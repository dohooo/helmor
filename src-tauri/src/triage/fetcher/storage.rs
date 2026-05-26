//! DB ops for `triage_candidate`, `triage_fetch_cursor`,
//! `triage_source_subscription`.
//!
//! Writes go through `db::write_conn()` (single-writer pool). Reads use
//! the read pool. All timestamps are RFC 3339 with timezone offset so
//! cross-day comparisons are unambiguous.

use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::models::db;

/// One row to upsert into `triage_candidate`. Built by each provider's
/// fetcher and handed to [`upsert_candidate`].
#[derive(Debug, Clone)]
pub struct NewCandidate {
    pub id: String,
    pub source: String,
    pub source_kind: String,
    pub source_ref: String,
    pub source_parent: Option<String>,
    pub source_time: DateTime<Utc>,
    pub sender: Option<String>,
    pub title: Option<String>,
    pub preview: Option<String>,
    pub external_url: Option<String>,
    pub payload_path: String,
    pub payload_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpsertOutcome {
    Inserted,
    UpdatedUnchanged,
    /// Row already had a non-NULL `decision`; we leave it alone so the
    /// fetcher never resurrects items the LLM (or the user) already
    /// decided.
    SkippedDecided,
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn fmt_ts(ts: DateTime<Utc>) -> String {
    ts.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Insert if new; otherwise refresh metadata IF the row is still open
/// (`decision IS NULL`). Decided rows are not touched — that's the
/// "don't re-evaluate skipped items" guarantee.
pub fn upsert_candidate(candidate: &NewCandidate) -> Result<UpsertOutcome> {
    let now = now_iso();
    let source_time = fmt_ts(candidate.source_time);
    let conn = db::write_conn()?;

    // Branch on existing row's decision so the fetcher can never
    // resurrect a 'skip'/'dismissed' candidate just because upstream
    // bumped its updated_at.
    let existing_decision: Option<Option<String>> = conn
        .query_row(
            "SELECT decision FROM triage_candidate WHERE source = ?1 AND source_ref = ?2",
            params![&candidate.source, &candidate.source_ref],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .context("query existing triage_candidate")?;

    match existing_decision {
        Some(Some(_)) => Ok(UpsertOutcome::SkippedDecided),
        Some(None) => {
            conn.execute(
                "UPDATE triage_candidate SET
                    source_kind = ?1,
                    source_parent = ?2,
                    fetched_at = ?3,
                    source_time = ?4,
                    last_updated_at = ?5,
                    sender = ?6,
                    title = ?7,
                    preview = ?8,
                    external_url = ?9,
                    payload_path = ?10,
                    payload_bytes = ?11
                 WHERE source = ?12 AND source_ref = ?13",
                params![
                    &candidate.source_kind,
                    &candidate.source_parent,
                    &now,
                    &source_time,
                    &now,
                    &candidate.sender,
                    &candidate.title,
                    &candidate.preview,
                    &candidate.external_url,
                    &candidate.payload_path,
                    candidate.payload_bytes as i64,
                    &candidate.source,
                    &candidate.source_ref,
                ],
            )
            .context("update open triage_candidate")?;
            Ok(UpsertOutcome::UpdatedUnchanged)
        }
        None => {
            conn.execute(
                "INSERT INTO triage_candidate (
                    id, source, source_kind, source_ref, source_parent,
                    fetched_at, source_time, last_updated_at, sender,
                    title, preview, external_url, payload_path, payload_bytes
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5,
                    ?6, ?7, ?8, ?9,
                    ?10, ?11, ?12, ?13, ?14
                )",
                params![
                    &candidate.id,
                    &candidate.source,
                    &candidate.source_kind,
                    &candidate.source_ref,
                    &candidate.source_parent,
                    &now,
                    &source_time,
                    &now,
                    &candidate.sender,
                    &candidate.title,
                    &candidate.preview,
                    &candidate.external_url,
                    &candidate.payload_path,
                    candidate.payload_bytes as i64,
                ],
            )
            .context("insert triage_candidate")?;
            Ok(UpsertOutcome::Inserted)
        }
    }
}

/// True if a candidate with this `(source, source_ref)` already exists.
/// Used by fetchers to skip the detail-fetch cost for known items.
pub fn candidate_exists(source: &str, source_ref: &str) -> Result<bool> {
    let conn = db::read_conn()?;
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM triage_candidate WHERE source = ?1 AND source_ref = ?2",
            params![source, source_ref],
            |row| row.get(0),
        )
        .context("candidate_exists count")?;
    Ok(n > 0)
}

/// Per-`(source, source_parent)` cursor used by fetchers to skip rows
/// they've already seen. `source_parent` defaults to "" for inbox-style
/// sources without a parent identifier.
#[derive(Debug, Clone, Default)]
pub struct FetchCursor {
    pub last_fetched_at: Option<String>,
    pub last_source_time: Option<String>,
    pub last_external_ref: Option<String>,
}

pub fn read_cursor(source: &str, parent: &str) -> Result<FetchCursor> {
    let conn = db::read_conn()?;
    let row = conn
        .query_row(
            "SELECT last_fetched_at, last_source_time, last_external_ref
             FROM triage_fetch_cursor
             WHERE source = ?1 AND source_parent = ?2",
            params![source, parent],
            |row| {
                Ok(FetchCursor {
                    last_fetched_at: row.get(0)?,
                    last_source_time: row.get(1)?,
                    last_external_ref: row.get(2)?,
                })
            },
        )
        .optional()
        .context("read triage_fetch_cursor")?;
    Ok(row.unwrap_or_default())
}

pub fn write_cursor(source: &str, parent: &str, cursor: &FetchCursor) -> Result<()> {
    let now = now_iso();
    let last_fetched_at = cursor
        .last_fetched_at
        .clone()
        .unwrap_or_else(|| now.clone());
    let conn = db::write_conn()?;
    conn.execute(
        "INSERT INTO triage_fetch_cursor (source, source_parent, last_fetched_at, last_source_time, last_external_ref)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(source, source_parent) DO UPDATE SET
            last_fetched_at = excluded.last_fetched_at,
            last_source_time = COALESCE(excluded.last_source_time, last_source_time),
            last_external_ref = COALESCE(excluded.last_external_ref, last_external_ref)",
        params![
            source,
            parent,
            last_fetched_at,
            cursor.last_source_time,
            cursor.last_external_ref,
        ],
    )
    .context("upsert triage_fetch_cursor")?;
    Ok(())
}

/// Subscription rows tell the fetcher which `source_parent`s to poll.
/// Layer-2 / UI write 'pinned' / 'muted'; the fetcher itself writes
/// 'auto' as it discovers new active sources.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionMode {
    Auto,
    Pinned,
    Muted,
}

impl SubscriptionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SubscriptionMode::Auto => "auto",
            SubscriptionMode::Pinned => "pinned",
            SubscriptionMode::Muted => "muted",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "pinned" => SubscriptionMode::Pinned,
            "muted" => SubscriptionMode::Muted,
            _ => SubscriptionMode::Auto,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Subscription {
    pub source: String,
    pub source_parent: String,
    pub label: Option<String>,
    pub mode: SubscriptionMode,
    pub last_user_activity_at: Option<String>,
}

pub fn upsert_subscription_auto(
    source: &str,
    parent: &str,
    label: Option<&str>,
    last_user_activity_at: Option<&str>,
) -> Result<()> {
    let now = now_iso();
    let conn = db::write_conn()?;
    conn.execute(
        "INSERT INTO triage_source_subscription
            (source, source_parent, label, mode, last_user_activity_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'auto', ?4, ?5, ?5)
         ON CONFLICT(source, source_parent) DO UPDATE SET
            label = COALESCE(excluded.label, label),
            last_user_activity_at = COALESCE(excluded.last_user_activity_at, last_user_activity_at),
            updated_at = excluded.updated_at",
        params![source, parent, label, last_user_activity_at, now],
    )
    .context("upsert triage_source_subscription")?;
    Ok(())
}

pub fn list_subscriptions(source: &str) -> Result<Vec<Subscription>> {
    let conn = db::read_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT source, source_parent, label, mode, last_user_activity_at
             FROM triage_source_subscription
             WHERE source = ?1 AND mode != 'muted'",
        )
        .context("prepare list_subscriptions")?;
    let rows = stmt
        .query_map(params![source], |row| {
            let mode_raw: String = row.get(3)?;
            Ok(Subscription {
                source: row.get(0)?,
                source_parent: row.get(1)?,
                label: row.get(2)?,
                mode: SubscriptionMode::parse(&mode_raw),
                last_user_activity_at: row.get(4)?,
            })
        })
        .context("query list_subscriptions")?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("collect list_subscriptions")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateRow {
    pub id: String,
    pub source: String,
    pub source_kind: String,
    pub source_ref: String,
    pub source_parent: Option<String>,
    pub source_time: String,
    pub sender: Option<String>,
    pub title: Option<String>,
    pub preview: Option<String>,
    pub external_url: Option<String>,
    pub payload_path: String,
    pub payload_bytes: i64,
    pub decision: Option<String>,
}

/// Used by Layer-2 (LLM tick) to read pending candidates. Newest first —
/// Layer-2 decides relevance, the fetcher just hands over recent open rows.
pub fn list_open_candidates(limit: i64) -> Result<Vec<CandidateRow>> {
    let conn = db::read_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, source, source_kind, source_ref, source_parent,
                    source_time, sender, title, preview, external_url,
                    payload_path, payload_bytes, decision
             FROM triage_candidate
             WHERE decision IS NULL
             ORDER BY source_time DESC
             LIMIT ?1",
        )
        .context("prepare list_open_candidates")?;
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(CandidateRow {
                id: row.get(0)?,
                source: row.get(1)?,
                source_kind: row.get(2)?,
                source_ref: row.get(3)?,
                source_parent: row.get(4)?,
                source_time: row.get(5)?,
                sender: row.get(6)?,
                title: row.get(7)?,
                preview: row.get(8)?,
                external_url: row.get(9)?,
                payload_path: row.get(10)?,
                payload_bytes: row.get(11)?,
                decision: row.get(12)?,
            })
        })
        .context("query list_open_candidates")?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("collect list_open_candidates")
}

/// Open candidates in the same `source_parent` as a given candidate,
/// excluding the candidate itself. Lets Layer-2 browse "what else is
/// happening in this channel/repo" without paying the cost of opening
/// individual payload files. Cap at `limit` rows; backed by the
/// partial index `idx_triage_candidate_parent_open`.
pub fn list_candidates_in_parent(
    parent: &str,
    exclude_id: Option<&str>,
    limit: i64,
) -> Result<Vec<CandidateRow>> {
    let conn = db::read_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, source, source_kind, source_ref, source_parent,
                    source_time, sender, title, preview, external_url,
                    payload_path, payload_bytes, decision
             FROM triage_candidate
             WHERE decision IS NULL
               AND source_parent = ?1
               AND (?2 IS NULL OR id != ?2)
             ORDER BY source_time DESC
             LIMIT ?3",
        )
        .context("prepare list_candidates_in_parent")?;
    let rows = stmt
        .query_map(params![parent, exclude_id, limit], |row| {
            Ok(CandidateRow {
                id: row.get(0)?,
                source: row.get(1)?,
                source_kind: row.get(2)?,
                source_ref: row.get(3)?,
                source_parent: row.get(4)?,
                source_time: row.get(5)?,
                sender: row.get(6)?,
                title: row.get(7)?,
                preview: row.get(8)?,
                external_url: row.get(9)?,
                payload_path: row.get(10)?,
                payload_bytes: row.get(11)?,
                decision: row.get(12)?,
            })
        })
        .context("query list_candidates_in_parent")?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("collect list_candidates_in_parent")
}

pub fn count_open_candidates() -> Result<i64> {
    let conn = db::read_conn()?;
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM triage_candidate WHERE decision IS NULL",
            [],
            |row| row.get(0),
        )
        .context("count open candidates")?;
    Ok(n)
}

/// Look up one candidate row by id. Used by the Tauri command bridge
/// when the LLM hands us a `candidate_id` and we need (payload_path,
/// source, source_ref, etc.) to fulfil the call.
pub fn get_candidate(id: &str) -> Result<Option<CandidateRow>> {
    let conn = db::read_conn()?;
    let row = conn
        .query_row(
            "SELECT id, source, source_kind, source_ref, source_parent,
                    source_time, sender, title, preview, external_url,
                    payload_path, payload_bytes, decision
             FROM triage_candidate WHERE id = ?1",
            params![id],
            |row| {
                Ok(CandidateRow {
                    id: row.get(0)?,
                    source: row.get(1)?,
                    source_kind: row.get(2)?,
                    source_ref: row.get(3)?,
                    source_parent: row.get(4)?,
                    source_time: row.get(5)?,
                    sender: row.get(6)?,
                    title: row.get(7)?,
                    preview: row.get(8)?,
                    external_url: row.get(9)?,
                    payload_path: row.get(10)?,
                    payload_bytes: row.get(11)?,
                    decision: row.get(12)?,
                })
            },
        )
        .optional()
        .context("get_candidate")?;
    Ok(row)
}

/// Used by Layer-2 to record a verdict on one candidate.
pub fn record_decision(id: &str, decision: &str, reason: Option<&str>) -> Result<()> {
    let now = now_iso();
    let conn = db::write_conn()?;
    conn.execute(
        "UPDATE triage_candidate SET decision = ?1, decision_at = ?2, reason = ?3 WHERE id = ?4",
        params![decision, now, reason, id],
    )
    .context("record candidate decision")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn env() -> crate::testkit::TestEnv {
        crate::testkit::TestEnv::new("triage_storage")
    }

    fn make(id: &str, source_ref: &str) -> NewCandidate {
        NewCandidate {
            id: id.into(),
            source: "github".into(),
            source_kind: "issue".into(),
            source_ref: source_ref.into(),
            source_parent: Some("foo/bar".into()),
            source_time: Utc.with_ymd_and_hms(2026, 5, 26, 10, 0, 0).unwrap(),
            sender: Some("alice".into()),
            title: Some("Bug: pipeline drops deltas".into()),
            preview: Some("repro: ...".into()),
            external_url: Some("https://example.com/issue/1".into()),
            payload_path: format!("github/{id}.md"),
            payload_bytes: 100,
        }
    }

    #[test]
    fn insert_then_update_preserves_open_row() {
        let _e = env();
        let c1 = make("gh:1", "1");
        let r1 = upsert_candidate(&c1).unwrap();
        assert_eq!(r1, UpsertOutcome::Inserted);

        // Same source_ref → UpdatedUnchanged path (refresh metadata).
        let mut c2 = make("gh:1", "1");
        c2.title = Some("Bug: pipeline drops deltas (updated)".into());
        let r2 = upsert_candidate(&c2).unwrap();
        assert_eq!(r2, UpsertOutcome::UpdatedUnchanged);

        let open = list_open_candidates(10).unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(
            open[0].title.as_deref(),
            Some("Bug: pipeline drops deltas (updated)")
        );
    }

    #[test]
    fn decided_candidate_is_not_resurrected() {
        let _e = env();
        let c = make("gh:1", "1");
        upsert_candidate(&c).unwrap();
        record_decision("gh:1", "skip", Some("not actionable")).unwrap();

        // Refetching → SkippedDecided.
        let again = upsert_candidate(&c).unwrap();
        assert_eq!(again, UpsertOutcome::SkippedDecided);

        // And it's no longer in the open list.
        assert_eq!(list_open_candidates(10).unwrap().len(), 0);
        assert_eq!(count_open_candidates().unwrap(), 0);
    }

    #[test]
    fn cursor_round_trips() {
        let _e = env();
        let cursor = FetchCursor {
            last_fetched_at: Some("2026-05-26T10:00:00Z".into()),
            last_source_time: Some("2026-05-26T09:00:00Z".into()),
            last_external_ref: Some("123".into()),
        };
        write_cursor("github", "foo/bar", &cursor).unwrap();
        let got = read_cursor("github", "foo/bar").unwrap();
        assert_eq!(
            got.last_source_time.as_deref(),
            Some("2026-05-26T09:00:00Z")
        );
        assert_eq!(got.last_external_ref.as_deref(), Some("123"));
    }

    #[test]
    fn cursor_partial_update_preserves_old_fields() {
        let _e = env();
        write_cursor(
            "github",
            "foo/bar",
            &FetchCursor {
                last_fetched_at: Some("2026-05-26T10:00:00Z".into()),
                last_source_time: Some("2026-05-26T09:00:00Z".into()),
                last_external_ref: Some("first".into()),
            },
        )
        .unwrap();
        // Partial: only `last_fetched_at` set.
        write_cursor(
            "github",
            "foo/bar",
            &FetchCursor {
                last_fetched_at: Some("2026-05-26T11:00:00Z".into()),
                last_source_time: None,
                last_external_ref: None,
            },
        )
        .unwrap();
        let got = read_cursor("github", "foo/bar").unwrap();
        // last_source_time preserved via COALESCE.
        assert_eq!(
            got.last_source_time.as_deref(),
            Some("2026-05-26T09:00:00Z")
        );
        assert_eq!(got.last_external_ref.as_deref(), Some("first"));
        assert_eq!(got.last_fetched_at.as_deref(), Some("2026-05-26T11:00:00Z"));
    }

    #[test]
    fn subscription_upsert_auto_then_pinned() {
        let _e = env();
        upsert_subscription_auto("lark", "oc_x", Some("eng-frontend"), None).unwrap();
        let subs = list_subscriptions("lark").unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].mode, SubscriptionMode::Auto);

        // Pin via raw SQL — public API for that lives outside the fetcher.
        db::write_conn()
            .unwrap()
            .execute(
                "UPDATE triage_source_subscription SET mode = 'muted'
                 WHERE source = 'lark' AND source_parent = 'oc_x'",
                [],
            )
            .unwrap();
        assert_eq!(list_subscriptions("lark").unwrap().len(), 0);
    }
}
