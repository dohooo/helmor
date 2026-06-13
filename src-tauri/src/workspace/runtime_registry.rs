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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeProcessIdentity {
    pub repo_id: String,
    pub workspace_id: Option<String>,
    pub script_type: String,
    pub pid: i32,
    pub pgid: i32,
}

/// Persist a row for a freshly-spawned script/terminal process. The
/// returned id is used by `record_ended` (and any future surface
/// that wants to address the registry row directly).
pub fn record_started(
    repo_id: &str,
    workspace_id: Option<&str>,
    script_type: &str,
    pid: i32,
    pgid: i32,
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

/// Stamp only the runtime rows that match process identities Helmor just
/// proved gone, leaving prior maybe-alive stale rows open so the next
/// startup can keep reporting them.
pub fn record_processes_ended(processes: &[RuntimeProcessIdentity]) -> Result<usize> {
    let conn = db::write_conn()
        .context("Failed to borrow write connection for runtime registry process update")?;
    record_processes_ended_in(&conn, processes)
}

/// Parse a SQLite `datetime('now')` timestamp ("YYYY-MM-DD HH:MM:SS", UTC) into
/// a Unix epoch. Returns `None` for any unexpected shape so callers treat an
/// unparseable row as "boot session unknown" rather than guessing.
fn started_at_epoch(started_at: &str) -> Option<i64> {
    chrono::NaiveDateTime::parse_from_str(started_at, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|naive| naive.and_utc().timestamp())
}

fn stamp_row_ended(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE runtime_processes
         SET ended_at = datetime('now')
         WHERE id = ?1 AND ended_at IS NULL",
        [id],
    )
    .with_context(|| format!("Failed to stamp ended_at on dead runtime row {id}"))?;
    Ok(())
}

/// Return the newest still-open registry row for this exact process identity
/// when its PID is alive **and** the row was recorded during the current boot
/// session — the only case where the recorded PID is provably still ours.
/// Rows whose PID is dead, or whose PID is alive but predates this boot (and so
/// may have been reused for an unrelated process), are stamped ended instead of
/// returned. When the boot time can't be read at all, an alive PID is left
/// untouched rather than risk signalling a reused one.
pub fn live_process_for_identity(
    repo_id: &str,
    workspace_id: Option<&str>,
    script_type: &str,
) -> Result<Option<RuntimeProcessIdentity>> {
    let conn = db::write_conn()
        .context("Failed to borrow write connection for runtime registry lookup")?;
    let boot_epoch = crate::platform::process::boot_time_epoch();
    live_process_for_identity_in(&conn, repo_id, workspace_id, script_type, boot_epoch)
}

pub fn live_process_for_identity_in(
    conn: &Connection,
    repo_id: &str,
    workspace_id: Option<&str>,
    script_type: &str,
    boot_epoch: Option<i64>,
) -> Result<Option<RuntimeProcessIdentity>> {
    let rows: Vec<RawRuntimeRow> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, repo_id, workspace_id, script_type, pid, pgid, started_at
                 FROM runtime_processes
                 WHERE ended_at IS NULL
                   AND repo_id = ?1
                   AND ((?2 IS NULL AND workspace_id IS NULL) OR workspace_id = ?2)
                   AND script_type = ?3
                 ORDER BY started_at DESC, id DESC",
            )
            .with_context(|| {
                format!("Failed to prepare runtime registry lookup for {repo_id}/{script_type}")
            })?;
        let iter = stmt
            .query_map(
                rusqlite::params![repo_id, workspace_id, script_type],
                |row| {
                    Ok(RawRuntimeRow {
                        id: row.get(0)?,
                        repo_id: row.get(1)?,
                        workspace_id: row.get(2)?,
                        script_type: row.get(3)?,
                        pid: row.get::<_, i64>(4)? as i32,
                        pgid: row.get::<_, i64>(5)? as i32,
                        started_at: row.get(6)?,
                    })
                },
            )
            .context("Failed to read matching runtime registry rows")?;
        iter.collect::<rusqlite::Result<Vec<_>>>()
            .context("Failed to materialise matching runtime registry rows")?
    };

    let mut live = None;
    for row in rows {
        if !probe_pid_alive(row.pid) {
            // No such PID — the process is definitely gone. Close the row.
            stamp_row_ended(conn, &row.id)?;
            continue;
        }

        // The PID is alive, but that alone does not prove it is still *our*
        // process: PIDs are reused across reboots. Only trust it when the row
        // was recorded during the current boot session.
        match (boot_epoch, started_at_epoch(&row.started_at)) {
            (Some(boot), Some(started)) if started >= boot => {
                // Same boot → the live PID is genuinely the process we recorded.
                if live.is_none() {
                    live = Some(RuntimeProcessIdentity {
                        repo_id: row.repo_id,
                        workspace_id: row.workspace_id,
                        script_type: row.script_type,
                        pid: row.pid,
                        pgid: row.pgid,
                    });
                }
            }
            (Some(_), Some(_)) => {
                // Alive PID, but the row predates this boot: the original
                // process is gone and this PID now belongs to something
                // unrelated. Close the stale row; never signal the stranger.
                stamp_row_ended(conn, &row.id)?;
            }
            _ => {
                // Boot session unknown (couldn't read boot time, or the
                // timestamp didn't parse). Refuse to treat a maybe-reused PID
                // as a kill target, and leave the row open — we have no proof
                // it is dead — for a later attempt once we can verify it.
                tracing::warn!(
                    id = %row.id,
                    pid = row.pid,
                    "Runtime registry: cannot verify boot session for a live PID; not targeting it"
                );
            }
        }
    }

    Ok(live)
}

// Caller-supplied connection so tests can drive it against an in-memory DB.
pub fn record_processes_ended_in(
    conn: &Connection,
    processes: &[RuntimeProcessIdentity],
) -> Result<usize> {
    let mut affected = 0;
    for process in processes {
        affected += conn
            .execute(
                "UPDATE runtime_processes
                 SET ended_at = datetime('now')
                 WHERE ended_at IS NULL
                   AND repo_id = ?1
                   AND ((?2 IS NULL AND workspace_id IS NULL) OR workspace_id = ?2)
                   AND script_type = ?3
                   AND pid = ?4
                   AND pgid = ?5",
                rusqlite::params![
                    process.repo_id.as_str(),
                    process.workspace_id.as_deref(),
                    process.script_type.as_str(),
                    process.pid as i64,
                    process.pgid as i64,
                ],
            )
            .with_context(|| {
                format!(
                    "Failed to mark runtime process {} ({}/{}) as ended",
                    process.pid, process.repo_id, process.script_type
                )
            })?;
    }
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
        let alive = probe_pid_alive(row.pid);
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

/// Conservative liveness probe used by the stale-process sweep. Delegates to
/// the cross-platform [`crate::platform::process::pid_alive`], which on Unix
/// treats `EPERM` (process exists but owned by another user) as alive — matching
/// the "only auto-kill when ownership is proven" rule — and on Windows queries
/// the process exit code. Non-positive PIDs are never live.
fn probe_pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    crate::platform::process::pid_alive(pid as crate::platform::process::Pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestEnv;

    fn seed_row(conn: &Connection, id: &str, pid: i32, pgid: i32, ended_at: Option<&str>) {
        seed_identity_row(conn, id, "r1", Some("w1"), "run", pid, pgid, ended_at);
    }

    #[allow(clippy::too_many_arguments)]
    fn seed_identity_row(
        conn: &Connection,
        id: &str,
        repo_id: &str,
        workspace_id: Option<&str>,
        script_type: &str,
        pid: i32,
        pgid: i32,
        ended_at: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO runtime_processes (id, repo_id, workspace_id, script_type, pid, pgid, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                id,
                repo_id,
                workspace_id,
                script_type,
                pid as i64,
                pgid as i64,
                ended_at
            ],
        )
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn seed_identity_row_at(
        conn: &Connection,
        id: &str,
        repo_id: &str,
        workspace_id: Option<&str>,
        script_type: &str,
        pid: i32,
        pgid: i32,
        started_at: &str,
        ended_at: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO runtime_processes (id, repo_id, workspace_id, script_type, pid, pgid, started_at, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                repo_id,
                workspace_id,
                script_type,
                pid as i64,
                pgid as i64,
                started_at,
                ended_at
            ],
        )
        .unwrap();
    }

    // Private in-memory DB so the classify/sweep tests are isolated from the
    // process-global file DB (concurrent writes there made count asserts flaky).
    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory runtime test db");
        crate::models::db::init_connection(&conn, true).expect("init pragmas");
        crate::schema::ensure_schema(&conn).expect("init runtime test schema");
        conn
    }

    fn run_test_classification(conn: &mut Connection) -> Vec<StaleRuntimeProcess> {
        classify_stale_processes_in(conn).expect("classification")
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
    fn record_processes_ended_only_stamps_matching_identities() {
        let conn = fresh_db();
        seed_identity_row(&conn, "match", "r1", Some("w1"), "run", 100, 100, None);
        seed_identity_row(
            &conn,
            "different-pid",
            "r1",
            Some("w1"),
            "run",
            101,
            100,
            None,
        );
        seed_identity_row(
            &conn,
            "different-ws",
            "r1",
            Some("w2"),
            "run",
            100,
            100,
            None,
        );
        seed_identity_row(
            &conn,
            "different-repo",
            "r2",
            Some("w1"),
            "run",
            100,
            100,
            None,
        );
        seed_identity_row(&conn, "no-workspace", "r1", None, "run", 200, 200, None);

        let affected = record_processes_ended_in(
            &conn,
            &[
                RuntimeProcessIdentity {
                    repo_id: "r1".to_string(),
                    workspace_id: Some("w1".to_string()),
                    script_type: "run".to_string(),
                    pid: 100,
                    pgid: 100,
                },
                RuntimeProcessIdentity {
                    repo_id: "r1".to_string(),
                    workspace_id: None,
                    script_type: "run".to_string(),
                    pid: 200,
                    pgid: 200,
                },
            ],
        )
        .unwrap();

        assert_eq!(affected, 2);
        assert!(read_ended_at(&conn, "match").is_some());
        assert!(read_ended_at(&conn, "no-workspace").is_some());
        assert!(read_ended_at(&conn, "different-pid").is_none());
        assert!(read_ended_at(&conn, "different-ws").is_none());
        assert!(read_ended_at(&conn, "different-repo").is_none());
    }

    #[test]
    fn live_process_for_identity_returns_alive_match_and_stamps_dead_matches() {
        let conn = fresh_db();
        seed_identity_row(
            &conn,
            "dead-match",
            "r1",
            Some("w1"),
            "run:action",
            DEAD_SENTINEL_PID,
            DEAD_SENTINEL_PID,
            None,
        );
        seed_identity_row(
            &conn,
            "alive-match",
            "r1",
            Some("w1"),
            "run:action",
            alive_sentinel_pid(),
            alive_sentinel_pid(),
            None,
        );
        seed_identity_row(
            &conn,
            "different-action",
            "r1",
            Some("w1"),
            "run:other",
            DEAD_SENTINEL_PID,
            DEAD_SENTINEL_PID,
            None,
        );

        let live =
            live_process_for_identity_in(&conn, "r1", Some("w1"), "run:action", Some(0)).unwrap();

        assert_eq!(
            live,
            Some(RuntimeProcessIdentity {
                repo_id: "r1".to_string(),
                workspace_id: Some("w1".to_string()),
                script_type: "run:action".to_string(),
                pid: alive_sentinel_pid(),
                pgid: alive_sentinel_pid(),
            })
        );
        assert!(
            read_ended_at(&conn, "dead-match").is_some(),
            "dead matching rows should be closed while searching"
        );
        assert!(
            read_ended_at(&conn, "alive-match").is_none(),
            "live matching rows stay open for the caller to stop"
        );
        assert!(
            read_ended_at(&conn, "different-action").is_none(),
            "non-matching rows must not be touched"
        );
    }

    #[test]
    fn live_process_for_identity_handles_no_workspace_keys() {
        let conn = fresh_db();
        seed_identity_row(
            &conn,
            "no-workspace",
            "r1",
            None,
            "terminal",
            alive_sentinel_pid(),
            alive_sentinel_pid(),
            None,
        );
        seed_identity_row(
            &conn,
            "workspace-row",
            "r1",
            Some("w1"),
            "terminal",
            alive_sentinel_pid(),
            alive_sentinel_pid(),
            None,
        );

        let live = live_process_for_identity_in(&conn, "r1", None, "terminal", Some(0)).unwrap();

        assert_eq!(live.as_ref().and_then(|p| p.workspace_id.as_deref()), None);
        assert_eq!(live.map(|p| p.pid), Some(alive_sentinel_pid()));
    }

    #[test]
    fn live_process_for_identity_refuses_a_pid_recorded_before_this_boot() {
        let conn = fresh_db();
        let boot = started_at_epoch("2026-06-01 00:00:00").expect("parse boot reference");
        // PID is alive (sentinel = our own pid), but the row predates this boot,
        // so the PID may have been reused. It must NOT be offered as a kill
        // target, and the stale row should be closed instead.
        seed_identity_row_at(
            &conn,
            "prior-boot",
            "r1",
            Some("w1"),
            "run:action",
            alive_sentinel_pid(),
            alive_sentinel_pid(),
            "2026-05-01 00:00:00",
            None,
        );

        let live = live_process_for_identity_in(&conn, "r1", Some("w1"), "run:action", Some(boot))
            .unwrap();

        assert!(
            live.is_none(),
            "an alive PID recorded before this boot may be reused; never target it"
        );
        assert!(
            read_ended_at(&conn, "prior-boot").is_some(),
            "the prior-boot row is closed (its original process is gone)"
        );
    }

    #[test]
    fn live_process_for_identity_targets_this_boot_pid_over_a_prior_boot_row() {
        let conn = fresh_db();
        let boot = started_at_epoch("2026-06-01 00:00:00").expect("parse boot reference");
        seed_identity_row_at(
            &conn,
            "prior-boot",
            "r1",
            Some("w1"),
            "run:action",
            alive_sentinel_pid(),
            alive_sentinel_pid(),
            "2026-05-01 00:00:00",
            None,
        );
        seed_identity_row_at(
            &conn,
            "this-boot",
            "r1",
            Some("w1"),
            "run:action",
            alive_sentinel_pid(),
            alive_sentinel_pid(),
            "2026-06-02 00:00:00",
            None,
        );

        let live = live_process_for_identity_in(&conn, "r1", Some("w1"), "run:action", Some(boot))
            .unwrap();

        assert_eq!(
            live.map(|p| p.pid),
            Some(alive_sentinel_pid()),
            "the in-boot row is a valid kill target"
        );
        assert!(
            read_ended_at(&conn, "prior-boot").is_some(),
            "the prior-boot row is closed"
        );
        assert!(
            read_ended_at(&conn, "this-boot").is_none(),
            "the in-boot target stays open for the caller to stop"
        );
    }

    #[test]
    fn live_process_for_identity_will_not_target_a_pid_when_boot_time_is_unknown() {
        let conn = fresh_db();
        seed_identity_row(
            &conn,
            "alive",
            "r1",
            Some("w1"),
            "run:action",
            alive_sentinel_pid(),
            alive_sentinel_pid(),
            None,
        );

        let live =
            live_process_for_identity_in(&conn, "r1", Some("w1"), "run:action", None).unwrap();

        assert!(
            live.is_none(),
            "without a boot reference the PID can't be trusted; do not target it"
        );
        assert!(
            read_ended_at(&conn, "alive").is_none(),
            "an unverifiable live row stays open rather than being closed or killed"
        );
    }

    // ── classify_stale_processes ──────────────────────────────────────

    /// The test process itself is always alive on every platform, so it is a
    /// deterministic "alive" sentinel without spawning a child. (On Unix the
    /// previous sentinel was `init`/PID 1 via `EPERM`; PID 1 does not exist on
    /// Windows, so we use the current PID, which works identically on both.)
    fn alive_sentinel_pid() -> i32 {
        std::process::id() as i32
    }

    /// The max 32-bit PID is far outside any OS's reuse window, so a liveness
    /// probe returns "dead" on both Unix (`ESRCH`) and Windows (`OpenProcess`
    /// fails).
    const DEAD_SENTINEL_PID: i32 = i32::MAX;

    #[test]
    fn classify_marks_dead_rows_ended_and_reports_maybe_alive() {
        let mut conn = fresh_db();
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
            alive_sentinel_pid(),
            alive_sentinel_pid(),
            None,
        );

        let maybe_alive = run_test_classification(&mut conn);

        assert_eq!(
            maybe_alive.len(),
            1,
            "exactly one row should be reported as alive"
        );
        assert_eq!(maybe_alive[0].id, "alive-row");
        assert_eq!(maybe_alive[0].verdict, StaleProcessVerdict::MaybeAlive);

        // Dead row was stamped, alive row was not.
        assert!(
            read_ended_at(&conn, "dead-row").is_some(),
            "dead row should have ended_at stamped"
        );
        assert!(
            read_ended_at(&conn, "alive-row").is_none(),
            "maybe-alive row must NOT be stamped (we don't kill on conservative classify)"
        );
    }

    #[test]
    fn classify_with_no_open_rows_is_noop() {
        let mut conn = fresh_db();
        // No seeded rows. Should return an empty vec without
        // touching the DB.
        let maybe_alive = run_test_classification(&mut conn);
        assert!(maybe_alive.is_empty());
    }

    #[test]
    fn classify_ignores_already_ended_rows() {
        let mut conn = fresh_db();
        // An already-ended row whose PID happens to still be alive.
        // The classifier must NOT report it because the row was
        // already closed out by a previous run.
        seed_row(
            &conn,
            "old-ended",
            alive_sentinel_pid(),
            alive_sentinel_pid(),
            Some("2026-01-01T00:00:00Z"),
        );

        let maybe_alive = run_test_classification(&mut conn);
        assert!(maybe_alive.is_empty());
        // Stamp is preserved exactly — classification doesn't rewrite
        // an existing ended_at.
        assert_eq!(
            read_ended_at(&conn, "old-ended").as_deref(),
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
        assert!(probe_pid_alive(alive_sentinel_pid()));
    }

    #[test]
    fn probe_pid_alive_returns_false_for_clearly_dead_pid() {
        assert!(!probe_pid_alive(DEAD_SENTINEL_PID));
    }
}
