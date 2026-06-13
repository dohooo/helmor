//! Convert a `StreamReplayFingerprint` into a shape that produces stable
//! snapshots: UUIDs → `msg-N` labels, wall-clock `duration_ms` →
//! `has_duration` boolean. Everything here is pure transformation; see
//! `replay.rs` for the side-effectful driver that produces the raw form.

use helmor_lib::pipeline::types::ThreadMessageLike;
use serde::Serialize;
use serde_json::Value;

use crate::common::normalize::{normalize_message, NormPart};

use super::replay::{RawStreamEmission, StreamReplayFingerprint};

/// Stabilized message: raw UUIDs replaced with `msg-N` labels, wall-clock
/// `duration_ms` collapsed to a `has_duration` boolean.
#[derive(Debug, Serialize)]
pub struct StableNormThreadMessage {
    pub role: String,
    pub id: Option<String>,
    pub content: Vec<StableNormPart>,
    pub streaming: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum StableNormPart {
    Text {
        text: String,
    },
    Reasoning {
        text_preview: String,
        streaming: Option<bool>,
        has_duration: bool,
    },
    Other {
        original_type: String,
    },
}

fn stabilize_part(part: &NormPart) -> StableNormPart {
    match part {
        NormPart::Text { text } => StableNormPart::Text { text: text.clone() },
        NormPart::Reasoning {
            text_preview,
            streaming,
            duration_ms,
            ..
        } => StableNormPart::Reasoning {
            text_preview: text_preview.clone(),
            streaming: *streaming,
            has_duration: duration_ms.is_some(),
        },
        other => StableNormPart::Other {
            original_type: match other {
                NormPart::ToolCall { tool_name, .. } => format!("tool-call:{tool_name}"),
                NormPart::CollapsedGroup { category, .. } => {
                    format!("collapsed-group:{category}")
                }
                NormPart::SystemNotice { severity, .. } => {
                    format!("system-notice:{severity}")
                }
                NormPart::TodoList { .. } => "todo-list".to_string(),
                NormPart::Image { kind, .. } => format!("image:{kind}"),
                NormPart::PromptSuggestion { .. } => "prompt-suggestion".to_string(),
                NormPart::PlanReview { .. } => "plan-review".to_string(),
                NormPart::UserQuestion {
                    source,
                    status,
                    answers,
                    ..
                } => format!("user-question:{source}:{status}[{}]", answers.join("; ")),
                NormPart::FileMention { .. } => "file-mention".to_string(),
                _ => "unknown".to_string(),
            },
        },
    }
}

/// Stable fingerprint of a persisted turn's content blocks. Replaces the
/// raw `__duration_ms` ms with a `has_duration` boolean and drops
/// `__part_id` so the snapshot survives UUID / wall-clock drift while
/// still pinning the `__is_streaming` strip contract.
#[derive(Debug, Serialize)]
pub struct StablePersistedBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_is_streaming: Option<bool>,
    pub has_duration_ms: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub other_keys: Vec<String>,
}

fn stabilize_persisted_content(content: &Value) -> Vec<StablePersistedBlock> {
    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.as_object())
                .map(|obj| {
                    let block_type = obj
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let has_is_streaming = obj
                        .get("__is_streaming")
                        .and_then(Value::as_bool)
                        .map(|_| true);
                    let has_duration_ms = obj
                        .get("__duration_ms")
                        .map(Value::is_number)
                        .unwrap_or(false);
                    // Surface any other keys a future regression might
                    // accidentally leak (besides the well-known block
                    // payload fields + our two live-render markers +
                    // __part_id which we intentionally persist).
                    let mut other_keys: Vec<String> = obj
                        .keys()
                        .filter(|k| {
                            !matches!(
                                k.as_str(),
                                "type"
                                    | "__is_streaming"
                                    | "__duration_ms"
                                    | "__part_id"
                                    | "thinking"
                                    | "signature"
                                    | "text"
                                    | "name"
                                    | "id"
                                    | "input"
                            )
                        })
                        .cloned()
                        .collect();
                    other_keys.sort();
                    StablePersistedBlock {
                        block_type,
                        has_is_streaming,
                        has_duration_ms,
                        other_keys,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Shape-stable fingerprint built from `StreamReplayFingerprint`.
#[derive(Debug, Serialize)]
pub struct StableStreamReplayFingerprint {
    pub emissions: Vec<StableStreamEmission>,
    pub final_render: Vec<StableNormThreadMessage>,
    pub persisted_turn_blocks: Vec<Vec<StablePersistedBlock>>,
    pub historical_render: Vec<StableNormThreadMessage>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StableStreamEmission {
    Partial {
        line_index: usize,
        event_type: String,
        message: StableNormThreadMessage,
    },
    Full {
        line_index: usize,
        event_type: String,
        messages: Vec<StableNormThreadMessage>,
    },
}

/// Shared ID stabilizer. Replaces every unique raw id (usually a UUID)
/// with a sequential `msg-N` label so snapshots stay stable across runs.
/// Used in one pass over the whole fingerprint so the same UUID lands on
/// the same label whether it shows up in a partial, a full emission,
/// the final render, or the historical-reload output.
struct IdStabilizer {
    counter: usize,
    map: std::collections::HashMap<String, String>,
}

impl IdStabilizer {
    fn new() -> Self {
        Self {
            counter: 0,
            map: std::collections::HashMap::new(),
        }
    }

    fn stabilize(&mut self, id: &str) -> String {
        let counter = &mut self.counter;
        self.map
            .entry(id.to_string())
            .or_insert_with(|| {
                *counter += 1;
                format!("msg-{counter}")
            })
            .clone()
    }

    fn stabilize_message(&mut self, msg: &ThreadMessageLike) -> StableNormThreadMessage {
        let norm = normalize_message(msg);
        StableNormThreadMessage {
            role: norm.role,
            id: norm.id.as_deref().map(|raw| self.stabilize(raw)),
            content: norm.content.iter().map(stabilize_part).collect(),
            streaming: norm.streaming,
        }
    }
}

pub fn normalize_stream_fingerprint(
    fingerprint: &StreamReplayFingerprint,
) -> StableStreamReplayFingerprint {
    let mut ids = IdStabilizer::new();
    let emissions = fingerprint
        .emissions
        .iter()
        .map(|e| match e {
            RawStreamEmission::Partial {
                line_index,
                event_type,
                message,
            } => StableStreamEmission::Partial {
                line_index: *line_index,
                event_type: event_type.clone(),
                message: ids.stabilize_message(message),
            },
            RawStreamEmission::Full {
                line_index,
                event_type,
                messages,
            } => StableStreamEmission::Full {
                line_index: *line_index,
                event_type: event_type.clone(),
                messages: messages.iter().map(|m| ids.stabilize_message(m)).collect(),
            },
        })
        .collect();
    let final_render = fingerprint
        .final_render
        .iter()
        .map(|m| ids.stabilize_message(m))
        .collect();
    let historical_render = fingerprint
        .historical_render
        .iter()
        .map(|m| ids.stabilize_message(m))
        .collect();
    StableStreamReplayFingerprint {
        emissions,
        final_render,
        persisted_turn_blocks: fingerprint
            .persisted_turn_blocks
            .iter()
            .map(stabilize_persisted_content)
            .collect(),
        historical_render,
    }
}
