//! Replay the real Claude Agent SDK NDJSON dump captured at
//! `/tmp/claude-sdk-test/events.ndjson` and print what the pipeline
//! actually emits at each stage. Run with:
//!
//!   cargo test --manifest-path src-tauri/Cargo.toml \
//!     --test thinking_block_replay -- --nocapture
//!
//! Not a pass/fail gate — exists to expose where `streaming`,
//! `durationMs`, and part-id flow diverge from the raw SDK stream.

use helmor_lib::pipeline::accumulator::StreamAccumulator;
use helmor_lib::pipeline::adapter::convert;
use helmor_lib::pipeline::types::{ExtendedMessagePart, MessagePart};
use serde_json::Value;
use std::fs;

fn variant_tag(part: &ExtendedMessagePart) -> &'static str {
    match part {
        ExtendedMessagePart::Basic(MessagePart::Text { .. }) => "Text",
        ExtendedMessagePart::Basic(MessagePart::Reasoning { .. }) => "Reasoning",
        ExtendedMessagePart::Basic(MessagePart::ToolCall { .. }) => "ToolCall",
        ExtendedMessagePart::Basic(MessagePart::Image { .. }) => "Image",
        ExtendedMessagePart::Basic(MessagePart::TodoList { .. }) => "TodoList",
        ExtendedMessagePart::Basic(MessagePart::SystemNotice { .. }) => "SystemNotice",
        ExtendedMessagePart::Basic(MessagePart::PlanReview { .. }) => "PlanReview",
        ExtendedMessagePart::Basic(MessagePart::PromptSuggestion { .. }) => "PromptSuggestion",
        ExtendedMessagePart::CollapsedGroup(_) => "CollapsedGroup",
        _ => "Other",
    }
}

#[test]
fn replay_real_sdk_dump() {
    let path = "/tmp/claude-sdk-test/events.ndjson";
    let Ok(contents) = fs::read_to_string(path) else {
        eprintln!("skip: no dump at {path}");
        return;
    };

    let mut acc = StreamAccumulator::new("claude", "claude-sonnet-4-5");
    let mut line_no = 0usize;

    for raw_line in contents.lines() {
        line_no += 1;
        let value: Value = match serde_json::from_str(raw_line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("line {line_no}: parse err {e}");
                continue;
            }
        };
        let outcome = acc.push_event(&value, raw_line);

        let evt_type = value.get("type").and_then(Value::as_str).unwrap_or("?");
        let inner_evt = value
            .get("event")
            .and_then(|e| e.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let delta_t = value
            .get("event")
            .and_then(|e| e.get("delta"))
            .and_then(|d| d.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let idx = value
            .get("event")
            .and_then(|e| e.get("index"))
            .and_then(Value::as_u64);

        eprintln!(
            "[{line_no:02}] outcome={outcome:?} type={evt_type} evt={inner_evt} delta={delta_t} idx={idx:?}"
        );

        // After each event, dump what a live partial or collected slice
        // looks like for thinking blocks.
        let partial = acc.build_partial("ctx", "sess");
        if let Some(p) = partial {
            dump_thinking_state("partial", &p.parsed);
        }
        for (i, m) in acc.collected().iter().enumerate() {
            dump_thinking_state(&format!("collected[{i}]"), &m.parsed);
        }
    }

    // Finalize and show the end-state render
    acc.flush_pending();

    eprintln!("\n=== final render (after flush) ===");
    let messages = acc.collected().to_vec();
    let rendered = convert(&messages);
    for (i, m) in rendered.iter().enumerate() {
        eprintln!(
            "msg[{i}] role={:?} streaming={:?} parts={}",
            m.role,
            m.streaming,
            m.content.len()
        );
        for (j, part) in m.content.iter().enumerate() {
            match part {
                ExtendedMessagePart::Basic(MessagePart::Reasoning {
                    id,
                    streaming,
                    duration_ms,
                    text,
                }) => {
                    eprintln!(
                        "  [{j}] Reasoning id={id} streaming={streaming:?} duration_ms={duration_ms:?} text_len={}",
                        text.len()
                    );
                }
                ExtendedMessagePart::Basic(MessagePart::Text { id, text }) => {
                    eprintln!("  [{j}] Text id={id} len={}", text.len());
                }
                other => {
                    eprintln!("  [{j}] {}", variant_tag(other));
                }
            }
        }
    }
}

fn dump_thinking_state(label: &str, parsed: &Option<Value>) {
    let Some(parsed) = parsed else { return };
    let Some(blocks) = parsed
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for (i, b) in blocks.iter().enumerate() {
        let Some(obj) = b.as_object() else { continue };
        if obj.get("type").and_then(Value::as_str) != Some("thinking") {
            continue;
        }
        let part_id = obj.get("__part_id").and_then(Value::as_str).unwrap_or("-");
        let is_streaming = obj.get("__is_streaming").and_then(Value::as_bool);
        let duration = obj.get("__duration_ms").and_then(Value::as_u64);
        let text_len = obj
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::len)
            .unwrap_or(0);
        eprintln!(
            "    {label}[{i}] thinking part_id={part_id} streaming={is_streaming:?} duration_ms={duration:?} text_len={text_len}"
        );
    }
}
