//! Lark ImBackend. Discovery: DMs surface on any activity; groups only when the
//! user posted or was @ed. Lark's `chat-list` doesn't return DMs, so DMs are
//! derived from `messages-search --chat-type p2p`. Pipeline:
//! messages-search(sender=me, is_at_me) → involved groups;
//! messages-search(p2p) → DMs; chat-list → group enumeration; merge.

use std::collections::BTreeSet;

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, SecondsFormat, TimeZone, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::lark;
use crate::triage::attachments;

use super::types::{ImAttachment, ImConversation, ImConversationKind, ImMessage};
use super::ImBackend;

const SOURCE: &str = "lark";
/// Lark API max.
const DISCOVERY_PAGE_SIZE: u32 = 50;
/// Lark API max.
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

            // (1) Build the "I'm involved" GROUP set: person-centric — ONLY
            // chats where someone @-mentioned me within the window. A group
            // where I merely posted (sender=me) is not, by itself, my task,
            // so it no longer surfaces (mirrors the Slack from:me drop).
            let mut involved_groups: BTreeSet<String> = BTreeSet::new();
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

            // (2) Active DMs via messages-search(p2p).
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

            // (4) Filter groups to involved set; DMs first to survive truncation.
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
        let rt = super::super::http_runtime();
        let raw = rt.block_on(lark::im::chat_messages_list(lark::im::ChatMessages {
            chat_id,
            page_size: limit.min(u32::MAX as usize) as u32,
            start: start.as_deref(),
        }))?;
        let messages: Vec<ImMessage> = parse_messages(&raw)
            .into_iter()
            .filter_map(to_im_message)
            .collect();
        // Best-effort: download referenced image attachments per message.
        // candidate_id == chat_id (one chat → one triage candidate).
        let mut out = Vec::with_capacity(messages.len());
        for mut msg in messages {
            if !msg.attachments.is_empty() {
                rt.block_on(download_attachments(&mut msg, chat_id));
            }
            out.push(msg);
        }
        Ok(out)
    }

    fn render_message_block(&self, _conv: &ImConversation, msg: &ImMessage) -> String {
        // Surface `msg_type` in heading for non-text bubbles.
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

/// Distinct chat_ids from a messages-search response.
fn collect_chat_ids(raw: &Value, sink: &mut BTreeSet<String>) {
    for m in parse_messages(raw) {
        if let Some(id) = m.chat_id.filter(|s| !s.is_empty()) {
            sink.insert(id);
        }
    }
}

/// Group p2p messages by `chat_id` → one ImConversation per DM. Label = counterpart's display name.
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
    // chat-list returns groups only; no public/private distinction → Channel.
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
    let attachments = extract_attachment_placeholders(&text);
    let raw = json!({ "msg_type": m.msg_type });
    Some(ImMessage {
        id,
        timestamp,
        sender,
        text,
        external_url: m.message_app_link,
        deleted: false,
        attachments,
        raw,
    })
}

/// Walk lark-cli's `[Image: <key>]` placeholders out of a message body.
/// Produces empty-path placeholders that `download_attachments` fills.
fn extract_attachment_placeholders(text: &str) -> Vec<ImAttachment> {
    let mut out = Vec::new();
    let mut cursor = text;
    while let Some(start) = cursor.find("[Image:") {
        cursor = &cursor[start + "[Image:".len()..];
        let body = cursor.trim_start();
        let Some(end) = body.find(']') else { break };
        let key = body[..end].trim();
        if !key.is_empty() {
            out.push(ImAttachment {
                filename: format!("{key}.bin"),
                local_path: std::path::PathBuf::new(),
                mime_type: None,
                bytes: 0,
                alt: Some(key.to_string()),
            });
        }
        cursor = &body[end + 1..];
    }
    out
}

/// Download each placeholder via lark-cli; fills `local_path` / `bytes` /
/// `mime_type` / refined `filename` (extension from magic bytes). Drops
/// entries that fail to download.
async fn download_attachments(msg: &mut ImMessage, chat_id: &str) {
    let Ok(staging) = attachments::staging_dir("lark", chat_id) else {
        msg.attachments.clear();
        return;
    };
    let mut kept = Vec::with_capacity(msg.attachments.len());
    for mut att in std::mem::take(&mut msg.attachments) {
        let Some(key) = att.alt.clone() else { continue };
        // Skip re-download when this key is already staged from a prior
        // tick (filename = `<key>.<ext>`, set by the rename below).
        if let Some((existing_path, bytes)) =
            attachments::find_staged_by_stem("lark", chat_id, &key)
        {
            let mime = sniff_image_mime(&existing_path);
            att.filename = existing_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(str::to_string)
                .unwrap_or(att.filename);
            att.local_path = existing_path;
            att.mime_type = mime.map(str::to_string);
            att.bytes = bytes;
            kept.push(att);
            continue;
        }
        let initial_name = att.filename.clone();
        if let Err(e) =
            lark::im::download_resource(&msg.id, "image", &key, &staging, &initial_name).await
        {
            tracing::warn!(
                error = %e,
                message_id = %msg.id,
                key = %key,
                "lark: download_resource failed"
            );
            continue;
        }
        let raw_path = staging.join(&initial_name);
        let Ok(meta) = std::fs::metadata(&raw_path) else {
            continue;
        };
        if meta.len() == 0 {
            let _ = std::fs::remove_file(&raw_path);
            continue;
        }
        // Sniff MIME and rename to the right extension if needed.
        let mime = sniff_image_mime(&raw_path);
        let final_name = match mime {
            Some(m) => format!("{key}{}", ext_for_mime(m)),
            None => initial_name.clone(),
        };
        let final_path = staging.join(&final_name);
        if final_path != raw_path {
            let _ = std::fs::rename(&raw_path, &final_path);
        }
        att.filename = final_name;
        att.local_path = final_path;
        att.mime_type = mime.map(str::to_string);
        att.bytes = meta.len();
        kept.push(att);
    }
    msg.attachments = kept;
}

fn sniff_image_mime(path: &std::path::Path) -> Option<&'static str> {
    let mut buf = [0u8; 12];
    let n = std::fs::File::open(path)
        .ok()
        .and_then(|mut f| std::io::Read::read(&mut f, &mut buf).ok())?;
    let head = &buf[..n];
    if head.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else if head.starts_with(&[0x42, 0x4D]) {
        Some("image/bmp")
    } else {
        None
    }
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/bmp" => ".bmp",
        _ => ".bin",
    }
}

fn parse_create_time(raw: Option<&str>) -> Option<DateTime<Utc>> {
    let s = raw?;
    let ms: i64 = s.parse().ok()?;
    Utc.timestamp_millis_opt(ms).single()
}

/// Subset of chat-list row fields we consume.
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
            attachments: Vec::new(),
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
            attachments: Vec::new(),
            raw: json!({ "msg_type": "text" }),
        };
        let rendered = LarkBackend.render_message_block(&conv, &msg);
        assert!(!rendered.contains("· text"));
    }

    #[test]
    fn extract_attachment_placeholders_handles_multiple_images() {
        let text = "see this [Image: img_v3_aaa] and that [Image: img_v3_bbb] please";
        let atts = extract_attachment_placeholders(text);
        assert_eq!(atts.len(), 2);
        assert_eq!(atts[0].alt.as_deref(), Some("img_v3_aaa"));
        assert_eq!(atts[1].alt.as_deref(), Some("img_v3_bbb"));
        assert_eq!(atts[0].filename, "img_v3_aaa.bin");
    }

    #[test]
    fn extract_attachment_placeholders_skips_unclosed() {
        let text = "broken [Image: img_v3_xxx";
        let atts = extract_attachment_placeholders(text);
        assert!(atts.is_empty());
    }
}
