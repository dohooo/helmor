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

/// Out-of-band Codex `/goal` lifecycle control. The banner buttons
/// (Pause / Resume / Clear) call this directly so the operations don't
/// appear in chat history. Routes to the sidecar's `mutateCodexGoal`
/// method, which then dispatches to the right `thread/goal/*` RPC.
#[tauri::command]
pub async fn mutate_codex_goal(
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    session_id: String,
    action: String,
) -> CmdResult<()> {
    if !matches!(action.as_str(), "pause" | "resume" | "clear") {
        return Err(anyhow::anyhow!("Invalid mutateCodexGoal action: {action}").into());
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let req = crate::sidecar::SidecarRequest {
        id: request_id.clone(),
        method: "mutateCodexGoal".to_string(),
        params: serde_json::json!({
            "sessionId": session_id,
            "action": action,
        }),
    };

    let rx = sidecar.subscribe(&request_id);
    if let Err(error) = sidecar.send(&req) {
        sidecar.unsubscribe(&request_id);
        return Err(anyhow::anyhow!("Sidecar send failed: {error}").into());
    }

    let rid = request_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(anyhow::anyhow!("mutateCodexGoal timed out"));
            }
            match rx.recv_timeout(remaining) {
                Ok(event) => {
                    if event.event_type() == "pong" {
                        return Ok(());
                    }
                    if event.event_type() == "error" {
                        let msg = event
                            .raw
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("sidecar error")
                            .to_string();
                        return Err(anyhow::anyhow!(msg));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err(anyhow::anyhow!("mutateCodexGoal timed out"));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(anyhow::anyhow!("Sidecar disconnected before responding"));
                }
            }
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("mutate_codex_goal worker join failed: {e}"))?;

    sidecar.unsubscribe(&rid);
    outcome?;
    Ok(())
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
