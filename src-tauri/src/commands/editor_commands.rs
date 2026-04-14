use anyhow::Context;

use crate::{editor_files, git_ops, models::workspaces as workspace_models};

use super::common::{run_blocking, CmdResult};

#[tauri::command]
pub async fn read_editor_file(path: String) -> CmdResult<editor_files::EditorFileReadResponse> {
    run_blocking(move || editor_files::read_editor_file(&path)).await
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
        let workspace_dir =
            crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
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
) -> CmdResult<editor_files::EditorFileWriteResponse> {
    run_blocking(move || editor_files::write_editor_file(&path, &content)).await
}

#[tauri::command]
pub async fn stat_editor_file(path: String) -> CmdResult<editor_files::EditorFileStatResponse> {
    run_blocking(move || editor_files::stat_editor_file(&path)).await
}
