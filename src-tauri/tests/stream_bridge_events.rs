//! Integration coverage for the per-event bridge functions in
//! `agents::streaming`. Mirrors `stream_bridge_elicitation.rs` but exercises
//! the rest of the bridges — permission, deferred-tool-use, user-input,
//! error, done, aborted — alongside a live `MessagePipeline` so we capture
//! the wire shape the frontend sees during a real turn.
//!
//! These snapshots lock the AgentStreamEvent contract before the
//! state-machine refactor in `agents::streaming` proper. Once the
//! refactor lands, the state machine's `Action::EmitToFrontend` carries
//! exactly these values; any drift here surfaces as a snapshot diff.

mod common;

use common::*;
use helmor_lib::agents::{
    bridge_aborted_event, bridge_done_event, bridge_error_event, bridge_permission_request_event,
    bridge_user_input_request_event, AgentStreamEvent,
};
use helmor_lib::pipeline::PipelineEmit;
use insta::assert_yaml_snapshot;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Serialize)]
struct StreamBridgeSnapshot {
    line_count: usize,
    control_events: Vec<Value>,
    final_messages: Vec<NormThreadMessage>,
    dropped_event_types: Vec<String>,
}

fn serialize_event(event: AgentStreamEvent) -> Value {
    serde_json::to_value(event).expect("agent stream event should serialize")
}

/// Drive a sequence of events through the pipeline. Bridge-only events
/// (permission/deferred/userInput/error/aborted/done) are converted via the
/// matching bridge fn and recorded in `control_events`; the rest go to the
/// pipeline. Mirrors the dispatch order in `agents::streaming`'s match arm
/// so the snapshot reflects what the frontend actually receives.
fn replay_stream(provider: &str, lines: &[Value]) -> StreamBridgeSnapshot {
    let mut pipeline = MessagePipeline::new(provider, "test-model", "ctx", "sess");
    let mut latest_messages: Vec<ThreadMessageLike> = Vec::new();
    let mut control_events = Vec::new();

    let resolved_session_id = || Some("provider-session-1".to_string());
    let working_directory = "/tmp/helmor";

    for value in lines {
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "permissionRequest" => {
                control_events.push(serialize_event(bridge_permission_request_event(value)));
                continue;
            }
            "userInputRequest" => {
                let resolved_model = pipeline.accumulator.resolved_model().to_string();
                control_events.push(serialize_event(bridge_user_input_request_event(
                    provider,
                    "model-id",
                    &resolved_model,
                    resolved_session_id(),
                    working_directory,
                    Some("default".to_string()),
                    value,
                )));
                continue;
            }
            "error" => {
                // In production the call site decides `persisted` based on
                // whether `persist_error_message` succeeded. For the bridge
                // contract we just snapshot both branches.
                control_events.push(serialize_event(bridge_error_event(value, true)));
                continue;
            }
            "aborted" => {
                let resolved_model = pipeline.accumulator.resolved_model().to_string();
                let reason = value
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("user_requested")
                    .to_string();
                control_events.push(serialize_event(bridge_aborted_event(
                    provider,
                    "model-id",
                    &resolved_model,
                    resolved_session_id(),
                    working_directory,
                    true,
                    reason,
                )));
                continue;
            }
            "end" => {
                let resolved_model = pipeline.accumulator.resolved_model().to_string();
                control_events.push(serialize_event(bridge_done_event(
                    provider,
                    "model-id",
                    &resolved_model,
                    resolved_session_id(),
                    working_directory,
                    true,
                )));
                continue;
            }
            _ => {}
        }

        let line = serde_json::to_string(value).expect("fixture line should serialize");
        match pipeline.push_event(value, &line) {
            PipelineEmit::Full(messages) => {
                latest_messages = messages;
            }
            PipelineEmit::Partial(message) => {
                latest_messages.push(message);
            }
            PipelineEmit::None => {}
        }
    }

    let final_messages = pipeline.finish();
    let dropped_event_types = pipeline.accumulator.dropped_event_types().to_vec();

    StreamBridgeSnapshot {
        line_count: lines.len(),
        control_events,
        final_messages: normalize_all(if final_messages.is_empty() {
            &latest_messages
        } else {
            &final_messages
        }),
        dropped_event_types,
    }
}

#[test]
fn permission_request_emits_alongside_assistant_text() {
    let snapshot = replay_stream(
        "claude",
        &[
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-session-1",
                "uuid": "system-1"
            }),
            json!({
                "type": "assistant",
                "session_id": "provider-session-1",
                "uuid": "assistant-1",
                "message": {
                    "content": [
                        { "type": "text", "text": "I'll need to run a command." }
                    ]
                }
            }),
            json!({
                "type": "permissionRequest",
                "permissionId": "permission-1",
                "toolName": "Bash",
                "toolInput": { "command": "ls" },
                "title": "Run shell command",
                "description": "Lists the current directory"
            }),
            json!({
                "type": "result",
                "session_id": "provider-session-1",
                "subtype": "success",
                "is_error": false,
                "result": "done"
            }),
        ],
    );

    assert_yaml_snapshot!(snapshot);
    assert!(snapshot.dropped_event_types.is_empty());
}

#[test]
fn ask_user_question_user_input_pauses_stream_with_pending_state() {
    // Claude emits a unified `userInputRequest` for AskUserQuestion via
    // its `canUseTool` callback. The turn pauses; the frontend renders
    // the user-input overlay (AUQ flavor) and resumes via
    // `respondToUserInput`. The pause is expressed by emitting the
    // bridge event; the pipeline state up to that point is the snapshot
    // the frontend caches behind the panel.
    let snapshot = replay_stream(
        "claude",
        &[
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-session-1",
                "uuid": "system-1"
            }),
            json!({
                "type": "assistant",
                "session_id": "provider-session-1",
                "uuid": "assistant-1",
                "message": {
                    "content": [
                        { "type": "text", "text": "Let me ask you a question." }
                    ]
                }
            }),
            json!({
                "type": "userInputRequest",
                "userInputId": "tool-1",
                "source": "Claude",
                "message": "Claude is asking for your input.",
                "payload": {
                    "kind": "ask-user-question",
                    "questions": [{ "question": "Pick one", "options": [] }]
                }
            }),
        ],
    );

    assert_yaml_snapshot!(snapshot);
    assert!(snapshot.dropped_event_types.is_empty());
}

#[test]
fn codex_user_input_passes_form_payload_through() {
    // Codex's `requestUserInput` is now synthesized into a JSON-Schema
    // form on the SIDECAR side; Rust just forwards the unified
    // `userInputRequest` with `payload.kind = form`.
    let snapshot = replay_stream(
        "codex",
        &[json!({
            "type": "userInputRequest",
            "userInputId": "user-input-1",
            "source": "Codex",
            "message": "Codex needs your input.",
            "payload": {
                "kind": "form",
                "schema": {
                    "type": "object",
                    "properties": {
                        "approval": {
                            "type": "string",
                            "title": "Approval",
                            "description": "Approve plan?",
                            "oneOf": [
                                { "const": "Yes", "title": "Yes", "description": "Proceed" },
                                { "const": "No", "title": "No", "description": "Stop" }
                            ]
                        }
                    },
                    "required": ["approval"]
                }
            }
        })],
    );

    assert_yaml_snapshot!(snapshot);
    assert!(snapshot.dropped_event_types.is_empty());
}

#[test]
fn error_event_emits_with_internal_flag() {
    let snapshot = replay_stream(
        "claude",
        &[json!({
            "type": "error",
            "message": "Sidecar lost connection",
            "internal": true
        })],
    );

    assert_yaml_snapshot!(snapshot);
    assert!(snapshot.dropped_event_types.is_empty());
}

#[test]
fn aborted_event_carries_user_requested_reason() {
    let snapshot = replay_stream(
        "claude",
        &[
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-session-1",
                "uuid": "system-1"
            }),
            json!({
                "type": "assistant",
                "session_id": "provider-session-1",
                "uuid": "assistant-1",
                "message": {
                    "content": [
                        { "type": "text", "text": "Working on it..." }
                    ]
                }
            }),
            json!({
                "type": "aborted",
                "reason": "user_requested"
            }),
        ],
    );

    assert_yaml_snapshot!(snapshot);
    assert!(snapshot.dropped_event_types.is_empty());
}

#[test]
fn done_event_finalizes_full_turn() {
    let snapshot = replay_stream(
        "claude",
        &[
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "provider-session-1",
                "uuid": "system-1"
            }),
            json!({
                "type": "assistant",
                "session_id": "provider-session-1",
                "uuid": "assistant-1",
                "message": {
                    "content": [
                        { "type": "text", "text": "Here's the answer." }
                    ]
                }
            }),
            json!({
                "type": "result",
                "session_id": "provider-session-1",
                "subtype": "success",
                "is_error": false,
                "result": "Here's the answer."
            }),
            json!({ "type": "end" }),
        ],
    );

    assert_yaml_snapshot!(snapshot);
    assert!(snapshot.dropped_event_types.is_empty());
}
