//! Tauri commands for the voice planner.
//!
//! The frontend dispatcher calls `start_planner_turn` after it sees rt
//! invoke the `ask_planner` tool. The command returns immediately with
//! a turn id; planner events arrive on the supplied `Channel`. Abort is
//! a separate command keyed by the same turn id.

use tauri::{ipc::Channel, Manager};

use crate::voice_planner::{
    self, fabricate_turn_id, tools::TauriPlannerTools, ManagedPlanner, PlannerEvent,
    PlannerTurnAccepted,
};
use crate::workspace::scripts::ScriptProcessManager;

use super::common::CmdResult;

/// Start a new planner turn. Returns immediately; the streaming work
/// continues on a spawned tokio task. The caller MUST keep the
/// `on_event` channel alive — dropping it cancels event delivery.
#[tauri::command]
pub async fn start_planner_turn(
    app: tauri::AppHandle,
    transcript: String,
    on_event: Channel<PlannerEvent>,
) -> CmdResult<PlannerTurnAccepted> {
    let turn_id = fabricate_turn_id();
    let api_key =
        voice_planner::load_planner_api_key().map_err(crate::error::CommandError::from)?;

    let planner_handle = app.clone();
    let app_for_task = app.clone();
    let turn_id_for_task = turn_id.clone();
    tauri::async_runtime::spawn(async move {
        let planner = planner_handle.state::<ManagedPlanner>();
        let scripts_manager = app_for_task.state::<ScriptProcessManager>().inner().clone();
        let planner_tools = TauriPlannerTools {
            app: app_for_task,
            scripts_manager,
        };
        if let Err(e) = voice_planner::run_turn(
            &planner_tools,
            &planner,
            api_key,
            turn_id_for_task.clone(),
            transcript,
            on_event,
        )
        .await
        {
            tracing::warn!(
                target: "planner::lifecycle",
                turn_id = %turn_id_for_task,
                error = %format!("{e:#}"),
                "planner turn ended with error"
            );
        }
    });

    Ok(PlannerTurnAccepted { turn_id })
}

/// Abort an in-flight planner turn. No-op if the id is unknown.
#[tauri::command]
pub async fn abort_planner_turn(app: tauri::AppHandle, turn_id: String) -> CmdResult<()> {
    let aborted = app.state::<ManagedPlanner>().abort(&turn_id);
    tracing::info!(
        target: "planner::lifecycle",
        turn_id = %turn_id,
        aborted,
        "abort_planner_turn"
    );
    Ok(())
}
