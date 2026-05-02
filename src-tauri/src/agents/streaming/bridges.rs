//! Pure constructors that translate raw sidecar event payloads into
//! `AgentStreamEvent`s for the frontend. The state machine in
//! `streaming/event_loop.rs` calls these inside an `Action::EmitToFrontend`
//! transition; the sidecar JSON shape is locked here so the wire contract
//! lives in one place.
//!
//! Every function here is pure (no DB, no IO) so it can be unit-tested
//! against literal JSON snippets. Behavior changes show up in the inline
//! `assert_yaml_snapshot!` literals below and in the integration tests
//! under `src-tauri/tests/stream_bridge_events.rs`.
//!
//! These bridges replaced the inline `AgentStreamEvent::X { ... }` literals
//! that used to live in `streaming.rs`'s 1500-line match arm. Keep them
//! pure — anything that needs DB access or pipeline state belongs in the
//! state machine, not in a bridge.

use serde_json::{json, Value};

use crate::agents::AgentStreamEvent;

/// Pure constructor for `AgentStreamEvent::ElicitationRequest` from the
/// raw sidecar `elicitationRequest` event payload.
pub fn bridge_elicitation_request_event(
    provider: &str,
    model_id: &str,
    resolved_model: &str,
    session_id: Option<String>,
    working_directory: &str,
    raw: &Value,
) -> AgentStreamEvent {
    AgentStreamEvent::ElicitationRequest {
        provider: provider.to_string(),
        model_id: model_id.to_string(),
        resolved_model: resolved_model.to_string(),
        session_id,
        working_directory: working_directory.to_string(),
        elicitation_id: raw
            .get("elicitationId")
            .and_then(Value::as_str)
            .map(str::to_string),
        server_name: raw
            .get("serverName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        message: raw
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        mode: raw.get("mode").and_then(Value::as_str).map(str::to_string),
        url: raw.get("url").and_then(Value::as_str).map(str::to_string),
        requested_schema: raw.get("requestedSchema").cloned(),
    }
}

/// Pure constructor for `AgentStreamEvent::PermissionRequest` from the raw
/// sidecar `permissionRequest` event payload. Missing fields fall back to
/// empty strings / empty object so the wire shape stays deterministic.
pub fn bridge_permission_request_event(raw: &Value) -> AgentStreamEvent {
    AgentStreamEvent::PermissionRequest {
        permission_id: raw
            .get("permissionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        tool_name: raw
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        tool_input: raw
            .get("toolInput")
            .cloned()
            .unwrap_or(Value::Object(Default::default())),
        title: raw.get("title").and_then(Value::as_str).map(str::to_string),
        description: raw
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// Pure constructor for `AgentStreamEvent::DeferredToolUse` from the raw
/// sidecar `deferredToolUse` event payload plus the streaming context.
pub fn bridge_deferred_tool_use_event(
    provider: &str,
    model_id: &str,
    resolved_model: &str,
    session_id: Option<String>,
    working_directory: &str,
    permission_mode: Option<String>,
    raw: &Value,
) -> AgentStreamEvent {
    AgentStreamEvent::DeferredToolUse {
        provider: provider.to_string(),
        model_id: model_id.to_string(),
        resolved_model: resolved_model.to_string(),
        session_id,
        working_directory: working_directory.to_string(),
        permission_mode,
        tool_use_id: raw
            .get("toolUseId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        tool_name: raw
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        tool_input: raw
            .get("toolInput")
            .cloned()
            .unwrap_or(Value::Object(Default::default())),
    }
}

/// Pure constructor for the Codex `userInputRequest` flavored elicitation.
/// The Codex sidecar emits a `userInputRequest` with `questions[]`; we
/// synthesize a JSON Schema via `build_user_input_schema` so the frontend
/// can render it through the same ElicitationPanel as MCP form prompts.
pub fn bridge_user_input_request_event(
    provider: &str,
    model_id: &str,
    resolved_model: &str,
    session_id: Option<String>,
    working_directory: &str,
    raw: &Value,
) -> AgentStreamEvent {
    let user_input_id = raw
        .get("userInputId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let questions = raw
        .get("questions")
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    let schema = build_user_input_schema(&questions);
    AgentStreamEvent::ElicitationRequest {
        provider: provider.to_string(),
        model_id: model_id.to_string(),
        resolved_model: resolved_model.to_string(),
        session_id,
        working_directory: working_directory.to_string(),
        elicitation_id: Some(user_input_id),
        server_name: "Codex".to_string(),
        message: "Codex needs your input".to_string(),
        mode: Some("form".to_string()),
        url: None,
        requested_schema: Some(schema),
    }
}

/// True for sidecar `error` events that are explicitly marked as retry
/// progress notices rather than terminal failures. Newer sidecars suppress
/// Codex app-server `willRetry=true` notifications before they reach Rust, but
/// this guard keeps the stream alive if an older sidecar forwards the
/// structured notice as `type:error`.
pub(super) fn is_retryable_sidecar_error(raw: &Value) -> bool {
    for key in ["willRetry", "will_retry"] {
        if let Some(will_retry) = raw.get(key).and_then(Value::as_bool) {
            return will_retry;
        }
    }

    false
}

/// Build a non-terminal pipeline event for a structured retryable sidecar
/// error. This keeps older sidecars that forwarded Codex reconnect progress as
/// `type:error` with `willRetry=true` visible to the user without terminating
/// the stream.
pub(super) fn retry_notice_event_from_error(raw: &Value) -> Value {
    let message = raw
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Retrying provider request");
    let (attempt, max_retries) = reconnect_counts_from_message(message).unwrap_or((0, 0));

    json!({
        "type": "system",
        "subtype": "codex_reconnecting",
        "attempt": attempt,
        "max_retries": max_retries,
        "retry_delay_ms": 0,
        "error": message,
    })
}

fn reconnect_counts_from_message(message: &str) -> Option<(u64, u64)> {
    let message = message.trim_start();
    let suffix = message
        .strip_prefix("Reconnecting...")
        .or_else(|| message.strip_prefix("Reconnecting…"));
    reconnect_counts(suffix.unwrap_or(message).trim_start())
}

fn reconnect_counts(message: &str) -> Option<(u64, u64)> {
    let mut chars = message.chars().peekable();
    let attempt = consume_ascii_digits(&mut chars)?;
    while chars.peek().is_some_and(|c| c.is_ascii_whitespace()) {
        chars.next();
    }
    if chars.next() != Some('/') {
        return None;
    }
    while chars.peek().is_some_and(|c| c.is_ascii_whitespace()) {
        chars.next();
    }
    let max = consume_ascii_digits(&mut chars)?;
    Some((attempt, max))
}

fn consume_ascii_digits<I>(chars: &mut std::iter::Peekable<I>) -> Option<u64>
where
    I: Iterator<Item = char>,
{
    let mut value = String::new();
    while chars.peek().is_some_and(|c| c.is_ascii_digit()) {
        if let Some(ch) = chars.next() {
            value.push(ch);
        }
    }
    (!value.is_empty()).then(|| value.parse().unwrap_or(0))
}

/// Pure constructor for `AgentStreamEvent::Error`. Caller decides
/// `persisted` based on whether `persist_error_message` succeeded — the
/// raw event itself never carries that flag.
pub fn bridge_error_event(raw: &Value, persisted: bool) -> AgentStreamEvent {
    AgentStreamEvent::Error {
        message: raw
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Unknown sidecar error")
            .to_string(),
        persisted,
        internal: raw
            .get("internal")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// Pure constructor for `AgentStreamEvent::Done`. All fields come from the
/// streaming context — no raw event payload to extract from.
pub fn bridge_done_event(
    provider: &str,
    model_id: &str,
    resolved_model: &str,
    session_id: Option<String>,
    working_directory: &str,
    persisted: bool,
) -> AgentStreamEvent {
    AgentStreamEvent::Done {
        provider: provider.to_string(),
        model_id: model_id.to_string(),
        resolved_model: resolved_model.to_string(),
        session_id,
        working_directory: working_directory.to_string(),
        persisted,
    }
}

/// Pure constructor for `AgentStreamEvent::Aborted`. `reason` is extracted
/// upstream from the raw `aborted` event (or defaulted to
/// `"user_requested"`) so the bridge stays a thin wrapper.
pub fn bridge_aborted_event(
    provider: &str,
    model_id: &str,
    resolved_model: &str,
    session_id: Option<String>,
    working_directory: &str,
    persisted: bool,
    reason: String,
) -> AgentStreamEvent {
    AgentStreamEvent::Aborted {
        provider: provider.to_string(),
        model_id: model_id.to_string(),
        resolved_model: resolved_model.to_string(),
        session_id,
        working_directory: working_directory.to_string(),
        persisted,
        reason,
    }
}

/// Build a JSON Schema from Codex `requestUserInput` questions so the
/// frontend's ElicitationPanel can render them as form fields.
fn build_user_input_schema(questions: &Value) -> Value {
    let arr = match questions.as_array() {
        Some(a) => a,
        None => return Value::Null,
    };

    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();

    for (i, q) in arr.iter().enumerate() {
        let header = q.get("header").and_then(Value::as_str).unwrap_or("");
        let question_text = q
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or("Question");
        let is_other = q.get("isOther").and_then(Value::as_bool).unwrap_or(false);
        let options = q.get("options").and_then(Value::as_array);
        // Use question id as key so responses map back to Codex question ids
        let key = q
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("q{i}"));

        // header → title (tab label), question → description (subtitle)
        let title = if header.is_empty() {
            question_text
        } else {
            header
        };
        let description = if header.is_empty() { "" } else { question_text };

        let has_options = options.is_some_and(|o| !o.is_empty());

        let prop = if has_options {
            let opts = options.unwrap();
            let one_of: Vec<Value> = opts
                .iter()
                .map(|opt| {
                    let label = opt.get("label").and_then(Value::as_str).unwrap_or("");
                    let desc = opt.get("description").and_then(Value::as_str).unwrap_or("");
                    serde_json::json!({
                        "const": label,
                        "title": label,
                        "description": desc,
                    })
                })
                .collect();

            let mut p = serde_json::json!({
                "type": "string",
                "title": title,
                "description": description,
                "oneOf": one_of,
            });
            if is_other {
                p["x-allow-other"] = Value::Bool(true);
            }
            p
        } else if is_other {
            serde_json::json!({
                "type": "string",
                "title": title,
                "description": description,
            })
        } else {
            serde_json::json!({
                "type": "string",
                "title": title,
                "description": description,
                "oneOf": [
                    { "const": "yes", "title": "Yes" },
                    { "const": "no", "title": "No" },
                ],
            })
        };

        required.push(Value::String(key.clone()));
        properties.insert(key, prop);
    }

    serde_json::json!({
        "type": "object",
        "properties": properties,
        "required": required,
    })
}

/// Convert an ElicitationResponse content back to Codex answer format.
///
/// Codex expects: `{ "question_id": { "answers": ["value"] }, ... }`
/// Frontend sends: `{ "question_id": "value", ... }`
pub fn convert_elicitation_content_to_codex_answers(content: &Value) -> Value {
    let obj = match content.as_object() {
        Some(o) => o,
        None => return Value::Null,
    };
    let mut answers = serde_json::Map::new();
    for (key, value) in obj {
        let answer_str = value.as_str().unwrap_or("").to_string();
        answers.insert(key.clone(), serde_json::json!({ "answers": [answer_str] }));
    }
    Value::Object(answers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use insta::assert_yaml_snapshot;

    #[test]
    fn build_permission_request_event_maps_raw_sidecar_payload() {
        let event = bridge_permission_request_event(&serde_json::json!({
            "permissionId": "permission-1",
            "toolName": "Bash",
            "toolInput": { "command": "ls -la" },
            "title": "Run shell command",
            "description": "Reads directory listing"
        }));

        assert_yaml_snapshot!(
            serde_json::to_value(&event).unwrap(),
            @r#"
        description: Reads directory listing
        kind: permissionRequest
        permissionId: permission-1
        title: Run shell command
        toolInput:
          command: ls -la
        toolName: Bash
        "#
        );
    }

    #[test]
    fn build_permission_request_event_defaults_missing_fields() {
        // Sidecar may omit `title`/`description`/`toolInput`; bridge must
        // never panic and the wire shape must stay deterministic so the
        // frontend doesn't see "undefined" strings.
        let event = bridge_permission_request_event(&serde_json::json!({}));

        assert_yaml_snapshot!(
            serde_json::to_value(&event).unwrap(),
            @r#"
        description: ~
        kind: permissionRequest
        permissionId: ""
        title: ~
        toolInput: {}
        toolName: ""
        "#
        );
    }

    #[test]
    fn build_deferred_tool_use_event_maps_raw_sidecar_payload() {
        let event = bridge_deferred_tool_use_event(
            "claude",
            "opus-1m",
            "claude-opus-4-20250514",
            Some("provider-session-1".to_string()),
            "/tmp/helmor",
            Some("default".to_string()),
            &serde_json::json!({
                "toolUseId": "tool-1",
                "toolName": "AskUserQuestion",
                "toolInput": { "question": "Pick one" }
            }),
        );

        assert_yaml_snapshot!(
            serde_json::to_value(&event).unwrap(),
            @r#"
        kind: deferredToolUse
        model_id: opus-1m
        permission_mode: default
        provider: claude
        resolved_model: claude-opus-4-20250514
        session_id: provider-session-1
        toolInput:
          question: Pick one
        toolName: AskUserQuestion
        toolUseId: tool-1
        working_directory: /tmp/helmor
        "#
        );
    }

    #[test]
    fn build_user_input_request_event_synthesizes_form_schema() {
        // Codex `userInputRequest` is normalized into the same
        // ElicitationRequest shape as MCP elicitations so the frontend
        // renders both through the ElicitationPanel.
        let event = bridge_user_input_request_event(
            "codex",
            "gpt-5.4",
            "gpt-5.4",
            Some("provider-thread-1".to_string()),
            "/tmp/helmor",
            &serde_json::json!({
                "userInputId": "user-input-1",
                "questions": [
                    { "id": "approval", "question": "Approve?", "isOther": false }
                ]
            }),
        );

        assert_yaml_snapshot!(
            serde_json::to_value(&event).unwrap(),
            @r#"
        elicitationId: user-input-1
        kind: elicitationRequest
        message: Codex needs your input
        mode: form
        model_id: gpt-5.4
        provider: codex
        requestedSchema:
          properties:
            approval:
              description: ""
              oneOf:
                - const: "yes"
                  title: "Yes"
                - const: "no"
                  title: "No"
              title: Approve?
              type: string
          required:
            - approval
          type: object
        resolved_model: gpt-5.4
        serverName: Codex
        session_id: provider-thread-1
        url: ~
        working_directory: /tmp/helmor
        "#
        );
    }

    #[test]
    fn build_error_event_maps_message_and_internal_flag() {
        let event = bridge_error_event(
            &serde_json::json!({
                "message": "Sidecar crashed",
                "internal": true
            }),
            true,
        );

        assert_yaml_snapshot!(
            serde_json::to_value(&event).unwrap(),
            @r#"
        internal: true
        kind: error
        message: Sidecar crashed
        persisted: true
        "#
        );
    }

    #[test]
    fn build_error_event_falls_back_to_default_message() {
        // No `message` field → default to "Unknown sidecar error" so the
        // user always sees something. `internal` defaults to `false`.
        let event = bridge_error_event(&serde_json::json!({}), false);

        assert_yaml_snapshot!(
            serde_json::to_value(&event).unwrap(),
            @r#"
        internal: false
        kind: error
        message: Unknown sidecar error
        persisted: false
        "#
        );
    }

    #[test]
    fn build_done_event_carries_streaming_context() {
        let event = bridge_done_event(
            "claude",
            "opus-1m",
            "claude-opus-4-20250514",
            Some("provider-session-1".to_string()),
            "/tmp/helmor",
            true,
        );

        assert_yaml_snapshot!(
            serde_json::to_value(&event).unwrap(),
            @r#"
        kind: done
        model_id: opus-1m
        persisted: true
        provider: claude
        resolved_model: claude-opus-4-20250514
        session_id: provider-session-1
        working_directory: /tmp/helmor
        "#
        );
    }

    #[test]
    fn build_aborted_event_includes_reason() {
        let event = bridge_aborted_event(
            "claude",
            "opus-1m",
            "claude-opus-4-20250514",
            Some("provider-session-1".to_string()),
            "/tmp/helmor",
            true,
            "user_requested".to_string(),
        );

        assert_yaml_snapshot!(
            serde_json::to_value(&event).unwrap(),
            @r#"
        kind: aborted
        model_id: opus-1m
        persisted: true
        provider: claude
        reason: user_requested
        resolved_model: claude-opus-4-20250514
        session_id: provider-session-1
        working_directory: /tmp/helmor
        "#
        );
    }

    #[test]
    fn build_elicitation_request_event_maps_raw_sidecar_payload() {
        let event = bridge_elicitation_request_event(
            "claude",
            "opus-1m",
            "claude-opus-4-20250514",
            Some("provider-session-1".to_string()),
            "/tmp/helmor",
            &serde_json::json!({
                "elicitationId": "elicitation-1",
                "serverName": "design-server",
                "message": "Need structured input",
                "mode": "form",
                "url": null,
                "requestedSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" }
                    },
                    "required": ["name"]
                }
            }),
        );

        assert_yaml_snapshot!(
            serde_json::to_value(&event).unwrap(),
            @r#"
        elicitationId: elicitation-1
        kind: elicitationRequest
        message: Need structured input
        mode: form
        model_id: opus-1m
        provider: claude
        requestedSchema:
          properties:
            name:
              type: string
          required:
            - name
          type: object
        resolved_model: claude-opus-4-20250514
        serverName: design-server
        session_id: provider-session-1
        url: ~
        working_directory: /tmp/helmor
        "#
        );
    }

    #[test]
    fn user_input_schema_yes_no_question() {
        let questions = serde_json::json!([
            { "question": "Approve this plan?" }
        ]);
        let schema = build_user_input_schema(&questions);
        assert_eq!(schema["type"], "object");
        let q0 = &schema["properties"]["q0"];
        assert_eq!(q0["type"], "string");
        assert_eq!(q0["title"], "Approve this plan?");
        let options = q0["oneOf"].as_array().unwrap();
        assert_eq!(options.len(), 2);
        assert_eq!(options[0]["const"], "yes");
        assert_eq!(options[1]["const"], "no");
        assert_eq!(schema["required"][0], "q0");
    }

    #[test]
    fn user_input_schema_free_text_question() {
        let questions = serde_json::json!([
            { "question": "What changes?", "isOther": true }
        ]);
        let schema = build_user_input_schema(&questions);
        assert_eq!(schema["type"], "object");
        let q0 = &schema["properties"]["q0"];
        assert_eq!(q0["type"], "string");
        assert_eq!(q0["title"], "What changes?");
        assert!(q0.get("oneOf").is_none());
    }

    #[test]
    fn user_input_schema_mixed_questions() {
        let questions = serde_json::json!([
            { "question": "Continue?" },
            { "question": "Describe approach", "isOther": true },
        ]);
        let schema = build_user_input_schema(&questions);
        let props = &schema["properties"];
        assert!(props["q0"].get("oneOf").is_some());
        assert!(props["q1"].get("oneOf").is_none());
        assert_eq!(schema["required"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn user_input_schema_empty_returns_empty_object() {
        let schema = build_user_input_schema(&serde_json::json!([]));
        assert_eq!(schema["type"], "object");
        assert!(schema["properties"].as_object().unwrap().is_empty());
    }

    #[test]
    fn user_input_schema_non_array_returns_null() {
        assert_eq!(
            build_user_input_schema(&serde_json::json!("not array")),
            Value::Null
        );
    }

    #[test]
    fn convert_answers_maps_to_codex_format() {
        let content = serde_json::json!({
            "project_shape": "New project",
            "app_goal": "Validate requirements",
        });
        let answers = convert_elicitation_content_to_codex_answers(&content);
        let obj = answers.as_object().unwrap();
        assert_eq!(
            obj["project_shape"],
            serde_json::json!({ "answers": ["New project"] }),
        );
        assert_eq!(
            obj["app_goal"],
            serde_json::json!({ "answers": ["Validate requirements"] }),
        );
    }

    #[test]
    fn convert_answers_wraps_each_value() {
        let content = serde_json::json!({
            "q0": "a",
            "q1": "b",
        });
        let answers = convert_elicitation_content_to_codex_answers(&content);
        let obj = answers.as_object().unwrap();
        assert_eq!(obj.len(), 2);
        assert_eq!(obj["q0"]["answers"][0], "a");
        assert_eq!(obj["q1"]["answers"][0], "b");
    }

    #[test]
    fn convert_answers_null_input() {
        assert_eq!(
            convert_elicitation_content_to_codex_answers(&Value::Null),
            Value::Null,
        );
    }

    #[test]
    fn user_input_schema_with_options() {
        let questions = serde_json::json!([{
            "id": "project_shape",
            "header": "Project shape",
            "question": "Choose project type",
            "isOther": false,
            "options": [
                { "label": "New project", "description": "Start from scratch" },
                { "label": "Refactor", "description": "Based on existing code" },
            ]
        }]);
        let schema = build_user_input_schema(&questions);
        let field = &schema["properties"]["project_shape"];
        assert_eq!(field["title"], "Project shape");
        assert_eq!(field["description"], "Choose project type");
        let opts = field["oneOf"].as_array().unwrap();
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0]["const"], "New project");
        assert_eq!(opts[0]["description"], "Start from scratch");
        assert!(field.get("x-allow-other").is_none());
    }

    #[test]
    fn user_input_schema_options_with_is_other() {
        let questions = serde_json::json!([{
            "header": "Platform choice",
            "question": "First-launch platform?",
            "isOther": true,
            "options": [
                { "label": "H5", "description": "Fastest" },
            ]
        }]);
        let schema = build_user_input_schema(&questions);
        let q0 = &schema["properties"]["q0"];
        assert_eq!(q0["title"], "Platform choice");
        assert_eq!(q0["x-allow-other"], true);
        assert_eq!(q0["oneOf"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn user_input_schema_header_fallback() {
        let questions = serde_json::json!([
            { "question": "Simple question?" }
        ]);
        let schema = build_user_input_schema(&questions);
        let q0 = &schema["properties"]["q0"];
        assert_eq!(q0["title"], "Simple question?");
        assert_eq!(q0["description"], "");
    }
}
