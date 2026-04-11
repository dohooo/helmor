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
    let setup_root_dir = crate::data_dir::data_dir()?
        .join("repo-roots")
        .join(&repository.name);
    let logs_dir = crate::data_dir::workspace_logs_dir(&workspace_id)?;
    let initialization_log_path = logs_dir.join("initialization.log");
    let setup_log_path = logs_dir.join("setup.log");
    let timestamp = db::current_timestamp()?;
    let mut created_worktree = false;
    let mut created_setup_root = false;

    fs::create_dir_all(&logs_dir).with_context(|| {
        format!(
            "Failed to create workspace log directory {}",
            logs_dir.display()
        )
    })?;

    workspace_models::insert_initializing_workspace_and_session(
        &repository,
        &workspace_id,
        &session_id,
        &directory_name,
        &branch,
        &default_branch,
        &timestamp,
        &initialization_log_path,
        &setup_log_path,
    )?;

    let create_result = (|| -> Result<CreateWorkspaceResponse> {
        if workspace_dir.exists() {
            let error = format!(
                "Workspace target already exists at {}",
                workspace_dir.display()
            );
            let _ = write_log_file(&initialization_log_path, &error);
            bail!("{error}");
        }

        git_ops::ensure_git_repository(&repo_root)?;
        let start_ref = git_ops::default_branch_ref(&remote, &default_branch);
        git_ops::verify_commitish_exists(
            &repo_root,
            &start_ref,
            &format!("Default branch is missing in source repo: {default_branch}"),
        )?;
        let init_log = match git_ops::create_worktree_from_start_point(
            &repo_root,
            &workspace_dir,
            &branch,
            &start_ref,
        ) {
            Ok(output) => {
                created_worktree = true;
                output
            }
            Err(error) => {
                let _ = write_log_file(&initialization_log_path, &format!("{error:#}"));
                return Err(error);
            }
        };
        write_log_file(
            &initialization_log_path,
            &format!(
                "Repository: {}\nWorkspace: {}\nBranch: {}\nStart point: {}\n\n{}",
                repository.name,
                workspace_dir.display(),
                branch,
                start_ref,
                init_log
            ),
        )?;

        helpers::create_workspace_context_scaffold(&workspace_dir)?;
        let initialization_files_copied = git_ops::tracked_file_count(&workspace_dir)?;

        workspace_models::update_workspace_initialization_metadata(
            &workspace_id,
            initialization_files_copied,
            &timestamp,
        )?;
        workspace_models::update_workspace_state(&workspace_id, "setting_up", &timestamp)?;

        git_ops::refresh_repo_setup_root(&repo_root, &setup_root_dir, &start_ref)?;
        created_setup_root = true;

        let setup_hook = match resolve_setup_hook(&repository, &workspace_dir, &setup_root_dir) {
            Ok(value) => value,
            Err(error) => {
                let _ = write_log_file(&setup_log_path, &format!("{error:#}"));
                return Err(error);
            }
        };
        run_setup_hook(
            setup_hook.as_deref(),
            &workspace_dir,
            &setup_root_dir,
            &setup_log_path,
        )?;
        workspace_models::update_workspace_state(&workspace_id, "ready", &timestamp)?;

        Ok(CreateWorkspaceResponse {
            created_workspace_id: workspace_id.clone(),
            selected_workspace_id: workspace_id.clone(),
            created_state: "ready".to_string(),
            directory_name,
            branch: branch.clone(),
        })
    })();

    let result = match create_result {
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
    };

    if created_setup_root {
        let _ = git_ops::remove_worktree(&repo_root, &setup_root_dir);
        let _ = fs::remove_dir_all(&setup_root_dir);
    }

    result
}

struct ArchivePreflightData {
    repo_root: PathBuf,
    branch: String,
    workspace_dir: PathBuf,
    archived_context_dir: PathBuf,
    archive_commit: String,
}

fn archive_workspace_preflight(workspace_id: &str) -> Result<ArchivePreflightData> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    if record.state != "ready" {
        bail!("Workspace is not ready: {workspace_id}");
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

    let archive_commit = git_ops::current_workspace_head_commit(&workspace_dir)?;
    git_ops::verify_commit_exists(&repo_root, &archive_commit)?;

    Ok(ArchivePreflightData {
        repo_root,
        branch,
        workspace_dir,
        archived_context_dir,
        archive_commit,
    })
}

pub fn validate_archive_workspace(workspace_id: &str) -> Result<()> {
    archive_workspace_preflight(workspace_id).map(|_| ())
}

pub fn archive_workspace_impl(workspace_id: &str) -> Result<ArchiveWorkspaceResponse> {
    let ArchivePreflightData {
        repo_root,
        branch,
        workspace_dir,
        archived_context_dir,
        archive_commit,
    } = archive_workspace_preflight(workspace_id)?;

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
    let staged_archive_dir = helpers::staged_archive_context_dir(&archived_context_dir);
    create_staged_archive_context(&workspace_context_dir, &staged_archive_dir)?;

    if let Err(error) = git_ops::remove_worktree(&repo_root, &workspace_dir) {
        let _ = fs::remove_dir_all(&staged_archive_dir);
        return Err(error);
    }

    git_ops::run_git(
        [
            "-C",
            &repo_root.display().to_string(),
            "branch",
            "-D",
            &branch,
        ],
        None,
    )
    .ok();

    if let Err(error) = fs::rename(&staged_archive_dir, &archived_context_dir) {
        cleanup_failed_archive(
            &repo_root,
            &workspace_dir,
            &workspace_context_dir,
            &branch,
            &archive_commit,
            &staged_archive_dir,
            &archived_context_dir,
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
            &repo_root,
            &workspace_dir,
            &workspace_context_dir,
            &branch,
            &archive_commit,
            &staged_archive_dir,
            &archived_context_dir,
        );
        return Err(error);
    }

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

fn resolve_setup_hook(
    repository: &repos::RepositoryRecord,
    workspace_dir: &Path,
    setup_root_dir: &Path,
) -> Result<Option<PathBuf>> {
    let raw_setup_script = if let Some(script) = repository
        .setup_script
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(script.to_string())
    } else {
        load_setup_script_from_conductor_json(workspace_dir)?
    };

    let Some(raw_setup_script) = raw_setup_script else {
        return Ok(None);
    };

    let resolved_path = expand_hook_path(&raw_setup_script, workspace_dir, setup_root_dir);
    if !resolved_path.exists() {
        bail!(
            "Configured setup script is missing at {}",
            resolved_path.display()
        );
    }

    Ok(Some(resolved_path))
}

fn load_setup_script_from_conductor_json(workspace_dir: &Path) -> Result<Option<String>> {
    let conductor_json_path = workspace_dir.join("conductor.json");
    if !conductor_json_path.is_file() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&conductor_json_path).with_context(|| {
        format!(
            "Failed to read conductor.json at {}",
            conductor_json_path.display()
        )
    })?;
    let json: Value = serde_json::from_str(&contents).with_context(|| {
        format!(
            "Failed to parse conductor.json at {}",
            conductor_json_path.display()
        )
    })?;

    Ok(json
        .get("scripts")
        .and_then(|value| value.get("setup"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned))
}

fn expand_hook_path(raw_value: &str, workspace_dir: &Path, setup_root_dir: &Path) -> PathBuf {
    let setup_root = setup_root_dir.display().to_string();
    let expanded = raw_value
        .replace("$CONDUCTOR_ROOT_PATH", &setup_root)
        .replace(
            "$CONDUCTOR_WORKSPACE_PATH",
            &workspace_dir.display().to_string(),
        );
    let expanded_path = PathBuf::from(expanded);

    if expanded_path.is_absolute() {
        expanded_path
    } else {
        workspace_dir.join(expanded_path)
    }
}

fn run_setup_hook(
    setup_script: Option<&Path>,
    workspace_dir: &Path,
    setup_root_dir: &Path,
    log_path: &Path,
) -> Result<()> {
    let Some(setup_script) = setup_script else {
        write_log_file(log_path, "No setup script configured.\n")?;
        return Ok(());
    };

    let (program, args) = command_for_script(setup_script)?;
    let setup_root = setup_root_dir.display().to_string();
    let workspace_path = workspace_dir.display().to_string();

    let output = Command::new(&program)
        .args(&args)
        .arg(setup_script)
        .current_dir(workspace_dir)
        .env("CONDUCTOR_ROOT_PATH", &setup_root)
        .env("CONDUCTOR_WORKSPACE_PATH", &workspace_path)
        .output()
        .map_err(|error| {
            let _ = write_log_file(
                log_path,
                &format!(
                    "Failed to spawn setup script\nProgram: {}\nScript: {}\nError: {}\n",
                    program,
                    setup_script.display(),
                    error
                ),
            );
            anyhow::anyhow!(
                "Failed to execute setup script {}: {error}",
                setup_script.display()
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    write_log_file(
        log_path,
        &format!(
            "Program: {}\nScript: {}\nWorkspace: {}\nCONDUCTOR_ROOT_PATH={}\nCONDUCTOR_WORKSPACE_PATH={}\nExit status: {}\n\n[stdout]\n{}\n\n[stderr]\n{}\n",
            program,
            setup_script.display(),
            workspace_dir.display(),
            setup_root,
            workspace_path,
            output.status,
            stdout,
            stderr
        ),
    )?;

    if output.status.success() {
        Ok(())
    } else {
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("exit status {}", output.status)
        };
        bail!(
            "Setup script failed for {}: {detail}",
            setup_script.display()
        )
    }
}

fn command_for_script(script_path: &Path) -> Result<(String, Vec<String>)> {
    let contents = fs::read_to_string(script_path)
        .with_context(|| format!("Failed to inspect setup script {}", script_path.display()))?;
    let first_line = contents.lines().next().unwrap_or_default();

    if let Some(interpreter) = first_line.strip_prefix("#!") {
        let tokens = interpreter
            .split_whitespace()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if let Some((program, args)) = tokens.split_first() {
            return Ok((program.clone(), args.to_vec()));
        }
    }

    Ok(("/bin/sh".to_string(), Vec::new()))
}

fn write_log_file(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create log directory {}", parent.display()))?;
    }

    fs::write(path, contents)
        .with_context(|| format!("Failed to write log file {}", path.display()))
}
