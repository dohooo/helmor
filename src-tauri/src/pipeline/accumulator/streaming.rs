//! Claude streaming-block handling.
//!
//! Owns the per-block state machine (`StreamingBlock`) and every handler
//! that consumes a `stream_event` envelope: content_block_start /
//! _delta / _stop, the legacy flat-delta path, tool_progress, and the
//! two `build_partial_*` constructors that snapshot mid-stream state
//! into an `IntermediateMessage` for the renderer.

use serde_json::Value;

use super::StreamAccumulator;
use crate::pipeline::types::IntermediateMessage;

/// Per-content-block streaming state. Indexed by `index` from the
/// `content_block_start` event so deltas land in the right slot.
#[derive(Debug, Clone)]
pub(super) enum StreamingBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
        /// Set to true when content_block_stop arrives.
        done: bool,
    },
    ToolUse {
        tool_use_id: String,
        tool_name: String,
        input_json_text: String,
        parsed_input: Option<Value>,
        status: &'static str,
    },
}

pub(super) fn handle_stream_event(acc: &mut StreamAccumulator, value: &Value) {
    let event = match value.get("event") {
        Some(e) => e,
        None => return,
    };
    let event_type = event.get("type").and_then(Value::as_str);

    match event_type {
        Some("content_block_start") => {
            acc.has_block_structure = true;
            handle_block_start(acc, event);
        }
        Some("content_block_delta") => {
            if acc.has_block_structure {
                handle_block_delta(acc, event);
            } else {
                handle_legacy_delta(acc, event);
            }
        }
        Some("content_block_stop") => {
            handle_block_stop(acc, event);
        }
        _ => {
            // Legacy/simple delta format (no eventType, just delta object)
            if let Some(delta) = event.get("delta") {
                if event_type.is_none() {
                    apply_delta(acc, delta);
                }
            }
        }
    }
}

fn handle_block_start(acc: &mut StreamAccumulator, event: &Value) {
    let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
    let content_block = match event.get("content_block") {
        Some(cb) => cb,
        None => return,
    };
    let block_type = content_block
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("");

    match block_type {
        "text" => {
            acc.blocks.insert(
                index,
                StreamingBlock::Text {
                    text: String::new(),
                },
            );
        }
        "thinking" => {
            acc.blocks.insert(
                index,
                StreamingBlock::Thinking {
                    text: String::new(),
                    done: false,
                },
            );
        }
        "tool_use" => {
            acc.blocks.insert(
                index,
                StreamingBlock::ToolUse {
                    tool_use_id: content_block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    tool_name: content_block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    input_json_text: String::new(),
                    parsed_input: None,
                    status: "pending",
                },
            );
        }
        _ => {}
    }
}

fn handle_block_delta(acc: &mut StreamAccumulator, event: &Value) {
    let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
    let delta = match event.get("delta") {
        Some(d) => d,
        None => return,
    };
    let block = match acc.blocks.get_mut(&index) {
        Some(b) => b,
        None => return,
    };
    let delta_type = delta.get("type").and_then(Value::as_str);

    match (block, delta_type) {
        (StreamingBlock::Text { text }, Some("text_delta")) => {
            if let Some(dt) = delta.get("text").and_then(Value::as_str) {
                text.push_str(dt);
                // Also accumulate for persistence
                acc.assistant_text.push_str(dt);
                acc.saw_text_delta = true;
            }
        }
        (StreamingBlock::Thinking { text, .. }, Some("thinking_delta")) => {
            if let Some(dt) = delta.get("thinking").and_then(Value::as_str) {
                text.push_str(dt);
                acc.thinking_text.push_str(dt);
                acc.saw_thinking_delta = true;
            }
        }
        (
            StreamingBlock::ToolUse {
                input_json_text,
                status,
                ..
            },
            Some("input_json_delta"),
        ) => {
            if let Some(pj) = delta.get("partial_json").and_then(Value::as_str) {
                input_json_text.push_str(pj);
                *status = "streaming_input";
            }
        }
        _ => {}
    }
}

fn handle_block_stop(acc: &mut StreamAccumulator, event: &Value) {
    let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
    match acc.blocks.get_mut(&index) {
        Some(StreamingBlock::Thinking { done, .. }) => {
            *done = true;
        }
        Some(StreamingBlock::ToolUse {
            input_json_text,
            parsed_input,
            status,
            ..
        }) => {
            if !input_json_text.is_empty() {
                if let Ok(v) = serde_json::from_str::<Value>(input_json_text) {
                    *parsed_input = Some(v);
                }
            }
            *status = "running";
        }
        _ => {}
    }
}

fn handle_legacy_delta(acc: &mut StreamAccumulator, event: &Value) {
    if let Some(delta) = event.get("delta") {
        if let Some(text) = delta.get("text").and_then(Value::as_str) {
            acc.fallback_text.push_str(text);
            acc.assistant_text.push_str(text);
            acc.saw_text_delta = true;
        }
        if let Some(thinking) = delta.get("thinking").and_then(Value::as_str) {
            acc.fallback_thinking.push_str(thinking);
            acc.thinking_text.push_str(thinking);
            acc.saw_thinking_delta = true;
        }
    }
}

fn apply_delta(acc: &mut StreamAccumulator, delta: &Value) {
    if let Some(text) = delta.get("text").and_then(Value::as_str) {
        if acc.has_block_structure {
            append_to_last_text_block(acc, text);
        } else {
            acc.fallback_text.push_str(text);
        }
        acc.assistant_text.push_str(text);
        acc.saw_text_delta = true;
    }
    if let Some(thinking) = delta.get("thinking").and_then(Value::as_str) {
        if acc.has_block_structure {
            append_to_last_thinking_block(acc, thinking);
        } else {
            acc.fallback_thinking.push_str(thinking);
        }
        acc.thinking_text.push_str(thinking);
        acc.saw_thinking_delta = true;
    }
}

pub(super) fn handle_tool_progress(acc: &mut StreamAccumulator, value: &Value) {
    let tool_use_id = match value.get("tool_use_id").and_then(Value::as_str) {
        Some(id) => id,
        None => return,
    };
    for block in acc.blocks.values_mut() {
        if let StreamingBlock::ToolUse {
            tool_use_id: id,
            status,
            ..
        } = block
        {
            if id == tool_use_id {
                *status = "running";
                break;
            }
        }
    }
}

fn append_to_last_text_block(acc: &mut StreamAccumulator, text: &str) {
    for block in acc.blocks.values_mut().rev() {
        if let StreamingBlock::Text { text: t } = block {
            t.push_str(text);
            return;
        }
    }
    // No text block exists — create one
    let idx = acc.blocks.len();
    acc.blocks.insert(
        idx,
        StreamingBlock::Text {
            text: text.to_string(),
        },
    );
}

fn append_to_last_thinking_block(acc: &mut StreamAccumulator, text: &str) {
    for block in acc.blocks.values_mut().rev() {
        if let StreamingBlock::Thinking { text: t, .. } = block {
            t.push_str(text);
            return;
        }
    }
    let idx = acc.blocks.len();
    acc.blocks.insert(
        idx,
        StreamingBlock::Thinking {
            text: text.to_string(),
            done: false,
        },
    );
}

pub(super) fn build_partial_from_blocks(
    acc: &StreamAccumulator,
    _session_id: &str,
    partial_id: String,
    created_at: String,
) -> IntermediateMessage {
    let mut content_blocks = Vec::new();
    for block in acc.blocks.values() {
        match block {
            StreamingBlock::Text { text } => {
                let display = if text.is_empty() {
                    "..."
                } else {
                    text.as_str()
                };
                content_blocks.push(serde_json::json!({"type": "text", "text": display}));
            }
            StreamingBlock::Thinking { text, done } => {
                if !text.is_empty() {
                    content_blocks.push(serde_json::json!({
                        "type": "thinking",
                        "thinking": text,
                        "__is_streaming": !done,
                    }));
                }
            }
            StreamingBlock::ToolUse {
                tool_use_id,
                tool_name,
                input_json_text,
                parsed_input,
                status,
            } => {
                let input = parsed_input
                    .clone()
                    .unwrap_or_else(|| serde_json::json!({}));
                content_blocks.push(serde_json::json!({
                    "type": "tool_use",
                    "id": tool_use_id,
                    "name": tool_name,
                    "input": input,
                    "__streaming_status": status,
                    "__input_json_text": input_json_text,
                }));
            }
        }
    }

    if content_blocks.is_empty() {
        content_blocks.push(serde_json::json!({"type": "text", "text": "..."}));
    }

    let parsed = serde_json::json!({
        "type": "assistant",
        "message": {
            "type": "message",
            "role": "assistant",
            "content": content_blocks,
        },
        "__streaming": true,
    });

    IntermediateMessage {
        id: partial_id,
        role: "assistant".to_string(),
        raw_json: serde_json::to_string(&parsed).unwrap_or_default(),
        parsed: Some(parsed),
        created_at,
        is_streaming: true,
    }
}

pub(super) fn build_partial_fallback(
    acc: &StreamAccumulator,
    _session_id: &str,
    partial_id: String,
    created_at: String,
) -> IntermediateMessage {
    let text = acc.fallback_text.trim();
    let thinking = acc.fallback_thinking.trim();
    let display_text = if text.is_empty() { "..." } else { text };

    let parsed = if !thinking.is_empty() {
        serde_json::json!({
            "type": "assistant",
            "message": {
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": thinking},
                    {"type": "text", "text": display_text},
                ],
            },
            "__streaming": true,
        })
    } else {
        serde_json::json!({
            "type": "assistant",
            "message": {
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "text", "text": display_text},
                ],
            },
            "__streaming": true,
        })
    };

    IntermediateMessage {
        id: partial_id,
        role: "assistant".to_string(),
        raw_json: serde_json::to_string(&parsed).unwrap_or_default(),
        parsed: Some(parsed),
        created_at,
        is_streaming: true,
    }
}

// ---------------------------------------------------------------------------
// Claude payload extraction helpers used by the full-message handlers in
// `mod.rs` to fall back when delta accumulation didn't catch any text.
// ---------------------------------------------------------------------------

pub(super) fn extract_claude_model_name(value: &Value) -> Option<String> {
    if let Some(model) = value.get("model").and_then(Value::as_str) {
        return Some(model.to_string());
    }
    if let Some(model) = value
        .get("message")
        .and_then(|m| m.get("model"))
        .and_then(Value::as_str)
    {
        return Some(model.to_string());
    }
    if let Some(model) = value
        .get("model")
        .and_then(|m| m.get("display_name"))
        .and_then(Value::as_str)
    {
        return Some(model.to_string());
    }
    None
}

pub(super) fn extract_claude_assistant_text(value: &Value) -> Option<String> {
    let content = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)?;
    let text: String = content
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                block.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.trim().is_empty()).then_some(text)
}

pub(super) fn extract_claude_thinking_text(value: &Value) -> Option<String> {
    let content = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)?;
    let text: String = content
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some("thinking") {
                block.get("thinking").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.trim().is_empty()).then_some(text)
}
