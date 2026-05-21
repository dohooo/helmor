//! Copilot ACP event handling — `copilot/`-namespaced events from the sidecar.
//!
//! Events:
//!   - `session_init` (synthetic, carries session_id) — NoOp here
//!   - `status` RUNNING/FINISHED — turn boundary / finalize trigger
//!   - `thinking` (text delta), `assistant` (text delta)
//!   - `tool_call_start` / `tool_call_end` / `tool_call_update`
//!   - `plan` — plan update
//!
//! Output: synthesized Claude-format messages so the adapter is shared.

use std::collections::HashMap;

use chrono::Utc;
use serde_json::{json, Value};
use uuid::Uuid;

use super::super::types::{CollectedTurn, IntermediateMessage, MessageRole};
use super::{now_ms, PushOutcome, StreamAccumulator};

#[derive(Debug, Default)]
pub(in crate::pipeline) struct CopilotRunState {
    pub assistant_text: String,
    pub thinking_text: String,
    pub tools: Vec<CopilotToolCall>,
    pub tool_index: HashMap<String, usize>,
    pub started_at: Option<f64>,
}

#[derive(Debug, Default)]
pub(in crate::pipeline) struct CopilotToolCall {
    pub call_id: String,
    pub name: String,
    pub args: Value,
    pub output: String,
    pub result: Option<Value>,
    pub is_error: bool,
}

pub(super) fn new_run_state() -> CopilotRunState {
    CopilotRunState::default()
}

pub(super) fn handle_status(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match status {
        "RUNNING" => {
            acc.copilot_state = new_run_state();
            acc.copilot_state.started_at = Some(now_ms());
            PushOutcome::NoOp
        }
        "FINISHED" => finalize(acc),
        _ => PushOutcome::NoOp,
    }
}

pub(super) fn handle_thinking(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            acc.copilot_state.thinking_text.push_str(text);
            acc.saw_thinking_delta = true;
        }
    }
    PushOutcome::StreamingDelta
}

pub(super) fn handle_assistant_delta(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            acc.copilot_state.assistant_text.push_str(text);
            acc.saw_text_delta = true;
        }
    }
    PushOutcome::StreamingDelta
}

pub(super) fn handle_tool_call_start(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let call_id = value
        .get("call_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if call_id.is_empty() {
        return PushOutcome::NoOp;
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let args = value.get("args").cloned().unwrap_or(json!({}));

    let idx = acc.copilot_state.tools.len();
    acc.copilot_state.tools.push(CopilotToolCall {
        call_id: call_id.clone(),
        name,
        args,
        output: String::new(),
        result: None,
        is_error: false,
    });
    acc.copilot_state.tool_index.insert(call_id, idx);
    PushOutcome::StreamingDelta
}

pub(super) fn handle_tool_call_update(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let call_id = match value.get("call_id").and_then(Value::as_str) {
        Some(id) => id,
        None => return PushOutcome::NoOp,
    };
    let output = value.get("output").and_then(Value::as_str).unwrap_or("");

    if let Some(&idx) = acc.copilot_state.tool_index.get(call_id) {
        if let Some(entry) = acc.copilot_state.tools.get_mut(idx) {
            entry.output.push_str(output);
        }
    }
    PushOutcome::StreamingDelta
}

pub(super) fn handle_tool_call_end(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let call_id = match value.get("call_id").and_then(Value::as_str) {
        Some(id) => id,
        None => return PushOutcome::NoOp,
    };
    let result = value.get("result").cloned();
    let is_error = value
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if let Some(&idx) = acc.copilot_state.tool_index.get(call_id) {
        if let Some(entry) = acc.copilot_state.tools.get_mut(idx) {
            entry.result = result;
            entry.is_error = is_error;
        }
    }
    PushOutcome::StreamingDelta
}

#[allow(dead_code)]
pub(super) fn flush_in_progress(acc: &mut StreamAccumulator) {
    finalize(acc);
}

fn finalize(acc: &mut StreamAccumulator) -> PushOutcome {
    let state = std::mem::take(&mut acc.copilot_state);

    let has_text = !state.assistant_text.is_empty();
    let has_thinking = !state.thinking_text.is_empty();
    let has_tools = !state.tools.is_empty();
    if !has_text && !has_thinking && !has_tools {
        acc.fallback_text.clear();
        acc.fallback_thinking.clear();
        return PushOutcome::NoOp;
    }

    let assistant_id = acc
        .active_turn_id
        .take()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let session_id_value: Value = acc
        .session_id
        .as_deref()
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null);
    let resolved_model = acc.resolved_model.clone();
    let created_at = Utc::now().to_rfc3339();

    let mut content: Vec<Value> = Vec::with_capacity(2 + state.tools.len());
    if has_thinking {
        content.push(json!({
            "type": "thinking",
            "thinking": state.thinking_text,
            "signature": "",
        }));
    }
    for tool in &state.tools {
        content.push(json!({
            "type": "tool_use",
            "id": tool.call_id,
            "name": tool.name,
            "input": tool.args,
        }));
    }
    if has_text {
        content.push(json!({
            "type": "text",
            "text": state.assistant_text,
        }));
    }

    let assistant_msg = json!({
        "type": "assistant",
        "session_id": session_id_value,
        "message": {
            "id": assistant_id,
            "role": "assistant",
            "model": resolved_model,
            "content": content,
        },
    });
    let raw_json = assistant_msg.to_string();
    acc.collected.push(IntermediateMessage {
        id: assistant_id.clone(),
        role: MessageRole::Assistant,
        raw_json: raw_json.clone(),
        parsed: Some(assistant_msg),
        created_at: created_at.clone(),
        is_streaming: false,
    });
    acc.turns.push(CollectedTurn {
        id: assistant_id.clone(),
        role: MessageRole::Assistant,
        content_json: raw_json,
    });

    for tool in &state.tools {
        let Some(result) = &tool.result else { continue };
        let result_text = if !tool.output.is_empty() {
            tool.output.clone()
        } else {
            serde_json::to_string_pretty(result).unwrap_or_default()
        };
        let user_msg = json!({
            "type": "user",
            "session_id": session_id_value,
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool.call_id,
                    "content": result_text,
                    "is_error": tool.is_error,
                }],
            },
        });
        let raw = user_msg.to_string();
        let id = format!("tool_result_{}", tool.call_id);
        acc.collected.push(IntermediateMessage {
            id: id.clone(),
            role: MessageRole::User,
            raw_json: raw.clone(),
            parsed: Some(user_msg),
            created_at: created_at.clone(),
            is_streaming: false,
        });
        acc.turns.push(CollectedTurn {
            id,
            role: MessageRole::User,
            content_json: raw,
        });
    }

    if has_text {
        if !acc.assistant_text.is_empty() {
            acc.assistant_text.push('\n');
        }
        acc.assistant_text.push_str(&state.assistant_text);
    }
    if has_thinking {
        if !acc.thinking_text.is_empty() {
            acc.thinking_text.push('\n');
        }
        acc.thinking_text.push_str(&state.thinking_text);
    }

    if let Some(started) = state.started_at {
        let duration = now_ms() - started;
        if duration > 0.0 {
            let enriched = json!({ "type": "turn/completed", "duration_ms": duration });
            let enriched_str = serde_json::to_string(&enriched).unwrap_or_default();
            let id = Uuid::new_v4().to_string();
            acc.result_id = Some(id.clone());
            acc.result_json = Some(enriched_str.clone());
            acc.collect_message(&enriched_str, &enriched, MessageRole::Assistant, Some(&id));
        }
    }

    PushOutcome::Finalized
}
