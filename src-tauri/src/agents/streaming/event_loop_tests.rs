//! Event-loop orchestration tests.
//!
//! Locks the dispatch shape inside `stream_via_sidecar`'s receive loop:
//! given a sequence of sidecar `SidecarEvent`s, what `AgentStreamEvent`s
//! does the loop emit, in what order, and what state does the
//! `TurnSession` end up in.
//!
//! The unit tests in `state.rs` cover each `handle_*` in isolation; the
//! per-event-type integration tests under `tests/stream_bridge_*.rs`
//! cover the bridge layer. This file fills the remaining gap: the
//! match-arm dispatch + cross-event state carry-over (e.g., a
//! `planCaptured` stashing the plan in `ctx` so a later `end` appends
//! it to the final `Update`).
//!
//! DB writes and Tauri channel emit are deliberately skipped — those
//! have their own coverage in `cleanup.rs`, `context_usage.rs`,
//! `params.rs`, and the `stream_bridge_*` integration tests. What this
//! harness adds is the **routing + ordering** contract.
//!
//! Module-level `#[cfg(test)]` lives on the `mod event_loop_tests;`
//! declaration in `mod.rs`, so this file doesn't need an inner gate.

use insta::assert_yaml_snapshot;
use serde::Serialize;
use serde_json::{json, Value};

use crate::agents::AgentStreamEvent;
use crate::pipeline::types::{ExtendedMessagePart, MessagePart, ThreadMessageLike};
use crate::pipeline::MessagePipeline;

use super::actions::Action;
use super::state::{TurnContext, TurnSession};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// One snapshot-friendly entry per dispatched sidecar event.
#[derive(Debug, Serialize)]
struct DispatchEntry {
    event_type: String,
    /// The trace of what the loop emitted to the frontend. Other Action
    /// variants (Persist*, etc.) are captured in `side_effects` so the
    /// snapshot stays focused on the wire contract.
    emitted: Vec<EmittedEvent>,
    side_effects: Vec<String>,
}

/// Stripped-down `AgentStreamEvent` for snapshotting. Drops UUID-bearing
/// fields and reduces `Update.messages` to role + part-type fingerprints
/// so the snapshot is stable across runs.
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
enum EmittedEvent {
    Update {
        messages: Vec<MessageFingerprint>,
    },
    StreamingPartial {
        message: MessageFingerprint,
    },
    PermissionRequest {
        permission_id: String,
        tool_name: String,
    },
    UserInputRequest {
        user_input_id: String,
        source: String,
        permission_mode: Option<String>,
        payload_kind: String,
    },
    PlanCaptured,
    Done {
        persisted: bool,
    },
    Aborted {
        persisted: bool,
        reason: String,
    },
    Error {
        message: String,
        persisted: bool,
        internal: bool,
    },
}

#[derive(Debug, Serialize)]
struct MessageFingerprint {
    role: String,
    part_types: Vec<String>,
    streaming: Option<bool>,
}

fn fingerprint_message(msg: &ThreadMessageLike) -> MessageFingerprint {
    let part_types = msg
        .content
        .iter()
        .map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::Text { .. }) => "text".into(),
            ExtendedMessagePart::Basic(MessagePart::Reasoning { .. }) => "reasoning".into(),
            ExtendedMessagePart::Basic(MessagePart::ToolCall { tool_name, .. }) => {
                format!("tool-call({tool_name})")
            }
            ExtendedMessagePart::Basic(MessagePart::SystemNotice { .. }) => "system-notice".into(),
            ExtendedMessagePart::Basic(MessagePart::PlanReview { .. }) => "plan-review".into(),
            ExtendedMessagePart::Basic(MessagePart::TodoList { .. }) => "todo-list".into(),
            ExtendedMessagePart::Basic(MessagePart::Image { .. }) => "image".into(),
            ExtendedMessagePart::Basic(MessagePart::FileMention { .. }) => "file-mention".into(),
            ExtendedMessagePart::Basic(MessagePart::PromptSuggestion { .. }) => {
                "prompt-suggestion".into()
            }
            ExtendedMessagePart::CollapsedGroup(g) => {
                format!("collapsed-group({:?},tools={})", g.category, g.tools.len())
            }
        })
        .collect();
    MessageFingerprint {
        role: format!("{:?}", msg.role).to_lowercase(),
        part_types,
        streaming: msg.streaming,
    }
}

fn convert_action(action: Action) -> Result<EmittedEvent, String> {
    match action {
        Action::EmitToFrontend(event) => Ok(match event {
            AgentStreamEvent::Update { messages } => EmittedEvent::Update {
                messages: messages.iter().map(fingerprint_message).collect(),
            },
            AgentStreamEvent::StreamingPartial { message } => EmittedEvent::StreamingPartial {
                message: fingerprint_message(&message),
            },
            AgentStreamEvent::PermissionRequest {
                permission_id,
                tool_name,
                ..
            } => EmittedEvent::PermissionRequest {
                permission_id,
                tool_name,
            },
            AgentStreamEvent::UserInputRequest {
                user_input_id,
                source,
                permission_mode,
                payload,
                ..
            } => EmittedEvent::UserInputRequest {
                user_input_id,
                source,
                permission_mode,
                payload_kind: payload
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            },
            AgentStreamEvent::PlanCaptured {} => EmittedEvent::PlanCaptured,
            AgentStreamEvent::Done { persisted, .. } => EmittedEvent::Done { persisted },
            AgentStreamEvent::Aborted {
                persisted, reason, ..
            } => EmittedEvent::Aborted { persisted, reason },
            AgentStreamEvent::Error {
                message,
                persisted,
                internal,
            } => EmittedEvent::Error {
                message,
                persisted,
                internal,
            },
        }),
        // Non-emit actions are surfaced as text labels so the snapshot
        // documents that they were generated, without binding the test
        // to their full payload (which is exercised in actions.rs).
        other => Err(format!("{other:?}")
            .split_whitespace()
            .next()
            .unwrap_or("unknown")
            .to_string()),
    }
}

fn make_ctx(provider: &str) -> TurnContext {
    TurnContext {
        provider: provider.into(),
        model_id: "model-id".into(),
        working_directory: "/tmp/helmor".into(),
        effort_level: None,
        permission_mode: None,
        fast_mode: false,
        helmor_session_id: Some("session-1".into()),
        resolved_session_id: None,
        resolved_model: "test-model".into(),
        persisted_turn_count: 0,
        persisted_exit_plan_review: None,
    }
}

/// Mirrors the dispatch shape in `stream_via_sidecar`'s receive loop,
/// minus DB writes, Tauri channel emit, and the `ActiveStreams`
/// registry. Returns one `DispatchEntry` per sidecar event so the
/// snapshot covers the per-event emission AND the cumulative ordering.
fn dispatch_events(provider: &str, events: Vec<Value>) -> Vec<DispatchEntry> {
    let mut pipeline: Option<MessagePipeline> =
        Some(MessagePipeline::new(provider, "test-model", "ctx", "sess"));
    let mut session = TurnSession::new(make_ctx(provider));
    let mut entries = Vec::new();

    for event in events {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let actions = dispatch_one(&event_type, &event, &mut session, &mut pipeline);

        let mut emitted = Vec::new();
        let mut side_effects = Vec::new();
        for action in actions {
            match convert_action(action) {
                Ok(ev) => emitted.push(ev),
                Err(label) => side_effects.push(label),
            }
        }

        entries.push(DispatchEntry {
            event_type,
            emitted,
            side_effects,
        });
    }

    entries
}

fn dispatch_one(
    event_type: &str,
    raw: &Value,
    session: &mut TurnSession,
    pipeline: &mut Option<MessagePipeline>,
) -> Vec<Action> {
    let result = match event_type {
        "permissionRequest" => session.handle_permission_request(raw),
        "permissionModeChanged" => session.handle_permission_mode_changed(raw),
        "userInputRequest" => {
            // Mirror mod.rs: keep the pipeline alive (`as_mut`, not `take`)
            // so post-pause events still accumulate into the same instance.
            let mut resolved_model = session.ctx.resolved_model.clone();
            let mut final_messages = Vec::new();
            if let Some(pipeline_state) = pipeline.as_mut() {
                pipeline_state.accumulator.flush_pending();
                resolved_model = pipeline_state.accumulator.resolved_model().to_string();
                final_messages = pipeline_state.finish();
            }
            session.handle_user_input_request(raw, &resolved_model, final_messages)
        }
        "contextUsageUpdated" => session.handle_context_usage_updated(raw),
        "planCaptured" => {
            // Mirror mod.rs: flush + finish + build plan_message, then
            // hand to the state machine. DB persistence skipped — we
            // pass empty id/created_at so the bridge synthesizes a
            // placeholder.
            if let Some(pipeline_state) = pipeline.as_mut() {
                pipeline_state.accumulator.flush_pending();
                let tool_use_id = raw
                    .get("toolUseId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let plan_value = raw.get("plan").cloned().unwrap_or(Value::Null);
                let tool_input = json!({"plan": plan_value});
                let plan_message = super::build_exit_plan_review_message(
                    None,
                    None,
                    &tool_use_id,
                    "ExitPlanMode",
                    &tool_input,
                );
                let final_messages = pipeline_state.finish();
                session.handle_plan_captured(plan_message, final_messages)
            } else {
                Ok(vec![])
            }
        }
        "error"
            if session.ctx.provider == "codex"
                && super::bridges::is_retryable_sidecar_error(raw) =>
        {
            if let Some(pipeline_state) = pipeline.as_mut() {
                let notice = super::bridges::retry_notice_event_from_error(raw);
                let raw_str = serde_json::to_string(&notice).unwrap_or_default();
                let emit = pipeline_state.push_event(&notice, &raw_str);
                session.handle_stream_event(emit)
            } else {
                Ok(vec![])
            }
        }
        "error" => {
            // Persistence success is fixed at `true` so the test focuses
            // on the dispatch + state transition rather than the DB
            // write outcome (cleanup.rs covers that).
            session.handle_error(raw, true)
        }
        "end" | "aborted" => {
            let is_aborted = event_type == "aborted";
            let reason = if is_aborted {
                Some(
                    raw.get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("user_requested")
                        .to_string(),
                )
            } else {
                None
            };
            let mut resolved_model = session.ctx.resolved_model.clone();
            let mut final_messages = Vec::new();
            if let Some(mut pipeline_state) = pipeline.take() {
                if is_aborted {
                    pipeline_state.accumulator.mark_pending_tools_aborted();
                }
                pipeline_state.accumulator.flush_pending();
                if is_aborted {
                    pipeline_state.accumulator.flush_codex_in_progress();
                    pipeline_state.materialize_partial();
                    pipeline_state.accumulator.append_aborted_notice();
                }
                let output = pipeline_state
                    .accumulator
                    .drain_output(session.ctx.resolved_session_id.as_deref());
                if !output.assistant_text.is_empty() {
                    resolved_model = output.resolved_model.clone();
                }
                final_messages = pipeline_state.finish();
            }
            session.handle_end_or_aborted(is_aborted, reason, &resolved_model, final_messages, true)
        }
        // Heartbeat is keepalive — the loop body skips it before reaching
        // the dispatch match. Mirror that here so a fixture with
        // heartbeat events doesn't accidentally appear as transitions.
        "heartbeat" => Ok(vec![]),
        // Default arm: stream_event main path.
        _ => {
            if let Some(pipeline_state) = pipeline.as_mut() {
                let raw_str = serde_json::to_string(raw).unwrap_or_default();
                if raw_str.is_empty() || raw_str == "{}" {
                    Ok(vec![])
                } else {
                    let emit = pipeline_state.push_event(raw, &raw_str);
                    session.handle_stream_event(emit)
                }
            } else {
                Ok(vec![])
            }
        }
    };

    result.unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

#[test]
fn codex_two_consecutive_readonly_commands_collapse_then_done() {
    // Happy path: 2 commandExecutions back-to-back (no commentary
    // between) → final Update should carry a collapsed-group, NOT
    // two separate tool-call rows.
    let entries = dispatch_events(
        "codex",
        vec![
            json!({"type": "turn/started", "session_id": "s1"}),
            json!({
                "type": "item/started",
                "item": {"type": "commandExecution", "id": "cmd_1", "command": "/bin/zsh -lc 'ls -la'", "status": "inProgress"},
                "session_id": "s1"
            }),
            json!({
                "type": "item/completed",
                "item": {"type": "commandExecution", "id": "cmd_1", "command": "/bin/zsh -lc 'ls -la'", "status": "completed", "exit_code": 0, "aggregated_output": "total 24"},
                "session_id": "s1"
            }),
            json!({
                "type": "item/started",
                "item": {"type": "commandExecution", "id": "cmd_2", "command": "/bin/zsh -lc 'cat README.md'", "status": "inProgress"},
                "session_id": "s1"
            }),
            json!({
                "type": "item/completed",
                "item": {"type": "commandExecution", "id": "cmd_2", "command": "/bin/zsh -lc 'cat README.md'", "status": "completed", "exit_code": 0, "aggregated_output": "# Project"},
                "session_id": "s1"
            }),
            json!({"type": "turn/completed", "session_id": "s1"}),
            json!({"type": "end"}),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn permission_request_mid_stream_does_not_break_pipeline() {
    // The model emits text, then asks permission to run a tool, then
    // continues with more text. Dispatch must keep the session in
    // Streaming and the partial render must keep growing.
    let entries = dispatch_events(
        "claude",
        vec![
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-1",
                "uuid": "sys-1"
            }),
            json!({
                "type": "assistant",
                "session_id": "provider-1",
                "uuid": "asst-1",
                "message": {"content": [{"type": "text", "text": "I need to run a command."}]}
            }),
            json!({
                "type": "permissionRequest",
                "permissionId": "perm-1",
                "toolName": "Bash",
                "toolInput": {"command": "ls"}
            }),
            json!({
                "type": "assistant",
                "session_id": "provider-1",
                "uuid": "asst-2",
                "message": {"content": [{"type": "text", "text": "Done."}]}
            }),
            json!({
                "type": "result",
                "session_id": "provider-1",
                "subtype": "success",
                "is_error": false,
                "result": "Done."
            }),
            json!({"type": "end"}),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn plan_captured_then_end_appends_plan_to_final_update() {
    // Cross-event interaction: planCaptured stashes the exit-plan row
    // in `ctx.persisted_exit_plan_review`; the terminal `end` arm must
    // append it to the final Update so the cache mirrors the
    // historical reload.
    let entries = dispatch_events(
        "claude",
        vec![
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-1",
                "uuid": "sys-1"
            }),
            json!({
                "type": "assistant",
                "session_id": "provider-1",
                "uuid": "asst-1",
                "message": {"content": [{"type": "text", "text": "Here is my plan."}]}
            }),
            json!({
                "type": "planCaptured",
                "toolUseId": "tool-1",
                "plan": "1. Read codebase\n2. Write tests"
            }),
            json!({"type": "end"}),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn aborted_emits_update_then_aborted_with_reason() {
    let entries = dispatch_events(
        "claude",
        vec![
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-1",
                "uuid": "sys-1"
            }),
            json!({
                "type": "assistant",
                "session_id": "provider-1",
                "uuid": "asst-1",
                "message": {"content": [{"type": "text", "text": "Working..."}]}
            }),
            json!({"type": "aborted", "reason": "user_requested"}),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn error_event_terminates_session_with_internal_flag() {
    let entries = dispatch_events(
        "claude",
        vec![
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-1",
                "uuid": "sys-1"
            }),
            json!({
                "type": "error",
                "message": "Sidecar lost connection",
                "internal": true
            }),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn structured_retryable_sidecar_error_does_not_terminate_session() {
    let entries = dispatch_events(
        "codex",
        vec![
            json!({"type": "turn/started", "session_id": "s1"}),
            json!({
                "type": "error",
                "message": "Reconnecting... 1/100",
                "willRetry": true
            }),
            json!({"type": "item/agentMessage/delta", "session_id": "s1", "delta": "Recovered"}),
            json!({"type": "turn/completed", "session_id": "s1"}),
            json!({"type": "end"}),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn codex_message_only_reconnect_error_then_end_preserves_error() {
    let entries = dispatch_events(
        "codex",
        vec![
            json!({"type": "turn/started", "session_id": "s1"}),
            json!({
                "type": "error",
                "message": "Reconnecting... 1/5"
            }),
            json!({"type": "end"}),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn codex_reconnecting_terminal_error_without_progress_terminates_session() {
    let entries = dispatch_events(
        "codex",
        vec![
            json!({"type": "turn/started", "session_id": "s1"}),
            json!({
                "type": "error",
                "message": "Reconnecting... exhausted retries"
            }),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn claude_reconnecting_error_terminates_session() {
    let entries = dispatch_events(
        "claude",
        vec![
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-1",
                "uuid": "sys-1"
            }),
            json!({
                "type": "error",
                "message": "Reconnecting... provider failed",
                "willRetry": true
            }),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn user_input_request_emits_panel_marker_without_terminating() {
    // Unified user-input pause (Claude AUQ flavor here): the sidecar's
    // live SDK callback is parked, the pipeline keeps accumulating, and
    // Rust just emits a snapshot Update + the UserInputRequest marker.
    // Subsequent stream events flow normally once the user submits.
    let entries = dispatch_events(
        "claude",
        vec![
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-1",
                "uuid": "sys-1"
            }),
            json!({
                "type": "assistant",
                "session_id": "provider-1",
                "uuid": "asst-1",
                "message": {"content": [{"type": "text", "text": "Let me ask you something."}]}
            }),
            json!({
                "type": "userInputRequest",
                "userInputId": "tool-1",
                "source": "Claude",
                "message": "Claude is asking for your input.",
                "payload": {
                    "kind": "ask-user-question",
                    "questions": [{"question": "Pick one", "options": []}]
                }
            }),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn permission_mode_changed_propagates_to_later_user_input_request() {
    // permissionModeChanged updates ctx.permission_mode; the
    // UserInputRequest emit later in the turn must reflect the new mode.
    let entries = dispatch_events(
        "claude",
        vec![
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-1",
                "uuid": "sys-1"
            }),
            json!({"type": "permissionModeChanged", "permissionMode": "plan"}),
            json!({
                "type": "userInputRequest",
                "userInputId": "tool-1",
                "source": "Claude",
                "message": "Claude is asking for your input.",
                "payload": {
                    "kind": "ask-user-question",
                    "questions": [{"question": "Pick", "options": []}]
                }
            }),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn late_event_after_terminal_is_rejected_without_emit() {
    // Once the session has transitioned to Terminated, any subsequent
    // event must NOT emit a duplicate AgentStreamEvent. The legacy
    // implementation silently dispatched late events; the state machine
    // returns Err(AlreadyTerminated) which the harness drops.
    let entries = dispatch_events(
        "claude",
        vec![
            json!({"type": "end"}),
            // These should all produce empty `emitted` lists.
            json!({
                "type": "permissionRequest",
                "permissionId": "p-late",
                "toolName": "Bash",
                "toolInput": {}
            }),
            json!({"type": "permissionModeChanged", "permissionMode": "plan"}),
            json!({"type": "error", "message": "stale", "internal": false}),
        ],
    );
    assert_yaml_snapshot!(entries);
}

#[test]
fn user_input_request_form_mode_passes_payload_through() {
    // Form-mode user input (MCP elicitation form, or Codex's
    // synthesized form schema). The sidecar shapes `payload.schema`;
    // Rust forwards the marker without inspecting the schema.
    let entries = dispatch_events(
        "claude",
        vec![
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-1",
                "uuid": "sys-1"
            }),
            json!({
                "type": "userInputRequest",
                "userInputId": "elic-1",
                "source": "design-server",
                "message": "Need input",
                "payload": {
                    "kind": "form",
                    "schema": { "type": "object", "properties": {} }
                }
            }),
            json!({"type": "end"}),
        ],
    );
    assert_yaml_snapshot!(entries);
}
