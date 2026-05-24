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
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub mod events;
pub mod openai;
pub mod prompt;

pub use events::PlannerEvent;

/// Default model. Swap by editing this constant — the user's OpenAI key
/// in settings is what gets billed; no per-model configuration today.
pub const PLANNER_MODEL: &str = "gpt-5";

/// Minimum gap between consecutive `Say` events emitted to the
/// frontend. Belt-and-braces guard on top of the prompt cadence rules;
/// if the planner ignores its instructions, we still throttle here.
const MIN_SAY_INTERVAL: Duration = Duration::from_millis(2_500);

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
    // Make sure the registration is cleaned up no matter how we exit.
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

    let tools = vec![
        openai::ToolDecl {
            kind: "function",
            name: "say",
            description: "Emit one short interim spoken update for the user. Follow the cadence rules in the system prompt. Use sparingly.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Exactly what the voice model should speak. One short sentence. No markdown, no URLs, no IDs."
                    }
                },
                "required": ["text"]
            }),
        },
        openai::ToolDecl {
            kind: "function",
            name: "final",
            description: "Emit your final answer for this turn. The voice model voices this, then the turn ends. Call exactly once, as the last function call.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Final user-facing answer. One short sentence in the user's language."
                    }
                },
                "required": ["text"]
            }),
        },
    ];

    let mut rx = openai::stream_responses_turn(
        &api_key,
        PLANNER_MODEL,
        prompt::PLANNER_SYSTEM_PROMPT,
        &transcript,
        tools,
        cancel.clone(),
    )
    .await
    .context("open planner stream")?;

    // call_id → function name. Captured at `output_item.added` time so
    // we know whether a later arguments.done is a `say` or a `final`.
    let mut call_id_to_name: HashMap<String, String> = HashMap::new();
    let mut said_final = false;
    let mut last_say_at: Option<Instant> = None;
    let mut emitted_final_text: Option<String> = None;

    while let Some(event) = rx.recv().await {
        if cancel.is_cancelled() {
            tracing::info!(target: "planner::lifecycle", turn_id = %turn_id, "stream loop saw cancel — breaking");
            break;
        }
        match event {
            openai::StreamEvent::FunctionCallStarted { name, call_id } => {
                tracing::debug!(
                    target: "planner::stream",
                    turn_id = %turn_id,
                    call_id = %call_id,
                    name = %name,
                    "function call started"
                );
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
                let parsed: Value = serde_json::from_str(&arguments).unwrap_or(Value::Null);
                let text = parsed
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if text.is_empty() {
                    tracing::warn!(
                        target: "planner::stream",
                        turn_id = %turn_id,
                        name = %name,
                        "function args missing/empty `text` — skipping"
                    );
                    continue;
                }
                match name.as_str() {
                    "say" => {
                        if let Some(prev) = last_say_at {
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
                                    &channel,
                                    PlannerEvent::Status {
                                        turn_id: turn_id.clone(),
                                        note: format!(
                                            "throttled say after {}ms",
                                            elapsed.as_millis()
                                        ),
                                    },
                                );
                                continue;
                            }
                        }
                        last_say_at = Some(Instant::now());
                        emit(
                            &channel,
                            PlannerEvent::Say {
                                turn_id: turn_id.clone(),
                                text,
                            },
                        );
                    }
                    "final" => {
                        if said_final {
                            tracing::warn!(
                                target: "planner::stream",
                                turn_id = %turn_id,
                                "duplicate `final` call — keeping first, dropping rest"
                            );
                            continue;
                        }
                        said_final = true;
                        emitted_final_text = Some(text.clone());
                        emit(
                            &channel,
                            PlannerEvent::Final {
                                turn_id: turn_id.clone(),
                                text,
                            },
                        );
                    }
                    other => {
                        tracing::warn!(
                            target: "planner::stream",
                            turn_id = %turn_id,
                            name = %other,
                            "unknown function call name — Phase 1 only knows say/final"
                        );
                    }
                }
            }
            openai::StreamEvent::Completed { usage } => {
                tracing::info!(
                    target: "planner::lifecycle",
                    turn_id = %turn_id,
                    elapsed_ms = %started_at.elapsed().as_millis(),
                    said_final,
                    usage = %usage.map(|u| u.to_string()).unwrap_or_default(),
                    "planner stream completed"
                );
                break;
            }
            openai::StreamEvent::Failed { message } => {
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
                break;
            }
        }
    }

    // Safety net: if the model exited without calling `final`, fabricate
    // one so rt doesn't sit there waiting. Phase 1 prompt instructs this
    // strictly, but we don't trust the model 100%.
    if !said_final && !cancel.is_cancelled() {
        let fallback = if emitted_final_text.is_some() {
            // Shouldn't happen, but defensive.
            "Done.".to_string()
        } else {
            "Sorry — I couldn't finish the response.".to_string()
        };
        tracing::warn!(
            target: "planner::lifecycle",
            turn_id = %turn_id,
            "planner ended without `final` — emitting fallback"
        );
        emit(
            &channel,
            PlannerEvent::Final {
                turn_id: turn_id.clone(),
                text: fallback,
            },
        );
    }

    emit(
        &channel,
        PlannerEvent::Done {
            turn_id: turn_id.clone(),
        },
    );
    Ok(())
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
