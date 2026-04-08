//! Shared helpers for the unified pipeline test infrastructure.
//!
//! Three test targets share this module:
//! - `pipeline_scenarios.rs` — handcrafted edge-case scenarios (normalized snapshots)
//! - `pipeline_fixtures.rs` — real DB-captured sessions (raw snapshots)
//! - `pipeline_streams.rs` — raw stream-event jsonl replay (synthesized snapshots)
//!
//! Each test target sees a different subset of these helpers — `dead_code`
//! is permitted globally so unused-from-target's-perspective items don't
//! emit warnings.

#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

// Re-exported so test files can `use common::*` and reach the production
// pipeline types without listing each one.
pub use helmor_lib::pipeline::types::{HistoricalRecord, ThreadMessageLike};
pub use helmor_lib::pipeline::MessagePipeline;

use helmor_lib::pipeline::types::{ExtendedMessagePart, MessagePart, MessageRole, StreamingStatus};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ============================================================================
// Normalized snapshot format
// ----------------------------------------------------------------------------
// Used by handcrafted scenarios where we care about structural shape, not
// exact text content. Strips IDs/timestamps, lowercases the role enum,
// truncates long strings, and reports tool args as sorted key sets.
// ============================================================================

#[derive(Debug, Serialize)]
pub struct NormThreadMessage {
    pub role: String,
    pub id: Option<String>,
    pub content_length: usize,
    pub content: Vec<NormPart>,
    pub status: Option<NormStatus>,
    pub streaming: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct NormStatus {
    #[serde(rename = "type")]
    pub status_type: String,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum NormPart {
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
    /// Collapsed group placeholder. Most scenarios shouldn't trigger collapse,
    /// but if one does we want a clear marker rather than a panic.
    CollapsedGroup {
        category: String,
        tools_count: usize,
        active: bool,
        summary: String,
    },
    SystemNotice {
        severity: String,
        label: String,
        body: Option<String>,
    },
    TodoList {
        item_count: usize,
        statuses: Vec<String>,
    },
    Image {
        kind: String,
        media_type: Option<String>,
    },
    PromptSuggestion {
        text_length: usize,
        text_preview: String,
    },
}

pub fn truncate(s: &str) -> String {
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

pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

pub fn streaming_status_str(s: &StreamingStatus) -> String {
    match s {
        StreamingStatus::Pending => "pending",
        StreamingStatus::StreamingInput => "streaming_input",
        StreamingStatus::Running => "running",
        StreamingStatus::Done => "done",
        StreamingStatus::Error => "error",
    }
    .to_string()
}

pub fn role_str(role: &MessageRole) -> String {
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
        MessagePart::SystemNotice {
            severity,
            label,
            body,
        } => NormPart::SystemNotice {
            severity: format!("{severity:?}").to_lowercase(),
            label: truncate(label),
            body: body.as_deref().map(truncate),
        },
        MessagePart::TodoList { items } => NormPart::TodoList {
            item_count: items.len(),
            statuses: items
                .iter()
                .map(|i| format!("{:?}", i.status).to_lowercase())
                .collect(),
        },
        MessagePart::Image { source, media_type } => NormPart::Image {
            kind: match source {
                helmor_lib::pipeline::types::ImageSource::Base64 { .. } => "base64".to_string(),
                helmor_lib::pipeline::types::ImageSource::Url { .. } => "url".to_string(),
            },
            media_type: media_type.clone(),
        },
        MessagePart::PromptSuggestion { text } => NormPart::PromptSuggestion {
            text_length: utf16_len(text),
            text_preview: truncate(text),
        },
    }
}

pub fn normalize_part(part: &ExtendedMessagePart) -> NormPart {
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

pub fn normalize_message(msg: &ThreadMessageLike) -> NormThreadMessage {
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

pub fn normalize_all(msgs: &[ThreadMessageLike]) -> Vec<NormThreadMessage> {
    msgs.iter().map(normalize_message).collect()
}

// ============================================================================
// Builders — produce HistoricalRecord with parsed_content auto-derived from
// content. Mirrors the production loader in `sessions.rs::list_session_*`.
// ============================================================================

pub fn make_record(id: &str, role: &str, content: &str) -> HistoricalRecord {
    HistoricalRecord {
        id: id.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        parsed_content: serde_json::from_str::<Value>(content).ok(),
        created_at: "2026-04-06T00:00:00.000Z".to_string(),
    }
}

pub fn assistant_json(id: &str, blocks: Value, extra: Option<Value>) -> HistoricalRecord {
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
    make_record(id, "assistant", &serde_json::to_string(&parsed).unwrap())
}

pub fn user_json(id: &str, blocks: Value) -> HistoricalRecord {
    let parsed = json!({
        "type": "user",
        "message": { "role": "user", "content": blocks },
    });
    make_record(id, "user", &serde_json::to_string(&parsed).unwrap())
}

/// Post-migration form for real human prompts:
/// `{"type":"user_prompt","text":"..."}`
pub fn user_prompt(id: &str, text: &str) -> HistoricalRecord {
    let parsed = json!({ "type": "user_prompt", "text": text });
    make_record(id, "user", &serde_json::to_string(&parsed).unwrap())
}

pub fn system_json(id: &str, extra: Value) -> HistoricalRecord {
    let mut parsed = json!({ "type": "system" });
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            parsed[k] = v.clone();
        }
    }
    make_record(id, "system", &serde_json::to_string(&parsed).unwrap())
}

pub fn result_json(id: &str, extra: Value) -> HistoricalRecord {
    let mut parsed = json!({ "type": "result" });
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            parsed[k] = v.clone();
        }
    }
    make_record(id, "assistant", &serde_json::to_string(&parsed).unwrap())
}

/// Run records through the pipeline and return the normalized form. Used by
/// the handcrafted scenarios where structural shape is what matters.
pub fn run_normalized(msgs: Vec<HistoricalRecord>) -> Vec<NormThreadMessage> {
    normalize_all(&MessagePipeline::convert_historical(&msgs))
}

// ============================================================================
// Real-data fixture loader (used by `pipeline_fixtures.rs`)
// ----------------------------------------------------------------------------
// Reads `tests/fixtures/pipeline/<name>/input.json` and produces
// `Vec<HistoricalRecord>`. Accepts the legacy `content_is_json` field via
// #[serde(default, rename)] for fixtures captured before the user_prompt
// migration; the field is ignored on read since we now always derive
// parsed_content from content.
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoricalRecordFixture {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub parsed_content: Option<Value>,
    pub created_at: String,
    /// Legacy field — kept for deserialization of old fixtures, ignored.
    #[serde(default, rename = "content_is_json")]
    pub _legacy_content_is_json: Option<bool>,
}

impl HistoricalRecordFixture {
    pub fn into_record(self) -> HistoricalRecord {
        let parsed_content = self
            .parsed_content
            .or_else(|| serde_json::from_str(&self.content).ok());
        HistoricalRecord {
            id: self.id,
            role: self.role,
            content: self.content,
            parsed_content,
            created_at: self.created_at,
        }
    }
}

pub fn load_fixture(input_json_path: &Path) -> Vec<HistoricalRecord> {
    let raw = fs::read_to_string(input_json_path)
        .unwrap_or_else(|e| panic!("read {input_json_path:?}: {e}"));
    let fixtures: Vec<HistoricalRecordFixture> =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {input_json_path:?}: {e}"));
    fixtures.into_iter().map(|f| f.into_record()).collect()
}

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}
