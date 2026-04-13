//! Adapter unit tests. Most exercise the public `convert` API; a few
//! reach into the private `labels::format_count` and
//! `labels::build_result_label` helpers via `super::labels::*`.

use super::blocks::parse_assistant_parts;
use super::labels::{build_result_label, format_count};
use super::*;
use crate::pipeline::types::{NoticeSeverity, TodoStatus};
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
                        "tool_use_id": "stu_1",
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
    // token counts and cost are no longer shown
    assert!(!label.contains("in "));
    assert!(!label.contains("out "));
    assert!(!label.contains("$"));
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
                children,
                ..
            }) if tool_name == "Task" => Some((tool_call_id.clone(), children.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(parts.len(), 2, "expected two Task tool-calls");

    // Each Task's `children` Vec should contain ONLY its own
    // sub-agent's text parts, not the other subagent's.
    fn collect_text(parts: &[ExtendedMessagePart]) -> Vec<String> {
        parts
            .iter()
            .filter_map(|p| match p {
                ExtendedMessagePart::Basic(MessagePart::Text { text }) => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    for (id, children) in parts {
        assert!(
            !children.is_empty(),
            "Task {id} should have children attached, got empty"
        );
        let texts = collect_text(&children);
        let expected_letter = if id == "task_a" { "A" } else { "B" };
        let unexpected_letter = if id == "task_a" { "B" } else { "A" };
        assert!(
            texts.iter().any(|t| t == &format!("{expected_letter}1")),
            "Task {id} should contain own child {expected_letter}1, got: {texts:?}"
        );
        assert!(
            texts.iter().any(|t| t == &format!("{expected_letter}2")),
            "Task {id} should contain own child {expected_letter}2, got: {texts:?}"
        );
        assert!(
            !texts.iter().any(|t| t == &format!("{unexpected_letter}1")),
            "Task {id} should NOT contain other subagent's child {unexpected_letter}1, got: {texts:?}"
        );
        assert!(
            !texts.iter().any(|t| t == &format!("{unexpected_letter}2")),
            "Task {id} should NOT contain other subagent's child {unexpected_letter}2, got: {texts:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// R5: strict tool_use_id matching for server tool results
// ---------------------------------------------------------------------------

/// Pin the strict-id behavior: when a server_tool_use is followed by an
/// unrelated tool_use AND THEN the matching *_tool_result, the result
/// must still attach to the server tool by id, not to the most recent
/// ToolCall in the parts list.
#[test]
fn server_tool_result_attaches_by_id_skipping_intervening_toolcall() {
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
                        "id": "stu_search",
                        "name": "web_search",
                        "input": {"query": "rust"},
                    },
                    {
                        "type": "tool_use",
                        "id": "tc_other",
                        "name": "Bash",
                        "input": {"command": "ls"},
                    },
                    {
                        "type": "web_search_tool_result",
                        "tool_use_id": "stu_search",
                        "content": [{"type": "web_search_result", "url": "https://r.org"}],
                    }
                ]
            }
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    let parts: Vec<_> = result[0]
        .content
        .iter()
        .filter_map(|p| {
            if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
                tool_call_id,
                result,
                ..
            }) = p
            {
                Some((tool_call_id.clone(), result.clone()))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(parts.len(), 2, "expected two ToolCalls (web_search + Bash)");
    let by_id: std::collections::HashMap<_, _> = parts.into_iter().collect();
    assert!(
        by_id.get("stu_search").and_then(|r| r.as_ref()).is_some(),
        "web_search tool should have its result attached"
    );
    assert!(
        by_id.get("tc_other").and_then(|r| r.as_ref()).is_none(),
        "Bash tool should NOT have anything attached — id mismatch"
    );
}

/// Result block missing `tool_use_id` is dropped silently (we don't
/// want to misroute it onto an arbitrary recent ToolCall).
#[test]
fn server_tool_result_without_id_is_dropped() {
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
                        "content": [{"type": "web_search_result", "url": "https://r.org"}],
                    }
                ]
            }
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    if let ExtendedMessagePart::Basic(MessagePart::ToolCall { result, .. }) = &result[0].content[0]
    {
        assert!(
            result.is_none(),
            "id-less result block must be dropped, not attached to most-recent tool"
        );
    } else {
        panic!("expected single ToolCall");
    }
}

// ---------------------------------------------------------------------------
// R2: non-tool_result user payloads
// ---------------------------------------------------------------------------

/// A `type=user` event whose content is plain text (no tool_result
/// blocks) following an assistant turn must render as a real user
/// message — dropping it on the `parsed.is_some()` branch would
/// silently swallow mid-conversation user turns.
#[test]
fn user_text_event_after_assistant_renders_as_user_message() {
    let messages = vec![
        im(
            "a1",
            "assistant",
            json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "What's next?"}]
                }
            }),
        ),
        im(
            "u1",
            "user",
            json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "do the thing"}]
                }
            }),
        ),
    ];
    let result = convert(&messages);
    assert_eq!(result.len(), 2);
    assert_eq!(result[1].role, MessageRole::User);
    if let ExtendedMessagePart::Basic(MessagePart::Text { text }) = &result[1].content[0] {
        assert_eq!(text, "do the thing");
    } else {
        panic!("expected user text part");
    }
}

/// Drop rule: a non-tool_result user payload with no preceding
/// assistant context is dropped (likely a stray SDK wrapper).
#[test]
fn user_text_event_with_no_preceding_assistant_is_dropped() {
    let messages = vec![im(
        "u1",
        "user",
        json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "stray"}]
            }
        }),
    )];
    let result = convert(&messages);
    assert!(
        result.is_empty(),
        "stray user wrapper with no context should be dropped, got {result:?}"
    );
}

// ---------------------------------------------------------------------------
// R6: prompt_suggestion
// ---------------------------------------------------------------------------

#[test]
fn prompt_suggestion_renders_as_system_part() {
    let messages = vec![im(
        "ps1",
        "assistant",
        json!({
            "type": "prompt_suggestion",
            "suggestion": "Try running the tests",
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].role, MessageRole::System);
    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::PromptSuggestion { text }) => {
            assert_eq!(text, "Try running the tests");
        }
        other => panic!("expected PromptSuggestion, got {other:?}"),
    }
}

#[test]
fn prompt_suggestion_empty_is_silent() {
    let messages = vec![im(
        "ps1",
        "assistant",
        json!({
            "type": "prompt_suggestion",
            "suggestion": "",
        }),
    )];
    let result = convert(&messages);
    assert!(result.is_empty(), "empty suggestion must produce nothing");
}

// ---------------------------------------------------------------------------
// R6: rate_limit_event
// ---------------------------------------------------------------------------

/// Every status OTHER than `rejected` is a usage gauge — the adapter
/// must hide it. This covers `allowed` (the common per-turn gauge) as
/// well as warning variants like `allowed_warning` and `queued`, which
/// the SDK emits before the bucket is actually full.
#[test]
fn rate_limit_non_rejected_is_silent() {
    for status in ["allowed", "allowed_warning", "queued"] {
        let messages = vec![im(
            "rl1",
            "assistant",
            json!({
                "type": "rate_limit_event",
                "rate_limit_info": {
                    "status": status,
                    "rateLimitType": "five_hour",
                }
            }),
        )];
        let result = convert(&messages);
        assert!(
            result.is_empty(),
            "rate_limit_event with status={status} must be hidden"
        );
    }
}

/// Only `rejected` rate-limit events render as a SystemNotice.
#[test]
fn rate_limit_rejected_renders_warning_notice() {
    let messages = vec![im(
        "rl1",
        "assistant",
        json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "rejected",
                "rateLimitType": "five_hour",
            }
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::SystemNotice {
            severity, label, ..
        }) => {
            assert_eq!(*severity, NoticeSeverity::Warning);
            assert!(
                label.contains("rejected"),
                "label should mention status, got {label:?}"
            );
        }
        other => panic!("expected SystemNotice, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// R6: TodoWrite collapse — both convert() end-to-end and direct
// parse_assistant_parts coverage per request.
// ---------------------------------------------------------------------------

#[test]
fn claude_todowrite_collapses_to_todolist_via_convert() {
    let messages = vec![im(
        "1",
        "assistant",
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "tc_todo",
                    "name": "TodoWrite",
                    "input": {"todos": [
                        {"content": "Step A", "status": "completed"},
                        {"content": "Step B", "status": "in_progress"},
                        {"content": "Step C", "status": "pending"},
                    ]}
                }]
            }
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::TodoList { items }) => {
            assert_eq!(items.len(), 3);
            assert_eq!(items[0].text, "Step A");
            assert_eq!(items[0].status, TodoStatus::Completed);
            assert_eq!(items[1].status, TodoStatus::InProgress);
            assert_eq!(items[2].status, TodoStatus::Pending);
        }
        other => panic!("expected TodoList, got {other:?}"),
    }
}

#[test]
fn claude_todowrite_streaming_falls_back_to_toolcall() {
    // Mid-stream tool_use: input is still empty (input_json_delta
    // hasn't landed yet), so we should fall back to a regular ToolCall
    // instead of collapsing into a TodoList.
    let parsed = json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "tc_todo",
                "name": "TodoWrite",
                "input": {},
                "__streaming_status": "streaming_input"
            }]
        }
    });
    let parts = parse_assistant_parts(Some(&parsed));
    assert_eq!(parts.len(), 1);
    match &parts[0] {
        MessagePart::ToolCall { tool_name, .. } => assert_eq!(tool_name, "TodoWrite"),
        MessagePart::TodoList { .. } => {
            panic!("streaming TodoWrite must NOT collapse — fall back to ToolCall")
        }
        other => panic!("unexpected part {other:?}"),
    }
}

/// Direct unit test of parse_assistant_parts so the collapse logic is
/// pinned without going through `convert` + `merge_adjacent_assistants`.
#[test]
fn parse_assistant_parts_collapses_todowrite() {
    let parsed = json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "tc_todo",
                "name": "TodoWrite",
                "input": {"todos": [
                    {"content": "X", "status": "pending"},
                ]}
            }]
        }
    });
    let parts = parse_assistant_parts(Some(&parsed));
    assert_eq!(parts.len(), 1);
    match &parts[0] {
        MessagePart::TodoList { items } => {
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].text, "X");
            assert_eq!(items[0].status, TodoStatus::Pending);
        }
        other => panic!("expected TodoList, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// R6: SystemNotice for subagent task_started — verify the child:* id
// encoding so the grouping pass can attach it to the parent Task tool.
// ---------------------------------------------------------------------------

#[test]
fn subagent_task_started_renders_as_notice_with_child_id() {
    let messages = vec![im(
        "sn1",
        "assistant",
        json!({
            "type": "system",
            "subtype": "task_started",
            "tool_use_id": "task_xyz",
            "description": "scanning files",
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].role, MessageRole::System);
    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::SystemNotice {
            severity,
            label,
            body,
        }) => {
            assert_eq!(*severity, NoticeSeverity::Info);
            assert_eq!(label, "Subagent started");
            assert_eq!(body.as_deref(), Some("scanning files"));
        }
        other => panic!("expected SystemNotice, got {other:?}"),
    }
    assert_eq!(result[0].id.as_deref(), Some("child:task_xyz:sn1"));
}

// ---------------------------------------------------------------------------
// Subagent prompt — `type=user` with `parent_tool_use_id` is folded
// into the parent Task tool call's `children` as a synthesized
// `ToolCall` whose `tool_name` is `"Prompt"`. The frontend renders
// it through the same code path as every other child tool call —
// no special MessagePart variant, no extra rendering branch.
// ---------------------------------------------------------------------------

#[test]
fn subagent_prompt_folds_into_parent_task_as_prompt_tool_call() {
    let messages = vec![
        // Parent assistant emits the Task tool_use.
        im(
            "a1",
            "assistant",
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_parent",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "tu_subagent_1",
                        "name": "Task",
                        "input": {
                            "description": "explore repo",
                            "subagent_type": "Explore",
                            "prompt": "look at the codebase",
                        }
                    }]
                }
            }),
        ),
        // Subagent's initial prompt — text wrapped as a `type=user`
        // event with `parent_tool_use_id` pointing back at the Task.
        im(
            "u_prompt",
            "user",
            json!({
                "type": "user",
                "parent_tool_use_id": "tu_subagent_1",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "look at the codebase"}],
                }
            }),
        ),
        // Subagent runs a tool inside its session.
        im(
            "a_child",
            "assistant",
            json!({
                "type": "assistant",
                "parent_tool_use_id": "tu_subagent_1",
                "message": {
                    "id": "msg_child",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "tu_glob",
                        "name": "Glob",
                        "input": {"pattern": "**/*.rs"}
                    }]
                }
            }),
        ),
    ];

    let result = convert(&messages);

    // Find the parent Task tool call and inspect its children.
    let task_children = result
        .iter()
        .find_map(|m| {
            m.content.iter().find_map(|p| {
                if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
                    tool_name,
                    children,
                    ..
                }) = p
                {
                    if tool_name == "Task" {
                        return Some(children.clone());
                    }
                }
                None
            })
        })
        .expect("expected a Task tool call in the result");

    // children should contain BOTH the synthesized "Prompt" ToolCall
    // and the subagent's real Glob tool_use folded by the existing
    // assistant grouping pass.
    let prompt_args_text = task_children.iter().find_map(|p| {
        if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
            tool_name, args, ..
        }) = p
        {
            if tool_name == "Prompt" {
                return args
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(str::to_string);
            }
        }
        None
    });
    assert_eq!(
        prompt_args_text.as_deref(),
        Some("look at the codebase"),
        "expected synthesized Prompt ToolCall folded into parent Task children"
    );

    let glob_id = task_children.iter().find_map(|p| {
        if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
            tool_name,
            tool_call_id,
            ..
        }) = p
        {
            if tool_name == "Glob" {
                return Some(tool_call_id.clone());
            }
        }
        None
    });
    assert_eq!(
        glob_id.as_deref(),
        Some("tu_glob"),
        "expected subagent's Glob tool call also folded into parent Task children"
    );
}

#[test]
fn subagent_prompt_with_no_text_content_is_dropped() {
    // A `type=user` payload with `parent_tool_use_id` but no text
    // blocks (e.g. an image-only continuation) shouldn't push an
    // empty Prompt tool call.
    let messages = vec![
        im(
            "a1",
            "assistant",
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_parent",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "tu_2",
                        "name": "Task",
                        "input": {"description": "x", "subagent_type": "Explore"}
                    }]
                }
            }),
        ),
        im(
            "u_empty",
            "user",
            json!({
                "type": "user",
                "parent_tool_use_id": "tu_2",
                "message": {
                    "role": "user",
                    "content": [],
                }
            }),
        ),
    ];

    let result = convert(&messages);
    let task_children = result
        .iter()
        .find_map(|m| {
            m.content.iter().find_map(|p| {
                if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
                    tool_name,
                    children,
                    ..
                }) = p
                {
                    if tool_name == "Task" {
                        return Some(children.clone());
                    }
                }
                None
            })
        })
        .expect("expected a Task tool call in the result");
    let has_prompt = task_children.iter().any(|p| {
        matches!(
            p,
            ExtendedMessagePart::Basic(MessagePart::ToolCall { tool_name, .. })
                if tool_name == "Prompt"
        )
    });
    assert!(
        !has_prompt,
        "empty user payload should not produce a Prompt tool call"
    );
}

// settle detects abort_notice → fills Agent/Task result so isRunning=false
#[test]
fn settle_fills_agent_result_when_abort_notice_present() {
    let asst = im(
        "asst1",
        "assistant",
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "tc1",
                    "name": "Task",
                    "input": {"description": "x", "subagent_type": "Explore"}
                }]
            }
        }),
    );
    let notice = im(
        "err1",
        "error",
        json!({"type": "error", "content": "aborted by user"}),
    );

    let out = convert(&[asst, notice]);
    let result = out
        .iter()
        .flat_map(|m| m.content.iter())
        .find_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::ToolCall {
                tool_name, result, ..
            }) if tool_name == "Task" => Some(result.clone()),
            _ => None,
        })
        .expect("expected a Task ToolCall");
    assert!(
        result.is_some(),
        "Task result must be non-null after settle"
    );
}

// settle does NOT touch non-Agent tools
#[test]
fn settle_leaves_regular_tools_alone() {
    let asst = im(
        "asst1",
        "assistant",
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "tc1",
                    "name": "Bash",
                    "input": {"command": "sleep 60"}
                }]
            }
        }),
    );
    let notice = im(
        "err1",
        "error",
        json!({"type": "error", "content": "aborted by user"}),
    );

    let out = convert(&[asst, notice]);
    let result = out
        .iter()
        .flat_map(|m| m.content.iter())
        .find_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::ToolCall { result, .. }) => {
                Some(result.clone())
            }
            _ => None,
        })
        .expect("expected a ToolCall");
    assert!(result.is_none(), "regular tool result must stay null");
}

// no abort_notice → settle is a no-op
#[test]
fn settle_noop_without_abort_notice() {
    let asst = im(
        "asst1",
        "assistant",
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "tc1",
                    "name": "Task",
                    "input": {"description": "x"}
                }]
            }
        }),
    );

    let out = convert(&[asst]);
    let result = out
        .iter()
        .flat_map(|m| m.content.iter())
        .find_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::ToolCall { result, .. }) => {
                Some(result.clone())
            }
            _ => None,
        })
        .expect("expected a ToolCall");
    assert!(result.is_none(), "no abort → result stays null");
}
