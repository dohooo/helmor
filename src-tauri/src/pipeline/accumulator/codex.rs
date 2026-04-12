//! Codex `item.*` synthesis.
//!
//! Codex emits one event per ThreadItem (`item.started`, `item.updated`,
//! `item.completed`). Each item carries a full snapshot, so the three
//! lifecycle markers route through the same `handle_item_snapshot`
//! dispatcher; only `item.completed` writes to `acc.turns` for
//! persistence.
//!
//! Each item type is reshaped into a Claude-style `assistant` event
//! (synthetic `tool_use` block, or thinking block for `reasoning`) so
//! the adapter has a single rendering path for both providers.

use serde_json::Value;

use super::StreamAccumulator;
use crate::pipeline::types::CollectedTurn;

pub(super) fn handle_item_completed(acc: &mut StreamAccumulator, raw_line: &str, value: &Value) {
    handle_item_snapshot(acc, raw_line, value, true);
}

/// Single entry point for Codex `item.started` / `item.updated` /
/// `item.completed`. Items are full snapshots so the rendering logic
/// is identical for all three; only `persist == true` (the completed
/// case) writes to `acc.turns`.
pub(super) fn handle_item_snapshot(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    value: &Value,
    persist: bool,
) {
    let item = match value.get("item") {
        Some(i) => i,
        None => return,
    };

    let item_type = item.get("type").and_then(Value::as_str);
    let item_id = item.get("id").and_then(Value::as_str).map(str::to_string);

    if item_type == Some("agent_message") {
        // Live agent_message text — only persisted when completed.
        if persist {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                if !acc.assistant_text.is_empty() {
                    acc.assistant_text.push_str("\n\n");
                }
                acc.assistant_text.push_str(text);
            }
            acc.turns.push(CollectedTurn {
                id: uuid::Uuid::new_v4().to_string(),
                role: "assistant".to_string(),
                content_json: raw_line.to_string(),
                collected_idx: None,
            });
        }
        acc.collect_or_replace(
            raw_line,
            value,
            "assistant",
            item_id.as_ref().map(|s| format!("codex-item:{s}")),
        );
        return;
    }

    if item_type == Some("todo_list") {
        handle_todo_list(acc, raw_line, item, item_id.as_deref(), persist);
        return;
    }

    if item_type == Some("reasoning") {
        handle_reasoning(acc, raw_line, item, item_id.as_deref(), persist);
        return;
    }

    if item_type == Some("file_change") {
        handle_file_change(acc, raw_line, item, item_id.as_deref(), persist);
        return;
    }

    if item_type == Some("web_search") {
        handle_web_search(acc, raw_line, item, item_id.as_deref(), persist);
        return;
    }

    if item_type == Some("mcp_tool_call") {
        handle_mcp_tool_call(acc, raw_line, item, item_id.as_deref(), persist);
        return;
    }

    if item_type == Some("command_execution") {
        handle_command_execution(acc, raw_line, item, item_id.as_deref(), persist);
        return;
    }

    if item_type == Some("error") {
        handle_codex_error_item(acc, raw_line, item, persist);
        return;
    }

    // Unknown item type — record for the drop-guard test so adding a new
    // SDK item type fails the build until a handler lands here.
    let label = format!("codex/item:{}", item_type.unwrap_or("<missing-item-type>"));
    if !acc.dropped_event_types.contains(&label) {
        acc.dropped_event_types.push(label);
    }
}

/// Codex `ErrorItem { type: "error", message: string }` — a non-fatal
/// error report at item granularity. Reshape into the same `{type:
/// error, message}` envelope `handle_codex_turn_failed` and Claude's
/// own error path use, so the downstream renderer treats all three
/// the same. The frontend never branches on provider.
fn handle_codex_error_item(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    persist: bool,
) {
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
    acc.collect_message(&s, &synthetic, "error", None);

    if persist {
        acc.turns.push(CollectedTurn {
            id: uuid::Uuid::new_v4().to_string(),
            role: "error".to_string(),
            content_json: raw_line.to_string(),
            collected_idx: None,
        });
    }
}

fn handle_command_execution(
    acc: &mut StreamAccumulator,
    raw_line: &str,
    item: &Value,
    item_id: Option<&str>,
    persist: bool,
) {
    let command = item.get("command").and_then(Value::as_str).unwrap_or("");
    // Real Codex SDK sends `aggregated_output`. The legacy fixture
    // (and possibly an older SDK build) used `output`. Read both so
    // both shapes work.
    let output = item
        .get("aggregated_output")
        .or_else(|| item.get("output"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let exit_code_raw = item.get("exit_code").and_then(Value::as_i64);
    let synthetic_id = item_id
        .map(|id| format!("codex-cmd-{id}"))
        .unwrap_or_else(|| format!("codex-cmd-{}", acc.line_count));

    // While the command is in flight (item.started / pre-completion
    // item.updated), exit_code is null and the tool_use carries a
    // `running` streaming_status so the frontend shows the spinner.
    // Once it lands (item.completed), the status flips to `done` and
    // the user tool_result is appended.
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
    let asst_id = item_id.map(|id| format!("codex-cmd-asst:{id}"));
    acc.collect_or_replace(&sa_str, &synthetic_assistant, "assistant", asst_id);

    // Skip the user tool_result entirely while running — the adapter
    // shows the bash card with a Running indicator until the result
    // arrives. Once exit_code lands, synthesize the tool_result and
    // route it through collect_or_replace so reruns of the same
    // logical item update in place.
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
        acc.collect_or_replace(&sr_str, &synthetic_result, "user", user_id);
    }

    if persist {
        acc.turns.push(CollectedTurn {
            id: uuid::Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content_json: raw_line.to_string(),
            collected_idx: None,
        });
    }
}

/// Synthesize a `WebSearch` tool_use from a Codex `web_search` item.
/// The query is the only meaningful field; pre-completion snapshots
/// render with `running` streaming_status. Codex doesn't expose the
/// search results in the item payload, so on completion we attach a
/// minimal "Search completed" result so the card resolves.
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

    // Codex's web_search item exposes no status field — unlike
    // command_execution (uses exit_code) or mcp_tool_call (uses
    // status). The only signal we have is whether the snapshot is
    // a started/updated event (persist=false) or the completed
    // event (persist=true).
    let is_running = !persist;
    let mut tool_use = serde_json::json!({
        "type": "tool_use",
        "id": synthetic_id,
        "name": "WebSearch",
        "input": {"query": query},
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
    let asst_id = item_id.map(|id| format!("codex-search-asst:{id}"));
    acc.collect_or_replace(&sa_str, &synthetic_assistant, "assistant", asst_id);

    if persist {
        let synthetic_result = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": synthetic_id,
                    "content": "Search completed",
                }]
            }
        });
        let sr_str = serde_json::to_string(&synthetic_result).unwrap_or_default();
        let user_id = item_id.map(|id| format!("codex-search-user:{id}"));
        acc.collect_or_replace(&sr_str, &synthetic_result, "user", user_id);

        acc.turns.push(CollectedTurn {
            id: uuid::Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content_json: raw_line.to_string(),
            collected_idx: None,
        });
    }
}

/// Synthesize a tool_use for a Codex `mcp_tool_call` item. The
/// synthetic tool_name follows the same `mcp__{server}__{tool}`
/// convention Claude uses, so the frontend's tool router treats
/// both providers identically.
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
    let asst_id = item_id.map(|id| format!("codex-mcp-asst:{id}"));
    acc.collect_or_replace(&sa_str, &synthetic_assistant, "assistant", asst_id);

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
        acc.collect_or_replace(&sr_str, &synthetic_result, "user", user_id);
    }

    if persist {
        acc.turns.push(CollectedTurn {
            id: uuid::Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content_json: raw_line.to_string(),
            collected_idx: None,
        });
    }
}

/// Synthesize an `apply_patch` tool_use + tool_result pair from a
/// Codex `file_change` item. The args carry the {path, kind} list;
/// the result carries the patch status. Pre-completion snapshots
/// (item.started without `status`) render with a `running`
/// streaming_status indicator.
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
    let asst_id = item_id.map(|id| format!("codex-patch-asst:{id}"));
    acc.collect_or_replace(&sa_str, &synthetic_assistant, "assistant", asst_id);

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
        acc.collect_or_replace(&sr_str, &synthetic_result, "user", user_id);
    }

    if persist {
        acc.turns.push(CollectedTurn {
            id: uuid::Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content_json: raw_line.to_string(),
            collected_idx: None,
        });
    }
}

/// Synthesize a Claude-style assistant `thinking` block from a
/// Codex `reasoning` item so it reuses the existing reasoning
/// rendering. Like todo_list, item.started/updated reuses the
/// same intermediate id via collect_or_replace.
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
    let synthetic_assistant = serde_json::json!({
        "type": "assistant",
        "message": {
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "thinking",
                "thinking": text,
            }]
        }
    });
    let sa_str = serde_json::to_string(&synthetic_assistant).unwrap_or_default();
    let intermediate_id = item_id.map(|id| format!("codex-reasoning:{id}"));
    acc.collect_or_replace(&sa_str, &synthetic_assistant, "assistant", intermediate_id);

    if persist {
        acc.turns.push(CollectedTurn {
            id: uuid::Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content_json: raw_line.to_string(),
            collected_idx: None,
        });
    }
}

/// Synthesize a Claude-style `TodoWrite` tool_use from a Codex
/// `todo_list` item, then route it through the same intermediate
/// pipeline. The adapter detects `tool_name == "TodoWrite"` and
/// converts to a unified `MessagePart::TodoList`, so both providers
/// render identically. `item.started` / `item.updated` snapshots
/// pass `persist == false`; only `item.completed` writes a turn.
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
    // Codex shape: [{text, completed}]. Map to Claude shape:
    // [{content, status}] so the adapter's existing TodoWrite parser
    // handles it without a Codex-specific code path.
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
    let intermediate_id = item_id.map(|id| format!("codex-todo-msg:{id}"));
    acc.collect_or_replace(&sa_str, &synthetic_assistant, "assistant", intermediate_id);

    if persist {
        acc.turns.push(CollectedTurn {
            id: uuid::Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content_json: raw_line.to_string(),
            collected_idx: None,
        });
    }
}
