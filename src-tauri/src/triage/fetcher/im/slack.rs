//! Slack ImBackend. DMs/MPIMs unconditional; channels where the user was
//! @ed or posted within `COLD_START_DAYS`.
//!
//! Channels are **surface-aware**: instead of discarding the search hits and
//! re-fetching the channel timeline (which omits thread replies — the bug
//! this replaces), we keep the hits, expand the exact @-ed thread via
//! `conversations.replies`, and always surface the mention message. The DM
//! path is unchanged (a plain `conversations.history` window).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::json;

use crate::models::slack_workspaces;
use crate::slack::api::{self, ConversationRow, RawFile, RawMessage};
use crate::slack::credentials::{self, SlackCreds};
use crate::slack::files as slack_files;
use crate::slack::relevance::{self, MentionHit};
use crate::slack::types::SlackWorkspace;
use crate::triage::attachments;

use super::types::{ImAttachment, ImConversation, ImConversationKind, ImMessage};
use super::{
    default_message_block, default_trim_window, render_chat_payload, ImBackend, WINDOW_DAYS,
    WINDOW_MAX_BYTES, WINDOW_MAX_MESSAGES,
};

const SOURCE: &str = "slack";

/// Per-tick discovery output for one involved channel. Populated by
/// `discover_conversations`, consumed by `fetch_messages` / `render_payload` /
/// `trim_window` within the SAME tick (same `&self`).
#[derive(Default, Clone)]
struct ChannelHits {
    /// `thread_ts` values to expand fully via `conversations.replies`.
    thread_seeds: BTreeSet<String>,
    /// The matched hits — used to force-inject a mention the replies page
    /// truncated away (or an inaccessible channel), and to mark anchors.
    hits: Vec<MentionHit>,
}

/// Slack triage backend. Holds the current tick's per-channel discovery hits
/// so the channel fetch/render/trim path can expand the right threads and
/// protect the mention. `Mutex` (not `RefCell`) because `ImBackend: Send+Sync`.
#[derive(Default)]
pub struct SlackBackend {
    hits: Mutex<HashMap<String, ChannelHits>>,
}

impl SlackBackend {
    /// Mention anchors for a channel = `is_mention` hit ts that are actually
    /// present in `messages` (so every anchor is a real `ImMessage.id`).
    fn channel_anchors(&self, conv_id: &str, messages: &[ImMessage]) -> Vec<String> {
        let present: BTreeSet<&str> = messages.iter().map(|m| m.id.as_str()).collect();
        let map = self.hits.lock().expect("slack hits poisoned");
        let Some(ch) = map.get(conv_id) else {
            return Vec::new();
        };
        let mut anchors: Vec<String> = ch
            .hits
            .iter()
            .filter(|h| h.is_mention && present.contains(h.ts.as_str()))
            .map(|h| h.ts.clone())
            .collect();
        anchors.sort();
        anchors.dedup();
        anchors
    }

    /// Protected ts = mention anchors ∪ every message belonging to a seeded
    /// thread, so the whole @-ed thread survives trimming even if older than
    /// the time floor.
    fn channel_protected(&self, conv_id: &str, messages: &[ImMessage]) -> BTreeSet<String> {
        let map = self.hits.lock().expect("slack hits poisoned");
        let Some(ch) = map.get(conv_id) else {
            return BTreeSet::new();
        };
        let mut protected: BTreeSet<String> = ch
            .hits
            .iter()
            .filter(|h| h.is_mention)
            .map(|h| h.ts.clone())
            .collect();
        for m in messages {
            let in_seeded_thread = message_thread_ts(m)
                .map(|t| ch.thread_seeds.contains(&t))
                .unwrap_or(false)
                || ch.thread_seeds.contains(&m.id);
            if in_seeded_thread {
                protected.insert(m.id.clone());
            }
        }
        protected
    }
}

impl ImBackend for SlackBackend {
    fn source(&self) -> &'static str {
        SOURCE
    }

    fn preflight(&self) -> Result<()> {
        let workspaces = slack_workspaces::list_workspaces().context("list slack workspaces")?;
        if workspaces.is_empty() {
            anyhow::bail!("no Slack workspace connected");
        }
        Ok(())
    }

    fn discover_conversations(&self, _limit: usize) -> Result<Vec<ImConversation>> {
        let workspaces = slack_workspaces::list_workspaces()?;
        let mut out: Vec<ImConversation> = Vec::new();
        self.hits.lock().expect("slack hits poisoned").clear();
        for ws in &workspaces {
            let creds = match credentials::load_credentials(&ws.team_id)? {
                Some(c) => c,
                None => continue,
            };

            // Which channels mentioned me / I posted in, WITH the messages.
            // Auth failure → skip this workspace; transient → degraded.
            let involved = match relevance::involved_channel_hits(
                &creds,
                &ws.my_user_id,
                super::COLD_START_DAYS,
            ) {
                Ok(outcome) => outcome,
                Err(error) => {
                    tracing::warn!(
                        team_id = %ws.team_id,
                        error = %format!("{error:#}"),
                        "slack backend: auth failure, skipping workspace",
                    );
                    crate::triage::fetcher::health::record_degraded(
                        SOURCE,
                        format!("auth failure: {error:#}"),
                    );
                    continue;
                }
            };
            if let Some(reason) = &involved.degraded {
                tracing::warn!(
                    team_id = %ws.team_id,
                    reason = %reason,
                    "slack backend: channel discovery degraded",
                );
                crate::triage::fetcher::health::record_degraded(SOURCE, reason.clone());
            }

            // Group hits by channel id. Person-centric: only a real `<@me>`
            // mention seeds a thread to expand — a `from:me` post (I spoke,
            // nobody asked me) is kept as context but never drives surfacing.
            let mut by_channel: BTreeMap<String, ChannelHits> = BTreeMap::new();
            for hit in involved.value {
                let entry = by_channel.entry(hit.channel_id.clone()).or_default();
                if hit.is_mention {
                    if let Some(t) = &hit.thread_ts {
                        entry.thread_seeds.insert(t.clone());
                    }
                }
                entry.hits.push(hit);
            }

            // A conversation surfaces ONLY if it actually @-mentions me. This
            // drops from:me-only channels and group chatter where I'm merely
            // present — the root of "lots of Slack that isn't mine".
            let mentioned: std::collections::HashSet<String> = by_channel
                .iter()
                .filter(|(_, ch)| ch.hits.iter().any(|h| h.is_mention))
                .map(|(id, _)| id.clone())
                .collect();

            // Every conversation I'm a member of (DMs/MPIMs + channels). A
            // transient failure surfaces as degraded health; auth → skip ws.
            let members = match relevance::member_conversations(
                &creds,
                "im,mpim,public_channel,private_channel",
                500,
            ) {
                Ok(outcome) => outcome,
                Err(error) => {
                    tracing::warn!(
                        team_id = %ws.team_id,
                        error = %format!("{error:#}"),
                        "slack backend: auth failure, skipping workspace",
                    );
                    crate::triage::fetcher::health::record_degraded(
                        SOURCE,
                        format!("auth failure: {error:#}"),
                    );
                    continue;
                }
            };
            if let Some(reason) = &members.degraded {
                tracing::warn!(
                    team_id = %ws.team_id,
                    reason = %reason,
                    "slack backend: conversation listing degraded",
                );
                crate::triage::fetcher::health::record_degraded(SOURCE, reason.clone());
            }

            let member_by_id: HashMap<&str, &ConversationRow> =
                members.value.iter().map(|c| (c.id.as_str(), c)).collect();

            // 1:1 DMs are inherently directed at me → always surface.
            // Group-DMs (MPIM) only when they actually @-mention me — an MPIM
            // I'm simply a member of is not, by itself, my task.
            for row in &members.value {
                if row.is_im || (row.is_mpim && mentioned.contains(&row.id)) {
                    out.push(to_im_conversation(ws, row));
                }
            }

            // Involved channels (incl. ones I'm not a member of — Q1). Store
            // the hits keyed by conv.id for the surface-aware fetch/render/trim.
            let mut map = self.hits.lock().expect("slack hits poisoned");
            for (channel_id, ch_hits) in by_channel {
                // Person-centric: only channels that actually @-mention me.
                // (from:me-only channels were filtered out of `mentioned`.)
                if !mentioned.contains(&channel_id) {
                    continue;
                }
                // A `<@me>` in a DM shows up here too — already covered above.
                if let Some(row) = member_by_id.get(channel_id.as_str()) {
                    if row.is_im || row.is_mpim {
                        continue;
                    }
                }
                let conv = match member_by_id.get(channel_id.as_str()) {
                    Some(row) => to_im_conversation(ws, row),
                    None => synthesize_channel_conv(ws, &channel_id, &creds),
                };
                map.insert(conv.id.clone(), ch_hits);
                out.push(conv);
            }
        }
        Ok(out)
    }

    fn fetch_messages(
        &self,
        conv: &ImConversation,
        since: Option<DateTime<Utc>>,
        limit: usize,
    ) -> Result<Vec<ImMessage>> {
        let ConvHandle { team_id, .. } = parse_handle(conv);
        let creds = match credentials::load_credentials(team_id)? {
            Some(c) => c,
            None => return Ok(Vec::new()),
        };
        let channel_id = parse_channel_id(&conv.id);
        let mut messages = fetch_history(&creds, team_id, channel_id, &conv.id, since, limit)?;

        // DM / group-DM: the history window is the whole story.
        if matches!(
            conv.kind,
            ImConversationKind::Dm | ImConversationKind::GroupDm
        ) {
            return Ok(messages);
        }

        // Channel: expand each @-ed thread fully, then guarantee the mention.
        let ch_hits = self
            .hits
            .lock()
            .expect("slack hits poisoned")
            .get(&conv.id)
            .cloned()
            .unwrap_or_default();
        let mut seen: BTreeSet<String> = messages.iter().map(|m| m.id.clone()).collect();
        for thread_ts in &ch_hits.thread_seeds {
            match api::conversations_replies(&creds, channel_id, thread_ts) {
                Ok(raws) => {
                    for raw in raws {
                        if raw.ts.is_empty() || !seen.insert(raw.ts.clone()) {
                            continue;
                        }
                        if let Some(mut m) = to_im_message(team_id, &creds, &raw) {
                            m.attachments = download_image_attachments(&conv.id, &raw);
                            messages.push(m);
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        conv_id = %conv.id,
                        error = %format!("{error:#}"),
                        "slack backend: thread replies fetch failed",
                    );
                    crate::triage::fetcher::health::record_degraded(
                        SOURCE,
                        format!("thread replies failed: {error:#}"),
                    );
                }
            }
        }
        // Force-inject any mention the replies page truncated away or that
        // lives in an inaccessible channel — guarantees the mention is present.
        let mut forced = 0usize;
        for hit in &ch_hits.hits {
            if hit.is_mention && seen.insert(hit.ts.clone()) {
                messages.push(force_inject_message(hit));
                forced += 1;
            }
        }
        tracing::info!(
            conv_id = %conv.id,
            threads_expanded = ch_hits.thread_seeds.len(),
            mentions = ch_hits.hits.iter().filter(|h| h.is_mention).count(),
            force_injected = forced,
            messages = messages.len(),
            "slack triage: channel indexed",
        );
        Ok(messages)
    }

    fn render_payload(
        &self,
        conv: &ImConversation,
        messages: &[ImMessage],
        proposed_anchors: &[String],
    ) -> String {
        if matches!(
            conv.kind,
            ImConversationKind::Dm | ImConversationKind::GroupDm
        ) {
            return render_chat_payload(self, conv, messages, proposed_anchors);
        }
        let anchors = self.channel_anchors(&conv.id, messages);
        build_channel_payload(conv, messages, &anchors, proposed_anchors)
    }

    fn trim_window(&self, conv: &ImConversation, messages: &mut Vec<ImMessage>) {
        if matches!(
            conv.kind,
            ImConversationKind::Dm | ImConversationKind::GroupDm
        ) {
            default_trim_window(messages, self, conv);
            return;
        }
        let protected = self.channel_protected(&conv.id, messages);
        protected_trim(messages, self, conv, &protected);
    }
}

/// `conversations.history` window → resolved [`ImMessage`]s with attachments.
/// Shared by the DM path and the channel base window.
fn fetch_history(
    creds: &SlackCreds,
    team_id: &str,
    channel_id: &str,
    conv_id: &str,
    since: Option<DateTime<Utc>>,
    limit: usize,
) -> Result<Vec<ImMessage>> {
    let oldest = since.map(|dt| format!("{}.000000", dt.timestamp()));
    let raws = api::conversations_history(
        creds,
        channel_id,
        oldest.as_deref(),
        limit.min(u32::MAX as usize) as u32,
    )
    .with_context(|| format!("slack conversations.history {channel_id}"))?;
    let mut messages = Vec::with_capacity(raws.len());
    for raw in raws {
        if let Some(mut m) = to_im_message(team_id, creds, &raw) {
            m.attachments = download_image_attachments(conv_id, &raw);
            messages.push(m);
        }
    }
    Ok(messages)
}

/// Minimal [`ImMessage`] built from a retained search hit, for when a thread
/// truncated the mention past the replies page or the channel is inaccessible.
fn force_inject_message(hit: &MentionHit) -> ImMessage {
    let timestamp = ts_string_to_utc(&hit.ts).unwrap_or_else(Utc::now);
    ImMessage {
        id: hit.ts.clone(),
        timestamp,
        sender: None,
        text: hit.text.clone(),
        external_url: None,
        deleted: false,
        attachments: Vec::new(),
        raw: json!({ "thread_ts": hit.thread_ts }),
    }
}

/// Read the `thread_ts` stashed on an [`ImMessage`] by [`to_im_message`].
fn message_thread_ts(m: &ImMessage) -> Option<String> {
    m.raw
        .get("thread_ts")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Non-member channel (e.g. @-ed then removed, or a public channel not
/// joined). Best-effort name resolution; defaults to a public-channel kind.
fn synthesize_channel_conv(
    ws: &SlackWorkspace,
    channel_id: &str,
    creds: &SlackCreds,
) -> ImConversation {
    let label = api::conversations_info(creds, channel_id)
        .ok()
        .unwrap_or_else(|| format!("#{channel_id}"));
    ImConversation {
        id: format!("{}:{}", ws.team_id, channel_id),
        label: Some(label),
        kind: ImConversationKind::Channel,
        raw: json!({ "team_id": ws.team_id, "channel_id": channel_id }),
    }
}

/// Pure channel payload: the flat chat stream (per-message blocks stay
/// byte-compatible with [`default_message_block`] so the reload parser still
/// recovers them) + a `your_mentions` header + a parser-ignored `- ↳ mention`
/// marker on each anchor. No `## ` banners — the `read_candidate` `tail`
/// consumer splits on `\n## ` and would miscount them.
fn build_channel_payload(
    conv: &ImConversation,
    messages: &[ImMessage],
    your_mentions: &[String],
    proposed_anchors: &[String],
) -> String {
    let mut out = String::new();
    let label = conv.label.as_deref().unwrap_or(&conv.id);
    out.push_str(&format!("# slack chat — {label}\n\n"));
    out.push_str(&format!("- conversation_id: {}\n", conv.id));
    out.push_str(&format!("- kind: {}\n", conv.kind.as_source_kind()));
    out.push_str(&format!(
        "- window: last {WINDOW_DAYS} days, {} messages\n",
        messages.len()
    ));
    if !your_mentions.is_empty() {
        out.push_str(&format!(
            "- your_mentions: {}  (messages that @-mention you — anchor a task on one)\n",
            your_mentions.join(", ")
        ));
    }
    if !proposed_anchors.is_empty() {
        out.push_str("- last_proposed_anchors: ");
        out.push_str(&proposed_anchors.join(", "));
        out.push('\n');
        out.push_str("  (the LLM has already created workspaces for these anchors — skip them)\n");
    }
    out.push_str("\n---\n\n");
    let mention_set: BTreeSet<&str> = your_mentions.iter().map(String::as_str).collect();
    for m in messages {
        let block = default_message_block(conv, m);
        if mention_set.contains(m.id.as_str()) {
            // Inject the marker after the `## …` header line; the parser skips
            // the bulleted-meta region, so the block stays round-trippable.
            match block.split_once('\n') {
                Some((head, rest)) => {
                    out.push_str(head);
                    out.push_str("\n- ↳ mention\n");
                    out.push_str(rest);
                }
                None => out.push_str(&block),
            }
        } else {
            out.push_str(&block);
        }
        for att in &m.attachments {
            let alt = att.alt.as_deref().unwrap_or(&att.filename);
            let mime = att
                .mime_type
                .as_deref()
                .unwrap_or("application/octet-stream");
            out.push_str(&format!(
                "📎 attachment: {alt} ({mime}, {} bytes) — {}\n",
                att.bytes,
                att.local_path.display(),
            ));
        }
        out.push('\n');
    }
    out
}

/// Like the default trim but never evicts a protected message (a mention or a
/// message in an @-ed thread), even when older than the time floor.
fn protected_trim<B: ImBackend + ?Sized>(
    messages: &mut Vec<ImMessage>,
    backend: &B,
    conv: &ImConversation,
    protected: &BTreeSet<String>,
) {
    let cutoff = Utc::now() - Duration::days(WINDOW_DAYS);
    messages.retain(|m| protected.contains(&m.id) || m.timestamp >= cutoff);
    while messages.len() > WINDOW_MAX_MESSAGES {
        match messages.iter().position(|m| !protected.contains(&m.id)) {
            Some(pos) => {
                messages.remove(pos);
            }
            None => break,
        }
    }
    loop {
        let bytes: usize = messages
            .iter()
            .map(|m| backend.render_message_block(conv, m).len() + 1)
            .sum();
        if bytes <= WINDOW_MAX_BYTES {
            break;
        }
        match messages.iter().position(|m| !protected.contains(&m.id)) {
            Some(pos) => {
                messages.remove(pos);
            }
            None => break,
        }
    }
}

/// Pull image attachments off the message and stage them under the
/// triage attachment dir. Non-image files are ignored (priming markdown
/// can still mention them via the inline text body).
fn download_image_attachments(candidate_id: &str, raw: &RawMessage) -> Vec<ImAttachment> {
    if raw.files.is_empty() {
        return Vec::new();
    }
    let Ok(staging) = attachments::staging_dir(SOURCE, candidate_id) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for file in &raw.files {
        let Some(url) = file.url_private.as_deref() else {
            continue;
        };
        let mime = file.mimetype.as_deref().unwrap_or("");
        if !mime.starts_with("image/") {
            continue;
        }
        let cache_path = match slack_files::resolve_to_path(url) {
            Ok(p) => p,
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    file_id = %file.id,
                    "slack: resolve_to_path failed",
                );
                continue;
            }
        };
        if let Some(att) = stage_one(&staging, &cache_path, file, mime) {
            out.push(att);
        }
    }
    out
}

fn stage_one(
    staging: &std::path::Path,
    cache_path: &std::path::Path,
    file: &RawFile,
    mime: &str,
) -> Option<ImAttachment> {
    let ext = cache_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let filename = format!("{}.{}", file.id, ext);
    let dest = staging.join(&filename);
    if let Err(error) = std::fs::copy(cache_path, &dest) {
        tracing::warn!(error = %error, file_id = %file.id, "slack: copy to staging failed");
        return None;
    }
    let bytes = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    if bytes == 0 {
        let _ = std::fs::remove_file(&dest);
        return None;
    }
    Some(ImAttachment {
        filename,
        local_path: dest,
        mime_type: Some(mime.to_string()),
        bytes,
        alt: file.title.clone().or_else(|| file.name.clone()),
    })
}

/// `ImConversation.id = <team_id>:<channel_id>`.
struct ConvHandle<'a> {
    team_id: &'a str,
    #[allow(dead_code)]
    channel_id: &'a str,
}

fn parse_handle(conv: &ImConversation) -> ConvHandle<'_> {
    let (team, channel) = conv
        .id
        .split_once(':')
        .unwrap_or((conv.id.as_str(), conv.id.as_str()));
    ConvHandle {
        team_id: team,
        channel_id: channel,
    }
}

fn parse_channel_id(conv_id: &str) -> &str {
    conv_id.split_once(':').map(|(_, c)| c).unwrap_or(conv_id)
}

fn to_im_conversation(ws: &SlackWorkspace, row: &ConversationRow) -> ImConversation {
    let kind = if row.is_im {
        ImConversationKind::Dm
    } else if row.is_mpim {
        ImConversationKind::GroupDm
    } else if row.is_private {
        ImConversationKind::PrivateChannel
    } else {
        ImConversationKind::Channel
    };
    let label = row.name.clone().map(|n| match kind {
        ImConversationKind::Dm | ImConversationKind::GroupDm => format!("DM · {n}"),
        _ => format!("#{n}"),
    });
    ImConversation {
        id: format!("{}:{}", ws.team_id, row.id),
        label,
        kind,
        raw: json!({
            "team_id": ws.team_id,
            "channel_id": row.id,
            "unread_count_display": row.unread_count_display,
        }),
    }
}

fn to_im_message(team_id: &str, creds: &SlackCreds, raw: &RawMessage) -> Option<ImMessage> {
    if raw.ts.is_empty() {
        return None;
    }
    let body = api::extract_display_text(raw);
    let text = api::resolve_mentions(team_id, creds, &body);
    let sender = raw
        .user_id
        .as_deref()
        .and_then(|uid| api::users_info(team_id, creds, uid).ok())
        .map(|u| u.display_name)
        .or_else(|| raw.username_fallback.clone());
    let timestamp = ts_string_to_utc(&raw.ts).unwrap_or_else(Utc::now);
    // RawMessage isn't Serialize — hand-build.
    let raw_blob = json!({
        "thread_ts": raw.thread_ts,
        "files": raw.files.len(),
        "has_reactions": !raw.reactions.is_empty(),
    });
    Some(ImMessage {
        id: raw.ts.clone(),
        timestamp,
        sender,
        text,
        external_url: raw.permalink.clone(),
        deleted: false,
        attachments: Vec::new(), // filled later by fetch_messages override
        raw: raw_blob,
    })
}

fn ts_string_to_utc(ts: &str) -> Option<DateTime<Utc>> {
    let secs_f: f64 = ts.parse().ok()?;
    let secs = secs_f as i64;
    let nanos = ((secs_f - secs as f64) * 1_000_000_000f64) as u32;
    Utc.timestamp_opt(secs, nanos).single()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> SlackWorkspace {
        SlackWorkspace {
            team_id: "T0".into(),
            team_name: "test".into(),
            team_domain: "test".into(),
            my_user_id: "U_me".into(),
            added_at: 0,
        }
    }

    fn row(
        id: &str,
        name: &str,
        is_im: bool,
        is_mpim: bool,
        is_private: bool,
        unread: u32,
    ) -> ConversationRow {
        ConversationRow {
            id: id.into(),
            name: Some(name.into()),
            is_im,
            is_mpim,
            is_channel: !is_im && !is_mpim,
            is_private,
            user: None,
            unread_count_display: unread,
            last_read: None,
        }
    }

    fn msg(id: &str, ts_offset: i64, text: &str, thread_ts: Option<&str>) -> ImMessage {
        ImMessage {
            id: id.into(),
            timestamp: Utc.with_ymd_and_hms(2026, 5, 26, 10, 0, 0).unwrap()
                + Duration::seconds(ts_offset),
            sender: Some("Alice".into()),
            text: text.into(),
            external_url: None,
            deleted: false,
            attachments: Vec::new(),
            raw: json!({ "thread_ts": thread_ts }),
        }
    }

    fn channel_conv() -> ImConversation {
        ImConversation {
            id: "T0:C1".into(),
            label: Some("#eng".into()),
            kind: ImConversationKind::Channel,
            raw: json!({}),
        }
    }

    #[test]
    fn maps_dm_to_kind_dm_with_label() {
        let conv = to_im_conversation(&ws(), &row("D1", "alice", true, false, false, 0));
        assert_eq!(conv.kind, ImConversationKind::Dm);
        assert_eq!(conv.label.as_deref(), Some("DM · alice"));
        assert_eq!(conv.id, "T0:D1");
    }

    #[test]
    fn conv_id_round_trips_through_parse_handle() {
        let conv = to_im_conversation(&ws(), &row("C1", "eng", false, false, false, 1));
        let handle = parse_handle(&conv);
        assert_eq!(handle.team_id, "T0");
        assert_eq!(handle.channel_id, "C1");
    }

    #[test]
    fn ts_round_trip() {
        let dt = ts_string_to_utc("1735000000.123456").unwrap();
        assert_eq!(dt.timestamp(), 1735000000);
    }

    #[test]
    fn channel_payload_marks_mentions_and_lists_them_in_header() {
        let conv = channel_conv();
        let messages = vec![
            msg("100.1", 0, "morning all", None),
            msg("100.2", 60, "hey <@U_me> can you own SOC II?", None),
        ];
        let payload = build_channel_payload(&conv, &messages, &["100.2".into()], &[]);
        assert!(payload.contains("- your_mentions: 100.2"));
        // The mention block carries the marker; the other does not.
        assert!(payload.contains("· id:100.2\n- ↳ mention\n"));
        assert!(payload.contains("· id:100.1\n```"));
        // No decorative `## ` banner — only real message blocks start with `## `.
        for line in payload.lines().filter(|l| l.starts_with("## ")) {
            assert!(line.contains("· id:"), "stray ## banner: {line}");
        }
    }

    #[test]
    fn protected_trim_keeps_old_mention_thread_over_time_floor() {
        struct B;
        impl ImBackend for B {
            fn source(&self) -> &'static str {
                SOURCE
            }
            fn preflight(&self) -> Result<()> {
                Ok(())
            }
            fn discover_conversations(&self, _: usize) -> Result<Vec<ImConversation>> {
                Ok(vec![])
            }
            fn fetch_messages(
                &self,
                _: &ImConversation,
                _: Option<DateTime<Utc>>,
                _: usize,
            ) -> Result<Vec<ImMessage>> {
                Ok(vec![])
            }
        }
        let conv = channel_conv();
        // An old protected thread root + a recent unprotected message.
        let old_root = ImMessage {
            timestamp: Utc::now() - Duration::days(WINDOW_DAYS + 5),
            ..msg("root", 0, "old @-ed thread root", None)
        };
        let recent = ImMessage {
            timestamp: Utc::now() - Duration::hours(1),
            ..msg("recent", 0, "fresh chatter", None)
        };
        let mut messages = vec![old_root, recent];
        let protected: BTreeSet<String> = ["root".to_string()].into_iter().collect();
        protected_trim(&mut messages, &B, &conv, &protected);
        assert!(
            messages.iter().any(|m| m.id == "root"),
            "old protected root must survive the time floor",
        );
        assert!(messages.iter().any(|m| m.id == "recent"));
    }

    #[test]
    fn force_inject_builds_message_from_hit() {
        let hit = MentionHit {
            channel_id: "C1".into(),
            ts: "1735000000.000900".into(),
            thread_ts: Some("1735000000.000100".into()),
            text: "<@U_me> ping".into(),
            is_mention: true,
        };
        let m = force_inject_message(&hit);
        assert_eq!(m.id, "1735000000.000900");
        assert_eq!(m.text, "<@U_me> ping");
        assert_eq!(message_thread_ts(&m).as_deref(), Some("1735000000.000100"));
    }
}
