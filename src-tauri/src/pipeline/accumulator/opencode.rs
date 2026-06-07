//! opencode event handling — `opencode/`-namespaced events from the sidecar.
//! `message.part.updated` snapshots carry FULL cumulative text and the SSE
//! stream is ordered → plain replace, no delta dedup. Output is an
//! `opencode_message` rendered by `adapter/opencode_parts.rs`.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::super::types::{CollectedTurn, MessageRole};
use super::{PushOutcome, StreamAccumulator};

#[derive(Debug, Default)]
pub(super) struct OpencodeRunState {
    pub turn_id: Option<String>,
    /// messageID → role. Only `assistant` parts render (user is the prompt echo).
    pub role_by_message_id: HashMap<String, String>,
    pub parts: Vec<Value>,
    /// partID → index into `parts`.
    pub part_index: HashMap<String, usize>,
    pub model: Option<String>,
    /// parentCallID → subagent run; `task` tools run in a child session whose
    /// parts (`opencode/subtask.*`) nest under the parent task tool's children.
    pub subtasks: HashMap<String, SubtaskAccum>,
}

#[derive(Debug, Default)]
pub(super) struct SubtaskAccum {
    pub role_by_message_id: HashMap<String, String>,
    pub parts: Vec<Value>,
    pub part_index: HashMap<String, usize>,
}

pub(super) fn new_run_state() -> OpencodeRunState {
    OpencodeRunState::default()
}

// ── Event handlers ──────────────────────────────────────────────────────────

pub(super) fn handle_message_updated(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let Some(info) = value.get("info") else {
        return PushOutcome::NoOp;
    };
    let Some(id) = info.get("id").and_then(Value::as_str) else {
        return PushOutcome::NoOp;
    };
    let role = info
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if role == "assistant" {
        if let Some(model) = info.get("model") {
            let provider = model.get("providerID").and_then(Value::as_str);
            let model_id = model.get("modelID").and_then(Value::as_str);
            if let (Some(p), Some(m)) = (provider, model_id) {
                let slug = format!("{p}/{m}");
                acc.opencode_state.model = Some(slug.clone());
                acc.resolved_model = slug;
            }
        }
    }
    acc.opencode_state
        .role_by_message_id
        .insert(id.to_string(), role);
    PushOutcome::NoOp
}

pub(super) fn handle_part_updated(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let Some(part) = value.get("part") else {
        return PushOutcome::NoOp;
    };
    let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
    let Some(part_id) = part.get("id").and_then(Value::as_str) else {
        return PushOutcome::NoOp;
    };
    // `compaction` rides a USER-role message but must still surface; every other
    // non-assistant part is a prompt echo and stays filtered.
    if kind != "compaction" && !is_assistant_part(acc, part) {
        return PushOutcome::NoOp;
    }
    if kind == "step-finish" {
        apply_step_finish_usage(acc, part);
        return PushOutcome::NoOp;
    }
    let rendered = match kind {
        "text" | "reasoning" => {
            let text = part.get("text").and_then(Value::as_str).unwrap_or_default();
            json!({ "type": kind, "text": text })
        }
        "tool" => render_tool_part(part),
        "file" => json!({
            "type": "file",
            "mime": part.get("mime").cloned().unwrap_or(Value::Null),
            "filename": part.get("filename").cloned().unwrap_or(Value::Null),
            "url": part.get("url").cloned().unwrap_or(Value::Null),
        }),
        "retry" => {
            let message = part
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| part.get("error").and_then(Value::as_str));
            json!({
                "type": "retry",
                "attempt": part.get("attempt").cloned().unwrap_or(Value::Null),
                "message": message,
            })
        }
        "compaction" => json!({
            "type": "compaction",
            "auto": part.get("auto").and_then(Value::as_bool).unwrap_or(false),
        }),
        // step-start / snapshot / patch / agent: not rendered, but handled so
        // they don't trip the coverage guard.
        _ => return PushOutcome::NoOp,
    };
    upsert_part(acc, part_id, rendered);
    rebuild_collected(acc);
    PushOutcome::StreamingDelta
}

// `input` is the per-step context size (keep latest = full window); `output` +
// `reasoning` are generated tokens (summed across steps).
fn apply_step_finish_usage(acc: &mut StreamAccumulator, part: &Value) {
    let Some(tokens) = part.get("tokens") else {
        return;
    };
    let i = |k: &str| tokens.get(k).and_then(Value::as_i64).unwrap_or(0);
    let cache_read = tokens
        .get("cache")
        .and_then(|c| c.get("read"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    acc.usage.input_tokens = Some(i("input") + cache_read);
    let generated = i("output") + i("reasoning");
    acc.usage.output_tokens = Some(acc.usage.output_tokens.unwrap_or(0) + generated);
}

// ── Subagent (`task` tool) child-session nesting ────────────────────────────

pub(super) fn handle_subtask_message_updated(
    acc: &mut StreamAccumulator,
    value: &Value,
) -> PushOutcome {
    let Some(parent) = value.get("parent_call_id").and_then(Value::as_str) else {
        return PushOutcome::NoOp;
    };
    let (Some(id), role) = (
        value
            .get("info")
            .and_then(|i| i.get("id"))
            .and_then(Value::as_str),
        value
            .get("info")
            .and_then(|i| i.get("role"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) else {
        return PushOutcome::NoOp;
    };
    acc.opencode_state
        .subtasks
        .entry(parent.to_string())
        .or_default()
        .role_by_message_id
        .insert(id.to_string(), role.to_string());
    PushOutcome::NoOp
}

pub(super) fn handle_subtask_part_updated(
    acc: &mut StreamAccumulator,
    value: &Value,
) -> PushOutcome {
    let Some(parent) = value
        .get("parent_call_id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return PushOutcome::NoOp;
    };
    let Some(part) = value.get("part") else {
        return PushOutcome::NoOp;
    };
    let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
    let Some(part_id) = part.get("id").and_then(Value::as_str) else {
        return PushOutcome::NoOp;
    };
    let message_id = part.get("messageID").and_then(Value::as_str);
    {
        let sub = acc
            .opencode_state
            .subtasks
            .entry(parent.clone())
            .or_default();
        let is_assistant = message_id
            .and_then(|m| sub.role_by_message_id.get(m))
            .map(String::as_str)
            == Some("assistant");
        if !is_assistant {
            return PushOutcome::NoOp;
        }
        let rendered = match kind {
            "text" | "reasoning" => {
                let text = part.get("text").and_then(Value::as_str).unwrap_or_default();
                json!({ "type": kind, "text": text })
            }
            "tool" => render_tool_part(part),
            _ => return PushOutcome::NoOp,
        };
        if let Some(&idx) = sub.part_index.get(part_id) {
            if let Some(slot) = sub.parts.get_mut(idx) {
                *slot = rendered;
            }
        } else {
            let idx = sub.parts.len();
            sub.parts.push(rendered);
            sub.part_index.insert(part_id.to_string(), idx);
        }
    }
    rebuild_collected(acc);
    PushOutcome::StreamingDelta
}

fn render_tool_part(part: &Value) -> Value {
    let call_id = part
        .get("callID")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tool = part.get("tool").and_then(Value::as_str).unwrap_or("tool");
    let state = part.get("state");
    let status = state
        .and_then(|s| s.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("pending");
    let input = state
        .and_then(|s| s.get("input"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let title = state.and_then(|s| s.get("title")).and_then(Value::as_str);
    let mut out = json!({
        "type": "tool",
        "callID": call_id,
        "tool": tool,
        "status": status,
        "input": input,
    });
    if let Some(t) = title {
        out["title"] = json!(t);
    }
    match status {
        "completed" => {
            let output = state.and_then(|s| s.get("output")).and_then(Value::as_str);
            if let Some(o) = output {
                out["output"] = json!(o);
            }
        }
        "error" => {
            let err = state.and_then(|s| s.get("error")).and_then(Value::as_str);
            out["output"] = json!(err.unwrap_or("Tool failed"));
            out["isError"] = json!(true);
        }
        _ => {}
    }
    out
}

pub(super) fn handle_session_idle(acc: &mut StreamAccumulator) -> PushOutcome {
    finalize(acc)
}

pub(super) fn handle_session_status(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let is_idle = value
        .get("status")
        .and_then(|s| s.get("type"))
        .and_then(Value::as_str)
        == Some("idle");
    if is_idle {
        finalize(acc)
    } else {
        PushOutcome::NoOp
    }
}

// Drain in-flight state on abort (no `session.idle` will arrive).
pub(super) fn flush_in_progress(acc: &mut StreamAccumulator) {
    finalize(acc);
}

// ── Internals ───────────────────────────────────────────────────────────────

fn is_assistant_message(acc: &StreamAccumulator, message_id: Option<&str>) -> bool {
    match message_id {
        Some(id) => {
            acc.opencode_state
                .role_by_message_id
                .get(id)
                .map(String::as_str)
                == Some("assistant")
        }
        None => false,
    }
}

fn is_assistant_part(acc: &StreamAccumulator, part: &Value) -> bool {
    is_assistant_message(acc, part.get("messageID").and_then(Value::as_str))
}

fn upsert_part(acc: &mut StreamAccumulator, part_id: &str, rendered: Value) {
    if let Some(&idx) = acc.opencode_state.part_index.get(part_id) {
        if let Some(slot) = acc.opencode_state.parts.get_mut(idx) {
            *slot = rendered;
        }
    } else {
        let idx = acc.opencode_state.parts.len();
        acc.opencode_state.parts.push(rendered);
        acc.opencode_state
            .part_index
            .insert(part_id.to_string(), idx);
    }
}

fn rebuild_collected(acc: &mut StreamAccumulator) {
    if acc.opencode_state.parts.is_empty() {
        return;
    }
    let turn_id = acc
        .opencode_state
        .turn_id
        .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
        .clone();

    // Inject each `task` tool's subagent run as its `children` for nested render.
    let subtasks = &acc.opencode_state.subtasks;
    let parts: Vec<Value> = acc
        .opencode_state
        .parts
        .iter()
        .map(|p| {
            if p.get("tool").and_then(Value::as_str) == Some("task") {
                if let Some(call_id) = p.get("callID").and_then(Value::as_str) {
                    if let Some(sub) = subtasks.get(call_id) {
                        if !sub.parts.is_empty() {
                            let mut with_children = p.clone();
                            with_children["children"] = json!(sub.parts);
                            return with_children;
                        }
                    }
                }
            }
            p.clone()
        })
        .collect();
    let session_id_value: Value = acc
        .session_id
        .as_deref()
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null);
    let message = json!({
        "type": "opencode_message",
        "session_id": session_id_value,
        "role": "assistant",
        "model": acc.opencode_state.model,
        "parts": parts,
    });
    let raw = message.to_string();

    if let Some(pos) = acc.collected.iter().rposition(|m| m.id == turn_id) {
        acc.collected[pos].raw_json = raw;
        acc.collected[pos].parsed = Some(message);
        acc.opencode_partial_idx = Some(pos);
    } else {
        let idx = acc.collected.len();
        acc.collect_message(&raw, &message, MessageRole::Assistant, Some(&turn_id));
        acc.opencode_partial_idx = Some(idx);
    }
}

fn finalize(acc: &mut StreamAccumulator) -> PushOutcome {
    if acc.opencode_state.parts.is_empty() {
        return PushOutcome::NoOp;
    }
    rebuild_collected(acc);
    acc.opencode_partial_idx = None;

    let turn_id = acc
        .opencode_state
        .turn_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let assistant_text: String = acc
        .opencode_state
        .parts
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    if !assistant_text.is_empty() {
        if !acc.assistant_text.is_empty() {
            acc.assistant_text.push('\n');
        }
        acc.assistant_text.push_str(&assistant_text);
    }

    if let Some(entry) = acc.collected.iter().rev().find(|m| m.id == turn_id) {
        acc.turns.push(CollectedTurn {
            id: turn_id,
            role: MessageRole::Assistant,
            content_json: entry.raw_json.clone(),
        });
    }

    // Reset per-turn state; role map persists across turns.
    acc.opencode_state.turn_id = None;
    acc.opencode_state.parts.clear();
    acc.opencode_state.part_index.clear();
    acc.opencode_state.subtasks.clear();

    PushOutcome::Finalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::accumulator::StreamAccumulator;
    use serde_json::json;

    fn updated(role_msg: &str, part_type: &str, part_id: &str, text: &str) -> serde_json::Value {
        json!({
            "type": "opencode/message.part.updated",
            "session_id": "ses_1",
            "part": { "type": part_type, "text": text, "messageID": role_msg, "id": part_id },
        })
    }

    #[test]
    fn assistant_text_snapshots_replace_and_finalize() {
        let mut acc = StreamAccumulator::new("opencode", "");
        acc.push_event(
            &json!({ "type": "opencode/message.updated", "session_id": "ses_1",
                     "info": { "id": "m1", "role": "assistant" } }),
            "",
        );
        // Cumulative snapshots for the same part.
        acc.push_event(&updated("m1", "text", "p1", "Hel"), "");
        acc.push_event(&updated("m1", "text", "p1", "Hello"), "");
        let out = acc.push_event(
            &json!({ "type": "opencode/session.idle", "session_id": "ses_1" }),
            "",
        );
        assert_eq!(out, PushOutcome::Finalized);
        let msgs = acc.collected();
        assert_eq!(msgs.len(), 1);
        let parsed = msgs[0].parsed.as_ref().unwrap();
        assert_eq!(parsed["type"], "opencode_message");
        assert_eq!(parsed["parts"][0]["text"], "Hello");
    }

    #[test]
    fn user_echo_parts_are_not_rendered() {
        let mut acc = StreamAccumulator::new("opencode", "");
        // opencode echoes the prompt as a user-role message + text part.
        acc.push_event(
            &json!({ "type": "opencode/message.updated", "session_id": "ses_1",
                     "info": { "id": "mu", "role": "user" } }),
            "",
        );
        let out = acc.push_event(&updated("mu", "text", "pu", "say hi"), "");
        assert_eq!(out, PushOutcome::NoOp);
        assert!(acc.collected().is_empty());
    }

    #[test]
    fn tool_part_carries_native_name_and_output() {
        let mut acc = StreamAccumulator::new("opencode", "");
        acc.push_event(
            &json!({ "type": "opencode/message.updated", "session_id": "ses_1",
                     "info": { "id": "m1", "role": "assistant" } }),
            "",
        );
        acc.push_event(&updated("m1", "text", "p1", "Listing files"), "");
        acc.push_event(
            &json!({
                "type": "opencode/message.part.updated", "session_id": "ses_1",
                "part": {
                    "type": "tool", "id": "p2", "messageID": "m1",
                    "callID": "call_1", "tool": "bash",
                    "state": { "status": "completed", "input": { "command": "ls" }, "output": "a.txt" },
                },
            }),
            "",
        );
        acc.push_event(
            &json!({ "type": "opencode/session.idle", "session_id": "ses_1" }),
            "",
        );
        let parsed = acc.collected()[0].parsed.as_ref().unwrap();
        let parts = parsed["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1]["type"], "tool");
        assert_eq!(parts[1]["tool"], "bash");
        assert_eq!(parts[1]["output"], "a.txt");
    }

    fn assistant(acc: &mut StreamAccumulator, msg_id: &str) {
        acc.push_event(
            &json!({ "type": "opencode/message.updated", "session_id": "ses_1",
                     "info": { "id": msg_id, "role": "assistant" } }),
            "",
        );
    }

    #[test]
    fn step_finish_populates_usage() {
        let mut acc = StreamAccumulator::new("opencode", "");
        assistant(&mut acc, "m1");
        acc.push_event(&updated("m1", "text", "p1", "hi"), "");
        acc.push_event(
            &json!({
                "type": "opencode/message.part.updated", "session_id": "ses_1",
                "part": { "type": "step-finish", "id": "sf1", "messageID": "m1",
                    "tokens": { "input": 100, "output": 20, "reasoning": 5,
                                "cache": { "read": 900, "write": 0 } } },
            }),
            "",
        );
        acc.push_event(
            &json!({
                "type": "opencode/message.part.updated", "session_id": "ses_1",
                "part": { "type": "step-finish", "id": "sf2", "messageID": "m1",
                    "tokens": { "input": 150, "output": 30, "reasoning": 0,
                                "cache": { "read": 950, "write": 0 } } },
            }),
            "",
        );
        // input = last step's input + cache.read; output = sum of generated.
        assert_eq!(acc.usage.input_tokens, Some(150 + 950));
        assert_eq!(acc.usage.output_tokens, Some(25 + 30));
        acc.push_event(
            &json!({ "type": "opencode/session.idle", "session_id": "ses_1" }),
            "",
        );
        let parts = acc.collected()[0].parsed.as_ref().unwrap()["parts"]
            .as_array()
            .unwrap()
            .clone();
        assert!(parts.iter().all(|p| p["type"] != "step-finish"));
    }

    #[test]
    fn file_retry_compaction_parts_are_stored() {
        let mut acc = StreamAccumulator::new("opencode", "");
        assistant(&mut acc, "m1");
        acc.push_event(
            &json!({ "type": "opencode/message.part.updated", "session_id": "ses_1",
                "part": { "type": "file", "id": "f1", "messageID": "m1",
                    "mime": "image/png", "filename": "a.png", "url": "data:image/png;base64,QQ" } }),
            "",
        );
        acc.push_event(
            &json!({ "type": "opencode/message.part.updated", "session_id": "ses_1",
                "part": { "type": "retry", "id": "r1", "messageID": "m1",
                    "attempt": 2, "message": "rate limited" } }),
            "",
        );
        acc.push_event(
            &json!({ "type": "opencode/message.part.updated", "session_id": "ses_1",
                "part": { "type": "compaction", "id": "cmp1", "messageID": "m1", "auto": true } }),
            "",
        );
        acc.push_event(
            &json!({ "type": "opencode/session.idle", "session_id": "ses_1" }),
            "",
        );
        let parsed = acc.collected()[0].parsed.as_ref().unwrap();
        let kinds: Vec<&str> = parsed["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, vec!["file", "retry", "compaction"]);
    }

    #[test]
    fn subtask_events_nest_under_parent_task_tool() {
        let mut acc = StreamAccumulator::new("opencode", "");
        assistant(&mut acc, "m1");
        acc.push_event(
            &json!({
                "type": "opencode/message.part.updated", "session_id": "ses_1",
                "part": { "type": "tool", "id": "p1", "messageID": "m1",
                    "callID": "task_1", "tool": "task",
                    "state": { "status": "running", "input": { "subagent_type": "general" } } },
            }),
            "",
        );
        // Child session: role first, then parts tagged with parent_call_id.
        acc.push_event(
            &json!({ "type": "opencode/subtask.message.updated", "session_id": "child_1",
                "parent_call_id": "task_1", "info": { "id": "cm1", "role": "assistant" } }),
            "",
        );
        let out = acc.push_event(
            &json!({ "type": "opencode/subtask.message.part.updated", "session_id": "child_1",
                "parent_call_id": "task_1",
                "part": { "type": "text", "id": "cp1", "messageID": "cm1", "text": "child reply" } }),
            "",
        );
        assert_eq!(out, PushOutcome::StreamingDelta);
        acc.push_event(
            &json!({ "type": "opencode/session.idle", "session_id": "ses_1" }),
            "",
        );
        let parsed = acc.collected()[0].parsed.as_ref().unwrap();
        let task = &parsed["parts"][0];
        assert_eq!(task["tool"], "task");
        let children = task["children"].as_array().expect("task has children");
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["type"], "text");
        assert_eq!(children[0]["text"], "child reply");
    }

    #[test]
    fn subtask_user_echo_is_not_nested() {
        let mut acc = StreamAccumulator::new("opencode", "");
        assistant(&mut acc, "m1");
        acc.push_event(
            &json!({
                "type": "opencode/message.part.updated", "session_id": "ses_1",
                "part": { "type": "tool", "id": "p1", "messageID": "m1",
                    "callID": "task_1", "tool": "task",
                    "state": { "status": "running", "input": {} } },
            }),
            "",
        );
        // Child echoes the task prompt as a USER message — must not nest.
        acc.push_event(
            &json!({ "type": "opencode/subtask.message.updated", "session_id": "child_1",
                "parent_call_id": "task_1", "info": { "id": "cu1", "role": "user" } }),
            "",
        );
        let out = acc.push_event(
            &json!({ "type": "opencode/subtask.message.part.updated", "session_id": "child_1",
                "parent_call_id": "task_1",
                "part": { "type": "text", "id": "cup1", "messageID": "cu1", "text": "the task prompt" } }),
            "",
        );
        assert_eq!(out, PushOutcome::NoOp);
        acc.push_event(
            &json!({ "type": "opencode/session.idle", "session_id": "ses_1" }),
            "",
        );
        let task = &acc.collected()[0].parsed.as_ref().unwrap()["parts"][0];
        assert!(task.get("children").is_none());
    }

    #[test]
    fn compaction_marker_on_user_message_renders() {
        // `compaction` rides a user-role message but must still surface.
        let mut acc = StreamAccumulator::new("opencode", "");
        acc.push_event(
            &json!({ "type": "opencode/message.updated", "session_id": "ses_1",
                     "info": { "id": "mc", "role": "user" } }),
            "",
        );
        let out = acc.push_event(
            &json!({ "type": "opencode/message.part.updated", "session_id": "ses_1",
                "part": { "type": "compaction", "id": "pcmp", "messageID": "mc", "auto": false } }),
            "",
        );
        assert_eq!(out, PushOutcome::StreamingDelta);
        assistant(&mut acc, "ms");
        acc.push_event(&updated("ms", "text", "pt", "## Summary"), "");
        acc.push_event(
            &json!({ "type": "opencode/session.idle", "session_id": "ses_1" }),
            "",
        );
        let kinds: Vec<&str> = acc.collected()[0].parsed.as_ref().unwrap()["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, vec!["compaction", "text"]);

        // A normal user-text part is still dropped (prompt echo).
        let mut echo = StreamAccumulator::new("opencode", "");
        echo.push_event(
            &json!({ "type": "opencode/message.updated", "session_id": "ses_1",
                     "info": { "id": "u", "role": "user" } }),
            "",
        );
        let echo_out = echo.push_event(&updated("u", "text", "pu", "hi"), "");
        assert_eq!(echo_out, PushOutcome::NoOp);
        assert!(echo.collected().is_empty());
    }

    #[test]
    fn informational_events_are_handled_as_noops_not_dropped() {
        // Must stay explicit NoOps, else the `dropped_event_types` coverage guard fails.
        let mut acc = StreamAccumulator::new("opencode", "");
        for ty in [
            "opencode/message.part.delta",
            "opencode/session.error",
            "opencode/session.created",
            "opencode/session.updated",
            "opencode/session.diff",
            "opencode/todo.updated",
            "opencode/message.removed",
            "opencode/message.part.removed",
        ] {
            let out = acc.push_event(&json!({ "type": ty, "session_id": "ses_1" }), "");
            assert_eq!(out, PushOutcome::NoOp, "{ty} should be a NoOp");
        }
        assert!(
            acc.dropped_event_types().is_empty(),
            "informational events must not be dropped: {:?}",
            acc.dropped_event_types()
        );
        assert!(acc.collected().is_empty());
    }
}
