//! Voice planner: GPT-5-backed reasoning layer that talks to rt through
//! out-of-band `say()` events plus a single final answer per turn.
//!
//! ## Why this exists
//!
//! `gpt-realtime-2` is great at voice I/O but weak at multi-step
//! reasoning, and its small context window doesn't tolerate long tool
//! catalogs. Phase 0 PoC validated that we can drive rt to speak text
//! we hand it via `response.create`. This module is the production
//! producer of that text: GPT-5 plans the turn, calls `say()` for
//! interim updates, and calls `final()` exactly once with the answer.
//!
//! Phase 1 scope: planner has ONLY `say` + `final` tools — no real
//! Helmor tool execution yet. That comes in Phase 2.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::commands::voice_agent::ToolKind;

pub mod context;
pub mod events;
pub mod openai;
pub mod prompt;
pub mod tools;

pub use events::PlannerEvent;

/// Default model. Swap by editing this constant — the user's OpenAI key
/// in settings is what gets billed; no per-model configuration today.
///
/// `gpt-5.4-mini` paired with `reasoning.effort: "medium"` gives the
/// planner enough reasoning headroom to pick the right Helmor tool
/// from the now-21-strong catalog (Phase 2 added all the workspace /
/// session / MCP / end_session / capture_screen routes). Time-to-
/// first-byte is slower than `minimal` effort but still well under
/// the user's patience threshold, and the smarter routing makes up
/// for it on multi-tool work.
pub const PLANNER_MODEL: &str = "gpt-5.4-mini";

/// Minimum gap between consecutive `Say` events emitted to the
/// frontend. Belt-and-braces guard on top of the prompt cadence rules;
/// if the planner ignores its instructions, we still throttle here.
const MIN_SAY_INTERVAL: Duration = Duration::from_millis(2_500);

/// Soft upper bound on agent-loop iterations. Empirically `gpt-5.4-mini`
/// with `medium` reasoning likes to do 6–10 tool calls on multi-step
/// work, so we set this generously high. The real termination signal
/// is the user interrupting (cancel token) — once the user speaks
/// again the loop drops out cleanly. The cap is only a safety belt
/// against a runaway model that calls tools indefinitely without ever
/// emitting `final`; in practice we expect to reach `final` long
/// before hitting this.
const MAX_AGENT_ITERATIONS: usize = 64;

/// One active turn. Held in `ManagedPlanner` so `abort_planner_turn`
/// can find the right cancel token.
struct ActiveTurn {
    turn_id: String,
    cancel: CancellationToken,
    started_at: Instant,
}

/// App-state singleton. Tracks every in-flight planner turn so abort
/// commands can target them. We expect at most 1-2 turns at a time
/// (one normal, one being torn down), so a `HashMap<turn_id, ...>`
/// is plenty.
pub struct ManagedPlanner {
    inner: Mutex<HashMap<String, ActiveTurn>>,
}

impl ManagedPlanner {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, ActiveTurn>> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                tracing::warn!(
                    target: "planner::lifecycle",
                    "ManagedPlanner mutex poisoned — recovering"
                );
                poisoned.into_inner()
            }
        }
    }

    fn register(&self, turn: ActiveTurn) {
        self.lock().insert(turn.turn_id.clone(), turn);
    }

    fn unregister(&self, turn_id: &str) {
        self.lock().remove(turn_id);
    }

    /// Cancel a turn by id. Returns `true` if a turn was found and
    /// signalled, `false` if no such turn exists (already finished or
    /// never started). Callers can ignore the bool — the frontend's
    /// idempotent "speak the latest user input" handler doesn't care
    /// whether the cancel actually had work to do.
    pub fn abort(&self, turn_id: &str) -> bool {
        if let Some(turn) = self.lock().get(turn_id) {
            tracing::info!(
                target: "planner::lifecycle",
                turn_id = %turn_id,
                age_ms = %turn.started_at.elapsed().as_millis(),
                "aborting planner turn"
            );
            turn.cancel.cancel();
            true
        } else {
            false
        }
    }
}

impl Default for ManagedPlanner {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Public entry point — called from the `start_planner_turn` Tauri command
// ---------------------------------------------------------------------------

/// Run one planner turn, streaming events to the supplied `channel`
/// until the underlying GPT-5 response finishes or `abort` is called.
///
/// `turn_id` is supplied by the caller (the Tauri command) so it can
/// return it synchronously to the frontend before the streaming work
/// kicks off.
pub async fn run_turn(
    planner_tools: &dyn tools::PlannerTools,
    planner: &ManagedPlanner,
    api_key: String,
    turn_id: String,
    transcript: String,
    channel: Channel<PlannerEvent>,
) -> Result<()> {
    let cancel = CancellationToken::new();
    let started_at = Instant::now();
    planner.register(ActiveTurn {
        turn_id: turn_id.clone(),
        cancel: cancel.clone(),
        started_at,
    });
    let _guard = UnregisterOnDrop {
        planner,
        turn_id: turn_id.clone(),
    };

    tracing::info!(
        target: "planner::lifecycle",
        turn_id = %turn_id,
        transcript_chars = transcript.chars().count(),
        "starting planner turn"
    );

    emit(
        &channel,
        PlannerEvent::Started {
            turn_id: turn_id.clone(),
        },
    );

    // Compose the tool catalog: built-in `say` / `final` plus the
    // Helmor tool subset filtered by `tools::is_planner_tool`.
    let mut all_tools = tools::builtin_say_final_decls();
    all_tools.extend(tools::planner_helmor_tool_decls());
    let tools_count = all_tools.len();
    tracing::info!(
        target: "planner::lifecycle",
        turn_id = %turn_id,
        tools_count,
        "planner tool catalog assembled (say + final + helmor)"
    );

    let system_prompt = build_system_prompt(&turn_id);

    // ── Agent loop state ──────────────────────────────────────────────
    let mut said_final = false;
    let mut last_say_at: Option<Instant> = None;
    let mut previous_response_id: Option<String> = None;
    let mut pending_outputs: Vec<openai::ToolOutput> = Vec::new();
    let mut stream_failure: Option<String> = None;

    for iteration in 0..MAX_AGENT_ITERATIONS {
        if cancel.is_cancelled() {
            break;
        }
        let outputs_for_post = std::mem::take(&mut pending_outputs);
        tracing::info!(
            target: "planner::lifecycle",
            turn_id = %turn_id,
            iteration = iteration + 1,
            tool_outputs_returned = outputs_for_post.len(),
            has_previous_response = previous_response_id.is_some(),
            "agent loop iteration"
        );

        let mut rx = match openai::stream_responses_turn(
            &api_key,
            PLANNER_MODEL,
            &system_prompt,
            &transcript,
            all_tools.clone(),
            previous_response_id.as_deref(),
            outputs_for_post,
            cancel.clone(),
        )
        .await
        .context("open planner stream")
        {
            Ok(rx) => rx,
            Err(e) => {
                stream_failure = Some(format!("{e:#}"));
                break;
            }
        };

        // Per-iteration scratch: collect tool calls before executing them
        // after the stream completes. We could execute eagerly mid-stream
        // but draining first keeps the agent loop simple and lets the
        // model emit say/final + helmor calls in any order.
        let mut call_id_to_name: HashMap<String, String> = HashMap::new();
        let mut call_id_to_args: HashMap<String, String> = HashMap::new();
        let mut helmor_call_order: Vec<String> = Vec::new();
        let mut iter_response_id: Option<String> = None;
        let mut iter_failed: Option<String> = None;

        while let Some(event) = rx.recv().await {
            if cancel.is_cancelled() {
                break;
            }
            match event {
                openai::StreamEvent::ResponseCreated { id } => {
                    iter_response_id = Some(id);
                }
                openai::StreamEvent::FunctionCallStarted { name, call_id } => {
                    call_id_to_name.insert(call_id, name);
                }
                openai::StreamEvent::FunctionCallArgs { call_id, arguments } => {
                    let Some(name) = call_id_to_name.get(&call_id).cloned() else {
                        tracing::warn!(
                            target: "planner::stream",
                            turn_id = %turn_id,
                            call_id = %call_id,
                            "arguments arrived for unknown call_id — skipping"
                        );
                        continue;
                    };
                    match name.as_str() {
                        "say" => emit_say(&channel, &turn_id, &arguments, &mut last_say_at),
                        "final" => {
                            if !said_final {
                                emit_final(&channel, &turn_id, &arguments);
                                said_final = true;
                            }
                        }
                        "show_status" => {
                            // Voice-bar progress text. NOT voiced — the
                            // frontend dispatcher routes this to the bar
                            // label only. Returns instantly so we
                            // synthesize the function_call_output here
                            // and let the model continue.
                            let parsed: Value =
                                serde_json::from_str(&arguments).unwrap_or(Value::Null);
                            let note = parsed
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .trim()
                                .to_string();
                            if !note.is_empty() {
                                emit(
                                    &channel,
                                    PlannerEvent::Status {
                                        turn_id: turn_id.clone(),
                                        note,
                                    },
                                );
                            }
                            pending_outputs.push(openai::ToolOutput {
                                call_id,
                                output: r#"{"ok":true}"#.to_string(),
                            });
                        }
                        _ => {
                            // Helmor tool — defer execution until the
                            // stream finishes so we can batch tool_outputs
                            // into one continuation POST.
                            call_id_to_args.insert(call_id.clone(), arguments);
                            helmor_call_order.push(call_id);
                        }
                    }
                }
                openai::StreamEvent::Completed { usage } => {
                    tracing::info!(
                        target: "planner::lifecycle",
                        turn_id = %turn_id,
                        iteration = iteration + 1,
                        usage = %usage.map(|u| u.to_string()).unwrap_or_default(),
                        "stream iteration completed"
                    );
                    break;
                }
                openai::StreamEvent::Failed { message } => {
                    iter_failed = Some(message);
                    break;
                }
            }
        }

        if let Some(msg) = iter_failed {
            stream_failure = Some(msg);
            break;
        }
        previous_response_id = iter_response_id;

        if helmor_call_order.is_empty() && pending_outputs.is_empty() {
            // Model finished its response with only say/final and queued
            // no further work. If final landed we're done; otherwise the
            // fallback path takes over.
            break;
        }

        // Execute every queued Helmor tool call. Sequential for now —
        // simpler and avoids interleaving Invalidate events from parallel
        // tools touching the same query keys. If a tool errors we still
        // emit a function_call_output so the planner can react.
        for call_id in helmor_call_order {
            if cancel.is_cancelled() {
                break;
            }
            let name = call_id_to_name.get(&call_id).cloned().unwrap_or_default();
            let args_str = call_id_to_args
                .get(&call_id)
                .cloned()
                .unwrap_or_else(|| "{}".to_string());
            let args: Value = serde_json::from_str(&args_str).unwrap_or(Value::Null);

            let Some(kind) = ToolKind::from_name(&name) else {
                tracing::warn!(
                    target: "planner::tool",
                    turn_id = %turn_id,
                    name = %name,
                    "unknown Helmor tool name from model — feeding error back"
                );
                pending_outputs.push(openai::ToolOutput {
                    call_id,
                    output: format!("{{\"ok\":false,\"error\":\"unknown tool: {name}\"}}"),
                });
                continue;
            };
            if !tools::is_planner_tool(kind) {
                tracing::warn!(
                    target: "planner::tool",
                    turn_id = %turn_id,
                    name = %name,
                    "rt-only tool requested by planner — refusing"
                );
                pending_outputs.push(openai::ToolOutput {
                    call_id,
                    output: format!(
                        "{{\"ok\":false,\"error\":\"{name} is not available to the planner\"}}"
                    ),
                });
                continue;
            }

            let tool_started = Instant::now();
            emit(
                &channel,
                PlannerEvent::ToolCallStarted {
                    turn_id: turn_id.clone(),
                    call_id: call_id.clone(),
                    name: name.clone(),
                    args_preview: preview(&args_str, 200),
                },
            );
            tracing::info!(
                target: "planner::tool",
                turn_id = %turn_id,
                name = %name,
                call_id = %call_id,
                args = %preview(&args_str, 200),
                "executing Helmor tool"
            );

            let envelope = planner_tools.dispatch(kind, args).await;

            // Bubble side effects up before returning to the model.
            if !envelope.invalidates.is_empty() {
                let kinds: Vec<String> = envelope
                    .invalidates
                    .iter()
                    .filter_map(|k| serde_json::to_value(k).ok())
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect();
                if !kinds.is_empty() {
                    emit(
                        &channel,
                        PlannerEvent::Invalidate {
                            turn_id: turn_id.clone(),
                            kinds,
                        },
                    );
                }
            }
            if let Some(ws) = &envelope.navigate_to_workspace_id {
                emit(
                    &channel,
                    PlannerEvent::NavigateToWorkspace {
                        turn_id: turn_id.clone(),
                        workspace_id: ws.clone(),
                    },
                );
            }

            // Reception-coupled side effects: end_session and the
            // image side-channel of capture_screen need the frontend
            // dispatcher to act. We surface them as dedicated
            // PlannerEvent variants.
            if kind == ToolKind::EndSession && envelope.ok {
                emit(
                    &channel,
                    PlannerEvent::EndSession {
                        turn_id: turn_id.clone(),
                    },
                );
            }
            // Strip the image bytes from the model's tool_output. The
            // image rides the side-channel; sending hundreds of KB of
            // base64 back to gpt-5.4-mini blows token budget and the
            // model can't see it anyway.
            let mut envelope_for_model = envelope.clone();
            if kind == ToolKind::CaptureScreen {
                if let Some(image) = envelope_for_model.image.take() {
                    let width = image.width;
                    let height = image.height;
                    let caption = image.caption.clone();
                    emit(
                        &channel,
                        PlannerEvent::CaptureImage {
                            turn_id: turn_id.clone(),
                            width,
                            height,
                            data_url: image.data_url,
                            caption: image.caption,
                        },
                    );
                    envelope_for_model.data = serde_json::json!({
                        "width": width,
                        "height": height,
                        "caption": caption,
                        "image_forwarded_to_voice_channel": true,
                    });
                }
            }

            let output = serde_json::to_string(&serde_json::json!({
                "ok": envelope_for_model.ok,
                "data": envelope_for_model.data,
                "error": envelope_for_model.error,
            }))
            .unwrap_or_else(|_| "{}".to_string());

            let duration_ms = tool_started.elapsed().as_millis() as u64;
            let envelope_ok = envelope_for_model.ok;
            emit(
                &channel,
                PlannerEvent::ToolCallCompleted {
                    turn_id: turn_id.clone(),
                    call_id: call_id.clone(),
                    name: name.clone(),
                    ok: envelope_ok,
                    duration_ms,
                    result_preview: preview(&output, 200),
                },
            );
            tracing::info!(
                target: "planner::tool",
                turn_id = %turn_id,
                name = %name,
                call_id = %call_id,
                ok = envelope_ok,
                duration_ms,
                "Helmor tool completed"
            );

            pending_outputs.push(openai::ToolOutput { call_id, output });
        }
    }

    if let Some(message) = stream_failure {
        tracing::warn!(
            target: "planner::lifecycle",
            turn_id = %turn_id,
            error = %message,
            "planner stream failed"
        );
        emit(
            &channel,
            PlannerEvent::Error {
                turn_id: turn_id.clone(),
                message,
            },
        );
    } else if !said_final && !cancel.is_cancelled() {
        tracing::warn!(
            target: "planner::lifecycle",
            turn_id = %turn_id,
            "planner ended without `final` — emitting fallback"
        );
        emit(
            &channel,
            PlannerEvent::Final {
                turn_id: turn_id.clone(),
                text: "嗯,刚才走神了,你再说一遍?".to_string(),
            },
        );
    }

    tracing::info!(
        target: "planner::lifecycle",
        turn_id = %turn_id,
        elapsed_ms = %started_at.elapsed().as_millis(),
        said_final,
        "planner turn complete"
    );

    emit(
        &channel,
        PlannerEvent::Done {
            turn_id: turn_id.clone(),
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers — kept module-private to keep `run_turn` itself terse.
// ---------------------------------------------------------------------------

/// Compose the planner system prompt with the current Helmor context
/// block appended. Failures fall through to the bare prompt + warning.
fn build_system_prompt(turn_id: &str) -> String {
    match context::current_helmor_context() {
        Ok(Some(ctx)) => {
            let block = ctx.to_instruction_block();
            tracing::info!(
                target: "planner::lifecycle",
                turn_id = %turn_id,
                context_block = %block.replace('\n', " | "),
                "injecting Helmor context block into planner prompt"
            );
            format!("{}\n\n{}", prompt::PLANNER_SYSTEM_PROMPT, block)
        }
        Ok(None) => {
            tracing::info!(
                target: "planner::lifecycle",
                turn_id = %turn_id,
                "no Helmor context (no active workspace) — sending bare prompt"
            );
            prompt::PLANNER_SYSTEM_PROMPT.to_string()
        }
        Err(e) => {
            tracing::warn!(
                target: "planner::lifecycle",
                turn_id = %turn_id,
                error = %format!("{e:#}"),
                "failed to build Helmor context; sending bare prompt"
            );
            prompt::PLANNER_SYSTEM_PROMPT.to_string()
        }
    }
}

fn emit_say(
    channel: &Channel<PlannerEvent>,
    turn_id: &str,
    arguments: &str,
    last_say_at: &mut Option<Instant>,
) {
    let parsed: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
    let text = parsed
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return;
    }
    if let Some(prev) = *last_say_at {
        let elapsed = prev.elapsed();
        if elapsed < MIN_SAY_INTERVAL {
            tracing::info!(
                target: "planner::cadence",
                turn_id = %turn_id,
                elapsed_ms = %elapsed.as_millis(),
                min_ms = %MIN_SAY_INTERVAL.as_millis(),
                "throttling consecutive `say` — drop"
            );
            emit(
                channel,
                PlannerEvent::Status {
                    turn_id: turn_id.to_string(),
                    note: format!("throttled say after {}ms", elapsed.as_millis()),
                },
            );
            return;
        }
    }
    *last_say_at = Some(Instant::now());
    emit(
        channel,
        PlannerEvent::Say {
            turn_id: turn_id.to_string(),
            text,
        },
    );
}

fn emit_final(channel: &Channel<PlannerEvent>, turn_id: &str, arguments: &str) {
    let parsed: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
    let text = parsed
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return;
    }
    emit(
        channel,
        PlannerEvent::Final {
            turn_id: turn_id.to_string(),
            text,
        },
    );
}

fn preview(s: &str, max: usize) -> String {
    let mut iter = s.chars();
    let head: String = iter.by_ref().take(max).collect();
    if iter.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

// ---------------------------------------------------------------------------
// Event emission helpers
// ---------------------------------------------------------------------------

fn emit(channel: &Channel<PlannerEvent>, event: PlannerEvent) {
    if let Err(e) = channel.send(event) {
        tracing::warn!(
            target: "planner::stream",
            error = %e,
            "channel send failed — frontend dropped"
        );
    }
}

// ---------------------------------------------------------------------------
// Cleanup guard (avoid scopeguard crate dep — this is enough)
// ---------------------------------------------------------------------------

struct UnregisterOnDrop<'a> {
    planner: &'a ManagedPlanner,
    turn_id: String,
}

impl Drop for UnregisterOnDrop<'_> {
    fn drop(&mut self) {
        self.planner.unregister(&self.turn_id);
    }
}

// ---------------------------------------------------------------------------
// Tauri-command facing helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerTurnAccepted {
    pub turn_id: String,
}

/// Fresh turn id. Generated once by the Tauri command so it can return
/// the id synchronously and the streaming task can register itself
/// under the same id.
pub fn fabricate_turn_id() -> String {
    format!("turn-{}", Uuid::new_v4())
}

/// Resolve the configured OpenAI API key from the same settings slot
/// the realtime client uses. Reusing one key keeps the user's setup
/// experience to "type the key once".
pub fn load_planner_api_key() -> Result<String> {
    let value = crate::models::settings::load_setting_value("app.openai_realtime_api_key")?
        .unwrap_or_default()
        .trim()
        .to_string();
    if value.is_empty() {
        return Err(anyhow!(
            "OpenAI API key is not configured. Add it under Settings → Voice."
        ));
    }
    Ok(value)
}
