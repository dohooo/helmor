//! Raw stream-event replay tests for the message pipeline.
//!
//! Each `.jsonl` fixture under `tests/fixtures/streams/<provider>/` is a
//! sequence of sidecar stream events (one JSON object per line) from a
//! real Claude Code / Codex CLI session. The parent directory name
//! (`claude` or `codex`) IS the provider — the accumulator picks its
//! parser branch from that. We replay each line through
//! `MessagePipeline::push_event` and snapshot the live render, the
//! post-finalize persisted turns, and the historical reload round-trip.
//!
//! This covers the accumulator layer specifically — delta merging,
//! `tool_use` block assembly across `content_block_*` events,
//! partial-id stability — which `pipeline_fixtures.rs` skips by working
//! directly on post-accumulator `HistoricalRecord`s.
//!
//! # Adding a new stream fixture
//!
//! For Codex: `bun run scripts/capture-codex-fixture.ts
//! <output-path> [prompt]` drives `CodexSessionManager` against the live
//! SDK and writes the result. Drop the output under
//! `tests/fixtures/streams/codex/`.
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

/// One snapshot per stream fixture, covering three stages of the pipeline:
///
/// - **Streaming render** (`checkpoints` + `final_state`): mid-stream Full()
///   emissions and the post-`finish()` ThreadMessageLike snapshot. Catches
///   adapter / collapse drift on the live path.
///
/// - **Persistence layout** (`persisted_turns`): the `turns` vec exposed by
///   the accumulator after `finish_output()`, with each turn's role and
///   content block types. Catches accumulator-level drops that lose blocks
///   before they reach `self.turns`.
///
/// - **Historical reload** (`historical_render`): feed the persisted turns
///   back through `convert_historical` and snapshot the rendered output.
///   The full round-trip — streaming → persist → reload → render — closes
///   the symmetry gap between the live path and the historical path.
///
/// We only snapshot structural shape (roles, part types, block types),
/// not full content — the jsonl can produce thousands of lines after
/// pretty-print and the shape is what meaningfully drifts.
#[derive(Debug, Serialize)]
struct StreamReplaySnapshot {
    line_count: usize,
    checkpoint_count: usize,
    checkpoints: Vec<StreamCheckpoint>,
    final_state: FinalState,
    persisted_turns: PersistedTurnsSnapshot,
    historical_render: HistoricalRenderSnapshot,
    /// Top-level event types `accumulator.push_event` had no handler for.
    /// MUST be empty in steady state — the post-snapshot assertion enforces
    /// it. Keeping the list in the snapshot makes drift visible in
    /// `cargo insta review` even if you skip the assertion.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    dropped_event_types: Vec<String>,
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
    /// Tool names of children attached to ToolCall parts (via grouping).
    /// Empty when no ToolCall has children — `skip_serializing_if` keeps
    /// existing snapshots unchanged.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    children_tool_names: Vec<String>,
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
/// `turn_count` and the per-turn block-type list collectively pin the
/// accumulator's delta-batching behavior.
#[derive(Debug, Serialize)]
struct PersistedTurnsSnapshot {
    turn_count: usize,
    /// Total number of content blocks across all turns. A blunt
    /// fingerprint of accumulator block drops — any change in the
    /// delta-merge path shifts this count.
    total_blocks: usize,
    turns: Vec<PersistedTurn>,
}

#[derive(Debug, Serialize)]
struct PersistedTurn {
    role: String,
    /// Content block types in the order they appear in the persisted JSON.
    block_types: Vec<String>,
}

fn part_type(part: &helmor_lib::pipeline::types::ExtendedMessagePart) -> &'static str {
    use helmor_lib::pipeline::types::{ExtendedMessagePart, MessagePart};
    match part {
        ExtendedMessagePart::Basic(MessagePart::Text { .. }) => "text",
        ExtendedMessagePart::Basic(MessagePart::Reasoning { .. }) => "reasoning",
        ExtendedMessagePart::Basic(MessagePart::ToolCall { .. }) => "tool-call",
        ExtendedMessagePart::Basic(MessagePart::SystemNotice { .. }) => "system-notice",
        ExtendedMessagePart::Basic(MessagePart::TodoList { .. }) => "todo-list",
        ExtendedMessagePart::Basic(MessagePart::Image { .. }) => "image",
        ExtendedMessagePart::Basic(MessagePart::PromptSuggestion { .. }) => "prompt-suggestion",
        ExtendedMessagePart::CollapsedGroup(_) => "collapsed-group",
    }
}

fn collect_part_types(msg: &ThreadMessageLike) -> Vec<String> {
    msg.content
        .iter()
        .map(|p| part_type(p).to_string())
        .collect()
}

/// Collect tool names of children inside ToolCall parts. Returns an empty
/// vec when no ToolCall has children — the `skip_serializing_if` on the
/// struct field keeps existing snapshots unchanged.
fn collect_children_tool_names(msg: &ThreadMessageLike) -> Vec<String> {
    use helmor_lib::pipeline::types::{ExtendedMessagePart, MessagePart};
    let mut names = Vec::new();
    for part in &msg.content {
        if let ExtendedMessagePart::Basic(MessagePart::ToolCall { children, .. }) = part {
            for child in children {
                if let ExtendedMessagePart::Basic(MessagePart::ToolCall { tool_name, .. }) = child {
                    names.push(tool_name.clone());
                }
            }
        }
    }
    names
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
                children_tool_names: collect_children_tool_names(m),
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
    // Fixtures live under `tests/fixtures/streams/<provider>/<name>.jsonl`.
    // The parent directory name IS the provider — no filename sniffing,
    // no implicit conventions. Adding a new provider means adding a new
    // subdirectory.
    glob!("fixtures/streams/*/*.jsonl", |path| {
        let raw = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
        let lines: Vec<&str> = raw
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();

        let provider = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or_else(|| panic!("fixture {path:?} is missing a provider parent dir"));
        assert!(
            matches!(provider, "claude" | "codex"),
            "fixture {path:?} is under unknown provider directory {provider:?}"
        );

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

        // Mirror the persistence-side finalization that agents.rs runs after
        // the stream loop — this flushes the staged final assistant turn
        // into `accumulator.turns`, which the snapshot below reads.
        let _ = pipeline
            .accumulator
            .finish_output(Some("test-session"))
            .ok();
        let persisted_turns = build_persisted_snapshot(&pipeline);
        let historical_render = build_historical_snapshot(&pipeline);

        // Hard-zero coverage invariant: every top-level event type in this
        // fixture must be handled by `accumulator.push_event`. Anything
        // that falls through to the `_` arm is recorded in
        // `dropped_event_types`. We embed the dropped list into the
        // snapshot so it shows up in the .snap diff (and `cargo insta
        // review` can review it), then assert empty so the test still
        // hard-fails on any drop.
        let dropped: Vec<String> = pipeline.accumulator.dropped_event_types().to_vec();

        let snapshot = StreamReplaySnapshot {
            line_count: lines.len(),
            checkpoint_count: checkpoints.len(),
            checkpoints,
            final_state,
            persisted_turns,
            historical_render,
            dropped_event_types: dropped.clone(),
        };

        // insta's glob! uses the full matched path (relative to the glob
        // base) as the snapshot's `@suffix`, with `/` → `__`. Under
        // `*/*.jsonl` that becomes e.g. `claude__thinking-text.jsonl` or
        // `codex__list-files.jsonl` — provider already embedded, no
        // collision between `claude/tool-use` and `codex/tool-use`.
        assert_yaml_snapshot!(snapshot);

        // Hard-fail on any unhandled event type. Done AFTER the snapshot
        // assertion so the .snap diff captures the drift before the test
        // aborts — easier to triage from `cargo insta review`.
        if std::env::var("HELMOR_INVENTORY").is_err() {
            assert!(
                dropped.is_empty(),
                "fixture {path:?} dropped unhandled event types: {dropped:?}"
            );
        }
    });
}
