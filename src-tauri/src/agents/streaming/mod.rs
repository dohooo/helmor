use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

/// Maximum time we wait between sidecar events before declaring the sidecar
/// dead. The sidecar emits a `heartbeat` event every 15s for every active
/// stream; 45s = 3× heartbeat interval tolerates a single missed tick from
/// GC / busy system without false positives. A long-running tool call (e.g.
/// `bash: pytest` for 20 minutes) is fine because heartbeats keep flowing
/// regardless of what the AI is doing.
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);

mod actions;
mod active_streams;
mod bridges;
mod cleanup;
pub(crate) mod codex_goal;
mod context_usage;
mod params;
mod session_id;
mod state;

#[cfg(test)]
mod event_loop_tests;

pub(crate) use active_streams::ActiveStreamHandle;
pub use active_streams::{abort_all_active_streams_blocking, ActiveStreamSummary, ActiveStreams};
pub use bridges::{
    bridge_aborted_event, bridge_done_event, bridge_error_event, bridge_permission_request_event,
    bridge_user_input_request_event,
};
pub(crate) use cleanup::cleanup_abnormal_stream_exit;
pub use params::{
    build_send_message_params, lookup_workspace_linked_directories, BuildSendMessageParamsInput,
};
use session_id::should_adopt_provider_session_id;

use rusqlite::params;
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, Manager};
use uuid::Uuid;

use crate::pipeline::types::{
    ExtendedMessagePart, MessagePart, MessageRole, PlanAllowedPrompt, ThreadMessageLike,
};

use super::{
    finalize_session_metadata, persist_error_message, persist_exit_plan_message,
    persist_result_and_finalize, persist_turn_message, persist_user_message, AgentSendRequest,
    AgentStreamEvent, CmdResult, ExchangeContext,
};

#[allow(clippy::too_many_arguments)]
pub(super) fn stream_via_sidecar(
    app: AppHandle,
    on_event: Channel<AgentStreamEvent>,
    sidecar: &crate::sidecar::ManagedSidecar,
    active_streams: &ActiveStreams,
    stream_id: &str,
    model: &super::ResolvedModel,
    prompt: &str,
    request: &AgentSendRequest,
    working_directory: &Path,
) -> CmdResult<()> {
    let request_id = stream_id.to_string();

    tracing::debug!(
        provider = %model.provider,
        model = %model.cli_model,
        cwd = %working_directory.display(),
        prompt_len = prompt.len(),
        "stream_via_sidecar"
    );

    // Single read against `sessions` for both lookups we need below:
    // resume-session matching (provider_session_id + agent_type) and the
    // workspace_id we stamp onto the active-streams handle. Two queries
    // would borrow the read pool twice on the hot path of every send.
    let session_row: Option<(Option<String>, Option<String>, Option<String>)> =
        request.helmor_session_id.as_deref().and_then(|hsid| {
            let conn = crate::models::db::read_conn().ok()?;
            conn.query_row(
                "SELECT provider_session_id, agent_type, workspace_id FROM sessions WHERE id = ?1",
                [hsid],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok()
        });

    let resume_session_id = request.session_id.clone().or_else(|| {
        let (stored_sid, stored_provider, _) = session_row.as_ref()?;
        let sid = stored_sid.clone()?;
        if stored_provider.clone().unwrap_or_default() == model.provider {
            Some(sid)
        } else {
            None
        }
    });

    tracing::debug!(
        resume_session_id = ?resume_session_id,
        helmor_session_id = ?request.helmor_session_id,
        provider = %model.provider,
        "Session resume context"
    );

    let helmor_session_id = request.helmor_session_id.clone();
    let sidecar_session_id = helmor_session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    // Combine the optional hidden preamble with the user's prompt. Only
    // the wire payload sees the combined string — `prompt` (user text
    // only) is what gets persisted in `persist_user_message` below, so
    // the chat bubble + DB stay free of the preference prefix.
    let prefix_trimmed = request
        .prompt_prefix
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let combined_prompt = match prefix_trimmed {
        Some(prefix) => format!("{prefix}\n\nUser request:\n{prompt}"),
        None => prompt.to_string(),
    };

    let images_for_wire = request.images.clone().unwrap_or_default();
    let params = build_send_message_params(BuildSendMessageParamsInput {
        sidecar_session_id: &sidecar_session_id,
        prompt: &combined_prompt,
        cli_model: &model.cli_model,
        cwd: &working_directory.display().to_string(),
        resume_session_id: resume_session_id.as_deref(),
        provider: &model.provider,
        effort_level: request.effort_level.as_deref(),
        permission_mode: request.permission_mode.as_deref(),
        fast_mode: request.fast_mode.unwrap_or(false),
        helmor_session_id: request.helmor_session_id.as_deref(),
        claude_base_url: model.claude_base_url.as_deref(),
        claude_auth_token: model.claude_auth_token.as_deref(),
        images: &images_for_wire,
    });

    // Surface the `/add-dir` decision in logs — we often debug linked-
    // directory issues by asking "did the path actually make it to the
    // sidecar?" and this answers that without grepping the sidecar
    // wire-format later.
    if let Some(arr) = params
        .get("additionalDirectories")
        .and_then(|v| v.as_array())
    {
        tracing::info!(
            count = arr.len(),
            dirs = ?arr,
            helmor_session_id = ?request.helmor_session_id,
            "sendMessage with linked additionalDirectories"
        );
    } else {
        tracing::info!(
            helmor_session_id = ?request.helmor_session_id,
            "sendMessage without linked additionalDirectories (none configured)"
        );
    }

    let sidecar_req = crate::sidecar::SidecarRequest {
        id: request_id.clone(),
        method: "sendMessage".to_string(),
        params,
    };

    // Workspace for the UI's "this workspace is busy" badge —
    // pulled out of the same `session_row` we already read above so
    // we don't borrow the read pool a second time on every send.
    let workspace_id_for_handle = session_row
        .as_ref()
        .and_then(|(_, _, workspace_id)| workspace_id.clone());

    // Per-helmor-session lock — block overlapping sends so concurrent
    // `query()` calls can't stack against the same `resume:` id and
    // corrupt the conversation jsonl (issue #398).
    let registered = active_streams.try_register_for_session(ActiveStreamHandle {
        request_id: request_id.clone(),
        sidecar_session_id: sidecar_session_id.clone(),
        provider: model.provider.to_string(),
        helmor_session_id: request.helmor_session_id.clone(),
        workspace_id: workspace_id_for_handle,
    });
    if !registered {
        tracing::warn!(
            rid = %request_id,
            helmor_session_id = ?request.helmor_session_id,
            "Rejecting send: another stream is already active for this session"
        );
        return Err(anyhow::anyhow!(
            "A previous send is still running for this session. Wait for it to finish or stop it first."
        )
        .into());
    }
    // Notify the UI that the active-streams set changed. Anonymous
    // streams (helmor_session_id == None) are filtered out of the
    // snapshot the frontend reads, but we still publish — the
    // frontend's invalidate is cheap and the alternative (branch on
    // visibility here) couples this call site to UI policy.
    crate::ui_sync::publish(&app, crate::ui_sync::UiMutationEvent::ActiveStreamsChanged);

    let rx = sidecar.subscribe(&request_id);

    if let Err(error) = sidecar.send(&sidecar_req) {
        sidecar.unsubscribe(&request_id);
        active_streams.unregister(&request_id);
        crate::ui_sync::publish(&app, crate::ui_sync::UiMutationEvent::ActiveStreamsChanged);
        return Err(anyhow::anyhow!("Sidecar send failed: {error}").into());
    }

    let model_id = model.id.clone();
    let provider = model.provider.clone();
    let model_copy = model.clone();
    let prompt_copy = prompt.to_string();
    let working_dir_str = working_directory.display().to_string();
    let hsid_copy = helmor_session_id;
    let effort_copy = request.effort_level.clone();
    let permission_mode_initial = request.permission_mode.clone();
    let fast_mode = request.fast_mode.unwrap_or(false);
    let user_message_id_copy = request.user_message_id.clone();
    let files_copy = request.files.clone().unwrap_or_default();
    let images_copy = request.images.clone().unwrap_or_default();
    let sidecar_session_id_copy = sidecar_session_id.clone();
    let rid = request_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let stream_started_at = Instant::now();
        tracing::info!(
            rid = %rid,
            helmor_session_id = ?hsid_copy,
            sidecar_session_id = %sidecar_session_id_copy,
            provider = %provider,
            model = %model_copy.cli_model,
            "stream: event loop starting"
        );

        let sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecar> = app.state();
        let active_streams_state: tauri::State<'_, ActiveStreams> = app.state();
        let mut resolved_session_id: Option<String> = resume_session_id.clone();
        let context_key = rid.clone();
        let pipeline_session_id = hsid_copy.clone().unwrap_or_else(|| context_key.clone());
        let mut pipeline = hsid_copy.as_ref().map(|_| {
            crate::pipeline::MessagePipeline::new(
                provider.as_str(),
                &model_copy.cli_model,
                &context_key,
                &pipeline_session_id,
            )
        });
        let mut event_count: u64 = 0;
        let mut heartbeat_count: u64 = 0;

        let mut exchange_ctx: Option<ExchangeContext> = None;
        // `persisted_turn_count` lives in this local rather than in
        // `turn_session.ctx` because the inline DB-write loops in each
        // arm need shared `&mut` access alongside the pipeline's
        // `accumulator.turn_at()`. Once the persist loop migrates
        // behind `Action::PersistTurnRange`, this can move into ctx.
        let mut persisted_turn_count: usize = 0;

        // Short-borrow only. The single-writer pool (max_size=1) is shared
        // with every other write in the app; a long-held handle here would
        // block pin/unpin/mark-read/rename for the entire turn.
        if let Some(hsid) = &hsid_copy {
            let ctx = ExchangeContext {
                helmor_session_id: hsid.clone(),
                model_id: model_copy.id.to_string(),
                model_provider: model_copy.provider.to_string(),
                user_message_id: user_message_id_copy
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
            };

            match crate::models::db::write_conn() {
                Ok(conn) => {
                    if let Err(e) = conn.execute(
                        "UPDATE sessions SET fast_mode = ?1 WHERE id = ?2",
                        rusqlite::params![fast_mode, &ctx.helmor_session_id],
                    ) {
                        tracing::error!(rid = %rid, "Failed to update fast_mode: {e}");
                    }

                    match persist_user_message(&conn, &ctx, &prompt_copy, &files_copy, &images_copy)
                    {
                        Ok(()) => {
                            tracing::debug!(rid = %rid, "User message persisted to DB");
                            exchange_ctx = Some(ctx);
                        }
                        Err(error) => {
                            tracing::error!(rid = %rid, "Failed to persist user message: {error}");
                        }
                    }
                }
                Err(e) => {
                    tracing::error!(rid = %rid, "Failed to borrow write conn for initial persist: {e}");
                }
            }
        }

        tracing::debug!(rid = %rid, "Waiting for sidecar events...");

        // State machine session — iteration 4 onwards. Each migrated
        // event arm dispatches through `turn_session.handle_*`; the
        // remaining arms still drive the legacy flow. ctx fields here
        // are a snapshot at session-start; events that mutate them
        // (e.g., `permissionModeChanged`) mirror the change back into
        // the legacy local vars until those readers migrate too.
        let apply_ctx = actions::ApplyContext {
            on_event: &on_event,
            app: &app,
        };
        let mut turn_session = state::TurnSession::new(state::TurnContext {
            provider: provider.clone(),
            model_id: model_id.clone(),
            working_directory: working_dir_str.clone(),
            effort_level: effort_copy.clone(),
            permission_mode: permission_mode_initial.clone(),
            fast_mode,
            helmor_session_id: hsid_copy.clone(),
            resolved_session_id: resolved_session_id.clone(),
            resolved_model: model_copy.cli_model.to_string(),
            persisted_turn_count: 0,
            persisted_exit_plan_review: None,
        });

        loop {
            let event = match rx.recv_timeout(HEARTBEAT_TIMEOUT) {
                Ok(ev) => ev,
                Err(err @ (RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected)) => {
                    let kind = match err {
                        RecvTimeoutError::Timeout => state::AbnormalExit::HeartbeatTimeout,
                        RecvTimeoutError::Disconnected => state::AbnormalExit::SidecarDisconnected,
                    };
                    let (reason_log, user_message, should_stop_sidecar) = match kind {
                        state::AbnormalExit::HeartbeatTimeout => (
                            format!(
                                "heartbeat lost for {:?} — treating stream as dead",
                                HEARTBEAT_TIMEOUT
                            ),
                            format!(
                                "Sidecar stopped responding (no heartbeat for {:?}). You can retry the request.",
                                HEARTBEAT_TIMEOUT,
                            ),
                            true,
                        ),
                        state::AbnormalExit::SidecarDisconnected => (
                            "sidecar channel disconnected".to_string(),
                            "Sidecar connection was lost. You can retry the request.".to_string(),
                            // Channel already closed — stopSession would most
                            // likely fail, and if the sidecar already died
                            // the request isn't running anyway.
                            false,
                        ),
                    };
                    tracing::error!(rid = %rid, "{reason_log}");

                    if should_stop_sidecar {
                        let stop_req = crate::sidecar::SidecarRequest {
                            id: Uuid::new_v4().to_string(),
                            method: "stopSession".to_string(),
                            params: serde_json::json!({
                                "sessionId": sidecar_session_id_copy,
                                "provider": provider,
                            }),
                        };
                        if let Err(e) = sidecar_state.send(&stop_req) {
                            tracing::warn!(rid = %rid, "stopSession during abnormal exit failed: {e}");
                        }
                    }

                    let resolved_model = pipeline
                        .as_ref()
                        .map(|p| p.accumulator.resolved_model().to_string())
                        .unwrap_or_else(|| model_copy.cli_model.to_string());
                    let persisted = cleanup_abnormal_stream_exit(
                        &rid,
                        exchange_ctx.as_ref(),
                        &resolved_model,
                        &user_message,
                        effort_copy.as_deref(),
                        turn_session.ctx.permission_mode.as_deref(),
                    );

                    tracing::info!(
                        rid = %rid,
                        event_count,
                        heartbeat_count,
                        elapsed_ms = stream_started_at.elapsed().as_millis(),
                        persisted,
                        has_exchange_ctx = exchange_ctx.is_some(),
                        "stream: abnormal exit — finalized"
                    );

                    match turn_session.handle_abnormal_exit(kind, user_message, persisted) {
                        Ok(actions) => {
                            for action in actions {
                                actions::apply_action(action, &apply_ctx);
                            }
                        }
                        Err(err) => {
                            tracing::error!(
                                rid = %rid,
                                error = ?err,
                                "abnormal exit transition rejected",
                            );
                        }
                    }
                    break;
                }
            };

            // Heartbeats are keepalives only — do not advance pipeline state.
            if event.event_type() == "heartbeat" {
                heartbeat_count += 1;
                tracing::trace!(rid = %rid, heartbeat_count, "heartbeat");
                continue;
            }

            // Older sidecars may forward Codex app-server retry notices as
            // `type:error` events while preserving the structured
            // `willRetry=true` bit. Treat only those explicit retry markers as
            // liveness pings; message-only errors are terminal and must not be
            // converted into a successful `end` if the sidecar's finally block
            // emits one immediately after.
            if model_copy.provider == "codex"
                && event.event_type() == "error"
                && bridges::is_retryable_sidecar_error(&event.raw)
            {
                heartbeat_count += 1;
                let message = event
                    .raw
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("retryable sidecar error");
                tracing::debug!(rid = %rid, heartbeat_count, "Forwarding retryable sidecar error as notice: {message}");

                if let Some(pipeline_state) = pipeline.as_mut() {
                    let notice = bridges::retry_notice_event_from_error(&event.raw);
                    let line = serde_json::to_string(&notice).unwrap_or_default();
                    let emit = pipeline_state.push_event(&notice, &line);
                    match turn_session.handle_stream_event(emit) {
                        Ok(actions) => {
                            for action in actions {
                                actions::apply_action(action, &apply_ctx);
                            }
                        }
                        Err(err) => {
                            tracing::error!(
                                rid = %rid,
                                error = ?err,
                                "retry_notice transition rejected",
                            );
                        }
                    }
                }
                continue;
            }

            event_count += 1;

            // Claude's authoritative session_id comes only from `system.init`.
            // Earlier events — notably SessionStart:resume hook notifications —
            // carry a transient session_id that does NOT map to any real
            // conversation jsonl. Adopting them poisons the next resume with
            // "No conversation found". Codex flattens every notification with
            // its real thread_id, so any event is safe.
            let is_provider_session_marker = match model_copy.provider.as_str() {
                "claude" => event.is_claude_session_init(),
                _ => true,
            };
            if is_provider_session_marker {
                if let Some(sid) = event.session_id() {
                    if should_adopt_provider_session_id(
                        resolved_session_id.as_deref(),
                        sid,
                        hsid_copy.as_deref(),
                    ) {
                        resolved_session_id = Some(sid.to_string());
                        if let (Some(ctx), Some(conn)) =
                            (&exchange_ctx, &crate::models::db::write_conn().ok())
                        {
                            if let Err(error) = conn.execute(
                                "UPDATE sessions SET provider_session_id = ?2, agent_type = ?3 WHERE id = ?1",
                                params![ctx.helmor_session_id, sid, ctx.model_provider],
                            ) {
                                tracing::error!(rid = %rid, "Failed to persist session id: {error}");
                            } else {
                                tracing::debug!(rid = %rid, provider_session_id = sid, "Session ID persisted");
                            }
                        }
                    }
                }
            }

            match event.event_type() {
                "end" | "aborted" => {
                    // Infrastructure-side prep stays inline because it
                    // needs owned access to the pipeline and the
                    // single-writer DB pool. The state machine handles
                    // the terminal transition + the Update + Done|Aborted
                    // emit pair (and appends the persisted exit-plan
                    // review row when one was captured earlier).
                    let is_aborted = event.event_type() == "aborted";
                    let reason = if is_aborted {
                        Some(
                            event
                                .raw
                                .get("reason")
                                .and_then(Value::as_str)
                                .unwrap_or("user_requested")
                                .to_string(),
                        )
                    } else {
                        None
                    };
                    let status = if is_aborted { "aborted" } else { "idle" };

                    // Tracks whether the FINAL finalize (persist_result_and_finalize
                    // for end, finalize_session_metadata for aborted) succeeded.
                    // Turn-message failures don't flip this back to false — the
                    // frontend uses `persisted` as "end state is durable in DB".
                    let mut persisted = false;
                    let mut resolved_model = model_copy.cli_model.to_string();
                    let mut final_messages: Vec<ThreadMessageLike> = Vec::new();
                    // Set on an empty `end` for a `resume:` stream — surface
                    // an Error instead of silently committing a blank Done
                    // (issue #398). We do NOT clear provider_session_id
                    // here: a single empty response can be a transient API
                    // blip, and dropping the resume id would lose the whole
                    // conversation on retry (issue #402). The hard-evidence
                    // clear lives in `cleanup_abnormal_stream_exit`.
                    let mut bad_resume_failure = false;
                    const BAD_RESUME_USER_MESSAGE: &str =
                        "The provider returned an empty response. Please try again. \
                         If this keeps happening on this thread, start a new conversation.";

                    if let Some(mut pipeline_state) = pipeline.take() {
                        if is_aborted {
                            pipeline_state.accumulator.mark_pending_tools_aborted();
                        }

                        pipeline_state.accumulator.flush_pending();

                        if is_aborted {
                            pipeline_state.accumulator.flush_codex_in_progress();
                            pipeline_state.accumulator.flush_cursor_in_progress();
                            pipeline_state.materialize_partial();
                            pipeline_state.accumulator.append_aborted_notice();
                        }

                        // Borrow writer once for both turn persistence and the
                        // terminal finalize. drain_output between the two uses
                        // is purely in-memory, so holding the writer pool slot
                        // across it is cheap and halves the writer round-trips
                        // per terminal event.
                        let writer = exchange_ctx
                            .as_ref()
                            .and_then(|_| crate::models::db::write_conn().ok());

                        // Persist remaining turns and sync their UUIDs back
                        // into collected[] so streaming IDs = DB IDs.
                        if let (Some(ctx), Some(conn)) = (exchange_ctx.as_ref(), writer.as_ref()) {
                            let model_str = pipeline_state.accumulator.resolved_model().to_string();
                            while persisted_turn_count < pipeline_state.accumulator.turns_len() {
                                match persist_turn_message(
                                    conn,
                                    ctx,
                                    pipeline_state.accumulator.turn_at(persisted_turn_count),
                                    &model_str,
                                ) {
                                    Ok(_) => persisted_turn_count += 1,
                                    Err(error) => {
                                        tracing::error!(
                                            turn = persisted_turn_count,
                                            "Failed to persist turn: {error}"
                                        );
                                        break;
                                    }
                                }
                            }
                        }
                        let output = pipeline_state
                            .accumulator
                            .drain_output(resolved_session_id.as_deref());
                        if !output.assistant_text.is_empty() {
                            resolved_model = output.resolved_model.clone();
                        }

                        // Empty result on a `resume:` stream → surface as
                        // Error. Skipped on the no-resume case (a brand-new
                        // turn returning empty is a different kind of bug).
                        let is_empty_resume = !is_aborted
                            && resume_session_id.is_some()
                            && persisted_turn_count == 0
                            && output.assistant_text.trim().is_empty();

                        if let (Some(ctx), Some(conn)) = (exchange_ctx.as_ref(), writer.as_ref()) {
                            if is_empty_resume {
                                bad_resume_failure = true;
                                match persist_error_message(
                                    conn,
                                    ctx,
                                    &resolved_model,
                                    BAD_RESUME_USER_MESSAGE,
                                ) {
                                    Ok(_) => {}
                                    Err(error) => {
                                        tracing::error!(
                                            rid = %rid,
                                            "Failed to persist bad-resume error: {error}"
                                        );
                                    }
                                }
                                match finalize_session_metadata(
                                    conn,
                                    ctx,
                                    "idle",
                                    effort_copy.as_deref(),
                                    turn_session.ctx.permission_mode.as_deref(),
                                ) {
                                    Ok(_) => persisted = true,
                                    Err(error) => {
                                        tracing::error!(
                                            rid = %rid,
                                            "Failed to finalize after empty resume: {error}"
                                        );
                                    }
                                }
                            } else if is_aborted {
                                match finalize_session_metadata(
                                    conn,
                                    ctx,
                                    status,
                                    effort_copy.as_deref(),
                                    turn_session.ctx.permission_mode.as_deref(),
                                ) {
                                    Ok(_) => persisted = true,
                                    Err(error) => {
                                        tracing::error!(rid = %rid, "Failed to finalize exchange: {error}");
                                    }
                                }
                            } else {
                                let preassigned = pipeline_state.accumulator.take_result_id();
                                match persist_result_and_finalize(
                                    conn,
                                    ctx,
                                    &output.resolved_model,
                                    &output.assistant_text,
                                    effort_copy.as_deref(),
                                    turn_session.ctx.permission_mode.as_deref(),
                                    &output.usage,
                                    output.result_json.as_deref(),
                                    status,
                                    preassigned,
                                ) {
                                    Ok(_) => persisted = true,
                                    Err(error) => {
                                        tracing::error!(rid = %rid, "Failed to finalize exchange: {error}");
                                    }
                                }
                            }
                        } else if exchange_ctx.is_some() {
                            tracing::error!(
                                rid = %rid,
                                "Failed to borrow writer for finalize — reporting persisted=false"
                            );
                        }
                        drop(writer);

                        // Final render with DB-synced IDs so the frontend
                        // cache matches what the historical loader returns.
                        final_messages = pipeline_state.finish();
                    }

                    tracing::info!(
                        rid = %rid,
                        outcome = if is_aborted { "aborted" } else { "done" },
                        event_count,
                        heartbeat_count,
                        persisted_turn_count,
                        elapsed_ms = stream_started_at.elapsed().as_millis(),
                        persisted,
                        bad_resume_failure,
                        "stream: terminal event received"
                    );

                    if bad_resume_failure {
                        // End in `Error` (not `Done`) so the frontend's
                        // error path runs.
                        let raw = json!({
                            "type": "error",
                            "message": BAD_RESUME_USER_MESSAGE,
                            "internal": false,
                        });
                        match turn_session.handle_error(&raw, persisted) {
                            Ok(actions) => {
                                for action in actions {
                                    actions::apply_action(action, &apply_ctx);
                                }
                            }
                            Err(err) => {
                                tracing::error!(
                                    rid = %rid,
                                    error = ?err,
                                    "bad-resume error transition rejected",
                                );
                            }
                        }
                        break;
                    }

                    match turn_session.handle_end_or_aborted(
                        is_aborted,
                        reason,
                        &resolved_model,
                        final_messages,
                        persisted,
                    ) {
                        Ok(actions) => {
                            for action in actions {
                                actions::apply_action(action, &apply_ctx);
                            }
                        }
                        Err(err) => {
                            tracing::error!(
                                rid = %rid,
                                error = ?err,
                                outcome = if is_aborted { "aborted" } else { "done" },
                                "end/aborted transition rejected",
                            );
                        }
                    }
                    break;
                }
                "permissionRequest" => {
                    // Routed through `TurnSession::handle_permission_request`
                    // — the first event arm migrated to the state machine.
                    // Late events (after Terminated) are surfaced as a
                    // tracing error rather than silently dropped.
                    let raw = event.raw.clone();
                    if let AgentStreamEvent::PermissionRequest {
                        permission_id,
                        tool_name,
                        ..
                    } = bridge_permission_request_event(&raw)
                    {
                        tracing::debug!(
                            rid = %rid,
                            tool = %tool_name,
                            permission_id = %permission_id,
                            "Permission request",
                        );
                    }
                    match turn_session.handle_permission_request(&raw) {
                        Ok(actions) => {
                            for action in actions {
                                actions::apply_action(action, &apply_ctx);
                            }
                        }
                        Err(err) => {
                            tracing::error!(
                                rid = %rid,
                                error = ?err,
                                "permissionRequest transition rejected",
                            );
                        }
                    }
                }
                "planCaptured" => {
                    // Infrastructure-side prep (DB writes + pipeline flush)
                    // stays inline because it needs owned access to the
                    // single-writer DB pool and `&mut MessagePipeline`.
                    // Once prepared, `turn_session.handle_plan_captured`
                    // owns the state mutation (`persisted_exit_plan_review`)
                    // and the Update + PlanCaptured emit sequence.
                    let tool_use_id = event
                        .raw
                        .get("toolUseId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let plan_value = event.raw.get("plan").cloned().unwrap_or(Value::Null);
                    let tool_input = json!({ "plan": plan_value });
                    tracing::debug!(rid = %rid, tool_use_id = %tool_use_id, "Plan captured");

                    if let Some(pipeline_state) = pipeline.as_mut() {
                        pipeline_state.accumulator.flush_pending();

                        // Single writer borrow covers turn persistence and
                        // the exit-plan message write below; only an
                        // in-memory `resolved_model` read sits between them.
                        let writer = exchange_ctx
                            .as_ref()
                            .and_then(|_| crate::models::db::write_conn().ok());

                        if let (Some(ctx), Some(conn)) = (exchange_ctx.as_ref(), writer.as_ref()) {
                            let model_str = pipeline_state.accumulator.resolved_model().to_string();
                            while persisted_turn_count < pipeline_state.accumulator.turns_len() {
                                match persist_turn_message(
                                    conn,
                                    ctx,
                                    pipeline_state.accumulator.turn_at(persisted_turn_count),
                                    &model_str,
                                ) {
                                    Ok(_) => persisted_turn_count += 1,
                                    Err(error) => {
                                        tracing::error!(
                                            turn = persisted_turn_count,
                                            "Failed to persist turn: {error}"
                                        );
                                        break;
                                    }
                                }
                            }
                        }

                        let resolved_model =
                            pipeline_state.accumulator.resolved_model().to_string();
                        let persisted_metadata = if let (Some(ctx), Some(conn)) =
                            (exchange_ctx.as_ref(), writer.as_ref())
                        {
                            persist_exit_plan_message(
                                conn,
                                ctx,
                                &resolved_model,
                                &tool_use_id,
                                "ExitPlanMode",
                                &tool_input,
                            )
                            .ok()
                        } else {
                            None
                        };
                        drop(writer);
                        let (msg_id, created_at) = persisted_metadata.unwrap_or_default();
                        let plan_message = build_exit_plan_review_message(
                            (!msg_id.is_empty()).then_some(msg_id),
                            (!created_at.is_empty()).then_some(created_at),
                            &tool_use_id,
                            "ExitPlanMode",
                            &tool_input,
                        );

                        let final_messages = pipeline_state.finish();

                        match turn_session.handle_plan_captured(plan_message, final_messages) {
                            Ok(actions) => {
                                for action in actions {
                                    actions::apply_action(action, &apply_ctx);
                                }
                            }
                            Err(err) => {
                                tracing::error!(
                                    rid = %rid,
                                    error = ?err,
                                    "planCaptured transition rejected",
                                );
                            }
                        }
                    } else {
                        // Pipeline was already taken (e.g., terminal
                        // event arrived first). The frontend still gets
                        // the bare PlanCaptured marker so its overlay
                        // doesn't get stuck waiting on it.
                        let _ = on_event.send(AgentStreamEvent::PlanCaptured {});
                    }
                }
                "userInputRequest" => {
                    // Unified user-input pause. Sources: Claude
                    // AskUserQuestion (canUseTool), Claude MCP elicitation
                    // (onElicitation), Codex `requestUserInput`. The
                    // sidecar has the live SDK callback parked on a
                    // promise; the SDK process keeps running and the
                    // pipeline keeps accumulating. We persist any
                    // complete turns up to this point (crash-safe) and
                    // emit a snapshot Update + the UserInputRequest
                    // marker so the frontend overlay shows up at the
                    // right position. Subsequent stream events flow
                    // normally once the user submits via
                    // `respondToUserInput`.
                    let mut resolved_model = model_copy.cli_model.to_string();
                    let mut final_messages: Vec<ThreadMessageLike> = Vec::new();

                    if let Some(pipeline_state) = pipeline.as_mut() {
                        pipeline_state.accumulator.flush_pending();

                        if let (Some(ctx), Some(conn)) = (
                            exchange_ctx.as_ref(),
                            crate::models::db::write_conn().ok().as_ref(),
                        ) {
                            let model_str = pipeline_state.accumulator.resolved_model().to_string();
                            while persisted_turn_count < pipeline_state.accumulator.turns_len() {
                                match persist_turn_message(
                                    conn,
                                    ctx,
                                    pipeline_state.accumulator.turn_at(persisted_turn_count),
                                    &model_str,
                                ) {
                                    Ok(_) => persisted_turn_count += 1,
                                    Err(error) => {
                                        tracing::error!(
                                            turn = persisted_turn_count,
                                            "Failed to persist turn: {error}"
                                        );
                                        break;
                                    }
                                }
                            }
                        }

                        resolved_model = pipeline_state.accumulator.resolved_model().to_string();
                        // `finish()` is non-destructive (a pure render),
                        // so we keep the pipeline live for the events
                        // that arrive after the user submits.
                        final_messages = pipeline_state.finish();
                    }

                    match turn_session.handle_user_input_request(
                        &event.raw,
                        &resolved_model,
                        final_messages,
                    ) {
                        Ok(actions) => {
                            for action in actions {
                                actions::apply_action(action, &apply_ctx);
                            }
                        }
                        Err(err) => {
                            tracing::error!(
                                rid = %rid,
                                error = ?err,
                                "userInputRequest transition rejected",
                            );
                        }
                    }
                }
                "permissionModeChanged" => {
                    match turn_session.handle_permission_mode_changed(&event.raw) {
                        Ok(actions) => {
                            for action in actions {
                                actions::apply_action(action, &apply_ctx);
                            }
                        }
                        Err(err) => {
                            tracing::error!(
                                rid = %rid,
                                error = ?err,
                                "permissionModeChanged transition rejected",
                            );
                        }
                    }
                }
                "contextUsageUpdated" => {
                    match turn_session.handle_context_usage_updated(&event.raw) {
                        Ok(actions) => {
                            for action in actions {
                                actions::apply_action(action, &apply_ctx);
                            }
                        }
                        Err(err) => {
                            tracing::error!(
                                rid = %rid,
                                error = ?err,
                                "contextUsageUpdated transition rejected",
                            );
                        }
                    }
                }
                "codexGoalUpdated" => match turn_session.handle_codex_goal_updated(&event.raw) {
                    Ok(actions) => {
                        for action in actions {
                            actions::apply_action(action, &apply_ctx);
                        }
                    }
                    Err(err) => {
                        tracing::error!(
                            rid = %rid,
                            error = ?err,
                            "codexGoalUpdated transition rejected",
                        );
                    }
                },
                "error" => {
                    // Pre-compute (message, internal) for tracing and DB
                    // writes. Final emit goes through the state machine
                    // so the Terminated transition is recorded; a stray
                    // event after this point is now rejected loudly.
                    let preview = bridge_error_event(&event.raw, false);
                    let (message, internal) = match &preview {
                        AgentStreamEvent::Error {
                            message, internal, ..
                        } => (message.clone(), *internal),
                        _ => unreachable!("bridge_error_event returns Error variant"),
                    };
                    tracing::debug!(rid = %rid, internal, "Sidecar error: {message}");
                    let mut persisted = false;

                    if let (Some(ctx), Some(conn)) =
                        (&exchange_ctx, &crate::models::db::write_conn().ok())
                    {
                        let resolved_model = pipeline
                            .as_ref()
                            .map(|pipeline_state| {
                                pipeline_state.accumulator.resolved_model().to_string()
                            })
                            .unwrap_or_else(|| model_copy.cli_model.to_string());

                        match persist_error_message(conn, ctx, &resolved_model, &message) {
                            Ok(_) => persisted = true,
                            Err(error) => {
                                tracing::error!(rid = %rid, "Failed to persist error message: {error}");
                            }
                        }

                        if let Err(error) = finalize_session_metadata(
                            conn,
                            ctx,
                            "idle",
                            effort_copy.as_deref(),
                            turn_session.ctx.permission_mode.as_deref(),
                        ) {
                            tracing::error!(rid = %rid, "Failed to finalize error exchange: {error}");
                        }
                    }

                    tracing::info!(
                        rid = %rid,
                        event_count,
                        heartbeat_count,
                        elapsed_ms = stream_started_at.elapsed().as_millis(),
                        persisted,
                        internal,
                        "stream: error event — finalized"
                    );

                    match turn_session.handle_error(&event.raw, persisted) {
                        Ok(actions) => {
                            for action in actions {
                                actions::apply_action(action, &apply_ctx);
                            }
                        }
                        Err(err) => {
                            tracing::error!(
                                rid = %rid,
                                error = ?err,
                                "error transition rejected",
                            );
                        }
                    }
                    break;
                }
                _ => {
                    // Default arm — covers `stream_event`, `assistant`,
                    // `result`, `system`, etc. The pipeline accumulator
                    // owns the dispatch by event type; the state machine
                    // takes its `PipelineEmit` and decides what to send.
                    let line = serde_json::to_string(&event.raw).unwrap_or_default();
                    if !line.is_empty() && line != "{}" {
                        if let Some(pipeline_state) = pipeline.as_mut() {
                            let emit = pipeline_state.push_event(&event.raw, &line);

                            if let (Some(ctx), Some(conn)) =
                                (&exchange_ctx, &crate::models::db::write_conn().ok())
                            {
                                let model_str =
                                    pipeline_state.accumulator.resolved_model().to_string();
                                while persisted_turn_count < pipeline_state.accumulator.turns_len()
                                {
                                    match persist_turn_message(
                                        conn,
                                        ctx,
                                        pipeline_state.accumulator.turn_at(persisted_turn_count),
                                        &model_str,
                                    ) {
                                        Ok(_) => {
                                            persisted_turn_count += 1;
                                        }
                                        Err(error) => {
                                            tracing::error!(
                                                turn = persisted_turn_count,
                                                "Failed to persist turn: {error}"
                                            );
                                            break;
                                        }
                                    }
                                }
                            }

                            match turn_session.handle_stream_event(emit) {
                                Ok(actions) => {
                                    for action in actions {
                                        actions::apply_action(action, &apply_ctx);
                                    }
                                }
                                Err(err) => {
                                    tracing::error!(
                                        rid = %rid,
                                        error = ?err,
                                        "stream_event transition rejected",
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        tracing::info!(
            rid = %rid,
            event_count,
            heartbeat_count,
            persisted_turn_count,
            elapsed_ms = stream_started_at.elapsed().as_millis(),
            "stream: event loop exited, cleaning up subscription"
        );
        sidecar_state.unsubscribe(&rid);
        active_streams_state.unregister(&rid);
        crate::ui_sync::publish(&app, crate::ui_sync::UiMutationEvent::ActiveStreamsChanged);
    });

    Ok(())
}

fn build_exit_plan_review_message(
    id: Option<String>,
    created_at: Option<String>,
    tool_use_id: &str,
    tool_name: &str,
    tool_input: &Value,
) -> ThreadMessageLike {
    let plan = tool_input
        .get("plan")
        .and_then(Value::as_str)
        .map(str::to_string);
    let plan_file_path = tool_input
        .get("planFilePath")
        .and_then(Value::as_str)
        .map(str::to_string);
    let allowed_prompts = tool_input
        .get("allowedPrompts")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let tool = entry.get("tool").and_then(Value::as_str)?;
                    let prompt = entry.get("prompt").and_then(Value::as_str)?;
                    Some(PlanAllowedPrompt {
                        tool: tool.to_string(),
                        prompt: prompt.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    ThreadMessageLike {
        role: MessageRole::Assistant,
        id,
        created_at,
        content: vec![ExtendedMessagePart::Basic(MessagePart::PlanReview {
            tool_use_id: tool_use_id.to_string(),
            tool_name: tool_name.to_string(),
            plan,
            plan_file_path,
            allowed_prompts,
        })],
        status: None,
        streaming: None,
    }
}
