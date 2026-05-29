//! Content-block parsing and tool-result merging.
//!
//! Owns every helper that turns a Claude `assistant.message.content[]`
//! block (or a `user.message.content[]` `tool_result` block) into a
//! `MessagePart`. Includes the TodoWrite/TodoList collapse, image and
//! document parsing, server-tool result attachment, and the lookahead
//! merge that pairs `tool_result` payloads with their owning `tool_use`.

use std::collections::HashMap;

use serde_json::Value;

use crate::pipeline::types::{
    ExtendedMessagePart, ImageSource, IntermediateMessage, MessagePart, NoticeSeverity,
    StreamingStatus, ThreadMessageLike, TodoItem, TodoStatus,
};

/// Returns true when an assistant message contains at least one
/// content block whose `type` is in our known set. `convert_flat`
/// uses this to suppress the text-fallback path when a message
/// contained ONLY recognized-but-non-emitting blocks (e.g. an
/// `mcp_tool_result` that attaches to a previous ToolCall via the
/// late merge — its parts list is empty by design).
pub(super) fn assistant_has_recognized_blocks(parsed: Option<&Value>) -> bool {
    let Some(parsed) = parsed else {
        return false;
    };
    let Some(blocks) = parsed
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    blocks.iter().any(|b| {
        let Some(t) = b.get("type").and_then(Value::as_str) else {
            return false;
        };
        matches!(
            t,
            "text"
                | "thinking"
                | "redacted_thinking"
                | "tool_use"
                | "server_tool_use"
                | "mcp_tool_use"
                | "mcp_tool_result"
                | "image"
                | "document"
                | "container_upload"
                | "compaction"
                | "web_search_tool_result"
                | "web_fetch_tool_result"
                | "code_execution_tool_result"
                | "bash_code_execution_tool_result"
                | "text_editor_code_execution_tool_result"
                | "tool_search_tool_result"
        )
    })
}

/// Read the stable part id stamped onto a block by the accumulator
/// (`__part_id`). Falls back to a deterministic `{msg_id}:blk:{idx}`
/// synthesis for historical rows written before stable ids landed.
fn resolve_part_id(obj: &serde_json::Map<String, Value>, msg_id: &str, idx: usize) -> String {
    obj.get("__part_id")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{msg_id}:blk:{idx}"))
}

/// Id prefix stamped onto every `TodoList` part synthesized from the Claude
/// Task family. `collapse_task_todo_lists` keys off this so it folds the
/// whole Task sequence into one evolving widget while leaving TodoWrite- and
/// Codex-sourced lists untouched.
pub(super) const CLAUDE_TASK_LIST_ID_PREFIX: &str = "claude-task:";

/// Cross-message accumulator for the Claude Task tool family
/// (`TaskCreate` / `TaskUpdate`), which replaced `TodoWrite` for SDK and
/// headless sessions in claude-agent-sdk v0.3.142.
///
/// Unlike `TodoWrite` (a full snapshot per call), the Task family is
/// incremental: `TaskCreate` adds a task and the CLI assigns it a
/// sequential id (`"1"`, `"2"`, `"3"`…) by creation order; `TaskUpdate`
/// patches a task by that id. To present the same single evolving plan
/// widget the user saw with `TodoWrite`, the adapter threads one of these
/// across the whole message list, emitting a cumulative `TodoList` on each
/// state-changing call. `convert` then folds consecutive `TodoList` parts
/// into one (see `collapse_consecutive_todo_lists`).
#[derive(Default)]
pub(super) struct TaskListState {
    /// Task ids in creation order — drives the rendered row order.
    order: Vec<String>,
    /// id → (text, status). Text is the task `subject`.
    tasks: std::collections::HashMap<String, (String, TodoStatus)>,
    /// Count of `TaskCreate` seen → the next sequential id.
    created: usize,
}

fn parse_task_status(s: &str) -> TodoStatus {
    match s {
        "completed" => TodoStatus::Completed,
        "in_progress" => TodoStatus::InProgress,
        _ => TodoStatus::Pending,
    }
}

impl TaskListState {
    /// Apply a Task-family `tool_use` and return the cumulative TodoList
    /// items if the block was a recognized, complete state mutation.
    /// Returns `None` when the caller should fall back to a plain ToolCall:
    /// a `TaskCreate` still streaming its input (no `subject`), or a
    /// `TaskUpdate` referencing a task we never saw created.
    fn apply(&mut self, name: &str, input: &Value) -> Option<Vec<TodoItem>> {
        match name {
            "TaskCreate" => {
                let subject = input.get("subject").and_then(Value::as_str)?;
                self.created += 1;
                let id = self.created.to_string();
                let status = input
                    .get("status")
                    .and_then(Value::as_str)
                    .map(parse_task_status)
                    .unwrap_or(TodoStatus::Pending);
                self.order.push(id.clone());
                self.tasks.insert(id, (subject.to_string(), status));
                Some(self.snapshot())
            }
            "TaskUpdate" => {
                let id = input.get("taskId").and_then(Value::as_str)?;
                if !self.tasks.contains_key(id) {
                    return None;
                }
                let new_status = input.get("status").and_then(Value::as_str);
                let new_subject = input.get("subject").and_then(Value::as_str);
                // A TaskUpdate that touches neither a field we render (status,
                // subject) — e.g. an owner-only or addBlocks-only update —
                // doesn't change the list. Fall back to a plain ToolCall
                // rather than re-emit an identical snapshot.
                if new_status.is_none() && new_subject.is_none() {
                    return None;
                }
                // A `deleted` status drops the task from the list entirely.
                if new_status == Some("deleted") {
                    self.tasks.remove(id);
                    self.order.retain(|x| x != id);
                    return Some(self.snapshot());
                }
                if let Some((text, status)) = self.tasks.get_mut(id) {
                    if let Some(s) = new_status {
                        *status = parse_task_status(s);
                    }
                    if let Some(subj) = new_subject {
                        *text = subj.to_string();
                    }
                }
                Some(self.snapshot())
            }
            _ => None,
        }
    }

    fn snapshot(&self) -> Vec<TodoItem> {
        self.order
            .iter()
            .filter_map(|id| {
                self.tasks.get(id).map(|(text, status)| TodoItem {
                    text: text.clone(),
                    status: status.clone(),
                })
            })
            .collect()
    }
}

/// Stateless convenience wrapper for unit tests that exercise a single
/// message in isolation. Production code (and the streaming-partial path via
/// `convert`) always goes through `parse_assistant_parts_stateful` with a
/// `TaskListState` shared across the whole message list — Task-family
/// accumulation is inherently cross-message. With a fresh state here an
/// isolated `TaskCreate` still collapses, but a bare `TaskUpdate` falls back
/// to a ToolCall (no prior task to patch).
#[cfg(test)]
pub(super) fn parse_assistant_parts(parsed: Option<&Value>, msg_id: &str) -> Vec<MessagePart> {
    let mut task_state = TaskListState::default();
    parse_assistant_parts_stateful(parsed, msg_id, &mut task_state)
}

pub(super) fn parse_assistant_parts_stateful(
    parsed: Option<&Value>,
    msg_id: &str,
    task_state: &mut TaskListState,
) -> Vec<MessagePart> {
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
                    // Tri-state: true = still streaming, false = live-just-
                    // finished (present on partials + `handle_assistant`
                    // output), missing = historical / unknown.
                    let streaming = obj.get("__is_streaming").and_then(Value::as_bool);
                    let duration_ms = obj.get("__duration_ms").and_then(Value::as_u64);
                    parts.push(MessagePart::Reasoning {
                        id: resolve_part_id(obj, msg_id, idx),
                        text: text.to_string(),
                        streaming,
                        duration_ms,
                    });
                }
            }
            "redacted_thinking" => {
                parts.push(MessagePart::Reasoning {
                    id: resolve_part_id(obj, msg_id, idx),
                    text: "[Thinking redacted]".to_string(),
                    streaming: None,
                    duration_ms: None,
                });
            }
            "text" => {
                if let Some(text) = obj.get("text").and_then(Value::as_str) {
                    parts.push(MessagePart::Text {
                        id: resolve_part_id(obj, msg_id, idx),
                        text: text.to_string(),
                    });
                }
            }
            "image" => {
                if let Some(part) = parse_image_block(obj, msg_id, idx) {
                    parts.push(part);
                }
            }
            "document" => {
                if let Some(text) = parse_document_block(obj) {
                    parts.push(MessagePart::Text {
                        id: resolve_part_id(obj, msg_id, idx),
                        text,
                    });
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
            // MCP tool result lives inline in the assistant message (NOT
            // a follow-up user tool_result block). Distinct from the
            // server-tool results above because the content is plain
            // text (string or text-block array) and the `is_error` flag
            // routes through our existing ToolCallErrorRow renderer
            // — we don't want to bury it inside a JSON-stringified
            // payload like attach_server_tool_result does.
            "mcp_tool_result" => {
                attach_mcp_tool_result(&mut parts, obj);
            }
            // BetaMCPToolUseBlock { id, name, input, server_name }.
            // Synthesize the tool_name as `mcp__{server}__{name}` so
            // it converges with Codex's `handle_mcp_tool_call` — both
            // providers reach the frontend's tool router with the same
            // canonical shape.
            "mcp_tool_use" => {
                let server_name = obj.get("server_name").and_then(Value::as_str).unwrap_or("");
                let mcp_tool_short = obj.get("name").and_then(Value::as_str).unwrap_or("");
                let synthesized = format!("mcp__{server_name}__{mcp_tool_short}");
                push_tool_use(&mut parts, obj, idx, Some(synthesized), msg_id, task_state);
            }
            // BetaContainerUploadBlock { file_id }. The user explicitly
            // asked us NOT to render these — model-side container file
            // uploads are an internal step they don't want surfaced.
            // Explicit no-op arm (rather than falling through to `_`)
            // so a future "show me upload events" feature is a single
            // search away.
            "container_upload" => {}
            // BetaCompactionBlock { content: string | null }. The
            // model is reporting that it just compacted the previous
            // turn's context to free up tokens. Render as a SystemNotice
            // so it shows in the timeline alongside the corresponding
            // `compact_boundary` system event (if any) — both share
            // the same UI shell.
            "compaction" => {
                let body = obj
                    .get("content")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string);
                parts.push(MessagePart::SystemNotice {
                    id: resolve_part_id(obj, msg_id, idx),
                    severity: NoticeSeverity::Info,
                    label: "Context compacted".to_string(),
                    body,
                });
            }
            "tool_use" | "server_tool_use" => {
                push_tool_use(&mut parts, obj, idx, None, msg_id, task_state);
            }
            _ => {}
        }
    }

    parts
}

/// Push a `MessagePart::ToolCall` (or fold into `TodoList`) for a
/// `tool_use` / `server_tool_use` / `mcp_tool_use` block. `name_override`
/// is `Some` only for MCP, where the tool name is synthesized from
/// `server_name + name`. Centralizing this avoids three near-identical
/// match arms drifting apart and keeps Claude's three tool-use shapes
/// converging on the same `MessagePart` shape.
fn push_tool_use(
    parts: &mut Vec<MessagePart>,
    obj: &serde_json::Map<String, Value>,
    idx: usize,
    name_override: Option<String>,
    msg_id: &str,
    task_state: &mut TaskListState,
) {
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
    let tool_name = name_override.unwrap_or_else(|| {
        obj.get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string()
    });

    // Claude TodoWrite collapses into the unified TodoList part so the
    // frontend renders it identically to Codex todo_list. We only do
    // this once the input has been fully streamed — partial streaming
    // arrives via stream events with no `todos` array yet, in which
    // case we fall through to the regular ToolCall.
    if tool_name == "TodoWrite" {
        if let Some(items) = parse_claude_todowrite_items(&args) {
            parts.push(MessagePart::TodoList {
                id: resolve_part_id(obj, msg_id, idx),
                items,
            });
            return;
        }
    }

    // claude-agent-sdk v0.3.142 replaced TodoWrite with the incremental
    // Task family (TaskCreate / TaskUpdate) for SDK/headless sessions.
    // Fold each state-changing call into a cumulative TodoList so the user
    // still sees the same single evolving plan widget. `TaskListState`
    // carries the running list across messages; a still-streaming
    // TaskCreate (no `subject`) or a TaskUpdate for an unknown id returns
    // None and falls through to a regular ToolCall. TaskGet / TaskList are
    // read-only and intentionally NOT handled here — they render as plain
    // ToolCalls.
    if tool_name == "TaskCreate" || tool_name == "TaskUpdate" {
        if let Some(items) = task_state.apply(&tool_name, &args) {
            // Prefix the part id so `collapse_task_todo_lists` can fold the
            // whole Task sequence into one evolving widget without ever
            // touching TodoWrite/Codex-sourced lists.
            parts.push(MessagePart::TodoList {
                id: format!(
                    "{CLAUDE_TASK_LIST_ID_PREFIX}{}",
                    resolve_part_id(obj, msg_id, idx)
                ),
                items,
            });
            return;
        }
    }

    parts.push(MessagePart::ToolCall {
        tool_call_id,
        tool_name,
        args,
        args_text,
        result: None,
        is_error: None,
        streaming_status: stream_status,
        children: Vec::new(),
    });
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
}

/// Parse tool_result blocks from a `type=user` payload. Returns None if the
/// payload is not a pure tool_result message.
fn extract_tool_results(parsed: Option<&Value>) -> Option<Vec<ToolResultEntry>> {
    let parsed = parsed?;
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
            results.push(ToolResultEntry {
                tool_use_id,
                content,
                is_error,
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
                ..
            } = part
            {
                if *tool_call_id == entry.tool_use_id {
                    *result = Some(Value::String(entry.content));
                    *is_error = entry.is_error;
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
                ..
            }) = part
            {
                if *tool_call_id == entry.tool_use_id {
                    *result = Some(Value::String(entry.content));
                    *is_error = entry.is_error;
                    break;
                }
            }
        }
    }
    true
}

/// Late-merge any unresolved ToolCalls in `out` against tool_result blocks
/// scattered anywhere in the input. The lookahead-based merge in
/// `convert_flat` only walks forward from the parent assistant until it
/// hits a non-system non-user message — which means a parent Task tool's
/// `tool_result` (delivered AFTER all subagent child messages) never gets
/// merged. This pass closes that gap by indexing every tool_result by
/// `tool_use_id` and patching any ToolCall that's still missing a `result`.
pub(super) fn late_merge_unresolved_tool_results(
    messages: &[IntermediateMessage],
    out: &mut [ThreadMessageLike],
) {
    // Cheap precheck — if every ToolCall already has a result, skip the
    // input scan entirely. This is the streaming hot path: most ticks
    // touch one short message with all tool_results already merged inline.
    let any_unresolved = out.iter().any(|m| {
        m.content.iter().any(|p| {
            matches!(
                p,
                ExtendedMessagePart::Basic(MessagePart::ToolCall { result: None, .. })
            )
        })
    });
    if !any_unresolved {
        return;
    }

    let mut index: HashMap<String, ToolResultPatch> = HashMap::new();
    for msg in messages {
        let Some(parsed) = msg.parsed.as_ref() else {
            continue;
        };
        let Some(blocks) = parsed
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for b in blocks {
            let Some(obj) = b.as_object() else { continue };
            // Both shapes share the same `{tool_use_id, content, is_error?}`
            // surface; the only difference is which side of the conversation
            // the SDK delivers them on (`tool_result` lives inside a
            // follow-up user message, `mcp_tool_result` lives inline in
            // the same assistant message as the matching `mcp_tool_use`).
            // Indexing both here means the unified late-merge handles
            // BOTH the parent-Task lookahead gap AND the cross-event
            // mcp result attach without two scan passes.
            let block_type = obj.get("type").and_then(Value::as_str);
            if block_type != Some("tool_result") && block_type != Some("mcp_tool_result") {
                continue;
            }
            let Some(id) = obj.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            let content = extract_tool_result_content(obj.get("content"));
            let is_error = match obj.get("is_error").and_then(Value::as_bool) {
                Some(true) => Some(true),
                _ => None,
            };
            // First-write wins — the SDK occasionally re-emits the same
            // tool_use_id (retries, partial replays); the earliest entry
            // matches the chronological tool_use the user actually saw.
            index
                .entry(id.to_string())
                .or_insert(ToolResultPatch { content, is_error });
        }
    }

    if index.is_empty() {
        return;
    }

    for msg in out.iter_mut() {
        for part in msg.content.iter_mut() {
            if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
                tool_call_id,
                result,
                is_error,
                ..
            }) = part
            {
                if result.is_some() {
                    continue;
                }
                if let Some(patch) = index.get(tool_call_id) {
                    *result = Some(Value::String(patch.content.clone()));
                    *is_error = patch.is_error;
                }
            }
        }
    }
}

struct ToolResultPatch {
    content: String,
    is_error: Option<bool>,
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

/// Attach a `BetaMCPToolResultBlock` to its owning `mcp_tool_use`.
/// `content` is `string | BetaTextBlock[]`; both forms collapse to a
/// plain string. `is_error: true` is propagated so the frontend's
/// existing `ToolCallErrorRow` lights up — the MCP error path reuses
/// the same UI as Bash failures, no new components needed.
fn attach_mcp_tool_result(parts: &mut [MessagePart], obj: &serde_json::Map<String, Value>) {
    let target_id = match obj.get("tool_use_id").and_then(Value::as_str) {
        Some(id) => id,
        None => return,
    };
    let content_text = extract_tool_result_content(obj.get("content"));
    let is_error_flag = match obj.get("is_error").and_then(Value::as_bool) {
        Some(true) => Some(true),
        _ => None,
    };
    for part in parts.iter_mut().rev() {
        if let MessagePart::ToolCall {
            tool_call_id,
            result,
            is_error,
            ..
        } = part
        {
            if tool_call_id == target_id {
                *result = Some(Value::String(content_text));
                *is_error = is_error_flag;
                return;
            }
        }
    }
}

/// Parse a Claude `image` content block into a MessagePart::Image.
/// Recognizes both base64 (`{type: "base64", data, media_type}`) and
/// url (`{type: "url", url}`) source variants. Returns None for any
/// shape we can't decode so the parser stays liberal.
fn parse_image_block(
    obj: &serde_json::Map<String, Value>,
    msg_id: &str,
    idx: usize,
) -> Option<MessagePart> {
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
                id: resolve_part_id(obj, msg_id, idx),
                source: ImageSource::Base64 { data },
                media_type,
            })
        }
        Some("url") => {
            let url = source.get("url").and_then(Value::as_str)?.to_string();
            Some(MessagePart::Image {
                id: resolve_part_id(obj, msg_id, idx),
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
