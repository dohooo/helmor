use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::{
    bail_coded, db,
    error::{coded, ErrorCode},
    git_ops, helpers,
    models::workspaces::{self as workspace_models, WorkspaceRecord},
    workspace_pr_sync::PrSyncState,
    workspace_state,
    workspace_status::WorkspaceStatus,
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
        .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    if !record.state.is_operational() {
        bail!(
            "Cannot rename branch: workspace is {} (archived or mid-creation)",
            record.state
        );
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

    let connection = db::write_conn()?;
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
        let connection = db::write_conn()?;
        let updated_rows = connection
            .execute(
                &format!(
                    "UPDATE workspaces SET intended_target_branch = ?2 WHERE id = ?1 AND state {}",
                    workspace_state::OPERATIONAL_FILTER,
                ),
                (workspace_id, target_branch),
            )
            .context("Failed to update intended target branch")?;

        if updated_rows != 1 {
            bail!("Cannot update target branch: workspace {workspace_id} not found or archived");
        }
    }

    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found after intent update: {workspace_id}"))?;

    let post_reset_sha = try_realign_local_branch(&record, target_branch)?;

    if post_reset_sha.is_some() {
        let connection = db::write_conn()?;
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
    if !record.state.is_operational() {
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

    let workspace_dir = helpers::workspace_path(record)?;
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
    if !record.state.is_operational() {
        return Ok(false);
    }
    let workspace_dir = helpers::workspace_path(&record)?;
    if !workspace_dir.is_dir() {
        return Ok(false);
    }

    let remote = record.remote.as_deref().unwrap_or("origin");
    if git_ops::fetch_remote_branch(&workspace_dir, remote, target_branch).is_err() {
        return Ok(false);
    }

    let ws_lock = db::workspace_fs_mutation_lock(workspace_id);
    let _lock = ws_lock.blocking_lock();

    let Some(fresh_record) = workspace_models::load_workspace_record_by_id(workspace_id)? else {
        return Ok(false);
    };
    if !fresh_record.state.is_operational() {
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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncWorkspaceTargetOutcome {
    Updated,
    AlreadyUpToDate,
    Conflict,
    /// Merge succeeded but restoring the user's stashed work hit conflicts.
    StashPopConflict,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncWorkspaceTargetResponse {
    pub outcome: SyncWorkspaceTargetOutcome,
    pub target_branch: String,
    pub conflicted_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushWorkspaceToRemoteResponse {
    pub target_ref: String,
    pub head_commit: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueWorkspaceResponse {
    pub branch: String,
    pub target_branch: String,
    pub start_point: String,
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
        if !record.state.is_operational() {
            return Ok(PrefetchRemoteRefsResponse { fetched: false });
        }
        let workspace_dir = helpers::workspace_path(&record)?;
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

pub fn sync_workspace_with_target_branch(
    workspace_id: &str,
) -> Result<SyncWorkspaceTargetResponse> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;
    if !record.state.is_operational() {
        bail!(
            "Cannot sync target branch: workspace is {} (archived or mid-creation)",
            record.state
        );
    }

    let target_branch = record
        .intended_target_branch
        .clone()
        .or(record.default_branch.clone())
        .unwrap_or_else(|| "main".to_string());
    let remote = record
        .remote
        .clone()
        .unwrap_or_else(|| "origin".to_string());
    let workspace_dir = helpers::workspace_path(&record)?;
    if !workspace_dir.is_dir() {
        bail_coded!(
            ErrorCode::WorkspaceBroken,
            "Workspace directory is missing for {workspace_id}"
        );
    }

    let current_status =
        git_ops::workspace_action_status(&workspace_dir, Some(&remote), Some(&target_branch))?;
    // Pre-existing in-progress merge — let the user/agent resolve before we touch it.
    if current_status.conflict_count > 0 {
        return Ok(SyncWorkspaceTargetResponse {
            outcome: SyncWorkspaceTargetOutcome::Conflict,
            target_branch,
            conflicted_files: Vec::new(),
        });
    }
    let dirty = current_status.uncommitted_count > 0;

    git_ops::fetch_remote_branch(&workspace_dir, &remote, &target_branch)?;
    let target_remote_ref = format!("refs/remotes/{remote}/{target_branch}");
    let behind_count = git_ops::commits_behind(&workspace_dir, &target_remote_ref)?;
    if behind_count == 0 {
        return Ok(SyncWorkspaceTargetResponse {
            outcome: SyncWorkspaceTargetOutcome::AlreadyUpToDate,
            target_branch,
            conflicted_files: Vec::new(),
        });
    }

    // Preflight in a temp worktree against HEAD only — dirty work isn't
    // visible there, so a clean preflight doesn't guarantee a clean stash
    // pop. We still gate on it to catch HEAD-vs-target conflicts cheaply
    // before touching the user's worktree.
    let preflight = git_ops::preflight_merge_ref(&workspace_dir, &target_remote_ref)?;
    if !preflight.conflicted_files.is_empty() {
        return Ok(SyncWorkspaceTargetResponse {
            outcome: SyncWorkspaceTargetOutcome::Conflict,
            target_branch,
            conflicted_files: preflight.conflicted_files,
        });
    }

    let stash_message = format!("helmor-sync-{workspace_id}");
    let stashed = if dirty {
        git_ops::stash_push_include_untracked(&workspace_dir, &stash_message)?
    } else {
        false
    };

    if let Err(error) = git_ops::merge_ref_no_edit(&workspace_dir, &target_remote_ref) {
        let merge_status =
            git_ops::workspace_action_status(&workspace_dir, Some(&remote), Some(&target_branch))?;
        let merge_conflict = merge_status.conflict_count > 0;
        if merge_conflict {
            let _ = git_ops::abort_merge(&workspace_dir);
        }
        if stashed {
            // Best-effort restore of the user's work. If this somehow fails
            // the stash entry is preserved on the stack for manual recovery.
            match git_ops::stash_pop(&workspace_dir) {
                Ok(git_ops::StashPopOutcome::Clean) => {}
                Ok(git_ops::StashPopOutcome::Conflict) => {
                    tracing::warn!(
                        workspace_id,
                        "stash pop hit conflicts on merge-error path; worktree has unmerged paths"
                    );
                }
                Err(pop_error) => {
                    tracing::warn!(
                        workspace_id,
                        "stash pop failed on merge-error path; stash preserved for manual recovery: {pop_error:#}"
                    );
                }
            }
        }
        if merge_conflict {
            return Ok(SyncWorkspaceTargetResponse {
                outcome: SyncWorkspaceTargetOutcome::Conflict,
                target_branch,
                conflicted_files: Vec::new(),
            });
        }
        return Err(error);
    }

    if stashed {
        match git_ops::stash_pop(&workspace_dir)? {
            git_ops::StashPopOutcome::Clean => {}
            git_ops::StashPopOutcome::Conflict => {
                return Ok(SyncWorkspaceTargetResponse {
                    outcome: SyncWorkspaceTargetOutcome::StashPopConflict,
                    target_branch,
                    conflicted_files: Vec::new(),
                });
            }
        }
    }

    Ok(SyncWorkspaceTargetResponse {
        outcome: SyncWorkspaceTargetOutcome::Updated,
        target_branch,
        conflicted_files: Vec::new(),
    })
}

pub fn push_workspace_to_remote(workspace_id: &str) -> Result<PushWorkspaceToRemoteResponse> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;
    if !record.state.is_operational() {
        bail!(
            "Cannot push branch: workspace is {} (archived or mid-creation)",
            record.state
        );
    }

    let remote = record
        .remote
        .clone()
        .unwrap_or_else(|| "origin".to_string());
    let workspace_dir = helpers::workspace_path(&record)?;
    if !workspace_dir.is_dir() {
        bail_coded!(
            ErrorCode::WorkspaceBroken,
            "Workspace directory is missing for {workspace_id}"
        );
    }

    let current_status = git_ops::workspace_action_status(
        &workspace_dir,
        Some(&remote),
        record
            .intended_target_branch
            .as_deref()
            .or(record.default_branch.as_deref()),
    )?;
    if current_status.conflict_count > 0 {
        bail!("Cannot push branch while merge conflicts are present");
    }

    let push_result = git_ops::push_current_branch(&workspace_dir, &remote)?;
    let head_commit = git_ops::current_workspace_head_commit(&workspace_dir)?;

    Ok(PushWorkspaceToRemoteResponse {
        target_ref: push_result.target_ref,
        head_commit,
    })
}

pub fn continue_workspace_from_target_branch(
    workspace_id: &str,
) -> Result<ContinueWorkspaceResponse> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;
    if !record.state.is_operational() {
        bail!(
            "Cannot continue workspace: workspace is {} (archived or mid-creation)",
            record.state
        );
    }

    let repo_root = helpers::non_empty(&record.root_path)
        .map(PathBuf::from)
        .with_context(|| format!("Workspace {workspace_id} is missing repo root_path"))?;
    let workspace_dir = helpers::workspace_path(&record)?;
    if !workspace_dir.is_dir() {
        bail_coded!(
            ErrorCode::WorkspaceBroken,
            "Workspace directory is missing for {workspace_id}"
        );
    }

    let target_branch = record
        .intended_target_branch
        .clone()
        .or(record.default_branch.clone())
        .unwrap_or_else(|| "main".to_string());
    let remote = record
        .remote
        .clone()
        .unwrap_or_else(|| "origin".to_string());
    let start_point = if git_ops::verify_remote_ref_exists(&workspace_dir, &remote, &target_branch)?
    {
        format!("{remote}/{target_branch}")
    } else if git_ops::verify_branch_exists(&repo_root, &target_branch).is_ok() {
        target_branch.clone()
    } else {
        bail!("Target branch {target_branch} was not found");
    };

    let branch_settings = crate::repos::load_repo_branch_prefix_settings(&record.repo_id)?;
    let base_branch = helpers::branch_name_for_directory(&record.directory_name, &branch_settings);
    let branch = helpers::next_available_branch_name(&repo_root, &base_branch)?;
    let workspace_dir_arg = workspace_dir.display().to_string();
    let old_branch = git_ops::current_branch_name(&workspace_dir)
        .context("Failed to resolve current workspace branch")?;

    git_ops::run_git(
        [
            "-C",
            workspace_dir_arg.as_str(),
            "switch",
            "-c",
            &branch,
            &start_point,
        ],
        None,
    )
    .context(
        "Continue could not move your local changes onto the target branch. \
         Commit, stash, or discard the conflicting changes, then try again.",
    )?;
    let _ = git_ops::run_git(
        [
            "-C",
            workspace_dir_arg.as_str(),
            "branch",
            "--unset-upstream",
            &branch,
        ],
        None,
    );

    let persist_result = (|| -> Result<()> {
        let connection = db::write_conn()?;
        let updated_rows = connection
            .execute(
                r#"
                UPDATE workspaces
                SET branch = ?2,
                    status = ?3,
                    initialization_parent_branch = ?4,
                    intended_target_branch = ?4,
                    pr_sync_state = ?5,
                    pr_title = NULL,
                    pr_url = NULL,
                    updated_at = datetime('now')
                WHERE id = ?1
                "#,
                rusqlite::params![
                    workspace_id,
                    branch,
                    WorkspaceStatus::InProgress,
                    target_branch,
                    PrSyncState::None,
                ],
            )
            .context("Failed to persist continued workspace branch")?;
        if updated_rows != 1 {
            bail!("Continue workspace update affected {updated_rows} rows for {workspace_id}");
        }
        Ok(())
    })();
    if let Err(error) = persist_result {
        rollback_continue_branch(&workspace_dir_arg, &old_branch, &branch, workspace_id);
        return Err(error);
    }

    Ok(ContinueWorkspaceResponse {
        branch,
        target_branch,
        start_point,
    })
}

fn rollback_continue_branch(
    workspace_dir_arg: &str,
    old_branch: &str,
    new_branch: &str,
    workspace_id: &str,
) {
    if let Err(error) = git_ops::run_git(["-C", workspace_dir_arg, "switch", old_branch], None) {
        tracing::warn!(
            workspace_id,
            branch = %new_branch,
            error = %error,
            "Failed to roll back workspace branch after continue persistence failure"
        );
        return;
    }
    if let Err(error) =
        git_ops::run_git(["-C", workspace_dir_arg, "branch", "-D", new_branch], None)
    {
        tracing::warn!(
            workspace_id,
            branch = %new_branch,
            error = %error,
            "Failed to delete continued branch after rollback"
        );
    }
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
