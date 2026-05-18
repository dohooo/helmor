//! Pinning tests for the stable-part-id invariant.
//!
//! Backs the guarantee the frontend relies on: every rendered part
//! carries an id that stays equal to itself across
//! - multiple streaming partials for the same block,
//! - block boundaries within the same turn,
//! - the partial → final transition at turn commit,
//! - the live → historical reload round-trip.
//!
//! If any of these assertions break, `<Reasoning>` (and every other
//! part with state) will start remounting mid-stream again — the exact
//! regression the stable-id refactor exists to prevent.

mod common;

use common::*;
use helmor_lib::pipeline::types::{ExtendedMessagePart, MessagePart};
use helmor_lib::pipeline::PipelineEmit;
use serde_json::{json, Value};

/// Feed an event and return the fully rendered thread snapshot.
///
/// `Partial` only carries the trailing streaming message; we call
/// `finish()` after each event so the assertions can always reach every
/// message — the partial id lives on the last entry of the returned Vec.
fn push_and_render(pipeline: &mut MessagePipeline, event: Value) -> Vec<ThreadMessageLike> {
    let line = serde_json::to_string(&event).unwrap();
    let _ = pipeline.push_event(&event, &line);
    pipeline.finish()
}

/// Pull the last assistant message's first `Reasoning` part's id out of a
/// rendered snapshot. Returns `None` if the shape isn't what we expect.
fn last_reasoning_id(messages: &[ThreadMessageLike]) -> Option<String> {
    let last = messages.last()?;
    for part in &last.content {
        if let ExtendedMessagePart::Basic(MessagePart::Reasoning { id, .. }) = part {
            return Some(id.clone());
        }
    }
    None
}

/// Pull the last assistant message's first `Text` part's id.
fn last_text_id(messages: &[ThreadMessageLike]) -> Option<String> {
    let last = messages.last()?;
    for part in &last.content {
        if let ExtendedMessagePart::Basic(MessagePart::Text { id, .. }) = part {
            return Some(id.clone());
        }
    }
    None
}

fn first_system_notice(message: &ThreadMessageLike) -> Option<(String, String)> {
    for part in &message.content {
        if let ExtendedMessagePart::Basic(MessagePart::SystemNotice { id, label, .. }) = part {
            return Some((id.clone(), label.clone()));
        }
    }
    None
}

#[test]
fn reasoning_id_is_stable_across_deltas_and_block_boundary() {
    let mut pipeline = MessagePipeline::new("claude", "opus", "ctx", "sess");

    // content_block_start for a thinking block at index 0.
    push_and_render(
        &mut pipeline,
        json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "thinking", "thinking": "" }
            }
        }),
    );

    // First delta — the reasoning part should appear.
    let msgs_after_delta_1 = push_and_render(
        &mut pipeline,
        json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "thinking_delta", "thinking": "Let me " }
            }
        }),
    );
    let id_after_delta_1 = last_reasoning_id(&msgs_after_delta_1)
        .expect("reasoning part should be present after first thinking delta");

    // Second delta — same block, same id.
    let msgs_after_delta_2 = push_and_render(
        &mut pipeline,
        json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "thinking_delta", "thinking": "think about this." }
            }
        }),
    );
    let id_after_delta_2 = last_reasoning_id(&msgs_after_delta_2)
        .expect("reasoning part should be present after second delta");
    assert_eq!(
        id_after_delta_1, id_after_delta_2,
        "reasoning id must not change between deltas of the same block",
    );

    // content_block_stop for the thinking block.
    push_and_render(
        &mut pipeline,
        json!({
            "type": "stream_event",
            "event": { "type": "content_block_stop", "index": 0 }
        }),
    );

    // Start a NEW content block (text) at index 1 — reasoning is now
    // "done" but stays in the rendered output with the same id.
    push_and_render(
        &mut pipeline,
        json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 1,
                "content_block": { "type": "text" }
            }
        }),
    );

    let msgs_after_text_start = push_and_render(
        &mut pipeline,
        json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 1,
                "delta": { "type": "text_delta", "text": "Here is the answer." }
            }
        }),
    );
    let id_after_block_boundary = last_reasoning_id(&msgs_after_text_start)
        .expect("reasoning part should survive when a following text block starts");
    assert_eq!(
        id_after_delta_2, id_after_block_boundary,
        "reasoning id must stay stable after the thinking block completes and a text block begins",
    );

    // The text part has its own id, different from the reasoning id.
    let text_id =
        last_text_id(&msgs_after_text_start).expect("text part should be present after text_delta");
    assert_ne!(
        text_id, id_after_block_boundary,
        "text and reasoning parts must have distinct ids"
    );

    // Finalize the turn with an `assistant` event carrying both blocks.
    let msgs_after_assistant = push_and_render(
        &mut pipeline,
        json!({
            "type": "assistant",
            "message": {
                "id": "msg_pin_1",
                "role": "assistant",
                "content": [
                    { "type": "thinking", "thinking": "Let me think about this." },
                    { "type": "text", "text": "Here is the answer." },
                ]
            }
        }),
    );
    let id_after_commit = last_reasoning_id(&msgs_after_assistant)
        .expect("reasoning part should be present after assistant commit");
    assert_eq!(
        id_after_block_boundary, id_after_commit,
        "reasoning id must stay stable across the partial → final transition at turn commit",
    );
}

#[test]
fn message_id_does_not_flip_between_partial_and_final() {
    let mut pipeline = MessagePipeline::new("claude", "opus", "ctx", "sess");

    // Kick off a streaming partial.
    push_and_render(
        &mut pipeline,
        json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text" }
            }
        }),
    );
    let partial_snapshot = push_and_render(
        &mut pipeline,
        json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": "Hello" }
            }
        }),
    );
    let partial_msg_id = partial_snapshot
        .last()
        .and_then(|m| m.id.clone())
        .expect("partial should have a message id");

    // Finalize with the matching assistant event.
    let final_snapshot = push_and_render(
        &mut pipeline,
        json!({
            "type": "assistant",
            "message": {
                "id": "msg_stable_1",
                "role": "assistant",
                "content": [{ "type": "text", "text": "Hello" }]
            }
        }),
    );
    let final_msg_id = final_snapshot
        .last()
        .and_then(|m| m.id.clone())
        .expect("final render should have a message id");

    assert_eq!(
        partial_msg_id, final_msg_id,
        "assistant message id must stay stable between partial and final — no more `stream-partial:N` → DB-UUID swap",
    );

    // And the same id must be used for the persisted turn.
    pipeline.accumulator.flush_pending();
    assert_eq!(pipeline.accumulator.turns_len(), 1);
    assert_eq!(
        pipeline.accumulator.turn_at(0).id,
        final_msg_id,
        "CollectedTurn.id must match the live-rendered message id",
    );
}

#[test]
fn part_id_roundtrips_through_historical_reload() {
    let mut pipeline = MessagePipeline::new("claude", "opus", "ctx", "sess");

    push_and_render(
        &mut pipeline,
        json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "thinking", "thinking": "" }
            }
        }),
    );
    let live_snapshot = push_and_render(
        &mut pipeline,
        json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "thinking_delta", "thinking": "stable" }
            }
        }),
    );
    let live_reasoning_id = last_reasoning_id(&live_snapshot).expect("reasoning present live");

    push_and_render(
        &mut pipeline,
        json!({
            "type": "assistant",
            "message": {
                "id": "msg_round_1",
                "role": "assistant",
                "content": [{ "type": "thinking", "thinking": "stable" }]
            }
        }),
    );
    pipeline.accumulator.flush_pending();

    // Simulate historical reload by feeding the persisted turn's JSON
    // back through `convert_historical`. The DB would hand us the same
    // `content_json` the accumulator just serialized.
    let turn = pipeline.accumulator.turn_at(0).clone();
    let record = HistoricalRecord {
        id: turn.id.clone(),
        role: turn.role,
        content: turn.content_json.clone(),
        parsed_content: serde_json::from_str(&turn.content_json).ok(),
        created_at: "2026-04-20T00:00:00.000Z".to_string(),
    };
    let historical = MessagePipeline::convert_historical(&[record]);
    let historical_reasoning_id =
        last_reasoning_id(&historical).expect("reasoning present on reload");

    assert_eq!(
        live_reasoning_id, historical_reasoning_id,
        "reasoning id must survive the persist → historical-reload round-trip",
    );
}

// ---------------------------------------------------------------------------
// Multi-assistant-event merge (high-risk regression pinning)
// ---------------------------------------------------------------------------

/// Collect all part ids from every assistant message in a rendered snapshot.
fn collect_all_part_ids(messages: &[ThreadMessageLike]) -> Vec<String> {
    let mut ids = Vec::new();
    for msg in messages {
        if msg.role != helmor_lib::pipeline::types::MessageRole::Assistant {
            continue;
        }
        for part in &msg.content {
            ids.push(part.part_id().to_string());
        }
    }
    ids
}

#[test]
fn multi_assistant_event_same_msgid_no_duplicate_part_ids() {
    // Claude SDK sends finalized content blocks as separate `assistant`
    // events with the SAME msg_id. Each event's content array starts at
    // index 0, so positional synthesis would collide. This test pins that
    // the accumulator stamps unique `__part_id` across events.
    let mut pipeline = MessagePipeline::new("claude", "opus", "ctx", "sess");

    // Event 1: thinking block
    push_and_render(
        &mut pipeline,
        json!({
            "type": "assistant",
            "message": {
                "id": "m1",
                "role": "assistant",
                "content": [{"type": "thinking", "thinking": "deep thought"}]
            }
        }),
    );

    // Event 2: text block — same msg_id, content starts at idx 0 again
    push_and_render(
        &mut pipeline,
        json!({
            "type": "assistant",
            "message": {
                "id": "m1",
                "role": "assistant",
                "content": [{"type": "text", "text": "here is the answer"}]
            }
        }),
    );

    // Force flush so the turn is committed.
    pipeline.accumulator.flush_pending();

    // Re-render the full thread.
    let rendered = pipeline.finish();
    let ids = collect_all_part_ids(&rendered);

    // Must have at least 2 parts (reasoning + text), all unique.
    assert!(
        ids.len() >= 2,
        "expected at least reasoning + text, got {ids:?}",
    );
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    assert_eq!(
        ids.len(),
        unique.len(),
        "part ids must be unique across merged assistant events, got duplicates: {ids:?}",
    );

    // Historical reload must produce the same ids.
    let turn = pipeline.accumulator.turn_at(0).clone();
    let record = HistoricalRecord {
        id: turn.id.clone(),
        role: turn.role,
        content: turn.content_json.clone(),
        parsed_content: serde_json::from_str(&turn.content_json).ok(),
        created_at: "2026-04-20T00:00:00.000Z".to_string(),
    };
    let historical = MessagePipeline::convert_historical(&[record]);
    let hist_ids = collect_all_part_ids(&historical);
    assert_eq!(
        ids, hist_ids,
        "part ids must be identical between live render and historical reload",
    );
}

// ---------------------------------------------------------------------------
// Codex reasoning round-trip
// ---------------------------------------------------------------------------

#[test]
fn codex_reasoning_id_roundtrips_through_historical_reload() {
    let mut pipeline = MessagePipeline::new("codex", "codex-mini", "ctx", "sess");

    // Simulate a Codex reasoning item.completed event.
    push_and_render(
        &mut pipeline,
        json!({
            "type": "item/completed",
            "item": {
                "id": "reason_42",
                "type": "reasoning",
                "text": "analyzing the request"
            }
        }),
    );

    let live = pipeline.finish();
    let live_id = last_reasoning_id(&live).expect("reasoning part should be present live");

    // Historical reload: the DB stores the raw item.completed event.
    assert!(pipeline.accumulator.turns_len() >= 1);
    let turn = pipeline.accumulator.turn_at(0).clone();
    let record = HistoricalRecord {
        id: turn.id.clone(),
        role: turn.role,
        content: turn.content_json.clone(),
        parsed_content: serde_json::from_str(&turn.content_json).ok(),
        created_at: "2026-04-20T00:00:00.000Z".to_string(),
    };
    let historical = MessagePipeline::convert_historical(&[record]);
    let hist_id = last_reasoning_id(&historical).expect("reasoning present on historical reload");

    assert_eq!(
        live_id, hist_id,
        "Codex reasoning part id must survive the live → DB → historical round-trip",
    );
}

#[test]
fn codex_context_compaction_renders_started_and_completed_notices() {
    let mut pipeline = MessagePipeline::new("codex", "codex-mini", "ctx", "sess");

    let started = json!({
        "type": "item/started",
        "item": {
            "id": "compact_1",
            "type": "contextCompaction"
        }
    });
    let started_line = serde_json::to_string(&started).unwrap();
    let partial = match pipeline.push_event(&started, &started_line) {
        PipelineEmit::Partial(message) => message,
        _ => panic!("context compaction start should emit a streaming notice"),
    };
    let (started_part_id, started_label) =
        first_system_notice(&partial).expect("started notice should render");
    assert_eq!(started_label, "Compacting context");

    let completed = json!({
        "type": "item/completed",
        "item": {
            "id": "compact_1",
            "type": "contextCompaction"
        }
    });
    let completed_line = serde_json::to_string(&completed).unwrap();
    let messages = match pipeline.push_event(&completed, &completed_line) {
        PipelineEmit::Full(messages) => messages,
        _ => panic!("context compaction completion should emit a full render"),
    };
    let notices: Vec<(String, String)> = messages.iter().filter_map(first_system_notice).collect();

    assert_eq!(notices.len(), 2);
    assert_eq!(notices[0].1, "Compacting context");
    assert_eq!(notices[1].1, "Context compacted");
    assert_ne!(started_part_id, notices[1].0);
}
