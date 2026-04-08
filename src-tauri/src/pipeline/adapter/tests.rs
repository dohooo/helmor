//! Adapter unit tests. Most exercise the public `convert` API; a few
//! reach into the private `labels::format_count` and
//! `labels::build_result_label` helpers via `super::labels::*`.

use super::labels::{build_result_label, format_count};
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
fn claude_server_tool_result_attaches_to_previous_tool_use() {
    let messages = vec![im(
        "1",
        "assistant",
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "server_tool_use",
                        "id": "stu_1",
                        "name": "web_search",
                        "input": {"query": "rust"},
                    },
                    {
                        "type": "web_search_tool_result",
                        "content": [{"type": "web_search_result", "url": "https://rust-lang.org", "title": "Rust"}],
                    }
                ]
            }
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::ToolCall {
            result, tool_name, ..
        }) => {
            assert_eq!(tool_name, "web_search");
            assert!(result.is_some(), "expected attached server tool result");
        }
        _ => panic!("expected single tool-call with attached result"),
    }
}

#[test]
fn claude_document_block_renders_as_text() {
    let messages = vec![im(
        "1",
        "assistant",
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "document",
                    "source": {"type": "text", "data": "doc body", "media_type": "text/plain"},
                }]
            }
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::Text { text }) => {
            assert_eq!(text, "doc body");
        }
        _ => panic!("expected text part"),
    }
}

#[test]
fn claude_image_block_renders_as_image_part() {
    let messages = vec![im(
        "1",
        "assistant",
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "iVBORw0KGgo=",
                    }
                }]
            }
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::Image { source, media_type }) => {
            assert_eq!(media_type.as_deref(), Some("image/png"));
            match source {
                crate::pipeline::types::ImageSource::Base64 { data } => {
                    assert_eq!(data, "iVBORw0KGgo=");
                }
                _ => panic!("expected base64 source"),
            }
        }
        _ => panic!("expected image part"),
    }
}

#[test]
fn codex_turn_failed_renders_as_system_error() {
    let messages = vec![im(
        "1",
        "error",
        json!({
            "type": "turn.failed",
            "error": {"message": "rate exceeded"},
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].role, MessageRole::System);
    if let ExtendedMessagePart::Basic(MessagePart::Text { text }) = &result[0].content[0] {
        assert!(text.contains("rate exceeded"));
    } else {
        panic!("expected text part");
    }
}

#[test]
fn codex_error_event_renders_with_message() {
    let messages = vec![im(
        "1",
        "error",
        json!({
            "type": "error",
            "message": "stream closed unexpectedly",
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].role, MessageRole::System);
    if let ExtendedMessagePart::Basic(MessagePart::Text { text }) = &result[0].content[0] {
        assert!(text.contains("stream closed unexpectedly"));
    } else {
        panic!("expected text part");
    }
}

#[test]
fn system_init_skipped_subagent_renders_as_notice() {
    let messages = vec![
        im(
            "1",
            "assistant",
            json!({"type": "system", "subtype": "init"}),
        ),
        im(
            "2",
            "assistant",
            json!({
                "type": "system",
                "subtype": "task_progress",
                "summary": "scanning files",
            }),
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
    // task_progress now renders as a SystemNotice; init stays silent.
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].role, MessageRole::System);
    assert!(matches!(
        &result[0].content[0],
        ExtendedMessagePart::Basic(MessagePart::SystemNotice { .. })
    ));
    assert_eq!(result[1].role, MessageRole::Assistant);
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
        ExtendedMessagePart::Basic(MessagePart::Reasoning { text, .. }) if text == "let me think..."
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

/// Regression for the multi-subagent interleaving bug. Two Task tools
/// (`task_a`, `task_b`) run in parallel; their children arrive in
/// interleaved order. The grouping pass MUST attach each child to its
/// own parent based on `parent_tool_use_id`, not based on the most
/// recent Task in the timeline.
///
/// Before the fix, the adjacency-based grouping would attach
/// `child_b1` (which lands right after parent_b) and ALL subsequent
/// consecutive child:* messages to parent_b, including `child_a2`
/// which actually belongs to parent_a.
#[test]
fn interleaved_subagent_children_attach_to_correct_parent() {
    let messages = vec![
        // Parent assistant with first Task
        im(
            "p1",
            "assistant",
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_parent",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "task_a",
                        "name": "Task",
                        "input": {"description": "subagent A", "subagent_type": "Explore"}
                    }]
                }
            }),
        ),
        // First child of subagent A
        im(
            "c_a1",
            "assistant",
            json!({
                "type": "assistant",
                "parent_tool_use_id": "task_a",
                "message": {
                    "id": "msg_child_a1",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "A1"}]
                }
            }),
        ),
        // Second parent assistant with second Task (still same SDK msg_id
        // in real life, but the adapter sees this as a separate row)
        im(
            "p2",
            "assistant",
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_parent",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "task_b",
                        "name": "Task",
                        "input": {"description": "subagent B", "subagent_type": "Explore"}
                    }]
                }
            }),
        ),
        // First child of subagent B (lands right after parent_b)
        im(
            "c_b1",
            "assistant",
            json!({
                "type": "assistant",
                "parent_tool_use_id": "task_b",
                "message": {
                    "id": "msg_child_b1",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "B1"}]
                }
            }),
        ),
        // CRITICAL: child of subagent A arriving AFTER parent_b. The
        // old adjacency-based grouping would attach this to task_b
        // because it's consecutive with c_b1. The new logic must look
        // at parent_tool_use_id and route it back to task_a.
        im(
            "c_a2",
            "assistant",
            json!({
                "type": "assistant",
                "parent_tool_use_id": "task_a",
                "message": {
                    "id": "msg_child_a2",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "A2"}]
                }
            }),
        ),
        // Another B child
        im(
            "c_b2",
            "assistant",
            json!({
                "type": "assistant",
                "parent_tool_use_id": "task_b",
                "message": {
                    "id": "msg_child_b2",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "B2"}]
                }
            }),
        ),
    ];

    let result = convert(&messages);

    // After grouping + adjacent merge: one combined assistant message
    // with two Task tool-call parts.
    assert_eq!(result.len(), 1);
    let parts: Vec<_> = result[0]
        .content
        .iter()
        .filter_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::ToolCall {
                tool_call_id,
                tool_name,
                result,
                ..
            }) if tool_name == "Task" => Some((tool_call_id.clone(), result.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(parts.len(), 2, "expected two Task tool-calls");

    // Each Task's __children__ payload should contain ONLY its own
    // children's text, not the other subagent's.
    for (id, result_value) in parts {
        let children_json = match result_value {
            Some(Value::String(s)) => s,
            _ => panic!("expected __children__ result on Task {id}"),
        };
        assert!(
            children_json.starts_with("__children__"),
            "Task {id} result should be __children__, got: {children_json}"
        );
        let expected_letter = if id == "task_a" { "A" } else { "B" };
        let unexpected_letter = if id == "task_a" { "B" } else { "A" };
        assert!(
            children_json.contains(&format!("\"{expected_letter}1\"")),
            "Task {id} should contain own child {expected_letter}1, got: {children_json}"
        );
        assert!(
            children_json.contains(&format!("\"{expected_letter}2\"")),
            "Task {id} should contain own child {expected_letter}2, got: {children_json}"
        );
        assert!(
            !children_json.contains(&format!("\"{unexpected_letter}1\"")),
            "Task {id} should NOT contain other subagent's child {unexpected_letter}1, got: {children_json}"
        );
        assert!(
            !children_json.contains(&format!("\"{unexpected_letter}2\"")),
            "Task {id} should NOT contain other subagent's child {unexpected_letter}2, got: {children_json}"
        );
    }
}
