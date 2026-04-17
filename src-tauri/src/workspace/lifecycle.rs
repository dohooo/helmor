use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::{db, git_ops, helpers, models::workspaces as workspace_models, repos, settings};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreWorkspaceResponse {
    pub restored_workspace_id: String,
    pub restored_state: String,
    pub selected_workspace_id: String,
    /// Set when the originally archived branch name was already taken at
    /// restore time and the workspace had to be checked out on a `-vN`
    /// suffixed branch instead. The frontend uses this to surface an
    /// informational toast so the rename never happens silently.
    pub branch_rename: Option<BranchRename>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRename {
    pub original: String,
    pub actual: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveWorkspaceResponse {
    pub archived_workspace_id: String,
    pub archived_state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceResponse {
    pub created_workspace_id: String,
    pub selected_workspace_id: String,
    pub created_state: String,
    pub directory_name: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateRestoreResponse {
    /// Set when the workspace's `intended_target_branch` no longer exists
    /// on the repo's current remote. The frontend should confirm before
    /// proceeding, offering `suggested_branch` as the replacement.
    pub target_branch_conflict: Option<TargetBranchConflict>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetBranchConflict {
    pub current_branch: String,
    pub suggested_branch: String,
    pub remote: String,
}

pub fn create_workspace_from_repo_impl(repo_id: &str) -> Result<CreateWorkspaceResponse> {
    let repository = repos::load_repository_by_id(repo_id)?
        .with_context(|| format!("Repository not found: {repo_id}"))?;
    let repo_root = PathBuf::from(repository.root_path.trim());
    git_ops::ensure_git_repository(&repo_root)?;

    let remote = repository
        .remote
        .clone()
        .unwrap_or_else(|| "origin".to_string());

    if !git_ops::has_remote(&repo_root, &remote)? {
        bail!(
            "Repository \"{}\" has no remote \"{remote}\". Workspaces require a remote to branch from.",
            repository.name
        );
    }

    let directory_name = helpers::allocate_directory_name_for_repo(repo_id)?;
    let branch_settings = settings::load_branch_prefix_settings()?;
    let branch = helpers::branch_name_for_directory(&directory_name, &branch_settings);
    let default_branch = repository
        .default_branch
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "main".to_string());
    let workspace_id = uuid::Uuid::new_v4().to_string();
    let session_id = uuid::Uuid::new_v4().to_string();
    let workspace_dir = crate::data_dir::workspace_dir(&repository.name, &directory_name)?;
    let timestamp = db::current_timestamp()?;
    let mut created_worktree = false;

    workspace_models::insert_initializing_workspace_and_session(
        &repository,
        &workspace_id,
        &session_id,
        &directory_name,
        &branch,
        &default_branch,
        &timestamp,
    )?;

    let create_result = (|| -> Result<CreateWorkspaceResponse> {
        if workspace_dir.exists() {
            bail!(
                "Workspace target already exists at {}",
                workspace_dir.display()
            );
        }

        git_ops::ensure_git_repository(&repo_root)?;
        let start_ref = git_ops::default_branch_ref(&remote, &default_branch);
        git_ops::verify_commitish_exists(
            &repo_root,
            &start_ref,
            &format!("Default branch is missing in source repo: {default_branch}"),
        )?;
        match git_ops::create_worktree_from_start_point(
            &repo_root,
            &workspace_dir,
            &branch,
            &start_ref,
        ) {
            Ok(_) => {
                created_worktree = true;
            }
            Err(error) => {
                return Err(error);
            }
        };

        helpers::create_workspace_context_scaffold(&workspace_dir)?;
        let initialization_files_copied = git_ops::tracked_file_count(&workspace_dir)?;

        workspace_models::update_workspace_initialization_metadata(
            &workspace_id,
            initialization_files_copied,
            &timestamp,
        )?;
        // Defer setup to the frontend inspector: if a script is configured,
        // the workspace starts in "setup_pending" and the UI auto-triggers it.
        let has_setup = match resolve_setup_hook(&repository, &workspace_dir) {
            Ok(Some(s)) if !s.trim().is_empty() => true,
            Ok(_) => false,
            Err(e) => {
                tracing::warn!("Failed to resolve setup hook, skipping: {e:#}");
                false
            }
        };
        let final_state = if has_setup { "setup_pending" } else { "ready" };
        workspace_models::update_workspace_state(&workspace_id, final_state, &timestamp)?;

        Ok(CreateWorkspaceResponse {
            created_workspace_id: workspace_id.clone(),
            selected_workspace_id: workspace_id.clone(),
            created_state: final_state.to_string(),
            directory_name,
            branch: branch.clone(),
        })
    })();

    match create_result {
        Ok(response) => Ok(response),
        Err(error) => {
            cleanup_failed_created_workspace(
                &workspace_id,
                &session_id,
                &repo_root,
                &workspace_dir,
                &branch,
                created_worktree,
            );
            Err(error)
        }
    }
}

#[derive(Debug, Clone)]
pub struct ArchivePreparedPlan {
    pub workspace_id: String,
    repo_root: PathBuf,
    branch: String,
    workspace_dir: PathBuf,
    archived_context_dir: PathBuf,
}

fn is_archive_eligible_state(state: &str) -> bool {
    matches!(state, "ready" | "setup_pending")
}

/// Resolve the interpreter + single-command flag used to run the archive
/// script. On Unix we respect `$SHELL` (falling back to `/bin/sh`) and use
/// `-c`; on Windows we use `%COMSPEC%` (falling back to `cmd.exe`) and `/C`.
/// Powershell would also work but `cmd /C` matches user expectation for
/// single-line `archive_script` entries and has no startup latency.
fn archive_shell() -> (String, &'static str) {
    #[cfg(windows)]
    {
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        (shell, "/C")
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        (shell, "-c")
    }
}

/// Structured outcome of a single archive-hook invocation. Returned by the
/// testable `run_archive_hook_inner` and collapsed to a log line by the public
/// `run_archive_hook`. Phase 2's cross-platform refactor uses the same enum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArchiveHookOutcome {
    /// Workspace record was not found in the DB.
    WorkspaceMissing,
    /// Repo scripts failed to load (DB error).
    ScriptsLoadFailed,
    /// No archive script is configured — nothing to run.
    NoScript,
    /// The shell exited zero.
    Success,
    /// The shell exited non-zero with the given code (if reported).
    ScriptError { code: Option<i32> },
    /// The shell failed to spawn (binary missing, permissions, etc.).
    SpawnError { message: String },
}

/// Best-effort archive hook. Public wrapper that logs the outcome and discards it.
fn run_archive_hook(workspace_id: &str, workspace_dir: &Path, repo_root: &Path) {
    let outcome = run_archive_hook_inner(workspace_id, workspace_dir, repo_root);
    match outcome {
        ArchiveHookOutcome::Success => {
            tracing::info!(workspace_id, "Archive hook succeeded");
        }
        ArchiveHookOutcome::ScriptError { code } => {
            tracing::warn!(workspace_id, code = ?code, "Archive hook exited with error");
        }
        ArchiveHookOutcome::SpawnError { message } => {
            tracing::warn!(workspace_id, error = %message, "Archive hook failed to spawn");
        }
        ArchiveHookOutcome::NoScript
        | ArchiveHookOutcome::WorkspaceMissing
        | ArchiveHookOutcome::ScriptsLoadFailed => {
            // Silent no-ops by design.
        }
    }
}

/// Testable inner implementation. Returns a typed outcome without logging so
/// tests can assert on it deterministically.
pub(crate) fn run_archive_hook_inner(
    workspace_id: &str,
    workspace_dir: &Path,
    repo_root: &Path,
) -> ArchiveHookOutcome {
    let record = match workspace_models::load_workspace_record_by_id(workspace_id) {
        Ok(Some(r)) => r,
        _ => return ArchiveHookOutcome::WorkspaceMissing,
    };
    let scripts = match repos::load_repo_scripts(&record.repo_id, Some(workspace_id)) {
        Ok(s) => s,
        Err(_) => return ArchiveHookOutcome::ScriptsLoadFailed,
    };
    let script = match scripts.archive_script.filter(|s| !s.trim().is_empty()) {
        Some(s) => s,
        None => return ArchiveHookOutcome::NoScript,
    };

    let (shell, shell_flag) = archive_shell();
    tracing::info!(workspace_id, script = %script, shell = %shell, "Running archive hook");

    let status = Command::new(&shell)
        .arg(shell_flag)
        .arg(&script)
        .current_dir(workspace_dir)
        .env("HELMOR_ROOT_PATH", repo_root.display().to_string())
        .env("HELMOR_WORKSPACE_PATH", workspace_dir.display().to_string())
        .env("HELMOR_WORKSPACE_NAME", &record.directory_name)
        .env(
            "HELMOR_DEFAULT_BRANCH",
            record.default_branch.as_deref().unwrap_or("main"),
        )
        .status();

    match status {
        Ok(s) if s.success() => ArchiveHookOutcome::Success,
        Ok(s) => ArchiveHookOutcome::ScriptError { code: s.code() },
        Err(e) => ArchiveHookOutcome::SpawnError {
            message: e.to_string(),
        },
    }
}

pub fn prepare_archive_plan(workspace_id: &str) -> Result<ArchivePreparedPlan> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    if !is_archive_eligible_state(&record.state) {
        bail!(
            "Workspace is not archive-ready: {workspace_id} (state: {})",
            record.state
        );
    }

    let repo_root = helpers::non_empty(&record.root_path)
        .map(PathBuf::from)
        .with_context(|| format!("Workspace {workspace_id} is missing repo root_path"))?;
    let branch = helpers::non_empty(&record.branch)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Workspace {workspace_id} is missing branch"))?;

    let workspace_dir = crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
    if !workspace_dir.is_dir() {
        bail!(
            "Archive source workspace is missing at {}",
            workspace_dir.display()
        );
    }

    let archived_context_dir =
        crate::data_dir::archived_context_dir(&record.repo_name, &record.directory_name)?;
    if archived_context_dir.exists() {
        bail!(
            "Archived context target already exists at {}",
            archived_context_dir.display()
        );
    }

    Ok(ArchivePreparedPlan {
        workspace_id: workspace_id.to_string(),
        repo_root,
        branch,
        workspace_dir,
        archived_context_dir,
    })
}

pub fn validate_archive_workspace(workspace_id: &str) -> Result<()> {
    prepare_archive_plan(workspace_id).map(|_| ())
}

pub fn archive_workspace_impl(workspace_id: &str) -> Result<ArchiveWorkspaceResponse> {
    let plan = prepare_archive_plan(workspace_id)?;
    execute_archive_plan(&plan)
}

pub fn execute_archive_plan(plan: &ArchivePreparedPlan) -> Result<ArchiveWorkspaceResponse> {
    let repo_root = &plan.repo_root;
    let branch = &plan.branch;
    let workspace_dir = &plan.workspace_dir;
    let archived_context_dir = &plan.archived_context_dir;
    let workspace_id = &plan.workspace_id;
    let timing = std::time::Instant::now();
    let archive_commit = git_ops::current_workspace_head_commit(workspace_dir)?;
    git_ops::verify_commit_exists(repo_root, &archive_commit)?;

    // Run archive script (best-effort, don't block archive on script failure).
    let hook_started = std::time::Instant::now();
    run_archive_hook(workspace_id, workspace_dir, repo_root);
    tracing::info!(
        workspace_id,
        elapsed_ms = hook_started.elapsed().as_millis(),
        "Archive hook finished"
    );

    fs::create_dir_all(archived_context_dir.parent().with_context(|| {
        format!(
            "Archived context target has no parent: {}",
            archived_context_dir.display()
        )
    })?)
    .with_context(|| {
        format!(
            "Failed to create archived context parent directory for {}",
            archived_context_dir.display()
        )
    })?;

    let workspace_context_dir = workspace_dir.join(".context");
    let staged_archive_dir = helpers::staged_archive_context_dir(archived_context_dir);
    let context_copy_started = std::time::Instant::now();
    create_staged_archive_context(&workspace_context_dir, &staged_archive_dir)?;
    tracing::info!(
        workspace_id,
        elapsed_ms = context_copy_started.elapsed().as_millis(),
        "Archive context staging finished"
    );

    let remove_worktree_started = std::time::Instant::now();
    if let Err(error) = git_ops::remove_worktree(repo_root, workspace_dir) {
        let _ = fs::remove_dir_all(&staged_archive_dir);
        return Err(error);
    }
    tracing::info!(
        workspace_id,
        elapsed_ms = remove_worktree_started.elapsed().as_millis(),
        "Archive worktree removal finished"
    );

    git_ops::run_git(
        [
            "-C",
            &repo_root.display().to_string(),
            "branch",
            "-D",
            branch,
        ],
        None,
    )
    .ok();

    if let Err(error) = fs::rename(&staged_archive_dir, archived_context_dir) {
        cleanup_failed_archive(
            repo_root,
            workspace_dir,
            &workspace_context_dir,
            branch,
            &archive_commit,
            &staged_archive_dir,
            archived_context_dir,
        );
        bail!(
            "Failed to move archived context into {}: {error}",
            archived_context_dir.display()
        );
    }

    if let Err(error) =
        workspace_models::update_archived_workspace_state(workspace_id, &archive_commit)
    {
        cleanup_failed_archive(
            repo_root,
            workspace_dir,
            &workspace_context_dir,
            branch,
            &archive_commit,
            &staged_archive_dir,
            archived_context_dir,
        );
        return Err(error);
    }

    tracing::info!(
        workspace_id,
        elapsed_ms = timing.elapsed().as_millis(),
        "Archive execution finished"
    );

    Ok(ArchiveWorkspaceResponse {
        archived_workspace_id: workspace_id.to_string(),
        archived_state: "archived".to_string(),
    })
}

struct RestorePreflightData {
    repo_root: PathBuf,
    branch: String,
    archive_commit: String,
    workspace_dir: PathBuf,
    archived_context_dir: PathBuf,
}

fn restore_workspace_preflight(workspace_id: &str) -> Result<RestorePreflightData> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    if record.state != "archived" {
        bail!("Workspace is not archived: {workspace_id}");
    }

    let repo_root = helpers::non_empty(&record.root_path)
        .map(PathBuf::from)
        .with_context(|| format!("Workspace {workspace_id} is missing repo root_path"))?;
    let branch = helpers::non_empty(&record.branch)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Workspace {workspace_id} is missing branch"))?;
    let archive_commit = helpers::non_empty(&record.archive_commit)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Workspace {workspace_id} is missing archive_commit"))?;

    let workspace_dir = crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
    let archived_context_dir =
        crate::data_dir::archived_context_dir(&record.repo_name, &record.directory_name)?;
    if !archived_context_dir.is_dir() {
        bail!(
            "Archived context directory is missing at {}",
            archived_context_dir.display()
        );
    }

    git_ops::ensure_git_repository(&repo_root)?;
    git_ops::verify_commit_exists(&repo_root, &archive_commit)?;

    Ok(RestorePreflightData {
        repo_root,
        branch,
        archive_commit,
        workspace_dir,
        archived_context_dir,
    })
}

pub fn validate_restore_workspace(workspace_id: &str) -> Result<ValidateRestoreResponse> {
    let preflight = restore_workspace_preflight(workspace_id)?;

    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;
    let remote = record.remote.unwrap_or_else(|| "origin".to_string());
    let intended = record
        .intended_target_branch
        .filter(|value| !value.trim().is_empty());

    let conflict = if let Some(ref target) = intended {
        let has_any_refs = !git_ops::list_remote_branches(&preflight.repo_root, &remote)
            .unwrap_or_default()
            .is_empty();

        let exists = git_ops::verify_remote_ref_exists(&preflight.repo_root, &remote, target)
            .unwrap_or(false);

        if exists || !has_any_refs {
            None
        } else {
            let repo = crate::repos::load_repository_by_id(&record.repo_id)?
                .with_context(|| format!("Repository not found: {}", record.repo_id))?;
            let suggested = repo.default_branch.unwrap_or_else(|| "main".to_string());
            Some(TargetBranchConflict {
                current_branch: target.clone(),
                suggested_branch: suggested,
                remote,
            })
        }
    } else {
        None
    };

    Ok(ValidateRestoreResponse {
        target_branch_conflict: conflict,
    })
}

pub fn restore_workspace_impl(
    workspace_id: &str,
    target_branch_override: Option<&str>,
) -> Result<RestoreWorkspaceResponse> {
    let RestorePreflightData {
        repo_root,
        branch,
        archive_commit,
        workspace_dir,
        archived_context_dir,
    } = restore_workspace_preflight(workspace_id)?;

    if workspace_dir.exists() {
        std::fs::remove_dir_all(&workspace_dir).with_context(|| {
            format!(
                "Failed to remove existing workspace directory: {}",
                workspace_dir.display()
            )
        })?;
    }

    fs::create_dir_all(workspace_dir.parent().with_context(|| {
        format!(
            "Workspace restore target has no parent: {}",
            workspace_dir.display()
        )
    })?)
    .with_context(|| {
        format!(
            "Failed to create workspace parent directory for {}",
            workspace_dir.display()
        )
    })?;

    let actual_branch = if git_ops::verify_branch_exists(&repo_root, &branch).is_ok() {
        let mut candidate = branch.clone();
        for version in 1..=999 {
            candidate = format!("{branch}-v{version}");
            if git_ops::verify_branch_exists(&repo_root, &candidate).is_err() {
                break;
            }
        }
        candidate
    } else {
        branch.clone()
    };

    git_ops::verify_commit_exists(&repo_root, &archive_commit).with_context(|| {
        format!(
            "Archive commit {archive_commit} no longer exists in {} \
             (likely garbage-collected). Cannot restore.",
            repo_root.display()
        )
    })?;

    git_ops::run_git(
        [
            "-C",
            &repo_root.display().to_string(),
            "branch",
            &actual_branch,
            &archive_commit,
        ],
        None,
    )
    .with_context(|| format!("Failed to create branch {actual_branch} from {archive_commit}"))?;

    git_ops::create_worktree(&repo_root, &workspace_dir, &actual_branch)?;

    let staged_archive_dir = helpers::staged_archive_context_dir(&archived_context_dir);
    if actual_branch != branch {
        let conn = db::open_connection(true).map_err(|error| {
            cleanup_failed_restore(
                &repo_root,
                &workspace_dir,
                None,
                &staged_archive_dir,
                &archived_context_dir,
                &actual_branch,
            );
            error.context("Failed to open DB to persist restored branch name")
        })?;
        conn.execute(
            "UPDATE workspaces SET branch = ?1 WHERE id = ?2",
            rusqlite::params![actual_branch, workspace_id],
        )
        .map_err(|error| {
            cleanup_failed_restore(
                &repo_root,
                &workspace_dir,
                None,
                &staged_archive_dir,
                &archived_context_dir,
                &actual_branch,
            );
            anyhow::anyhow!("Failed to persist restored branch name in DB: {error}")
        })?;
    }

    fs::rename(&archived_context_dir, &staged_archive_dir).map_err(|error| {
        cleanup_failed_restore(
            &repo_root,
            &workspace_dir,
            None,
            &staged_archive_dir,
            &archived_context_dir,
            &actual_branch,
        );
        anyhow::anyhow!(
            "Failed to stage archived context {}: {error}",
            archived_context_dir.display()
        )
    })?;

    let workspace_context_dir = workspace_dir.join(".context");
    if let Err(error) = helpers::copy_dir_all(&staged_archive_dir, &workspace_context_dir) {
        cleanup_failed_restore(
            &repo_root,
            &workspace_dir,
            Some(&workspace_context_dir),
            &staged_archive_dir,
            &archived_context_dir,
            &actual_branch,
        );
        return Err(error);
    }

    if let Err(error) = workspace_models::update_restored_workspace_state(
        workspace_id,
        &archived_context_dir,
        &workspace_context_dir,
        target_branch_override,
    ) {
        cleanup_failed_restore(
            &repo_root,
            &workspace_dir,
            Some(&workspace_context_dir),
            &staged_archive_dir,
            &archived_context_dir,
            &actual_branch,
        );
        return Err(error);
    }

    if let Err(error) = fs::remove_dir_all(&staged_archive_dir) {
        let _ = fs::rename(&staged_archive_dir, &archived_context_dir);
        tracing::error!(dir = %staged_archive_dir.display(), "Failed to delete staged archived context: {error}");
    }

    let branch_rename = if actual_branch != branch {
        Some(BranchRename {
            original: branch,
            actual: actual_branch,
        })
    } else {
        None
    };

    Ok(RestoreWorkspaceResponse {
        restored_workspace_id: workspace_id.to_string(),
        restored_state: "ready".to_string(),
        selected_workspace_id: workspace_id.to_string(),
        branch_rename,
    })
}

fn cleanup_failed_created_workspace(
    workspace_id: &str,
    session_id: &str,
    repo_root: &Path,
    workspace_dir: &Path,
    branch: &str,
    created_worktree: bool,
) {
    if created_worktree && workspace_dir.exists() {
        let _ = git_ops::remove_worktree(repo_root, workspace_dir);
        let _ = fs::remove_dir_all(workspace_dir);
    }

    let _ = git_ops::remove_branch(repo_root, branch);
    let _ = workspace_models::delete_workspace_and_session_rows(workspace_id, session_id);
}

fn cleanup_failed_restore(
    repo_root: &Path,
    workspace_dir: &Path,
    workspace_context_dir: Option<&Path>,
    staged_archive_dir: &Path,
    archived_context_dir: &Path,
    branch: &str,
) {
    if let Some(context_dir) = workspace_context_dir {
        let _ = fs::remove_dir_all(context_dir);
    }

    let _ = git_ops::remove_worktree(repo_root, workspace_dir);
    let _ = fs::remove_dir_all(workspace_dir);
    let _ = git_ops::remove_branch(repo_root, branch);

    if staged_archive_dir.exists() && !archived_context_dir.exists() {
        let _ = fs::rename(staged_archive_dir, archived_context_dir);
    }
}

fn cleanup_failed_archive(
    repo_root: &Path,
    workspace_dir: &Path,
    workspace_context_dir: &Path,
    branch: &str,
    archive_commit: &str,
    staged_archive_dir: &Path,
    archived_context_dir: &Path,
) {
    if archived_context_dir.exists() && !staged_archive_dir.exists() {
        let _ = fs::rename(archived_context_dir, staged_archive_dir);
    }

    let _ = git_ops::point_branch_to_commit(repo_root, branch, archive_commit);

    if !workspace_dir.exists() {
        let _ = git_ops::create_worktree(repo_root, workspace_dir, branch);
    }

    if staged_archive_dir.exists() {
        let _ = fs::remove_dir_all(workspace_context_dir);
        let _ = helpers::copy_dir_contents(staged_archive_dir, workspace_context_dir);
        let _ = fs::remove_dir_all(staged_archive_dir);
    }
}

fn create_staged_archive_context(
    workspace_context_dir: &Path,
    staged_archive_dir: &Path,
) -> Result<()> {
    if staged_archive_dir.exists() {
        bail!(
            "Archive staging directory already exists at {}",
            staged_archive_dir.display()
        );
    }

    fs::create_dir_all(staged_archive_dir).with_context(|| {
        format!(
            "Failed to create archive staging directory {}",
            staged_archive_dir.display()
        )
    })?;

    if workspace_context_dir.is_dir() {
        if let Err(error) = helpers::copy_dir_contents(workspace_context_dir, staged_archive_dir) {
            let _ = fs::remove_dir_all(staged_archive_dir);
            return Err(error);
        }
    } else if workspace_context_dir.exists() {
        let _ = fs::remove_dir_all(staged_archive_dir);
        bail!(
            "Workspace context path is not a directory: {}",
            workspace_context_dir.display()
        );
    }

    Ok(())
}

/// Resolve the setup script command string from DB or project config.
fn resolve_setup_hook(
    repository: &repos::RepositoryRecord,
    workspace_dir: &Path,
) -> Result<Option<String>> {
    if let Some(script) = repository
        .setup_script
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        return Ok(Some(script.to_string()));
    }
    load_setup_script_from_project_config(workspace_dir)
}

fn load_setup_script_from_project_config(workspace_dir: &Path) -> Result<Option<String>> {
    let config_path = workspace_dir.join("helmor.json");
    if !config_path.is_file() {
        return Ok(None);
    }
    let contents = fs::read_to_string(&config_path)
        .with_context(|| format!("Failed to read {}", config_path.display()))?;
    let json: Value = serde_json::from_str(&contents)
        .with_context(|| format!("Failed to parse {}", config_path.display()))?;
    Ok(json
        .get("scripts")
        .and_then(|v| v.get("setup"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned))
}

#[cfg(test)]
mod tests {
    //! Phase 0 baseline tests. Exercise the archive-hook outcome enum without
    //! requiring a real workspace in the database: the WorkspaceMissing path is
    //! the easiest to reach deterministically from a unit test.
    //!
    //! Phase 2's per-OS shell refactor must keep these passing; the shell
    //! selection change in Phase 2 should add `#[cfg(windows)]`-gated tests
    //! that exercise the Success path with `cmd.exe /C`.
    use super::*;

    #[test]
    fn archive_hook_inner_returns_workspace_missing_for_unknown_id() {
        let tmp = std::env::temp_dir();
        let outcome = run_archive_hook_inner("nonexistent-workspace-id", &tmp, &tmp);
        // Whatever the DB state, an unknown workspace id must short-circuit to
        // WorkspaceMissing or ScriptsLoadFailed — never spawn a shell or Success.
        assert!(
            matches!(
                outcome,
                ArchiveHookOutcome::WorkspaceMissing | ArchiveHookOutcome::ScriptsLoadFailed
            ),
            "unexpected outcome for unknown workspace id: {outcome:?}"
        );
    }

    #[test]
    fn archive_hook_outcome_debug_is_stable() {
        // Lock the debug representations that show up in logs/test diagnostics.
        assert_eq!(format!("{:?}", ArchiveHookOutcome::Success), "Success");
        assert_eq!(format!("{:?}", ArchiveHookOutcome::NoScript), "NoScript");
        assert_eq!(
            format!("{:?}", ArchiveHookOutcome::ScriptError { code: Some(7) }),
            "ScriptError { code: Some(7) }"
        );
    }

    #[test]
    fn archive_hook_outcome_equality() {
        assert_eq!(
            ArchiveHookOutcome::ScriptError { code: Some(1) },
            ArchiveHookOutcome::ScriptError { code: Some(1) }
        );
        assert_ne!(
            ArchiveHookOutcome::ScriptError { code: Some(1) },
            ArchiveHookOutcome::ScriptError { code: Some(2) }
        );
        assert_ne!(ArchiveHookOutcome::Success, ArchiveHookOutcome::NoScript);
    }
}
