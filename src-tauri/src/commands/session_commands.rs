use anyhow::Context;

use crate::{
    agents::{self, ActionKind},
    db, pipeline, sessions,
};

use super::common::{run_blocking, CmdResult};

/// Broadcast a session-list mutation so teammates (and this client's other
/// windows) re-sync the sidebar / session tabs. No-op when `workspace_id` is
/// `None` (the session was already gone). In team mode this rides the shared
/// `/v1/stream` ui-sync channel to every connected member.
fn notify_session_list_changed(app: &tauri::AppHandle, workspace_id: Option<String>) {
    if let Some(workspace_id) = workspace_id {
        crate::ui_sync::publish(
            app,
            crate::ui_sync::UiMutationEvent::SessionListChanged { workspace_id },
        );
    }
}

#[tauri::command]
pub async fn list_workspace_sessions(
    workspace_id: String,
) -> CmdResult<Vec<sessions::WorkspaceSessionSummary>> {
    run_blocking(move || sessions::list_workspace_sessions(&workspace_id)).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionThreadMessagesPage {
    pub messages: Vec<pipeline::types::ThreadMessageLike>,
    pub has_more: bool,
}

#[tauri::command]
pub async fn list_session_thread_messages(
    session_id: String,
    tail_limit: Option<usize>,
) -> CmdResult<SessionThreadMessagesPage> {
    run_blocking(move || {
        let windowed = sessions::list_session_historical_records_windowed(&session_id, tail_limit)?;
        let messages = pipeline::MessagePipeline::convert_historical(&windowed.records);
        Ok(SessionThreadMessagesPage {
            messages,
            has_more: windowed.has_more,
        })
    })
    .await
}

/// One raw message row as stored in the D1 mirror (Stage B). Mirrors the columns
/// the team Worker's `GET /team/messages` returns, so the desktop can render
/// history from D1 while the sandbox sleeps.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalRecordInput {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    #[serde(default)]
    pub author_id: Option<String>,
}

/// Run the SAME historical pipeline as [`list_session_thread_messages`] over raw
/// rows supplied by the caller (the team D1 mirror) instead of the local DB.
/// LOCAL command (never proxied) — it's pure CPU, no DB, so team mode can render
/// sandbox-independent history identically to the container path.
#[tauri::command]
pub async fn convert_historical_records(
    records: Vec<HistoricalRecordInput>,
) -> CmdResult<Vec<pipeline::types::ThreadMessageLike>> {
    run_blocking(move || {
        let records: Vec<pipeline::types::HistoricalRecord> = records
            .into_iter()
            .map(|record| pipeline::types::HistoricalRecord {
                id: record.id,
                // Mirror roles are always one of user/assistant/system/error;
                // an unknown value degrades to a System notice rather than failing.
                role: record
                    .role
                    .parse()
                    .unwrap_or(pipeline::types::MessageRole::System),
                // Parse the raw mirror content into JSON so the pipeline can
                // classify + render it — same as the desktop's local read
                // (models/sessions.rs). Leaving it None rendered raw JSON in the UI.
                parsed_content: serde_json::from_str(&record.content).ok(),
                content: record.content,
                created_at: record.created_at,
                author_id: record.author_id,
            })
            .collect();
        Ok(pipeline::MessagePipeline::convert_historical(&records))
    })
    .await
}

/// `seed_session_id`: see `sessions::CreateSessionOverrides::seed_session_id` —
/// frontend-provided UUID used as the new `sessions.id` when present.
#[allow(clippy::too_many_arguments)] // Tauri IPC command — args mirror the frontend call.
#[tauri::command]
pub async fn create_session(
    app: tauri::AppHandle,
    workspace_id: String,
    action_kind: Option<ActionKind>,
    permission_mode: Option<String>,
    model: Option<String>,
    effort_level: Option<String>,
    fast_mode: Option<bool>,
    seed_session_id: Option<String>,
    session_kind: Option<String>,
    agent_type: Option<String>,
) -> CmdResult<sessions::CreateSessionResponse> {
    let ws = workspace_id.clone();
    let response = run_blocking(move || {
        sessions::create_session(
            &workspace_id,
            action_kind,
            permission_mode.as_deref(),
            sessions::CreateSessionOverrides {
                model: model.as_deref(),
                effort_level: effort_level.as_deref(),
                fast_mode,
                seed_session_id: seed_session_id.as_deref(),
                session_kind: session_kind.as_deref(),
                agent_type: agent_type.as_deref(),
            },
        )
    })
    .await?;
    notify_session_list_changed(&app, Some(ws));
    Ok(response)
}

#[tauri::command]
pub async fn rename_session(
    app: tauri::AppHandle,
    session_id: String,
    title: String,
) -> CmdResult<()> {
    let workspace_id = run_blocking(move || {
        sessions::rename_session(&session_id, &title)?;
        sessions::workspace_id_for_session(&session_id)
    })
    .await?;
    notify_session_list_changed(&app, workspace_id);
    Ok(())
}

#[tauri::command]
pub async fn hide_session(app: tauri::AppHandle, session_id: String) -> CmdResult<()> {
    let workspace_id = run_blocking(move || {
        sessions::hide_session(&session_id)?;
        sessions::workspace_id_for_session(&session_id)
    })
    .await?;
    notify_session_list_changed(&app, workspace_id);
    Ok(())
}

#[tauri::command]
pub async fn unhide_session(app: tauri::AppHandle, session_id: String) -> CmdResult<()> {
    let workspace_id = run_blocking(move || {
        sessions::unhide_session(&session_id)?;
        sessions::workspace_id_for_session(&session_id)
    })
    .await?;
    notify_session_list_changed(&app, workspace_id);
    Ok(())
}

#[tauri::command]
pub async fn delete_session(app: tauri::AppHandle, session_id: String) -> CmdResult<()> {
    let workspace_id = run_blocking(move || {
        // Resolve the workspace BEFORE the row is gone; afterwards the lookup
        // returns None and the teammate broadcast would be lost.
        let workspace_id = sessions::workspace_id_for_session(&session_id)?;
        sessions::delete_session(&session_id)?;
        Ok(workspace_id)
    })
    .await?;
    notify_session_list_changed(&app, workspace_id);
    Ok(())
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

/// Frontend-initiated write of `context_usage_meta`. Used when a
/// trustworthy Claude hover fetch returns fresher numbers than the
/// last persisted turn-end record — promotes them into the DB so the
/// ring stays accurate across cold starts.
#[tauri::command]
pub async fn set_session_context_usage(
    app: tauri::AppHandle,
    session_id: String,
    meta: String,
) -> CmdResult<()> {
    run_blocking(move || {
        crate::agents::streaming::context_usage::persist_context_usage_meta(
            &app,
            &session_id,
            &meta,
        );
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn get_session_codex_goal(session_id: String) -> CmdResult<Option<String>> {
    run_blocking(move || sessions::get_session_codex_goal(&session_id)).await
}

/// Latest normalised plan projection for `session_id`. Backed by
/// `session_plan_state`; populated by the streaming bridge when
/// Codex emits `turn/plan/updated` or Claude emits `ExitPlanMode`.
/// `Ok(None)` means the session has never carried a plan (or the
/// stored row failed validation — the loader logs and returns
/// `None` instead of bubbling the error so the pinned-plan UI can
/// degrade gracefully).
#[tauri::command]
pub async fn get_session_plan_state(
    session_id: String,
) -> CmdResult<Option<crate::agents::session_plan::SessionPlanState>> {
    run_blocking(move || crate::agents::session_plan::load_session_plan_state(&session_id)).await
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

/// Companion/team variant: with a trusted `member_id`, advance that member's
/// per-session read cursor; without one (`None`) fall back to the global
/// local-mode clear so the desktop path is unchanged.
pub async fn mark_session_read_for_member(
    session_id: String,
    member_id: Option<String>,
) -> CmdResult<()> {
    run_blocking(move || match member_id {
        Some(member) => sessions::mark_session_read_for_member(&session_id, &member),
        None => sessions::mark_session_read(&session_id),
    })
    .await
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
                rusqlite::params![session_id, model, effort_level, permission_mode, fast_mode,],
            )
            .context("Failed to update session settings")?;
        Ok(())
    })
    .await
}
