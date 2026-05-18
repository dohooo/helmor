//! Normalized snapshot format.
//!
//! Used by handcrafted scenarios where we care about structural shape, not
//! exact text content. Strips IDs/timestamps, lowercases the role enum,
//! truncates long strings, and reports tool args as sorted key sets.

use helmor_lib::pipeline::types::{
    ExtendedMessagePart, ImageSource, MessagePart, MessageRole, StreamingStatus, ThreadMessageLike,
};
use serde::Serialize;
use serde_json::Value;

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
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
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
        /// Number of sub-agent child parts attached to this tool call by
        /// the grouping pass. Always 0 for non-Task/Agent tools.
        #[serde(default, skip_serializing_if = "is_zero")]
        children_count: usize,
        /// Normalized child parts — only present when children_count > 0.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        children: Vec<NormPart>,
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
    PlanReview {
        tool_use_id: String,
        tool_name: String,
        plan_length: usize,
        plan_preview: Option<String>,
        plan_file_path: Option<String>,
        allowed_prompt_tools: Vec<String>,
    },
    FileMention {
        path: String,
    },
}

fn is_zero(n: &usize) -> bool {
    *n == 0
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
    role.as_str().to_string()
}

fn normalize_basic(part: &MessagePart) -> NormPart {
    match part {
        // Part `id` is intentionally omitted from the normalized form so
        // snapshots stay stable across UUID changes. The stable-id
        // invariants are covered by dedicated pinning tests that read
        // `part.part_id()` directly.
        MessagePart::Text { text, .. } => NormPart::Text {
            text: truncate(text),
        },
        MessagePart::Reasoning {
            text,
            streaming,
            duration_ms,
            ..
        } => NormPart::Reasoning {
            text_length: utf16_len(text),
            text_preview: truncate(text),
            streaming: *streaming,
            duration_ms: *duration_ms,
        },
        MessagePart::ToolCall {
            tool_call_id,
            tool_name,
            args,
            args_text,
            result,
            streaming_status,
            children,
            // is_error kept out of the normalized form on purpose.
            ..
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
                        (true, Some("string".to_string()), Some(truncate(s)))
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
                children_count: children.len(),
                children: children.iter().map(normalize_part).collect(),
            }
        }
        MessagePart::SystemNotice {
            severity,
            label,
            body,
            ..
        } => NormPart::SystemNotice {
            severity: format!("{severity:?}").to_lowercase(),
            label: truncate(label),
            body: body.as_deref().map(truncate),
        },
        MessagePart::TodoList { items, .. } => NormPart::TodoList {
            item_count: items.len(),
            statuses: items
                .iter()
                .map(|i| format!("{:?}", i.status).to_lowercase())
                .collect(),
        },
        MessagePart::Image {
            source, media_type, ..
        } => NormPart::Image {
            kind: match source {
                ImageSource::Base64 { .. } => "base64".to_string(),
                ImageSource::Url { .. } => "url".to_string(),
                ImageSource::File { .. } => "file".to_string(),
            },
            media_type: media_type.clone(),
        },
        MessagePart::PromptSuggestion { text, .. } => NormPart::PromptSuggestion {
            text_length: utf16_len(text),
            text_preview: truncate(text),
        },
        MessagePart::PlanReview {
            tool_use_id,
            tool_name,
            plan,
            plan_file_path,
            allowed_prompts,
        } => NormPart::PlanReview {
            tool_use_id: tool_use_id.clone(),
            tool_name: tool_name.clone(),
            plan_length: plan.as_deref().map(utf16_len).unwrap_or(0),
            plan_preview: plan.as_deref().map(truncate),
            plan_file_path: plan_file_path.clone(),
            allowed_prompt_tools: allowed_prompts
                .iter()
                .map(|entry| entry.tool.clone())
                .collect(),
        },
        MessagePart::FileMention { path, .. } => NormPart::FileMention { path: path.clone() },
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
    let mut counter = 0usize;
    let mut id_map = std::collections::HashMap::<String, String>::new();
    msgs.iter()
        .map(|msg| {
            let mut norm = normalize_message(msg);
            // Replace non-deterministic IDs (UUIDs, stream:N:role, partial
            // IDs) with sequential labels so snapshots are stable across
            // runs. Deterministic short test IDs (e.g. "e1", "u1") pass
            // through unchanged.
            if let Some(raw) = &norm.id {
                let stable = id_map.entry(raw.clone()).or_insert_with(|| {
                    counter += 1;
                    format!("msg-{counter}")
                });
                norm.id = Some(stable.clone());
            }
            norm
        })
        .collect()
}
