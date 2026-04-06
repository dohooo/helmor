//! Message adaptation: IntermediateMessage → ThreadMessageLike.
//!
//! Ported from `message-adapter.ts`. Converts raw intermediate messages
//! (from the accumulator or historical records) into fully rendered
//! `ThreadMessageLike` values ready for the frontend.
//!
//! Pipeline steps (all in this file):
//! 1. `convert_flat` — per-message parsing with lookahead tool-result merging
//! 2. `group_child_messages` — detect child agent messages, inline or group
//! 3. `merge_adjacent_assistants` — fold consecutive assistant messages

use serde_json::Value;

use super::types::{
    ExtendedMessagePart, HistoricalRecord, IntermediateMessage, MessagePart, MessageRole,
    MessageStatus, StreamingStatus, ThreadMessageLike,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Convert intermediate messages into rendered thread messages.
pub fn convert(messages: &[IntermediateMessage]) -> Vec<ThreadMessageLike> {
    let flat = convert_flat(messages);
    let grouped = group_child_messages(flat);
    merge_adjacent_assistants(grouped)
}

/// Convert historical DB records into rendered thread messages.
pub fn convert_historical(records: &[HistoricalRecord]) -> Vec<ThreadMessageLike> {
    let intermediate: Vec<IntermediateMessage> = records
        .iter()
        .map(|r| IntermediateMessage {
            id: r.id.clone(),
            role: r.role.clone(),
            raw_json: r.content.clone(),
            parsed: if r.content_is_json {
                r.parsed_content.clone()
            } else {
                None
            },
            created_at: r.created_at.clone(),
            is_streaming: false,
        })
        .collect();
    convert(&intermediate)
}

// ---------------------------------------------------------------------------
// Flat conversion — per-message parsing
// ---------------------------------------------------------------------------

fn convert_flat(messages: &[IntermediateMessage]) -> Vec<ThreadMessageLike> {
    let mut result: Vec<ThreadMessageLike> = Vec::new();
    let mut i = 0;

    while i < messages.len() {
        let msg = &messages[i];
        let parsed = msg.parsed.as_ref();
        let msg_type = parsed.and_then(|p| p.get("type")).and_then(Value::as_str);

        // system — skip noise subtypes
        if msg_type == Some("system") {
            let sub = parsed
                .and_then(|p| p.get("subtype"))
                .and_then(Value::as_str);
            if matches!(
                sub,
                Some(
                    "init"
                        | "task_progress"
                        | "task_started"
                        | "task_completed"
                        | "task_notification"
                )
            ) {
                i += 1;
                continue;
            }
            result.push(make_system(msg, &build_system_label(parsed)));
            i += 1;
            continue;
        }

        // result (session summary)
        if msg_type == Some("result") {
            result.push(make_system(msg, &build_result_label(parsed)));
            i += 1;
            continue;
        }

        // error
        if msg_type == Some("error") || msg.role == "error" {
            result.push(make_system(msg, &build_error_label(msg, parsed)));
            i += 1;
            continue;
        }

        // assistant (by JSON type or by role for plain-text live messages)
        if msg_type == Some("assistant") || (parsed.is_none() && msg.role == "assistant") {
            let mut parts = parse_assistant_parts(parsed);
            let is_child = parsed
                .and_then(|p| p.get("parent_tool_use_id"))
                .and_then(Value::as_str)
                .is_some();

            // Look ahead: merge following user/tool_result messages
            while i + 1 < messages.len() {
                let next = &messages[i + 1];
                let np = next.parsed.as_ref();
                let next_type = np.and_then(|p| p.get("type")).and_then(Value::as_str);
                if next_type != Some("user") {
                    break;
                }
                if !merge_tool_results(np, &mut parts) {
                    break;
                }
                i += 1;
            }

            if parts.is_empty() {
                let fb = extract_fallback(msg);
                if !fb.is_empty() {
                    parts.push(MessagePart::Text { text: fb });
                }
            }

            let is_streaming = parsed
                .and_then(|p| p.get("__streaming"))
                .and_then(Value::as_bool)
                .unwrap_or(false);

            let id = if is_child {
                Some(format!("child:{}", msg.id))
            } else {
                Some(msg.id.clone())
            };

            result.push(ThreadMessageLike {
                role: MessageRole::Assistant,
                id,
                created_at: Some(msg.created_at.clone()),
                content: parts.into_iter().map(ExtendedMessagePart::Basic).collect(),
                status: Some(MessageStatus {
                    status_type: "complete".to_string(),
                    reason: Some("stop".to_string()),
                }),
                streaming: if is_streaming { Some(true) } else { None },
            });
            i += 1;
            continue;
        }

        // user — tool_result messages: merge into previous assistant or skip
        if msg_type == Some("user") {
            if let Some(prev) = result.last_mut() {
                if prev.role == MessageRole::Assistant {
                    // Extract basic parts for merging
                    let mut basic_parts: Vec<MessagePart> = prev
                        .content
                        .iter()
                        .filter_map(|p| {
                            if let ExtendedMessagePart::Basic(mp) = p {
                                Some(mp.clone())
                            } else {
                                None
                            }
                        })
                        .collect();
                    if merge_tool_results(parsed, &mut basic_parts) {
                        prev.content = basic_parts
                            .into_iter()
                            .map(ExtendedMessagePart::Basic)
                            .collect();
                    }
                }
            }
            // Never render user tool_result messages standalone
            if parsed.is_some() {
                i += 1;
                continue;
            }
            result.push(convert_user_message(msg, parsed));
            i += 1;
            continue;
        }

        // Codex: item.completed with agent_message
        if msg_type == Some("item.completed") {
            let item = parsed.and_then(|p| p.get("item"));
            if let Some(item_obj) = item {
                if item_obj.get("type").and_then(Value::as_str) == Some("agent_message") {
                    if let Some(text) = item_obj.get("text").and_then(Value::as_str) {
                        result.push(ThreadMessageLike {
                            role: MessageRole::Assistant,
                            id: Some(msg.id.clone()),
                            created_at: Some(msg.created_at.clone()),
                            content: vec![ExtendedMessagePart::Basic(MessagePart::Text {
                                text: text.to_string(),
                            })],
                            status: Some(MessageStatus {
                                status_type: "complete".to_string(),
                                reason: Some("stop".to_string()),
                            }),
                            streaming: None,
                        });
                    }
                }
            }
            i += 1;
            continue;
        }

        // Codex: turn.completed — render as session summary
        if msg_type == Some("turn.completed") {
            result.push(make_system(msg, &build_result_label(parsed)));
            i += 1;
            continue;
        }

        // user by role (plain text, non-JSON)
        if msg.role == "user" && parsed.is_none() {
            result.push(convert_user_message(msg, None));
            i += 1;
            continue;
        }

        // unknown
        let label = msg_type
            .map(|t| format!("{t} event"))
            .unwrap_or_else(|| "Event".to_string());
        result.push(make_system(msg, &label));
        i += 1;
    }

    result
}

// ---------------------------------------------------------------------------
// Assistant parsing
// ---------------------------------------------------------------------------

fn parse_assistant_parts(parsed: Option<&Value>) -> Vec<MessagePart> {
    let parsed = match parsed {
        Some(p) => p,
        None => return Vec::new(),
    };
    let msg = parsed.get("message").and_then(|v| v.as_object());
    let blocks = msg.and_then(|m| m.get("content")).and_then(Value::as_array);
    let blocks = match blocks {
        Some(b) => b,
        None => return Vec::new(),
    };

    let mut parts = Vec::new();

    for (idx, b) in blocks.iter().enumerate() {
        let obj = match b.as_object() {
            Some(o) => o,
            None => continue,
        };
        let block_type = obj.get("type").and_then(Value::as_str).unwrap_or("");

        match block_type {
            "thinking" => {
                if let Some(text) = obj.get("thinking").and_then(Value::as_str) {
                    parts.push(MessagePart::Reasoning {
                        text: text.to_string(),
                    });
                }
            }
            "redacted_thinking" => {
                parts.push(MessagePart::Reasoning {
                    text: "[Thinking redacted]".to_string(),
                });
            }
            "text" => {
                if let Some(text) = obj.get("text").and_then(Value::as_str) {
                    parts.push(MessagePart::Text {
                        text: text.to_string(),
                    });
                }
            }
            "tool_use" | "server_tool_use" => {
                let args = obj
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Default::default()));
                let stream_status = obj
                    .get("__streaming_status")
                    .and_then(Value::as_str)
                    .and_then(parse_streaming_status);
                let raw_json_text = obj.get("__input_json_text").and_then(Value::as_str);
                let args_text = raw_json_text
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| serde_json::to_string(&args).unwrap_or_default());
                let tool_call_id = obj
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("tc-{idx}"));
                let tool_name = obj
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();

                parts.push(MessagePart::ToolCall {
                    tool_call_id,
                    tool_name,
                    args,
                    args_text,
                    result: None,
                    streaming_status: stream_status,
                });
            }
            _ => {}
        }
    }

    parts
}

fn parse_streaming_status(s: &str) -> Option<StreamingStatus> {
    match s {
        "pending" => Some(StreamingStatus::Pending),
        "streaming_input" => Some(StreamingStatus::StreamingInput),
        "running" => Some(StreamingStatus::Running),
        "done" => Some(StreamingStatus::Done),
        "error" => Some(StreamingStatus::Error),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Merge tool_result user messages into preceding tool-call parts
// ---------------------------------------------------------------------------

fn merge_tool_results(parsed: Option<&Value>, target_parts: &mut [MessagePart]) -> bool {
    let parsed = match parsed {
        Some(p) => p,
        None => return false,
    };
    let msg = parsed.get("message").and_then(|v| v.as_object());
    let blocks = msg.and_then(|m| m.get("content")).and_then(Value::as_array);
    let blocks = match blocks {
        Some(b) if !b.is_empty() => b,
        _ => return false,
    };

    let mut all_tool_result = true;
    let mut results: Vec<(String, String)> = Vec::new(); // (tool_use_id, content)

    for b in blocks {
        let obj = match b.as_object() {
            Some(o) => o,
            None => continue,
        };
        let block_type = obj.get("type").and_then(Value::as_str).unwrap_or("");

        if block_type == "tool_result" {
            let tool_use_id = obj
                .get("tool_use_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let content = extract_tool_result_content(obj.get("content"));
            results.push((tool_use_id, content));
        } else if block_type == "text" {
            let text = obj.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.trim().is_empty() {
                all_tool_result = false;
            }
        } else if block_type != "image" && block_type != "file" {
            all_tool_result = false;
        }
    }

    if !all_tool_result || results.is_empty() {
        return false;
    }

    // Attach results to matching tool-call parts
    for (tool_use_id, content) in results {
        for part in target_parts.iter_mut() {
            if let MessagePart::ToolCall {
                tool_call_id,
                result,
                ..
            } = part
            {
                if *tool_call_id == tool_use_id {
                    *result = Some(Value::String(content.clone()));
                    break;
                }
            }
        }
    }

    true
}

fn extract_tool_result_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => {
            let texts: Vec<&str> = arr
                .iter()
                .filter_map(|x| {
                    x.as_object()
                        .and_then(|o| o.get("text"))
                        .and_then(Value::as_str)
                })
                .collect();
            texts.join("\n")
        }
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// User message
// ---------------------------------------------------------------------------

fn convert_user_message(msg: &IntermediateMessage, parsed: Option<&Value>) -> ThreadMessageLike {
    let mut parts: Vec<MessagePart> = Vec::new();

    if let Some(p) = parsed {
        let message = p.get("message").and_then(|v| v.as_object());
        if let Some(blocks) = message
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for b in blocks {
                if let Some(obj) = b.as_object() {
                    if obj.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(text) = obj.get("text").and_then(Value::as_str) {
                            parts.push(MessagePart::Text {
                                text: text.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    if parts.is_empty() {
        parts.push(MessagePart::Text {
            text: extract_fallback(msg),
        });
    }

    ThreadMessageLike {
        role: MessageRole::User,
        id: Some(msg.id.clone()),
        created_at: Some(msg.created_at.clone()),
        content: parts.into_iter().map(ExtendedMessagePart::Basic).collect(),
        status: None,
        streaming: None,
    }
}

// ---------------------------------------------------------------------------
// Child message grouping
// ---------------------------------------------------------------------------

fn group_child_messages(msgs: Vec<ThreadMessageLike>) -> Vec<ThreadMessageLike> {
    let has_children = msgs
        .iter()
        .any(|m| m.id.as_ref().is_some_and(|id| id.starts_with("child:")));
    if !has_children {
        return msgs;
    }

    // Count Agent/Task tool-calls in non-child messages
    let mut agent_tool_count = 0u32;
    for m in &msgs {
        if m.id.as_ref().is_some_and(|id| id.starts_with("child:")) {
            continue;
        }
        if m.role != MessageRole::Assistant {
            continue;
        }
        for p in &m.content {
            if let ExtendedMessagePart::Basic(MessagePart::ToolCall { tool_name, .. }) = p {
                if tool_name == "Agent" || tool_name == "Task" {
                    agent_tool_count += 1;
                }
            }
        }
    }

    if agent_tool_count <= 1 {
        inline_child_messages(msgs)
    } else {
        group_child_messages_under_parent(msgs)
    }
}

/// Single-agent mode: strip "child:" prefix and render inline.
fn inline_child_messages(msgs: Vec<ThreadMessageLike>) -> Vec<ThreadMessageLike> {
    msgs.into_iter()
        .map(|mut m| {
            if let Some(id) = &m.id {
                if let Some(stripped) = id.strip_prefix("child:") {
                    m.id = Some(stripped.to_string());
                }
            }
            m
        })
        .collect()
}

/// Multi-agent mode: group children under their parent Agent/Task tool-call.
fn group_child_messages_under_parent(msgs: Vec<ThreadMessageLike>) -> Vec<ThreadMessageLike> {
    let mut out: Vec<ThreadMessageLike> = Vec::new();
    let mut i = 0;

    while i < msgs.len() {
        let m = &msgs[i];
        if m.id.as_ref().is_some_and(|id| id.starts_with("child:")) {
            if let Some(parent) = out.last_mut() {
                if parent.role == MessageRole::Assistant {
                    // Collect all consecutive child message parts
                    let mut child_parts: Vec<ExtendedMessagePart> = Vec::new();
                    while i < msgs.len()
                        && msgs[i]
                            .id
                            .as_ref()
                            .is_some_and(|id| id.starts_with("child:"))
                    {
                        child_parts.extend(msgs[i].content.clone());
                        i += 1;
                    }

                    // Find the last Agent/Task tool-call in the parent
                    for p in parent.content.iter_mut().rev() {
                        if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
                            tool_name,
                            result,
                            ..
                        }) = p
                        {
                            if tool_name == "Agent" || tool_name == "Task" {
                                let children_json =
                                    serde_json::to_string(&child_parts).unwrap_or_default();
                                *result = Some(Value::String(format!(
                                    "__children__{{\"parts\":{children_json}}}"
                                )));
                                break;
                            }
                        }
                    }
                    continue;
                }
            }
            i += 1;
            continue;
        }
        out.push(msgs[i].clone());
        i += 1;
    }

    out
}

// ---------------------------------------------------------------------------
// Merge adjacent assistant messages
// ---------------------------------------------------------------------------

fn merge_adjacent_assistants(msgs: Vec<ThreadMessageLike>) -> Vec<ThreadMessageLike> {
    let mut out: Vec<ThreadMessageLike> = Vec::new();

    for msg in msgs {
        let should_merge = matches!(
            (out.last().map(|p| &p.role), &msg.role),
            (Some(MessageRole::Assistant), MessageRole::Assistant)
        );

        if should_merge {
            let prev = out.last_mut().unwrap();
            prev.content.extend(msg.content);
            if msg.status.is_some() {
                prev.status = msg.status;
            }
            if prev.streaming == Some(true) || msg.streaming == Some(true) {
                prev.streaming = Some(true);
            }
        } else {
            out.push(msg);
        }
    }

    out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_system(msg: &IntermediateMessage, text: &str) -> ThreadMessageLike {
    ThreadMessageLike {
        role: MessageRole::System,
        id: Some(msg.id.clone()),
        created_at: Some(msg.created_at.clone()),
        content: vec![ExtendedMessagePart::Basic(MessagePart::Text {
            text: text.to_string(),
        })],
        status: None,
        streaming: None,
    }
}

fn build_system_label(parsed: Option<&Value>) -> String {
    let parsed = match parsed {
        Some(p) => p,
        None => return "System".to_string(),
    };
    let sub = parsed.get("subtype").and_then(Value::as_str);
    let model = parsed.get("model").and_then(Value::as_str);
    match sub {
        Some("init") => match model {
            Some(m) => format!("Session initialized — {m}"),
            None => "Session initialized".to_string(),
        },
        Some(s) => format!("System: {s}"),
        None => "System".to_string(),
    }
}

fn build_result_label(parsed: Option<&Value>) -> String {
    let parsed = match parsed {
        Some(p) => p,
        None => return "Done".to_string(),
    };

    let cost = parsed.get("total_cost_usd").and_then(Value::as_f64);
    let duration_ms = parsed.get("duration_ms").and_then(Value::as_f64);
    let usage = parsed.get("usage");

    let input_tokens = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(Value::as_i64)
        .or_else(|| parsed.get("input_tokens").and_then(Value::as_i64));
    let output_tokens = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(Value::as_i64)
        .or_else(|| parsed.get("output_tokens").and_then(Value::as_i64));

    let mut bits: Vec<String> = Vec::new();

    if let Some(ms) = duration_ms {
        let total_secs = ms / 1000.0;
        if total_secs >= 60.0 {
            let mins = (total_secs / 60.0).floor() as i64;
            let secs = (total_secs % 60.0).round() as i64;
            if secs > 0 {
                bits.push(format!("{mins}m {secs}s"));
            } else {
                bits.push(format!("{mins}m"));
            }
        } else {
            bits.push(format!("{total_secs:.1}s"));
        }
    }

    if let Some(v) = input_tokens {
        bits.push(format!("in {}", format_count(v)));
    }
    if let Some(v) = output_tokens {
        bits.push(format!("out {}", format_count(v)));
    }
    if let Some(c) = cost {
        bits.push(format!("${c:.4}"));
    }

    if bits.is_empty() {
        "Done".to_string()
    } else {
        bits.join(" \u{2022} ")
    }
}

fn build_error_label(msg: &IntermediateMessage, parsed: Option<&Value>) -> String {
    if let Some(p) = parsed {
        if let Some(content) = p.get("content").and_then(Value::as_str) {
            if !content.trim().is_empty() {
                return format!("Error: {content}");
            }
        }
        if let Some(message) = p.get("message").and_then(Value::as_str) {
            if !message.trim().is_empty() {
                return format!("Error: {message}");
            }
        }
    }

    // Try parsing raw content as JSON for error extraction
    if let Ok(obj) = serde_json::from_str::<Value>(&msg.raw_json) {
        if let Some(content) = obj.get("content").and_then(Value::as_str) {
            return format!("Error: {content}");
        }
        if let Some(message) = obj.get("message").and_then(Value::as_str) {
            return format!("Error: {message}");
        }
    }

    let fb = extract_fallback(msg);
    format!("Error: {fb}")
}

fn extract_fallback(msg: &IntermediateMessage) -> String {
    if msg.parsed.is_none() {
        return msg.raw_json.clone();
    }
    let p = msg.parsed.as_ref().unwrap();

    if let Some(text) = p.get("text").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return text.to_string();
        }
    }
    if let Some(result) = p.get("result").and_then(Value::as_str) {
        if !result.trim().is_empty() {
            return result.to_string();
        }
    }

    let m = p.get("message");
    if let Some(msg_obj) = m.and_then(Value::as_object) {
        if let Some(content) = msg_obj.get("content") {
            if let Some(s) = content.as_str() {
                return s.to_string();
            }
            if let Some(arr) = content.as_array() {
                let texts: Vec<&str> = arr
                    .iter()
                    .filter_map(|b| {
                        b.as_object()
                            .and_then(|o| o.get("text"))
                            .and_then(Value::as_str)
                    })
                    .collect();
                if !texts.is_empty() {
                    return texts.join("\n\n");
                }
            }
        }
    }

    // Last resort: truncate raw content
    let max = 200;
    if msg.raw_json.len() <= max {
        msg.raw_json.clone()
    } else {
        msg.raw_json[..max].to_string()
    }
}

/// Format a token count with thousand separators.
fn format_count(value: i64) -> String {
    if value < 1000 {
        return value.to_string();
    }
    let s = value.to_string();
    let mut result = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push(',');
        }
        result.push(ch);
    }
    result.chars().rev().collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn im(id: &str, role: &str, content: Value) -> IntermediateMessage {
        let raw = serde_json::to_string(&content).unwrap();
        IntermediateMessage {
            id: id.to_string(),
            role: role.to_string(),
            raw_json: raw,
            parsed: Some(content),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            is_streaming: false,
        }
    }

    #[test]
    fn format_count_with_commas() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(1000), "1,000");
        assert_eq!(format_count(1_234_567), "1,234,567");
    }

    #[test]
    fn skip_system_noise() {
        let messages = vec![
            im(
                "1",
                "assistant",
                json!({"type": "system", "subtype": "init"}),
            ),
            im(
                "2",
                "assistant",
                json!({"type": "system", "subtype": "task_progress"}),
            ),
            im(
                "3",
                "assistant",
                json!({
                    "type": "assistant",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": "hello"}]}
                }),
            ),
        ];
        let result = convert(&messages);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].role, MessageRole::Assistant);
    }

    #[test]
    fn parse_assistant_with_thinking_and_text() {
        let messages = vec![im(
            "1",
            "assistant",
            json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "let me think..."},
                        {"type": "text", "text": "here is my answer"}
                    ]
                }
            }),
        )];
        let result = convert(&messages);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].content.len(), 2);
        assert!(matches!(
            &result[0].content[0],
            ExtendedMessagePart::Basic(MessagePart::Reasoning { text }) if text == "let me think..."
        ));
        assert!(matches!(
            &result[0].content[1],
            ExtendedMessagePart::Basic(MessagePart::Text { text }) if text == "here is my answer"
        ));
    }

    #[test]
    fn merge_tool_result_into_tool_call() {
        let messages = vec![
            im(
                "1",
                "assistant",
                json!({
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {"type": "tool_use", "id": "tc1", "name": "read", "input": {"file_path": "/a.txt"}}
                        ]
                    }
                }),
            ),
            im(
                "2",
                "user",
                json!({
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [
                            {"type": "tool_result", "tool_use_id": "tc1", "content": "file contents here"}
                        ]
                    }
                }),
            ),
        ];
        let result = convert(&messages);
        assert_eq!(result.len(), 1);
        if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
            result: Some(r), ..
        }) = &result[0].content[0]
        {
            assert_eq!(r.as_str().unwrap(), "file contents here");
        } else {
            panic!("expected tool-call with result");
        }
    }

    #[test]
    fn merge_adjacent_assistant_messages() {
        let messages = vec![
            im(
                "1",
                "assistant",
                json!({
                    "type": "assistant",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": "part 1"}]}
                }),
            ),
            im(
                "2",
                "assistant",
                json!({
                    "type": "assistant",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": "part 2"}]}
                }),
            ),
        ];
        let result = convert(&messages);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].content.len(), 2);
    }

    #[test]
    fn result_label_formatting() {
        let label = build_result_label(Some(&json!({
            "type": "result",
            "duration_ms": 90_500,
            "usage": {"input_tokens": 5200, "output_tokens": 1200},
            "total_cost_usd": 0.0123
        })));
        assert!(label.contains("1m 31s"));
        assert!(label.contains("in 5,200"));
        assert!(label.contains("out 1,200"));
        assert!(label.contains("$0.0123"));
    }

    #[test]
    fn plain_user_message() {
        let msg = IntermediateMessage {
            id: "u1".to_string(),
            role: "user".to_string(),
            raw_json: "hello world".to_string(),
            parsed: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            is_streaming: false,
        };
        let result = convert(&[msg]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].role, MessageRole::User);
    }

    #[test]
    fn codex_item_completed() {
        let messages = vec![im(
            "1",
            "assistant",
            json!({
                "type": "item.completed",
                "item": {"type": "agent_message", "text": "Hello from Codex"}
            }),
        )];
        let result = convert(&messages);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].role, MessageRole::Assistant);
    }
}
