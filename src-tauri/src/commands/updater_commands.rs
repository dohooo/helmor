use tauri::AppHandle;

use crate::updater;

use super::common::CmdResult;

#[tauri::command]
pub async fn get_app_update_status(app: AppHandle) -> CmdResult<updater::UpdateStatusSnapshot> {
    Ok(updater::snapshot(app))
}

#[tauri::command]
pub async fn check_for_app_update(
    app: AppHandle,
    force: Option<bool>,
) -> CmdResult<updater::UpdateStatusSnapshot> {
    Ok(updater::trigger_check(app, updater::CheckReason::Manual, force.unwrap_or(false)).await)
}

#[tauri::command]
pub async fn install_downloaded_app_update(
    app: AppHandle,
) -> CmdResult<updater::UpdateStatusSnapshot> {
    Ok(updater::install_downloaded_update(app).await)
}
