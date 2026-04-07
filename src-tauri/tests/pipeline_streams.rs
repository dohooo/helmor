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

/// One snapshot per stream fixture, covering THREE stages of the pipeline:
///
/// - **Streaming render** (`checkpoints` + `final_state`): mid-stream Full()
///   emissions and the post-`finish()` ThreadMessageLike snapshot. Catches
///   adapter/collapse drift on the live path.
///
/// - **Persistence layout** (`persisted_turns`): the `turns` vec exposed by
///   the accumulator AFTER `finish_output()`, with each turn's role and
///   content block types. Catches accumulator-level bugs that drop blocks
///   from `cur_asst_*` before they reach `self.turns` (e.g. the "thinking
///   gets clobbered by the next same-msg_id event" regression).
///
/// - **Historical reload** (`historical_render`): feed the persisted turns
///   back through `convert_historical` and snapshot the rendered output.
///   This is the round-trip — streaming → persist → reload → render — that
///   would have caught BOTH the "command_execution dropped on reload" bug
///   AND the silent symmetry-break between the streaming render path
///   (which synthesizes tool_use/tool_result) and the historical render
///   path (which uses item.completed branches in the adapter).
///
/// We don't snapshot the full content (the jsonl can produce thousands of
/// lines after pretty-print) — just the structural shape that meaningfully
/// drifts when behavior changes.
#[derive(Debug, Serialize)]
struct StreamReplaySnapshot {
    line_count: usize,
    checkpoint_count: usize,
    checkpoints: Vec<StreamCheckpoint>,
    final_state: FinalState,
    persisted_turns: PersistedTurnsSnapshot,
    historical_render: HistoricalRenderSnapshot,
}

/// Historical-side snapshot — what `convert_historical` produces when the
/// persisted turns are loaded back from the DB. This is the path the user
/// hits every time they reopen a session.
#[derive(Debug, Serialize)]
struct HistoricalRenderSnapshot {
    message_count: usize,
    /// Per-message: role + content part types in order. Mirrors the
    /// streaming render's `checkpoints[*].last_part_types` but applied to
    /// the full historical reload.
    messages: Vec<HistoricalRenderedMessage>,
}

#[derive(Debug, Serialize)]
struct HistoricalRenderedMessage {
    role: String,
    part_types: Vec<String>,
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

/// Persistence-side snapshot — what the accumulator would write to the DB.
///
/// `turn_count` and the per-turn block-type list collectively pin the bug
/// surface area for accumulator-level drops: any change in how delta-style
/// assistant events are batched into turns shows up here.
#[derive(Debug, Serialize)]
struct PersistedTurnsSnapshot {
    turn_count: usize,
    /// Total number of content blocks across all turns. The most blunt
    /// fingerprint of the "thinking dropped" bug — without the fix this
    /// number is artificially low because thinking blocks never make it
    /// into self.turns.
    total_blocks: usize,
    turns: Vec<PersistedTurn>,
}

#[derive(Debug, Serialize)]
struct PersistedTurn {
    role: String,
    /// Content block types in the order they appear in the persisted JSON.
    /// `["thinking", "tool_use"]` is what a healthy Claude turn with
    /// thinking + tool call looks like; `["tool_use"]` alone is the
    /// pre-fix bug fingerprint.
    block_types: Vec<String>,
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

/// Build HistoricalRecords from the accumulator's persisted turns and run
/// them through `convert_historical`. Mirrors what happens when a user
/// closes the app and reopens a session — DB rows → loader → adapter →
/// rendered ThreadMessageLikes.
fn build_historical_snapshot(pipeline: &MessagePipeline) -> HistoricalRenderSnapshot {
    let acc = &pipeline.accumulator;
    let records: Vec<HistoricalRecord> = (0..acc.turns_len())
        .map(|i| {
            let turn = acc.turn_at(i);
            HistoricalRecord {
                id: format!("hist-{i}"),
                role: turn.role.clone(),
                content: turn.content_json.clone(),
                parsed_content: serde_json::from_str(&turn.content_json).ok(),
                created_at: "2026-04-08T00:00:00.000Z".to_string(),
            }
        })
        .collect();
    let rendered = MessagePipeline::convert_historical(&records);
    HistoricalRenderSnapshot {
        message_count: rendered.len(),
        messages: rendered
            .iter()
            .map(|m| HistoricalRenderedMessage {
                role: role_str(&m.role),
                part_types: collect_part_types(m),
            })
            .collect(),
    }
}

/// Extract the persisted-turn fingerprint by parsing each turn's JSON
/// content. Reads the persistence-side state of the accumulator that
/// `agents.rs::persist_turn_message` would write to the DB.
fn build_persisted_snapshot(pipeline: &MessagePipeline) -> PersistedTurnsSnapshot {
    let acc = &pipeline.accumulator;
    let turn_count = acc.turns_len();
    let mut turns = Vec::with_capacity(turn_count);
    let mut total_blocks = 0usize;

    for i in 0..turn_count {
        let turn = acc.turn_at(i);
        // Each turn's content_json is the raw `assistant`/`user` event
        // payload (or, for batched assistant turns, the template with
        // `message.content` rewritten from cur_asst_blocks).
        let parsed: Value = serde_json::from_str(&turn.content_json).unwrap_or(Value::Null);
        let block_types: Vec<String> = parsed
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| b.get("type").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        total_blocks += block_types.len();
        turns.push(PersistedTurn {
            role: turn.role.clone(),
            block_types,
        });
    }

    PersistedTurnsSnapshot {
        turn_count,
        total_blocks,
        turns,
    }
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

        // Drive the persistence-side finalization that agents.rs end branch
        // would run after the stream loop. This is what populates the
        // accumulator's `turns` vec with the FINAL staged assistant turn
        // (regression test for e0d6253) and what surfaces accumulator-level
        // block-batching bugs (regression test for the same-msg_id append fix).
        let _ = pipeline
            .accumulator
            .finish_output(Some("test-session"))
            .ok();
        let persisted_turns = build_persisted_snapshot(&pipeline);
        let historical_render = build_historical_snapshot(&pipeline);

        let snapshot = StreamReplaySnapshot {
            line_count: lines.len(),
            checkpoint_count: checkpoints.len(),
            checkpoints,
            final_state,
            persisted_turns,
            historical_render,
        };

        assert_yaml_snapshot!(snapshot);
    });
}
