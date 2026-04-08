//! Historical-reload rendering for Codex `item.completed` rows.
//!
//! When the user reopens a session, the DB hands the loader rows whose
//! `content` column holds the raw `item.completed` JSON the accumulator
//! persisted at stream time. We re-parse those rows here so the rendered
//! output matches what the user saw live — without going back through
//! the accumulator (it would push to `turns` again, which the historical
//! path must not do).
//!
//! Each `item.type` mirrors the corresponding accumulator handler, just
//! producing `ThreadMessageLike` directly instead of synthesizing a
//! Claude-shaped `assistant` event.

use serde_json::Value;

use super::blocks::parse_codex_todolist_items;
use crate::pipeline::types::{
    ExtendedMessagePart, IntermediateMessage, MessagePart, MessageRole, MessageStatus,
    ThreadMessageLike,
};

/// Render a single `item.completed` IntermediateMessage. Pushes 0 or 1
/// rendered messages onto `result` depending on the item type.
pub(super) fn render_item_completed(
    msg: &IntermediateMessage,
    parsed: Option<&Value>,
    result: &mut Vec<ThreadMessageLike>,
) {
    let item = match parsed.and_then(|p| p.get("item")) {
        Some(i) => i,
        None => return,
    };
    let item_type = item.get("type").and_then(Value::as_str);

    match item_type {
        Some("agent_message") => {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
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
        Some("command_execution") => render_command_execution(msg, item, result),
        Some("todo_list") => render_todo_list(msg, item, result),
        Some("reasoning") => render_reasoning(msg, item, result),
        Some("file_change") => render_file_change(msg, item, result),
        Some("web_search") => render_web_search(msg, item, result),
        Some("mcp_tool_call") => render_mcp_tool_call(msg, item, result),
        _ => {}
    }
}

fn render_command_execution(
    msg: &IntermediateMessage,
    item: &Value,
    result: &mut Vec<ThreadMessageLike>,
) {
    let command = item.get("command").and_then(Value::as_str).unwrap_or("");
    // Real Codex SDK sends `aggregated_output`. The legacy fixture/older
    // builds used `output`. Read both, prefer the new name.
    let output = item
        .get("aggregated_output")
        .or_else(|| item.get("output"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let exit_code = item.get("exit_code").and_then(Value::as_i64).unwrap_or(0);
    let result_text = if exit_code == 0 {
        output.to_string()
    } else {
        format!("Exit code: {exit_code}\n{output}")
    };
    let args = serde_json::json!({"command": command});
    let args_text = serde_json::to_string(&args).unwrap_or_default();

    result.push(ThreadMessageLike {
        role: MessageRole::Assistant,
        id: Some(msg.id.clone()),
        created_at: Some(msg.created_at.clone()),
        content: vec![ExtendedMessagePart::Basic(MessagePart::ToolCall {
            tool_call_id: format!("codex-cmd-{}", msg.id),
            tool_name: "Bash".to_string(),
            args,
            args_text,
            result: Some(Value::String(result_text)),
            streaming_status: None,
        })],
        status: Some(MessageStatus {
            status_type: "complete".to_string(),
            reason: Some("stop".to_string()),
        }),
        streaming: None,
    });
}

fn render_todo_list(msg: &IntermediateMessage, item: &Value, result: &mut Vec<ThreadMessageLike>) {
    if let Some(items) = parse_codex_todolist_items(item) {
        result.push(ThreadMessageLike {
            role: MessageRole::Assistant,
            id: Some(msg.id.clone()),
            created_at: Some(msg.created_at.clone()),
            content: vec![ExtendedMessagePart::Basic(MessagePart::TodoList { items })],
            status: Some(MessageStatus {
                status_type: "complete".to_string(),
                reason: Some("stop".to_string()),
            }),
            streaming: None,
        });
    }
}

fn render_reasoning(msg: &IntermediateMessage, item: &Value, result: &mut Vec<ThreadMessageLike>) {
    if let Some(text) = item.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            result.push(ThreadMessageLike {
                role: MessageRole::Assistant,
                id: Some(msg.id.clone()),
                created_at: Some(msg.created_at.clone()),
                content: vec![ExtendedMessagePart::Basic(MessagePart::Reasoning {
                    text: text.to_string(),
                    streaming: None,
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

fn render_file_change(
    msg: &IntermediateMessage,
    item: &Value,
    result: &mut Vec<ThreadMessageLike>,
) {
    let changes = item
        .get("changes")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let status = item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let result_text = match status {
        "completed" => "Patch applied".to_string(),
        "failed" => "Patch failed".to_string(),
        other => format!("Patch {other}"),
    };
    let args = serde_json::json!({"changes": changes});
    let args_text = serde_json::to_string(&args).unwrap_or_default();
    result.push(ThreadMessageLike {
        role: MessageRole::Assistant,
        id: Some(msg.id.clone()),
        created_at: Some(msg.created_at.clone()),
        content: vec![ExtendedMessagePart::Basic(MessagePart::ToolCall {
            tool_call_id: format!("codex-patch-{}", msg.id),
            tool_name: "apply_patch".to_string(),
            args,
            args_text,
            result: Some(Value::String(result_text)),
            streaming_status: None,
        })],
        status: Some(MessageStatus {
            status_type: "complete".to_string(),
            reason: Some("stop".to_string()),
        }),
        streaming: None,
    });
}

fn render_web_search(msg: &IntermediateMessage, item: &Value, result: &mut Vec<ThreadMessageLike>) {
    let query = item.get("query").and_then(Value::as_str).unwrap_or("");
    let args = serde_json::json!({"query": query});
    let args_text = serde_json::to_string(&args).unwrap_or_default();
    result.push(ThreadMessageLike {
        role: MessageRole::Assistant,
        id: Some(msg.id.clone()),
        created_at: Some(msg.created_at.clone()),
        content: vec![ExtendedMessagePart::Basic(MessagePart::ToolCall {
            tool_call_id: format!("codex-search-{}", msg.id),
            tool_name: "WebSearch".to_string(),
            args,
            args_text,
            result: Some(Value::String("Search completed".to_string())),
            streaming_status: None,
        })],
        status: Some(MessageStatus {
            status_type: "complete".to_string(),
            reason: Some("stop".to_string()),
        }),
        streaming: None,
    });
}

fn render_mcp_tool_call(
    msg: &IntermediateMessage,
    item: &Value,
    result: &mut Vec<ThreadMessageLike>,
) {
    let server = item.get("server").and_then(Value::as_str).unwrap_or("");
    let tool = item.get("tool").and_then(Value::as_str).unwrap_or("");
    let arguments = item.get("arguments").cloned().unwrap_or(Value::Null);
    let status = item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let result_text = if status == "failed" {
        let m = item
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("MCP tool failed");
        format!("Error: {m}")
    } else {
        item.get("result")
            .and_then(|r| serde_json::to_string(r).ok())
            .unwrap_or_else(|| "OK".to_string())
    };
    let args_text = serde_json::to_string(&arguments).unwrap_or_default();
    result.push(ThreadMessageLike {
        role: MessageRole::Assistant,
        id: Some(msg.id.clone()),
        created_at: Some(msg.created_at.clone()),
        content: vec![ExtendedMessagePart::Basic(MessagePart::ToolCall {
            tool_call_id: format!("codex-mcp-{}", msg.id),
            tool_name: format!("mcp__{server}__{tool}"),
            args: arguments,
            args_text,
            result: Some(Value::String(result_text)),
            streaming_status: None,
        })],
        status: Some(MessageStatus {
            status_type: "complete".to_string(),
            reason: Some("stop".to_string()),
        }),
        streaming: None,
    });
}
