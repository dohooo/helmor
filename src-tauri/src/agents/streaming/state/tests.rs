use serde_json::json;

use crate::agents::AgentStreamEvent;
use crate::pipeline::types::ThreadMessageLike;
use crate::pipeline::PipelineEmit;

use super::super::actions::Action;
use super::{
    AbnormalExit, TerminalReason, TransitionError, TurnContext, TurnSession, TurnState,
    TurnStateKind,
};

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
