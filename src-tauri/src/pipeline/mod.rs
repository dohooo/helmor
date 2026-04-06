//! Message transformation pipeline.
//!
//! Converts raw sidecar JSON events into rendered messages for the frontend.
//!
//! # Incremental IPC strategy
//!
//! - **Finalization events** (assistant, user, result, error): run the full
//!   pipeline (adapt + collapse) and emit `Full(Vec<ThreadMessageLike>)`.
//! - **Streaming deltas** (stream_event, tool_progress): only build the
//!   trailing partial message and emit `Partial(ThreadMessageLike)`.
//!   The frontend appends/replaces this at the end of its cached array.
//!
//! This keeps per-delta IPC payload small (~hundreds of bytes, one message)
//! instead of serializing the entire conversation on every keystroke.

pub mod accumulator;
pub mod adapter;
pub mod classify;
pub mod collapse;
pub mod types;

use serde_json::Value;

use types::{HistoricalRecord, IntermediateMessage, ThreadMessageLike};

// ---------------------------------------------------------------------------
// Pipeline output
// ---------------------------------------------------------------------------

/// What the pipeline wants to emit after processing an event.
pub enum PipelineEmit {
    /// Full snapshot — sent on finalization events (assistant, user, result, error).
    /// The frontend replaces its entire message array.
    Full(Vec<ThreadMessageLike>),
    /// Only the streaming partial changed — sent on stream deltas.
    /// The frontend replaces only the trailing streaming message.
    Partial(ThreadMessageLike),
    /// Nothing changed (e.g. event didn't affect visible output).
    None,
}

// ---------------------------------------------------------------------------
// MessagePipeline
// ---------------------------------------------------------------------------

pub struct MessagePipeline {
    pub accumulator: accumulator::StreamAccumulator,
    context_key: String,
    session_id: String,
    /// Monotonic counter — incremented on every accumulator mutation.
    generation: u64,
    /// Generation at last full emission.
    last_full_generation: u64,
    /// Generation at last partial emission.
    last_partial_generation: u64,
    /// Cached full render from the last finalization event.
    /// Re-used as the base for the next finalization.
    cached_full: Vec<ThreadMessageLike>,
}

impl MessagePipeline {
    pub fn new(provider: &str, fallback_model: &str, context_key: &str, session_id: &str) -> Self {
        Self {
            accumulator: accumulator::StreamAccumulator::new(provider, fallback_model),
            context_key: context_key.to_string(),
            session_id: session_id.to_string(),
            generation: 0,
            last_full_generation: 0,
            last_partial_generation: 0,
            cached_full: Vec::new(),
        }
    }

    /// Feed a raw sidecar JSON event.
    pub fn push_event(&mut self, value: &Value, raw_line: &str) -> PipelineEmit {
        self.accumulator.push_event(value, raw_line);
        self.generation += 1;

        let event_type = value.get("type").and_then(Value::as_str);
        let is_finalizing = matches!(event_type, Some("assistant" | "user" | "result" | "error"));

        if is_finalizing {
            self.emit_full()
        } else {
            self.emit_partial()
        }
    }

    /// Finalize after stream end. Always returns the full snapshot.
    pub fn finish(&mut self) -> Vec<ThreadMessageLike> {
        match self.emit_full() {
            PipelineEmit::Full(messages) => messages,
            _ => self.cached_full.clone(),
        }
    }

    /// Convert historical DB records (static, no accumulator).
    pub fn convert_historical(records: &[HistoricalRecord]) -> Vec<ThreadMessageLike> {
        let intermediate: Vec<IntermediateMessage> = records
            .iter()
            .map(|r| IntermediateMessage {
                id: r.id.clone(),
                role: r.role.clone(),
                raw_json: r.content.clone(),
                parsed: if r.content_is_json {
                    r.parsed_content.clone()
                } else {
                    None
                },
                created_at: r.created_at.clone(),
                is_streaming: false,
            })
            .collect();
        render_pipeline(&intermediate)
    }

    // -----------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------

    /// Full render: run adapter + collapse on ALL messages (collected + partial).
    /// Sent on finalization events. Caches the result.
    fn emit_full(&mut self) -> PipelineEmit {
        if self.generation == self.last_full_generation {
            return PipelineEmit::None;
        }

        let partial = self
            .accumulator
            .build_partial(&self.context_key, &self.session_id);
        let collected = self.accumulator.collected();

        let messages = match partial {
            Some(p) => {
                let mut all = Vec::with_capacity(collected.len() + 1);
                all.extend_from_slice(collected);
                all.push(p);
                render_pipeline(&all)
            }
            None => render_pipeline(collected),
        };

        self.cached_full = messages.clone();
        self.last_full_generation = self.generation;
        self.last_partial_generation = self.generation;

        PipelineEmit::Full(messages)
    }

    /// Partial render: only build the trailing streaming message.
    /// Sent on stream deltas. Much cheaper than a full render.
    fn emit_partial(&mut self) -> PipelineEmit {
        if self.generation == self.last_partial_generation {
            return PipelineEmit::None;
        }

        let partial = match self
            .accumulator
            .build_partial(&self.context_key, &self.session_id)
        {
            Some(p) => p,
            None => return PipelineEmit::None,
        };

        // Adapt only this single partial message — no collapse needed
        // during streaming (collapse runs on full renders).
        let rendered = adapter::convert(&[partial]);
        let mut msg = match rendered.into_iter().next() {
            Some(m) => m,
            None => return PipelineEmit::None,
        };
        msg.streaming = Some(true);

        self.last_partial_generation = self.generation;

        PipelineEmit::Partial(msg)
    }
}

/// Run the adapter + collapse stages on intermediate messages.
fn render_pipeline(intermediate: &[IntermediateMessage]) -> Vec<ThreadMessageLike> {
    let mut messages = adapter::convert(intermediate);
    collapse::collapse_pass(&mut messages);
    messages
}
