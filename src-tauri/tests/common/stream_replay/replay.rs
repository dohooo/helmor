//! Drive a live `MessagePipeline` from a slice of stream events and capture
//! every emission + the final render + the persisted turns + the historical
//! reload. Output is the raw `ThreadMessageLike` / JSON form — the
//! `stabilize` sibling module converts it to snapshot-stable shape.

use helmor_lib::pipeline::types::{HistoricalRecord, ThreadMessageLike};
use helmor_lib::pipeline::MessagePipeline;
use serde_json::Value;

/// A single emission observed while replaying stream events. Kept in raw
/// `ThreadMessageLike` form so `normalize_stream_fingerprint` can
/// stabilize UUIDs across every emission + the final render with a
/// single shared id_map.
pub enum RawStreamEmission {
    Partial {
        line_index: usize,
        event_type: String,
        message: ThreadMessageLike,
    },
    Full {
        line_index: usize,
        event_type: String,
        messages: Vec<ThreadMessageLike>,
    },
}

/// Full fingerprint of a replayed stream: every emission, the final render,
/// the persisted turns (what flush_assistant writes to the DB), and the
/// historical-reload render. Raw shape — run through
/// `normalize_stream_fingerprint` before snapshotting.
pub struct StreamReplayFingerprint {
    pub emissions: Vec<RawStreamEmission>,
    pub final_render: Vec<ThreadMessageLike>,
    pub persisted_turn_blocks: Vec<Value>,
    pub historical_render: Vec<ThreadMessageLike>,
}

pub fn replay_stream_events(provider: &str, events: &[Value]) -> StreamReplayFingerprint {
    use helmor_lib::pipeline::PipelineEmit;

    let mut pipeline = MessagePipeline::new(provider, "test-model", "ctx", "sess");
    let mut emissions: Vec<RawStreamEmission> = Vec::new();

    for (line_index, value) in events.iter().enumerate() {
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let raw = serde_json::to_string(value).unwrap_or_default();
        match pipeline.push_event(value, &raw) {
            PipelineEmit::Partial(message) => {
                emissions.push(RawStreamEmission::Partial {
                    line_index,
                    event_type,
                    message,
                });
            }
            PipelineEmit::Full(messages) => {
                emissions.push(RawStreamEmission::Full {
                    line_index,
                    event_type,
                    messages,
                });
            }
            PipelineEmit::None => {}
        }
    }

    let final_render = pipeline.finish();
    pipeline.accumulator.flush_pending();

    // Capture persisted block JSON verbatim — the strip/keep behavior of
    // `__is_streaming` vs `__duration_ms` is exactly what the snapshot
    // needs to pin.
    let acc = &pipeline.accumulator;
    let persisted_turn_blocks: Vec<Value> = (0..acc.turns_len())
        .map(|i| {
            let turn = acc.turn_at(i);
            let parsed: Value = serde_json::from_str(&turn.content_json).unwrap_or(Value::Null);
            parsed
                .get("message")
                .and_then(|m| m.get("content"))
                .cloned()
                .unwrap_or(Value::Null)
        })
        .collect();

    let historical_records: Vec<HistoricalRecord> = (0..acc.turns_len())
        .map(|i| {
            let turn = acc.turn_at(i);
            HistoricalRecord {
                id: format!("hist-{i}"),
                role: turn.role,
                content: turn.content_json.clone(),
                parsed_content: serde_json::from_str(&turn.content_json).ok(),
                created_at: "2026-04-08T00:00:00.000Z".to_string(),
                author_id: None,
            }
        })
        .collect();
    let historical_render = MessagePipeline::convert_historical(&historical_records);

    StreamReplayFingerprint {
        emissions,
        final_render,
        persisted_turn_blocks,
        historical_render,
    }
}
