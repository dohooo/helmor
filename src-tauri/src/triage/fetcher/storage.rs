//! DB ops for `triage_candidate` and `triage_fetch_cursor`. Minimal-by-design — every column has a prod read site.

use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::models::db;

#[derive(Debug, Clone)]
pub struct NewCandidate {
    pub id: String,
    pub source: String,
    pub source_kind: String,
    pub source_ref: String,
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
    /// Row already decided; left alone. IM fetchers explicitly call `reset_decision` when new activity arrives.
    SkippedDecided,
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn fmt_ts(ts: DateTime<Utc>) -> String {
    ts.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Insert if new; otherwise refresh metadata IFF the row is still open
/// (`decision IS NULL`). Decided rows are not touched.
pub fn upsert_candidate(candidate: &NewCandidate) -> Result<UpsertOutcome> {
    let source_time = fmt_ts(candidate.source_time);
    let conn = db::write_conn()?;

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
                    source_time = ?2,
                    sender = ?3,
                    title = ?4,
                    preview = ?5,
                    external_url = ?6,
                    payload_path = ?7,
                    payload_bytes = ?8
                 WHERE source = ?9 AND source_ref = ?10",
                params![
                    &candidate.source_kind,
                    &source_time,
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
                    id, source, source_kind, source_ref,
                    source_time, sender,
                    title, preview, external_url, payload_path, payload_bytes
                ) VALUES (
                    ?1, ?2, ?3, ?4,
                    ?5, ?6,
                    ?7, ?8, ?9, ?10, ?11
                )",
                params![
                    &candidate.id,
                    &candidate.source,
                    &candidate.source_kind,
                    &candidate.source_ref,
                    &source_time,
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

/// Per-`(source, source_parent)` cursor. Only IM fetchers populate it;
/// forge fetchers don't use it at all.
#[derive(Debug, Clone, Default)]
pub struct FetchCursor {
    pub last_source_time: Option<String>,
}

pub fn read_cursor(source: &str, parent: &str) -> Result<FetchCursor> {
    let conn = db::read_conn()?;
    let row = conn
        .query_row(
            "SELECT last_source_time FROM triage_fetch_cursor
             WHERE source = ?1 AND source_parent = ?2",
            params![source, parent],
            |row| {
                Ok(FetchCursor {
                    last_source_time: row.get(0)?,
                })
            },
        )
        .optional()
        .context("read triage_fetch_cursor")?;
    Ok(row.unwrap_or_default())
}

pub fn write_cursor(source: &str, parent: &str, cursor: &FetchCursor) -> Result<()> {
    let conn = db::write_conn()?;
    conn.execute(
        "INSERT INTO triage_fetch_cursor (source, source_parent, last_source_time)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(source, source_parent) DO UPDATE SET
            last_source_time = COALESCE(excluded.last_source_time, last_source_time)",
        params![source, parent, cursor.last_source_time],
    )
    .context("upsert triage_fetch_cursor")?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateRow {
    pub id: String,
    pub source: String,
    pub source_kind: String,
    pub source_ref: String,
    pub source_time: String,
    pub sender: Option<String>,
    pub title: Option<String>,
    pub preview: Option<String>,
    pub external_url: Option<String>,
    pub payload_path: String,
    pub payload_bytes: i64,
    pub decision: Option<String>,
}

/// Used by Layer-2 (LLM tick) to read pending candidates. Newest first.
pub fn list_open_candidates(limit: i64) -> Result<Vec<CandidateRow>> {
    let conn = db::read_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, source, source_kind, source_ref,
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
                source_time: row.get(4)?,
                sender: row.get(5)?,
                title: row.get(6)?,
                preview: row.get(7)?,
                external_url: row.get(8)?,
                payload_path: row.get(9)?,
                payload_bytes: row.get(10)?,
                decision: row.get(11)?,
            })
        })
        .context("query list_open_candidates")?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("collect list_open_candidates")
}

/// Anchors already used for a workspace, by chat. Fed to the LLM so it skips re-proposing.
pub fn proposed_anchors_for_chat(source: &str, chat_id: &str) -> Result<Vec<String>> {
    let conn = db::read_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT triage_source_ref FROM workspaces
             WHERE triage_source_type = ?1
               AND triage_source_ref LIKE ?2
               AND state != 'archived'",
        )
        .context("prepare proposed_anchors_for_chat")?;
    let prefix = format!("{chat_id}:");
    let pattern = format!("{prefix}%");
    let rows = stmt
        .query_map(params![source, pattern], |row| row.get::<_, String>(0))
        .context("query proposed_anchors_for_chat")?;
    let mut anchors = Vec::new();
    for row in rows {
        let full = row?;
        if let Some(anchor) = full.strip_prefix(&prefix) {
            if !anchor.is_empty() {
                anchors.push(anchor.to_string());
            }
        }
    }
    Ok(anchors)
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

/// Look up one candidate row by id.
pub fn get_candidate(id: &str) -> Result<Option<CandidateRow>> {
    let conn = db::read_conn()?;
    let row = conn
        .query_row(
            "SELECT id, source, source_kind, source_ref,
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
                    source_time: row.get(4)?,
                    sender: row.get(5)?,
                    title: row.get(6)?,
                    preview: row.get(7)?,
                    external_url: row.get(8)?,
                    payload_path: row.get(9)?,
                    payload_bytes: row.get(10)?,
                    decision: row.get(11)?,
                })
            },
        )
        .optional()
        .context("get_candidate")?;
    Ok(row)
}

/// Re-open a decided candidate when new activity lands. No-op if already open.
pub fn reset_decision(id: &str) -> Result<()> {
    let conn = db::write_conn()?;
    conn.execute(
        "UPDATE triage_candidate
         SET decision = NULL
         WHERE id = ?1 AND decision IS NOT NULL",
        params![id],
    )
    .context("reset triage_candidate.decision")?;
    Ok(())
}

/// Used by Layer-2 to record a verdict on one candidate.
pub fn record_decision(id: &str, decision: &str, _reason: Option<&str>) -> Result<()> {
    let conn = db::write_conn()?;
    conn.execute(
        "UPDATE triage_candidate SET decision = ?1 WHERE id = ?2",
        params![decision, id],
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

        let again = upsert_candidate(&c).unwrap();
        assert_eq!(again, UpsertOutcome::SkippedDecided);

        assert_eq!(list_open_candidates(10).unwrap().len(), 0);
        assert_eq!(count_open_candidates().unwrap(), 0);
    }

    #[test]
    fn reset_decision_reopens_a_decided_row() {
        let _e = env();
        let c = make("gh:1", "1");
        upsert_candidate(&c).unwrap();
        record_decision("gh:1", "skip", None).unwrap();
        assert_eq!(count_open_candidates().unwrap(), 0);
        reset_decision("gh:1").unwrap();
        assert_eq!(count_open_candidates().unwrap(), 1);
    }

    #[test]
    fn cursor_round_trips() {
        let _e = env();
        let cursor = FetchCursor {
            last_source_time: Some("2026-05-26T09:00:00Z".into()),
        };
        write_cursor("lark", "oc_xxx", &cursor).unwrap();
        let got = read_cursor("lark", "oc_xxx").unwrap();
        assert_eq!(
            got.last_source_time.as_deref(),
            Some("2026-05-26T09:00:00Z")
        );
    }
}
