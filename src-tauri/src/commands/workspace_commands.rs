use tauri::AppHandle;

use crate::{db, git_watcher, workspaces};

use super::common::{run_blocking, CmdResult};

#[tauri::command]
pub async fn create_workspace_from_repo(
    app: AppHandle,
    repo_id: String,
) -> CmdResult<workspaces::CreateWorkspaceResponse> {
    let _lock = db::WORKSPACE_MUTATION_LOCK.lock().await;
    let result =
        run_blocking(move || workspaces::create_workspace_from_repo_impl(&repo_id)).await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(result)
}

/// Transition a workspace from "setup_pending" to "ready" (e.g. when no
/// setup script is configured but the workspace was created with that state).
#[tauri::command]
pub async fn complete_workspace_setup(app: AppHandle, workspace_id: String) -> CmdResult<()> {
    run_blocking(move || {
        let ts = crate::models::db::current_timestamp()?;
        crate::models::workspaces::update_workspace_state(&workspace_id, "ready", &ts)
    })
    .await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn list_workspace_groups() -> CmdResult<Vec<workspaces::WorkspaceSidebarGroup>> {
    run_blocking(workspaces::list_workspace_groups).await
}

#[tauri::command]
pub async fn list_archived_workspaces() -> CmdResult<Vec<workspaces::WorkspaceSummary>> {
    run_blocking(workspaces::list_archived_workspaces).await
}

#[tauri::command]
pub async fn get_workspace(workspace_id: String) -> CmdResult<workspaces::WorkspaceDetail> {
    run_blocking(move || workspaces::get_workspace(&workspace_id)).await
}

#[tauri::command]
pub async fn mark_workspace_read(workspace_id: String) -> CmdResult<()> {
    let ws_lock = db::workspace_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    Ok(workspaces::mark_workspace_read(&workspace_id)?)
}

#[tauri::command]
pub async fn mark_workspace_unread(workspace_id: String) -> CmdResult<()> {
    let ws_lock = db::workspace_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    Ok(workspaces::mark_workspace_unread(&workspace_id)?)
}

#[tauri::command]
pub async fn pin_workspace(workspace_id: String) -> CmdResult<()> {
    let ws_lock = db::workspace_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    Ok(workspaces::pin_workspace(&workspace_id)?)
}

#[tauri::command]
pub async fn unpin_workspace(workspace_id: String) -> CmdResult<()> {
    let ws_lock = db::workspace_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    Ok(workspaces::unpin_workspace(&workspace_id)?)
}

#[tauri::command]
pub async fn set_workspace_manual_status(
    workspace_id: String,
    status: Option<String>,
) -> CmdResult<()> {
    let ws_lock = db::workspace_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    Ok(workspaces::set_workspace_manual_status(
        &workspace_id,
        status.as_deref(),
    )?)
}

#[tauri::command]
pub async fn list_remote_branches(
    workspace_id: Option<String>,
    repo_id: Option<String>,
) -> CmdResult<Vec<String>> {
    run_blocking(move || {
        workspaces::list_remote_branches(workspace_id.as_deref(), repo_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn rename_workspace_branch(
    app: AppHandle,
    workspace_id: String,
    new_branch: String,
) -> CmdResult<()> {
    let ws_lock = db::workspace_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    run_blocking(move || workspaces::rename_workspace_branch(&workspace_id, &new_branch)).await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn update_intended_target_branch(
    workspace_id: String,
    target_branch: String,
) -> CmdResult<workspaces::UpdateIntendedTargetBranchResponse> {
    let ws_lock = db::workspace_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    run_blocking(move || workspaces::update_intended_target_branch(&workspace_id, &target_branch))
        .await
}

#[tauri::command]
pub async fn prefetch_remote_refs(
    workspace_id: Option<String>,
    repo_id: Option<String>,
) -> CmdResult<workspaces::PrefetchRemoteRefsResponse> {
    run_blocking(move || {
        workspaces::prefetch_remote_refs(workspace_id.as_deref(), repo_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn restore_workspace(
    app: AppHandle,
    workspace_id: String,
    target_branch_override: Option<String>,
) -> CmdResult<workspaces::RestoreWorkspaceResponse> {
    let ws_lock = db::workspace_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    let result = run_blocking(move || {
        workspaces::restore_workspace_impl(&workspace_id, target_branch_override.as_deref())
    })
    .await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(result)
}

#[tauri::command]
pub async fn validate_restore_workspace(
    workspace_id: String,
) -> CmdResult<workspaces::ValidateRestoreResponse> {
    run_blocking(move || workspaces::validate_restore_workspace(&workspace_id)).await
}

#[tauri::command]
pub async fn archive_workspace(
    app: AppHandle,
    workspace_id: String,
) -> CmdResult<workspaces::ArchiveWorkspaceResponse> {
    let ws_lock = db::workspace_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    let result = run_blocking(move || workspaces::archive_workspace_impl(&workspace_id)).await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(result)
}

#[tauri::command]
pub async fn validate_archive_workspace(workspace_id: String) -> CmdResult<()> {
    run_blocking(move || workspaces::validate_archive_workspace(&workspace_id)).await
}

#[tauri::command]
pub async fn permanently_delete_workspace(app: AppHandle, workspace_id: String) -> CmdResult<()> {
    let ws_lock = db::workspace_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    run_blocking(move || workspaces::permanently_delete_workspace(&workspace_id)).await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(())
}
