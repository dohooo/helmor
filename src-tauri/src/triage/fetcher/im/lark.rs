//! Lark ImBackend.
//!
//! Discovery rides on `lark-cli im +chat-list --sort-type
//! ByActiveTimeDesc --exclude-muted`. Lark's server already sorts by
//! activity AND drops chats the user has muted (DND), so we just hand
//! the top slice back to the generic layer.
//!
//! Per-conversation pull uses `chat-messages-list --start <iso>`. The
//! `lark-cli` calls are async tokio — we drive them via the shared
//! `super::super::http_runtime()` from `ImBackend`'s sync trait.

use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::lark;

use super::types::{ImConversation, ImConversationKind, ImMessage};
use super::ImBackend;

const SOURCE: &str = "lark";
/// `chat-list` page-size; cap so a heavy account doesn't hog one tick.
/// The generic layer truncates further to MAX_CONVERSATIONS_PER_TICK.
const DISCOVERY_PAGE_SIZE: u32 = 100;

pub struct LarkBackend;

impl ImBackend for LarkBackend {
    fn source(&self) -> &'static str {
        SOURCE
    }

    fn preflight(&self) -> Result<()> {
        super::super::http_runtime()
            .block_on(lark::auth_status())
            .context("lark auth_status")
    }

    fn discover_conversations(&self, _limit: usize) -> Result<Vec<ImConversation>> {
        let raw =
            super::super::http_runtime().block_on(lark::im::chat_list(lark::im::ChatList {
                sort_type: "ByActiveTimeDesc",
                exclude_muted: true,
                page_size: DISCOVERY_PAGE_SIZE,
                page_token: None,
            }))?;
        Ok(parse_chats(&raw)
            .into_iter()
            .map(to_im_conversation)
            .collect())
    }

    fn fetch_messages(
        &self,
        conv: &ImConversation,
        since: Option<DateTime<Utc>>,
        limit: usize,
    ) -> Result<Vec<ImMessage>> {
        let chat_id = conv.id.as_str();
        let start = since.map(|dt| dt.to_rfc3339_opts(SecondsFormat::Secs, true));
        let raw = super::super::http_runtime().block_on(lark::im::chat_messages_list(
            lark::im::ChatMessages {
                chat_id,
                page_size: limit.min(u32::MAX as usize) as u32,
                start: start.as_deref(),
            },
        ))?;
        // `chat_messages_list` returns newest-first. We keep that order
        // for indexing, but each message's `raw.neighbors` carries the
        // surrounding ±NEIGHBOR_WINDOW messages sorted chronologically
        // (oldest first), so the rendered payload reads naturally.
        let records = parse_messages(&raw);
        let mut out = Vec::with_capacity(records.len());
        for (idx, record) in records.iter().enumerate() {
            let neighbors = collect_neighbors(&records, idx);
            if let Some(msg) = to_im_message(record.clone(), &neighbors) {
                out.push(msg);
            }
        }
        Ok(out)
    }

    fn render_payload(&self, conv: &ImConversation, msg: &ImMessage) -> String {
        // Lark-specific override: surface `chat_mode` and `msg_type` so
        // the LLM can tell a `post`-style rich message apart from a
        // plain text one, AND append the ±NEIGHBOR_WINDOW chronological
        // siblings so a one-line reply isn't read in isolation.
        let mut out = String::new();
        let label = conv.label.as_deref().unwrap_or(&conv.id);
        let sender = msg.sender.as_deref().unwrap_or("(unknown)");
        out.push_str(&format!("# Lark message — {sender} in {label}\n\n"));
        out.push_str(&format!("- chat_id: {}\n", conv.id));
        out.push_str(&format!("- kind: {}\n", conv.kind.as_source_kind()));
        if let Some(mode) = conv.raw.get("chat_mode").and_then(Value::as_str) {
            out.push_str(&format!("- chat_mode: {mode}\n"));
        }
        if let Some(msg_type) = msg.raw.get("msg_type").and_then(Value::as_str) {
            out.push_str(&format!("- msg_type: {msg_type}\n"));
        }
        out.push_str(&format!(
            "- timestamp: {}\n",
            msg.timestamp.to_rfc3339_opts(SecondsFormat::Secs, true)
        ));
        if let Some(url) = &msg.external_url {
            out.push_str(&format!("- link: {url}\n"));
        }
        out.push_str("\n---\n\n## Message\n\n```\n");
        out.push_str(msg.text.trim());
        out.push_str("\n```\n");

        if let Some(neighbors) = msg.raw.get("neighbors").and_then(Value::as_array) {
            if !neighbors.is_empty() {
                out.push_str("\n## Surrounding context (±3 messages, chronological)\n\n");
                for n in neighbors {
                    let ns = n
                        .get("sender")
                        .and_then(Value::as_str)
                        .unwrap_or("(unknown)");
                    let ts = n
                        .get("create_time_iso")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let body = n.get("content").and_then(Value::as_str).unwrap_or("");
                    out.push_str(&format!("**{ns}** · {ts}\n"));
                    out.push_str("```\n");
                    out.push_str(body.trim());
                    out.push_str("\n```\n\n");
                }
            }
        }
        out
    }
}

fn parse_chats(raw: &Value) -> Vec<ChatRow> {
    let arr = raw
        .pointer("/data/items")
        .or_else(|| raw.pointer("/data/chats"))
        .or_else(|| raw.get("items"))
        .or_else(|| raw.get("chats"))
        .and_then(Value::as_array);
    match arr {
        Some(arr) => arr
            .iter()
            .filter_map(|v| serde_json::from_value::<ChatRow>(v.clone()).ok())
            .filter(|c| !c.chat_id.is_empty())
            .collect(),
        None => Vec::new(),
    }
}

fn parse_messages(raw: &Value) -> Vec<MessageRecord> {
    let arr = raw
        .pointer("/data/messages")
        .or_else(|| raw.get("messages"))
        .and_then(Value::as_array);
    match arr {
        Some(arr) => arr
            .iter()
            .filter_map(|v| serde_json::from_value::<MessageRecord>(v.clone()).ok())
            .collect(),
        None => Vec::new(),
    }
}

fn to_im_conversation(row: ChatRow) -> ImConversation {
    let kind = match row.chat_mode.as_deref() {
        Some("p2p") => ImConversationKind::Dm,
        // Lark doesn't expose a public/private distinction at this level
        // ("group" covers both); default to Channel.
        _ => ImConversationKind::Channel,
    };
    let raw = json!({
        "chat_mode": row.chat_mode,
    });
    ImConversation {
        id: row.chat_id,
        label: row.name,
        kind,
        raw,
    }
}

/// Window radius for "surrounding context" — ±this many messages
/// (chronological) attached to each candidate's payload.
const NEIGHBOR_WINDOW: usize = 3;

/// Pick the ±NEIGHBOR_WINDOW neighbours of `records[idx]`, ordered
/// chronologically (oldest first). `records` comes in newest-first from
/// `chat_messages_list`, so:
///   - higher indices = chronologically earlier
///   - lower indices = chronologically later
///
/// We grab a window on each side and sort by parsed `create_time`.
fn collect_neighbors(records: &[MessageRecord], idx: usize) -> Vec<MessageRecord> {
    let total = records.len();
    let earlier_end = (idx + NEIGHBOR_WINDOW + 1).min(total);
    let later_start = idx.saturating_sub(NEIGHBOR_WINDOW);
    let mut neighbors: Vec<MessageRecord> = Vec::new();
    // Earlier-in-time → higher index than `idx`.
    if idx + 1 < earlier_end {
        neighbors.extend(records[(idx + 1)..earlier_end].iter().cloned());
    }
    // Later-in-time → lower index than `idx`.
    if later_start < idx {
        neighbors.extend(records[later_start..idx].iter().cloned());
    }
    neighbors.sort_by_key(|n| {
        n.create_time
            .as_deref()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0)
    });
    neighbors
}

fn to_im_message(m: MessageRecord, neighbors: &[MessageRecord]) -> Option<ImMessage> {
    let id = m.message_id?;
    if m.deleted.unwrap_or(false) {
        return None;
    }
    let timestamp = parse_create_time(m.create_time.as_deref()).unwrap_or_else(Utc::now);
    let sender = m
        .sender
        .as_ref()
        .and_then(|s| s.name.clone().or_else(|| s.id.clone()));
    let text = m.content.clone().unwrap_or_default();
    let neighbor_json: Vec<Value> = neighbors
        .iter()
        .filter(|n| !n.deleted.unwrap_or(false))
        .map(|n| {
            json!({
                "sender": n
                    .sender
                    .as_ref()
                    .and_then(|s| s.name.clone().or_else(|| s.id.clone()))
                    .unwrap_or_default(),
                "create_time": n.create_time,
                "create_time_iso": n
                    .create_time
                    .as_deref()
                    .and_then(parse_create_time_str_to_iso)
                    .unwrap_or_default(),
                "msg_type": n.msg_type,
                "content": n.content,
            })
        })
        .collect();
    let raw = json!({
        "msg_type": m.msg_type,
        "neighbors": neighbor_json,
    });
    Some(ImMessage {
        id,
        timestamp,
        sender,
        text,
        external_url: m.message_app_link,
        deleted: false,
        raw,
    })
}

/// Convert Lark's millis-string timestamp into a human-readable ISO
/// string for the neighbor section. Returns `None` if unparseable.
fn parse_create_time_str_to_iso(raw: &str) -> Option<String> {
    let ms: i64 = raw.parse().ok()?;
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn parse_create_time(raw: Option<&str>) -> Option<DateTime<Utc>> {
    let s = raw?;
    let ms: i64 = s.parse().ok()?;
    Utc.timestamp_millis_opt(ms).single()
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ChatRow {
    #[serde(default)]
    chat_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    chat_mode: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct MessageRecord {
    message_id: Option<String>,
    msg_type: Option<String>,
    create_time: Option<String>,
    content: Option<String>,
    deleted: Option<bool>,
    message_app_link: Option<String>,
    sender: Option<SenderRecord>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct SenderRecord {
    id: Option<String>,
    name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_chat_list_envelope() {
        let raw = json!({
            "data": {
                "items": [
                    { "chat_id": "oc_a", "name": "eng-frontend", "chat_mode": "group" },
                    { "chat_id": "oc_b", "name": "Alice", "chat_mode": "p2p" },
                ]
            }
        });
        let chats = parse_chats(&raw);
        assert_eq!(chats.len(), 2);
        let convs: Vec<_> = chats.into_iter().map(to_im_conversation).collect();
        assert_eq!(convs[0].kind, ImConversationKind::Channel);
        assert_eq!(convs[1].kind, ImConversationKind::Dm);
        assert_eq!(convs[0].label.as_deref(), Some("eng-frontend"));
    }

    #[test]
    fn parses_messages_envelope_and_maps_to_im_message() {
        let raw = json!({
            "data": {
                "messages": [
                    {
                        "message_id": "om_111",
                        "msg_type": "text",
                        "create_time": "1735000000000",
                        "content": "麻烦帮忙看下登录bug",
                        "sender": { "id": "ou_z", "name": "Bob" }
                    }
                ]
            }
        });
        let msgs = parse_messages(&raw);
        let im_msg = to_im_message(msgs.into_iter().next().unwrap(), &[]).unwrap();
        assert_eq!(im_msg.id, "om_111");
        assert_eq!(im_msg.sender.as_deref(), Some("Bob"));
        assert_eq!(im_msg.text, "麻烦帮忙看下登录bug");
    }

    #[test]
    fn parses_lark_millis_string() {
        let dt = parse_create_time(Some("1735000000000")).unwrap();
        assert_eq!(dt.timestamp_millis(), 1735000000000);
    }

    #[test]
    fn deleted_messages_are_dropped() {
        let m = MessageRecord {
            message_id: Some("om_x".into()),
            deleted: Some(true),
            ..Default::default()
        };
        assert!(to_im_message(m, &[]).is_none());
    }

    #[test]
    fn collect_neighbors_window_around_middle_index() {
        // Records arrive newest-first: indices 0,1,2,3,4 with create_times
        // descending. ±NEIGHBOR_WINDOW=3 around idx=3 (the 4th-newest).
        let records: Vec<MessageRecord> = (0..7)
            .map(|i| MessageRecord {
                message_id: Some(format!("om_{i}")),
                // newest-first → reverse-sorted timestamps
                create_time: Some((1_700_000_000_000_i64 - (i as i64 * 1000)).to_string()),
                content: Some(format!("msg-{i}")),
                ..Default::default()
            })
            .collect();
        let neighbors = collect_neighbors(&records, 3);
        // Expect indices [0,1,2] (later in time) + [4,5,6] (earlier in time)
        // sorted chronologically (oldest first) → [6,5,4,2,1,0] by index
        // → contents ["msg-6","msg-5","msg-4","msg-2","msg-1","msg-0"].
        let contents: Vec<&str> = neighbors
            .iter()
            .filter_map(|n| n.content.as_deref())
            .collect();
        assert_eq!(
            contents,
            vec!["msg-6", "msg-5", "msg-4", "msg-2", "msg-1", "msg-0"]
        );
    }

    #[test]
    fn neighbors_at_boundary_are_clamped() {
        let records: Vec<MessageRecord> = (0..3)
            .map(|i| MessageRecord {
                message_id: Some(format!("om_{i}")),
                create_time: Some((1_700_000_000_000_i64 - (i as i64 * 1000)).to_string()),
                ..Default::default()
            })
            .collect();
        // idx=0 (newest): no later neighbors, 2 earlier ones.
        assert_eq!(collect_neighbors(&records, 0).len(), 2);
        // idx=2 (oldest): 2 later neighbors, no earlier ones.
        assert_eq!(collect_neighbors(&records, 2).len(), 2);
    }

    #[test]
    fn render_includes_neighbor_context() {
        let conv = ImConversation {
            id: "oc_x".into(),
            label: Some("eng".into()),
            kind: ImConversationKind::Channel,
            raw: json!({ "chat_mode": "group" }),
        };
        let msg = ImMessage {
            id: "om_2".into(),
            timestamp: Utc.with_ymd_and_hms(2026, 5, 26, 10, 0, 5).unwrap(),
            sender: Some("Bob".into()),
            text: "OK".into(),
            external_url: None,
            deleted: false,
            raw: json!({
                "msg_type": "text",
                "neighbors": [
                    {
                        "sender": "Alice",
                        "create_time_iso": "2026-05-26T10:00:00Z",
                        "content": "Anyone seen the login bug?",
                    },
                    {
                        "sender": "Carol",
                        "create_time_iso": "2026-05-26T10:00:10Z",
                        "content": "Repro: open /login then…",
                    }
                ]
            }),
        };
        let rendered = LarkBackend.render_payload(&conv, &msg);
        assert!(rendered.contains("## Surrounding context"));
        assert!(rendered.contains("**Alice** · 2026-05-26T10:00:00Z"));
        assert!(rendered.contains("Repro: open /login then…"));
    }

    #[test]
    fn render_includes_chat_mode_and_msg_type() {
        let conv = ImConversation {
            id: "oc_x".into(),
            label: Some("eng".into()),
            kind: ImConversationKind::Channel,
            raw: json!({ "chat_mode": "group" }),
        };
        let msg = ImMessage {
            id: "om_1".into(),
            timestamp: Utc.with_ymd_and_hms(2026, 5, 26, 10, 0, 0).unwrap(),
            sender: Some("Bob".into()),
            text: "hi".into(),
            external_url: None,
            deleted: false,
            raw: json!({ "msg_type": "text" }),
        };
        let rendered = LarkBackend.render_payload(&conv, &msg);
        assert!(rendered.contains("- chat_mode: group"));
        assert!(rendered.contains("- msg_type: text"));
        assert!(rendered.contains("```\nhi\n```"));
    }
}
