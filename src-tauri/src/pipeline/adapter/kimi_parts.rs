//! Render Kimi's native `kimi_message` into universal `MessagePart`s.
//! Shared by the live-stream path and historical reload, so a turn renders
//! identically whether it is streaming or reloaded from the DB.

use serde_json::{json, Value};

use super::super::types::{MessagePart, StreamingStatus, TodoItem, TodoStatus};
use super::blocks::CLAUDE_TASK_LIST_ID_PREFIX;

// `msg_id` seeds stable React keys (`<msg_id>:<index>`). While streaming, the
// trailing part is the actively-generating one (reasoning renders expanded).
pub(crate) fn render_parts(parsed: &Value, msg_id: &str, is_streaming: bool) -> Vec<MessagePart> {
    let Some(parts) = parsed.get("parts").and_then(Value::as_array) else {
        return Vec::new();
    };
    let last_idx = parts.len().saturating_sub(1);
    let mut out = Vec::with_capacity(parts.len());
    for (idx, part) in parts.iter().enumerate() {
        let streaming_now = is_streaming && idx == last_idx;
        if let Some(rendered) = render_part(part, format!("{msg_id}:{idx}"), streaming_now) {
            out.push(rendered);
        }
    }
    out
}

fn render_part(part: &Value, id: String, streaming_now: bool) -> Option<MessagePart> {
    match part.get("type").and_then(Value::as_str).unwrap_or_default() {
        "text" => {
            let text = part.get("text").and_then(Value::as_str).unwrap_or_default();
            (!text.is_empty()).then(|| MessagePart::Text {
                id,
                text: text.to_string(),
            })
        }
        "reasoning" => {
            let text = part.get("text").and_then(Value::as_str).unwrap_or_default();
            (!text.is_empty()).then(|| MessagePart::Reasoning {
                id,
                text: text.to_string(),
                streaming: streaming_now.then_some(true),
                duration_ms: None,
            })
        }
        "tool" => Some(render_tool(part)),
        "plan" => render_plan(part, &id),
        _ => None,
    }
}

// ACP plan → unified todo list. Uses the shared task-list id prefix so the
// collapse pass folds repeated snapshots to the latest, matching other providers.
fn render_plan(part: &Value, id: &str) -> Option<MessagePart> {
    let entries = part.get("entries").and_then(Value::as_array)?;
    let items: Vec<TodoItem> = entries
        .iter()
        .filter_map(|e| {
            let text = e.get("content").and_then(Value::as_str)?.to_string();
            let status = match e.get("status").and_then(Value::as_str).unwrap_or("pending") {
                "in_progress" => TodoStatus::InProgress,
                "completed" => TodoStatus::Completed,
                _ => TodoStatus::Pending,
            };
            Some(TodoItem { text, status })
        })
        .collect();
    if items.is_empty() {
        return None;
    }
    Some(MessagePart::TodoList {
        id: format!("{CLAUDE_TASK_LIST_ID_PREFIX}{id}"),
        items,
    })
}

fn render_tool(part: &Value) -> MessagePart {
    let tool_call_id = part
        .get("tool_call_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let status = part
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pending");

    // File edits carry ACP `diff` blocks → render through the shared apply_patch
    // diff view (green +/red -). Otherwise a generic tool card by title/kind.
    let diffs = part
        .get("diffs")
        .and_then(Value::as_array)
        .filter(|d| !d.is_empty());
    let (tool_name, args) = match diffs {
        Some(d) => (
            "apply_patch".to_string(),
            json!({ "changes": diff_changes(d) }),
        ),
        None => (tool_display_name(part), tool_args(part)),
    };
    let args_text = serde_json::to_string(&args).unwrap_or_default();

    let is_error = status == "failed";
    let streaming_status = match status {
        "pending" => Some(StreamingStatus::Pending),
        "in_progress" => Some(StreamingStatus::Running),
        "completed" => Some(StreamingStatus::Done),
        "failed" => Some(StreamingStatus::Error),
        _ => None,
    };
    // With a rendered diff the success summary is redundant; keep other
    // output. A failed call keeps it regardless — the failure reason must
    // render even when diffs are present.
    let result = part
        .get("output_text")
        .and_then(Value::as_str)
        .filter(|o| !o.is_empty() && (is_error || diffs.is_none()))
        .map(|o| Value::String(o.to_string()));

    MessagePart::ToolCall {
        tool_call_id,
        tool_name,
        args,
        args_text,
        result,
        is_error: is_error.then_some(true),
        streaming_status,
        task_state: None,
        children: Vec::new(),
    }
}

// Prefer ACP's human-readable `title`; fall back to a canonical name from
// `kind`, then a generic label.
fn tool_display_name(part: &Value) -> String {
    if let Some(title) = part.get("title").and_then(Value::as_str) {
        if !title.is_empty() {
            return title.to_string();
        }
    }
    match part.get("kind").and_then(Value::as_str).unwrap_or_default() {
        "read" => "Read",
        "edit" => "Edit",
        "delete" => "Delete",
        "move" => "Move",
        "search" => "Search",
        "execute" => "Execute",
        "fetch" => "Fetch",
        "think" => "Think",
        "switch_mode" => "Switch mode",
        _ => "Tool",
    }
    .to_string()
}

fn tool_args(part: &Value) -> Value {
    part.get("raw_input")
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()))
}

// Build `[{ path, diff }]` from ACP diff blocks. ACP carries before/after text
// rather than a unified diff, so synthesize a full-replacement hunk the shared
// diff view can draw.
fn diff_changes(diffs: &[Value]) -> Vec<Value> {
    diffs
        .iter()
        .filter_map(|d| {
            let path = d.get("path").and_then(Value::as_str)?;
            let old = d.get("old_text").and_then(Value::as_str).unwrap_or("");
            let new = d.get("new_text").and_then(Value::as_str).unwrap_or("");
            Some(json!({ "path": path, "diff": synth_unified_diff(path, old, new) }))
        })
        .collect()
}

fn synth_unified_diff(path: &str, old: &str, new: &str) -> String {
    let mut out = format!("--- {path}\n+++ {path}\n@@ @@\n");
    if !old.is_empty() {
        for line in old.split('\n') {
            out.push('-');
            out.push_str(line);
            out.push('\n');
        }
    }
    if !new.is_empty() {
        for line in new.split('\n') {
            out.push('+');
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_text_and_reasoning_in_order() {
        let msg = json!({
            "type": "kimi_message",
            "parts": [
                { "type": "reasoning", "text": "thinking" },
                { "type": "text", "text": "hello" },
            ],
        });
        let parts = render_parts(&msg, "m1", false);
        assert_eq!(parts.len(), 2);
        match &parts[0] {
            MessagePart::Reasoning {
                id,
                text,
                streaming,
                ..
            } => {
                assert_eq!(id, "m1:0");
                assert_eq!(text, "thinking");
                // Not the trailing part → collapsed.
                assert_eq!(streaming, &None);
            }
            other => panic!("expected reasoning, got {other:?}"),
        }
        match &parts[1] {
            MessagePart::Text { id, text } => {
                assert_eq!(id, "m1:1");
                assert_eq!(text, "hello");
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn trailing_reasoning_streams_while_active() {
        let msg =
            json!({ "type": "kimi_message", "parts": [{ "type": "reasoning", "text": "…" }] });
        match &render_parts(&msg, "m1", true)[0] {
            MessagePart::Reasoning { streaming, .. } => assert_eq!(streaming, &Some(true)),
            other => panic!("expected reasoning, got {other:?}"),
        }
    }

    #[test]
    fn generic_tool_uses_title_and_raw_input() {
        let msg = json!({
            "type": "kimi_message",
            "parts": [{
                "type": "tool", "tool_call_id": "t1", "title": "Run tests",
                "kind": "execute", "status": "completed",
                "raw_input": { "command": "npm test" }, "output_text": "ok",
            }],
        });
        match &render_parts(&msg, "m1", false)[0] {
            MessagePart::ToolCall {
                tool_call_id,
                tool_name,
                args,
                result,
                streaming_status,
                is_error,
                ..
            } => {
                assert_eq!(tool_call_id, "t1");
                assert_eq!(tool_name, "Run tests");
                assert_eq!(args["command"], "npm test");
                assert_eq!(result.as_ref().unwrap(), &Value::String("ok".into()));
                assert_eq!(streaming_status, &Some(StreamingStatus::Done));
                assert_eq!(is_error, &None);
            }
            other => panic!("expected tool-call, got {other:?}"),
        }
    }

    #[test]
    fn tool_kind_falls_back_to_canonical_name() {
        let msg = json!({
            "type": "kimi_message",
            "parts": [{ "type": "tool", "tool_call_id": "t1", "kind": "read", "status": "pending" }],
        });
        match &render_parts(&msg, "m1", false)[0] {
            MessagePart::ToolCall {
                tool_name,
                streaming_status,
                ..
            } => {
                assert_eq!(tool_name, "Read");
                assert_eq!(streaming_status, &Some(StreamingStatus::Pending));
            }
            other => panic!("expected tool-call, got {other:?}"),
        }
    }

    #[test]
    fn tool_with_diffs_renders_as_apply_patch() {
        let msg = json!({
            "type": "kimi_message",
            "parts": [{
                "type": "tool", "tool_call_id": "t1", "title": "Edit a.txt",
                "kind": "edit", "status": "completed",
                "diffs": [{ "path": "a.txt", "old_text": "hi", "new_text": "bye" }],
                "output_text": "Edit applied.",
            }],
        });
        match &render_parts(&msg, "m1", false)[0] {
            MessagePart::ToolCall {
                tool_name,
                args,
                result,
                ..
            } => {
                assert_eq!(tool_name, "apply_patch");
                let changes = args["changes"].as_array().unwrap();
                assert_eq!(changes[0]["path"], "a.txt");
                let diff = changes[0]["diff"].as_str().unwrap();
                assert!(diff.contains("-hi"));
                assert!(diff.contains("+bye"));
                // Redundant success summary dropped when a diff is shown.
                assert!(result.is_none());
            }
            other => panic!("expected tool-call, got {other:?}"),
        }
    }

    #[test]
    fn failed_tool_marks_error() {
        let msg = json!({
            "type": "kimi_message",
            "parts": [{ "type": "tool", "tool_call_id": "t1", "title": "Run",
                        "status": "failed", "output_text": "boom" }],
        });
        match &render_parts(&msg, "m1", false)[0] {
            MessagePart::ToolCall {
                is_error,
                streaming_status,
                result,
                ..
            } => {
                assert_eq!(is_error, &Some(true));
                assert_eq!(streaming_status, &Some(StreamingStatus::Error));
                assert_eq!(result.as_ref().unwrap(), &Value::String("boom".into()));
            }
            other => panic!("expected tool-call, got {other:?}"),
        }
    }

    #[test]
    fn failed_tool_with_diffs_keeps_error_output() {
        let msg = json!({
            "type": "kimi_message",
            "parts": [{
                "type": "tool", "tool_call_id": "t1", "title": "Edit a.txt",
                "kind": "edit", "status": "failed",
                "diffs": [{ "path": "a.txt", "old_text": "hi", "new_text": "bye" }],
                "output_text": "Permission denied",
            }],
        });
        match &render_parts(&msg, "m1", false)[0] {
            MessagePart::ToolCall {
                tool_name,
                is_error,
                result,
                ..
            } => {
                assert_eq!(tool_name, "apply_patch");
                assert_eq!(is_error, &Some(true));
                // Failure reason renders even though a diff is shown.
                assert_eq!(
                    result.as_ref().unwrap(),
                    &Value::String("Permission denied".into())
                );
            }
            other => panic!("expected tool-call, got {other:?}"),
        }
    }

    #[test]
    fn plan_renders_as_todo_list() {
        let msg = json!({
            "type": "kimi_message",
            "parts": [{
                "type": "plan",
                "entries": [
                    { "content": "design", "priority": "high", "status": "completed" },
                    { "content": "build", "priority": "high", "status": "in_progress" },
                    { "content": "ship", "priority": "low", "status": "pending" },
                ],
            }],
        });
        match &render_parts(&msg, "m1", false)[0] {
            MessagePart::TodoList { id, items } => {
                assert!(id.starts_with(CLAUDE_TASK_LIST_ID_PREFIX));
                assert_eq!(items.len(), 3);
                assert_eq!(items[0].status, TodoStatus::Completed);
                assert_eq!(items[1].status, TodoStatus::InProgress);
                assert_eq!(items[2].status, TodoStatus::Pending);
            }
            other => panic!("expected todo-list, got {other:?}"),
        }
    }

    #[test]
    fn skips_empty_text() {
        let msg = json!({ "type": "kimi_message", "parts": [{ "type": "text", "text": "" }] });
        assert!(render_parts(&msg, "m1", false).is_empty());
    }
}
