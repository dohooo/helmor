//! Per-event handlers for [`TurnSession`].
//!
//! Each handler takes the prepared inputs (raw sidecar event,
//! pipeline emit, pre-finalised messages, etc.) and returns a vector
//! of `Action`s the call site dispatches via
//! [`super::super::actions::apply_action`]. Handlers bail with
//! `TransitionError::AlreadyTerminated` when invoked after a terminal
//! transition — the legacy event loop silently dropped late events;
//! returning the rejection lets the call site log + decide.

use serde_json::Value;

use crate::agents::AgentStreamEvent;
use crate::pipeline::types::ThreadMessageLike;
use crate::pipeline::PipelineEmit;

use super::super::actions::Action;
use super::super::bridges::{
    bridge_aborted_event, bridge_done_event, bridge_error_event, bridge_permission_request_event,
    bridge_user_input_request_event,
};
use super::{AbnormalExit, TerminalReason, TransitionError, TurnSession, TurnState};

impl TurnSession {
    /// Handle a `permissionRequest` sidecar event.
    ///
    /// Permission requests don't mutate session state — they just notify
    /// the frontend that the AI wants to run a tool and is paused on
    /// approval. Returning `Err(AlreadyTerminated)` if a late permission
    /// arrives after `end`/`aborted`/`error` closes the silent-drop bug
    /// the legacy match arm has today.
    pub(in crate::agents::streaming) fn handle_permission_request(
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
    pub(in crate::agents::streaming) fn handle_user_input_request(
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
    pub(in crate::agents::streaming) fn handle_stream_event(
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
    pub(in crate::agents::streaming) fn handle_end_or_aborted(
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
    pub(in crate::agents::streaming) fn handle_abnormal_exit(
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
    pub(in crate::agents::streaming) fn handle_error(
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
    pub(in crate::agents::streaming) fn handle_plan_captured(
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
    pub(in crate::agents::streaming) fn handle_context_usage_updated(
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
    pub(in crate::agents::streaming) fn handle_codex_goal_updated(
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
    pub(in crate::agents::streaming) fn handle_permission_mode_changed(
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
