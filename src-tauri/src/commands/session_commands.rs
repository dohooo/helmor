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
    app: tauri::AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    session_id: String,
    action: String,
) -> CmdResult<()> {
    if !matches!(action.as_str(), "pause" | "clear") {
        return Err(anyhow::anyhow!("Invalid mutateCodexGoal action: {action}").into());
    }
    tracing::info!(session_id = %session_id, action = %action, "mutate_codex_goal");

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
    let join_result = tauri::async_runtime::spawn_blocking(move || {
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
    .await;

    // Always unsubscribe — even when the worker panicked / produced a
    // join error — to avoid leaking the listener slot in the sidecar's
    // map. Both the join error and the worker's own outcome propagate
    // after the cleanup.
    sidecar.unsubscribe(&rid);
    let outcome =
        join_result.map_err(|e| anyhow::anyhow!("mutate_codex_goal worker join failed: {e}"))?;
    outcome?;

    // Mirror the goal mutation locally so the banner reflects the new
    // state on the next React Query refetch. Codex eventually pushes
    // `thread/goal/updated` too, but the notification flows through a
    // stale per-stream handler when no fresh sendMessage is in flight,
    // so we can't rely on it. `apply_local_mutation` is idempotent.
    let session_for_local = session_id.clone();
    let action_for_local = action.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        crate::agents::streaming::codex_goal::apply_local_mutation(
            &app,
            &session_for_local,
            &action_for_local,
        );
    })
    .await;

    Ok(())
}

/// Bulk-load every persisted composer draft. Frontend calls this once
/// at app boot and hydrates an in-memory map keyed by `session:<id>`,
/// preserving the synchronous API the existing draft-storage exposes.
#[tauri::command]
pub async fn list_session_drafts() -> CmdResult<Vec<sessions::SessionDraftRow>> {
    run_blocking(sessions::list_session_drafts).await
}

/// Persist (or clear) a session's composer draft. Pass `None` to clear.
#[tauri::command]
pub async fn set_session_draft(session_id: String, draft_state: Option<String>) -> CmdResult<()> {
    run_blocking(move || {
        sessions::set_session_draft(&session_id, draft_state.as_deref())?;
        Ok(())
    })
    .await
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
    fast_mode: Option<bool>,
) -> CmdResult<()> {
    run_blocking(move || {
        let connection = db::write_conn()?;
        connection
            .execute(
                r#"
                UPDATE sessions SET
                  model = COALESCE(?2, model),
                  effort_level = COALESCE(?3, effort_level),
                  permission_mode = COALESCE(?4, permission_mode),
                  fast_mode = COALESCE(?5, fast_mode)
                WHERE id = ?1
                "#,
                rusqlite::params![session_id, model, effort_level, permission_mode, fast_mode],
            )
            .context("Failed to update session settings")?;
        Ok(())
    })
    .await
}
