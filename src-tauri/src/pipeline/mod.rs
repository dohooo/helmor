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
pub mod event_filter;
pub mod types;

use serde_json::Value;

use accumulator::PushOutcome;
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
}

impl MessagePipeline {
    pub fn new(provider: &str, fallback_model: &str, context_key: &str, session_id: &str) -> Self {
        Self {
            accumulator: accumulator::StreamAccumulator::new(provider, fallback_model),
            context_key: context_key.to_string(),
            session_id: session_id.to_string(),
        }
    }

    /// Feed a raw sidecar JSON event.
    ///
    /// The accumulator classifies its own state change via `PushOutcome`,
    /// which decides between a full re-render, a partial render, or a
    /// no-op. A new SDK event type only has ONE place to land — the
    /// dispatch in `StreamAccumulator::push_event`.
    pub fn push_event(&mut self, value: &Value, raw_line: &str) -> PipelineEmit {
        let outcome = self.accumulator.push_event(value, raw_line);

        match outcome {
            PushOutcome::Finalized => PipelineEmit::Full(self.render_full()),
            PushOutcome::StreamingDelta => self.emit_partial(),
            PushOutcome::NoOp => PipelineEmit::None,
        }
    }

    /// Force a fresh full render. Called once at end-of-stream.
    pub fn finish(&mut self) -> Vec<ThreadMessageLike> {
        self.render_full()
    }

    /// Finalize any active streaming partial into a collected assistant
    /// message. Used on abort paths where no terminal provider assistant
    /// event will arrive, but the last visible partial should still remain
    /// in the thread ahead of the terminal abort notice.
    pub fn materialize_partial(&mut self) {
        self.accumulator
            .materialize_partial(&self.context_key, &self.session_id);
    }

    /// Convert historical DB records (static, no accumulator).
    pub fn convert_historical(records: &[HistoricalRecord]) -> Vec<ThreadMessageLike> {
        let intermediate: Vec<IntermediateMessage> = records
            .iter()
            .map(|r| IntermediateMessage {
                id: r.id.clone(),
                role: r.role.clone(),
                raw_json: r.content.clone(),
                parsed: r.parsed_content.clone(),
                created_at: r.created_at.clone(),
                is_streaming: false,
            })
            .collect();
        render_pipeline(&intermediate)
    }

    // -----------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------

    fn render_full(&mut self) -> Vec<ThreadMessageLike> {
        let partial = self
            .accumulator
            .build_partial(&self.context_key, &self.session_id);
        let collected = self.accumulator.collected();

        match partial {
            Some(p) => {
                let mut all = Vec::with_capacity(collected.len() + 1);
                all.extend_from_slice(collected);
                all.push(p);
                render_pipeline(&all)
            }
            None => render_pipeline(collected),
        }
    }

    /// Partial render: only build the trailing streaming message.
    /// Sent on stream deltas. Much cheaper than a full render.
    fn emit_partial(&mut self) -> PipelineEmit {
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

        PipelineEmit::Partial(msg)
    }
}

/// Run the adapter + collapse stages on intermediate messages.
fn render_pipeline(intermediate: &[IntermediateMessage]) -> Vec<ThreadMessageLike> {
    let mut messages = adapter::convert(intermediate);
    collapse::collapse_pass(&mut messages);
    messages
}
