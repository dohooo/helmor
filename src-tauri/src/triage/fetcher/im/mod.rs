//! Shared scaffolding for "office IM" sources (Slack, Lark, future
//! Dingtalk / WeChat / Teams). Each platform implements [`ImBackend`];
//! the generic [`ImFetcher`] wraps a backend into the top-level
//! [`super::Fetcher`] contract and handles every common concern.
//!
//! Candidate model
//! ---------------
//!
//! IM candidates are **chat-level**, not message-level:
//!   - One `triage_candidate` row per chat / channel / DM.
//!   - One markdown file per chat under `cache/triage/<source>/<conv>.md`,
//!     containing a trimmed window of recent messages.
//!   - The LLM reads the whole file when judging the chat, so it sees
//!     full multi-message context (the single-message model couldn't
//!     identify tasks made of several exchanges).
//!
//! When the LLM proposes a workspace it must pass a `task_anchor`
//! (typically the anchor message's id). The scheduler composes
//! `source_ref = <chat_id>:<anchor>` for `create_ai_workspace`, so a
//! single chat can spawn multiple workspaces — one per anchor.
//!
//! Decisions
//! ---------
//!
//! Unlike forge candidates where a decision is terminal, IM decisions
//! are **re-opened** by the fetcher when new activity arrives:
//!   - User dismissed the chat last tick → `decision='skip'`
//!   - Three new messages land → fetcher sees `new_messages > 0` and
//!     calls `reset_decision(id)` so the LLM sees the chat again.
//!
//! Window trimming
//! ---------------
//!
//! Each chat file is bounded by THREE limits, applied at write time:
//!   - last `WINDOW_DAYS` days,
//!   - max `WINDOW_MAX_MESSAGES` messages,
//!   - max `WINDOW_MAX_BYTES` bytes.
//!
//! Oldest messages are dropped first.

pub mod lark;
pub mod slack;
pub mod types;

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, SecondsFormat, Utc};

use super::cache;
use super::storage::{self, NewCandidate, UpsertOutcome};
use super::{FetchSummary, Fetcher};
pub use types::{ImConversation, ImConversationKind, ImMessage};

/// Per-tick conversation cap (defense in depth — backends already
/// pre-filter via platform signals).
pub const MAX_CONVERSATIONS_PER_TICK: usize = 30;
/// Max messages per conversation per fetch call.
pub const MAX_MESSAGES_PER_CONVERSATION: usize = 50;
/// Cold-start lookback (used when there's no per-conversation cursor).
pub const COLD_START_DAYS: i64 = 3;
/// Overlap window applied to the cursor so a message that straddled the
/// previous tick's boundary still surfaces.
pub const OVERLAP_HOURS: i64 = 6;
/// Sliding window of recent messages kept in each chat file.
pub const WINDOW_DAYS: i64 = 7;
pub const WINDOW_MAX_MESSAGES: usize = 200;
pub const WINDOW_MAX_BYTES: usize = 256 * 1024;
/// Recent-sender shortlist surfaced in candidate metadata.
pub const RECENT_PARTICIPANT_LIMIT: usize = 3;
/// Length of the human-readable preview in the candidate row.
pub const PREVIEW_CHARS: usize = 400;

/// Platform-specific backend for an "office IM" fetcher.
pub trait ImBackend: Send + Sync {
    /// Source id used for `triage_candidate.source`, scheduler logs,
    /// and the cache directory name. Stable contract — renaming
    /// orphans every stored row.
    fn source(&self) -> &'static str;

    /// Cheap auth check. `Err` means "skip this tick silently".
    fn preflight(&self) -> Result<()>;

    /// Enumerate conversations Helmor should poll.
    fn discover_conversations(&self, limit: usize) -> Result<Vec<ImConversation>>;

    /// Pull messages from one conversation since `since`. Caller may
    /// merge these with messages from the existing chat file and
    /// re-trim the window.
    fn fetch_messages(
        &self,
        conv: &ImConversation,
        since: Option<DateTime<Utc>>,
        limit: usize,
    ) -> Result<Vec<ImMessage>>;

    /// Render one message into a markdown block inside the chat file.
    /// Default: `## <iso-ts> — <sender>\n\`\`\`\n<text>\n\`\`\``.
    /// Backends override to add platform-specific extras (msg_type,
    /// file refs, …) inside each block.
    fn render_message_block(&self, conv: &ImConversation, msg: &ImMessage) -> String {
        default_message_block(conv, msg)
    }
}

/// Generic fetcher wrapping a single [`ImBackend`]. One per platform.
pub struct ImFetcher<B: ImBackend>(pub B);

impl<B: ImBackend + 'static> Fetcher for ImFetcher<B> {
    fn source(&self) -> &'static str {
        self.0.source()
    }

    fn fetch_once(&self) -> Result<FetchSummary> {
        let source = self.0.source();
        if let Err(error) = self.0.preflight() {
            tracing::debug!(
                source,
                error = %format!("{error:#}"),
                "im fetcher: preflight failed, skipping",
            );
            return Ok(FetchSummary::default());
        }
        let conversations = match self.0.discover_conversations(MAX_CONVERSATIONS_PER_TICK) {
            Ok(mut conv) => {
                conv.truncate(MAX_CONVERSATIONS_PER_TICK);
                conv
            }
            Err(error) => {
                tracing::warn!(
                    source,
                    error = %format!("{error:#}"),
                    "im fetcher: conversation discovery failed",
                );
                return Ok(FetchSummary::default());
            }
        };
        let mut summary = FetchSummary::default();
        for conv in &conversations {
            if let Err(error) = ingest_conversation(&self.0, conv, &mut summary) {
                tracing::warn!(
                    source,
                    conv_id = %conv.id,
                    error = %format!("{error:#}"),
                    "im fetcher: per-conversation fetch failed",
                );
            }
            summary.source_parents_scanned += 1;
        }
        Ok(summary)
    }
}

/// Chat-level ingest:
///   1. Pull recent messages from the backend (delta vs cursor).
///   2. Merge with messages still in the trimmed window file.
///   3. Trim window, render to markdown with `last_proposed_anchors`
///      header.
///   4. UPSERT the candidate row. If new messages arrived on a row
///      that was already decided, reset decision so the LLM sees it.
fn ingest_conversation<B: ImBackend + ?Sized>(
    backend: &B,
    conv: &ImConversation,
    summary: &mut FetchSummary,
) -> Result<()> {
    let source = backend.source();
    let cursor = storage::read_cursor(source, &conv.id)?;
    let since = effective_since(cursor.last_source_time.as_deref());

    let new_messages = backend
        .fetch_messages(conv, since, MAX_MESSAGES_PER_CONVERSATION)
        .with_context(|| format!("{source} fetch_messages for {}", conv.id))?;

    // Old messages: still in the existing file (if any). We reuse
    // them so the LLM keeps seeing >5min-old context even when only
    // 2 new messages arrived this tick.
    let candidate_id = format!("{source}:{}", conv.id);
    let existing_row = storage::get_candidate(&candidate_id)?;
    let mut merged_index = load_existing_messages(existing_row.as_ref());

    // Merge by message id (newest write wins for the same id).
    let new_message_ids: Vec<String> = new_messages
        .iter()
        .filter(|m| !m.deleted && !m.id.is_empty())
        .map(|m| m.id.clone())
        .collect();
    let has_new_activity = new_message_ids
        .iter()
        .any(|id| !merged_index.contains_key(id));

    for msg in new_messages.into_iter() {
        if msg.deleted || msg.id.is_empty() {
            continue;
        }
        merged_index.insert(msg.id.clone(), msg);
    }

    // Chronological order (oldest first) + window trimming.
    let mut ordered: Vec<ImMessage> = merged_index.into_values().collect();
    ordered.sort_by_key(|m| m.timestamp);
    trim_window(&mut ordered, backend, conv);

    if ordered.is_empty() {
        // Nothing to write yet (cold start + empty chat). Don't write a
        // cursor row either — the only useful column is
        // `last_source_time` and we have none.
        return Ok(());
    }

    let newest_ts = ordered.last().expect("non-empty").timestamp;
    let proposed_anchors = storage::proposed_anchors_for_chat(source, &conv.id)?;
    let payload = render_chat_payload(backend, conv, &ordered, &proposed_anchors);
    let payload_path = build_payload_path(source, &conv.id);
    let payload_bytes = cache::write_payload(&payload_path, &payload)?;

    let (title, preview, sender) = build_candidate_summary(conv, &ordered);
    let candidate = NewCandidate {
        id: candidate_id.clone(),
        source: source.into(),
        source_kind: conv.kind.as_source_kind().into(),
        source_ref: conv.id.clone(),
        source_time: newest_ts,
        sender,
        title: Some(title),
        preview: if preview.is_empty() {
            None
        } else {
            Some(preview)
        },
        external_url: None,
        payload_path,
        payload_bytes,
    };

    // If there's new activity and the row was previously decided, wake
    // it up so the LLM sees the chat in the next tick's candidate list.
    let was_decided = existing_row
        .as_ref()
        .and_then(|r| r.decision.as_deref())
        .is_some();
    if was_decided && has_new_activity {
        storage::reset_decision(&candidate_id).context("reset_decision after new IM activity")?;
        summary.updated += 1;
    }

    match storage::upsert_candidate(&candidate)? {
        UpsertOutcome::Inserted => summary.inserted += 1,
        UpsertOutcome::UpdatedUnchanged => summary.updated += 1,
        UpsertOutcome::SkippedDecided => summary.skipped_decided += 1,
    }

    storage::write_cursor(
        source,
        &conv.id,
        &storage::FetchCursor {
            last_source_time: Some(newest_ts.to_rfc3339_opts(SecondsFormat::Secs, true)),
        },
    )
    .context("write im per-conversation cursor")?;
    Ok(())
}

/// Read the existing chat file (if any) and parse it back into an
/// `ImMessage` map indexed by id. Best-effort: corruption / format
/// drift just means we re-fetch a wider window next tick.
fn load_existing_messages(existing: Option<&storage::CandidateRow>) -> BTreeMap<String, ImMessage> {
    let Some(row) = existing else {
        return BTreeMap::new();
    };
    let raw = match cache::read_payload(&row.payload_path) {
        Ok(s) => s,
        Err(_) => return BTreeMap::new(),
    };
    parse_chat_payload(&raw)
}

/// Trim the message vector down to the configured window. Drops oldest
/// first by timestamp, but also clips byte budget so a single
/// pathological message can't break the cap.
fn trim_window<B: ImBackend + ?Sized>(
    messages: &mut Vec<ImMessage>,
    backend: &B,
    conv: &ImConversation,
) {
    let cutoff = Utc::now() - Duration::days(WINDOW_DAYS);
    messages.retain(|m| m.timestamp >= cutoff);
    while messages.len() > WINDOW_MAX_MESSAGES {
        messages.remove(0);
    }
    // Estimate byte size by rendering and pop oldest until under cap.
    // We re-render once at the end; this cheap loop is just to bound
    // memory and final file size.
    loop {
        let probe_bytes: usize = messages
            .iter()
            .map(|m| backend.render_message_block(conv, m).len() + 1)
            .sum();
        if probe_bytes <= WINDOW_MAX_BYTES || messages.is_empty() {
            break;
        }
        messages.remove(0);
    }
}

fn build_candidate_summary(
    conv: &ImConversation,
    messages: &[ImMessage],
) -> (String, String, Option<String>) {
    let label = conv.label.as_deref().unwrap_or(&conv.id);
    let count = messages.len();
    let title = truncate(
        &format!(
            "{label} · {count} message{}",
            if count == 1 { "" } else { "s" }
        ),
        120,
    );
    // Preview: take the most recent few messages, oldest-first.
    let preview_msgs: Vec<&ImMessage> = messages.iter().rev().take(3).collect::<Vec<_>>();
    let mut preview = String::new();
    for m in preview_msgs.into_iter().rev() {
        let sender = m.sender.as_deref().unwrap_or("?");
        let body = m.text.replace('\n', " ");
        let line = format!("{sender}: {body} | ");
        preview.push_str(&line);
        if preview.chars().count() >= PREVIEW_CHARS {
            break;
        }
    }
    let preview = truncate(preview.trim_end_matches(" | "), PREVIEW_CHARS);
    // Sender = top-N most recent participants, deduped, newest-first.
    let mut seen = std::collections::HashSet::new();
    let mut recent_senders: Vec<String> = Vec::new();
    for m in messages.iter().rev() {
        let Some(s) = m.sender.as_deref() else {
            continue;
        };
        if seen.insert(s.to_string()) {
            recent_senders.push(s.to_string());
            if recent_senders.len() >= RECENT_PARTICIPANT_LIMIT {
                break;
            }
        }
    }
    let sender = if recent_senders.is_empty() {
        None
    } else {
        Some(recent_senders.join(", "))
    };
    (title, preview, sender)
}

fn render_chat_payload<B: ImBackend + ?Sized>(
    backend: &B,
    conv: &ImConversation,
    messages: &[ImMessage],
    proposed_anchors: &[String],
) -> String {
    let mut out = String::new();
    let source = backend.source();
    let label = conv.label.as_deref().unwrap_or(&conv.id);
    out.push_str(&format!("# {source} chat — {label}\n\n"));
    out.push_str(&format!("- conversation_id: {}\n", conv.id));
    out.push_str(&format!("- kind: {}\n", conv.kind.as_source_kind()));
    out.push_str(&format!(
        "- window: last {WINDOW_DAYS} days, {} messages\n",
        messages.len()
    ));
    if !proposed_anchors.is_empty() {
        out.push_str("- last_proposed_anchors: ");
        out.push_str(&proposed_anchors.join(", "));
        out.push('\n');
        out.push_str("  (the LLM has already created workspaces for these anchors — skip them)\n");
    }
    out.push_str("\n---\n\n");
    for m in messages {
        out.push_str(&backend.render_message_block(conv, m));
        out.push('\n');
    }
    out
}

/// Minimal regex-free parser for the chat-file format we emit. Reads
/// ID, timestamp, sender, and the body inside the fenced block. Lines
/// outside the header/blocks are skipped — corruption returns a
/// (possibly empty) best-effort map.
fn parse_chat_payload(raw: &str) -> BTreeMap<String, ImMessage> {
    let mut out = BTreeMap::new();
    // We split on the `## ` block delimiter we emit in
    // `default_message_block`. The first chunk is the chat-level header.
    let mut blocks = raw.split("\n## ");
    let _header = blocks.next();
    for block in blocks {
        let block = format!("## {block}");
        if let Some(msg) = parse_message_block(&block) {
            out.insert(msg.id.clone(), msg);
        }
    }
    out
}

fn parse_message_block(block: &str) -> Option<ImMessage> {
    // Expected layout (default_message_block):
    //   ## <iso-ts> — <sender>  [optional " · id:<id>"]
    //   [optional bulleted meta lines]
    //   ```
    //   <text>
    //   ```
    let mut lines = block.lines();
    let header = lines.next()?.trim_start_matches("## ");
    let (timestamp_str, rest) = header.split_once(" — ")?;
    let timestamp = DateTime::parse_from_rfc3339(timestamp_str.trim())
        .ok()?
        .with_timezone(&Utc);
    let (sender_part, id_part) = match rest.split_once(" · id:") {
        Some((s, i)) => (s.trim().to_string(), i.trim().to_string()),
        None => (rest.trim().to_string(), String::new()),
    };
    let id = id_part;
    if id.is_empty() {
        return None;
    }
    // Find the fenced block body.
    let mut in_body = false;
    let mut body_lines: Vec<&str> = Vec::new();
    for line in lines {
        if line.starts_with("```") {
            if in_body {
                break;
            }
            in_body = true;
            continue;
        }
        if in_body {
            body_lines.push(line);
        }
    }
    let text = body_lines.join("\n");
    Some(ImMessage {
        id,
        timestamp,
        sender: if sender_part.is_empty() || sender_part == "(unknown)" {
            None
        } else {
            Some(sender_part)
        },
        text,
        external_url: None,
        deleted: false,
        raw: serde_json::Value::Null,
    })
}

/// Default per-message block. Mirrored by `parse_message_block`. Format
/// changes here MUST be matched in the parser or restart upgrades will
/// silently drop history.
pub fn default_message_block(_conv: &ImConversation, msg: &ImMessage) -> String {
    let mut out = String::new();
    let sender = msg.sender.as_deref().unwrap_or("(unknown)");
    let ts = msg.timestamp.to_rfc3339_opts(SecondsFormat::Secs, true);
    out.push_str(&format!("## {ts} — {sender} · id:{}\n", msg.id));
    out.push_str("```\n");
    out.push_str(msg.text.trim());
    out.push_str("\n```\n");
    out
}

fn build_payload_path(source: &str, conv_id: &str) -> String {
    let source_seg = cache::safe_segment(source);
    let conv_seg = cache::safe_segment(conv_id);
    format!("{source_seg}/{conv_seg}.md")
}

/// Apply 6h overlap to the cursor (or 3-day floor on cold start) so a
/// message that landed right at the boundary still surfaces.
pub fn effective_since(last_source_time: Option<&str>) -> Option<DateTime<Utc>> {
    let parsed = last_source_time.and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    Some(match parsed {
        Some(dt) => dt.with_timezone(&Utc) - Duration::hours(OVERLAP_HOURS),
        None => Utc::now() - Duration::days(COLD_START_DAYS),
    })
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::Value;

    fn msg(id: &str, ts_secs_offset: i64, sender: &str, text: &str) -> ImMessage {
        ImMessage {
            id: id.into(),
            timestamp: Utc.with_ymd_and_hms(2026, 5, 26, 10, 0, 0).unwrap()
                + Duration::seconds(ts_secs_offset),
            sender: Some(sender.into()),
            text: text.into(),
            external_url: None,
            deleted: false,
            raw: Value::Null,
        }
    }

    #[test]
    fn cold_start_returns_3d_floor() {
        let dt = effective_since(None).unwrap();
        let diff = Utc::now().signed_duration_since(dt);
        assert!(diff <= Duration::days(COLD_START_DAYS) + Duration::minutes(1));
        assert!(diff >= Duration::days(COLD_START_DAYS) - Duration::minutes(1));
    }

    #[test]
    fn payload_path_for_chat() {
        let p = build_payload_path("slack", "C99/team-eng");
        assert_eq!(p, "slack/C99_team-eng.md");
    }

    #[test]
    fn default_block_round_trips_through_parser() {
        let conv = ImConversation {
            id: "C1".into(),
            label: Some("eng".into()),
            kind: ImConversationKind::Channel,
            raw: Value::Null,
        };
        let original = msg("om_1", 0, "Alice", "Hello\nworld");
        let block = default_message_block(&conv, &original);
        let map = parse_chat_payload(&format!("# header\n\n{block}"));
        let recovered = map.get("om_1").expect("message recovered");
        assert_eq!(recovered.sender.as_deref(), Some("Alice"));
        assert_eq!(recovered.text, "Hello\nworld");
        assert_eq!(recovered.timestamp, original.timestamp);
    }

    #[test]
    fn build_summary_picks_recent_senders() {
        let conv = ImConversation {
            id: "C1".into(),
            label: Some("eng-frontend".into()),
            kind: ImConversationKind::Channel,
            raw: Value::Null,
        };
        let messages = vec![
            msg("a", 0, "Dave", "old"),
            msg("b", 60, "Alice", "newer"),
            msg("c", 120, "Bob", "newest"),
            msg("d", 180, "Alice", "very newest"),
        ];
        let (title, _preview, sender) = build_candidate_summary(&conv, &messages);
        assert!(title.starts_with("eng-frontend · 4 messages"));
        // Reverse-iteration order, dedup, capped at 3.
        assert_eq!(sender.as_deref(), Some("Alice, Bob, Dave"));
    }

    #[test]
    fn render_chat_payload_includes_anchors_when_present() {
        struct B;
        impl ImBackend for B {
            fn source(&self) -> &'static str {
                "slack"
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
        let conv = ImConversation {
            id: "C1".into(),
            label: Some("eng".into()),
            kind: ImConversationKind::Channel,
            raw: Value::Null,
        };
        let messages = vec![msg("a", 0, "Alice", "hi")];
        let rendered = render_chat_payload(&B, &conv, &messages, &["om_aa".into(), "om_bb".into()]);
        assert!(rendered.contains("# slack chat — eng"));
        assert!(rendered.contains("- last_proposed_anchors: om_aa, om_bb"));
    }

    #[test]
    fn trim_window_drops_old_messages_by_time() {
        struct B;
        impl ImBackend for B {
            fn source(&self) -> &'static str {
                "slack"
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
        let conv = ImConversation {
            id: "C1".into(),
            label: None,
            kind: ImConversationKind::Channel,
            raw: Value::Null,
        };
        let too_old = Utc::now() - Duration::days(WINDOW_DAYS + 1);
        let recent = Utc::now() - Duration::hours(2);
        let mut messages = vec![
            ImMessage {
                id: "old".into(),
                timestamp: too_old,
                sender: Some("A".into()),
                text: "ancient".into(),
                external_url: None,
                deleted: false,
                raw: Value::Null,
            },
            ImMessage {
                id: "fresh".into(),
                timestamp: recent,
                sender: Some("B".into()),
                text: "fresh".into(),
                external_url: None,
                deleted: false,
                raw: Value::Null,
            },
        ];
        trim_window(&mut messages, &B, &conv);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "fresh");
    }
}
