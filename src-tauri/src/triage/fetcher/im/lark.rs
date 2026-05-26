//! Lark ImBackend.
//!
//! Discovery rules (matching user intent):
//!   - DMs (chat_mode = "p2p"): a DM is worth surfacing as soon as
//!     ANY message lands in it within the lookback window — we don't
//!     gate on whether the user has replied. The fetch step decides
//!     whether the DM actually has recent content (empty windows just
//!     don't write a candidate row).
//!   - Groups: only those the user has spoken in OR been @ed in. A
//!     large room the user is a passive member of doesn't earn a
//!     candidate slot.
//!
//! Implementation:
//!   1. `chat-list --sort-type ByActiveTimeDesc --exclude-muted` —
//!      enumerate every chat (DM + group) the user is in.
//!   2. `messages-search(sender=me, start=cold_start)` +
//!      `messages-search(is_at_me=true, start=cold_start)` — derive
//!      the "I'm involved here" group set.
//!   3. Keep DMs unconditionally; keep groups iff in the involved set.
//!      Per-conversation `chat-messages-list` runs later in the
//!      generic ingest path; empty windows are silently dropped there.

use std::collections::BTreeSet;

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, SecondsFormat, TimeZone, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::lark;

use super::types::{ImConversation, ImConversationKind, ImMessage};
use super::ImBackend;

const SOURCE: &str = "lark";
/// Cap per messages-search call. Lark's API maxes at 50 anyway, but
/// we only need DISTINCT chat ids — 50 usually covers all of them.
const DISCOVERY_PAGE_SIZE: u32 = 50;
/// Cap on chat-list. Sorted ByActiveTimeDesc, so the top slice is the
/// freshest. 100 is the API max.
const CHAT_LIST_PAGE_SIZE: u32 = 100;

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
        let rt = super::super::http_runtime();
        rt.block_on(async {
            let my_open_id = lark::contact::self_open_id()
                .await
                .context("resolve self open_id")?;
            // Cold-start aligned window for "I'm involved" checks. DMs
            // bypass this — they're kept unconditionally and the ingest
            // step decides whether they actually have recent activity.
            let start = (Utc::now() - Duration::days(super::COLD_START_DAYS))
                .to_rfc3339_opts(SecondsFormat::Secs, true);

            // (1) Build the "I'm involved" set: chats where I sent
            // something OR someone @ed me, within the window. Used
            // only to filter GROUPS — DMs bypass this set.
            let mut involved_groups: BTreeSet<String> = BTreeSet::new();
            let sent = lark::im::messages_search(lark::im::MessagesSearch {
                query: None,
                sender: Some(my_open_id.as_str()),
                chat_id: None,
                is_at_me: false,
                start: Some(start.as_str()),
                end: None,
                page_size: DISCOVERY_PAGE_SIZE,
            })
            .await
            .context("messages-search sender=me")?;
            collect_chat_ids(&sent, &mut involved_groups);
            let mentions = lark::im::messages_search(lark::im::MessagesSearch {
                query: None,
                sender: None,
                chat_id: None,
                is_at_me: true,
                start: Some(start.as_str()),
                end: None,
                page_size: DISCOVERY_PAGE_SIZE,
            })
            .await
            .context("messages-search is_at_me")?;
            collect_chat_ids(&mentions, &mut involved_groups);

            // (2) Enumerate every chat the user is in.
            let raw_chats = lark::im::chat_list(lark::im::ChatList {
                sort_type: "ByActiveTimeDesc",
                exclude_muted: true,
                page_size: CHAT_LIST_PAGE_SIZE,
            })
            .await
            .context("chat-list")?;

            // (3) Apply the per-type rule. Empty DMs survive here and
            // get filtered out at ingest time when fetch_messages
            // returns nothing within the window.
            let convs = parse_chat_list(&raw_chats)
                .into_iter()
                .filter(|c| {
                    let is_dm = c.chat_mode.as_deref() == Some("p2p");
                    is_dm || involved_groups.contains(&c.chat_id)
                })
                .map(to_im_conversation)
                .collect();
            Ok(convs)
        })
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
        Ok(parse_messages(&raw)
            .into_iter()
            .filter_map(to_im_message)
            .collect())
    }

    fn render_message_block(&self, _conv: &ImConversation, msg: &ImMessage) -> String {
        // Lark-specific tweak: surface `msg_type` on the same heading
        // line as the timestamp/sender so the LLM can spot a `post`-
        // style rich-text bubble vs a plain `text` line at a glance.
        let mut out = String::new();
        let sender = msg.sender.as_deref().unwrap_or("(unknown)");
        let ts = msg.timestamp.to_rfc3339_opts(SecondsFormat::Secs, true);
        let msg_type = msg
            .raw
            .get("msg_type")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && *s != "text");
        match msg_type {
            Some(kind) => out.push_str(&format!("## {ts} — {sender} · id:{} · {kind}\n", msg.id)),
            None => out.push_str(&format!("## {ts} — {sender} · id:{}\n", msg.id)),
        }
        out.push_str("```\n");
        out.push_str(msg.text.trim());
        out.push_str("\n```\n");
        out
    }
}

/// Extract distinct chat_ids from a `messages-search` response. We
/// don't care about anything else — just which chats had me involved.
fn collect_chat_ids(raw: &Value, sink: &mut BTreeSet<String>) {
    for m in parse_messages(raw) {
        if let Some(id) = m.chat_id.filter(|s| !s.is_empty()) {
            sink.insert(id);
        }
    }
}

/// Parse a `chat-list` envelope. Lark's response wraps rows under
/// `data.items` (current API) or `data.chats` (older); be liberal.
fn parse_chat_list(raw: &Value) -> Vec<ChatRow> {
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
        // Lark's `chat-list` doesn't separate public/private inside the
        // "group" bucket; default to Channel for both.
        _ => ImConversationKind::Channel,
    };
    let raw = json!({ "chat_mode": row.chat_mode });
    ImConversation {
        id: row.chat_id,
        label: row.name,
        kind,
        raw,
    }
}

fn to_im_message(m: MessageRecord) -> Option<ImMessage> {
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
    let raw = json!({ "msg_type": m.msg_type });
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

fn parse_create_time(raw: Option<&str>) -> Option<DateTime<Utc>> {
    let s = raw?;
    let ms: i64 = s.parse().ok()?;
    Utc.timestamp_millis_opt(ms).single()
}

/// One row from `chat-list`. Only the fields we actually consume are
/// captured; everything else is dropped by the `Deserialize` impl.
#[derive(Debug, Clone, Default, Deserialize)]
struct ChatRow {
    #[serde(default)]
    chat_id: String,
    #[serde(default)]
    name: Option<String>,
    /// `"p2p"` for DMs, `"group"` (and friends) for everything else.
    /// `None` when the API omits it — we treat that as group-like.
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
    /// Present on `messages-search` responses (each hit carries its
    /// chat context); absent on `chat-messages-list` rows.
    #[serde(default)]
    chat_id: Option<String>,
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
    fn collect_chat_ids_dedupes_across_calls() {
        let raw1 = json!({
            "data": {
                "messages": [
                    { "message_id": "om_1", "chat_id": "oc_a" },
                    { "message_id": "om_2", "chat_id": "oc_b" },
                ]
            }
        });
        let raw2 = json!({
            "data": {
                "messages": [
                    { "message_id": "om_3", "chat_id": "oc_a" },
                    { "message_id": "om_4", "chat_id": "oc_c" },
                ]
            }
        });
        let mut sink = BTreeSet::new();
        collect_chat_ids(&raw1, &mut sink);
        collect_chat_ids(&raw2, &mut sink);
        assert_eq!(sink.len(), 3);
        assert!(sink.contains("oc_a"));
        assert!(sink.contains("oc_b"));
        assert!(sink.contains("oc_c"));
    }

    #[test]
    fn parse_chat_list_handles_data_items() {
        let raw = json!({
            "data": {
                "items": [
                    { "chat_id": "oc_a", "name": "eng", "chat_mode": "group" },
                    { "chat_id": "oc_b", "name": "Alice", "chat_mode": "p2p" },
                ]
            }
        });
        let rows = parse_chat_list(&raw);
        assert_eq!(rows.len(), 2);
        let convs: Vec<_> = rows.into_iter().map(to_im_conversation).collect();
        assert_eq!(convs[0].kind, ImConversationKind::Channel);
        assert_eq!(convs[1].kind, ImConversationKind::Dm);
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
        let im_msg = to_im_message(msgs.into_iter().next().unwrap()).unwrap();
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
        assert!(to_im_message(m).is_none());
    }

    #[test]
    fn render_message_block_includes_msg_type_for_non_text() {
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
            text: "see attached".into(),
            external_url: None,
            deleted: false,
            raw: json!({ "msg_type": "post" }),
        };
        let rendered = LarkBackend.render_message_block(&conv, &msg);
        assert!(rendered.contains("· post"));
        assert!(rendered.contains("```\nsee attached\n```"));
    }

    #[test]
    fn render_message_block_omits_msg_type_for_plain_text() {
        let conv = ImConversation {
            id: "oc_x".into(),
            label: None,
            kind: ImConversationKind::Channel,
            raw: json!({}),
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
        let rendered = LarkBackend.render_message_block(&conv, &msg);
        assert!(!rendered.contains("· text"));
    }
}
