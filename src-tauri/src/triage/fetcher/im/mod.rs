//! Shared scaffolding for "office IM" sources (Slack, Lark, future
//! Dingtalk / WeChat / Teams). Each platform implements [`ImBackend`];
//! the generic [`ImFetcher`] wraps a backend into the top-level
//! [`super::Fetcher`] contract and handles every common concern:
//!
//! - subscription upsert
//! - per-conversation cursor read/write
//! - incremental window (`since` = cursor or 3-day cold-start floor)
//! - candidate exists/insert/update routing
//! - payload path generation + file write
//! - error isolation (per-conversation failure logged, never aborts the tick)
//!
//! Backends only express what's actually platform-specific:
//! authentication preflight, conversation discovery, message fetching,
//! and (optionally) custom payload rendering.

pub mod lark;
pub mod slack;
pub mod types;

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, SecondsFormat, Utc};

use super::cache;
use super::storage::{self, NewCandidate, UpsertOutcome};
use super::{FetchSummary, Fetcher};
pub use types::{ImConversation, ImConversationKind, ImMessage};

/// Per-tick conversation cap. We bound this generically here — backends
/// already filter / sort according to platform signals before returning,
/// so the cap is just defense in depth against an upstream that hands
/// back hundreds of rows.
pub const MAX_CONVERSATIONS_PER_TICK: usize = 30;
/// Max messages we'll ingest per conversation per tick. Backends pass
/// this through to their pagination call.
pub const MAX_MESSAGES_PER_CONVERSATION: usize = 50;
/// Cold-start lookback (used when there's no per-conversation cursor).
pub const COLD_START_DAYS: i64 = 3;
/// Overlap window applied to the cursor so a message that straddled the
/// previous tick's boundary still surfaces.
pub const OVERLAP_HOURS: i64 = 6;

/// Platform-specific backend for an "office IM" fetcher.
///
/// A backend models one chat platform (Slack workspaces, Lark tenants,
/// …). Methods are called from a single thread per tick; backends that
/// need async (Lark's tokio-based CLI) should block on the shared
/// runtime via [`super::http_runtime`].
pub trait ImBackend: Send + Sync {
    /// Source id used for `triage_candidate.source`, scheduler logs, and
    /// the cache directory name. Stable contract — renaming orphans
    /// every stored row.
    fn source(&self) -> &'static str;

    /// Cheap auth check. `Err` means "skip this tick silently" — used
    /// for users who haven't connected the platform. The fetcher logs
    /// at debug, not warn.
    fn preflight(&self) -> Result<()>;

    /// Enumerate conversations Helmor should poll. Backends are expected
    /// to lean on platform-native signals (Slack `unread_count_display`,
    /// Lark `ByActiveTimeDesc + exclude-muted`, …) to keep the set tight.
    /// Generic layer truncates to [`MAX_CONVERSATIONS_PER_TICK`].
    fn discover_conversations(&self, limit: usize) -> Result<Vec<ImConversation>>;

    /// Pull messages from one conversation since `since`. Backends are
    /// expected to convert `since` into whatever per-platform format the
    /// upstream API wants (Lark RFC3339, Slack `ts` seconds, …).
    fn fetch_messages(
        &self,
        conv: &ImConversation,
        since: Option<DateTime<Utc>>,
        limit: usize,
    ) -> Result<Vec<ImMessage>>;

    /// Render one message into the markdown payload stored under
    /// `cache/triage/<source>/...`. Default is a three-section template
    /// (header + metadata + body). Backends override when they want to
    /// add platform-specific context — Slack threads, Lark chat_mode, …
    fn render_payload(&self, conv: &ImConversation, msg: &ImMessage) -> String {
        default_three_section_render(self.source(), conv, msg)
    }
}

/// Generic fetcher wrapping a single [`ImBackend`]. One per platform;
/// registered via [`super::registered_fetchers`].
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
        tracing::debug!(
            source,
            count = conversations.len(),
            "im fetcher: discovered active conversations",
        );

        let mut summary = FetchSummary::default();
        for conv in &conversations {
            // Subscription row is best-effort metadata for the UI; never
            // let a write hiccup here abort the per-conv fetch.
            let _ =
                storage::upsert_subscription_auto(source, &conv.id, conv.label.as_deref(), None);

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

fn ingest_conversation<B: ImBackend + ?Sized>(
    backend: &B,
    conv: &ImConversation,
    summary: &mut FetchSummary,
) -> Result<()> {
    let source = backend.source();
    let cursor = storage::read_cursor(source, &conv.id)?;
    let since = effective_since(cursor.last_source_time.as_deref());

    let messages = backend
        .fetch_messages(conv, since, MAX_MESSAGES_PER_CONVERSATION)
        .with_context(|| format!("{source} fetch_messages for {}", conv.id))?;

    let mut newest_ts: Option<DateTime<Utc>> = None;
    for msg in &messages {
        match ingest_message(backend, conv, msg, summary) {
            Ok(Some(ts)) => {
                newest_ts = Some(newest_ts.map_or(ts, |prev| prev.max(ts)));
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(
                source,
                conv_id = %conv.id,
                message_id = %msg.id,
                error = %format!("{error:#}"),
                "im fetcher: ingest_message failed",
            ),
        }
    }

    let now = storage::now_iso();
    storage::write_cursor(
        source,
        &conv.id,
        &storage::FetchCursor {
            last_fetched_at: Some(now),
            last_source_time: newest_ts.map(|t| t.to_rfc3339_opts(SecondsFormat::Secs, true)),
            last_external_ref: None,
        },
    )
    .context("write im per-conversation cursor")?;
    Ok(())
}

fn ingest_message<B: ImBackend + ?Sized>(
    backend: &B,
    conv: &ImConversation,
    msg: &ImMessage,
    summary: &mut FetchSummary,
) -> Result<Option<DateTime<Utc>>> {
    if msg.deleted || msg.id.is_empty() {
        return Ok(None);
    }
    let source = backend.source();
    let id = format!("{source}:{}:{}", conv.id, msg.id);
    let source_ref = format!("{}:{}", conv.id, msg.id);

    let exists = storage::candidate_exists(source, &source_ref)?;
    let (payload_path, payload_bytes) = if exists {
        let path = read_existing_payload_path(&id)?;
        (path, 0u64)
    } else {
        let path = build_payload_path(source, &conv.id, &msg.id);
        let body = backend.render_payload(conv, msg);
        let bytes = cache::write_payload(&path, &body)?;
        (path, bytes)
    };

    let preview = truncate(&msg.text, 400);
    let title_source = if msg.text.trim().is_empty() {
        conv.label.clone().unwrap_or_else(|| conv.id.clone())
    } else {
        msg.text.clone()
    };
    let title = truncate(&title_source, 120);

    let candidate = NewCandidate {
        id,
        source: source.into(),
        source_kind: conv.kind.as_source_kind().into(),
        source_ref,
        source_parent: Some(conv.id.clone()),
        source_time: msg.timestamp,
        sender: msg.sender.clone(),
        title: Some(title),
        preview: if preview.is_empty() {
            None
        } else {
            Some(preview)
        },
        external_url: msg.external_url.clone(),
        payload_path,
        payload_bytes,
    };

    match storage::upsert_candidate(&candidate)? {
        UpsertOutcome::Inserted => summary.inserted += 1,
        UpsertOutcome::UpdatedUnchanged => summary.updated += 1,
        UpsertOutcome::SkippedDecided => summary.skipped_decided += 1,
    }
    Ok(Some(msg.timestamp))
}

fn read_existing_payload_path(candidate_id: &str) -> Result<String> {
    let conn = crate::models::db::read_conn()?;
    conn.query_row(
        "SELECT payload_path FROM triage_candidate WHERE id = ?1",
        rusqlite::params![candidate_id],
        |row| row.get(0),
    )
    .context("read existing payload_path")
}

fn build_payload_path(source: &str, conv_id: &str, msg_id: &str) -> String {
    let source_seg = cache::safe_segment(source);
    let conv_seg = cache::safe_segment(conv_id);
    let msg_seg = cache::safe_segment(msg_id);
    format!("{source_seg}/{conv_seg}/{msg_seg}.md")
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

/// Default markdown payload — every backend gets this for free. Three
/// sections: H1 header, bulleted metadata, fenced body block.
pub fn default_three_section_render(
    source: &str,
    conv: &ImConversation,
    msg: &ImMessage,
) -> String {
    let mut out = String::new();
    let label = conv.label.as_deref().unwrap_or(&conv.id);
    let sender = msg.sender.as_deref().unwrap_or("(unknown)");
    out.push_str(&format!("# {source} message — {sender} in {label}\n\n"));
    out.push_str(&format!("- conversation_id: {}\n", conv.id));
    out.push_str(&format!("- kind: {}\n", conv.kind.as_source_kind()));
    out.push_str(&format!(
        "- timestamp: {}\n",
        msg.timestamp.to_rfc3339_opts(SecondsFormat::Secs, true)
    ));
    if let Some(url) = &msg.external_url {
        out.push_str(&format!("- link: {url}\n"));
    }
    out.push_str("\n---\n\n```\n");
    out.push_str(msg.text.trim());
    out.push_str("\n```\n");
    out
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

    #[test]
    fn cold_start_returns_3d_floor() {
        let dt = effective_since(None).unwrap();
        let diff = Utc::now().signed_duration_since(dt);
        assert!(diff <= Duration::days(COLD_START_DAYS) + Duration::minutes(1));
        assert!(diff >= Duration::days(COLD_START_DAYS) - Duration::minutes(1));
    }

    #[test]
    fn cursor_with_overlap() {
        let dt = effective_since(Some("2026-05-26T10:00:00Z")).unwrap();
        let expected = DateTime::parse_from_rfc3339("2026-05-26T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            - Duration::hours(OVERLAP_HOURS);
        assert_eq!(dt, expected);
    }

    #[test]
    fn payload_path_is_safe_three_segments() {
        let p = build_payload_path("slack", "C99/team-eng", "1234.567");
        assert_eq!(p, "slack/C99_team-eng/1234_567.md");
    }

    #[test]
    fn truncate_preserves_utf8() {
        assert_eq!(truncate("你好世界", 2), "你好…");
    }

    #[test]
    fn default_render_includes_three_sections() {
        let conv = ImConversation {
            id: "C1".into(),
            label: Some("eng".into()),
            kind: ImConversationKind::Channel,
            raw: Value::Null,
        };
        let msg = ImMessage {
            id: "1".into(),
            timestamp: Utc.with_ymd_and_hms(2026, 5, 26, 10, 0, 0).unwrap(),
            sender: Some("Alice".into()),
            text: "Hi everyone!".into(),
            external_url: Some("https://example.com/m/1".into()),
            deleted: false,
            raw: Value::Null,
        };
        let rendered = default_three_section_render("slack", &conv, &msg);
        assert!(rendered.contains("# slack message — Alice in eng"));
        assert!(rendered.contains("- conversation_id: C1"));
        assert!(rendered.contains("- kind: channel"));
        assert!(rendered.contains("```\nHi everyone!\n```"));
    }
}
