use anyhow::Context;

use crate::{
    agents::{self, ActionKind},
    db, pipeline, sessions,
};

use super::common::{run_blocking, CmdResult};

#[tauri::command]
pub async fn list_workspace_sessions(
    workspace_id: String,
) -> CmdResult<Vec<sessions::WorkspaceSessionSummary>> {
    run_blocking(move || sessions::list_workspace_sessions(&workspace_id)).await
}

#[tauri::command]
pub async fn list_session_thread_messages(
    session_id: String,
) -> CmdResult<Vec<pipeline::types::ThreadMessageLike>> {
    run_blocking(move || {
        let historical = sessions::list_session_historical_records(&session_id)?;
        Ok(pipeline::MessagePipeline::convert_historical(&historical))
    })
    .await
}

#[tauri::command]
pub async fn create_session(
    workspace_id: String,
    action_kind: Option<ActionKind>,
    permission_mode: Option<String>,
) -> CmdResult<sessions::CreateSessionResponse> {
    run_blocking(move || {
        sessions::create_session(&workspace_id, action_kind, permission_mode.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn rename_session(session_id: String, title: String) -> CmdResult<()> {
    run_blocking(move || sessions::rename_session(&session_id, &title)).await
}

#[tauri::command]
pub async fn hide_session(session_id: String) -> CmdResult<()> {
    run_blocking(move || sessions::hide_session(&session_id)).await
}

#[tauri::command]
pub async fn unhide_session(session_id: String) -> CmdResult<()> {
    run_blocking(move || sessions::unhide_session(&session_id)).await
}

#[tauri::command]
pub async fn delete_session(session_id: String) -> CmdResult<()> {
    run_blocking(move || sessions::delete_session(&session_id)).await
}

#[tauri::command]
pub async fn list_hidden_sessions(
    workspace_id: String,
) -> CmdResult<Vec<sessions::WorkspaceSessionSummary>> {
    run_blocking(move || sessions::list_hidden_sessions(&workspace_id)).await
}

#[tauri::command]
pub async fn get_session_context_usage(session_id: String) -> CmdResult<Option<String>> {
    run_blocking(move || sessions::get_session_context_usage(&session_id)).await
}

#[tauri::command]
pub async fn get_session_codex_goal(session_id: String) -> CmdResult<Option<String>> {
    run_blocking(move || sessions::get_session_codex_goal(&session_id)).await
}

/// Ad-hoc Claude-only context-usage fetch for the hover popover. Pure
/// passthrough to the sidecar — no DB write, no mutex, no TTL. The
/// frontend caches the result for 30 s via React Query.
#[tauri::command]
pub async fn get_live_context_usage(
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: agents::GetLiveContextUsageRequest,
) -> CmdResult<String> {
    agents::fetch_live_context_usage(&sidecar, request)
}

#[tauri::command]
pub async fn mark_session_read(session_id: String) -> CmdResult<()> {
    run_blocking(move || sessions::mark_session_read(&session_id)).await
}

#[tauri::command]
pub async fn mark_session_unread(session_id: String) -> CmdResult<()> {
    run_blocking(move || sessions::mark_session_unread(&session_id)).await
}

#[tauri::command]
pub async fn update_session_settings(
    session_id: String,
    model: Option<String>,
    effort_level: Option<String>,
    permission_mode: Option<String>,
) -> CmdResult<()> {
    run_blocking(move || {
        let connection = db::write_conn()?;
        connection
            .execute(
                r#"
                UPDATE sessions SET
                  model = COALESCE(?2, model),
                  effort_level = COALESCE(?3, effort_level),
                  permission_mode = COALESCE(?4, permission_mode)
                WHERE id = ?1
                "#,
                rusqlite::params![session_id, model, effort_level, permission_mode],
            )
            .context("Failed to update session settings")?;
        Ok(())
    })
    .await
}
