//! Content-block parsing and tool-result merging.
//!
//! Owns every helper that turns a Claude `assistant.message.content[]`
//! block (or a `user.message.content[]` `tool_result` block) into a
//! `MessagePart`. Includes the TodoWrite/TodoList collapse, image and
//! document parsing, server-tool result attachment, and the lookahead
//! merge that pairs `tool_result` payloads with their owning `tool_use`.

use serde_json::Value;

use crate::pipeline::types::{
    ExtendedMessagePart, ImageSource, MessagePart, StreamingStatus, TodoItem, TodoStatus,
};

pub(super) fn parse_assistant_parts(parsed: Option<&Value>) -> Vec<MessagePart> {
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
                    let is_streaming = obj
                        .get("__is_streaming")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    parts.push(MessagePart::Reasoning {
                        text: text.to_string(),
                        streaming: if is_streaming { Some(true) } else { None },
                    });
                }
            }
            "redacted_thinking" => {
                parts.push(MessagePart::Reasoning {
                    text: "[Thinking redacted]".to_string(),
                    streaming: None,
                });
            }
            "text" => {
                if let Some(text) = obj.get("text").and_then(Value::as_str) {
                    parts.push(MessagePart::Text {
                        text: text.to_string(),
                    });
                }
            }
            "image" => {
                if let Some(part) = parse_image_block(obj) {
                    parts.push(part);
                }
            }
            "document" => {
                if let Some(text) = parse_document_block(obj) {
                    parts.push(MessagePart::Text { text });
                }
            }
            // All Claude server-tool *_tool_result blocks. The block
            // carries a `tool_use_id` pointing back at the matching
            // `server_tool_use` — we attach its serialized payload to
            // the ToolCall part with that exact id so the frontend's
            // existing tool card renders the output without per-block
            // code paths. Strict id matching only — matching "the most
            // recent ToolCall" would misroute the result whenever the
            // SDK interleaves an unrelated block (text/thinking)
            // between the server_tool_use and its result.
            "web_search_tool_result"
            | "web_fetch_tool_result"
            | "code_execution_tool_result"
            | "bash_code_execution_tool_result"
            | "text_editor_code_execution_tool_result"
            | "tool_search_tool_result" => {
                attach_server_tool_result(&mut parts, obj);
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

                // Claude TodoWrite collapses into the unified TodoList
                // part so the frontend renders it identically to Codex
                // todo_list. We only do this once the input has been
                // fully streamed — partial streaming arrives via stream
                // events with no `todos` array yet, in which case we
                // fall through to the regular ToolCall.
                if tool_name == "TodoWrite" {
                    if let Some(items) = parse_claude_todowrite_items(&args) {
                        parts.push(MessagePart::TodoList { items });
                        continue;
                    }
                }

                parts.push(MessagePart::ToolCall {
                    tool_call_id,
                    tool_name,
                    args,
                    args_text,
                    result: None,
                    is_error: None,
                    tool_use_result: None,
                    streaming_status: stream_status,
                    children: Vec::new(),
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

struct ToolResultEntry {
    tool_use_id: String,
    content: String,
    is_error: Option<bool>,
    tool_use_result: Option<Value>,
}

/// Parse tool_result blocks from a `type=user` payload. Returns None if the
/// payload is not a pure tool_result message.
fn extract_tool_results(parsed: Option<&Value>) -> Option<Vec<ToolResultEntry>> {
    let parsed = parsed?;
    // `tool_use_result` lives on the SDKUserMessage envelope, not inside content[].
    let envelope_tool_use_result = parsed.get("tool_use_result").cloned();
    let msg = parsed.get("message").and_then(|v| v.as_object());
    let blocks = msg.and_then(|m| m.get("content")).and_then(Value::as_array);
    let blocks = match blocks {
        Some(b) if !b.is_empty() => b,
        _ => return None,
    };

    let mut all_tool_result = true;
    let mut results: Vec<ToolResultEntry> = Vec::new();

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
            // Collapse `is_error: false` to None so the field is a positive failure signal.
            let is_error = match obj.get("is_error").and_then(Value::as_bool) {
                Some(true) => Some(true),
                _ => None,
            };
            // Skip the envelope on success — it duplicates `content` as kilobytes of stdout.
            let tool_use_result = if is_error.is_some() {
                envelope_tool_use_result.clone()
            } else {
                None
            };
            results.push(ToolResultEntry {
                tool_use_id,
                content,
                is_error,
                tool_use_result,
            });
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
        return None;
    }
    Some(results)
}

pub(super) fn merge_tool_results(parsed: Option<&Value>, target_parts: &mut [MessagePart]) -> bool {
    let results = match extract_tool_results(parsed) {
        Some(r) => r,
        None => return false,
    };
    for entry in results {
        for part in target_parts.iter_mut() {
            if let MessagePart::ToolCall {
                tool_call_id,
                result,
                is_error,
                tool_use_result,
                ..
            } = part
            {
                if *tool_call_id == entry.tool_use_id {
                    *result = Some(Value::String(entry.content));
                    *is_error = entry.is_error;
                    *tool_use_result = entry.tool_use_result;
                    break;
                }
            }
        }
    }
    true
}

/// Like `merge_tool_results` but operates directly on `ExtendedMessagePart`
/// slices, avoiding the clone-out / clone-back round-trip that the
/// `type=user` late-merge path previously required.
pub(super) fn merge_tool_results_extended(
    parsed: Option<&Value>,
    target: &mut [ExtendedMessagePart],
) -> bool {
    let results = match extract_tool_results(parsed) {
        Some(r) => r,
        None => return false,
    };
    for entry in results {
        for part in target.iter_mut() {
            if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
                tool_call_id,
                result,
                is_error,
                tool_use_result,
                ..
            }) = part
            {
                if *tool_call_id == entry.tool_use_id {
                    *result = Some(Value::String(entry.content));
                    *is_error = entry.is_error;
                    *tool_use_result = entry.tool_use_result;
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
// Block-level parsers
// ---------------------------------------------------------------------------

/// Parse a Claude `document` content block into a textual fallback.
/// We don't have a dedicated Document part — render the source's
/// `data` (PlainTextSource) when available, otherwise an inline
/// "Document attached" placeholder.
fn parse_document_block(obj: &serde_json::Map<String, Value>) -> Option<String> {
    let source = obj.get("source").and_then(Value::as_object)?;
    let source_type = source.get("type").and_then(Value::as_str);
    match source_type {
        Some("text") => source
            .get("data")
            .and_then(Value::as_str)
            .map(str::to_string),
        Some("base64") => Some("[Document attached]".to_string()),
        _ => Some("[Document attached]".to_string()),
    }
}

/// Attach a Claude server-tool *_tool_result block to the matching
/// ToolCall by `tool_use_id`. The result block carries the id of the
/// `server_tool_use` it belongs to; we look it up exactly so a result
/// block can never misroute even if the SDK interleaves unrelated
/// blocks between the tool use and its result. If the result block
/// has no `tool_use_id`, or no matching ToolCall exists in `parts`,
/// the block is dropped silently — same as the `_` arm in
/// `parse_assistant_parts`.
fn attach_server_tool_result(parts: &mut [MessagePart], obj: &serde_json::Map<String, Value>) {
    let target_id = match obj.get("tool_use_id").and_then(Value::as_str) {
        Some(id) => id,
        None => return,
    };
    let result_value = Value::Object(obj.clone());
    for part in parts.iter_mut().rev() {
        if let MessagePart::ToolCall {
            tool_call_id,
            result,
            ..
        } = part
        {
            if tool_call_id == target_id {
                *result = Some(result_value);
                return;
            }
        }
    }
}

/// Parse a Claude `image` content block into a MessagePart::Image.
/// Recognizes both base64 (`{type: "base64", data, media_type}`) and
/// url (`{type: "url", url}`) source variants. Returns None for any
/// shape we can't decode so the parser stays liberal.
fn parse_image_block(obj: &serde_json::Map<String, Value>) -> Option<MessagePart> {
    let source = obj.get("source")?.as_object()?;
    let source_type = source.get("type").and_then(Value::as_str);
    match source_type {
        Some("base64") => {
            let data = source.get("data").and_then(Value::as_str)?.to_string();
            let media_type = source
                .get("media_type")
                .and_then(Value::as_str)
                .map(str::to_string);
            Some(MessagePart::Image {
                source: ImageSource::Base64 { data },
                media_type,
            })
        }
        Some("url") => {
            let url = source.get("url").and_then(Value::as_str)?.to_string();
            Some(MessagePart::Image {
                source: ImageSource::Url { url },
                media_type: None,
            })
        }
        _ => None,
    }
}

/// Parse Claude `TodoWrite` tool input into the unified TodoItem shape.
/// Returns None when the args are still streaming (empty object) or
/// missing the `todos` array — the caller falls back to a regular
/// ToolCall in that case.
fn parse_claude_todowrite_items(args: &Value) -> Option<Vec<TodoItem>> {
    let todos = args.get("todos")?.as_array()?;
    let items: Vec<TodoItem> = todos
        .iter()
        .filter_map(|t| {
            let obj = t.as_object()?;
            // Claude uses `content` for the human-readable text and
            // `status` ∈ {pending, in_progress, completed}.
            let text = obj.get("content").and_then(Value::as_str)?.to_string();
            let status = match obj.get("status").and_then(Value::as_str) {
                Some("completed") => TodoStatus::Completed,
                Some("in_progress") => TodoStatus::InProgress,
                _ => TodoStatus::Pending,
            };
            Some(TodoItem { text, status })
        })
        .collect();
    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

/// Parse a Codex `todo_list` item payload into the unified TodoItem shape.
/// Codex uses `text` + `completed` (boolean), with no in-progress state —
/// we map `completed: true` → Completed and the rest → Pending.
pub(super) fn parse_codex_todolist_items(item: &Value) -> Option<Vec<TodoItem>> {
    let arr = item.get("items")?.as_array()?;
    let items: Vec<TodoItem> = arr
        .iter()
        .filter_map(|t| {
            let obj = t.as_object()?;
            let text = obj.get("text").and_then(Value::as_str)?.to_string();
            let completed = obj
                .get("completed")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Some(TodoItem {
                text,
                status: if completed {
                    TodoStatus::Completed
                } else {
                    TodoStatus::Pending
                },
            })
        })
        .collect();
    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}
