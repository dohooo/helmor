//! Tauri commands for automations — IPC glue over `automations::ops`.
//! Every mutation publishes `UiMutationEvent::AutomationsChanged` so the
//! frontend invalidates the `automations` query through the global bridge.

use serde::Deserialize;
use tauri::AppHandle;

use super::common::{run_blocking, CmdResult};
use crate::automations::ops;
use crate::models::automations::AutomationRecord;
use crate::ui_sync::{self, UiMutationEvent};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAutomationRequest {
    pub title: String,
    pub prompt: String,
    pub runs_in: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub schedule: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAutomationRequest {
    pub id: String,
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub runs_in: Option<String>,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub schedule: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn list_automations() -> CmdResult<Vec<AutomationRecord>> {
    run_blocking(crate::models::automations::list_automations).await
}

#[tauri::command]
pub async fn create_automation(
    app: AppHandle,
    request: CreateAutomationRequest,
) -> CmdResult<AutomationRecord> {
    let record = run_blocking(move || {
        ops::create_automation(ops::CreateAutomationInput {
            title: request.title,
            prompt: request.prompt,
            runs_in: request.runs_in,
            session_id: request.session_id,
            workspace_id: request.workspace_id,
            schedule: request.schedule,
        })
    })
    .await?;
    ui_sync::publish(&app, UiMutationEvent::AutomationsChanged);
    Ok(record)
}

#[tauri::command]
pub async fn update_automation(
    app: AppHandle,
    request: UpdateAutomationRequest,
) -> CmdResult<AutomationRecord> {
    let record = run_blocking(move || {
        ops::update_automation(
            &request.id,
            ops::UpdateAutomationInput {
                title: request.title,
                prompt: request.prompt,
                runs_in: request.runs_in,
                session_id: request.session_id,
                workspace_id: request.workspace_id,
                schedule: request.schedule,
            },
        )
    })
    .await?;
    ui_sync::publish(&app, UiMutationEvent::AutomationsChanged);
    Ok(record)
}

#[tauri::command]
pub async fn delete_automation(app: AppHandle, automation_id: String) -> CmdResult<()> {
    run_blocking(move || crate::models::automations::delete_automation(&automation_id)).await?;
    ui_sync::publish(&app, UiMutationEvent::AutomationsChanged);
    Ok(())
}

/// Pause (`paused`) or resume (`active`). Resume recomputes `next_run_at`
/// from now — no immediate fire.
#[tauri::command]
pub async fn set_automation_status(
    app: AppHandle,
    automation_id: String,
    status: String,
) -> CmdResult<AutomationRecord> {
    let record = run_blocking(move || ops::set_status(&automation_id, &status)).await?;
    ui_sync::publish(&app, UiMutationEvent::AutomationsChanged);
    Ok(record)
}

/// Dispatch immediately; records `last_run_at` only — the schedule is
/// untouched. Returns the session id the run landed in so the frontend can
/// offer a "view chat" jump.
#[tauri::command]
pub async fn run_automation_now(app: AppHandle, automation_id: String) -> CmdResult<String> {
    let handle = app.clone();
    let session_id = run_blocking(move || ops::run_now(&handle, &automation_id)).await?;
    ui_sync::publish(&app, UiMutationEvent::AutomationsChanged);
    Ok(session_id)
}
