//! Runtime process registry — tracks every PTY-backed script /
//! terminal Helmor spawns so a crash recovery sweep can identify
//! stale processes on the next launch.
//!
//! Design goals (conservative-on-purpose):
//!
//! - **Record on spawn, mark ended on exit.** `record_started` writes
//!   a row when the child is registered with `ScriptProcessManager`;
//!   `record_ended` stamps `ended_at` once the manager's owner thread
//!   reaps the child (whether via natural exit, user-initiated kill,
//!   or the graceful-quit `kill_all`).
//! - **No auto-kill on startup.** [`classify_stale_processes`] looks
//!   at rows whose `ended_at` is still NULL after an app restart and
//!   classifies them as either "definitely dead" (PID returns ESRCH;
//!   we mark them ended) or "maybe alive" (PID still answers signal-0
//!   poll; we surface the row but leave the process untouched). PIDs
//!   can be reused by the OS, so blindly killing a "maybe alive"
//!   process would risk hitting an unrelated user process.
//! - **No "kill by port".** Out of scope; the registry is the
//!   identity-based pathway. Killing by listening port is rejected by
//!   the contribution plan because it can't prove ownership.
//!
//! Today the registry is a startup diagnostic only — it logs what it
//! finds. A later UI slice can decide whether to surface the "maybe
//! alive" rows to the user; the data is already here.

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::models::db;

/// One stale runtime row carried out of the startup sweep so the
/// rest of the app (logging, future diagnostics UI) can decide what
/// to do with it. `verdict` answers the only question that matters
/// for decision-making: do we have any evidence the process is still
/// alive?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleRuntimeProcess {
    pub id: String,
    pub repo_id: String,
    pub workspace_id: Option<String>,
    pub script_type: String,
    pub pid: i32,
    pub pgid: i32,
    pub started_at: String,
    pub verdict: StaleProcessVerdict,
}

/// Outcome of the per-row liveness probe. `Dead` rows have already
/// had their `ended_at` stamped by [`classify_stale_processes`];
/// `MaybeAlive` rows are left as-is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StaleProcessVerdict {
    /// `kill(pid, 0)` returned `ESRCH` — the kernel has no such
    /// process. The row was marked ended as part of classification.
    Dead,
    /// `kill(pid, 0)` succeeded (or returned `EPERM`, indicating the
    /// PID exists but is owned by another user). The row is left
    /// `ended_at IS NULL` and reported here so callers can decide.
    MaybeAlive,
}

/// Persist a row for a freshly-spawned script/terminal process. The
/// returned id is used by `record_ended` (and any future surface
/// that wants to address the registry row directly).
pub fn record_started(
    repo_id: &str,
    workspace_id: Option<&str>,
    script_type: &str,
    pid: libc::pid_t,
    pgid: libc::pid_t,
) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db::write_conn()
        .context("Failed to borrow write connection for runtime registry insert")?;
    conn.execute(
        "INSERT INTO runtime_processes (id, repo_id, workspace_id, script_type, pid, pgid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            id,
            repo_id,
            workspace_id,
            script_type,
            pid as i64,
            pgid as i64,
        ],
    )
    .with_context(|| format!("Failed to record runtime process {pid} in registry"))?;
    Ok(id)
}

/// Stamp `ended_at = now()` for the given row. Idempotent — calling
/// it twice is a no-op the second time (`ended_at` only gets set
/// when it was still NULL).
pub fn record_ended(id: &str) -> Result<()> {
    let conn = db::write_conn()
        .context("Failed to borrow write connection for runtime registry update")?;
    conn.execute(
        "UPDATE runtime_processes
         SET ended_at = datetime('now')
         WHERE id = ?1 AND ended_at IS NULL",
        [id],
    )
    .with_context(|| format!("Failed to mark runtime process {id} as ended"))?;
    Ok(())
}

/// Force-stamp every still-open row to `ended_at = now()` — used by
/// the graceful-quit path so the next launch's classification sweep
/// doesn't waste cycles probing PIDs that we already terminated via
/// `kill_all`. Returns the number of rows stamped.
pub fn record_all_ended() -> Result<usize> {
    let conn =
        db::write_conn().context("Failed to borrow write connection for runtime registry sweep")?;
    let affected = conn
        .execute(
            "UPDATE runtime_processes
             SET ended_at = datetime('now')
             WHERE ended_at IS NULL",
            [],
        )
        .context("Failed to mark live runtime registry rows as ended")?;
    Ok(affected)
}

/// Startup classification sweep. Reads every row whose `ended_at` is
/// still NULL — those are entries from a prior process that didn't
/// reach the graceful-quit cleanup — probes each PID via
/// `kill(pid, 0)`, marks the dead ones as ended, and returns the
/// "maybe alive" ones so the caller can log or surface them.
pub fn classify_stale_processes() -> Result<Vec<StaleRuntimeProcess>> {
    let mut conn = db::write_conn()
        .context("Failed to borrow write connection for runtime registry classification")?;
    classify_stale_processes_in(&mut conn)
}

/// Inner helper that operates on a caller-supplied connection so
/// tests can drive the classification against an in-memory DB
/// without spinning up the connection pool.
pub fn classify_stale_processes_in(conn: &mut Connection) -> Result<Vec<StaleRuntimeProcess>> {
    let candidates: Vec<RawRuntimeRow> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, repo_id, workspace_id, script_type, pid, pgid, started_at
                 FROM runtime_processes
                 WHERE ended_at IS NULL",
            )
            .context("Failed to prepare runtime registry stale-row query")?;
        let iter = stmt
            .query_map([], |row| {
                Ok(RawRuntimeRow {
                    id: row.get(0)?,
                    repo_id: row.get(1)?,
                    workspace_id: row.get(2)?,
                    script_type: row.get(3)?,
                    pid: row.get::<_, i64>(4)? as i32,
                    pgid: row.get::<_, i64>(5)? as i32,
                    started_at: row.get(6)?,
                })
            })
            .context("Failed to read stale runtime rows")?;
        iter.collect::<rusqlite::Result<Vec<_>>>()
            .context("Failed to materialise stale runtime rows")?
    };

    let mut maybe_alive = Vec::new();
    let tx = conn
        .transaction()
        .context("Failed to start runtime registry classify transaction")?;
    for row in candidates {
        let alive = probe_pid_alive(row.pid as libc::pid_t);
        if alive {
            maybe_alive.push(StaleRuntimeProcess {
                id: row.id,
                repo_id: row.repo_id,
                workspace_id: row.workspace_id,
                script_type: row.script_type,
                pid: row.pid,
                pgid: row.pgid,
                started_at: row.started_at,
                verdict: StaleProcessVerdict::MaybeAlive,
            });
        } else {
            tx.execute(
                "UPDATE runtime_processes
                 SET ended_at = datetime('now')
                 WHERE id = ?1 AND ended_at IS NULL",
                [&row.id],
            )
            .with_context(|| format!("Failed to stamp ended_at on dead runtime row {}", row.id))?;
        }
    }
    tx.commit()
        .context("Failed to commit runtime registry classify transaction")?;
    Ok(maybe_alive)
}

/// Public hook for the startup setup path. Runs the classification
/// sweep and logs a single line at INFO summarising the counts, then
/// returns the "maybe alive" rows so future surfaces can pick them up.
pub fn run_startup_classification() -> Result<Vec<StaleRuntimeProcess>> {
    let maybe_alive = classify_stale_processes()?;
    let dead_marked = {
        let conn = db::read_conn().context("Failed to borrow read conn for classify summary")?;
        // Rows we stamped this run all have `ended_at` ≥ a moment
        // ago; this query bounds the count without needing a wider
        // schema. Best-effort — a parse error degrades to zero, the
        // headline number is informational.
        conn.query_row(
            "SELECT COUNT(*) FROM runtime_processes WHERE ended_at IS NOT NULL",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
    };
    let alive_count = maybe_alive.len();
    if alive_count > 0 {
        tracing::warn!(
            maybe_alive = alive_count,
            historical_ended = dead_marked,
            "Runtime registry: stale processes from a prior launch may still be running"
        );
        for row in &maybe_alive {
            tracing::warn!(
                pid = row.pid,
                pgid = row.pgid,
                script_type = %row.script_type,
                workspace_id = ?row.workspace_id,
                "Runtime registry: probable live process from prior launch"
            );
        }
    } else if dead_marked > 0 {
        tracing::debug!(
            historical_ended = dead_marked,
            "Runtime registry: startup sweep had no live stale processes"
        );
    }
    Ok(maybe_alive)
}

struct RawRuntimeRow {
    id: String,
    repo_id: String,
    workspace_id: Option<String>,
    script_type: String,
    pid: i32,
    pgid: i32,
    started_at: String,
}

/// `kill(pid, 0)` returns 0 if the PID is alive (or `EPERM` if it
/// exists but is owned by another user) and `-1` with `errno = ESRCH`
/// if it doesn't. We treat `EPERM` as alive too — it means the kernel
/// has a process by that PID, even if we can't signal it.
fn probe_pid_alive(pid: libc::pid_t) -> bool {
    if pid <= 0 {
        return false;
    }
    let ret = unsafe { libc::kill(pid, 0) };
    if ret == 0 {
        return true;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => false,
        // `EPERM` (process exists, signal not permitted) keeps us in
        // the "maybe alive" camp — conservative classification matches
        // the plan's "only auto-kill when ownership is proven" rule.
        Some(libc::EPERM) => true,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestEnv;

    fn seed_row(
        conn: &Connection,
        id: &str,
        pid: libc::pid_t,
        pgid: libc::pid_t,
        ended_at: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO runtime_processes (id, repo_id, workspace_id, script_type, pid, pgid, ended_at)
             VALUES (?1, 'r1', 'w1', 'run', ?2, ?3, ?4)",
            rusqlite::params![id, pid as i64, pgid as i64, ended_at],
        )
        .unwrap();
    }

    fn run_test_classification(env: &TestEnv) -> Vec<StaleRuntimeProcess> {
        let mut conn = env.db_connection();
        classify_stale_processes_in(&mut conn).expect("classification")
    }

    fn read_ended_at(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row(
            "SELECT ended_at FROM runtime_processes WHERE id = ?1",
            [id],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap()
    }

    // ── record_started / record_ended round-trip ──────────────────────

    #[test]
    fn record_started_and_record_ended_round_trip() {
        let env = TestEnv::new("runtime-record");
        let id = record_started("r1", Some("w1"), "run", 12345, 12345).unwrap();
        let row_pid: i64 = env
            .db_connection()
            .query_row(
                "SELECT pid FROM runtime_processes WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(row_pid, 12345);
        assert!(read_ended_at(&env.db_connection(), &id).is_none());

        record_ended(&id).unwrap();
        let ended = read_ended_at(&env.db_connection(), &id).expect("ended_at stamped");
        assert!(!ended.is_empty(), "ended_at should be a timestamp string");

        // Idempotent: re-calling doesn't clobber the stamp.
        record_ended(&id).unwrap();
        let ended_again = read_ended_at(&env.db_connection(), &id).unwrap();
        assert_eq!(ended, ended_again);
    }

    #[test]
    fn record_all_ended_stamps_only_live_rows() {
        let env = TestEnv::new("runtime-record-all");
        let conn = env.db_connection();
        seed_row(&conn, "live-1", 100, 100, None);
        seed_row(&conn, "live-2", 200, 200, None);
        seed_row(
            &conn,
            "already-ended",
            300,
            300,
            Some("2026-01-01T00:00:00Z"),
        );

        let affected = record_all_ended().unwrap();
        assert_eq!(affected, 2);
        // Pre-stamped row's `ended_at` stays at the seed value.
        assert_eq!(
            read_ended_at(&env.db_connection(), "already-ended").as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert!(read_ended_at(&env.db_connection(), "live-1").is_some());
        assert!(read_ended_at(&env.db_connection(), "live-2").is_some());
    }

    // ── classify_stale_processes ──────────────────────────────────────

    /// PIDs in the [0, 1] range are guaranteed to either be invalid
    /// (`0`) or `init` (`1`). `init` is owned by root, so a
    /// non-privileged test runner gets `EPERM` from `kill(1, 0)` —
    /// which we classify as `MaybeAlive`. We use it as the "alive"
    /// sentinel so the test is deterministic without spawning a
    /// real child.
    const ALIVE_SENTINEL_PID: libc::pid_t = 1;

    /// `kill(pid, 0)` on a PID we just chose at random from far
    /// outside the OS's reuse window returns `ESRCH`. Picking the
    /// max valid 32-bit PID maximises the chance the OS never
    /// allocated it.
    const DEAD_SENTINEL_PID: libc::pid_t = i32::MAX;

    #[test]
    fn classify_marks_dead_rows_ended_and_reports_maybe_alive() {
        let env = TestEnv::new("runtime-classify");
        let conn = env.db_connection();
        seed_row(
            &conn,
            "dead-row",
            DEAD_SENTINEL_PID,
            DEAD_SENTINEL_PID,
            None,
        );
        seed_row(
            &conn,
            "alive-row",
            ALIVE_SENTINEL_PID,
            ALIVE_SENTINEL_PID,
            None,
        );

        let maybe_alive = run_test_classification(&env);

        assert_eq!(
            maybe_alive.len(),
            1,
            "exactly one row should be reported as alive"
        );
        assert_eq!(maybe_alive[0].id, "alive-row");
        assert_eq!(maybe_alive[0].verdict, StaleProcessVerdict::MaybeAlive);

        // Dead row was stamped, alive row was not.
        assert!(
            read_ended_at(&env.db_connection(), "dead-row").is_some(),
            "dead row should have ended_at stamped"
        );
        assert!(
            read_ended_at(&env.db_connection(), "alive-row").is_none(),
            "maybe-alive row must NOT be stamped (we don't kill on conservative classify)"
        );
    }

    #[test]
    fn classify_with_no_open_rows_is_noop() {
        let env = TestEnv::new("runtime-classify-empty");
        // No seeded rows. Should return an empty vec without
        // touching the DB.
        let maybe_alive = run_test_classification(&env);
        assert!(maybe_alive.is_empty());
    }

    #[test]
    fn classify_ignores_already_ended_rows() {
        let env = TestEnv::new("runtime-classify-skip-ended");
        let conn = env.db_connection();
        // An already-ended row whose PID happens to still be alive.
        // The classifier must NOT report it because the row was
        // already closed out by a previous run.
        seed_row(
            &conn,
            "old-ended",
            ALIVE_SENTINEL_PID,
            ALIVE_SENTINEL_PID,
            Some("2026-01-01T00:00:00Z"),
        );

        let maybe_alive = run_test_classification(&env);
        assert!(maybe_alive.is_empty());
        // Stamp is preserved exactly — classification doesn't rewrite
        // an existing ended_at.
        assert_eq!(
            read_ended_at(&env.db_connection(), "old-ended").as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
    }

    // ── probe_pid_alive ──────────────────────────────────────────────

    #[test]
    fn probe_pid_alive_returns_false_for_invalid_pids() {
        assert!(!probe_pid_alive(0));
        assert!(!probe_pid_alive(-1));
    }

    #[test]
    fn probe_pid_alive_returns_true_for_init() {
        // init / launchd always exists, and we don't have signal
        // permission on it — `EPERM` is what makes it useful as a
        // deterministic "maybe alive" sentinel.
        assert!(probe_pid_alive(ALIVE_SENTINEL_PID));
    }

    #[test]
    fn probe_pid_alive_returns_false_for_clearly_dead_pid() {
        assert!(!probe_pid_alive(DEAD_SENTINEL_PID));
    }
}
