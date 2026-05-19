//! Explicit state machine for an agent turn.
//!
//! Replaces the implicit-state munge that used to live as a 1500-line
//! match arm in `streaming/mod.rs`. The types here are:
//!
//! - [`TurnState`] — three explicit phases (Initializing, Streaming,
//!   Terminated) with `is_terminated` checks at the top of every
//!   handler so a late event after a terminal transition is rejected
//!   loudly rather than silently dropped.
//! - [`TurnContext`] — the per-turn invariants that handlers read and
//!   mutate (provider, model id, working directory, permission mode,
//!   resolved session id, etc.).
//! - [`TerminalReason`] — what flavor of terminal we hit, including
//!   the abnormal exits (`HeartbeatTimeout`, `SidecarDisconnected`)
//!   that don't arrive as a sidecar event.
//! - [`TransitionError`] — the structured rejection type the state
//!   machine returns instead of silently no-op'ing on invalid input.
//! - [`Action`](super::actions::Action) — the side-effect descriptor
//!   each `handle_*` returns. Caller dispatches via
//!   [`super::actions::apply_action`].
//!
//! ## Module layout
//!
//! - [`types`] (private) — the data types defined here at the top
//!   of the module.
//! - [`handlers`] (private) — `impl TurnSession` with every
//!   per-event handler. Each one bails with
//!   `TransitionError::AlreadyTerminated` when the turn is past a
//!   terminal transition; pure dispatch otherwise.

// `TransitionError` variants `UnexpectedEventInState` / `MalformedEvent`
// (and the `TurnStateKind` discriminant they reference) are reserved for
// a future strict-validation pass — handlers today only emit
// `AlreadyTerminated`. Suppress dead-code warnings on the module rather
// than on each variant so the diff stays readable when those readers
// come online.
#![allow(dead_code)]

mod handlers;

#[cfg(test)]
mod tests;

use crate::pipeline::types::ThreadMessageLike;

/// Top-level state of a single agent turn.
///
/// The Codex/Claude variation lives inside `TurnContext` (resolved model,
/// session id) and the pipeline accumulator (block-level streaming state).
/// `TurnState` is provider-agnostic: it tracks just whether the turn is
/// in-flight, paused, or done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::agents::streaming) enum TurnState {
    /// Sidecar request has been sent; we have not yet seen the first
    /// event. `system.init` (Claude) or the first stream notification
    /// (Codex) advances us to `Streaming`.
    Initializing,

    /// Receiving events. Most of the turn lives here. `permissionRequest`,
    /// `elicitationRequest`, `userInputRequest`, `permissionModeChanged`,
    /// `planCaptured`, and the default stream-event arm all keep us in
    /// `Streaming`.
    Streaming,

    /// A terminal event was received and processed. The event loop must
    /// break out of its receive loop on this transition. `TerminalReason`
    /// records why so the surface emit at the call site (Done / Aborted /
    /// Error) can be derived without re-inspecting the raw event.
    Terminated(TerminalReason),
}

/// Why the turn ended. Mirrors the AgentStreamEvent terminal variants
/// the frontend understands, plus two abnormal-exit reasons that don't
/// arrive as a sidecar event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::agents::streaming) enum TerminalReason {
    /// Sidecar emitted `end` — normal completion.
    Done,
    /// Sidecar emitted `aborted` — user pressed stop or app shutdown.
    Aborted { reason: String },
    /// Sidecar emitted `error`.
    Error {
        message: String,
        internal: bool,
        persisted: bool,
    },
    /// Heartbeat timeout fired (no sidecar event for 45s). Synthesized
    /// from the receiver loop, not from the sidecar.
    HeartbeatTimeout,
    /// Sidecar mpsc channel disconnected. Sidecar process likely died.
    /// Synthesized from the receiver loop.
    SidecarDisconnected,
}

/// Why the receiver loop synthesized an abnormal exit. Distinct from
/// `TerminalReason` because the call site needs to know which message
/// to log + whether to send `stopSession` to the sidecar BEFORE the
/// state-machine transition runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::agents::streaming) enum AbnormalExit {
    /// `HEARTBEAT_TIMEOUT` elapsed without a sidecar event. Sidecar may
    /// still be alive but stuck; the call site sends stopSession before
    /// transitioning so a wedged turn doesn't keep eating tokens.
    HeartbeatTimeout,
    /// The sidecar mpsc channel disconnected. The sidecar process is
    /// almost certainly dead, so stopSession is best-effort and
    /// typically skipped.
    SidecarDisconnected,
}

impl AbnormalExit {
    pub(super) fn event_kind(self) -> &'static str {
        match self {
            Self::HeartbeatTimeout => "heartbeat_timeout",
            Self::SidecarDisconnected => "sidecar_disconnected",
        }
    }

    pub(super) fn into_terminal_reason(self) -> TerminalReason {
        match self {
            Self::HeartbeatTimeout => TerminalReason::HeartbeatTimeout,
            Self::SidecarDisconnected => TerminalReason::SidecarDisconnected,
        }
    }
}

/// Coarse-grained discriminant for `TurnState`, used in
/// `TransitionError::UnexpectedEventInState` to keep the variant cheap to
/// serialize for tracing without leaking the full payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::agents::streaming) enum TurnStateKind {
    Initializing,
    Streaming,
    Terminated,
}

impl TurnState {
    pub(in crate::agents::streaming) fn kind(&self) -> TurnStateKind {
        match self {
            TurnState::Initializing => TurnStateKind::Initializing,
            TurnState::Streaming => TurnStateKind::Streaming,
            TurnState::Terminated(_) => TurnStateKind::Terminated,
        }
    }

    pub(in crate::agents::streaming) fn is_terminated(&self) -> bool {
        matches!(self, TurnState::Terminated(_))
    }
}

/// Per-turn invariants that the event handlers read and mutate. Distinct
/// from `TurnState` so the state-transition logic can be expressed without
/// dragging the long list of context fields into every variant.
///
/// All fields here exist in today's event loop as local `let mut` bindings
/// inside `stream_via_sidecar`. Bundling them into a struct lets the state
/// machine's `handle` function take `&mut self` once instead of threading
/// 12 arguments.
#[derive(Debug, Clone)]
pub(in crate::agents::streaming) struct TurnContext {
    pub provider: String,
    pub model_id: String,
    pub working_directory: String,
    pub effort_level: Option<String>,
    pub permission_mode: Option<String>,
    pub fast_mode: bool,

    /// Helmor's session id (the DB primary key), if the request had one.
    /// `None` for transient turns that don't persist (e.g., title gen).
    pub helmor_session_id: Option<String>,

    /// Provider-issued session id (Claude conversation id, Codex thread id).
    /// Adopted from `system.init` per the rules in
    /// [`super::session_id::should_adopt_provider_session_id`].
    pub resolved_session_id: Option<String>,

    /// CLI model name. Initialized from the resolved-model fallback; the
    /// pipeline accumulator may upgrade it from a `system.init` event.
    pub resolved_model: String,

    /// How many turns we've already written to the DB. Compared against
    /// `pipeline.accumulator.turns_len()` after every push to drain newly
    /// completed turns into the DB without double-writing.
    pub persisted_turn_count: usize,

    /// When `planCaptured` fires we synthesize an exit-plan-review row;
    /// it lingers here so the terminal `end` event can append it to the
    /// final UI message bundle.
    pub persisted_exit_plan_review: Option<ThreadMessageLike>,
}

/// Reasons a `handle(state, event)` call may refuse to advance.
///
/// Today's event loop never returns these — invalid events are silently
/// dropped or processed despite being out-of-state. The state machine
/// surfaces them so the call site can log + decide (drop vs. force-
/// terminate); the loss-of-information bug class is closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::agents::streaming) enum TransitionError {
    /// Event arrived after a terminal transition.
    AlreadyTerminated { event_kind: String },
    /// Event arrived in a state where it isn't legal.
    UnexpectedEventInState {
        state: TurnStateKind,
        event_kind: String,
    },
    /// Event payload missing required fields.
    MalformedEvent { event_kind: String, reason: String },
}

/// Owns the per-turn state machine. Every sidecar event the loop sees
/// flows through one of the `handle_*` methods on this struct.
///
/// The session is `Send` so it can live inside the `spawn_blocking`
/// closure that owns the event loop.
#[derive(Debug)]
pub(in crate::agents::streaming) struct TurnSession {
    pub state: TurnState,
    pub ctx: TurnContext,
}

impl TurnSession {
    pub(in crate::agents::streaming) fn new(ctx: TurnContext) -> Self {
        Self {
            state: TurnState::Initializing,
            ctx,
        }
    }
}
