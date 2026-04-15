use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::params;
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, Manager};
use uuid::Uuid;

use crate::pipeline::types::{
    ExtendedMessagePart, MessagePart, MessageRole, PlanAllowedPrompt, ThreadMessageLike,
};

use super::{
    finalize_session_metadata, open_write_connection, persist_exit_plan_message,
    persist_result_and_finalize, persist_turn_message, persist_user_message, AgentSendRequest,
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

pub fn bridge_elicitation_request_event(
    provider: &str,
    model_id: &str,
    resolved_model: &str,
    session_id: Option<String>,
    working_directory: &str,
    raw: &Value,
) -> AgentStreamEvent {
    AgentStreamEvent::ElicitationRequest {
        provider: provider.to_string(),
        model_id: model_id.to_string(),
        resolved_model: resolved_model.to_string(),
        session_id,
        working_directory: working_directory.to_string(),
        elicitation_id: raw
            .get("elicitationId")
            .and_then(Value::as_str)
            .map(str::to_string),
        server_name: raw
            .get("serverName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        message: raw
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        mode: raw.get("mode").and_then(Value::as_str).map(str::to_string),
        url: raw.get("url").and_then(Value::as_str).map(str::to_string),
        requested_schema: raw.get("requestedSchema").cloned(),
    }
}

/// Build a JSON Schema from Codex `requestUserInput` questions so the
/// frontend's ElicitationPanel can render them as form fields.
fn build_user_input_schema(questions: &Value) -> Value {
    let arr = match questions.as_array() {
        Some(a) => a,
        None => return Value::Null,
    };

    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();

    for (i, q) in arr.iter().enumerate() {
        let header = q.get("header").and_then(Value::as_str).unwrap_or("");
        let question_text = q
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or("Question");
        let is_other = q.get("isOther").and_then(Value::as_bool).unwrap_or(false);
        let options = q.get("options").and_then(Value::as_array);
        // Use question id as key so responses map back to Codex question ids
        let key = q
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("q{i}"));

        // header → title (tab label), question → description (subtitle)
        let title = if header.is_empty() {
            question_text
        } else {
            header
        };
        let description = if header.is_empty() { "" } else { question_text };

        let has_options = options.is_some_and(|o| !o.is_empty());

        let prop = if has_options {
            let opts = options.unwrap();
            let one_of: Vec<Value> = opts
                .iter()
                .map(|opt| {
                    let label = opt.get("label").and_then(Value::as_str).unwrap_or("");
                    let desc = opt.get("description").and_then(Value::as_str).unwrap_or("");
                    serde_json::json!({
                        "const": label,
                        "title": label,
                        "description": desc,
                    })
                })
                .collect();

            let mut p = serde_json::json!({
                "type": "string",
                "title": title,
                "description": description,
                "oneOf": one_of,
            });
            if is_other {
                p["x-allow-other"] = Value::Bool(true);
            }
            p
        } else if is_other {
            serde_json::json!({
                "type": "string",
                "title": title,
                "description": description,
            })
        } else {
            serde_json::json!({
                "type": "string",
                "title": title,
                "description": description,
                "oneOf": [
                    { "const": "yes", "title": "Yes" },
                    { "const": "no", "title": "No" },
                ],
            })
        };

        required.push(Value::String(key.clone()));
        properties.insert(key, prop);
    }

    serde_json::json!({
        "type": "object",
        "properties": properties,
        "required": required,
    })
}

/// Convert an ElicitationResponse content back to Codex answer format.
///
/// Codex expects: `{ "question_id": { "answers": ["value"] }, ... }`
/// Frontend sends: `{ "question_id": "value", ... }`
pub fn convert_elicitation_content_to_codex_answers(content: &Value) -> Value {
    let obj = match content.as_object() {
        Some(o) => o,
        None => return Value::Null,
    };
    let mut answers = serde_json::Map::new();
    for (key, value) in obj {
        let answer_str = value.as_str().unwrap_or("").to_string();
        answers.insert(key.clone(), serde_json::json!({ "answers": [answer_str] }));
    }
    Value::Object(answers)
}

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

    let model_id = model.id.clone();
    let provider = model.provider.clone();
    let model_copy = model.clone();
    let prompt_copy = prompt.to_string();
    let working_dir_str = working_directory.display().to_string();
    let hsid_copy = helmor_session_id;
    let effort_copy = request.effort_level.clone();
    let mut permission_mode_copy = request.permission_mode.clone();
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
                &model_copy.cli_model,
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
        let mut persisted_exit_plan_review: Option<ThreadMessageLike> = None;

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
                            pipeline_state.accumulator.flush_codex_in_progress();
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
                        let mut final_messages = pipeline_state.finish();
                        if let Some(plan_message) = persisted_exit_plan_review.clone() {
                            final_messages.push(plan_message);
                        }
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
                "planCaptured" => {
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

                        let resolved_model =
                            pipeline_state.accumulator.resolved_model().to_string();
                        let persisted_metadata =
                            if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
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
                        let (msg_id, created_at) = persisted_metadata.unwrap_or_default();
                        persisted_exit_plan_review = Some(build_exit_plan_review_message(
                            (!msg_id.is_empty()).then_some(msg_id),
                            (!created_at.is_empty()).then_some(created_at),
                            &tool_use_id,
                            "ExitPlanMode",
                            &tool_input,
                        ));

                        let mut final_messages = pipeline_state.finish();
                        if let Some(plan_message) = persisted_exit_plan_review.clone() {
                            final_messages.push(plan_message);
                        }
                        let _ = on_event.send(AgentStreamEvent::Update {
                            messages: final_messages,
                        });
                    }
                    let _ = on_event.send(AgentStreamEvent::PlanCaptured {});
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
                "permissionModeChanged" => {
                    permission_mode_copy = event
                        .raw
                        .get("permissionMode")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                "elicitationRequest" => {
                    let resolved_model = pipeline
                        .as_ref()
                        .map(|state| state.accumulator.resolved_model().to_string())
                        .unwrap_or_else(|| model_copy.cli_model.to_string());
                    let _ = on_event.send(bridge_elicitation_request_event(
                        &provider,
                        &model_id,
                        &resolved_model,
                        resolved_session_id.clone(),
                        &working_dir_str,
                        &event.raw,
                    ));
                }
                "userInputRequest" => {
                    let resolved_model = pipeline
                        .as_ref()
                        .map(|state| state.accumulator.resolved_model().to_string())
                        .unwrap_or_else(|| model_copy.cli_model.to_string());
                    let user_input_id = event
                        .raw
                        .get("userInputId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let questions = event
                        .raw
                        .get("questions")
                        .cloned()
                        .unwrap_or(Value::Array(Vec::new()));
                    let schema = build_user_input_schema(&questions);
                    let message = "Codex needs your input".to_string();

                    let _ = on_event.send(AgentStreamEvent::ElicitationRequest {
                        provider: provider.to_string(),
                        model_id: model_id.to_string(),
                        resolved_model,
                        session_id: resolved_session_id.clone(),
                        working_directory: working_dir_str.clone(),
                        elicitation_id: Some(user_input_id),
                        server_name: "Codex".to_string(),
                        message,
                        mode: Some("form".to_string()),
                        url: None,
                        requested_schema: Some(schema),
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
                                crate::pipeline::PipelineEmit::Full(mut messages) => {
                                    if let Some(ref plan_msg) = persisted_exit_plan_review {
                                        messages.push(plan_msg.clone());
                                    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use insta::assert_yaml_snapshot;

    #[test]
    fn build_elicitation_request_event_maps_raw_sidecar_payload() {
        let event = bridge_elicitation_request_event(
            "claude",
            "opus-1m",
            "claude-opus-4-20250514",
            Some("provider-session-1".to_string()),
            "/tmp/helmor",
            &serde_json::json!({
                "elicitationId": "elicitation-1",
                "serverName": "design-server",
                "message": "Need structured input",
                "mode": "form",
                "url": null,
                "requestedSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" }
                    },
                    "required": ["name"]
                }
            }),
        );

        assert_yaml_snapshot!(
            serde_json::to_value(&event).unwrap(),
            @r#"
elicitationId: elicitation-1
kind: elicitationRequest
message: Need structured input
mode: form
model_id: opus-1m
provider: claude
requestedSchema:
  properties:
    name:
      type: string
  required:
    - name
  type: object
resolved_model: claude-opus-4-20250514
serverName: design-server
session_id: provider-session-1
url: ~
working_directory: /tmp/helmor
            "#
        );
    }

    #[test]
    fn user_input_schema_yes_no_question() {
        let questions = serde_json::json!([
            { "question": "Approve this plan?" }
        ]);
        let schema = build_user_input_schema(&questions);
        // Verify structure without relying on key order
        assert_eq!(schema["type"], "object");
        let q0 = &schema["properties"]["q0"];
        assert_eq!(q0["type"], "string");
        assert_eq!(q0["title"], "Approve this plan?");
        let options = q0["oneOf"].as_array().unwrap();
        assert_eq!(options.len(), 2);
        assert_eq!(options[0]["const"], "yes");
        assert_eq!(options[1]["const"], "no");
        assert_eq!(schema["required"][0], "q0");
    }

    #[test]
    fn user_input_schema_free_text_question() {
        let questions = serde_json::json!([
            { "question": "What changes?", "isOther": true }
        ]);
        let schema = build_user_input_schema(&questions);
        assert_eq!(schema["type"], "object");
        let q0 = &schema["properties"]["q0"];
        assert_eq!(q0["type"], "string");
        assert_eq!(q0["title"], "What changes?");
        assert!(q0.get("oneOf").is_none());
    }

    #[test]
    fn user_input_schema_mixed_questions() {
        let questions = serde_json::json!([
            { "question": "Continue?" },
            { "question": "Describe approach", "isOther": true },
        ]);
        let schema = build_user_input_schema(&questions);
        let props = &schema["properties"];
        assert!(props["q0"].get("oneOf").is_some());
        assert!(props["q1"].get("oneOf").is_none());
        assert_eq!(schema["required"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn user_input_schema_empty_returns_empty_object() {
        let schema = build_user_input_schema(&serde_json::json!([]));
        // Empty questions → empty schema (properties exist but empty)
        assert_eq!(schema["type"], "object");
        assert!(schema["properties"].as_object().unwrap().is_empty());
    }

    #[test]
    fn user_input_schema_non_array_returns_null() {
        assert_eq!(
            build_user_input_schema(&serde_json::json!("not array")),
            Value::Null
        );
    }

    #[test]
    fn convert_answers_maps_to_codex_format() {
        let content = serde_json::json!({
            "project_shape": "新项目",
            "app_goal": "验证需求",
        });
        let answers = convert_elicitation_content_to_codex_answers(&content);
        let obj = answers.as_object().unwrap();
        assert_eq!(
            obj["project_shape"],
            serde_json::json!({ "answers": ["新项目"] }),
        );
        assert_eq!(
            obj["app_goal"],
            serde_json::json!({ "answers": ["验证需求"] }),
        );
    }

    #[test]
    fn convert_answers_wraps_each_value() {
        let content = serde_json::json!({
            "q0": "a",
            "q1": "b",
        });
        let answers = convert_elicitation_content_to_codex_answers(&content);
        let obj = answers.as_object().unwrap();
        assert_eq!(obj.len(), 2);
        assert_eq!(obj["q0"]["answers"][0], "a");
        assert_eq!(obj["q1"]["answers"][0], "b");
    }

    #[test]
    fn convert_answers_null_input() {
        assert_eq!(
            convert_elicitation_content_to_codex_answers(&Value::Null),
            Value::Null,
        );
    }

    #[test]
    fn user_input_schema_with_options() {
        let questions = serde_json::json!([{
            "id": "project_shape",
            "header": "项目形态",
            "question": "选择项目类型",
            "isOther": false,
            "options": [
                { "label": "新项目", "description": "从零开始" },
                { "label": "改造", "description": "基于现有代码" },
            ]
        }]);
        let schema = build_user_input_schema(&questions);
        // Key should be the question id
        let field = &schema["properties"]["project_shape"];
        assert_eq!(field["title"], "项目形态");
        assert_eq!(field["description"], "选择项目类型");
        let opts = field["oneOf"].as_array().unwrap();
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0]["const"], "新项目");
        assert_eq!(opts[0]["description"], "从零开始");
        assert!(field.get("x-allow-other").is_none());
    }

    #[test]
    fn user_input_schema_options_with_is_other() {
        let questions = serde_json::json!([{
            "header": "终端选择",
            "question": "首发终端？",
            "isOther": true,
            "options": [
                { "label": "H5", "description": "最快" },
            ]
        }]);
        let schema = build_user_input_schema(&questions);
        let q0 = &schema["properties"]["q0"];
        assert_eq!(q0["title"], "终端选择");
        assert_eq!(q0["x-allow-other"], true);
        assert_eq!(q0["oneOf"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn user_input_schema_header_fallback() {
        let questions = serde_json::json!([
            { "question": "Simple question?" }
        ]);
        let schema = build_user_input_schema(&questions);
        let q0 = &schema["properties"]["q0"];
        // No header → title falls back to question, description is empty
        assert_eq!(q0["title"], "Simple question?");
        assert_eq!(q0["description"], "");
    }
}
