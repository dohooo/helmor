use tauri::AppHandle;

use crate::{git_watcher, import};

use super::common::{run_blocking, CmdResult};

#[tauri::command]
pub fn conductor_source_available() -> bool {
    import::conductor_source_available()
}

#[tauri::command]
pub async fn list_conductor_repos() -> CmdResult<Vec<import::ConductorRepo>> {
    run_blocking(import::list_conductor_repos).await
}

#[tauri::command]
pub async fn list_conductor_workspaces(
    repo_id: String,
) -> CmdResult<Vec<import::ConductorWorkspace>> {
    run_blocking(move || import::list_conductor_workspaces(&repo_id)).await
}

#[tauri::command]
pub async fn import_conductor_workspaces(
    app: AppHandle,
    workspace_ids: Vec<String>,
) -> CmdResult<import::ImportWorkspacesResult> {
    let result = run_blocking(move || import::import_conductor_workspaces(&workspace_ids)).await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(result)
}
