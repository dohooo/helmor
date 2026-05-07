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
//!   resolved session id, etc.). Replaces the bag of local `let mut`
//!   bindings that used to thread through the closure.
//! - [`TerminalReason`] — what flavor of terminal we hit, including
//!   the abnormal exits (`HeartbeatTimeout`, `SidecarDisconnected`)
//!   that don't arrive as a sidecar event.
//! - [`TransitionError`] — the structured rejection type the state
//!   machine returns instead of silently no-op'ing on invalid input.
//! - [`Action`](super::actions::Action) — the side-effect descriptor
//!   each `handle_*` returns. Caller dispatches via
//!   [`super::actions::apply_action`].
//!
//! Every event arm in `streaming/mod.rs` flows through one of these
//! handlers:
//!
//! | Event | Handler |
//! |-------|---------|
//! | `permissionRequest` | [`TurnSession::handle_permission_request`] |
//! | `permissionModeChanged` | [`TurnSession::handle_permission_mode_changed`] |
//! | `userInputRequest` | [`TurnSession::handle_user_input_request`] |
//! | `contextUsageUpdated` | [`TurnSession::handle_context_usage_updated`] |
//! | `planCaptured` | [`TurnSession::handle_plan_captured`] |
//! | `error` | [`TurnSession::handle_error`] |
//! | `end` / `aborted` | [`TurnSession::handle_end_or_aborted`] |
//! | default (`stream_event`, `assistant`, `result`, etc.) | [`TurnSession::handle_stream_event`] |
//! | heartbeat timeout / sidecar disconnect (synthesized) | [`TurnSession::handle_abnormal_exit`] |
//!
//! Pipeline mutation and DB writes still happen inline in the call
//! site because they need owned access to `MessagePipeline` and the
//! single-writer DB pool; the state machine takes the prepared values
//! and decides what to emit and how to advance the state.

// `TransitionError` variants `UnexpectedEventInState` / `MalformedEvent`
// (and the `TurnStateKind` discriminant they reference) are reserved for
// a future strict-validation pass — handlers today only emit
// `AlreadyTerminated`. Suppress dead-code warnings on the module rather
// than on each variant so the diff stays readable when those readers
// come online.
#![allow(dead_code)]

use serde_json::Value;

use crate::agents::AgentStreamEvent;
use crate::pipeline::types::ThreadMessageLike;
use crate::pipeline::PipelineEmit;

use super::actions::Action;
use super::bridges::{
    bridge_aborted_event, bridge_done_event, bridge_error_event, bridge_permission_request_event,
    bridge_user_input_request_event,
};

/// Top-level state of a single agent turn.
///
/// The Codex/Claude variation lives inside `TurnContext` (resolved model,
/// session id) and the pipeline accumulator (block-level streaming state).
/// `TurnState` is provider-agnostic: it tracks just whether the turn is
/// in-flight, paused, or done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum TurnState {
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
pub(super) enum TerminalReason {
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
pub(super) enum AbnormalExit {
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
    fn event_kind(self) -> &'static str {
        match self {
            Self::HeartbeatTimeout => "heartbeat_timeout",
            Self::SidecarDisconnected => "sidecar_disconnected",
        }
    }

    fn into_terminal_reason(self) -> TerminalReason {
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
pub(super) enum TurnStateKind {
    Initializing,
    Streaming,
    Terminated,
}

impl TurnState {
    pub(super) fn kind(&self) -> TurnStateKind {
        match self {
            TurnState::Initializing => TurnStateKind::Initializing,
            TurnState::Streaming => TurnStateKind::Streaming,
            TurnState::Terminated(_) => TurnStateKind::Terminated,
        }
    }

    pub(super) fn is_terminated(&self) -> bool {
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
pub(super) struct TurnContext {
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
pub(super) enum TransitionError {
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
pub(super) struct TurnSession {
    pub state: TurnState,
    pub ctx: TurnContext,
}

impl TurnSession {
    pub(super) fn new(ctx: TurnContext) -> Self {
        Self {
            state: TurnState::Initializing,
            ctx,
        }
    }

    /// Handle a `permissionRequest` sidecar event.
    ///
    /// Permission requests don't mutate session state — they just notify
    /// the frontend that the AI wants to run a tool and is paused on
    /// approval. Returning `Err(AlreadyTerminated)` if a late permission
    /// arrives after `end`/`aborted`/`error` closes the silent-drop bug
    /// the legacy match arm has today.
    pub(super) fn handle_permission_request(
        &mut self,
        raw: &Value,
    ) -> Result<Vec<Action>, TransitionError> {
        if self.state.is_terminated() {
            return Err(TransitionError::AlreadyTerminated {
                event_kind: "permissionRequest".into(),
            });
        }
        Ok(vec![Action::EmitToFrontend(
            bridge_permission_request_event(raw),
        )])
    }

    /// Handle a unified `userInputRequest` sidecar event. **Non-terminal pause.**
    ///
    /// Sources include Claude AskUserQuestion (canUseTool), Claude MCP
    /// elicitation (onElicitation), and Codex `requestUserInput`. All
    /// of them park the relevant SDK callback in the sidecar and ride
    /// through the same wire event — Rust just emits a snapshot Update
    /// (so the frontend cache mirrors the pre-pause assistant text)
    /// followed by the `UserInputRequest` marker, then stays in
    /// `Streaming`. Subsequent stream events flow through this state
    /// machine normally once the user submits via `respondToUserInput`.
    ///
    /// `pipeline_final_messages` is a non-destructive snapshot taken
    /// from `pipeline.finish()` at the call site; the pipeline itself
    /// is still alive and continues accumulating.
    pub(super) fn handle_user_input_request(
        &mut self,
        raw: &Value,
        resolved_model: &str,
        pipeline_final_messages: Vec<ThreadMessageLike>,
    ) -> Result<Vec<Action>, TransitionError> {
        if self.state.is_terminated() {
            return Err(TransitionError::AlreadyTerminated {
                event_kind: "userInputRequest".into(),
            });
        }
        Ok(vec![
            Action::EmitToFrontend(AgentStreamEvent::Update {
                messages: pipeline_final_messages,
            }),
            Action::EmitToFrontend(bridge_user_input_request_event(
                &self.ctx.provider,
                &self.ctx.model_id,
                resolved_model,
                self.ctx.resolved_session_id.clone(),
                &self.ctx.working_directory,
                self.ctx.permission_mode.clone(),
                raw,
            )),
        ])
    }

    /// Handle a generic stream event (the catch-all match arm). The
    /// caller has already pushed `event.raw` into the pipeline
    /// accumulator and persisted any newly completed turns; this
    /// method just decides what to emit based on the `PipelineEmit`
    /// the accumulator returned.
    ///
    /// On `Full(messages)` we append `ctx.persisted_exit_plan_review`
    /// (if a planCaptured stashed one earlier) so the cache mirrors
    /// the historical reload's row order.
    pub(super) fn handle_stream_event(
        &mut self,
        emit: PipelineEmit,
    ) -> Result<Vec<Action>, TransitionError> {
        if self.state.is_terminated() {
            return Err(TransitionError::AlreadyTerminated {
                event_kind: "stream_event".into(),
            });
        }
        match emit {
            PipelineEmit::Full(mut messages) => {
                if let Some(plan_msg) = self.ctx.persisted_exit_plan_review.clone() {
                    messages.push(plan_msg);
                }
                Ok(vec![Action::EmitToFrontend(AgentStreamEvent::Update {
                    messages,
                })])
            }
            PipelineEmit::Partial(message) => Ok(vec![Action::EmitToFrontend(
                AgentStreamEvent::StreamingPartial { message },
            )]),
            PipelineEmit::None => Ok(vec![]),
        }
    }

    /// Handle the `end` and `aborted` sidecar events. **Terminal transition.**
    ///
    /// Both branches share most of the prep work in `streaming/mod.rs`
    /// (mark_pending_tools_aborted on abort, flush_pending,
    /// drain_output, persist_result_and_finalize / finalize_session_metadata).
    /// The state machine takes the prepared values and:
    ///
    /// 1. Appends `ctx.persisted_exit_plan_review` (set by an earlier
    ///    planCaptured) to `final_messages` so the cache reflects the
    ///    plan review row at the tail.
    /// 2. Emits `Update { messages: ... }` so the frontend's cache
    ///    matches the historical reload.
    /// 3. Transitions to `Terminated(Done)` or `Terminated(Aborted { reason })`.
    /// 4. Emits the matching `Done` or `Aborted` terminal event.
    pub(super) fn handle_end_or_aborted(
        &mut self,
        is_aborted: bool,
        reason: Option<String>,
        resolved_model: &str,
        mut final_messages: Vec<ThreadMessageLike>,
        persisted: bool,
    ) -> Result<Vec<Action>, TransitionError> {
        if self.state.is_terminated() {
            return Err(TransitionError::AlreadyTerminated {
                event_kind: if is_aborted {
                    "aborted".into()
                } else {
                    "end".into()
                },
            });
        }

        // The planCaptured arm stashed the exit-plan review here; it
        // must trail the final assistant turn in the Update payload so
        // the frontend cache mirrors what `convert_historical` produces
        // on reload (DB row order — exit_plan_message comes last).
        if let Some(plan_message) = self.ctx.persisted_exit_plan_review.clone() {
            final_messages.push(plan_message);
        }

        let mut actions = Vec::with_capacity(2);
        actions.push(Action::EmitToFrontend(AgentStreamEvent::Update {
            messages: final_messages,
        }));

        if is_aborted {
            let reason_str = reason.unwrap_or_else(|| "user_requested".to_string());
            self.state = TurnState::Terminated(TerminalReason::Aborted {
                reason: reason_str.clone(),
            });
            actions.push(Action::EmitToFrontend(bridge_aborted_event(
                &self.ctx.provider,
                &self.ctx.model_id,
                resolved_model,
                self.ctx.resolved_session_id.clone(),
                &self.ctx.working_directory,
                persisted,
                reason_str,
            )));
        } else {
            self.state = TurnState::Terminated(TerminalReason::Done);
            actions.push(Action::EmitToFrontend(bridge_done_event(
                &self.ctx.provider,
                &self.ctx.model_id,
                resolved_model,
                self.ctx.resolved_session_id.clone(),
                &self.ctx.working_directory,
                persisted,
            )));
        }

        Ok(actions)
    }

    /// Handle an abnormal receiver-loop exit (heartbeat timeout or
    /// sidecar channel disconnect). **Terminal transition.**
    ///
    /// Synthesized by the call site when `rx.recv_timeout` fires
    /// `RecvTimeoutError::{Timeout,Disconnected}`. The call site has
    /// already (a) logged the underlying cause, (b) optionally sent
    /// `stopSession` to the sidecar (timeout only), and (c) called
    /// `cleanup_abnormal_stream_exit` to persist a generic error row +
    /// flip the session to `idle`. `persisted` carries that DB result
    /// so the emitted `Error` event mirrors the on-disk state.
    ///
    /// Always emits `Error { internal: true, .. }` so the frontend
    /// shows a generic toast rather than leaking the heartbeat-timeout
    /// details to the user.
    pub(super) fn handle_abnormal_exit(
        &mut self,
        kind: AbnormalExit,
        user_message: String,
        persisted: bool,
    ) -> Result<Vec<Action>, TransitionError> {
        if self.state.is_terminated() {
            return Err(TransitionError::AlreadyTerminated {
                event_kind: kind.event_kind().into(),
            });
        }
        self.state = TurnState::Terminated(kind.into_terminal_reason());
        Ok(vec![Action::EmitToFrontend(AgentStreamEvent::Error {
            message: user_message,
            persisted,
            internal: true,
        })])
    }

    /// Handle an `error` sidecar event. **Terminal transition.**
    ///
    /// `persisted` is computed by the call site after running
    /// `persist_error_message` against the live DB pool. The state
    /// machine takes that result as input, transitions to
    /// `Terminated(Error { .. })`, and emits the canonical Error event.
    /// After this returns, the event loop must break out of its
    /// receive loop.
    pub(super) fn handle_error(
        &mut self,
        raw: &Value,
        persisted: bool,
    ) -> Result<Vec<Action>, TransitionError> {
        if self.state.is_terminated() {
            return Err(TransitionError::AlreadyTerminated {
                event_kind: "error".into(),
            });
        }
        let event = bridge_error_event(raw, persisted);
        let (message, internal) = match &event {
            AgentStreamEvent::Error {
                message, internal, ..
            } => (message.clone(), *internal),
            _ => unreachable!("bridge_error_event returns Error variant"),
        };
        self.state = TurnState::Terminated(TerminalReason::Error {
            message,
            internal,
            persisted,
        });
        Ok(vec![Action::EmitToFrontend(event)])
    }

    /// Handle a `planCaptured` sidecar event.
    ///
    /// The DB persistence (turn flush + exit_plan_message row) and
    /// pipeline finalization (`finish()`) still run inline in
    /// `streaming/mod.rs` because they need owned access to the
    /// `MessagePipeline` and the single-writer DB pool. The state
    /// machine takes the prepared `plan_message` and the pipeline's
    /// finalized messages, stashes the plan in `ctx`, and returns the
    /// two-emit sequence (Update + PlanCaptured) the frontend expects.
    pub(super) fn handle_plan_captured(
        &mut self,
        plan_message: ThreadMessageLike,
        mut pipeline_final_messages: Vec<ThreadMessageLike>,
    ) -> Result<Vec<Action>, TransitionError> {
        if self.state.is_terminated() {
            return Err(TransitionError::AlreadyTerminated {
                event_kind: "planCaptured".into(),
            });
        }
        // The frontend renders the plan-review card from the trailing
        // entry of `Update.messages`; appending here keeps the live
        // render symmetrical with the historical reload (which appends
        // the exit-plan row at the end of the message list).
        pipeline_final_messages.push(plan_message.clone());
        self.ctx.persisted_exit_plan_review = Some(plan_message);
        Ok(vec![
            Action::EmitToFrontend(AgentStreamEvent::Update {
                messages: pipeline_final_messages,
            }),
            Action::EmitToFrontend(AgentStreamEvent::PlanCaptured {}),
        ])
    }

    /// Handle a `contextUsageUpdated` sidecar event.
    ///
    /// Persists the parsed payload to the session row and broadcasts a
    /// `ContextUsageChanged` UI mutation so React Query invalidates the
    /// cached meta. No frontend emit on the streaming channel — the
    /// payload travels via the broadcast socket, not the per-turn channel.
    pub(super) fn handle_context_usage_updated(
        &mut self,
        raw: &Value,
    ) -> Result<Vec<Action>, TransitionError> {
        if self.state.is_terminated() {
            return Err(TransitionError::AlreadyTerminated {
                event_kind: "contextUsageUpdated".into(),
            });
        }
        Ok(vec![Action::PersistContextUsage { raw: raw.clone() }])
    }

    /// Handle a `codexGoalUpdated` sidecar event (Codex `/goal` lifecycle).
    /// Persists the goal payload to the session row and broadcasts a
    /// `CodexGoalChanged` invalidation so the panel-header banner refetches.
    ///
    /// Intentionally does NOT bail when the turn is already terminated:
    /// codex pushes `thread/goal/updated` exactly at the turn boundary
    /// with the final tokens / `complete` status, and we want the banner
    /// to reflect that. The action is a pure DB write + UI invalidation
    /// — no state-machine invariants to protect.
    pub(super) fn handle_codex_goal_updated(
        &mut self,
        raw: &Value,
    ) -> Result<Vec<Action>, TransitionError> {
        Ok(vec![Action::PersistCodexGoal { raw: raw.clone() }])
    }

    /// Handle a `permissionModeChanged` sidecar event.
    ///
    /// State-mutating with no frontend emit: stores the new mode in
    /// `ctx.permission_mode` so subsequent transitions (e.g.,
    /// `deferredToolUse`) see the latest value. Until iteration 7+ also
    /// migrates the readers, the call site mirrors the value back into
    /// the legacy local var `permission_mode_copy`.
    pub(super) fn handle_permission_mode_changed(
        &mut self,
        raw: &Value,
    ) -> Result<Vec<Action>, TransitionError> {
        if self.state.is_terminated() {
            return Err(TransitionError::AlreadyTerminated {
                event_kind: "permissionModeChanged".into(),
            });
        }
        self.ctx.permission_mode = raw
            .get("permissionMode")
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok(vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_ctx() -> TurnContext {
        TurnContext {
            provider: "claude".into(),
            model_id: "opus-1m".into(),
            working_directory: "/tmp/helmor".into(),
            effort_level: None,
            permission_mode: None,
            fast_mode: false,
            helmor_session_id: Some("session-1".into()),
            resolved_session_id: None,
            resolved_model: "claude-opus-4".into(),
            persisted_turn_count: 0,
            persisted_exit_plan_review: None,
        }
    }

    #[test]
    fn turn_session_starts_in_initializing() {
        let session = TurnSession::new(test_ctx());
        assert_eq!(session.state, TurnState::Initializing);
    }

    #[test]
    fn handle_permission_request_emits_one_action() {
        let mut session = TurnSession::new(test_ctx());
        let raw = json!({
            "permissionId": "p-1",
            "toolName": "Bash",
            "toolInput": { "command": "ls" }
        });

        let actions = session.handle_permission_request(&raw).unwrap();

        assert_eq!(actions.len(), 1);
        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::PermissionRequest {
                permission_id,
                tool_name,
                ..
            }) => {
                assert_eq!(permission_id, "p-1");
                assert_eq!(tool_name, "Bash");
            }
            other => panic!("expected EmitToFrontend(PermissionRequest), got {other:?}"),
        }
    }

    #[test]
    fn handle_permission_request_does_not_mutate_state() {
        // Permission requests are notifications — the state stays where
        // it was so subsequent stream events still flow.
        let mut session = TurnSession::new(test_ctx());
        let _ = session
            .handle_permission_request(&json!({ "permissionId": "p-1" }))
            .unwrap();
        assert_eq!(session.state, TurnState::Initializing);
    }

    #[test]
    fn handle_permission_request_after_terminal_returns_error() {
        // The legacy match arm silently drops late events here. The
        // state machine surfaces it.
        let mut session = TurnSession::new(test_ctx());
        session.state = TurnState::Terminated(TerminalReason::Done);

        let err = session
            .handle_permission_request(&json!({ "permissionId": "p-late" }))
            .unwrap_err();

        match err {
            TransitionError::AlreadyTerminated { event_kind } => {
                assert_eq!(event_kind, "permissionRequest");
            }
            other => panic!("expected AlreadyTerminated, got {other:?}"),
        }
    }

    #[test]
    fn handle_user_input_request_emits_update_then_marker_with_live_resolved_model() {
        // The pipeline owns the truth about `resolved_model` (it can be
        // upgraded mid-stream by `system.init`). The state machine takes
        // it as an argument rather than reading the snapshot in ctx.
        let mut session = TurnSession::new(test_ctx());
        session.state = TurnState::Streaming;
        let raw = json!({
            "userInputId": "ui-1",
            "source": "design-server",
            "message": "Need input",
            "payload": {
                "kind": "form",
                "schema": { "type": "object", "properties": {} }
            }
        });
        let final_messages = vec![empty_thread_message("asst-1")];

        let actions = session
            .handle_user_input_request(&raw, "claude-opus-4.6-LIVE", final_messages)
            .unwrap();

        // Update first (snapshot of pre-pause state) then the
        // UserInputRequest marker. State must STAY in Streaming —
        // user-input pause is non-terminal.
        assert_eq!(actions.len(), 2);
        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::Update { messages }) => {
                assert_eq!(messages.len(), 1);
                assert_eq!(messages[0].id.as_deref(), Some("asst-1"));
            }
            other => panic!("expected EmitToFrontend(Update), got {other:?}"),
        }
        match &actions[1] {
            Action::EmitToFrontend(AgentStreamEvent::UserInputRequest {
                resolved_model,
                user_input_id,
                source,
                ..
            }) => {
                assert_eq!(resolved_model, "claude-opus-4.6-LIVE");
                assert_eq!(user_input_id, "ui-1");
                assert_eq!(source, "design-server");
            }
            other => panic!("expected EmitToFrontend(UserInputRequest), got {other:?}"),
        }
        assert_eq!(session.state, TurnState::Streaming);
    }

    #[test]
    fn handle_permission_mode_changed_updates_ctx_emits_nothing() {
        // Pure state mutation: caller mirrors `ctx.permission_mode` into
        // the legacy `permission_mode_copy` until the readers migrate.
        let mut session = TurnSession::new(test_ctx());
        assert_eq!(session.ctx.permission_mode, None);

        let actions = session
            .handle_permission_mode_changed(&json!({ "permissionMode": "plan" }))
            .unwrap();

        assert!(actions.is_empty());
        assert_eq!(session.ctx.permission_mode.as_deref(), Some("plan"));
    }

    fn empty_thread_message(id: &str) -> ThreadMessageLike {
        serde_json::from_value(json!({
            "id": id,
            "role": "assistant",
            "content": []
        }))
        .expect("trivial ThreadMessageLike parses")
    }

    #[test]
    fn handle_stream_event_full_emits_update_with_messages() {
        let mut session = TurnSession::new(test_ctx());
        let messages = vec![empty_thread_message("asst-1")];

        let actions = session
            .handle_stream_event(PipelineEmit::Full(messages))
            .unwrap();

        assert_eq!(actions.len(), 1);
        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::Update { messages }) => {
                assert_eq!(messages.len(), 1);
            }
            other => panic!("expected EmitToFrontend(Update), got {other:?}"),
        }
    }

    #[test]
    fn handle_stream_event_full_appends_exit_plan_review() {
        // After a planCaptured fired earlier in the turn, every Full
        // emission must append the plan-review row so the cache and
        // the historical reload line up.
        let mut session = TurnSession::new(test_ctx());
        session.ctx.persisted_exit_plan_review = Some(empty_thread_message("plan-1"));
        let messages = vec![empty_thread_message("asst-1")];

        let actions = session
            .handle_stream_event(PipelineEmit::Full(messages))
            .unwrap();

        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::Update { messages }) => {
                assert_eq!(messages.len(), 2, "asst-1 + plan-1");
                assert_eq!(messages[1].id.as_deref(), Some("plan-1"));
            }
            other => panic!("expected EmitToFrontend(Update), got {other:?}"),
        }
    }

    #[test]
    fn handle_stream_event_partial_emits_streaming_partial() {
        let mut session = TurnSession::new(test_ctx());
        let message = empty_thread_message("asst-streaming");

        let actions = session
            .handle_stream_event(PipelineEmit::Partial(message))
            .unwrap();

        assert_eq!(actions.len(), 1);
        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::StreamingPartial { message }) => {
                assert_eq!(message.id.as_deref(), Some("asst-streaming"));
            }
            other => panic!("expected EmitToFrontend(StreamingPartial), got {other:?}"),
        }
    }

    #[test]
    fn handle_stream_event_none_returns_empty_actions() {
        let mut session = TurnSession::new(test_ctx());
        let actions = session.handle_stream_event(PipelineEmit::None).unwrap();
        assert!(actions.is_empty());
    }

    #[test]
    fn handle_end_or_aborted_done_path_emits_update_then_done() {
        let mut session = TurnSession::new(test_ctx());
        let final_messages = vec![empty_thread_message("asst-1")];

        let actions = session
            .handle_end_or_aborted(false, None, "claude-opus-4-LIVE", final_messages, true)
            .unwrap();

        assert_eq!(actions.len(), 2);
        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::Update { messages }) => {
                assert_eq!(messages.len(), 1);
            }
            other => panic!("expected EmitToFrontend(Update), got {other:?}"),
        }
        match &actions[1] {
            Action::EmitToFrontend(AgentStreamEvent::Done {
                resolved_model,
                persisted,
                ..
            }) => {
                assert_eq!(resolved_model, "claude-opus-4-LIVE");
                assert!(persisted);
            }
            other => panic!("expected EmitToFrontend(Done), got {other:?}"),
        }
        assert_eq!(session.state, TurnState::Terminated(TerminalReason::Done));
    }

    #[test]
    fn handle_end_or_aborted_aborted_path_carries_reason() {
        let mut session = TurnSession::new(test_ctx());
        let actions = session
            .handle_end_or_aborted(
                true,
                Some("user_requested".into()),
                "claude-opus-4",
                vec![],
                true,
            )
            .unwrap();

        match &actions[1] {
            Action::EmitToFrontend(AgentStreamEvent::Aborted { reason, .. }) => {
                assert_eq!(reason, "user_requested");
            }
            other => panic!("expected EmitToFrontend(Aborted), got {other:?}"),
        }
        assert_eq!(
            session.state,
            TurnState::Terminated(TerminalReason::Aborted {
                reason: "user_requested".into()
            }),
        );
    }

    #[test]
    fn handle_end_or_aborted_aborted_defaults_reason_when_none() {
        // When the sidecar omits `reason` the legacy code defaults to
        // "user_requested"; preserve that for cache-stable snapshots.
        let mut session = TurnSession::new(test_ctx());
        let actions = session
            .handle_end_or_aborted(true, None, "claude-opus-4", vec![], true)
            .unwrap();

        match &actions[1] {
            Action::EmitToFrontend(AgentStreamEvent::Aborted { reason, .. }) => {
                assert_eq!(reason, "user_requested");
            }
            other => panic!("expected EmitToFrontend(Aborted), got {other:?}"),
        }
    }

    #[test]
    fn handle_end_or_aborted_appends_persisted_exit_plan_review() {
        // After a `planCaptured`, the terminal Update must include the
        // plan-review row at the tail so the frontend cache mirrors the
        // DB row order (exit_plan_message is the last persisted row).
        let mut session = TurnSession::new(test_ctx());
        session.ctx.persisted_exit_plan_review = Some(empty_thread_message("plan-1"));
        let final_messages = vec![empty_thread_message("asst-1")];

        let actions = session
            .handle_end_or_aborted(false, None, "claude-opus-4", final_messages, true)
            .unwrap();

        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::Update { messages }) => {
                assert_eq!(messages.len(), 2, "asst-1 + plan-1 appended");
                assert_eq!(messages[1].id.as_deref(), Some("plan-1"));
            }
            other => panic!("expected EmitToFrontend(Update), got {other:?}"),
        }
    }

    #[test]
    fn handle_user_input_request_for_ask_user_question_passes_payload_through() {
        // AskUserQuestion ships through unified userInputRequest with
        // its native `payload.kind = ask-user-question` and the raw
        // questions[] from the SDK — Rust just plumbs it through.
        let mut session = TurnSession::new(test_ctx());
        session.state = TurnState::Streaming;
        session.ctx.permission_mode = Some("default".into());
        let raw = json!({
            "userInputId": "tool-1",
            "source": "Claude",
            "message": "Claude is asking for your input.",
            "payload": {
                "kind": "ask-user-question",
                "questions": [{ "question": "Pick one", "options": [] }]
            }
        });
        let final_messages = vec![empty_thread_message("asst-1")];

        let actions = session
            .handle_user_input_request(&raw, "claude-opus-4-LIVE", final_messages)
            .unwrap();

        assert_eq!(actions.len(), 2);
        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::Update { messages }) => {
                assert_eq!(messages.len(), 1);
            }
            other => panic!("expected EmitToFrontend(Update), got {other:?}"),
        }
        match &actions[1] {
            Action::EmitToFrontend(AgentStreamEvent::UserInputRequest {
                user_input_id,
                source,
                resolved_model,
                permission_mode,
                payload,
                ..
            }) => {
                assert_eq!(user_input_id, "tool-1");
                assert_eq!(source, "Claude");
                assert_eq!(resolved_model, "claude-opus-4-LIVE");
                assert_eq!(permission_mode.as_deref(), Some("default"));
                assert_eq!(payload["kind"], "ask-user-question");
                assert!(payload["questions"].is_array());
            }
            other => panic!("expected EmitToFrontend(UserInputRequest), got {other:?}"),
        }
        assert_eq!(session.state, TurnState::Streaming);
    }

    #[test]
    fn handle_error_transitions_to_terminated_and_emits_error() {
        let mut session = TurnSession::new(test_ctx());
        let raw = json!({
            "message": "Sidecar lost connection",
            "internal": false
        });

        let actions = session.handle_error(&raw, true).unwrap();

        assert_eq!(actions.len(), 1);
        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::Error {
                message,
                persisted,
                internal,
            }) => {
                assert_eq!(message, "Sidecar lost connection");
                assert!(persisted);
                assert!(!internal);
            }
            other => panic!("expected EmitToFrontend(Error), got {other:?}"),
        }
        // State must record the terminal reason so a stray event after
        // this point is rejected, not silently processed.
        match &session.state {
            TurnState::Terminated(TerminalReason::Error {
                message,
                internal,
                persisted,
            }) => {
                assert_eq!(message, "Sidecar lost connection");
                assert!(!internal);
                assert!(persisted);
            }
            other => panic!("expected Terminated(Error), got {other:?}"),
        }
    }

    #[test]
    fn handle_abnormal_exit_heartbeat_timeout_terminates_with_internal_error() {
        let mut session = TurnSession::new(test_ctx());
        let actions = session
            .handle_abnormal_exit(
                AbnormalExit::HeartbeatTimeout,
                "Sidecar stopped responding".into(),
                true,
            )
            .unwrap();

        assert_eq!(actions.len(), 1);
        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::Error {
                message,
                persisted,
                internal,
            }) => {
                assert_eq!(message, "Sidecar stopped responding");
                assert!(persisted);
                assert!(internal, "internal=true so frontend shows generic toast");
            }
            other => panic!("expected EmitToFrontend(Error), got {other:?}"),
        }
        assert_eq!(
            session.state,
            TurnState::Terminated(TerminalReason::HeartbeatTimeout),
        );
    }

    #[test]
    fn handle_abnormal_exit_sidecar_disconnected_uses_distinct_terminal_reason() {
        let mut session = TurnSession::new(test_ctx());
        let actions = session
            .handle_abnormal_exit(
                AbnormalExit::SidecarDisconnected,
                "Sidecar connection lost".into(),
                false,
            )
            .unwrap();

        assert_eq!(actions.len(), 1);
        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::Error {
                persisted,
                internal,
                ..
            }) => {
                assert!(!persisted);
                assert!(internal);
            }
            other => panic!("expected EmitToFrontend(Error), got {other:?}"),
        }
        // Distinct from HeartbeatTimeout so debug logs / future audit
        // can tell the two paths apart even after the wire-format
        // collapsed both into Error{internal:true}.
        assert_eq!(
            session.state,
            TurnState::Terminated(TerminalReason::SidecarDisconnected),
        );
    }

    #[test]
    fn handle_abnormal_exit_after_terminal_returns_already_terminated() {
        // If a terminal sidecar event (end / aborted / error) and a
        // heartbeat timeout race, the second one should be rejected
        // rather than re-emit a duplicate Error to the frontend.
        let mut session = TurnSession::new(test_ctx());
        session.state = TurnState::Terminated(TerminalReason::Done);

        let err = session
            .handle_abnormal_exit(AbnormalExit::HeartbeatTimeout, "late timeout".into(), false)
            .unwrap_err();

        match err {
            TransitionError::AlreadyTerminated { event_kind } => {
                assert_eq!(event_kind, "heartbeat_timeout");
            }
            other => panic!("expected AlreadyTerminated, got {other:?}"),
        }
    }

    #[test]
    fn handle_error_after_terminal_returns_already_terminated() {
        // Two error events in a row would be a sidecar bug, but the
        // state machine should reject the second instead of silently
        // double-emitting.
        let mut session = TurnSession::new(test_ctx());
        session.state = TurnState::Terminated(TerminalReason::Done);

        let err = session
            .handle_error(&json!({ "message": "late error" }), false)
            .unwrap_err();

        match err {
            TransitionError::AlreadyTerminated { event_kind } => {
                assert_eq!(event_kind, "error");
            }
            other => panic!("expected AlreadyTerminated, got {other:?}"),
        }
    }

    #[test]
    fn handle_user_input_request_after_terminal_returns_already_terminated() {
        let mut session = TurnSession::new(test_ctx());
        session.state = TurnState::Terminated(TerminalReason::Done);

        let err = session
            .handle_user_input_request(&json!({}), "model", vec![])
            .unwrap_err();

        match err {
            TransitionError::AlreadyTerminated { event_kind } => {
                assert_eq!(event_kind, "userInputRequest");
            }
            other => panic!("expected AlreadyTerminated, got {other:?}"),
        }
    }

    #[test]
    fn handle_plan_captured_emits_update_then_plan_captured() {
        let mut session = TurnSession::new(test_ctx());
        let plan_message = empty_thread_message("plan-1");
        let final_messages = vec![empty_thread_message("asst-1")];

        let actions = session
            .handle_plan_captured(plan_message.clone(), final_messages)
            .unwrap();

        // Order matters: Update FIRST so the frontend has the plan-review
        // card in its message list before PlanCaptured tells the panel
        // to show the Implement / Request Changes buttons.
        assert_eq!(actions.len(), 2);
        match &actions[0] {
            Action::EmitToFrontend(AgentStreamEvent::Update { messages }) => {
                assert_eq!(messages.len(), 2, "asst-1 + plan-1 appended");
                assert_eq!(messages[1].id.as_deref(), Some("plan-1"));
            }
            other => panic!("expected EmitToFrontend(Update), got {other:?}"),
        }
        match &actions[1] {
            Action::EmitToFrontend(AgentStreamEvent::PlanCaptured {}) => {}
            other => panic!("expected EmitToFrontend(PlanCaptured), got {other:?}"),
        }

        // ctx must remember the plan so the terminal `end | aborted`
        // arm can append it to the final UI message bundle.
        assert_eq!(
            session
                .ctx
                .persisted_exit_plan_review
                .as_ref()
                .and_then(|m| m.id.as_deref()),
            Some("plan-1"),
        );
    }

    #[test]
    fn handle_context_usage_updated_returns_persist_action() {
        let mut session = TurnSession::new(test_ctx());
        let raw = json!({
            "sessionId": "session-1",
            "meta": "{\"usedTokens\":42}"
        });

        let actions = session.handle_context_usage_updated(&raw).unwrap();

        assert_eq!(actions.len(), 1);
        match &actions[0] {
            Action::PersistContextUsage { raw: emitted } => {
                assert_eq!(emitted.get("sessionId").unwrap(), "session-1");
            }
            other => panic!("expected PersistContextUsage, got {other:?}"),
        }
    }

    #[test]
    fn handle_codex_goal_updated_returns_persist_action_when_active() {
        let mut session = TurnSession::new(test_ctx());
        let raw = json!({
            "sessionId": "session-1",
            "goal": "{\"status\":\"active\"}"
        });

        let actions = session.handle_codex_goal_updated(&raw).unwrap();

        assert_eq!(actions.len(), 1);
        assert!(matches!(actions[0], Action::PersistCodexGoal { .. }));
    }

    // Regression: codex pushes `thread/goal/updated` exactly at the turn
    // boundary carrying the final tokens / `complete` status. The handler
    // must NOT bail with `AlreadyTerminated` — that would drop the final
    // payload and leave the banner stale forever. The action is just a DB
    // write + UI invalidation; it has no state-machine invariants to
    // protect post-termination.
    #[test]
    fn handle_codex_goal_updated_still_persists_after_termination() {
        let mut session = TurnSession::new(test_ctx());
        session.state = TurnState::Terminated(TerminalReason::Done);

        let raw = json!({
            "sessionId": "session-1",
            "goal": "{\"status\":\"complete\",\"tokensUsed\":12345}"
        });

        let actions = session.handle_codex_goal_updated(&raw).expect(
            "goal-updated must remain accepted post-termination so the banner sees \
             the final tokens / complete status codex emits at the turn boundary",
        );
        assert_eq!(actions.len(), 1);
        assert!(matches!(actions[0], Action::PersistCodexGoal { .. }));
    }

    #[test]
    fn handle_permission_mode_changed_clears_when_field_missing() {
        let mut session = TurnSession::new(test_ctx());
        session.ctx.permission_mode = Some("acceptEdits".into());

        let actions = session.handle_permission_mode_changed(&json!({})).unwrap();

        assert!(actions.is_empty());
        assert_eq!(session.ctx.permission_mode, None);
    }

    #[test]
    fn turn_state_kind_round_trips() {
        assert_eq!(TurnState::Initializing.kind(), TurnStateKind::Initializing);
        assert_eq!(TurnState::Streaming.kind(), TurnStateKind::Streaming);
        assert_eq!(
            TurnState::Terminated(TerminalReason::Done).kind(),
            TurnStateKind::Terminated,
        );
    }

    #[test]
    fn is_terminated_flags_terminal_variants_only() {
        assert!(!TurnState::Initializing.is_terminated());
        assert!(!TurnState::Streaming.is_terminated());
        assert!(TurnState::Terminated(TerminalReason::Done).is_terminated());
        assert!(TurnState::Terminated(TerminalReason::Aborted {
            reason: "user_requested".into(),
        })
        .is_terminated());
        assert!(TurnState::Terminated(TerminalReason::Error {
            message: "boom".into(),
            internal: true,
            persisted: false,
        })
        .is_terminated());
        assert!(TurnState::Terminated(TerminalReason::HeartbeatTimeout).is_terminated());
        assert!(TurnState::Terminated(TerminalReason::SidecarDisconnected).is_terminated());
    }

    #[test]
    fn terminal_reason_distinguishes_done_from_aborted() {
        // Same fields, different variants — must NOT be equal so we can
        // dispatch on outcome at the bridge layer.
        let done = TurnState::Terminated(TerminalReason::Done);
        let aborted = TurnState::Terminated(TerminalReason::Aborted {
            reason: "user_requested".into(),
        });
        assert_ne!(done, aborted);
    }

    #[test]
    fn transition_error_carries_event_kind_for_tracing() {
        let err = TransitionError::AlreadyTerminated {
            event_kind: "stream_event".into(),
        };
        let formatted = format!("{err:?}");
        assert!(formatted.contains("stream_event"));
    }
}
