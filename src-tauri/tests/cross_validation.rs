//! Cross-validation snapshot tests for the message pipeline.
//!
//! Ported from `feat/rust-stream-accumulator`'s
//! `src-tauri/src/message_adapter.rs::cross_validation_tests` module.
//!
//! # Strategy
//!
//! Each test feeds a tiny handcrafted scenario into
//! `MessagePipeline::convert_historical` and freezes the resulting
//! `Vec<ThreadMessageLike>` via `insta::assert_yaml_snapshot!`. The output
//! goes through a normalization pass first that:
//!
//! - strips volatile fields (timestamps)
//! - converts `MessageRole` enum to a lowercase string
//! - truncates long strings to `[head]...[tail][len:N]`
//! - reports tool-call args as sorted key sets + UTF-16 length
//!
//! This makes the snapshots short enough to review in a diff and stable
//! across pipeline implementation changes that don't affect output shape.
//!
//! # Coverage
//!
//! Selected categories where the existing inline pipeline unit tests
//! were thinnest:
//!
//! - `err_*`  — error message normalization (5)
//! - `user_*` — user message edge cases (5)
//! - `res_*`  — result message duration / token formatting (6)
//! - `edge_*` — empty/100-alternating/unknown-type/non-json (8)
//! - `asst_*` — selected assistant variants (5)
//! - `sys_*`  — system message rendering (2)
//! - `merge_*` — merging boundaries (2)
//!
//! Intentionally **not** ported: `xv_child_*`, `xv_codex_*`, `xv_collapse_*`
//! and the simpler `xv_asst_*` / `xv_merge_*` cases — either already covered
//! by inline `pipeline::*::tests` or at risk of behavioral divergence.
//!
//! # Updating snapshots
//!
//! ```sh
//! INSTA_UPDATE=always cargo test --test cross_validation
//! # or, with the insta CLI:
//! cargo insta test --test-runner cargo --review
//! ```

use helmor_lib::pipeline::types::{
    ExtendedMessagePart, HistoricalRecord, MessagePart, MessageRole, StreamingStatus,
    ThreadMessageLike,
};
use helmor_lib::pipeline::MessagePipeline;
use insta::assert_yaml_snapshot;
use serde::Serialize;
use serde_json::{json, Value};

// ============================================================================
// Normalized snapshot format
// ============================================================================

#[derive(Debug, Serialize)]
struct NormThreadMessage {
    role: String,
    id: Option<String>,
    content_length: usize,
    content: Vec<NormPart>,
    status: Option<NormStatus>,
    streaming: Option<bool>,
}

#[derive(Debug, Serialize)]
struct NormStatus {
    #[serde(rename = "type")]
    status_type: String,
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum NormPart {
    Text {
        text: String,
    },
    Reasoning {
        text_length: usize,
        text_preview: String,
        streaming: Option<bool>,
    },
    ToolCall {
        tool_name: String,
        tool_call_id: String,
        args_keys: Vec<String>,
        args_text_length: usize,
        has_result: bool,
        result_kind: Option<String>,
        result_preview: Option<String>,
        streaming_status: Option<String>,
    },
    /// Collapsed group placeholder. None of the ported scenarios are
    /// expected to trigger collapse, but if one does we want a clear marker
    /// in the snapshot rather than a panic.
    CollapsedGroup {
        category: String,
        tools_count: usize,
        active: bool,
        summary: String,
    },
}

fn truncate(s: &str) -> String {
    // UTF-16 code-unit semantics — matches TS string.length / slice
    // so the snapshot format stays comparable across Rust and TS reference.
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= 100 {
        return s.to_string();
    }
    let first = String::from_utf16_lossy(&units[..50]);
    let last = String::from_utf16_lossy(&units[units.len() - 50..]);
    format!("{first}...{last}[len:{}]", units.len())
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn streaming_status_str(s: &StreamingStatus) -> String {
    match s {
        StreamingStatus::Pending => "pending",
        StreamingStatus::StreamingInput => "streaming_input",
        StreamingStatus::Running => "running",
        StreamingStatus::Done => "done",
        StreamingStatus::Error => "error",
    }
    .to_string()
}

fn role_str(role: &MessageRole) -> String {
    match role {
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
        MessageRole::User => "user",
    }
    .to_string()
}

fn normalize_basic(part: &MessagePart) -> NormPart {
    match part {
        MessagePart::Text { text } => NormPart::Text {
            text: truncate(text),
        },
        MessagePart::Reasoning { text, streaming } => NormPart::Reasoning {
            text_length: utf16_len(text),
            text_preview: truncate(text),
            streaming: *streaming,
        },
        MessagePart::ToolCall {
            tool_call_id,
            tool_name,
            args,
            args_text,
            result,
            streaming_status,
        } => {
            let mut keys: Vec<String> = args
                .as_object()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            keys.sort();
            let (has_result, result_kind, result_preview) = match result {
                None => (false, None, None),
                Some(v) => {
                    if let Some(s) = v.as_str() {
                        let kind = if s.starts_with("__children__") {
                            "children-marker"
                        } else {
                            "string"
                        };
                        (true, Some(kind.to_string()), Some(truncate(s)))
                    } else {
                        let kind = match v {
                            Value::Number(_) => "number",
                            Value::Bool(_) => "boolean",
                            Value::Array(_) => "array",
                            Value::Object(_) => "object",
                            Value::Null => "null",
                            _ => "other",
                        };
                        (true, Some(kind.to_string()), None)
                    }
                }
            };
            NormPart::ToolCall {
                tool_name: tool_name.clone(),
                tool_call_id: tool_call_id.clone(),
                args_keys: keys,
                args_text_length: utf16_len(args_text),
                has_result,
                result_kind,
                result_preview,
                streaming_status: streaming_status.as_ref().map(streaming_status_str),
            }
        }
    }
}

fn normalize_part(part: &ExtendedMessagePart) -> NormPart {
    match part {
        ExtendedMessagePart::Basic(p) => normalize_basic(p),
        ExtendedMessagePart::CollapsedGroup(g) => NormPart::CollapsedGroup {
            category: format!("{:?}", g.category).to_lowercase(),
            tools_count: g.tools.len(),
            active: g.active,
            summary: g.summary.clone(),
        },
    }
}

fn normalize_message(msg: &ThreadMessageLike) -> NormThreadMessage {
    NormThreadMessage {
        role: role_str(&msg.role),
        id: msg.id.clone(),
        content_length: msg.content.len(),
        content: msg.content.iter().map(normalize_part).collect(),
        status: msg.status.as_ref().map(|s| NormStatus {
            status_type: s.status_type.clone(),
            reason: s.reason.clone(),
        }),
        streaming: msg.streaming,
    }
}

fn normalize_all(msgs: &[ThreadMessageLike]) -> Vec<NormThreadMessage> {
    msgs.iter().map(normalize_message).collect()
}

// ============================================================================
// Builders — produce HistoricalRecord with parsed_content pre-computed
// (the production loader in `sessions.rs` does the same parse upstream).
// ============================================================================

fn make_record(id: &str, role: &str, content: &str, content_is_json: bool) -> HistoricalRecord {
    let parsed_content = if content_is_json {
        serde_json::from_str::<Value>(content).ok()
    } else {
        None
    };
    HistoricalRecord {
        id: id.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        content_is_json,
        parsed_content,
        created_at: "2026-04-06T00:00:00.000Z".to_string(),
    }
}

fn assistant_json(id: &str, blocks: Value, extra: Option<Value>) -> HistoricalRecord {
    let mut parsed = json!({
        "type": "assistant",
        "message": { "role": "assistant", "content": blocks },
    });
    if let Some(e) = extra {
        if let Some(obj) = e.as_object() {
            for (k, v) in obj {
                parsed[k] = v.clone();
            }
        }
    }
    make_record(
        id,
        "assistant",
        &serde_json::to_string(&parsed).unwrap(),
        true,
    )
}

fn user_json(id: &str, blocks: Value) -> HistoricalRecord {
    let parsed = json!({
        "type": "user",
        "message": { "role": "user", "content": blocks },
    });
    make_record(id, "user", &serde_json::to_string(&parsed).unwrap(), true)
}

fn system_json(id: &str, extra: Value) -> HistoricalRecord {
    let mut parsed = json!({ "type": "system" });
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            parsed[k] = v.clone();
        }
    }
    make_record(id, "system", &serde_json::to_string(&parsed).unwrap(), true)
}

fn result_json(id: &str, extra: Value) -> HistoricalRecord {
    let mut parsed = json!({ "type": "result" });
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            parsed[k] = v.clone();
        }
    }
    make_record(
        id,
        "assistant",
        &serde_json::to_string(&parsed).unwrap(),
        true,
    )
}

fn run(msgs: Vec<HistoricalRecord>) -> Vec<NormThreadMessage> {
    normalize_all(&MessagePipeline::convert_historical(&msgs))
}

// ============================================================================
// 1. Error messages
// ============================================================================

#[test]
fn xv_err_content_string() {
    let parsed = json!({ "type": "error", "content": "Something broke" });
    let msgs = vec![make_record(
        "e1",
        "error",
        &serde_json::to_string(&parsed).unwrap(),
        true,
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_err_message_string() {
    let parsed = json!({ "type": "error", "message": "Boom" });
    let msgs = vec![make_record(
        "e1",
        "error",
        &serde_json::to_string(&parsed).unwrap(),
        true,
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_err_role_plain_text() {
    let msgs = vec![make_record("e1", "error", "crash!", false)];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_err_raw_json_content() {
    let raw = serde_json::to_string(&json!({ "content": "inner error" })).unwrap();
    let msgs = vec![make_record("e1", "error", &raw, false)];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_err_empty() {
    let parsed = json!({ "type": "error" });
    let msgs = vec![make_record(
        "e1",
        "error",
        &serde_json::to_string(&parsed).unwrap(),
        true,
    )];
    assert_yaml_snapshot!(run(msgs));
}

// ============================================================================
// 2. User messages
// ============================================================================

#[test]
fn xv_user_plain_text() {
    let msgs = vec![make_record("u1", "user", "hello assistant", false)];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_user_json_text_swallowed() {
    // JSON user message with pure text content is dropped (the assistant
    // already has the prompt; this avoids double-rendering).
    let msgs = vec![user_json(
        "u1",
        json!([{ "type": "text", "text": "please do X" }]),
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_user_tool_result_only_no_prev() {
    let msgs = vec![user_json(
        "u1",
        json!([{ "type": "tool_result", "tool_use_id": "tX", "content": "out" }]),
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_user_mixed_text_and_tool_result() {
    let msgs = vec![user_json(
        "u1",
        json!([
            { "type": "text", "text": "note" },
            { "type": "tool_result", "tool_use_id": "tX", "content": "out" }
        ]),
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_user_multi_plain_text() {
    let msgs = vec![
        make_record("u1", "user", "first", false),
        make_record("u2", "user", "second", false),
    ];
    assert_yaml_snapshot!(run(msgs));
}

// ============================================================================
// 3. Result messages
// ============================================================================

#[test]
fn xv_res_full() {
    let msgs = vec![result_json(
        "r1",
        json!({
            "total_cost_usd": 0.0123,
            "duration_ms": 4500,
            "usage": { "input_tokens": 1234, "output_tokens": 567 }
        }),
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_res_duration_only() {
    let msgs = vec![result_json("r1", json!({ "duration_ms": 1500 }))];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_res_duration_long() {
    let msgs = vec![result_json("r1", json!({ "duration_ms": 125_000 }))];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_res_duration_exact_60s() {
    let msgs = vec![result_json("r1", json!({ "duration_ms": 60_000 }))];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_res_duration_short() {
    let msgs = vec![result_json("r1", json!({ "duration_ms": 3456 }))];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_res_large_tokens() {
    let msgs = vec![result_json(
        "r1",
        json!({
            "duration_ms": 2000,
            "usage": { "input_tokens": 1_234_567, "output_tokens": 98_765 }
        }),
    )];
    assert_yaml_snapshot!(run(msgs));
}

// ============================================================================
// 4. Edge cases
// ============================================================================

#[test]
fn xv_edge_empty_array() {
    assert_yaml_snapshot!(run(vec![]));
}

#[test]
fn xv_edge_single_assistant_text() {
    let msgs = vec![assistant_json(
        "a1",
        json!([{ "type": "text", "text": "hi" }]),
        None,
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_edge_100_alternating() {
    let mut msgs: Vec<HistoricalRecord> = Vec::new();
    for i in 0..100 {
        if i % 2 == 0 {
            msgs.push(make_record(
                &format!("u{i}"),
                "user",
                &format!("msg {i}"),
                false,
            ));
        } else {
            msgs.push(assistant_json(
                &format!("a{i}"),
                json!([{ "type": "text", "text": format!("reply {i}") }]),
                None,
            ));
        }
    }
    let rendered = MessagePipeline::convert_historical(&msgs);

    // High-level structural summary instead of the full normalized form —
    // the bulk content isn't interesting, the shape is.
    #[derive(Serialize)]
    struct Summary {
        total: usize,
        roles: Vec<String>,
        first_id: Option<String>,
        last_id: Option<String>,
    }
    let summary = Summary {
        total: rendered.len(),
        roles: rendered.iter().map(|m| role_str(&m.role)).collect(),
        first_id: rendered.first().and_then(|m| m.id.clone()),
        last_id: rendered.last().and_then(|m| m.id.clone()),
    };
    assert_yaml_snapshot!(summary);
}

#[test]
fn xv_edge_unknown_type() {
    let parsed = json!({ "type": "mystery_event", "whatever": 1 });
    let msgs = vec![make_record(
        "x1",
        "assistant",
        &serde_json::to_string(&parsed).unwrap(),
        true,
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_edge_no_type_no_role_match() {
    let parsed = json!({ "foo": "bar" });
    let msgs = vec![make_record(
        "x1",
        "assistant",
        &serde_json::to_string(&parsed).unwrap(),
        true,
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_edge_non_json_assistant_fallback() {
    let msgs = vec![make_record(
        "a1",
        "assistant",
        "plain-text streaming",
        false,
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_edge_streaming_flag() {
    let msgs = vec![assistant_json(
        "a1",
        json!([{ "type": "text", "text": "streaming..." }]),
        Some(json!({ "__streaming": true })),
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_edge_non_json_content_with_malformed_json() {
    // content looks like JSON but content_is_json=false → treated as plain text
    let msgs = vec![make_record("a1", "assistant", "{not really json", false)];
    assert_yaml_snapshot!(run(msgs));
}

// ============================================================================
// 5. Selected assistant variants
// ============================================================================

#[test]
fn xv_asst_redacted_thinking() {
    let msgs = vec![assistant_json(
        "a1",
        json!([{ "type": "redacted_thinking", "data": "xxx" }]),
        None,
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_asst_server_tool_use() {
    let msgs = vec![assistant_json(
        "a1",
        json!([{ "type": "server_tool_use", "id": "st1", "name": "WebSearch", "input": { "query": "foo" } }]),
        None,
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_asst_tool_use_missing_id_name() {
    let msgs = vec![assistant_json(
        "a1",
        json!([
            { "type": "tool_use", "input": { "x": 1 } },
            { "type": "tool_use", "input": { "y": 2 } }
        ]),
        None,
    )];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_asst_merge_tool_result_with_image_block() {
    // Image blocks must NOT break the all-tool-result detection — merge still succeeds.
    let msgs = vec![
        assistant_json(
            "a1",
            json!([{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }]),
            None,
        ),
        user_json(
            "u1",
            json!([
                { "type": "tool_result", "tool_use_id": "t1", "content": "file-a" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "xxx" } }
            ]),
        ),
    ];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_asst_empty_content_fallback() {
    // assistant message with empty JSON content array + text fallback field
    let parsed = json!({
        "type": "assistant",
        "message": { "role": "assistant", "content": [] },
        "text": "fallback text"
    });
    let msgs = vec![make_record(
        "a1",
        "assistant",
        &serde_json::to_string(&parsed).unwrap(),
        true,
    )];
    assert_yaml_snapshot!(run(msgs));
}

// ============================================================================
// 6. System messages
// ============================================================================

#[test]
fn xv_sys_error_max_turns_rendered() {
    let msgs = vec![system_json("s1", json!({ "subtype": "error_max_turns" }))];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_sys_no_subtype() {
    let msgs = vec![system_json("s1", json!({}))];
    assert_yaml_snapshot!(run(msgs));
}

// ============================================================================
// 7. Merge boundaries
// ============================================================================

#[test]
fn xv_merge_broken_by_real_user() {
    let msgs = vec![
        assistant_json("a1", json!([{ "type": "text", "text": "hello" }]), None),
        make_record("u1", "user", "more please", false),
        assistant_json("a2", json!([{ "type": "text", "text": "world" }]), None),
    ];
    assert_yaml_snapshot!(run(msgs));
}

#[test]
fn xv_merge_streaming_flag_from_latest() {
    // Latest assistant sets streaming; earlier one does not — merged result
    // must reflect the latest streaming flag only.
    let msgs = vec![
        assistant_json("a1", json!([{ "type": "text", "text": "done" }]), None),
        assistant_json(
            "a2",
            json!([{ "type": "text", "text": "streaming..." }]),
            Some(json!({ "__streaming": true })),
        ),
    ];
    assert_yaml_snapshot!(run(msgs));
}
