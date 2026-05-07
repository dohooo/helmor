//! Bridge replay test: form / URL user-input requests ride alongside the
//! pipeline message stream without polluting it (no dropped events, no
//! cross-talk into the assistant turn timeline).

mod common;

use common::*;
use helmor_lib::agents::{bridge_user_input_request_event, AgentStreamEvent};
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

fn replay_stream(lines: &[Value]) -> StreamBridgeSnapshot {
    let mut pipeline = MessagePipeline::new("claude", "test-model", "ctx", "sess");
    let mut latest_messages: Vec<ThreadMessageLike> = Vec::new();
    let mut control_events = Vec::new();

    for value in lines {
        if value.get("type").and_then(Value::as_str) == Some("userInputRequest") {
            control_events.push(serialize_event(bridge_user_input_request_event(
                "claude",
                "opus-1m",
                "claude-opus-4-20250514",
                Some("provider-session-1".to_string()),
                "/tmp/helmor",
                None,
                value,
            )));
            continue;
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
fn form_user_input_replays_alongside_message_stream() {
    let snapshot = replay_stream(&[
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
                    { "type": "text", "text": "Before user input." }
                ]
            }
        }),
        json!({
            "type": "userInputRequest",
            "userInputId": "user-input-form-1",
            "source": "design-server",
            "message": "Need structured input",
            "payload": {
                "kind": "form",
                "schema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "title": "Project name" },
                        "approved": { "type": "boolean", "title": "Approved" }
                    },
                    "required": ["name", "approved"]
                }
            }
        }),
        json!({
            "type": "assistant",
            "session_id": "provider-session-1",
            "uuid": "assistant-2",
            "message": {
                "content": [
                    { "type": "text", "text": "After user input." }
                ]
            }
        }),
        json!({
            "type": "result",
            "session_id": "provider-session-1",
            "subtype": "success",
            "is_error": false,
            "result": "done"
        }),
    ]);

    assert_yaml_snapshot!(snapshot);

    assert!(snapshot.dropped_event_types.is_empty());
}

#[test]
fn url_user_input_replays_without_polluting_pipeline() {
    let snapshot = replay_stream(&[
        json!({
            "type": "assistant",
            "session_id": "provider-session-1",
            "uuid": "assistant-url-1",
            "message": {
                "content": [
                    { "type": "text", "text": "Open the sign-in page." }
                ]
            }
        }),
        json!({
            "type": "userInputRequest",
            "userInputId": "user-input-url-1",
            "source": "auth-server",
            "message": "Finish sign-in in the browser.",
            "payload": {
                "kind": "url",
                "url": "https://example.com/authorize"
            }
        }),
        json!({
            "type": "result",
            "session_id": "provider-session-1",
            "subtype": "success",
            "is_error": false,
            "result": "done"
        }),
    ]);

    assert_yaml_snapshot!(snapshot);

    assert!(snapshot.dropped_event_types.is_empty());
}
