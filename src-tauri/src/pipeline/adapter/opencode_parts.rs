//! Render opencode's native `opencode_message` into universal `MessagePart`s.
//! Shared by the live-stream path and historical reload.

use serde_json::{json, Value};

use super::super::types::{
    ExtendedMessagePart, ImageSource, MessagePart, NoticeSeverity, StreamingStatus, TodoItem,
    TodoStatus,
};
use super::blocks::CLAUDE_TASK_LIST_ID_PREFIX;

// `msg_id` seeds stable keys (`<msg_id>:<index>`). On a live partial the
// trailing part is the actively-generating one.
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

// opencode reasoning parts carry `time: { start, end }` (epoch ms); the gap is
// the "Thought for Ns" duration, available once the block closes (`end` set).
fn reasoning_duration_ms(part: &Value) -> Option<u64> {
    let time = part.get("time")?;
    let start = time.get("start").and_then(Value::as_f64)?;
    let end = time.get("end").and_then(Value::as_f64)?;
    let dur = end - start;
    (dur > 0.0).then_some(dur.round() as u64)
}

fn render_part(part: &Value, id: String, streaming_now: bool) -> Option<MessagePart> {
    let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
    let text = part.get("text").and_then(Value::as_str).unwrap_or_default();
    match kind {
        "text" => (!text.is_empty()).then(|| MessagePart::Text {
            id,
            text: text.to_string(),
        }),
        "reasoning" => (!text.is_empty()).then(|| MessagePart::Reasoning {
            id,
            text: text.to_string(),
            // Some(true) → expanded while streaming; None → collapsed.
            streaming: streaming_now.then_some(true),
            // "Thought for Ns" once the block closes (time.end present).
            duration_ms: reasoning_duration_ms(part),
        }),
        "tool" => {
            let tool = part.get("tool").and_then(Value::as_str).unwrap_or("tool");
            if tool == "todowrite" || tool == "todoread" {
                render_todo(part, &id)
            } else {
                Some(render_tool(part))
            }
        }
        "file" => Some(render_file(part, id)),
        "retry" => {
            let attempt = part.get("attempt").and_then(Value::as_i64);
            let body = part
                .get("message")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let label = match attempt {
                Some(n) => format!("Retrying (attempt {n})"),
                None => "Retrying after error".to_string(),
            };
            Some(MessagePart::SystemNotice {
                id,
                severity: NoticeSeverity::Warning,
                label,
                body,
            })
        }
        "compaction" => {
            let auto = part.get("auto").and_then(Value::as_bool).unwrap_or(false);
            Some(MessagePart::SystemNotice {
                id,
                severity: NoticeSeverity::Info,
                label: if auto {
                    "Context auto-compacted".to_string()
                } else {
                    "Context compacted".to_string()
                },
                body: None,
            })
        }
        "system-notice" => Some(render_system_notice(part, id)),
        _ => None,
    }
}

fn render_system_notice(part: &Value, id: String) -> MessagePart {
    let severity = match part.get("severity").and_then(Value::as_str) {
        Some("error") => NoticeSeverity::Error,
        Some("warning") => NoticeSeverity::Warning,
        _ => NoticeSeverity::Info,
    };
    let label = part
        .get("label")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("Notice")
        .to_string();
    let body = part
        .get("body")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    MessagePart::SystemNotice {
        id,
        severity,
        label,
        body,
    }
}

// Uses the Claude task-list id prefix so `collapse_task_todo_lists` folds
// repeated calls to the latest snapshot.
fn render_todo(part: &Value, id: &str) -> Option<MessagePart> {
    let todos = part
        .get("input")
        .and_then(|i| i.get("todos"))
        .and_then(Value::as_array)?;
    let items: Vec<TodoItem> = todos
        .iter()
        .filter_map(|t| {
            let text = t.get("content").and_then(Value::as_str)?.to_string();
            let status = match t.get("status").and_then(Value::as_str).unwrap_or("pending") {
                "in_progress" => TodoStatus::InProgress,
                "completed" | "cancelled" => TodoStatus::Completed,
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

fn render_file(part: &Value, id: String) -> MessagePart {
    let mime = part.get("mime").and_then(Value::as_str).unwrap_or_default();
    let url = part.get("url").and_then(Value::as_str).unwrap_or_default();
    let filename = part.get("filename").and_then(Value::as_str);
    if mime.starts_with("image/") {
        MessagePart::Image {
            id,
            source: image_source_from_url(url),
            media_type: (!mime.is_empty()).then(|| mime.to_string()),
        }
    } else {
        MessagePart::FileMention {
            id,
            path: filename
                .filter(|s| !s.is_empty())
                .unwrap_or(url)
                .to_string(),
        }
    }
}

// url is `data:<mime>;base64,…`, `file://…`, or an http URL.
fn image_source_from_url(url: &str) -> ImageSource {
    if let Some(rest) = url.strip_prefix("data:") {
        if let Some(pos) = rest.find("base64,") {
            return ImageSource::Base64 {
                data: rest[pos + "base64,".len()..].to_string(),
            };
        }
    }
    if let Some(path) = url.strip_prefix("file://") {
        return ImageSource::File {
            path: path.to_string(),
        };
    }
    ImageSource::Url {
        url: url.to_string(),
    }
}

// Tool name + arg keys normalized to the universal vocabulary here so the
// frontend renders opencode tools with the same code path as Claude/Codex.
fn render_tool(part: &Value) -> MessagePart {
    let call_id = part
        .get("callID")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let native_tool = part.get("tool").and_then(Value::as_str).unwrap_or("tool");
    let native_input = part
        .get("input")
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    // opencode surfaced per-file unified diffs (edit/write/apply_patch) → render
    // through the shared apply_patch diff view (`changes: [{path, diff}]`); the
    // frontend already draws this (green +/red -). Else use the name mapping.
    let file_diffs = part
        .get("fileDiffs")
        .and_then(Value::as_array)
        .filter(|c| !c.is_empty());
    let (tool_name, args) = match file_diffs {
        Some(changes) => ("apply_patch".to_string(), json!({ "changes": changes })),
        None => canonical_tool(native_tool, &native_input),
    };
    let args_text = serde_json::to_string(&args).unwrap_or_default();
    let status = part
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pending");
    let is_error = part
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let result = part.get("output").and_then(Value::as_str).and_then(|o| {
        // With a rendered diff the success summary ("Wrote file…", the M-file
        // list) is redundant — drop it, but keep output that carries extra
        // feedback (e.g. LSP errors).
        if file_diffs.is_some() && !o.contains("LSP") {
            None
        } else {
            Some(Value::String(o.to_string()))
        }
    });
    let streaming_status = match status {
        "pending" => Some(StreamingStatus::Pending),
        "running" => Some(StreamingStatus::Running),
        "completed" => Some(StreamingStatus::Done),
        "error" => Some(StreamingStatus::Error),
        _ => None,
    };
    let children: Vec<ExtendedMessagePart> = part
        .get("children")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .enumerate()
                .filter_map(|(i, child)| render_part(child, format!("{call_id}:child:{i}"), false))
                .map(ExtendedMessagePart::Basic)
                .collect()
        })
        .unwrap_or_default();
    MessagePart::ToolCall {
        tool_call_id: call_id,
        tool_name,
        args,
        args_text,
        result,
        is_error: is_error.then_some(true),
        streaming_status,
        task_state: None,
        children,
    }
}

// Unknown tools pass through verbatim (generic UI fallback renders by name).
fn canonical_tool(tool: &str, input: &Value) -> (String, Value) {
    match tool {
        "bash" => ("Bash".into(), input.clone()),
        "read" => (
            "Read".into(),
            rename_args(input, &[("filePath", "file_path")]),
        ),
        "write" => (
            "Write".into(),
            rename_args(input, &[("filePath", "file_path")]),
        ),
        "edit" => (
            "Edit".into(),
            rename_args(
                input,
                &[
                    ("filePath", "file_path"),
                    ("oldString", "old_string"),
                    ("newString", "new_string"),
                ],
            ),
        ),
        "grep" => ("Grep".into(), input.clone()),
        "glob" => ("Glob".into(), input.clone()),
        "webfetch" => ("WebFetch".into(), input.clone()),
        "websearch" => ("WebSearch".into(), input.clone()),
        "task" => ("Task".into(), input.clone()),
        "skill" => ("Skill".into(), input.clone()),
        other => (other.to_string(), input.clone()),
    }
}

fn rename_args(input: &Value, renames: &[(&str, &str)]) -> Value {
    let Some(obj) = input.as_object() else {
        return input.clone();
    };
    let mut out = serde_json::Map::with_capacity(obj.len());
    for (key, value) in obj {
        let mapped = renames
            .iter()
            .find(|(from, _)| from == key)
            .map(|(_, to)| (*to).to_string())
            .unwrap_or_else(|| key.clone());
        out.insert(mapped, value.clone());
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_text_and_reasoning_parts_in_order() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [
                { "type": "reasoning", "text": "thinking" },
                { "type": "text", "text": "hello" },
            ],
        });
        let parts = render_parts(&msg, "m1", false);
        assert_eq!(parts.len(), 2);
        match &parts[0] {
            MessagePart::Reasoning { id, text, .. } => {
                assert_eq!(id, "m1:0");
                assert_eq!(text, "thinking");
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
    fn reasoning_carries_thought_duration_from_time() {
        // Closed reasoning block: time.end - time.start → "Thought for Ns".
        let msg = json!({
            "type": "opencode_message",
            "parts": [{
                "type": "reasoning", "text": "thinking",
                "time": { "start": 1_780_746_688_918u64, "end": 1_780_746_690_443u64 },
            }],
        });
        match &render_parts(&msg, "m1", false)[0] {
            MessagePart::Reasoning { duration_ms, .. } => {
                assert_eq!(*duration_ms, Some(1525));
            }
            other => panic!("expected reasoning, got {other:?}"),
        }
        // Still-open block (no end) → no duration yet.
        let open = json!({
            "type": "opencode_message",
            "parts": [{ "type": "reasoning", "text": "thinking", "time": { "start": 1u64 } }],
        });
        match &render_parts(&open, "m1", false)[0] {
            MessagePart::Reasoning { duration_ms, .. } => assert_eq!(*duration_ms, None),
            other => panic!("expected reasoning, got {other:?}"),
        }
    }

    #[test]
    fn write_tool_with_file_diffs_renders_as_apply_patch() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [{
                "type": "tool", "callID": "c1", "tool": "write", "status": "completed",
                "input": { "filePath": "/tmp/a.txt", "content": "hi" },
                "output": "Wrote file successfully.",
                "fileDiffs": [{ "path": "a.txt", "diff": "--- a.txt\n+++ a.txt\n@@\n+hi\n" }],
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
                assert!(changes[0]["diff"].as_str().unwrap().contains("+hi"));
                // Redundant success summary dropped — the diff conveys it.
                assert!(result.is_none());
            }
            other => panic!("expected tool-call, got {other:?}"),
        }
    }

    #[test]
    fn diff_tool_keeps_lsp_feedback_in_result() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [{
                "type": "tool", "callID": "c1", "tool": "edit", "status": "completed",
                "input": { "filePath": "/tmp/a.txt" },
                "output": "Edit applied successfully.\n\nLSP errors detected in this file:\nfoo",
                "fileDiffs": [{ "path": "a.txt", "diff": "--- a.txt\n+++ a.txt\n@@\n-x\n+y\n" }],
            }],
        });
        match &render_parts(&msg, "m1", false)[0] {
            MessagePart::ToolCall {
                tool_name, result, ..
            } => {
                assert_eq!(tool_name, "apply_patch");
                assert!(result
                    .as_ref()
                    .and_then(|r| r.as_str())
                    .unwrap()
                    .contains("LSP errors"));
            }
            other => panic!("expected tool-call, got {other:?}"),
        }
    }

    #[test]
    fn skips_empty_text() {
        let msg = json!({ "type": "opencode_message", "parts": [{ "type": "text", "text": "" }] });
        assert!(render_parts(&msg, "m1", false).is_empty());
    }

    #[test]
    fn reasoning_streams_while_it_is_the_trailing_part() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [{ "type": "reasoning", "text": "thinking…" }],
        });
        // Live partial, reasoning is the trailing (active) part → expanded.
        match &render_parts(&msg, "m1", true)[0] {
            MessagePart::Reasoning { streaming, .. } => assert_eq!(streaming, &Some(true)),
            other => panic!("expected reasoning, got {other:?}"),
        }
        // Finalized / historical → collapsed.
        match &render_parts(&msg, "m1", false)[0] {
            MessagePart::Reasoning { streaming, .. } => assert_eq!(streaming, &None),
            other => panic!("expected reasoning, got {other:?}"),
        }
    }

    #[test]
    fn reasoning_collapses_once_the_model_moves_past_it() {
        // Mid-stream but no longer trailing → collapses.
        let msg = json!({
            "type": "opencode_message",
            "parts": [
                { "type": "reasoning", "text": "thought" },
                { "type": "text", "text": "answer" },
            ],
        });
        match &render_parts(&msg, "m1", true)[0] {
            MessagePart::Reasoning { streaming, .. } => assert_eq!(streaming, &None),
            other => panic!("expected reasoning, got {other:?}"),
        }
    }

    #[test]
    fn tool_part_normalized_to_universal_vocabulary() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [{
                "type": "tool",
                "callID": "call_1",
                "tool": "bash",
                "status": "completed",
                "input": { "command": "ls" },
                "output": "file.txt",
            }],
        });
        let parts = render_parts(&msg, "m1", false);
        assert_eq!(parts.len(), 1);
        match &parts[0] {
            MessagePart::ToolCall {
                tool_call_id,
                tool_name,
                args,
                result,
                streaming_status,
                is_error,
                ..
            } => {
                assert_eq!(tool_call_id, "call_1");
                assert_eq!(tool_name, "Bash");
                assert_eq!(args["command"], "ls");
                assert_eq!(result.as_ref().unwrap(), &Value::String("file.txt".into()));
                assert_eq!(streaming_status, &Some(StreamingStatus::Done));
                assert_eq!(is_error, &None);
            }
            other => panic!("expected tool-call, got {other:?}"),
        }
    }

    #[test]
    fn edit_tool_normalizes_name_and_camelcase_args() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [{
                "type": "tool", "callID": "c1", "tool": "edit", "status": "completed",
                "input": {
                    "filePath": "/tmp/a.txt",
                    "oldString": "hello",
                    "newString": "world",
                },
                "output": "Edit applied.",
            }],
        });
        let parts = render_parts(&msg, "m1", false);
        match &parts[0] {
            MessagePart::ToolCall {
                tool_name, args, ..
            } => {
                assert_eq!(tool_name, "Edit");
                assert_eq!(args["file_path"], "/tmp/a.txt");
                assert_eq!(args["old_string"], "hello");
                assert_eq!(args["new_string"], "world");
                assert!(args.get("oldString").is_none());
            }
            other => panic!("expected tool-call, got {other:?}"),
        }
    }

    #[test]
    fn renders_tool_error() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [{
                "type": "tool", "callID": "c2", "tool": "edit", "status": "error",
                "input": {}, "output": "boom", "isError": true,
            }],
        });
        let parts = render_parts(&msg, "m1", false);
        match &parts[0] {
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
    fn todowrite_renders_as_unified_todo_list() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [{
                "type": "tool", "callID": "c1", "tool": "todowrite", "status": "completed",
                "input": { "todos": [
                    { "content": "analyze", "status": "completed", "priority": "high" },
                    { "content": "write", "status": "in_progress", "priority": "high" },
                    { "content": "fix", "status": "pending", "priority": "low" },
                    { "content": "skip", "status": "cancelled", "priority": "low" },
                ] },
            }],
        });
        let parts = render_parts(&msg, "m1", false);
        assert_eq!(parts.len(), 1);
        match &parts[0] {
            MessagePart::TodoList { id, items } => {
                assert!(id.starts_with(CLAUDE_TASK_LIST_ID_PREFIX));
                assert_eq!(items.len(), 4);
                assert_eq!(items[0].status, TodoStatus::Completed);
                assert_eq!(items[1].status, TodoStatus::InProgress);
                assert_eq!(items[2].status, TodoStatus::Pending);
                // cancelled folds to Completed (no Cancelled variant).
                assert_eq!(items[3].status, TodoStatus::Completed);
            }
            other => panic!("expected todo-list, got {other:?}"),
        }
    }

    #[test]
    fn file_part_image_renders_inline_image() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [
                { "type": "file", "mime": "image/png", "filename": "shot.png",
                  "url": "data:image/png;base64,QUJD" },
                { "type": "file", "mime": "application/pdf", "filename": "doc.pdf",
                  "url": "file:///tmp/doc.pdf" },
            ],
        });
        let parts = render_parts(&msg, "m1", false);
        assert_eq!(parts.len(), 2);
        match &parts[0] {
            MessagePart::Image {
                source, media_type, ..
            } => {
                assert_eq!(media_type.as_deref(), Some("image/png"));
                match source {
                    ImageSource::Base64 { data } => assert_eq!(data, "QUJD"),
                    other => panic!("expected base64 source, got {other:?}"),
                }
            }
            other => panic!("expected image, got {other:?}"),
        }
        match &parts[1] {
            MessagePart::FileMention { path, .. } => assert_eq!(path, "doc.pdf"),
            other => panic!("expected file-mention, got {other:?}"),
        }
    }

    #[test]
    fn retry_and_compaction_render_as_system_notices() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [
                { "type": "retry", "attempt": 2, "message": "rate limited" },
                { "type": "compaction", "auto": true },
            ],
        });
        let parts = render_parts(&msg, "m1", false);
        assert_eq!(parts.len(), 2);
        match &parts[0] {
            MessagePart::SystemNotice {
                severity,
                label,
                body,
                ..
            } => {
                assert_eq!(severity, &NoticeSeverity::Warning);
                assert_eq!(label, "Retrying (attempt 2)");
                assert_eq!(body.as_deref(), Some("rate limited"));
            }
            other => panic!("expected system-notice, got {other:?}"),
        }
        match &parts[1] {
            MessagePart::SystemNotice {
                severity, label, ..
            } => {
                assert_eq!(severity, &NoticeSeverity::Info);
                assert_eq!(label, "Context auto-compacted");
            }
            other => panic!("expected system-notice, got {other:?}"),
        }
    }

    #[test]
    fn session_error_notice_renders_as_error_system_notice() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [{
                "type": "system-notice",
                "severity": "error",
                "label": "OpenCode error",
                "body": "Quota exceeded. Try again in 5 hours.",
            }],
        });
        let parts = render_parts(&msg, "m1", true);
        assert_eq!(parts.len(), 1);
        match &parts[0] {
            MessagePart::SystemNotice {
                severity,
                label,
                body,
                ..
            } => {
                assert_eq!(severity, &NoticeSeverity::Error);
                assert_eq!(label, "OpenCode error");
                assert_eq!(
                    body.as_deref(),
                    Some("Quota exceeded. Try again in 5 hours.")
                );
            }
            other => panic!("expected system-notice, got {other:?}"),
        }
    }

    #[test]
    fn task_tool_nests_subagent_children() {
        let msg = json!({
            "type": "opencode_message",
            "parts": [{
                "type": "tool", "callID": "task_1", "tool": "task", "status": "completed",
                "input": { "description": "Echo", "subagent_type": "general" },
                "output": "<task_result>done</task_result>",
                "children": [
                    { "type": "reasoning", "text": "child thinking" },
                    { "type": "tool", "callID": "cc1", "tool": "bash", "status": "completed",
                      "input": { "command": "echo hi" }, "output": "hi" },
                    { "type": "text", "text": "child reply" },
                ],
            }],
        });
        let parts = render_parts(&msg, "m1", false);
        assert_eq!(parts.len(), 1);
        match &parts[0] {
            MessagePart::ToolCall {
                tool_name,
                children,
                ..
            } => {
                assert_eq!(tool_name, "Task");
                assert_eq!(children.len(), 3);
                // Nested tools are normalized too (bash → Bash).
                match &children[1] {
                    ExtendedMessagePart::Basic(MessagePart::ToolCall {
                        tool_name, args, ..
                    }) => {
                        assert_eq!(tool_name, "Bash");
                        assert_eq!(args["command"], "echo hi");
                    }
                    other => panic!("expected nested bash tool, got {other:?}"),
                }
            }
            other => panic!("expected task tool-call, got {other:?}"),
        }
    }
}
