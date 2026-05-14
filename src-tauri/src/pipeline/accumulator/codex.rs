//! Codex App Server event handling.
//!
//! Processes events forwarded by the sidecar after JSON-RPC envelope
//! stripping: `item/started`, `item/completed`, delta events
//! (`item/agentMessage/delta`, etc.), and `turn/completed`.
//!
//! The App Server uses camelCase item types and field names. All
//! normalization (camelCase→snake_case) happens here so the adapter
//! and historical reload path see a consistent format.

use std::collections::HashMap;

use serde_json::Value;

use super::StreamAccumulator;
use crate::pipeline::codex_collab::{build_collab_result_text, collab_synthetic_tool_name};
use crate::pipeline::types::{CollectedTurn, MessageRole};

// ---------------------------------------------------------------------------
// Per-item delta accumulation state
// ---------------------------------------------------------------------------

pub(super) struct CodexItemState {
    item_type: String,
    text: String,
    output: String,
    reasoning_text: String,
    initial_item: Value,
}

impl CodexItemState {
    fn new(item_type: &str, initial_item: Value) -> Self {
        Self {
            item_type: item_type.to_string(),
            text: String::new(),
            output: String::new(),
            reasoning_text: String::new(),
            initial_item,
        }
    }

    /// Build a full item snapshot from accumulated delta state.
    fn build_snapshot(&self) -> Value {
        let mut item = self.initial_item.clone();
        match self.item_type.as_str() {
            "agent_message" => {
                item["text"] = Value::String(self.text.clone());
            }
            "command_execution" => {
                item["aggregated_output"] = Value::String(self.output.clone());
            }
            "reasoning" => {
                item["text"] = Value::String(self.reasoning_text.clone());
            }
            "plan" => {
                item["text"] = Value::String(self.text.clone());
            }
            _ => {}
        }
        item
    }
}

/// Initialize the codex_items map. Called from StreamAccumulator::new.
pub(super) fn new_item_states() -> HashMap<String, CodexItemState> {
    HashMap::new()
}

// ---------------------------------------------------------------------------
// Item lifecycle handlers
// ---------------------------------------------------------------------------

pub(super) fn handle_item_started(acc: &mut StreamAccumulator, _raw_line: &str, value: &Value) {
    let Some(raw_item) = value.get("item") else {
        return;
    };
    let item = normalize_item(raw_item);
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    let item_id = item.get("id").and_then(Value::as_str).unwrap_or("");

    if !item_id.is_empty() {
        acc.codex_items.insert(
            item_id.to_string(),
            CodexItemState::new(item_type, item.clone()),
        );
    }

    // Skip mid-flight render for collab tool calls — `item/started` has
    // empty agentsStates / receiverThreadIds, so all the frontend can show
    // is a "Sub-agent" placeholder that flickers off when completed lands.
    // The entry stays in `codex_items` so abort/flush still works.
    if item_type == "collab_agent_tool_call" {
        return;
    }

    let synthetic = serde_json::json!({"item": item});
    let synthetic_str = serde_json::to_string(&synthetic).unwrap_or_default();
    dispatch_item(acc, &synthetic_str, &synthetic, false);
}

pub(super) fn handle_item_completed(acc: &mut StreamAccumulator, _raw_line: &str, value: &Value) {
    let Some(raw_item) = value.get("item") else {
        return;
    };
    let item = normalize_item(raw_item);
    let item_id = item.get("id").and_then(Value::as_str).unwrap_or("");

    // Clean up delta state
    if !item_id.is_empty() {
        acc.codex_items.remove(item_id);
    }

    // Include "type": "item.completed" so the adapter's historical
    // reload can dispatch via `msg_type == "item.completed"`.
    let synthetic = serde_json::json!({"type": "item.completed", "item": item});
    let persist_str = serde_json::to_string(&synthetic).unwrap_or_default();
    dispatch_item(acc, &persist_str, &synthetic, true);
}

// ---------------------------------------------------------------------------
// Delta handlers
// ---------------------------------------------------------------------------

pub(super) fn handle_text_delta(acc: &mut StreamAccumulator, value: &Value) {
    let item_id = value.get("itemId").and_then(Value::as_str).unwrap_or("");
    // Official docs: `text`; some versions: `delta`
    let text = delta_text(value, &["text", "delta"]);
    if item_id.is_empty() || text.is_empty() {
        return;
    }

    if let Some(state) = acc.codex_items.get_mut(item_id) {
        state.text.push_str(text);
    }
    emit_snapshot_for(acc, item_id);
}

pub(super) fn handle_cmd_output_delta(acc: &mut StreamAccumulator, value: &Value) {
    let item_id = value.get("itemId").and_then(Value::as_str).unwrap_or("");
    // Official docs: `output`; some versions: `delta`
    let text = delta_text(value, &["output", "delta"]);
    if item_id.is_empty() || text.is_empty() {
        return;
    }

    if let Some(state) = acc.codex_items.get_mut(item_id) {
        state.output.push_str(text);
    }
    emit_snapshot_for(acc, item_id);
}

pub(super) fn handle_reasoning_delta(acc: &mut StreamAccumulator, value: &Value) {
    let item_id = value.get("itemId").and_then(Value::as_str).unwrap_or("");
    // Official docs: `text`; some versions: `delta`
    let text = delta_text(value, &["text", "delta"]);
    if item_id.is_empty() || text.is_empty() {
        return;
    }

    if let Some(state) = acc.codex_items.get_mut(item_id) {
        state.reasoning_text.push_str(text);
    }
    emit_snapshot_for(acc, item_id);
}

pub(super) fn handle_file_change_delta(acc: &mut StreamAccumulator, value: &Value) {
    let item_id = value.get("itemId").and_then(Value::as_str).unwrap_or("");
    if item_id.is_empty() {
        return;
    }
    emit_snapshot_for(acc, item_id);
}

pub(super) fn handle_plan_delta(acc: &mut StreamAccumulator, value: &Value) {
    let item_id = value.get("itemId").and_then(Value::as_str).unwrap_or("");
    let delta = value.get("delta").and_then(Value::as_str).unwrap_or("");
    if item_id.is_empty() || delta.is_empty() {
        return;
    }

    if let Some(state) = acc.codex_items.get_mut(item_id) {
        state.text.push_str(delta);
    }
    emit_snapshot_for(acc, item_id);
}

// ---------------------------------------------------------------------------
// Turn completion
// ---------------------------------------------------------------------------

/// Handle `turn/completed`. The App Server merges completed/failed into one
/// event with a `status` field on the `turn` object.
pub(super) fn handle_turn_completed(acc: &mut StreamAccumulator, raw_line: &str, value: &Value) {
    let turn = value.get("turn");
    let status = turn
        .and_then(|t| t.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("completed");

    if status == "failed" {
        let message = turn
            .and_then(|t| t.get("error"))
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Codex turn failed")
            .to_string();
        let synthetic = serde_json::json!({
            "type": "error",
            "message": message,
        });
        let s = serde_json::to_string(&synthetic).unwrap_or_default();
        let turn_id = uuid::Uuid::new_v4().to_string();
        acc.collect_message(&s, &synthetic, MessageRole::Error, Some(&turn_id));
        acc.turns.push(CollectedTurn {
            id: turn_id,
            role: MessageRole::Error,
            content_json: raw_line.to_string(),
        });
        return;
    }

    // Successful turn completion — inject computed duration_ms so the
    // adapter's `build_result_label` can display elapsed time.
    if let Some(parsed_usage) = value.get("usage") {
        acc.usage.input_tokens = parsed_usage.get("input_tokens").and_then(Value::as_i64);
        acc.usage.output_tokens = parsed_usage.get("output_tokens").and_then(Value::as_i64);
    }

    let mut enriched = value.clone();
    if let Some(started) = acc.codex_turn_started_at.take() {
        let now = super::now_ms();
        let duration = now - started;
        if duration > 0.0 {
            enriched["duration_ms"] = serde_json::json!(duration);
        }
    }
    let enriched_str = serde_json::to_string(&enriched).unwrap_or_else(|_| raw_line.to_string());

    acc.result_json = Some(enriched_str.clone());
    let id = uuid::Uuid::new_v4().to_string();
    acc.result_id = Some(id.clone());
    acc.collect_message(&enriched_str, &enriched, MessageRole::Assistant, Some(&id));
}

// ---------------------------------------------------------------------------
// Internal: dispatch normalized item to type-specific handlers
// ---------------------------------------------------------------------------

/// Build a snapshot from the accumulated delta state and dispatch it.
/// Separates the state read from the mutable accumulator dispatch to
/// satisfy the borrow checker.
fn emit_snapshot_for(acc: &mut StreamAccumulator, item_id: &str) {
    let snapshot = match acc.codex_items.get(item_id) {
        Some(state) => state.build_snapshot(),
        None => return,
    };
    let synthetic = serde_json::json!({"item": snapshot});
    let s = serde_json::to_string(&synthetic).unwrap_or_default();
    dispatch_item(acc, &s, &synthetic, false);
}

/// Route a normalized item value to the correct type handler.
/// Route a normalized item to the correct type handler.
fn dispatch_item(acc: &mut StreamAccumulator, raw_line: &str, value: &Value, persist: bool) {
    let item = match value.get("item") {
        Some(i) => i,
        None => return,
    };

    let item_type = item.get("type").and_then(Value::as_str);
    let item_id = item.get("id").and_then(Value::as_str).map(str::to_string);

    match item_type {
        // User message echoed back by App Server — skip, already tracked.
        Some("user_message") => {}
        Some("agent_message") => {
            handle_agent_message(acc, raw_line, item, item_id.as_deref(), persist);
        }
        Some("command_execution") => {
            handle_command_execution(acc, raw_line, item, item_id.as_deref(), persist);
        }
        Some("file_change") => {
            handle_file_change(acc, raw_line, item, item_id.as_deref(), persist);
        }
        Some("reasoning") => {
            handle_reasoning(acc, raw_line, item, item_id.as_deref(), persist);
        }
        Some("web_search") => {
            handle_web_search(acc, raw_line, item, item_id.as_deref(), persist);
        }
        Some("mcp_tool_call") => {
            handle_mcp_tool_call(acc, raw_line, item, item_id.as_deref(), persist);
        }
        Some("todo_list") => {
            handle_todo_list(acc, raw_line, item, item_id.as_deref(), persist);
        }
        Some("plan") => {
            handle_plan_item(acc, raw_line, item, item_id.as_deref(), persist);
        }
        Some("context_compaction") => {
            handle_context_compaction_item(acc, raw_line, item, item_id.as_deref(), persist);
        }
        Some("image_generation") => {
            handle_image_generation(acc, raw_line, item, item_id.as_deref(), persist);
        }
        Some("error") => {
            handle_error_item(acc, raw_line, item, persist);
        }
        Some("collab_agent_tool_call") => {
            handle_collab_agent_tool_call(acc, raw_line, item, item_id.as_deref(), persist);
        }
        _ => {
            let label = format!("codex/item:{}", item_type.unwrap_or("<missing-item-type>"));
            if !acc.dropped_event_types.contains(&label) {
                acc.dropped_event_types.push(label);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Per-type synthesis handlers
// ---------------------------------------------------------------------------

fn handle_agent_message(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let collect_id = item_id
        .map(|id| format!("codex-item:{id}"))
        .unwrap_or_else(|| format!("codex-item:{}", acc.line_count));
    if persist {
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            if !acc.assistant_text.is_empty() {
                acc.assistant_text.push_str("\n\n");
            }
            acc.assistant_text.push_str(text);
        }
        // Use the same id for the DB row and the live-rendered collected
        // entry so historical reload and live streaming agree byte-for-byte.
        acc.turns.push(CollectedTurn {
            id: collect_id.clone(),
            role: MessageRole::Assistant,
            content_json: raw_line.to_string(),
        });
    }
    // Wrap in the envelope the adapter expects
    let envelope = serde_json::json!({
        "type": "item.completed",
        "item": item,
    });
    let s = serde_json::to_string(&envelope).unwrap_or_default();
    acc.collect_or_replace(&s, &envelope, MessageRole::Assistant, Some(collect_id));
}

fn handle_command_execution(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let command = item.get("command").and_then(Value::as_str).unwrap_or("");
    let output = item
        .get("aggregated_output")
        .or_else(|| item.get("output"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let exit_code_raw = item.get("exit_code").and_then(Value::as_i64);
    let synthetic_id = item_id
        .map(|id| format!("codex-cmd-{id}"))
        .unwrap_or_else(|| format!("codex-cmd-{}", acc.line_count));

    let is_running = exit_code_raw.is_none();
    let mut tool_use = serde_json::json!({
        "type": "tool_use",
        "id": synthetic_id,
        "name": "Bash",
        "input": {"command": command},
    });
    if is_running {
        tool_use["__streaming_status"] = Value::String("running".to_string());
    }
    let synthetic_assistant = serde_json::json!({
        "type": "assistant",
        "message": {
            "type": "message",
            "role": "assistant",
            "content": [tool_use],
        }
    });
    let sa_str = serde_json::to_string(&synthetic_assistant).unwrap_or_default();
    let asst_id = item_id
        .map(|id| format!("codex-cmd-asst:{id}"))
        .unwrap_or_else(|| format!("codex-cmd-asst:{}", acc.line_count));
    acc.collect_or_replace(
        &sa_str,
        &synthetic_assistant,
        MessageRole::Assistant,
        Some(asst_id.clone()),
    );

    if !is_running {
        let exit_code = exit_code_raw.unwrap_or(0);
        let result_content = if exit_code == 0 {
            output.to_string()
        } else {
            format!("Exit code: {exit_code}\n{output}")
        };
        let synthetic_result = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": synthetic_id,
                    "content": result_content
                }]
            }
        });
        let sr_str = serde_json::to_string(&synthetic_result).unwrap_or_default();
        let user_id = item_id.map(|id| format!("codex-cmd-user:{id}"));
        acc.collect_or_replace(&sr_str, &synthetic_result, MessageRole::User, user_id);
    }

    if persist {
        acc.turns.push(CollectedTurn {
            id: asst_id,
            role: MessageRole::Assistant,
            content_json: raw_line.to_string(),
        });
    }
}

fn handle_file_change(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let changes = item
        .get("changes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let status = item.get("status").and_then(Value::as_str);
    let synthetic_id = item_id
        .map(|id| format!("codex-patch-{id}"))
        .unwrap_or_else(|| format!("codex-patch-{}", acc.line_count));

    let mut tool_use = serde_json::json!({
        "type": "tool_use",
        "id": synthetic_id,
        "name": "apply_patch",
        "input": {"changes": changes},
    });
    if status.is_none() {
        tool_use["__streaming_status"] = Value::String("running".to_string());
    }
    let synthetic_assistant = serde_json::json!({
        "type": "assistant",
        "message": {
            "type": "message",
            "role": "assistant",
            "content": [tool_use],
        }
    });
    let sa_str = serde_json::to_string(&synthetic_assistant).unwrap_or_default();
    let asst_id = item_id
        .map(|id| format!("codex-patch-asst:{id}"))
        .unwrap_or_else(|| format!("codex-patch-asst:{}", acc.line_count));
    acc.collect_or_replace(
        &sa_str,
        &synthetic_assistant,
        MessageRole::Assistant,
        Some(asst_id.clone()),
    );

    if let Some(s) = status {
        let result_text = match s {
            "completed" => "Patch applied".to_string(),
            "failed" => "Patch failed".to_string(),
            other => format!("Patch {other}"),
        };
        let synthetic_result = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": synthetic_id,
                    "content": result_text
                }]
            }
        });
        let sr_str = serde_json::to_string(&synthetic_result).unwrap_or_default();
        let user_id = item_id.map(|id| format!("codex-patch-user:{id}"));
        acc.collect_or_replace(&sr_str, &synthetic_result, MessageRole::User, user_id);
    }

    if persist {
        acc.turns.push(CollectedTurn {
            id: asst_id,
            role: MessageRole::Assistant,
            content_json: raw_line.to_string(),
        });
    }
}

fn handle_reasoning(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let text = item
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if text.is_empty() {
        return;
    }
    let intermediate_id = item_id
        .map(|id| format!("codex-reasoning:{id}"))
        .unwrap_or_else(|| format!("codex-reasoning:{}", acc.line_count));
    let synthetic_assistant = serde_json::json!({
        "type": "assistant",
        "message": {
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "thinking",
                "thinking": text,
                "__part_id": format!("{intermediate_id}:blk:0"),
            }]
        }
    });
    let sa_str = serde_json::to_string(&synthetic_assistant).unwrap_or_default();
    acc.collect_or_replace(
        &sa_str,
        &synthetic_assistant,
        MessageRole::Assistant,
        Some(intermediate_id.clone()),
    );

    if persist {
        acc.turns.push(CollectedTurn {
            id: intermediate_id,
            role: MessageRole::Assistant,
            content_json: raw_line.to_string(),
        });
    }
}

fn web_search_summary(query: &str, action: Option<&Value>) -> String {
    let mut lines = Vec::new();
    if !query.is_empty() {
        lines.push(query.to_string());
    }
    if let Some(a) = action {
        if let Some(url) = a.get("url").and_then(Value::as_str) {
            lines.push(url.to_string());
        }
        if let Some(pattern) = a.get("pattern").and_then(Value::as_str) {
            lines.push(format!("Pattern: {pattern}"));
        }
    }
    lines.join("\n")
}

fn handle_web_search(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let query = item.get("query").and_then(Value::as_str).unwrap_or("");
    let synthetic_id = item_id
        .map(|id| format!("codex-search-{id}"))
        .unwrap_or_else(|| format!("codex-search-{}", acc.line_count));

    let mut input = serde_json::json!({"query": query});
    if let Some(action) = item.get("action") {
        input["action"] = action.clone();
    }

    let is_running = !persist;
    let mut tool_use = serde_json::json!({
        "type": "tool_use",
        "id": synthetic_id,
        "name": "WebSearch",
        "input": input,
    });
    if is_running {
        tool_use["__streaming_status"] = Value::String("running".to_string());
    }
    let synthetic_assistant = serde_json::json!({
        "type": "assistant",
        "message": {
            "type": "message",
            "role": "assistant",
            "content": [tool_use],
        }
    });
    let sa_str = serde_json::to_string(&synthetic_assistant).unwrap_or_default();
    let asst_id = item_id
        .map(|id| format!("codex-search-asst:{id}"))
        .unwrap_or_else(|| format!("codex-search-asst:{}", acc.line_count));
    acc.collect_or_replace(
        &sa_str,
        &synthetic_assistant,
        MessageRole::Assistant,
        Some(asst_id.clone()),
    );

    if persist {
        let summary = web_search_summary(query, item.get("action"));
        let synthetic_result = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": synthetic_id,
                    "content": summary,
                }]
            }
        });
        let sr_str = serde_json::to_string(&synthetic_result).unwrap_or_default();
        let user_id = item_id.map(|id| format!("codex-search-user:{id}"));
        acc.collect_or_replace(&sr_str, &synthetic_result, MessageRole::User, user_id);

        acc.turns.push(CollectedTurn {
            id: asst_id,
            role: MessageRole::Assistant,
            content_json: raw_line.to_string(),
        });
    }
}

fn handle_mcp_tool_call(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let server = item.get("server").and_then(Value::as_str).unwrap_or("");
    let tool = item.get("tool").and_then(Value::as_str).unwrap_or("");
    let arguments = item.get("arguments").cloned().unwrap_or(Value::Null);
    let status = item.get("status").and_then(Value::as_str);
    let synthetic_id = item_id
        .map(|id| format!("codex-mcp-{id}"))
        .unwrap_or_else(|| format!("codex-mcp-{}", acc.line_count));
    let tool_name = format!("mcp__{server}__{tool}");

    let mut tool_use = serde_json::json!({
        "type": "tool_use",
        "id": synthetic_id,
        "name": tool_name,
        "input": arguments,
    });
    if status == Some("in_progress") {
        tool_use["__streaming_status"] = Value::String("running".to_string());
    }
    let synthetic_assistant = serde_json::json!({
        "type": "assistant",
        "message": {
            "type": "message",
            "role": "assistant",
            "content": [tool_use],
        }
    });
    let sa_str = serde_json::to_string(&synthetic_assistant).unwrap_or_default();
    let asst_id = item_id
        .map(|id| format!("codex-mcp-asst:{id}"))
        .unwrap_or_else(|| format!("codex-mcp-asst:{}", acc.line_count));
    acc.collect_or_replace(
        &sa_str,
        &synthetic_assistant,
        MessageRole::Assistant,
        Some(asst_id.clone()),
    );

    if matches!(status, Some("completed") | Some("failed")) {
        let result_text = if status == Some("failed") {
            let msg = item
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("MCP tool failed");
            format!("Error: {msg}")
        } else {
            item.get("result")
                .and_then(|r| serde_json::to_string(r).ok())
                .unwrap_or_else(|| "OK".to_string())
        };
        let synthetic_result = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": synthetic_id,
                    "content": result_text,
                }]
            }
        });
        let sr_str = serde_json::to_string(&synthetic_result).unwrap_or_default();
        let user_id = item_id.map(|id| format!("codex-mcp-user:{id}"));
        acc.collect_or_replace(&sr_str, &synthetic_result, MessageRole::User, user_id);
    }

    if persist {
        acc.turns.push(CollectedTurn {
            id: asst_id,
            role: MessageRole::Assistant,
            content_json: raw_line.to_string(),
        });
    }
}

fn handle_todo_list(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let items = match item.get("items").and_then(Value::as_array) {
        Some(arr) => arr,
        None => return,
    };
    let todos: Vec<Value> = items
        .iter()
        .filter_map(|t| {
            let obj = t.as_object()?;
            let text = obj.get("text").and_then(Value::as_str)?.to_string();
            let completed = obj
                .get("completed")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Some(serde_json::json!({
                "content": text,
                "activeForm": text,
                "status": if completed { "completed" } else { "pending" },
            }))
        })
        .collect();

    let synthetic_id = item_id
        .map(|id| format!("codex-todo-{id}"))
        .unwrap_or_else(|| format!("codex-todo-{}", acc.line_count));
    let synthetic_assistant = serde_json::json!({
        "type": "assistant",
        "message": {
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": synthetic_id,
                "name": "TodoWrite",
                "input": {"todos": todos},
            }]
        }
    });
    let sa_str = serde_json::to_string(&synthetic_assistant).unwrap_or_default();
    let intermediate_id = item_id
        .map(|id| format!("codex-todo-msg:{id}"))
        .unwrap_or_else(|| format!("codex-todo-msg:{}", acc.line_count));
    acc.collect_or_replace(
        &sa_str,
        &synthetic_assistant,
        MessageRole::Assistant,
        Some(intermediate_id.clone()),
    );

    if persist {
        acc.turns.push(CollectedTurn {
            id: intermediate_id,
            role: MessageRole::Assistant,
            content_json: raw_line.to_string(),
        });
    }
}

fn handle_plan_item(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let envelope = serde_json::json!({
        "type": "item.completed",
        "item": item,
    });
    let s = serde_json::to_string(&envelope).unwrap_or_default();
    let plan_id = item_id
        .map(|id| format!("codex-plan:{id}"))
        .unwrap_or_else(|| format!("codex-plan:{}", acc.line_count));
    acc.collect_or_replace(&s, &envelope, MessageRole::Assistant, Some(plan_id.clone()));

    if persist {
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            if !acc.assistant_text.is_empty() {
                acc.assistant_text.push_str("\n\n");
            }
            acc.assistant_text.push_str(text);
        }
        acc.turns.push(CollectedTurn {
            id: plan_id,
            role: MessageRole::Assistant,
            content_json: raw_line.to_string(),
        });
    }
}

fn handle_context_compaction_item(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let body = item
        .get("summary")
        .or_else(|| item.get("text"))
        .or_else(|| item.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let subtype = if persist {
        "codex_compacted"
    } else {
        "codex_compacting"
    };
    let synthetic = serde_json::json!({
        "type": "system",
        "subtype": subtype,
        "summary": body,
    });
    let synthetic_str = serde_json::to_string(&synthetic).unwrap_or_default();
    let prefix = if persist {
        "codex-compaction"
    } else {
        "codex-compacting"
    };
    let compaction_id = item_id
        .map(|id| format!("{prefix}:{id}"))
        .unwrap_or_else(|| format!("{prefix}:{}", acc.line_count));
    acc.collect_or_replace(
        &synthetic_str,
        &synthetic,
        MessageRole::System,
        Some(compaction_id.clone()),
    );

    if persist {
        acc.turns.push(CollectedTurn {
            id: compaction_id,
            role: MessageRole::System,
            content_json: raw_line.to_string(),
        });
    }
}

fn handle_image_generation(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let envelope = serde_json::json!({
        "type": "item.completed",
        "item": item,
    });
    let s = serde_json::to_string(&envelope).unwrap_or_default();
    let image_id = item_id
        .map(|id| format!("codex-image:{id}"))
        .unwrap_or_else(|| format!("codex-image:{}", acc.line_count));
    acc.collect_or_replace(
        &s,
        &envelope,
        MessageRole::Assistant,
        Some(image_id.clone()),
    );

    if persist {
        acc.turns.push(CollectedTurn {
            id: image_id,
            role: MessageRole::Assistant,
            content_json: raw_line.to_string(),
        });
    }
}

pub(super) fn handle_thread_compacted(acc: &mut StreamAccumulator, _raw_line: &str, value: &Value) {
    let synthetic = serde_json::json!({
        "type": "system",
        "subtype": "codex_compacted",
        "thread_id": value.get("threadId").or_else(|| value.get("thread_id")),
    });
    let synthetic_str = synthetic.to_string();
    let id = format!("codex-thread-compacted:{}", acc.line_count);
    acc.collect_message(&synthetic_str, &synthetic, MessageRole::System, Some(&id));
    acc.turns.push(CollectedTurn {
        id,
        role: MessageRole::System,
        content_json: synthetic_str,
    });
}

/// Handle `turn/plan/updated`: map plan steps to a TodoList via synthetic
/// `TodoWrite` tool_use. Uses a stable override_id so each update replaces
/// the previous.
pub(super) fn handle_turn_plan_updated(
    acc: &mut StreamAccumulator,
    _raw_line: &str,
    value: &Value,
) {
    let steps = match value.get("plan").and_then(Value::as_array) {
        Some(arr) => arr,
        None => return,
    };

    let todos: Vec<Value> = steps
        .iter()
        .filter_map(|s| {
            let text = s.get("step").and_then(Value::as_str)?.to_string();
            let status = s.get("status").and_then(Value::as_str).unwrap_or("pending");
            let mapped = match status {
                "completed" => "completed",
                "inProgress" | "in_progress" => "in_progress",
                _ => "pending",
            };
            Some(serde_json::json!({
                "content": text,
                "activeForm": text,
                "status": mapped,
            }))
        })
        .collect();

    if todos.is_empty() {
        return;
    }

    let turn_id = value
        .get("turnId")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let synthetic_id = format!("codex-plan-steps-{turn_id}");
    let synthetic_assistant = serde_json::json!({
        "type": "assistant",
        "message": {
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": synthetic_id,
                "name": "TodoWrite",
                "input": {"todos": todos},
            }]
        }
    });
    let sa_str = serde_json::to_string(&synthetic_assistant).unwrap_or_default();
    let msg_id = format!("codex-plan-steps-msg:{turn_id}");
    acc.collect_or_replace(
        &sa_str,
        &synthetic_assistant,
        MessageRole::Assistant,
        Some(msg_id),
    );
}

/// Synthesize a tool_use block for a `collabAgentToolCall`. The five
/// `tool` variants (spawnAgent / sendInput / resumeAgent / wait /
/// closeAgent) each become a distinct synthetic tool name so the
/// frontend can dispatch on `toolName` like it does for other Codex
/// tools (Bash, apply_patch, etc.).
///
/// `wait` carries the most signal: when status=completed,
/// `agentsStates[threadId].message` is the sub-agent's final answer
/// text. We emit it as a `tool_result` so the existing tool-result
/// rendering path can surface it without any new MessagePart shape.
fn handle_collab_agent_tool_call(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let tool = item.get("tool").and_then(Value::as_str).unwrap_or("");
    let status = item.get("status").and_then(Value::as_str);
    let synthetic_tool_name = collab_synthetic_tool_name(tool);

    let synthetic_id = item_id
        .map(|id| format!("codex-collab-{id}"))
        .unwrap_or_else(|| format!("codex-collab-{}", acc.line_count));

    // Pass through every collab field — the frontend's spawn-agent renderer
    // reads `prompt`, `senderThreadId`, `receiverThreadIds`, `agentsStates`,
    // `model`, `reasoningEffort` directly. Cheaper to forward the whole item
    // than to enumerate fields here (the adapter does the same).
    let mut input = item.clone();
    if let Some(obj) = input.as_object_mut() {
        // Drop redundant identifiers — frontend uses the synthetic id.
        obj.remove("type");
        obj.remove("id");
    }

    let mut tool_use = serde_json::json!({
        "type": "tool_use",
        "id": synthetic_id,
        "name": synthetic_tool_name,
        "input": input,
    });
    if status == Some("in_progress") {
        tool_use["__streaming_status"] = Value::String("running".to_string());
    }

    let synthetic_assistant = serde_json::json!({
        "type": "assistant",
        "message": {
            "type": "message",
            "role": "assistant",
            "content": [tool_use],
        }
    });
    let sa_str = serde_json::to_string(&synthetic_assistant).unwrap_or_default();
    let asst_id = item_id
        .map(|id| format!("codex-collab-asst:{id}"))
        .unwrap_or_else(|| format!("codex-collab-asst:{}", acc.line_count));
    acc.collect_or_replace(
        &sa_str,
        &synthetic_assistant,
        MessageRole::Assistant,
        Some(asst_id.clone()),
    );

    // For terminal statuses synthesize a tool_result. `wait` carries the
    // sub-agents' final answers in `agentsStates[*].message`; spawn / send /
    // resume / close don't produce useful textual output beyond the request
    // itself, so their result is just the status word.
    if matches!(status, Some("completed") | Some("failed")) {
        let result_text = build_collab_result_text(tool, status.unwrap_or(""), item);
        let synthetic_result = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": synthetic_id,
                    "content": result_text,
                }]
            }
        });
        let sr_str = serde_json::to_string(&synthetic_result).unwrap_or_default();
        let user_id = item_id.map(|id| format!("codex-collab-user:{id}"));
        acc.collect_or_replace(&sr_str, &synthetic_result, MessageRole::User, user_id);
    }

    if persist {
        acc.turns.push(CollectedTurn {
            id: asst_id,
            role: MessageRole::Assistant,
            content_json: raw_line.to_string(),
        });
    }
}

fn handle_error_item(acc: &mut StreamAccumulator, raw_line: &str, item: &Value, persist: bool) {
    let message = item
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Codex error")
        .to_string();
    let synthetic = serde_json::json!({
        "type": "error",
        "message": message,
    });
    let s = serde_json::to_string(&synthetic).unwrap_or_default();
    let err_id = uuid::Uuid::new_v4().to_string();
    acc.collect_message(&s, &synthetic, MessageRole::Error, Some(&err_id));

    if persist {
        acc.turns.push(CollectedTurn {
            id: err_id,
            role: MessageRole::Error,
            content_json: raw_line.to_string(),
        });
    }
}

// ---------------------------------------------------------------------------
// Abort: flush in-progress items as completed
// ---------------------------------------------------------------------------

/// Drain all in-progress Codex items and dispatch them with `persist=true`,
/// so they land in `turns` and get written to the DB on abort.
pub(super) fn flush_in_progress(acc: &mut StreamAccumulator) {
    let items: Vec<(String, CodexItemState)> = acc.codex_items.drain().collect();
    if items.is_empty() {
        return;
    }

    for (_id, state) in items {
        let snapshot = state.build_snapshot();
        let synthetic = serde_json::json!({"type": "item.completed", "item": snapshot});
        let persist_str = serde_json::to_string(&synthetic).unwrap_or_default();
        dispatch_item(acc, &persist_str, &synthetic, true);
    }

    acc.codex_partial_idx = None;
}

// ---------------------------------------------------------------------------
// camelCase → snake_case normalization
// ---------------------------------------------------------------------------

/// Normalize a Codex App Server item: convert type and field names
/// from camelCase to snake_case.
fn normalize_item(raw: &Value) -> Value {
    let Some(obj) = raw.as_object() else {
        return raw.clone();
    };

    let mut result = serde_json::Map::new();
    for (key, val) in obj {
        let normalized_key = normalize_field_name(key);
        let normalized_val = if key == "type" {
            match val.as_str() {
                Some(t) => Value::String(normalize_item_type(t).to_string()),
                None => val.clone(),
            }
        } else {
            normalize_field_value(key, val)
        };
        result.insert(normalized_key, normalized_val);
    }

    Value::Object(result)
}

/// Read a delta text field, trying multiple field names in order.
fn delta_text<'a>(value: &'a Value, names: &[&str]) -> &'a str {
    for name in names {
        if let Some(s) = value.get(*name).and_then(Value::as_str) {
            return s;
        }
    }
    ""
}

fn normalize_item_type(t: &str) -> &str {
    match t {
        "agentMessage" => "agent_message",
        "userMessage" | "user_message" => "user_message",
        "commandExecution" | "command_execution" => "command_execution",
        "fileChange" | "file_change" => "file_change",
        "webSearch" | "web_search" => "web_search",
        "mcpToolCall" | "mcp_tool_call" => "mcp_tool_call",
        "todoList" | "todo_list" => "todo_list",
        "reasoning" => "reasoning",
        "plan" => "plan",
        "contextCompaction" | "context_compaction" => "context_compaction",
        "imageGeneration" | "image_generation" => "image_generation",
        "collabAgentToolCall" | "collab_agent_tool_call" => "collab_agent_tool_call",
        "error" => "error",
        other => other,
    }
}

fn normalize_field_name(name: &str) -> String {
    match name {
        "exitCode" => "exit_code".to_string(),
        "aggregatedOutput" => "aggregated_output".to_string(),
        "toolCall" => "tool_call".to_string(),
        "durationMs" => "duration_ms".to_string(),
        "processId" => "process_id".to_string(),
        "commandActions" => "command_actions".to_string(),
        "memoryCitation" => "memory_citation".to_string(),
        "savedPath" => "saved_path".to_string(),
        // collabAgentToolCall fields — keep camelCase intact for the
        // adapter (it inspects raw fields like `senderThreadId`,
        // `receiverThreadIds`, `agentsStates`); rename only those that
        // collide with snake_case rendering elsewhere.
        _ => name.to_string(),
    }
}

/// Normalize status values: "inProgress" → "in_progress"
fn normalize_field_value(key: &str, val: &Value) -> Value {
    if key == "status" {
        if let Some(s) = val.as_str() {
            return match s {
                "inProgress" => Value::String("in_progress".to_string()),
                other => Value::String(other.to_string()),
            };
        }
    }
    val.clone()
}
