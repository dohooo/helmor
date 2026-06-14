//! Persistence for scheduled automations.
//!
//! SQLite is the single source of truth for scheduling: `next_run_at` and
//! `status` live here, and the in-process scheduler is a stateless poll loop
//! over this table. The two scheduler primitives (`due_automations`,
//! `claim_automation`) implement claim-before-dispatch: a CAS-style UPDATE on
//! `next_run_at` guarantees at-most-once firing per slot across restarts,
//! crashes, and racing ticks. Timestamps use the `db::current_timestamp()`
//! RFC3339-UTC-millis format, which orders chronologically as plain strings.

use anyhow::{Context, Result};
use rusqlite::params;
use serde::Serialize;

use crate::models::db;

pub const RUNS_IN_CHAT: &str = "chat";
pub const RUNS_IN_WORKSPACE: &str = "workspace";
pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_PAUSED: &str = "paused";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRecord {
    pub id: String,
    pub title: String,
    pub prompt: String,
    /// `chat` (append runs to the bound session) or `workspace` (create a new
    /// session per run in the bound workspace).
    pub runs_in: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    /// Schedule spec as JSON (see `automations::schedule::Schedule`). Stored
    /// opaque here so the persistence layer stays independent of domain types.
    pub schedule: serde_json::Value,
    pub status: String,
    pub next_run_at: String,
    pub last_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct NewAutomation<'a> {
    pub title: &'a str,
    pub prompt: &'a str,
    pub runs_in: &'a str,
    pub session_id: Option<&'a str>,
    pub workspace_id: Option<&'a str>,
    pub schedule: &'a serde_json::Value,
    pub next_run_at: &'a str,
}

const SELECT_COLUMNS: &str = "id, title, prompt, runs_in, session_id, workspace_id, schedule, \
     status, next_run_at, last_run_at, created_at, updated_at";

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(AutomationRecord, String)> {
    let schedule_raw: String = row.get(6)?;
    Ok((
        AutomationRecord {
            id: row.get(0)?,
            title: row.get(1)?,
            prompt: row.get(2)?,
            runs_in: row.get(3)?,
            session_id: row.get(4)?,
            workspace_id: row.get(5)?,
            schedule: serde_json::Value::Null,
            status: row.get(7)?,
            next_run_at: row.get(8)?,
            last_run_at: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        },
        schedule_raw,
    ))
}

fn parse_schedule(
    (mut record, schedule_raw): (AutomationRecord, String),
) -> Result<AutomationRecord> {
    record.schedule = serde_json::from_str(&schedule_raw).with_context(|| {
        format!(
            "automation {} has unparseable schedule JSON: {schedule_raw}",
            record.id
        )
    })?;
    Ok(record)
}

/// List all automations, newest first.
pub fn list_automations() -> Result<Vec<AutomationRecord>> {
    let conn = db::read_conn()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM automations ORDER BY created_at DESC"
    ))?;
    let rows = stmt
        .query_map([], record_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(parse_schedule).collect()
}

pub fn get_automation(id: &str) -> Result<Option<AutomationRecord>> {
    let conn = db::read_conn()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM automations WHERE id = ?1"
    ))?;
    let mut rows = stmt
        .query_map(params![id], record_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    match rows.pop() {
        Some(raw) => Ok(Some(parse_schedule(raw)?)),
        None => Ok(None),
    }
}

pub fn insert_automation(new: &NewAutomation<'_>) -> Result<AutomationRecord> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = db::current_timestamp()?;
    let schedule_raw = new.schedule.to_string();
    let conn = db::write_conn()?;
    conn.execute(
        "INSERT INTO automations \
         (id, title, prompt, runs_in, session_id, workspace_id, schedule, status, next_run_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            id,
            new.title,
            new.prompt,
            new.runs_in,
            new.session_id,
            new.workspace_id,
            schedule_raw,
            STATUS_ACTIVE,
            new.next_run_at,
            now,
        ],
    )?;
    Ok(AutomationRecord {
        id,
        title: new.title.to_string(),
        prompt: new.prompt.to_string(),
        runs_in: new.runs_in.to_string(),
        session_id: new.session_id.map(str::to_string),
        workspace_id: new.workspace_id.map(str::to_string),
        schedule: new.schedule.clone(),
        status: STATUS_ACTIVE.to_string(),
        next_run_at: new.next_run_at.to_string(),
        last_run_at: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Write back every editable field of a (read-modify-write) record.
/// Callers recompute `next_run_at` before saving when the schedule changed.
pub fn update_automation_record(record: &AutomationRecord) -> Result<()> {
    let now = db::current_timestamp()?;
    let conn = db::write_conn()?;
    conn.execute(
        "UPDATE automations SET title = ?2, prompt = ?3, runs_in = ?4, session_id = ?5, \
         workspace_id = ?6, schedule = ?7, status = ?8, next_run_at = ?9, updated_at = ?10 \
         WHERE id = ?1",
        params![
            record.id,
            record.title,
            record.prompt,
            record.runs_in,
            record.session_id,
            record.workspace_id,
            record.schedule.to_string(),
            record.status,
            record.next_run_at,
            now,
        ],
    )?;
    Ok(())
}

/// Pause/resume. Resume passes a freshly computed `next_run_at` (from now) so
/// a long-paused automation never fires immediately on resume.
pub fn set_automation_status(id: &str, status: &str, next_run_at: Option<&str>) -> Result<()> {
    let now = db::current_timestamp()?;
    let conn = db::write_conn()?;
    match next_run_at {
        Some(next) => conn.execute(
            "UPDATE automations SET status = ?2, next_run_at = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, status, next, now],
        )?,
        None => conn.execute(
            "UPDATE automations SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, status, now],
        )?,
    };
    Ok(())
}

/// Record a manual "Run now" without touching the schedule.
pub fn set_last_run_at(id: &str, last_run_at: &str) -> Result<()> {
    let conn = db::write_conn()?;
    conn.execute(
        "UPDATE automations SET last_run_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![id, last_run_at],
    )?;
    Ok(())
}

pub fn delete_automation(id: &str) -> Result<()> {
    let conn = db::write_conn()?;
    conn.execute("DELETE FROM automations WHERE id = ?1", params![id])?;
    Ok(())
}

/// Cascade-delete automations bound to a session. Runs on the caller's
/// connection/transaction (the writer pool is single-slot, so a session-delete
/// transaction must drop its automations inline, not via a nested `write_conn`).
/// `automations` has no FK because `foreign_keys` is OFF app-wide.
pub fn delete_automations_for_session(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM automations WHERE session_id = ?1",
        params![session_id],
    )
}

/// Cascade-delete automations bound to a workspace — both `workspace`-mode rows
/// and `chat`-mode rows whose session lives in that workspace. Must run BEFORE
/// the workspace's `sessions` rows are deleted (the subquery needs them).
pub fn delete_automations_for_workspace(
    conn: &rusqlite::Connection,
    workspace_id: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM automations \
         WHERE workspace_id = ?1 \
            OR session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
        params![workspace_id],
    )
}

// ── Scheduler primitives ────────────────────────────────────────────────────

/// Active automations whose `next_run_at` is due at `now`, oldest first.
pub fn due_automations(now: &str) -> Result<Vec<AutomationRecord>> {
    let conn = db::read_conn()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM automations \
         WHERE status = ?1 AND next_run_at <= ?2 ORDER BY next_run_at ASC"
    ))?;
    let rows = stmt
        .query_map(params![STATUS_ACTIVE, now], record_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(parse_schedule).collect()
}

/// Claim a due slot: CAS on `next_run_at` so exactly one claimer wins, even
/// across racing ticks or instances. Sets `last_run_at = now` as part of the
/// claim. Returns false when someone else already claimed (or the automation
/// was edited/paused since it was read).
pub fn claim_automation(
    id: &str,
    old_next_run_at: &str,
    new_next_run_at: &str,
    now: &str,
) -> Result<bool> {
    let conn = db::write_conn()?;
    let changed = conn.execute(
        "UPDATE automations SET next_run_at = ?3, last_run_at = ?4, updated_at = ?4 \
         WHERE id = ?1 AND next_run_at = ?2 AND status = ?5",
        params![id, old_next_run_at, new_next_run_at, now, STATUS_ACTIVE],
    )?;
    Ok(changed == 1)
}

/// Roll back a claim whose dispatch was rejected (e.g. the bound session was
/// concurrently busy). CAS-guarded on the claimed value so a concurrent edit
/// is never stomped; `last_run_at` is restored because the run never happened.
pub fn unclaim_automation(
    id: &str,
    claimed_next_run_at: &str,
    previous_next_run_at: &str,
    previous_last_run_at: Option<&str>,
) -> Result<()> {
    let now = db::current_timestamp()?;
    let conn = db::write_conn()?;
    conn.execute(
        "UPDATE automations SET next_run_at = ?3, last_run_at = ?4, updated_at = ?5 \
         WHERE id = ?1 AND next_run_at = ?2",
        params![
            id,
            claimed_next_run_at,
            previous_next_run_at,
            previous_last_run_at,
            now
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_sample(title: &str, next_run_at: &str) -> AutomationRecord {
        insert_automation(&NewAutomation {
            title,
            prompt: "check the thing",
            runs_in: RUNS_IN_CHAT,
            session_id: Some("session-1"),
            workspace_id: None,
            schedule: &serde_json::json!({"kind": "hourly"}),
            next_run_at,
        })
        .unwrap()
    }

    #[test]
    fn crud_roundtrip() {
        let _env = crate::testkit::TestEnv::new("automations-crud");

        let created = insert_sample("Order monitor", "2026-01-01T00:00:00.000Z");
        let listed = list_automations().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
        assert_eq!(listed[0].schedule, serde_json::json!({"kind": "hourly"}));
        assert_eq!(listed[0].status, STATUS_ACTIVE);

        let mut record = get_automation(&created.id).unwrap().unwrap();
        record.title = "Renamed".into();
        record.schedule = serde_json::json!({"kind": "daily", "time": "09:00"});
        update_automation_record(&record).unwrap();
        let reloaded = get_automation(&created.id).unwrap().unwrap();
        assert_eq!(reloaded.title, "Renamed");
        assert_eq!(reloaded.schedule["kind"], "daily");

        delete_automation(&created.id).unwrap();
        assert!(get_automation(&created.id).unwrap().is_none());
    }

    #[test]
    fn due_query_excludes_paused_and_future() {
        let _env = crate::testkit::TestEnv::new("automations-due");

        let due = insert_sample("due", "2020-01-01T00:00:00.000Z");
        let paused = insert_sample("paused", "2020-01-01T00:00:00.000Z");
        set_automation_status(&paused.id, STATUS_PAUSED, None).unwrap();
        insert_sample("future", "2999-01-01T00:00:00.000Z");

        let now = db::current_timestamp().unwrap();
        let found = due_automations(&now).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, due.id);
    }

    #[test]
    fn claim_is_exactly_once_and_unclaim_restores() {
        let _env = crate::testkit::TestEnv::new("automations-claim");

        let old_next = "2020-01-01T00:00:00.000Z";
        let record = insert_sample("claimable", old_next);
        let now = db::current_timestamp().unwrap();
        let new_next = "2999-01-01T00:00:00.000Z";

        // Two racing claims with the same observed value: exactly one wins.
        assert!(claim_automation(&record.id, old_next, new_next, &now).unwrap());
        assert!(!claim_automation(&record.id, old_next, new_next, &now).unwrap());

        let claimed = get_automation(&record.id).unwrap().unwrap();
        assert_eq!(claimed.next_run_at, new_next);
        assert_eq!(claimed.last_run_at.as_deref(), Some(now.as_str()));

        // Rolling back a rejected dispatch restores both fields.
        unclaim_automation(&record.id, new_next, old_next, None).unwrap();
        let restored = get_automation(&record.id).unwrap().unwrap();
        assert_eq!(restored.next_run_at, old_next);
        assert_eq!(restored.last_run_at, None);

        // Unclaim is CAS-guarded: a stale rollback never stomps a newer value.
        unclaim_automation(&record.id, new_next, "1999-01-01T00:00:00.000Z", None).unwrap();
        let unchanged = get_automation(&record.id).unwrap().unwrap();
        assert_eq!(unchanged.next_run_at, old_next);
    }

    #[test]
    fn paused_claim_is_rejected() {
        let _env = crate::testkit::TestEnv::new("automations-claim-paused");

        let old_next = "2020-01-01T00:00:00.000Z";
        let record = insert_sample("paused-claim", old_next);
        set_automation_status(&record.id, STATUS_PAUSED, None).unwrap();
        let now = db::current_timestamp().unwrap();
        assert!(!claim_automation(&record.id, old_next, "2999-01-01T00:00:00.000Z", &now).unwrap());
    }
}
