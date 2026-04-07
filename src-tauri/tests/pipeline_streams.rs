//! Raw stream-event replay tests for the message pipeline.
//!
//! Each `.jsonl` fixture under `tests/fixtures/streams/` is a sequence of
//! sidecar stream events (one JSON object per line) captured from a real
//! Claude Code / Codex CLI session. We replay each line through
//! `MessagePipeline::push_event` and snapshot:
//!
//! - the role sequence at every finalization checkpoint (assistant/user/result/error)
//! - the final state after `finish()` (role sequence + count)
//!
//! # Why this exists
//!
//! `pipeline_fixtures.rs` exercises the `convert_historical` adapter path
//! using DB-captured `HistoricalRecord`s — i.e., **post-accumulator** data.
//! That covers adapter + collapse, but it bypasses the accumulator entirely.
//!
//! The accumulator is the part that:
//! - merges streaming text deltas into a single text block
//! - assembles `tool_use` blocks across `content_block_start` / delta /
//!   `content_block_stop` events
//! - keeps partial-id stable across deltas so the frontend doesn't re-key
//! - resets blocks when a final `assistant` event arrives
//!
//! None of this is exercised by historical fixtures. The handful of
//! handcrafted `pipeline::accumulator::tests` cover individual mechanisms
//! but no end-to-end real stream replay. These jsonl fixtures fill that gap.
//!
//! # Adding a new stream fixture
//!
//! Capture a session via the temporary `__capturedStreamLines` debug hook
//! in `workspace-conversation-container.tsx` (set `__captureStreamName` and
//! POST to `/api/capture_stream`), then drop the file under
//! `tests/fixtures/streams/`.
//!
//! # Updating snapshots
//!
//! ```sh
//! INSTA_UPDATE=always cargo test --test pipeline_streams
//! # or, with the insta CLI:
//! cargo insta review
//! ```

mod common;

use common::*;
use helmor_lib::pipeline::PipelineEmit;
use insta::{assert_yaml_snapshot, glob};
use serde::Serialize;
use serde_json::Value;
use std::fs;

/// One snapshot per stream fixture: a series of mid-stream "checkpoints"
/// captured at every Full() emission, plus the final state. We don't
/// snapshot the full content (the jsonl can produce hundreds of messages
/// after collapse) — just the structural shape that meaningfully drifts
/// when accumulator/adapter behavior changes.
#[derive(Debug, Serialize)]
struct StreamReplaySnapshot {
    line_count: usize,
    checkpoint_count: usize,
    checkpoints: Vec<StreamCheckpoint>,
    final_state: FinalState,
}

#[derive(Debug, Serialize)]
struct StreamCheckpoint {
    line_index: usize,
    event_type: String,
    /// Roles in the message array at this checkpoint.
    roles: Vec<String>,
    /// Last message's content part types (text / reasoning / tool-call /
    /// collapsed-group). Useful for spotting "did the trailing message
    /// change shape between checkpoints".
    last_part_types: Vec<String>,
}

#[derive(Debug, Serialize)]
struct FinalState {
    message_count: usize,
    roles: Vec<String>,
    /// Total number of content parts across all messages.
    total_parts: usize,
}

fn part_type(part: &helmor_lib::pipeline::types::ExtendedMessagePart) -> &'static str {
    use helmor_lib::pipeline::types::{ExtendedMessagePart, MessagePart};
    match part {
        ExtendedMessagePart::Basic(MessagePart::Text { .. }) => "text",
        ExtendedMessagePart::Basic(MessagePart::Reasoning { .. }) => "reasoning",
        ExtendedMessagePart::Basic(MessagePart::ToolCall { .. }) => "tool-call",
        ExtendedMessagePart::CollapsedGroup(_) => "collapsed-group",
    }
}

fn collect_part_types(msg: &ThreadMessageLike) -> Vec<String> {
    msg.content
        .iter()
        .map(|p| part_type(p).to_string())
        .collect()
}

#[test]
fn stream_replay() {
    glob!("fixtures/streams/*.jsonl", |path| {
        let raw = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
        let lines: Vec<&str> = raw
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();

        // Pick provider hint from the filename so the accumulator picks the
        // right parser branch (claude vs codex). Falls back to "claude".
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        let provider = if stem.contains("codex") {
            "codex"
        } else {
            "claude"
        };

        let mut pipeline = MessagePipeline::new(provider, "test-model", "ctx", "sess");
        let mut checkpoints: Vec<StreamCheckpoint> = Vec::new();

        for (line_index, line) in lines.iter().enumerate() {
            let value: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let event_type = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();

            let emit = pipeline.push_event(&value, line);

            if let PipelineEmit::Full(messages) = emit {
                let last_part_types = messages.last().map(collect_part_types).unwrap_or_default();
                checkpoints.push(StreamCheckpoint {
                    line_index,
                    event_type,
                    roles: messages.iter().map(|m| role_str(&m.role)).collect(),
                    last_part_types,
                });
            }
        }

        let final_messages = pipeline.finish();
        let final_state = FinalState {
            message_count: final_messages.len(),
            roles: final_messages.iter().map(|m| role_str(&m.role)).collect(),
            total_parts: final_messages.iter().map(|m| m.content.len()).sum(),
        };

        let snapshot = StreamReplaySnapshot {
            line_count: lines.len(),
            checkpoint_count: checkpoints.len(),
            checkpoints,
            final_state,
        };

        assert_yaml_snapshot!(snapshot);
    });
}
