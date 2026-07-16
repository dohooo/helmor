//! Adapter unit tests. Most exercise the public `convert` API; a few
//! reach into the private `labels::format_count` and
//! `labels::build_result_label` helpers via `super::labels::*`.

use super::blocks::parse_assistant_parts;
use super::labels::{build_result_label, format_count};
use super::*;
use crate::pipeline::types::{
    NoticeSeverity, TaskStatus, TodoStatus, WorkflowAgentStatus, WorkflowStatus,
};
use serde_json::json;

fn im(id: &str, role: &str, content: Value) -> IntermediateMessage {
    let raw = serde_json::to_string(&content).unwrap();
    IntermediateMessage {
        id: id.to_string(),
        role: role.parse().expect("valid role"),
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
        ExtendedMessagePart::Basic(MessagePart::Text { text, .. }) => {
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
        ExtendedMessagePart::Basic(MessagePart::Image {
            source, media_type, ..
        }) => {
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
    if let ExtendedMessagePart::Basic(MessagePart::Text { text, .. }) = &result[0].content[0] {
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
    if let ExtendedMessagePart::Basic(MessagePart::Text { text, .. }) = &result[0].content[0] {
        assert!(text.contains("stream closed unexpectedly"));
    } else {
        panic!("expected text part");
    }
}

#[test]
fn system_init_and_orphan_task_progress_do_not_render_transcript_rows() {
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
    // task_progress is structured task state, not transcript prose. With no
    // owner tool in this fixture it is consumed and left out of chat output;
    // init stays silent too.
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
        ExtendedMessagePart::Basic(MessagePart::Reasoning { text, .. }) if text == "let me think..."
    ));
    assert!(matches!(
        &result[0].content[1],
        ExtendedMessagePart::Basic(MessagePart::Text { text, .. }) if text == "here is my answer"
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
fn merge_adjacent_same_id_assistant_messages_replaces_with_latest_snapshot() {
    let messages = vec![
        im(
            "same",
            "assistant",
            json!({
                "type": "assistant",
                "__streaming": true,
                "message": {
                    "role": "assistant",
                    "content": [{
                        "type": "thinking",
                        "thinking": "draft",
                        "__part_id": "same:blk:0",
                        "__is_streaming": true
                    }]
                }
            }),
        ),
        im(
            "same",
            "assistant",
            json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "thinking",
                            "thinking": "draft",
                            "__part_id": "same:blk:0"
                        },
                        {
                            "type": "text",
                            "text": "done",
                            "__part_id": "same:blk:1"
                        }
                    ]
                }
            }),
        ),
    ];

    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].content.len(), 2);
    assert_eq!(result[0].streaming, None);

    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::Reasoning { id, streaming, .. }) => {
            assert_eq!(id, "same:blk:0");
            assert_eq!(*streaming, None);
        }
        other => panic!("expected reasoning part, got {other:?}"),
    }
    match &result[0].content[1] {
        ExtendedMessagePart::Basic(MessagePart::Text { text, .. }) => {
            assert_eq!(text, "done");
        }
        other => panic!("expected text part, got {other:?}"),
    }
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
        role: MessageRole::User,
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
                ExtendedMessagePart::Basic(MessagePart::Text { text, .. }) => Some(text.clone()),
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

/// Nested sub-agents (Claude Code 2.1.172+): a Task spawned by a Task.
/// The grandchild's `parent_tool_use_id` points at the nested Task that
/// lives inside the outer Task's `children`, so the grouping pass must
/// index folded children too — otherwise the grandchild renders as an
/// orphan top-level message instead of nesting under its parent.
#[test]
fn nested_subagent_children_attach_to_nested_task() {
    let messages = vec![
        // Top-level assistant spawns the outer Task.
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
                        "id": "task_outer",
                        "name": "Task",
                        "input": {"description": "outer subagent", "subagent_type": "Explore"}
                    }]
                }
            }),
        ),
        // Child of the outer Task: the sub-agent spawns its own Task.
        im(
            "c1",
            "assistant",
            json!({
                "type": "assistant",
                "parent_tool_use_id": "task_outer",
                "message": {
                    "id": "msg_child",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "task_nested",
                        "name": "Task",
                        "input": {"description": "nested subagent", "subagent_type": "Explore"}
                    }]
                }
            }),
        ),
        // Grandchild: output of the nested sub-agent.
        im(
            "g1",
            "assistant",
            json!({
                "type": "assistant",
                "parent_tool_use_id": "task_nested",
                "message": {
                    "id": "msg_grandchild",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "GRANDCHILD"}]
                }
            }),
        ),
    ];

    let result = convert(&messages);

    // Everything folds into one assistant message — the grandchild must
    // NOT surface as a standalone top-level message.
    assert_eq!(
        result.len(),
        1,
        "grandchild should nest, not render as an orphan top-level message"
    );

    let outer_children = result[0]
        .content
        .iter()
        .find_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::ToolCall {
                tool_call_id,
                children,
                ..
            }) if tool_call_id == "task_outer" => Some(children),
            _ => None,
        })
        .expect("outer Task tool-call present");

    let nested_children = outer_children
        .iter()
        .find_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::ToolCall {
                tool_call_id,
                children,
                ..
            }) if tool_call_id == "task_nested" => Some(children),
            _ => None,
        })
        .expect("nested Task tool-call folded into the outer Task's children");

    let grandchild_texts: Vec<&str> = nested_children
        .iter()
        .filter_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::Text { text, .. }) => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        grandchild_texts,
        vec!["GRANDCHILD"],
        "grandchild content should attach to the nested Task"
    );
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

#[test]
fn user_text_event_after_assistant_is_dropped() {
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
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].role, MessageRole::Assistant);
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
        ExtendedMessagePart::Basic(MessagePart::PromptSuggestion { text, .. }) => {
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

#[test]
fn fast_mode_unavailable_renders_as_warning_notice() {
    let messages = vec![im(
        "fmu1",
        "assistant",
        json!({
            "type": "system",
            "subtype": "fast_mode_unavailable",
            "reason": "Fast mode runs on extra usage, which isn't enabled.",
            "fastModeState": "off",
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
            ..
        }) => {
            assert_eq!(*severity, NoticeSeverity::Warning);
            assert_eq!(label, "Fast mode unavailable");
            assert_eq!(
                body.as_deref(),
                Some("Fast mode runs on extra usage, which isn't enabled.")
            );
        }
        other => panic!("expected SystemNotice, got {other:?}"),
    }
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
        ExtendedMessagePart::Basic(MessagePart::TodoList { items, .. }) => {
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
    let parts = parse_assistant_parts(Some(&parsed), "test-msg");
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
    let parts = parse_assistant_parts(Some(&parsed), "test-msg");
    assert_eq!(parts.len(), 1);
    match &parts[0] {
        MessagePart::TodoList { items, .. } => {
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].text, "X");
            assert_eq!(items[0].status, TodoStatus::Pending);
        }
        other => panic!("expected TodoList, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// R6b: Task family (TaskCreate / TaskUpdate) → TodoList collapse.
//
// claude-agent-sdk v0.3.142 retired `TodoWrite` for SDK/headless sessions in
// favor of the incremental Task family. The adapter accumulates these by
// creation order (the CLI assigns sequential ids "1","2","3"…), renders a
// cumulative TodoList per state-changing call, then collapses consecutive
// TodoList parts so the user still sees a SINGLE evolving plan widget —
// identical in shape to the old single-TodoWrite render.
// ---------------------------------------------------------------------------

fn task_create(id: &str, subject: &str) -> IntermediateMessage {
    im(
        id,
        "assistant",
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": format!("tc_{id}"),
                    "name": "TaskCreate",
                    "input": {"subject": subject, "description": subject},
                }]
            }
        }),
    )
}

fn task_update(id: &str, task_id: &str, status: &str) -> IntermediateMessage {
    im(
        id,
        "assistant",
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": format!("tu_{id}"),
                    "name": "TaskUpdate",
                    "input": {"taskId": task_id, "status": status},
                }]
            }
        }),
    )
}

#[test]
fn claude_task_family_collapses_to_single_todolist() {
    // Mirror the real 2.1.154 stream: 3 TaskCreate + 2 TaskUpdate across
    // separate assistant messages. After merge + collapse the user must
    // see ONE TodoList reflecting the final cumulative state.
    let messages = vec![
        task_create("1", "Read the target file"),
        task_create("2", "Rename the function"),
        task_create("3", "Update all call sites"),
        task_update("4", "1", "in_progress"),
        task_update("5", "1", "completed"),
    ];
    let result = convert(&messages);
    assert_eq!(
        result.len(),
        1,
        "all Task calls merge into one assistant message"
    );

    let todo_lists: Vec<_> = result[0]
        .content
        .iter()
        .filter(|p| matches!(p, ExtendedMessagePart::Basic(MessagePart::TodoList { .. })))
        .collect();
    assert_eq!(
        todo_lists.len(),
        1,
        "consecutive Task TodoLists collapse to a single evolving list, got {} parts: {:?}",
        result[0].content.len(),
        result[0].content,
    );

    match todo_lists[0] {
        ExtendedMessagePart::Basic(MessagePart::TodoList { items, .. }) => {
            assert_eq!(items.len(), 3, "three tasks created");
            assert_eq!(items[0].text, "Read the target file");
            assert_eq!(
                items[0].status,
                TodoStatus::Completed,
                "task 1 ends completed"
            );
            assert_eq!(items[1].text, "Rename the function");
            assert_eq!(items[1].status, TodoStatus::Pending);
            assert_eq!(items[2].text, "Update all call sites");
            assert_eq!(items[2].status, TodoStatus::Pending);
        }
        other => panic!("expected TodoList, got {other:?}"),
    }
}

#[test]
fn claude_task_create_streaming_falls_back_to_toolcall() {
    // Mid-stream TaskCreate with no `subject` yet → render a plain ToolCall,
    // mirroring the TodoWrite streaming-fallback contract.
    let parsed = json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "tc_stream",
                "name": "TaskCreate",
                "input": {},
                "__streaming_status": "streaming_input"
            }]
        }
    });
    let parts = parse_assistant_parts(Some(&parsed), "test-msg");
    assert_eq!(parts.len(), 1);
    match &parts[0] {
        MessagePart::ToolCall { tool_name, .. } => assert_eq!(tool_name, "TaskCreate"),
        other => panic!("streaming TaskCreate must fall back to ToolCall, got {other:?}"),
    }
}

#[test]
fn claude_task_update_unknown_id_falls_back_to_toolcall() {
    // A TaskUpdate referencing a task we never saw created cannot fold into
    // a list → render it as a plain ToolCall rather than inventing a row.
    let messages = vec![task_update("1", "99", "completed")];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::ToolCall { tool_name, .. }) => {
            assert_eq!(tool_name, "TaskUpdate");
        }
        other => panic!("unknown-id TaskUpdate must be a ToolCall, got {other:?}"),
    }
}

#[test]
fn claude_task_get_and_list_render_as_toolcall() {
    // TaskGet / TaskList are read-only — they don't mutate the plan, so
    // they render as ordinary ToolCalls (with their own summary label),
    // never as a TodoList.
    let messages = vec![im(
        "1",
        "assistant",
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "tg", "name": "TaskGet", "input": {"taskId": "1"}},
                    {"type": "tool_use", "id": "tl", "name": "TaskList", "input": {}},
                ]
            }
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    let names: Vec<&str> = result[0]
        .content
        .iter()
        .filter_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::ToolCall { tool_name, .. }) => {
                Some(tool_name.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(names, vec!["TaskGet", "TaskList"]);
    assert!(
        !result[0]
            .content
            .iter()
            .any(|p| matches!(p, ExtendedMessagePart::Basic(MessagePart::TodoList { .. }))),
        "read-only Task tools must not synthesize a TodoList"
    );
}

#[test]
fn claude_task_create_then_update_in_one_message_collapses() {
    // Two Task calls inside a single assistant message still collapse to a
    // single TodoList (covers the `flat.len() <= 1` convert branch).
    let messages = vec![im(
        "1",
        "assistant",
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "c1", "name": "TaskCreate",
                     "input": {"subject": "Step A", "description": "do A"}},
                    {"type": "tool_use", "id": "u1", "name": "TaskUpdate",
                     "input": {"taskId": "1", "status": "in_progress"}},
                ]
            }
        }),
    )];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    let todo_lists: Vec<_> = result[0]
        .content
        .iter()
        .filter(|p| matches!(p, ExtendedMessagePart::Basic(MessagePart::TodoList { .. })))
        .collect();
    assert_eq!(todo_lists.len(), 1, "single evolving TodoList");
    match todo_lists[0] {
        ExtendedMessagePart::Basic(MessagePart::TodoList { items, .. }) => {
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].text, "Step A");
            assert_eq!(items[0].status, TodoStatus::InProgress);
        }
        other => panic!("expected TodoList, got {other:?}"),
    }
}

#[test]
fn claude_task_update_deleted_removes_row_from_list() {
    let messages = vec![
        task_create("1", "Keep me"),
        task_create("2", "Delete me"),
        task_update("3", "2", "deleted"),
    ];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    let items = result[0]
        .content
        .iter()
        .find_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::TodoList { items, .. }) => Some(items),
            _ => None,
        })
        .expect("a single TodoList");
    assert_eq!(items.len(), 1, "the deleted task is gone");
    assert_eq!(items[0].text, "Keep me");
}

#[test]
fn claude_task_update_without_rendered_fields_is_toolcall() {
    // A TaskUpdate that changes only owner/blocks (no status, no subject)
    // doesn't alter the rendered list → it must render as a plain ToolCall,
    // not a redundant duplicate TodoList.
    let messages = vec![
        task_create("1", "Step one"),
        im(
            "2",
            "assistant",
            json!({
                "type": "assistant",
                "message": {"role": "assistant", "content": [{
                    "type": "tool_use", "id": "u2", "name": "TaskUpdate",
                    "input": {"taskId": "1", "owner": "alice"}
                }]}
            }),
        ),
    ];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    let todos = result[0]
        .content
        .iter()
        .filter(|p| matches!(p, ExtendedMessagePart::Basic(MessagePart::TodoList { .. })))
        .count();
    let toolcalls = result[0]
        .content
        .iter()
        .filter(|p| matches!(p, ExtendedMessagePart::Basic(MessagePart::ToolCall { .. })))
        .count();
    assert_eq!(todos, 1, "the create still renders its list");
    assert_eq!(
        toolcalls, 1,
        "the no-op TaskUpdate falls back to a ToolCall"
    );
}

#[test]
fn claude_task_collapse_drops_emptied_task_only_message() {
    // Two Task-only assistant messages split by a user prompt (so they don't
    // merge). The second (TaskUpdate-only) message is emptied when its list is
    // folded into the anchor — it must be dropped, leaving no ghost bubble.
    let messages = vec![
        task_create("a1", "Step one"),
        im(
            "u1",
            "user",
            json!({"type": "user_prompt", "text": "keep going"}),
        ),
        task_update("a2", "1", "completed"),
    ];
    let result = convert(&messages);
    assert_eq!(
        result.len(),
        2,
        "emptied Task-only assistant message is dropped, got {result:?}"
    );
    assert!(
        !result
            .iter()
            .any(|m| m.role == MessageRole::Assistant && m.content.is_empty()),
        "no empty assistant ghost bubble remains"
    );
    let items = result[0]
        .content
        .iter()
        .find_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::TodoList { items, .. }) => Some(items),
            _ => None,
        })
        .expect("anchor message keeps the single TodoList");
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].status,
        TodoStatus::Completed,
        "anchor carries the final cumulative state"
    );
}

#[test]
fn claude_task_partial_fresh_state_bare_update_is_toolcall() {
    // The streaming-partial render path calls parse_assistant_parts with a
    // FRESH TaskListState (only the trailing message). A TaskUpdate whose
    // TaskCreate lived in an earlier, not-included message has no prior task
    // to patch → ToolCall, never a single-item phantom list.
    let parsed = json!({
        "type": "assistant",
        "message": {"role": "assistant", "content": [{
            "type": "tool_use", "id": "u", "name": "TaskUpdate",
            "input": {"taskId": "1", "status": "completed"}
        }]}
    });
    let parts = parse_assistant_parts(Some(&parsed), "partial-msg");
    assert_eq!(parts.len(), 1);
    assert!(
        matches!(&parts[0], MessagePart::ToolCall { tool_name, .. } if tool_name == "TaskUpdate"),
        "bare TaskUpdate in a fresh-state partial render is a ToolCall"
    );
}

// ---------------------------------------------------------------------------
// Dynamic Workflow widget: the Workflow tool call + its task_* lifecycle
// events (task_type="local_workflow") aggregate into one MessagePart::Workflow.
// Shapes mirror a real claude-code 2.1.154 capture.
// ---------------------------------------------------------------------------

fn sys(id: &str, content: Value) -> IntermediateMessage {
    im(id, "system", content)
}

#[test]
fn claude_workflow_aggregates_into_single_widget() {
    let messages = vec![
        // The Workflow tool call anchors the widget.
        im(
            "a1",
            "assistant",
            json!({
                "type": "assistant",
                "message": {"role": "assistant", "content": [{
                    "type": "tool_use", "id": "wf_tc", "name": "Workflow",
                    "input": {"script": "export const meta = { name: 'demo' }"}
                }]}
            }),
        ),
        // task_started links task_id ↔ tool_use_id and carries the name.
        sys(
            "s1",
            json!({
                "type": "system", "subtype": "task_started",
                "task_id": "w1", "tool_use_id": "wf_tc",
                "task_type": "local_workflow", "workflow_name": "demo-two-agents",
                "description": "Minimal demo"
            }),
        ),
        // task_progress carries the agent tree + cumulative usage.
        sys(
            "s2",
            json!({
                "type": "system", "subtype": "task_progress",
                "task_id": "w1", "tool_use_id": "wf_tc",
                "usage": {"total_tokens": 61609, "tool_uses": 0, "duration_ms": 1655},
                "workflow_progress": [
                    {"type": "workflow_phase", "index": 1, "title": "Demo"},
                    {"type": "workflow_agent", "index": 1, "label": "agent-alpha",
                     "phaseIndex": 1, "phaseTitle": "Demo", "model": "claude-opus-4-8[1m]",
                     "state": "done", "tokens": 30805, "toolCalls": 0, "durationMs": 1645,
                     "resultPreview": "alpha"},
                    {"type": "workflow_agent", "index": 2, "label": "agent-beta",
                     "state": "done", "resultPreview": "beta"}
                ]
            }),
        ),
        // task_updated (only task_id) flips status via the task→tool link.
        sys(
            "s3",
            json!({
                "type": "system", "subtype": "task_updated",
                "task_id": "w1", "patch": {"status": "completed"}
            }),
        ),
        // task_notification is terminal.
        sys(
            "s4",
            json!({
                "type": "system", "subtype": "task_notification",
                "task_id": "w1", "tool_use_id": "wf_tc", "status": "completed",
                "summary": "Dynamic workflow completed",
                "usage": {"total_tokens": 61609, "tool_uses": 0, "duration_ms": 1655}
            }),
        ),
    ];
    let result = convert(&messages);

    // Exactly one Workflow widget; the raw task_* events do NOT render as
    // standalone subagent notices.
    let workflows: Vec<_> = result
        .iter()
        .flat_map(|m| m.content.iter())
        .filter_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::Workflow {
                name,
                status,
                agents,
                total_tokens,
                ..
            }) => Some((name, status, agents, total_tokens)),
            _ => None,
        })
        .collect();
    assert_eq!(workflows.len(), 1, "one workflow widget, got {result:?}");
    let (name, status, agents, total_tokens) = workflows[0];
    assert_eq!(name, "demo-two-agents");
    assert_eq!(*status, WorkflowStatus::Completed);
    assert_eq!(*total_tokens, Some(61609));
    assert_eq!(agents.len(), 2);
    assert_eq!(agents[0].label, "agent-alpha");
    assert_eq!(agents[0].status, WorkflowAgentStatus::Done);
    assert_eq!(agents[0].result_preview.as_deref(), Some("alpha"));
    // Phase grouping + per-agent metrics are captured from the workflow_progress
    // entry (these drive the drill-down detail view).
    assert_eq!(agents[0].phase_index, Some(1));
    assert_eq!(agents[0].phase_title.as_deref(), Some("Demo"));
    assert_eq!(agents[0].model.as_deref(), Some("claude-opus-4-8[1m]"));
    assert_eq!(agents[0].tokens, Some(30805));
    assert_eq!(agents[0].tool_calls, Some(0));
    assert_eq!(agents[0].duration_ms, Some(1645));
    assert_eq!(agents[1].label, "agent-beta");
    // Agents whose entry omits the metric fields keep them None.
    assert_eq!(agents[1].model, None);
    assert_eq!(agents[1].tokens, None);

    // No leftover "Subagent started/progress/completed" notices for the
    // workflow's task_* events.
    let notice_count = result
        .iter()
        .flat_map(|m| m.content.iter())
        .filter(|p| {
            matches!(
                p,
                ExtendedMessagePart::Basic(MessagePart::SystemNotice { .. })
            )
        })
        .count();
    assert_eq!(
        notice_count, 0,
        "workflow task_* events must not render as notices"
    );
}

#[test]
fn non_workflow_subagent_task_aggregates_task_state() {
    // A task_* event WITHOUT task_type=local_workflow (a plain subagent)
    // becomes structured task state, not transcript prose.
    let messages = vec![
        im(
            "a1",
            "assistant",
            json!({
                "type": "assistant",
                "message": {"role": "assistant", "content": [{
                    "type": "tool_use", "id": "task_abc", "name": "Task",
                    "input": {"description": "review the code"}
                }]}
            }),
        ),
        sys(
            "s1",
            json!({
                "type": "system", "subtype": "task_started",
                "task_id": "t1", "tool_use_id": "task_abc",
                "description": "review the code"
            }),
        ),
    ];
    let result = convert(&messages);
    assert!(
        result
            .iter()
            .flat_map(|m| m.content.iter())
            .all(|p| !matches!(
                p,
                ExtendedMessagePart::Basic(MessagePart::SystemNotice { .. })
            )),
        "plain subagent task_started should not render a notice"
    );
    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::ToolCall { task_state, .. }) => {
            let task_state = task_state.as_ref().expect("task state");
            assert_eq!(task_state.id, "t1");
            assert_eq!(task_state.tool_use_id.as_deref(), Some("task_abc"));
            assert_eq!(task_state.status, TaskStatus::Running);
        }
        other => panic!("expected ToolCall, got {other:?}"),
    }
}

fn workflow_tool_use(msg_id: &str, tool_use_id: &str) -> IntermediateMessage {
    im(
        msg_id,
        "assistant",
        json!({
            "type": "assistant",
            "message": {"role": "assistant", "content": [{
                "type": "tool_use", "id": tool_use_id, "name": "Workflow",
                "input": {"script": "export const meta = { name: 'demo' }"}
            }]}
        }),
    )
}

fn first_workflow(result: &[ThreadMessageLike]) -> Option<&MessagePart> {
    result
        .iter()
        .flat_map(|m| m.content.iter())
        .find_map(|p| match p {
            ExtendedMessagePart::Basic(part @ MessagePart::Workflow { .. }) => Some(part),
            _ => None,
        })
}

#[test]
fn claude_workflow_agent_done_not_downgraded_by_stale_delta() {
    let messages = vec![
        workflow_tool_use("a1", "wf_tc"),
        sys(
            "s1",
            json!({"type":"system","subtype":"task_started","task_id":"w1","tool_use_id":"wf_tc","task_type":"local_workflow","workflow_name":"demo"}),
        ),
        // Agent 1 reaches done with a result preview…
        sys(
            "s2",
            json!({"type":"system","subtype":"task_progress","task_id":"w1","tool_use_id":"wf_tc","workflow_progress":[
                {"type":"workflow_agent","index":1,"label":"a","state":"done","resultPreview":"ok"}]}),
        ),
        // …then a stale delta says "progress" again — must NOT downgrade.
        sys(
            "s3",
            json!({"type":"system","subtype":"task_progress","task_id":"w1","tool_use_id":"wf_tc","workflow_progress":[
                {"type":"workflow_agent","index":1,"label":"a","state":"progress"}]}),
        ),
    ];
    let result = convert(&messages);
    match first_workflow(&result).expect("workflow widget") {
        MessagePart::Workflow { agents, .. } => {
            assert_eq!(agents.len(), 1);
            assert_eq!(
                agents[0].status,
                WorkflowAgentStatus::Done,
                "a done agent must not be downgraded by a stale delta"
            );
            assert_eq!(agents[0].result_preview.as_deref(), Some("ok"));
        }
        other => panic!("expected Workflow, got {other:?}"),
    }
}

#[test]
fn claude_workflow_multiple_runs_render_separately() {
    let messages = vec![
        workflow_tool_use("a1", "wf_a"),
        sys(
            "s1",
            json!({"type":"system","subtype":"task_started","task_id":"wa","tool_use_id":"wf_a","task_type":"local_workflow","workflow_name":"alpha-flow"}),
        ),
        sys(
            "s2",
            json!({"type":"system","subtype":"task_notification","task_id":"wa","tool_use_id":"wf_a","status":"completed"}),
        ),
        workflow_tool_use("a2", "wf_b"),
        sys(
            "s3",
            json!({"type":"system","subtype":"task_started","task_id":"wb","tool_use_id":"wf_b","task_type":"local_workflow","workflow_name":"beta-flow"}),
        ),
        sys(
            "s4",
            json!({"type":"system","subtype":"task_progress","task_id":"wb","tool_use_id":"wf_b","workflow_progress":[
                {"type":"workflow_agent","index":1,"label":"b","state":"progress"}]}),
        ),
    ];
    let result = convert(&messages);
    let flows: Vec<(&str, &WorkflowStatus)> = result
        .iter()
        .flat_map(|m| m.content.iter())
        .filter_map(|p| match p {
            ExtendedMessagePart::Basic(MessagePart::Workflow { name, status, .. }) => {
                Some((name.as_str(), status))
            }
            _ => None,
        })
        .collect();
    assert_eq!(flows.len(), 2, "two independent workflow widgets");
    assert_eq!(flows[0].0, "alpha-flow");
    assert_eq!(*flows[0].1, WorkflowStatus::Completed);
    assert_eq!(flows[1].0, "beta-flow");
    assert_eq!(*flows[1].1, WorkflowStatus::Running);
}

#[test]
fn claude_workflow_completes_via_notification_without_task_updated() {
    // task_notification is the terminal authority: even with no task_updated,
    // the run settles to completed. (The event stream is ordered, so
    // task_started always anchors the run before later events.)
    let messages = vec![
        workflow_tool_use("a1", "wf_tc"),
        sys(
            "s1",
            json!({"type":"system","subtype":"task_started","task_id":"w1","tool_use_id":"wf_tc","task_type":"local_workflow","workflow_name":"demo"}),
        ),
        sys(
            "s2",
            json!({"type":"system","subtype":"task_notification","task_id":"w1","tool_use_id":"wf_tc","status":"completed","usage":{"total_tokens":1000,"duration_ms":500}}),
        ),
    ];
    let result = convert(&messages);
    match first_workflow(&result).expect("workflow widget") {
        MessagePart::Workflow {
            status,
            total_tokens,
            ..
        } => {
            assert_eq!(*status, WorkflowStatus::Completed);
            assert_eq!(*total_tokens, Some(1000));
        }
        other => panic!("expected Workflow, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Task-state aggregation for non-workflow subagent task_started.
// ---------------------------------------------------------------------------

#[test]
fn subagent_task_started_renders_task_state_with_tool_ref() {
    let messages = vec![
        im(
            "a1",
            "assistant",
            json!({
                "type": "assistant",
                "message": {"role": "assistant", "content": [{
                    "type": "tool_use", "id": "task_xyz", "name": "Task",
                    "input": {"description": "scanning files"}
                }]}
            }),
        ),
        im(
            "sn1",
            "assistant",
            json!({
                "type": "system",
                "subtype": "task_started",
                "tool_use_id": "task_xyz",
                "description": "scanning files",
            }),
        ),
    ];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].role, MessageRole::Assistant);
    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::ToolCall { task_state, .. }) => {
            let task_state = task_state.as_ref().expect("task state");
            assert_eq!(task_state.id, "task_xyz");
            assert_eq!(task_state.tool_use_id.as_deref(), Some("task_xyz"));
            assert_eq!(task_state.description.as_deref(), Some("scanning files"));
        }
        other => panic!("expected ToolCall, got {other:?}"),
    }
}

#[test]
fn local_bash_task_events_are_aggregated() {
    // `task_type: local_bash` wraps a single Bash command — the Bash
    // tool call already renders the command. The task lifecycle survives as
    // structured state without adding a mislabeled notice sibling.
    let messages = vec![
        im(
            "a1",
            "assistant",
            json!({
                "type": "assistant",
                "message": {"role": "assistant", "content": [{
                    "type": "tool_use", "id": "toolu_bash_1", "name": "Bash",
                    "input": {"command": "cargo test"}
                }]}
            }),
        ),
        im(
            "sn1",
            "assistant",
            json!({
                "type": "system",
                "subtype": "task_started",
                "task_type": "local_bash",
                "tool_use_id": "toolu_bash_1",
                "description": "cargo test",
            }),
        ),
    ];
    let result = convert(&messages);
    assert_eq!(result.len(), 1);
    match &result[0].content[0] {
        ExtendedMessagePart::Basic(MessagePart::ToolCall {
            tool_name,
            task_state,
            ..
        }) => {
            assert_eq!(tool_name, "Bash");
            let task_state = task_state.as_ref().expect("task state");
            assert_eq!(task_state.task_type.as_deref(), Some("local_bash"));
            assert_eq!(task_state.tool_use_id.as_deref(), Some("toolu_bash_1"));
        }
        other => panic!("expected Bash ToolCall, got {other:?}"),
    }
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
