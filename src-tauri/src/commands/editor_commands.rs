use anyhow::{anyhow, Context};

use crate::{editor_files, git_ops, helpers, models::workspaces as workspace_models};

use super::common::{run_blocking, CmdResult};

#[tauri::command]
pub async fn read_editor_file(path: String) -> CmdResult<editor_files::EditorFileReadResponse> {
    run_blocking(move || editor_files::read_editor_file(&path)).await
}

#[tauri::command]
pub async fn read_file_at_ref(
    workspace_root_path: String,
    file_path: String,
    git_ref: String,
) -> CmdResult<Option<String>> {
    run_blocking(move || editor_files::read_file_at_ref(&workspace_root_path, &file_path, &git_ref))
        .await
}

#[tauri::command]
pub async fn list_editor_files(
    workspace_root_path: String,
) -> CmdResult<Vec<editor_files::EditorFileListItem>> {
    run_blocking(move || editor_files::list_editor_files(&workspace_root_path)).await
}

#[tauri::command]
pub async fn list_workspace_files(
    workspace_root_path: String,
) -> CmdResult<Vec<editor_files::EditorFileListItem>> {
    run_blocking(move || editor_files::list_workspace_files(&workspace_root_path)).await
}

#[tauri::command]
pub async fn list_editor_files_with_content(
    workspace_root_path: String,
) -> CmdResult<editor_files::EditorFilesWithContentResponse> {
    run_blocking(move || editor_files::list_editor_files_with_content(&workspace_root_path)).await
}

#[tauri::command]
pub async fn list_workspace_changes(
    workspace_root_path: String,
) -> CmdResult<Vec<editor_files::EditorFileListItem>> {
    run_blocking(move || editor_files::list_workspace_changes(&workspace_root_path)).await
}

#[tauri::command]
pub async fn list_workspace_changes_with_content(
    workspace_root_path: String,
) -> CmdResult<editor_files::EditorFilesWithContentResponse> {
    run_blocking(move || editor_files::list_workspace_changes_with_content(&workspace_root_path))
        .await
}

/// Sidebar-row totals: `+additions / -deletions` across all areas. Resolved
/// from a workspace ID (rather than a root path) because the row carries the
/// ID, not the on-disk path. Returns zeros for archived / vanished
/// workspaces so the row simply hides the chip instead of erroring out.
#[tauri::command]
pub async fn get_workspace_diff_stats(
    workspace_id: String,
) -> CmdResult<editor_files::WorkspaceDiffStats> {
    run_blocking(move || {
        let Some(record) = workspace_models::load_workspace_record_by_id(&workspace_id)? else {
            return Ok(editor_files::WorkspaceDiffStats::default());
        };
        let path = helpers::workspace_path(&record)
            .with_context(|| format!("Resolving path for workspace {workspace_id}"))?;
        let path_str = path
            .to_str()
            .ok_or_else(|| anyhow!("Workspace path is not valid UTF-8: {}", path.display()))?;
        editor_files::compute_workspace_diff_stats(path_str)
    })
    .await
}

#[tauri::command]
pub async fn discard_workspace_file(
    workspace_root_path: String,
    relative_path: String,
) -> CmdResult<()> {
    run_blocking(move || editor_files::discard_workspace_file(&workspace_root_path, &relative_path))
        .await
}

#[tauri::command]
pub async fn stage_workspace_file(
    workspace_root_path: String,
    relative_path: String,
) -> CmdResult<()> {
    run_blocking(move || editor_files::stage_workspace_file(&workspace_root_path, &relative_path))
        .await
}

#[tauri::command]
pub async fn unstage_workspace_file(
    workspace_root_path: String,
    relative_path: String,
) -> CmdResult<()> {
    run_blocking(move || editor_files::unstage_workspace_file(&workspace_root_path, &relative_path))
        .await
}

#[tauri::command]
pub async fn get_workspace_git_action_status(
    workspace_id: String,
) -> CmdResult<git_ops::WorkspaceGitActionStatus> {
    run_blocking(move || {
        let record = workspace_models::load_workspace_record_by_id(&workspace_id)?
            .with_context(|| format!("Workspace not found: {workspace_id}"))?;
        let quiet_status = || git_ops::WorkspaceGitActionStatus {
            uncommitted_count: 0,
            conflict_count: 0,
            sync_target_branch: record
                .intended_target_branch
                .clone()
                .or_else(|| record.default_branch.clone()),
            sync_status: git_ops::WorkspaceSyncStatus::UpToDate,
            behind_target_count: 0,
            remote_tracking_ref: None,
            ahead_of_remote_count: 0,
            ahead_of_target_count: 0,
            push_status: git_ops::WorkspacePushStatus::Unpublished,
        };
        // Non-operational workspaces (Initializing / Archived) have no live
        // worktree to inspect — Initializing because Phase 2 hasn't run yet,
        // Archived because the worktree has been removed. Running `git status`
        // against them would either error or return stale data. Short-circuit
        // to the canonical "fresh/quiet" status; the frontend can't take any
        // action on them anyway.
        if !record.state.is_operational() {
            return Ok(quiet_status());
        }
        let workspace_dir = crate::workspace::helpers::workspace_path(&record)?;
        // Defensive: if the worktree directory was removed externally (e.g.
        // user `rm -rf`ed it while the row is still `ready`), return quiet
        // status rather than erroring on every poll. User-triggered paths
        // (stage/unstage/send message) are where we surface WorkspaceBroken;
        // this poll is invisible and stays silent. Logged as warn (not debug)
        // so release builds still show the anomaly.
        if !workspace_dir.is_dir() {
            tracing::warn!(
                workspace_id = %workspace_id,
                path = %workspace_dir.display(),
                "worktree missing during git-status poll; returning quiet status",
            );
            return Ok(quiet_status());
        }
        let remote = record.remote.as_deref();
        let target_branch = record
            .intended_target_branch
            .as_deref()
            .or(record.default_branch.as_deref());
        git_ops::workspace_action_status(&workspace_dir, remote, target_branch)
    })
    .await
}

#[tauri::command]
pub async fn write_editor_file(
    path: String,
    content: String,
    expected_mtime_ms: Option<i64>,
    overwrite: Option<bool>,
) -> CmdResult<editor_files::EditorFileWriteOutcome> {
    let options = editor_files::EditorFileWriteOptions {
        expected_mtime_ms,
        overwrite: overwrite.unwrap_or(false),
    };
    run_blocking(move || editor_files::write_editor_file(&path, &content, options)).await
}

#[tauri::command]
pub async fn stat_editor_file(path: String) -> CmdResult<editor_files::EditorFileStatResponse> {
    run_blocking(move || editor_files::stat_editor_file(&path)).await
}

#[tauri::command]
pub async fn list_workspace_directory(
    workspace_root_path: String,
    relative_path: String,
) -> CmdResult<Vec<editor_files::DirEntry>> {
    run_blocking(move || {
        crate::workspace::files::listing::list_directory(&workspace_root_path, &relative_path)
    })
    .await
}

#[tauri::command]
pub async fn search_workspace_paths(
    workspace_root_path: String,
    query: String,
) -> CmdResult<Vec<editor_files::PathSearchHit>> {
    run_blocking(move || {
        crate::workspace::files::search::search_paths(&workspace_root_path, &query)
    })
    .await
}
