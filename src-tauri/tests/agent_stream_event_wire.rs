//! Wire-format pin for `AgentStreamEvent`.
//!
//! This is the contract the frontend (`use-streaming.ts`) listens to over
//! the Tauri Channel. Every variant of `AgentStreamEvent` is enumerated
//! here and snapshotted in its JSON-serialized form. The state-machine
//! refactor in `agents::streaming` must not change this surface — any
//! drift here is a frontend-breaking change.
//!
//! When intentionally evolving the wire format, the snapshot diff goes
//! through `cargo insta review` and the matching frontend type in
//! `src/lib/api.ts` must be updated in the same PR.

use helmor_lib::agents::AgentStreamEvent;
use helmor_lib::pipeline::types::ThreadMessageLike;
use insta::assert_yaml_snapshot;
use serde_json::{json, Value};

fn to_value(event: AgentStreamEvent) -> Value {
    serde_json::to_value(event).expect("AgentStreamEvent serializes")
}

fn empty_message() -> ThreadMessageLike {
    serde_json::from_value(json!({
        "id": "msg-1",
        "role": "assistant",
        "content": []
    }))
    .expect("trivial ThreadMessageLike parses")
}

#[test]
fn wire_format_update() {
    assert_yaml_snapshot!(to_value(AgentStreamEvent::Update {
        messages: vec![empty_message()],
    }));
}

#[test]
fn wire_format_streaming_partial() {
    assert_yaml_snapshot!(to_value(AgentStreamEvent::StreamingPartial {
        message: empty_message(),
    }));
}

#[test]
fn wire_format_done() {
    assert_yaml_snapshot!(to_value(AgentStreamEvent::Done {
        provider: "claude".into(),
        model_id: "opus-1m".into(),
        resolved_model: "claude-opus-4-20250514".into(),
        session_id: Some("provider-session-1".into()),
        working_directory: "/tmp/helmor".into(),
        persisted: true,
    }));
}

#[test]
fn wire_format_aborted() {
    assert_yaml_snapshot!(to_value(AgentStreamEvent::Aborted {
        provider: "claude".into(),
        model_id: "opus-1m".into(),
        resolved_model: "claude-opus-4-20250514".into(),
        session_id: Some("provider-session-1".into()),
        working_directory: "/tmp/helmor".into(),
        persisted: true,
        reason: "user_requested".into(),
    }));
}

#[test]
fn wire_format_permission_request() {
    assert_yaml_snapshot!(to_value(AgentStreamEvent::PermissionRequest {
        permission_id: "permission-1".into(),
        tool_name: "Bash".into(),
        tool_input: json!({ "command": "ls" }),
        title: Some("Run shell command".into()),
        description: Some("Lists the directory".into()),
    }));
}

#[test]
fn wire_format_user_input_request_ask_user_question() {
    assert_yaml_snapshot!(to_value(AgentStreamEvent::UserInputRequest {
        provider: "claude".into(),
        model_id: "opus-1m".into(),
        resolved_model: "claude-opus-4-20250514".into(),
        session_id: Some("provider-session-1".into()),
        working_directory: "/tmp/helmor".into(),
        permission_mode: Some("default".into()),
        user_input_id: "tool-1".into(),
        source: "Claude".into(),
        message: "Claude is asking for your input.".into(),
        payload: json!({
            "kind": "ask-user-question",
            "questions": [{ "question": "Pick one", "options": [] }],
        }),
    }));
}

#[test]
fn wire_format_user_input_request_form() {
    assert_yaml_snapshot!(to_value(AgentStreamEvent::UserInputRequest {
        provider: "claude".into(),
        model_id: "opus-1m".into(),
        resolved_model: "claude-opus-4-20250514".into(),
        session_id: Some("provider-session-1".into()),
        working_directory: "/tmp/helmor".into(),
        permission_mode: None,
        user_input_id: "elicitation-1".into(),
        source: "design-server".into(),
        message: "Need structured input".into(),
        payload: json!({
            "kind": "form",
            "schema": {
                "type": "object",
                "properties": { "name": { "type": "string" } },
                "required": ["name"]
            },
        }),
    }));
}

#[test]
fn wire_format_user_input_request_url() {
    assert_yaml_snapshot!(to_value(AgentStreamEvent::UserInputRequest {
        provider: "claude".into(),
        model_id: "opus-1m".into(),
        resolved_model: "claude-opus-4-20250514".into(),
        session_id: Some("provider-session-1".into()),
        working_directory: "/tmp/helmor".into(),
        permission_mode: None,
        user_input_id: "elicitation-2".into(),
        source: "auth-server".into(),
        message: "Finish auth".into(),
        payload: json!({
            "kind": "url",
            "url": "https://example.com/authorize",
        }),
    }));
}

#[test]
fn wire_format_plan_captured() {
    assert_yaml_snapshot!(to_value(AgentStreamEvent::PlanCaptured {}));
}

#[test]
fn wire_format_error() {
    assert_yaml_snapshot!(to_value(AgentStreamEvent::Error {
        message: "Sidecar crashed".into(),
        persisted: false,
        internal: true,
    }));
}
