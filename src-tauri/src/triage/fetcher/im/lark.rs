//! Lark ImBackend.
//!
//! Discovery rules (matching user intent):
//!   - DMs (p2p): surfaced as soon as ANY message lands in them within
//!     the lookback window — we don't gate on whether the user replied.
//!   - Groups: only those the user has spoken in OR been @ed in. A
//!     large room the user is a passive member of doesn't earn a slot.
//!
//! Implementation note on DMs: Lark's `chat-list` API only lists
//! GROUPS — there's no equivalent of Slack's `users.conversations`
//! that returns DMs alongside groups. To discover active DMs we run a
//! separate `messages-search --chat-type p2p` (Lark's default behavior
//! omits p2p; the filter has to be explicit) and treat each distinct
//! `chat_id` as one DM ImConversation. This matches the "active in the
//! last COLD_START_DAYS" semantics naturally.
//!
//! Pipeline:
//!   1. `messages-search(sender=me, start=cold_start)` +
//!      `messages-search(is_at_me=true, start=cold_start)` → derive
//!      the "I'm involved here" GROUP set.
//!   2. `messages-search(chat_type=p2p, start=cold_start)` → derive
//!      the "active DM" set, plus the counterpart's display name from
//!      the message sender.
//!   3. `chat-list --sort-type ByActiveTimeDesc --exclude-muted` →
//!      enumerate every GROUP the user is in. Filter to involved set.
//!   4. Merge: groups (from chat-list) + DMs (from p2p search).

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
            let start = (Utc::now() - Duration::days(super::COLD_START_DAYS))
                .to_rfc3339_opts(SecondsFormat::Secs, true);

            // (1) Build the "I'm involved" GROUP set: chats where I
            // sent something OR someone @ed me, within the window.
            let mut involved_groups: BTreeSet<String> = BTreeSet::new();
            let sent = lark::im::messages_search(lark::im::MessagesSearch {
                query: None,
                sender: Some(my_open_id.as_str()),
                chat_id: None,
                chat_type: None,
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
                chat_type: None,
                is_at_me: true,
                start: Some(start.as_str()),
                end: None,
                page_size: DISCOVERY_PAGE_SIZE,
            })
            .await
            .context("messages-search is_at_me")?;
            collect_chat_ids(&mentions, &mut involved_groups);

            // (2) Discover active DMs. Lark's chat-list does NOT
            // include p2p chats; messages-search with chat_type=p2p is
            // the only way to enumerate DMs that had any activity in
            // the window.
            let p2p = lark::im::messages_search(lark::im::MessagesSearch {
                query: None,
                sender: None,
                chat_id: None,
                chat_type: Some("p2p"),
                is_at_me: false,
                start: Some(start.as_str()),
                end: None,
                page_size: DISCOVERY_PAGE_SIZE,
            })
            .await
            .context("messages-search chat_type=p2p")?;
            let dm_convs = build_dm_conversations(&p2p, &my_open_id);

            // (3) Enumerate every group the user is in.
            let raw_chats = lark::im::chat_list(lark::im::ChatList {
                sort_type: "ByActiveTimeDesc",
                exclude_muted: true,
                page_size: CHAT_LIST_PAGE_SIZE,
            })
            .await
            .context("chat-list")?;

            // (4) Filter groups to the "involved" set and merge with
            // the DM list. DMs go first so they survive the per-tick
            // truncate in the generic layer.
            let group_convs: Vec<ImConversation> = parse_chat_list(&raw_chats)
                .into_iter()
                .filter(|c| involved_groups.contains(&c.chat_id))
                .map(to_im_conversation)
                .collect();
            let mut out = dm_convs;
            out.extend(group_convs);
            Ok(out)
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

/// Walk a p2p `messages-search` response, group by `chat_id`, and build
/// one `ImConversation` per DM. Label is the counterpart's display name
/// (the sender of the first message NOT sent by me); falls back to a
/// generic `"DM"` if all messages in the page are mine or unnamed.
fn build_dm_conversations(raw: &Value, my_open_id: &str) -> Vec<ImConversation> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out: Vec<ImConversation> = Vec::new();
    for m in parse_messages(raw) {
        let Some(chat_id) = m.chat_id.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        if !seen.insert(chat_id.to_string()) {
            // Already emitted; try to upgrade label if previous one was
            // a self-message and this one is from the counterpart.
            if let Some(existing) = out.iter_mut().find(|c| c.id == chat_id) {
                if existing.label.is_none() {
                    if let Some(label) = label_from_sender(m.sender.as_ref(), my_open_id) {
                        existing.label = Some(label);
                    }
                }
            }
            continue;
        }
        let label = label_from_sender(m.sender.as_ref(), my_open_id);
        out.push(ImConversation {
            id: chat_id.to_string(),
            label,
            kind: ImConversationKind::Dm,
            raw: json!({ "discovered_from": "messages_search_p2p" }),
        });
    }
    out
}

fn label_from_sender(sender: Option<&SenderRecord>, my_open_id: &str) -> Option<String> {
    let s = sender?;
    if s.id.as_deref() == Some(my_open_id) {
        return None;
    }
    s.name.clone().filter(|n| !n.is_empty())
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
    // Lark's `chat-list` only returns groups (p2p DMs are discovered
    // separately via messages-search). It also doesn't distinguish
    // public/private inside the group bucket, so everything maps to
    // Channel.
    ImConversation {
        id: row.chat_id,
        label: row.name,
        kind: ImConversationKind::Channel,
        raw: Value::Null,
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
/// captured. Lark's `chat-list` response doesn't include a chat_mode
/// field — and only returns groups anyway, so we don't need one.
#[derive(Debug, Clone, Default, Deserialize)]
struct ChatRow {
    #[serde(default)]
    chat_id: String,
    #[serde(default)]
    name: Option<String>,
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
    fn parse_chat_list_maps_all_rows_to_channel() {
        // Lark's chat-list only returns groups (no DMs), and doesn't
        // include a chat_mode field at all. Every row is a Channel.
        let raw = json!({
            "data": {
                "items": [
                    { "chat_id": "oc_a", "name": "eng" },
                    { "chat_id": "oc_b", "name": "leads" },
                ]
            }
        });
        let rows = parse_chat_list(&raw);
        assert_eq!(rows.len(), 2);
        let convs: Vec<_> = rows.into_iter().map(to_im_conversation).collect();
        assert_eq!(convs[0].kind, ImConversationKind::Channel);
        assert_eq!(convs[1].kind, ImConversationKind::Channel);
    }

    #[test]
    fn build_dm_conversations_labels_with_counterpart_name() {
        // A p2p search returns messages from both sides of each DM.
        // The label should be the counterpart's name, not "me", and
        // each chat_id should produce exactly one ImConversation.
        let raw = json!({
            "data": {
                "messages": [
                    // Me writing to Alice (label should NOT be "me").
                    { "message_id": "om_1", "chat_id": "oc_alice",
                      "sender": { "id": "ou_me", "name": "me" } },
                    // Alice replies — label upgrades to "Alice".
                    { "message_id": "om_2", "chat_id": "oc_alice",
                      "sender": { "id": "ou_alice", "name": "Alice" } },
                    // A separate DM with Bob, only his message.
                    { "message_id": "om_3", "chat_id": "oc_bob",
                      "sender": { "id": "ou_bob", "name": "Bob" } },
                ]
            }
        });
        let convs = build_dm_conversations(&raw, "ou_me");
        assert_eq!(convs.len(), 2);
        let alice = convs.iter().find(|c| c.id == "oc_alice").unwrap();
        assert_eq!(alice.kind, ImConversationKind::Dm);
        assert_eq!(alice.label.as_deref(), Some("Alice"));
        let bob = convs.iter().find(|c| c.id == "oc_bob").unwrap();
        assert_eq!(bob.label.as_deref(), Some("Bob"));
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
