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

/// Pure constructor for `AgentStreamEvent::UserInputRequest` from the raw
/// sidecar `userInputRequest` event payload plus the streaming context.
/// The sidecar already produced the kind-specific `payload` (AUQ raw
/// questions, MCP / Codex synthesized JSON Schema, or URL launcher), so
/// Rust just plumbs it through unchanged.
pub fn bridge_user_input_request_event(
    provider: &str,
    model_id: &str,
    resolved_model: &str,
    session_id: Option<String>,
    working_directory: &str,
    permission_mode: Option<String>,
    raw: &Value,
) -> AgentStreamEvent {
    AgentStreamEvent::UserInputRequest {
        provider: provider.to_string(),
        model_id: model_id.to_string(),
        resolved_model: resolved_model.to_string(),
        session_id,
        working_directory: working_directory.to_string(),
        permission_mode,
        user_input_id: raw
            .get("userInputId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        source: raw
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        message: raw
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        payload: raw
            .get("payload")
            .cloned()
            .unwrap_or(Value::Object(Default::default())),
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
    fn build_user_input_request_event_passes_payload_through() {
        // The sidecar pre-shapes the kind-specific `payload` (raw AUQ
        // questions / synthesized form schema / URL launcher); Rust just
        // plumbs it through verbatim.
        let event = bridge_user_input_request_event(
            "claude",
            "opus-1m",
            "claude-opus-4-20250514",
            Some("provider-session-1".to_string()),
            "/tmp/helmor",
            Some("default".to_string()),
            &serde_json::json!({
                "userInputId": "tool-1",
                "source": "Claude",
                "message": "Claude is asking for your input.",
                "payload": {
                    "kind": "ask-user-question",
                    "questions": [{ "question": "Pick one", "options": [] }],
                },
            }),
        );

        assert_yaml_snapshot!(
            serde_json::to_value(&event).unwrap(),
            @r#"
        kind: userInputRequest
        message: Claude is asking for your input.
        model_id: opus-1m
        payload:
          kind: ask-user-question
          questions:
            - options: []
              question: Pick one
        permission_mode: default
        provider: claude
        resolved_model: claude-opus-4-20250514
        session_id: provider-session-1
        source: Claude
        userInputId: tool-1
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
}
