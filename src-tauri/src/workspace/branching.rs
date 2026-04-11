use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::{
    db, git_ops, helpers,
    models::workspaces::{self as workspace_models, WorkspaceRecord},
};

struct RepoContext {
    root: PathBuf,
    remote: String,
}

/// Resolve the repository root and remote from either a workspace_id or a repo_id.
fn resolve_repo_context(workspace_id: Option<&str>, repo_id: Option<&str>) -> Result<RepoContext> {
    match (workspace_id, repo_id) {
        (Some(ws_id), _) => {
            let record = workspace_models::load_workspace_record_by_id(ws_id)?
                .with_context(|| format!("Workspace not found: {ws_id}"))?;
            let root = helpers::non_empty(&record.root_path)
                .map(PathBuf::from)
                .with_context(|| format!("Workspace {ws_id} is missing repo root_path"))?;
            let remote = record.remote.unwrap_or_else(|| "origin".to_string());
            Ok(RepoContext { root, remote })
        }
        (_, Some(r_id)) => {
            let repo = crate::repos::load_repository_by_id(r_id)?
                .with_context(|| format!("Repository not found: {r_id}"))?;
            let remote = repo.remote.unwrap_or_else(|| "origin".to_string());
            Ok(RepoContext {
                root: PathBuf::from(repo.root_path.trim()),
                remote,
            })
        }
        (None, None) => bail!("Either workspace_id or repo_id must be provided"),
    }
}

pub fn list_remote_branches(
    workspace_id: Option<&str>,
    repo_id: Option<&str>,
) -> Result<Vec<String>> {
    let ctx = resolve_repo_context(workspace_id, repo_id)?;
    git_ops::ensure_git_repository(&ctx.root)?;
    git_ops::list_remote_branches(&ctx.root, &ctx.remote)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateIntendedTargetBranchResponse {
    /// `true` if the workspace's local branch was hard-reset to `origin/<target>`.
    /// `false` if only the stored intent was updated (worktree dirty, branch
    /// already has user commits, baseline missing, etc.).
    pub reset: bool,
    pub target_branch: String,
}

/// Internal result of the synchronous (local-only) phase of a branch switch.
/// Carries the post-reset HEAD SHA so the caller can chain a background
/// remote-refresh against it.
#[derive(Debug)]
pub struct UpdateIntendedTargetBranchInternal {
    pub reset: bool,
    pub target_branch: String,
    /// `Some(sha)` only when a local reset actually happened.
    pub post_reset_sha: Option<String>,
}

/// Rename the workspace's local git branch and update `workspaces.branch` in
/// the database. Both sides must succeed atomically — if the DB update fails
/// after a successful git rename, the git rename is rolled back.
pub fn rename_workspace_branch(workspace_id: &str, new_branch: &str) -> Result<()> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    if record.state != "ready" {
        bail!("Cannot rename branch: workspace is not in ready state");
    }

    let old_branch = record
        .branch
        .as_deref()
        .with_context(|| format!("Workspace {workspace_id} has no branch"))?;

    if old_branch == new_branch {
        return Ok(());
    }

    let repo_root = helpers::non_empty(&record.root_path)
        .with_context(|| format!("Workspace {workspace_id} has no repo root path"))?;
    let repo_root_path = Path::new(repo_root);

    git_ops::rename_branch(repo_root_path, old_branch, new_branch)?;

    let connection = db::open_connection(true)?;
    if let Err(db_err) = connection.execute(
        "UPDATE workspaces SET branch = ?1 WHERE id = ?2",
        (new_branch, workspace_id),
    ) {
        if let Err(rb_err) = git_ops::rename_branch(repo_root_path, new_branch, old_branch) {
            tracing::error!(
                old = old_branch,
                new = new_branch,
                "Rollback git branch -m failed: {rb_err:#}"
            );
        }
        return Err(db_err).context("Failed to update branch name in database");
    }

    Ok(())
}

/// Tauri-facing entry point. Performs the fast local realignment synchronously,
/// then schedules a background fetch from `origin` to silently re-align to the
/// freshest tip if it is still safe.
pub fn update_intended_target_branch(
    workspace_id: &str,
    target_branch: &str,
) -> Result<UpdateIntendedTargetBranchResponse> {
    let internal = update_intended_target_branch_local(workspace_id, target_branch)?;

    if let Some(post_reset_sha) = internal.post_reset_sha.clone() {
        let workspace_id_owned = workspace_id.to_string();
        let target_branch_owned = internal.target_branch.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = refresh_remote_and_realign(
                &workspace_id_owned,
                &target_branch_owned,
                &post_reset_sha,
            );
        });
    }

    Ok(UpdateIntendedTargetBranchResponse {
        reset: internal.reset,
        target_branch: internal.target_branch,
    })
}

/// Synchronous local-only phase of a branch switch. Always updates the DB
/// `intended_target_branch`, then attempts a fast local reset to the cached
/// `origin/<target>` if all safety checks pass. Never hits the network.
pub fn update_intended_target_branch_local(
    workspace_id: &str,
    target_branch: &str,
) -> Result<UpdateIntendedTargetBranchInternal> {
    {
        let connection = db::open_connection(true)?;
        let updated_rows = connection
            .execute(
                "UPDATE workspaces SET intended_target_branch = ?2 WHERE id = ?1 AND state = 'ready'",
                (workspace_id, target_branch),
            )
            .context("Failed to update intended target branch")?;

        if updated_rows != 1 {
            bail!(
                "Cannot update target branch: workspace {workspace_id} not found or not in ready state"
            );
        }
    }

    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found after intent update: {workspace_id}"))?;

    let post_reset_sha = try_realign_local_branch(&record, target_branch)?;

    if post_reset_sha.is_some() {
        let connection = db::open_connection(true)?;
        connection
            .execute(
                "UPDATE workspaces SET initialization_parent_branch = ?2 WHERE id = ?1",
                (workspace_id, target_branch),
            )
            .context("Failed to update initialization parent branch after reset")?;
    }

    Ok(UpdateIntendedTargetBranchInternal {
        reset: post_reset_sha.is_some(),
        target_branch: target_branch.to_string(),
        post_reset_sha,
    })
}

fn try_realign_local_branch(
    record: &WorkspaceRecord,
    target_branch: &str,
) -> Result<Option<String>> {
    if record.state != "ready" {
        return Ok(None);
    }
    if helpers::non_empty(&record.root_path).is_none() {
        return Ok(None);
    }
    if helpers::non_empty(&record.branch).is_none() {
        return Ok(None);
    }
    let Some(init_parent) = helpers::non_empty(&record.initialization_parent_branch) else {
        return Ok(None);
    };

    let workspace_dir = crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
    if !workspace_dir.is_dir() {
        return Ok(None);
    }

    let remote = record.remote.as_deref().unwrap_or("origin");

    if !matches!(
        git_ops::verify_remote_ref_exists(&workspace_dir, remote, target_branch),
        Ok(true)
    ) {
        return Ok(None);
    }

    if !matches!(git_ops::working_tree_clean(&workspace_dir), Ok(true)) {
        return Ok(None);
    }

    let baseline_ref = format!("{remote}/{init_parent}");
    if !matches!(
        git_ops::commits_ahead_of(&workspace_dir, &baseline_ref),
        Ok(0)
    ) {
        return Ok(None);
    }

    let target_ref = format!("{remote}/{target_branch}");
    git_ops::reset_current_branch_hard(&workspace_dir, &target_ref)?;

    let post_reset_sha = git_ops::current_workspace_head_commit(&workspace_dir)?;
    Ok(Some(post_reset_sha))
}

/// Public so tests can drive it deterministically without spawning a thread.
pub fn refresh_remote_and_realign(
    workspace_id: &str,
    target_branch: &str,
    post_reset_sha: &str,
) -> Result<bool> {
    let Some(record) = workspace_models::load_workspace_record_by_id(workspace_id)? else {
        return Ok(false);
    };
    if record.state != "ready" {
        return Ok(false);
    }
    let workspace_dir = crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
    if !workspace_dir.is_dir() {
        return Ok(false);
    }

    let remote = record.remote.as_deref().unwrap_or("origin");
    if git_ops::fetch_remote_branch(&workspace_dir, remote, target_branch).is_err() {
        return Ok(false);
    }

    let ws_lock = db::workspace_mutation_lock(workspace_id);
    let _lock = ws_lock.blocking_lock();

    let Some(fresh_record) = workspace_models::load_workspace_record_by_id(workspace_id)? else {
        return Ok(false);
    };
    if fresh_record.state != "ready" {
        return Ok(false);
    }

    if !matches!(git_ops::working_tree_clean(&workspace_dir), Ok(true)) {
        return Ok(false);
    }

    let current_head = match git_ops::current_workspace_head_commit(&workspace_dir) {
        Ok(sha) => sha,
        Err(_) => return Ok(false),
    };
    if current_head != post_reset_sha {
        return Ok(false);
    }

    let new_remote_sha = match git_ops::remote_ref_sha(&workspace_dir, remote, target_branch) {
        Ok(sha) => sha,
        Err(_) => return Ok(false),
    };
    if new_remote_sha == post_reset_sha {
        return Ok(false);
    }

    let remote = fresh_record.remote.as_deref().unwrap_or("origin");
    let target_ref = format!("{remote}/{target_branch}");
    git_ops::reset_current_branch_hard(&workspace_dir, &target_ref)?;
    Ok(true)
}

const PREFETCH_RATE_LIMIT: Duration = Duration::from_secs(10);

fn prefetch_rate_limit_map() -> &'static Mutex<HashMap<String, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchRemoteRefsResponse {
    pub fetched: bool,
}

pub fn prefetch_remote_refs(
    workspace_id: Option<&str>,
    repo_id: Option<&str>,
) -> Result<PrefetchRemoteRefsResponse> {
    let rate_key = workspace_id
        .or(repo_id)
        .with_context(|| "Either workspace_id or repo_id must be provided")?;

    {
        let mut map = prefetch_rate_limit_map()
            .lock()
            .map_err(|_| anyhow::anyhow!("Prefetch rate-limit lock poisoned"))?;
        let now = Instant::now();
        if let Some(last) = map.get(rate_key) {
            if now.duration_since(*last) < PREFETCH_RATE_LIMIT {
                return Ok(PrefetchRemoteRefsResponse { fetched: false });
            }
        }
        map.insert(rate_key.to_string(), now);
    }

    if let Some(ws_id) = workspace_id {
        let record = workspace_models::load_workspace_record_by_id(ws_id)?
            .with_context(|| format!("Workspace not found: {ws_id}"))?;
        if record.state != "ready" {
            return Ok(PrefetchRemoteRefsResponse { fetched: false });
        }
        let workspace_dir =
            crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
        if !workspace_dir.is_dir() {
            return Ok(PrefetchRemoteRefsResponse { fetched: false });
        }
        let remote = record.remote.unwrap_or_else(|| "origin".to_string());
        git_ops::fetch_all_remote(&workspace_dir, &remote)?;
    } else {
        let ctx = resolve_repo_context(None, repo_id)?;
        git_ops::ensure_git_repository(&ctx.root)?;
        git_ops::fetch_all_remote(&ctx.root, &ctx.remote)?;
    }

    Ok(PrefetchRemoteRefsResponse { fetched: true })
}

pub(crate) fn clear_prefetch_rate_limit(workspace_id: &str) {
    if let Ok(mut map) = prefetch_rate_limit_map().lock() {
        map.remove(workspace_id);
    }
}

#[doc(hidden)]
pub fn _reset_prefetch_rate_limit() {
    if let Ok(mut map) = prefetch_rate_limit_map().lock() {
        map.clear();
    }
}
