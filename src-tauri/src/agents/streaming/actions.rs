//! Side effects emitted by the state machine in `streaming/state.rs`.
//!
//! Each `handle_*(state, event) -> Vec<Action>` call returns the list of
//! external effects (DB writes, frontend emits, sidecar requests) that
//! the loop should execute. Returning a list instead of executing the
//! effects inline lets us:
//!
//! - Unit-test the state machine without DB or Tauri channels.
//! - Express ordering invariants explicitly (the list IS the order —
//!   the Update emit must precede the terminal Done/Aborted/etc. so the
//!   frontend cache is up-to-date when the spinner clears).
//! - Catch missing effects via the test fixtures — if a transition was
//!   meant to emit `EmitToFrontend(Done)` but doesn't, the snapshot
//!   diff is impossible to miss.
//!
//! Today only `EmitToFrontend` and `PersistContextUsage` are wired into
//! [`apply_action`]. The remaining variants (`PersistTurnRange`,
//! `PersistResult`, `PersistError`, `PersistExitPlan`,
//! `AdoptProviderSessionId`, `RequestSidecarStop`,
//! `FinalizeSessionStatus`) are reserved for a future iteration that
//! moves the inline DB-write loops in `streaming/mod.rs` behind the
//! Action interface; the catch-all arm in `apply_action` logs them so
//! a state-machine test that emits an unwired action fails loudly.

// Reserved Action variants are wired in across the persistence-side
// migration; suppress dead-code warnings until each migrates.
#![allow(dead_code)]

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::agents::AgentStreamEvent;
use crate::pipeline::types::ThreadMessageLike;

/// One external effect to perform after a state-machine transition.
///
/// Variants are NOT mutually exclusive — a single transition typically
/// returns 2–4 (e.g., `[PersistTurnRange { .. }, EmitToFrontend(..),
/// AdoptProviderSessionId(..)]`). The order matters: persistence happens
/// before emission so the frontend never sees a streaming partial whose
/// IDs don't exist in the DB yet on reload.
#[derive(Debug, Clone)]
pub(super) enum Action {
    /// Send an event to the frontend over the Tauri channel.
    EmitToFrontend(AgentStreamEvent),

    /// Persist the user prompt at turn start. Carries the raw prompt
    /// text and any attached file paths.
    PersistUserMessage { prompt: String, files: Vec<String> },

    /// Drain accumulator turns `[from, to)` into the DB. The state
    /// machine bumps `persisted_turn_count` to `to` once `apply` reports
    /// success.
    PersistTurnRange { from: usize, to: usize },

    /// Persist the result row at the end of a successful turn. Captures
    /// the resolved model, the assistant text bundle, usage, and the raw
    /// `result` JSON so the historical loader has everything it needs.
    PersistResult {
        resolved_model: String,
        assistant_text: String,
        usage_json: Option<Value>,
        result_json: Option<String>,
        status: String,
        preassigned_id: Option<String>,
    },

    /// Persist a generic error row + flip session status. Triggered by
    /// the `error` event arm and the heartbeat-timeout / disconnect
    /// abnormal-exit paths.
    PersistError {
        resolved_model: String,
        message: String,
    },

    /// Persist an exit-plan-review row triggered by `planCaptured`.
    PersistExitPlan { plan: ThreadMessageLike },

    /// Update the session row's `provider_session_id` and `agent_type`.
    /// Fires once per turn, when `system.init` (Claude) or the first
    /// notification (Codex) arrives with a usable id.
    AdoptProviderSessionId { sid: String },

    /// Send `stopSession` to the sidecar (e.g., during graceful
    /// shutdown's heartbeat-timeout path).
    RequestSidecarStop {
        sidecar_session_id: String,
        provider: String,
    },

    /// Persist the parsed `contextUsageUpdated` payload + broadcast a
    /// `ContextUsageChanged` UI mutation.
    PersistContextUsage { raw: Value },

    /// Persist the parsed `codexGoalUpdated` payload + broadcast a
    /// `CodexGoalChanged` UI mutation.
    PersistCodexGoal { raw: Value },

    /// Finalize the session row to the given status (`idle` for normal
    /// exits, `aborted` for user-requested stops). Emitted on terminal
    /// transitions that don't go through `PersistResult` (e.g., aborts
    /// where there's no result text to persist).
    FinalizeSessionStatus { status: String },
}

/// Runtime resources `apply_action` needs to execute side effects.
///
/// Bundled in a struct so the call site builds it once at the top of the
/// event loop rather than threading every dispatcher argument through.
/// DB connections are NOT carried here — they're acquired per-action
/// from the single-writer pool to match the existing short-borrow rule
/// (long-held writers stall pin/unpin/mark-read/rename app-wide).
pub(super) struct ApplyContext<'a> {
    pub on_event: &'a Channel<AgentStreamEvent>,
    pub app: &'a AppHandle,
}

/// Execute a single action against the runtime resources.
///
/// Variants are wired in across iterations 4–N. Each migration of a
/// match arm in `streaming/mod.rs` adds its corresponding apply branch
/// here; the catch-all logs unwired actions so tests fail loudly rather
/// than silently skipping side effects.
pub(super) fn apply_action(action: Action, ctx: &ApplyContext) {
    match action {
        Action::EmitToFrontend(event) => {
            // The legacy event loop also ignores send errors with
            // `let _ = on_event.send(...)`; matching that behavior keeps
            // this iteration a no-op-equivalent migration. The
            // disconnected-channel cleanup is on the iteration-N+ list.
            let _ = ctx.on_event.send(event);
        }
        Action::PersistContextUsage { raw } => {
            super::context_usage::persist_context_usage_event(ctx.app, &raw);
        }
        Action::PersistCodexGoal { raw } => {
            super::codex_goal::persist_codex_goal_event(ctx.app, &raw);
        }
        other => {
            tracing::error!(
                action = ?other,
                "apply_action: action not yet wired — pending migration of the matching event arm",
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_emit_to_frontend_round_trips_event() {
        let event = AgentStreamEvent::Error {
            message: "boom".into(),
            persisted: false,
            internal: false,
        };
        let action = Action::EmitToFrontend(event.clone());
        match action {
            Action::EmitToFrontend(AgentStreamEvent::Error { message, .. }) => {
                assert_eq!(message, "boom");
            }
            other => panic!("expected EmitToFrontend(Error), got {other:?}"),
        }
    }

    #[test]
    fn action_persist_turn_range_carries_index_pair() {
        let action = Action::PersistTurnRange { from: 2, to: 5 };
        match action {
            Action::PersistTurnRange { from, to } => {
                assert_eq!(from, 2);
                assert_eq!(to, 5);
            }
            other => panic!("expected PersistTurnRange, got {other:?}"),
        }
    }

    #[test]
    fn actions_debug_format_distinguishes_payloads() {
        // ThreadMessageLike doesn't implement PartialEq, so Action does
        // not either. State-machine tests in iteration 4+ assert via
        // Debug-format strings or per-variant pattern matching instead.
        let a = Action::AdoptProviderSessionId { sid: "a".into() };
        let b = Action::AdoptProviderSessionId { sid: "b".into() };
        assert_ne!(format!("{a:?}"), format!("{b:?}"));
    }
}
