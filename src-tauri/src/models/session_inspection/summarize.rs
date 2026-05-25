use serde_json::Value;

use crate::pipeline::types::HistoricalRecord;

/// Collapse a stored `session_messages.content` row into a single
/// human-readable string for CLI/MCP read tools.
pub(super) fn summarize_historical_record(record: &HistoricalRecord) -> String {
    let Some(parsed) = &record.parsed_content else {
        return record.content.clone();
    };
    let Some(msg_type) = parsed.get("type").and_then(Value::as_str) else {
        return record.content.clone();
    };
    match msg_type {
        "user_prompt" | "user" => parsed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("(empty user message)")
            .to_string(),
        "assistant" => summarize_assistant_blocks(parsed),
        "system" => parsed
            .get("subtype")
            .and_then(Value::as_str)
            .map(|s| format!("[system: {s}]"))
            .unwrap_or_else(|| "[system event]".to_owned()),
        "error" => parsed
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| parsed.get("error").and_then(Value::as_str))
            .unwrap_or("[error]")
            .to_string(),
        "result" => parsed
            .get("result")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| "[result]".to_owned()),
        "item.completed" | "turn.completed" => format!("[{msg_type}]"),
        other => format!("[{other}]"),
    }
}

fn summarize_assistant_blocks(parsed: &Value) -> String {
    let Some(blocks) = parsed.pointer("/message/content").and_then(Value::as_array) else {
        return "[assistant: no content]".to_owned();
    };
    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                }
            }
            Some("thinking") => {
                if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                    parts.push(format!("[thinking] {text}"));
                }
            }
            Some("tool_use") => {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("?");
                parts.push(format!("[used tool: {name}]"));
            }
            Some(other) => parts.push(format!("[block: {other}]")),
            None => {}
        }
    }
    if parts.is_empty() {
        "[assistant: empty content]".to_owned()
    } else {
        parts.join("\n\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::types::MessageRole;
    use serde_json::json;

    fn record(content: Value, role: MessageRole) -> HistoricalRecord {
        HistoricalRecord {
            id: "test-id".to_string(),
            role,
            content: content.to_string(),
            parsed_content: Some(content),
            created_at: "2026-05-25T00:00:00Z".to_string(),
        }
    }

    fn record_with_raw_content(raw: &str, role: MessageRole) -> HistoricalRecord {
        HistoricalRecord {
            id: "test-id".to_string(),
            role,
            content: raw.to_string(),
            parsed_content: serde_json::from_str(raw).ok(),
            created_at: "2026-05-25T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn summarizes_user_prompt_to_text_field() {
        let r = record(
            json!({ "type": "user_prompt", "text": "hello world" }),
            MessageRole::User,
        );
        assert_eq!(summarize_historical_record(&r), "hello world");
    }

    #[test]
    fn summarizes_user_to_text_field() {
        let r = record(
            json!({ "type": "user", "text": "from claude" }),
            MessageRole::User,
        );
        assert_eq!(summarize_historical_record(&r), "from claude");
    }

    #[test]
    fn summarizes_user_with_no_text_uses_placeholder() {
        let r = record(json!({ "type": "user_prompt" }), MessageRole::User);
        assert_eq!(summarize_historical_record(&r), "(empty user message)");
    }

    #[test]
    fn summarizes_system_event_with_subtype() {
        let r = record(
            json!({ "type": "system", "subtype": "init" }),
            MessageRole::System,
        );
        assert_eq!(summarize_historical_record(&r), "[system: init]");
    }

    #[test]
    fn summarizes_system_event_without_subtype_uses_placeholder() {
        let r = record(json!({ "type": "system" }), MessageRole::System);
        assert_eq!(summarize_historical_record(&r), "[system event]");
    }

    #[test]
    fn summarizes_error_with_message_field() {
        let r = record(
            json!({ "type": "error", "message": "boom" }),
            MessageRole::System,
        );
        assert_eq!(summarize_historical_record(&r), "boom");
    }

    #[test]
    fn summarizes_error_falls_back_to_error_field() {
        let r = record(
            json!({ "type": "error", "error": "bad" }),
            MessageRole::System,
        );
        assert_eq!(summarize_historical_record(&r), "bad");
    }

    #[test]
    fn summarizes_error_with_no_text_uses_placeholder() {
        let r = record(json!({ "type": "error" }), MessageRole::System);
        assert_eq!(summarize_historical_record(&r), "[error]");
    }

    #[test]
    fn summarizes_result_with_string_field() {
        let r = record(
            json!({ "type": "result", "result": "ok" }),
            MessageRole::System,
        );
        assert_eq!(summarize_historical_record(&r), "ok");
    }

    #[test]
    fn summarizes_result_without_field_uses_placeholder() {
        let r = record(json!({ "type": "result" }), MessageRole::System);
        assert_eq!(summarize_historical_record(&r), "[result]");
    }

    #[test]
    fn summarizes_lifecycle_events_to_bracketed_type() {
        for (msg_type, expected) in [
            ("item.completed", "[item.completed]"),
            ("turn.completed", "[turn.completed]"),
        ] {
            let r = record(json!({ "type": msg_type }), MessageRole::System);
            assert_eq!(summarize_historical_record(&r), expected);
        }
    }

    #[test]
    fn summarizes_unknown_type_to_bracketed_label() {
        let r = record(json!({ "type": "some.future.event" }), MessageRole::System);
        assert_eq!(summarize_historical_record(&r), "[some.future.event]");
    }

    #[test]
    fn summarizes_unparseable_content_returns_raw() {
        let r = record_with_raw_content("not json at all", MessageRole::User);
        assert_eq!(summarize_historical_record(&r), "not json at all");
    }

    #[test]
    fn summarizes_parsed_without_type_returns_raw() {
        let r = record(json!({ "text": "lonely" }), MessageRole::User);
        assert_eq!(summarize_historical_record(&r), "{\"text\":\"lonely\"}");
    }

    fn assistant_blocks(blocks: Value) -> Value {
        json!({ "message": { "content": blocks } })
    }

    #[test]
    fn assistant_text_blocks_flatten_to_their_text() {
        let parsed = assistant_blocks(json!([
            { "type": "text", "text": "first" },
            { "type": "text", "text": "second" },
        ]));
        assert_eq!(summarize_assistant_blocks(&parsed), "first\n\nsecond");
    }

    #[test]
    fn assistant_thinking_block_is_prefixed() {
        let parsed = assistant_blocks(json!([
            { "type": "thinking", "thinking": "let me work it out" },
        ]));
        assert_eq!(
            summarize_assistant_blocks(&parsed),
            "[thinking] let me work it out"
        );
    }

    #[test]
    fn assistant_tool_use_renders_name() {
        let parsed = assistant_blocks(json!([
            { "type": "tool_use", "name": "Read" },
        ]));
        assert_eq!(summarize_assistant_blocks(&parsed), "[used tool: Read]");
    }

    #[test]
    fn assistant_tool_use_without_name_uses_placeholder() {
        let parsed = assistant_blocks(json!([{ "type": "tool_use" }]));
        assert_eq!(summarize_assistant_blocks(&parsed), "[used tool: ?]");
    }

    #[test]
    fn assistant_unknown_block_kind_is_labeled() {
        let parsed = assistant_blocks(json!([
            { "type": "redacted_thinking", "data": "<sealed>" },
        ]));
        assert_eq!(
            summarize_assistant_blocks(&parsed),
            "[block: redacted_thinking]"
        );
    }

    #[test]
    fn assistant_mixed_blocks_join_with_blank_line() {
        let parsed = assistant_blocks(json!([
            { "type": "text", "text": "answer:" },
            { "type": "tool_use", "name": "Edit" },
        ]));
        assert_eq!(
            summarize_assistant_blocks(&parsed),
            "answer:\n\n[used tool: Edit]"
        );
    }

    #[test]
    fn assistant_empty_content_array_returns_placeholder() {
        let parsed = assistant_blocks(json!([]));
        assert_eq!(
            summarize_assistant_blocks(&parsed),
            "[assistant: empty content]"
        );
    }

    #[test]
    fn assistant_missing_content_path_returns_placeholder() {
        let parsed = json!({ "message": {} });
        assert_eq!(
            summarize_assistant_blocks(&parsed),
            "[assistant: no content]"
        );
    }

    #[test]
    fn summarize_historical_record_routes_assistant_to_block_flattener() {
        let r = record(
            json!({
                "type": "assistant",
                "message": { "content": [{ "type": "text", "text": "ack" }] },
            }),
            MessageRole::Assistant,
        );
        assert_eq!(summarize_historical_record(&r), "ack");
    }
}
