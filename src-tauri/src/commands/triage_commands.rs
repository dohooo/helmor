//! Tauri commands for the AI-triage feature.

use tauri::{AppHandle, Runtime, State};

use crate::commands::common::{run_blocking, CmdResult};
use crate::triage::{self, ActiveStatusStore, TriageConfig, TriageStatus};
use crate::ui_sync::{self, UiMutationEvent};

#[tauri::command]
pub async fn get_triage_config() -> CmdResult<TriageConfig> {
    run_blocking(triage::load_config).await
}

#[tauri::command]
pub async fn update_triage_config<R: Runtime>(
    app: AppHandle<R>,
    config: TriageConfig,
) -> CmdResult<()> {
    run_blocking(move || triage::save_config(&config)).await?;
    ui_sync::publish(&app, UiMutationEvent::TriageConfigChanged);
    Ok(())
}

#[tauri::command]
pub async fn get_triage_active_status(
    store: State<'_, ActiveStatusStore>,
) -> CmdResult<TriageStatus> {
    Ok(store.snapshot())
}

#[tauri::command]
pub async fn trigger_triage_tick_now<R: Runtime>(app: AppHandle<R>) -> CmdResult<String> {
    run_blocking(move || triage::trigger_tick_now(&app)).await
}
