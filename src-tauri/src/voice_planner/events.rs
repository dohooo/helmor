//! Events emitted by the voice planner as it runs a turn.
//!
//! Each variant lands on the frontend through a `Channel<PlannerEvent>`
//! that `start_planner_turn` accepts. The frontend dispatcher turns each
//! `Say` / `Final` into an out-of-band `response.create` so rt voices it.
//! `Status` is for the diag stream only — never spoken.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlannerEvent {
    /// Planner has been accepted; the SSE stream is open. Frontend uses
    /// this to know the turn is live (and to flush any "still spinning
    /// up" UI state).
    Started { turn_id: String },
    /// Interim user-facing line. The dispatcher should voice this through
    /// rt's `response.create` with a strict-text instruction. Tone is the
    /// planner's hint to the dispatcher about whether this is filler
    /// ("hmm") or a real finding ("found three workspaces") — kept for
    /// later UX use, the dispatcher currently treats them identically.
    Say { turn_id: String, text: String },
    /// Planner's final answer for the turn. The dispatcher voices this
    /// exactly like a `Say` but then closes the queue and returns
    /// control to organic rt behavior.
    Final { turn_id: String, text: String },
    /// Hint about progress milestones — entered "reasoning", started
    /// calling a real tool, etc. Pure diag, never spoken.
    Status { turn_id: String, note: String },
    /// Planner crashed / API rejected / timeout. The dispatcher should
    /// either speak a short error ("something went wrong, try again")
    /// or stay silent depending on whether anything was said yet.
    Error { turn_id: String, message: String },
    /// Planner stream closed cleanly. Always the last event for a
    /// successful turn — even if `Final` already fired. Useful for the
    /// frontend to know the channel is going away.
    Done { turn_id: String },
}
