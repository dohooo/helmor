//! Label/notice builders shared by `convert_flat`.
//!
//! Pure functions that turn an `IntermediateMessage` (or its parsed
//! payload) into a rendered string or `MessagePart`. Kept free of any
//! `convert_flat` state so the dispatch loop reads as a flat sequence
//! of `result.push(make_*(...))` calls.

use serde_json::Value;

use crate::pipeline::types::{
    ExtendedMessagePart, IntermediateMessage, MessagePart, MessageRole, NoticeSeverity,
    ThreadMessageLike,
};

pub(super) fn make_system(msg: &IntermediateMessage, text: &str) -> ThreadMessageLike {
    ThreadMessageLike {
        role: MessageRole::System,
        id: Some(msg.id.clone()),
        created_at: Some(msg.created_at.clone()),
        content: vec![ExtendedMessagePart::Basic(MessagePart::Text {
            text: text.to_string(),
        })],
        status: None,
        streaming: None,
    }
}

pub(super) fn make_system_notice(
    msg: &IntermediateMessage,
    part: MessagePart,
) -> ThreadMessageLike {
    ThreadMessageLike {
        role: MessageRole::System,
        id: Some(msg.id.clone()),
        created_at: Some(msg.created_at.clone()),
        content: vec![ExtendedMessagePart::Basic(part)],
        status: None,
        streaming: None,
    }
}

/// Render a Claude `rate_limit_event` into a `SystemNotice` part. Only
/// invoked for `status = "rejected"` (the caller hides every other
/// status), so the output is always a Warning notice describing which
/// bucket was hit and when it resets.
pub(super) fn build_rate_limit_notice(parsed: Option<&Value>) -> MessagePart {
    let info = parsed.and_then(|p| p.get("rate_limit_info"));
    let status = info
        .and_then(|i| i.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let kind = info
        .and_then(|i| i.get("rateLimitType"))
        .and_then(Value::as_str)
        .map(format_rate_limit_kind)
        .unwrap_or_else(|| "Rate limit".to_string());
    let resets_at = info.and_then(|i| i.get("resetsAt")).and_then(Value::as_i64);

    let severity = if status == "allowed" {
        NoticeSeverity::Info
    } else {
        NoticeSeverity::Warning
    };

    let label = if status == "allowed" {
        format!("{kind} — within limit")
    } else {
        format!("{kind} — {status}")
    };

    let body = resets_at.map(|ts| format!("Resets at unix {ts}"));

    MessagePart::SystemNotice {
        severity,
        label,
        body,
    }
}

fn format_rate_limit_kind(kind: &str) -> String {
    match kind {
        "five_hour" => "Rate limit (5 hour)".to_string(),
        "one_hour" => "Rate limit (1 hour)".to_string(),
        "one_day" => "Rate limit (24 hour)".to_string(),
        other => format!("Rate limit ({other})"),
    }
}

/// Convert a Claude `system` event with `subtype = task_*` into a
/// SystemNotice. Returns None for non-subagent system subtypes so the
/// caller falls back to the regular system path.
pub(super) fn build_subagent_notice(
    subtype: Option<&str>,
    parsed: Option<&Value>,
) -> Option<MessagePart> {
    let parsed = parsed?;
    let description = parsed
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string);
    let summary = parsed
        .get("summary")
        .and_then(Value::as_str)
        .map(str::to_string);
    let status = parsed.get("status").and_then(Value::as_str).unwrap_or("");

    match subtype {
        Some("task_started") => Some(MessagePart::SystemNotice {
            severity: NoticeSeverity::Info,
            label: "Subagent started".to_string(),
            body: description,
        }),
        Some("task_progress") => Some(MessagePart::SystemNotice {
            severity: NoticeSeverity::Info,
            label: "Subagent progress".to_string(),
            body: summary.or(description),
        }),
        Some("task_completed") => Some(MessagePart::SystemNotice {
            severity: NoticeSeverity::Info,
            label: "Subagent completed".to_string(),
            body: summary.or(description),
        }),
        Some("task_notification") => {
            let (severity, label) = match status {
                "completed" => (NoticeSeverity::Info, "Subagent completed".to_string()),
                "failed" => (NoticeSeverity::Error, "Subagent failed".to_string()),
                "cancelled" => (NoticeSeverity::Warning, "Subagent cancelled".to_string()),
                _ => (NoticeSeverity::Info, format!("Subagent {status}")),
            };
            Some(MessagePart::SystemNotice {
                severity,
                label,
                body: summary.or(description),
            })
        }
        _ => None,
    }
}

/// Convert a Claude `system` event into a structured `SystemNotice`
/// for the subtypes that carry rich metadata. Returns None for the
/// `task_*` family (handled by `build_subagent_notice`), `init`
/// (intentionally silent), and any unknown subtype (caller falls
/// through to the generic `build_system_label` string path).
///
/// Both Claude-only events (compact_boundary, api_retry) and
/// reshape-target events (tool_use_summary, local_command_output)
/// route through this single function so the frontend never has to
/// distinguish between them.
pub(super) fn build_system_notice(parsed: Option<&Value>) -> Option<MessagePart> {
    let parsed = parsed?;
    let sub = parsed.get("subtype").and_then(Value::as_str)?;
    match sub {
        "local_command_output" => {
            let content = parsed
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_string);
            Some(MessagePart::SystemNotice {
                severity: NoticeSeverity::Info,
                label: "Local command output".to_string(),
                body: content,
            })
        }
        "tool_use_summary" => {
            let summary = parsed
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let count = parsed
                .get("tool_use_count")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let label = if count > 1 {
                format!("Tool output summarized ({count} calls)")
            } else {
                "Tool output summarized".to_string()
            };
            Some(MessagePart::SystemNotice {
                severity: NoticeSeverity::Info,
                label,
                body: Some(summary),
            })
        }
        "compact_boundary" => Some(build_compact_boundary_notice(parsed)),
        "api_retry" => Some(build_api_retry_notice(parsed)),
        _ => None,
    }
}

/// `SDKCompactBoundaryMessage { compact_metadata: { trigger, pre_tokens } }`.
/// Renders as an Info notice explaining why the conversation history
/// just got shorter — Claude-only event, but the rendered shape is
/// provider-agnostic so a future Codex equivalent can flow through
/// the same UI.
fn build_compact_boundary_notice(parsed: &Value) -> MessagePart {
    let meta = parsed.get("compact_metadata");
    let trigger = meta
        .and_then(|m| m.get("trigger"))
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let pre_tokens = meta
        .and_then(|m| m.get("pre_tokens"))
        .and_then(Value::as_i64);
    let body = match (trigger, pre_tokens) {
        ("manual", Some(n)) => format!("Manual compaction · {} tokens compressed", format_count(n)),
        ("manual", None) => "Manual compaction".to_string(),
        ("auto", Some(n)) => format!(
            "Auto-compacted at context limit · {} tokens compressed",
            format_count(n)
        ),
        ("auto", None) => "Auto-compacted at context limit".to_string(),
        (other, Some(n)) => format!("Compacted ({other}) · {} tokens", format_count(n)),
        (other, None) => format!("Compacted ({other})"),
    };
    MessagePart::SystemNotice {
        severity: NoticeSeverity::Info,
        label: "Context compacted".to_string(),
        body: Some(body),
    }
}

/// `SDKAPIRetryMessage { attempt, max_retries, retry_delay_ms,
/// error_status, error }`. Renders as a Warning notice during transient
/// API failures — Claude-only at the source (Codex retries are
/// SDK-internal and never surface).
fn build_api_retry_notice(parsed: &Value) -> MessagePart {
    let attempt = parsed.get("attempt").and_then(Value::as_i64).unwrap_or(0);
    let max = parsed
        .get("max_retries")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let delay_ms = parsed
        .get("retry_delay_ms")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let error = parsed
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("server error");
    let status = parsed.get("error_status").and_then(Value::as_i64);

    let mut body = format!("Retry {attempt}/{max}");
    if delay_ms > 0 {
        body.push_str(&format!(" · waiting {:.1}s", delay_ms as f64 / 1000.0));
    }
    if let Some(s) = status {
        body.push_str(&format!(" · HTTP {s}"));
    }
    body.push_str(&format!(" · {error}"));

    MessagePart::SystemNotice {
        severity: NoticeSeverity::Warning,
        label: "Retrying".to_string(),
        body: Some(body),
    }
}

pub(super) fn build_system_label(parsed: Option<&Value>) -> String {
    let parsed = match parsed {
        Some(p) => p,
        None => return "System".to_string(),
    };
    let sub = parsed.get("subtype").and_then(Value::as_str);
    let model = parsed.get("model").and_then(Value::as_str);
    match sub {
        Some("init") => match model {
            Some(m) => format!("Session initialized — {m}"),
            None => "Session initialized".to_string(),
        },
        Some(s) => format!("System: {s}"),
        None => "System".to_string(),
    }
}

pub(super) fn build_result_label(parsed: Option<&Value>) -> String {
    let parsed = match parsed {
        Some(p) => p,
        None => return "Done".to_string(),
    };

    let cost = parsed.get("total_cost_usd").and_then(Value::as_f64);
    let duration_ms = parsed.get("duration_ms").and_then(Value::as_f64);
    let usage = parsed.get("usage");

    let input_tokens = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(Value::as_i64)
        .or_else(|| parsed.get("input_tokens").and_then(Value::as_i64));
    let output_tokens = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(Value::as_i64)
        .or_else(|| parsed.get("output_tokens").and_then(Value::as_i64));

    let mut bits: Vec<String> = Vec::new();

    if let Some(ms) = duration_ms {
        let total_secs = ms / 1000.0;
        if total_secs >= 60.0 {
            let mins = (total_secs / 60.0).floor() as i64;
            let secs = (total_secs % 60.0).round() as i64;
            if secs > 0 {
                bits.push(format!("{mins}m {secs}s"));
            } else {
                bits.push(format!("{mins}m"));
            }
        } else {
            bits.push(format!("{total_secs:.1}s"));
        }
    }

    if let Some(v) = input_tokens {
        bits.push(format!("in {}", format_count(v)));
    }
    if let Some(v) = output_tokens {
        bits.push(format!("out {}", format_count(v)));
    }
    if let Some(c) = cost {
        bits.push(format!("${c:.4}"));
    }

    if bits.is_empty() {
        "Done".to_string()
    } else {
        bits.join(" \u{2022} ")
    }
}

pub(super) fn build_error_label(msg: &IntermediateMessage, parsed: Option<&Value>) -> String {
    if let Some(p) = parsed {
        if let Some(content) = p.get("content").and_then(Value::as_str) {
            if !content.trim().is_empty() {
                return format!("Error: {content}");
            }
        }
        if let Some(message) = p.get("message").and_then(Value::as_str) {
            if !message.trim().is_empty() {
                return format!("Error: {message}");
            }
        }
    }

    // Try parsing raw content as JSON for error extraction
    if let Ok(obj) = serde_json::from_str::<Value>(&msg.raw_json) {
        if let Some(content) = obj.get("content").and_then(Value::as_str) {
            return format!("Error: {content}");
        }
        if let Some(message) = obj.get("message").and_then(Value::as_str) {
            return format!("Error: {message}");
        }
    }

    let fb = extract_fallback(msg);
    format!("Error: {fb}")
}

pub(super) fn extract_fallback(msg: &IntermediateMessage) -> String {
    if msg.parsed.is_none() {
        return msg.raw_json.clone();
    }
    let p = msg.parsed.as_ref().unwrap();

    if let Some(text) = p.get("text").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return text.to_string();
        }
    }
    if let Some(result) = p.get("result").and_then(Value::as_str) {
        if !result.trim().is_empty() {
            return result.to_string();
        }
    }

    let m = p.get("message");
    if let Some(msg_obj) = m.and_then(Value::as_object) {
        if let Some(content) = msg_obj.get("content") {
            if let Some(s) = content.as_str() {
                return s.to_string();
            }
            if let Some(arr) = content.as_array() {
                let texts: Vec<&str> = arr
                    .iter()
                    .filter_map(|b| {
                        b.as_object()
                            .and_then(|o| o.get("text"))
                            .and_then(Value::as_str)
                    })
                    .collect();
                if !texts.is_empty() {
                    return texts.join("\n\n");
                }
            }
        }
    }

    // Last resort: truncate raw content
    let max = 200;
    if msg.raw_json.len() <= max {
        msg.raw_json.clone()
    } else {
        msg.raw_json[..max].to_string()
    }
}

/// Format a token count with thousand separators.
pub(super) fn format_count(value: i64) -> String {
    if value < 1000 {
        return value.to_string();
    }
    let s = value.to_string();
    let mut result = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push(',');
        }
        result.push(ch);
    }
    result.chars().rev().collect()
}
