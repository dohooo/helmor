use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::params;
use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, Manager};
use uuid::Uuid;

use super::{
    finalize_session_metadata, open_write_connection, persist_result_and_finalize,
    persist_turn_message, persist_user_message, AgentModelDefinition, AgentSendRequest,
    AgentStreamEvent, CmdResult, ExchangeContext,
};

#[derive(Debug, Clone)]
struct ActiveStreamHandle {
    request_id: String,
    sidecar_session_id: String,
    provider: String,
}

#[derive(Default)]
pub struct ActiveStreams {
    inner: Arc<Mutex<HashMap<String, ActiveStreamHandle>>>,
}

impl ActiveStreams {
    pub fn new() -> Self {
        Self::default()
    }

    fn register(&self, handle: ActiveStreamHandle) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(handle.request_id.clone(), handle);
        }
    }

    fn unregister(&self, request_id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(request_id);
        }
    }

    fn snapshot(&self) -> Vec<ActiveStreamHandle> {
        self.inner
            .lock()
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default()
    }

    pub(crate) fn len(&self) -> usize {
        self.inner.lock().map(|map| map.len()).unwrap_or(0)
    }

    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

pub fn abort_all_active_streams_blocking(
    sidecar: &crate::sidecar::ManagedSidecar,
    active: &ActiveStreams,
    timeout: Duration,
) {
    let handles = active.snapshot();
    if handles.is_empty() {
        return;
    }

    tracing::info!(
        count = handles.len(),
        "Graceful shutdown — aborting active streams"
    );

    for handle in &handles {
        let stop_req = crate::sidecar::SidecarRequest {
            id: Uuid::new_v4().to_string(),
            method: "stopSession".to_string(),
            params: serde_json::json!({
                "sessionId": handle.sidecar_session_id,
                "provider": handle.provider,
            }),
        };
        if let Err(error) = sidecar.send(&stop_req) {
            tracing::error!(request_id = %handle.request_id, "Failed to send stopSession during shutdown: {error}");
        }
    }

    let start = Instant::now();
    let poll = Duration::from_millis(50);
    while !active.is_empty() && start.elapsed() < timeout {
        std::thread::sleep(poll);
    }

    let remaining = active.len();
    if remaining == 0 {
        tracing::info!("Graceful shutdown — all streams drained cleanly");
    } else {
        tracing::info!(
            remaining,
            "Graceful shutdown — timeout, streams still active"
        );
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn stream_via_sidecar(
    app: AppHandle,
    on_event: Channel<AgentStreamEvent>,
    sidecar: &crate::sidecar::ManagedSidecar,
    active_streams: &ActiveStreams,
    stream_id: &str,
    model: &AgentModelDefinition,
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

    let resume_session_id = request.session_id.clone().or_else(|| {
        request.helmor_session_id.as_deref().and_then(|hsid| {
            let conn = open_write_connection().ok()?;
            let (stored_sid, stored_provider): (Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT provider_session_id, agent_type FROM sessions WHERE id = ?1",
                    [hsid],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok()?;
            let sid = stored_sid?;
            if stored_provider.unwrap_or_default() == model.provider {
                Some(sid)
            } else {
                None
            }
        })
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

    let sidecar_req = crate::sidecar::SidecarRequest {
        id: request_id.clone(),
        method: "sendMessage".to_string(),
        params: serde_json::json!({
            "sessionId": sidecar_session_id,
            "prompt": prompt,
            "model": model.cli_model,
            "cwd": working_directory.display().to_string(),
            "resume": resume_session_id,
            "provider": model.provider,
            "effortLevel": request.effort_level,
            "permissionMode": request.permission_mode,
        }),
    };

    let rx = sidecar.subscribe(&request_id);

    if let Err(error) = sidecar.send(&sidecar_req) {
        sidecar.unsubscribe(&request_id);
        return Err(anyhow::anyhow!("Sidecar send failed: {error}").into());
    }

    active_streams.register(ActiveStreamHandle {
        request_id: request_id.clone(),
        sidecar_session_id: sidecar_session_id.clone(),
        provider: model.provider.to_string(),
    });

    let model_id = model.id.to_string();
    let provider = model.provider.to_string();
    let model_copy = *model;
    let prompt_copy = prompt.to_string();
    let working_dir_str = working_directory.display().to_string();
    let hsid_copy = helmor_session_id;
    let effort_copy = request.effort_level.clone();
    let permission_mode_copy = request.permission_mode.clone();
    let user_message_id_copy = request.user_message_id.clone();
    let files_copy = request.files.clone().unwrap_or_default();
    let resume_only = request.resume_only;
    let rid = request_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecar> = app.state();
        let active_streams_state: tauri::State<'_, ActiveStreams> = app.state();
        let mut resolved_session_id: Option<String> = None;
        let context_key = rid.clone();
        let pipeline_session_id = hsid_copy.clone().unwrap_or_else(|| context_key.clone());
        let mut pipeline = hsid_copy.as_ref().map(|_| {
            crate::pipeline::MessagePipeline::new(
                provider.as_str(),
                model_copy.cli_model,
                &context_key,
                &pipeline_session_id,
            )
        });
        let mut event_count: u64 = 0;

        let mut exchange_ctx: Option<ExchangeContext> = None;
        let mut persisted_turn_count: usize = 0;
        let db_conn = if hsid_copy.is_some() {
            open_write_connection().ok()
        } else {
            None
        };

        if let (Some(hsid), Some(conn)) = (&hsid_copy, &db_conn) {
            let ctx = ExchangeContext {
                helmor_session_id: hsid.clone(),
                turn_id: Uuid::new_v4().to_string(),
                model_id: model_copy.id.to_string(),
                model_provider: model_copy.provider.to_string(),
                assistant_sdk_message_id: format!("helmor-assistant-{}", Uuid::new_v4()),
                user_message_id: user_message_id_copy
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
            };

            if resume_only {
                exchange_ctx = Some(ctx);
            } else {
                match persist_user_message(conn, &ctx, &prompt_copy, &files_copy) {
                    Ok(()) => {
                        tracing::debug!(rid = %rid, "User message persisted to DB");
                        exchange_ctx = Some(ctx);
                    }
                    Err(error) => {
                        tracing::error!(rid = %rid, "Failed to persist user message: {error}");
                    }
                }
            }
        }

        tracing::debug!(rid = %rid, "Waiting for sidecar events...");

        for event in rx.iter() {
            event_count += 1;

            if let Some(sid) = event.session_id() {
                if resolved_session_id.is_none() {
                    resolved_session_id = Some(sid.to_string());
                    if resume_only {
                        tracing::debug!(
                            rid = %rid,
                            provider_session_id = sid,
                            "Skipping provider session persistence for resume-only stream"
                        );
                    } else if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
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

            match event.event_type() {
                "end" | "aborted" => {
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

                    let persisted = exchange_ctx.is_some();
                    let mut resolved_model = model_copy.cli_model.to_string();

                    if let Some(mut pipeline_state) = pipeline.take() {
                        if is_aborted {
                            pipeline_state.accumulator.mark_pending_tools_aborted();
                        }

                        pipeline_state.accumulator.flush_pending();

                        if is_aborted {
                            pipeline_state.materialize_partial();
                            pipeline_state.accumulator.append_aborted_notice();
                        }

                        // Persist remaining turns and sync their UUIDs back
                        // into collected[] so streaming IDs = DB IDs.
                        if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
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
                        pipeline_state.accumulator.sync_persisted_ids();

                        let output = pipeline_state
                            .accumulator
                            .drain_output(resolved_session_id.as_deref());
                        if !output.assistant_text.is_empty() {
                            resolved_model = output.resolved_model.clone();
                        }
                        if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
                            if is_aborted {
                                if let Err(error) = finalize_session_metadata(
                                    conn,
                                    ctx,
                                    status,
                                    effort_copy.as_deref(),
                                    permission_mode_copy.as_deref(),
                                ) {
                                    tracing::error!(rid = %rid, "Failed to finalize exchange: {error}");
                                }
                            } else {
                                match persist_result_and_finalize(
                                    conn,
                                    ctx,
                                    &output.resolved_model,
                                    &output.assistant_text,
                                    effort_copy.as_deref(),
                                    permission_mode_copy.as_deref(),
                                    &output.usage,
                                    output.result_json.as_deref(),
                                    status,
                                ) {
                                    Ok(result_id) => {
                                        pipeline_state.accumulator.sync_result_id(&result_id);
                                    }
                                    Err(error) => {
                                        tracing::error!(rid = %rid, "Failed to finalize exchange: {error}");
                                    }
                                }
                            }
                        }

                        // Final render with DB-synced IDs so the frontend
                        // cache matches what the historical loader returns.
                        let final_messages = pipeline_state.finish();
                        let _ = on_event.send(AgentStreamEvent::Update {
                            messages: final_messages,
                        });
                    }

                    let _ = if let Some(reason) = reason {
                        on_event.send(AgentStreamEvent::Aborted {
                            provider: provider.clone(),
                            model_id: model_id.clone(),
                            resolved_model,
                            session_id: resolved_session_id.clone(),
                            working_directory: working_dir_str.clone(),
                            persisted,
                            reason,
                        })
                    } else {
                        on_event.send(AgentStreamEvent::Done {
                            provider: provider.clone(),
                            model_id: model_id.clone(),
                            resolved_model,
                            session_id: resolved_session_id.clone(),
                            working_directory: working_dir_str.clone(),
                            persisted,
                        })
                    };
                    break;
                }
                "permissionRequest" => {
                    let permission_id = event
                        .raw
                        .get("permissionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let tool_name = event
                        .raw
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let tool_input = event
                        .raw
                        .get("toolInput")
                        .cloned()
                        .unwrap_or(Value::Object(Default::default()));
                    let title = event
                        .raw
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let description = event
                        .raw
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    tracing::debug!(rid = %rid, tool = %tool_name, permission_id = %permission_id, "Permission request");
                    let _ = on_event.send(AgentStreamEvent::PermissionRequest {
                        permission_id,
                        tool_name,
                        tool_input,
                        title,
                        description,
                    });
                }
                "deferredToolUse" => {
                    let tool_use_id = event
                        .raw
                        .get("toolUseId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let tool_name = event
                        .raw
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let tool_input = event
                        .raw
                        .get("toolInput")
                        .cloned()
                        .unwrap_or(Value::Object(Default::default()));
                    let mut resolved_model = model_copy.cli_model.to_string();

                    if let Some(mut pipeline_state) = pipeline.take() {
                        pipeline_state.accumulator.flush_pending();

                        if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
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

                        // Deferred pause is terminal for this stream from the
                        // frontend's perspective. Sync persisted turn UUIDs before
                        // the last Update so the cached thread keeps DB-stable ids
                        // across the follow-up resume path.
                        pipeline_state.accumulator.sync_persisted_ids();

                        resolved_model = pipeline_state.accumulator.resolved_model().to_string();
                        let final_messages = pipeline_state.finish();
                        let _ = on_event.send(AgentStreamEvent::Update {
                            messages: final_messages,
                        });

                        if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
                            if let Err(error) = finalize_session_metadata(
                                conn,
                                ctx,
                                "idle",
                                effort_copy.as_deref(),
                                permission_mode_copy.as_deref(),
                            ) {
                                tracing::error!(
                                    rid = %rid,
                                    "Failed to finalize deferred exchange: {error}"
                                );
                            }
                        }
                    }

                    let _ = on_event.send(AgentStreamEvent::DeferredToolUse {
                        provider: provider.clone(),
                        model_id: model_id.clone(),
                        resolved_model,
                        session_id: resolved_session_id.clone(),
                        working_directory: working_dir_str.clone(),
                        permission_mode: permission_mode_copy.clone(),
                        tool_use_id,
                        tool_name,
                        tool_input,
                    });
                    break;
                }
                "elicitationRequest" => {
                    let resolved_model = pipeline
                        .as_ref()
                        .map(|state| state.accumulator.resolved_model().to_string())
                        .unwrap_or_else(|| model_copy.cli_model.to_string());
                    let _ = on_event.send(AgentStreamEvent::ElicitationRequest {
                        provider: provider.clone(),
                        model_id: model_id.clone(),
                        resolved_model,
                        session_id: resolved_session_id.clone(),
                        working_directory: working_dir_str.clone(),
                        elicitation_id: event
                            .raw
                            .get("elicitationId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        server_name: event
                            .raw
                            .get("serverName")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        message: event
                            .raw
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        mode: event
                            .raw
                            .get("mode")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        url: event
                            .raw
                            .get("url")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        requested_schema: event.raw.get("requestedSchema").cloned(),
                    });
                }
                "error" => {
                    let message = event
                        .raw
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown sidecar error")
                        .to_string();
                    let internal = event
                        .raw
                        .get("internal")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    tracing::debug!(rid = %rid, internal, "Sidecar error: {message}");
                    let _ = on_event.send(AgentStreamEvent::Error {
                        message,
                        persisted: exchange_ctx.is_some(),
                        internal,
                    });
                    break;
                }
                _ => {
                    let line = serde_json::to_string(&event.raw).unwrap_or_default();
                    if !line.is_empty() && line != "{}" {
                        if let Some(pipeline_state) = pipeline.as_mut() {
                            let emit = pipeline_state.push_event(&event.raw, &line);

                            if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
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

                            match emit {
                                crate::pipeline::PipelineEmit::Full(messages) => {
                                    let _ = on_event.send(AgentStreamEvent::Update { messages });
                                }
                                crate::pipeline::PipelineEmit::Partial(message) => {
                                    let _ = on_event
                                        .send(AgentStreamEvent::StreamingPartial { message });
                                }
                                crate::pipeline::PipelineEmit::None => {}
                            }
                        }
                    }
                }
            }
        }

        tracing::debug!(rid = %rid, event_count, "Event loop exited");
        sidecar_state.unsubscribe(&rid);
        active_streams_state.unregister(&rid);
    });

    Ok(())
}
