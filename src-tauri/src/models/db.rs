//! DB connection pools + unified API.
//!
//! Two pools match SQLite's concurrency model:
//!   - read pool  (size = 8) — WAL readers run fully concurrently
//!   - write pool (size = 1) — single-writer executor; app-layer queue
//!     eliminates SQLITE_BUSY
//!
//! Initialise once at startup via [`init_pools`]. All DB access goes
//! through [`read_conn`] / [`write_conn`] or the closure helpers
//! [`read`] / [`write_transaction`].
use std::collections::HashMap;
use std::panic::Location;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use chrono::{SecondsFormat, Utc};
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OpenFlags, Transaction};
use tauri::async_runtime::Mutex;

pub type PooledConn = PooledConnection<SqliteConnectionManager>;

/// Serializes FS-mutating operations on a workspace (worktree creation /
/// removal / reset) together with the DB row update, so concurrent commands
/// can't interleave a half-applied filesystem change with a DB update.
pub static WORKSPACE_FS_MUTATION_LOCK: Mutex<()> = Mutex::const_new(());

/// Per-workspace FS-mutation lock map (see [`WORKSPACE_FS_MUTATION_LOCK`]).
fn per_workspace_locks() -> &'static std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static MAP: OnceLock<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    MAP.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub fn workspace_fs_mutation_lock(workspace_id: &str) -> Arc<Mutex<()>> {
    let mut map = per_workspace_locks()
        .lock()
        .expect("per-workspace lock map poisoned");
    map.entry(workspace_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

pub fn remove_workspace_lock(workspace_id: &str) {
    if let Ok(mut map) = per_workspace_locks().lock() {
        map.remove(workspace_id);
    }
}

// ── Pools ────────────────────────────────────────────────────────────────

struct PoolBundle {
    path: std::path::PathBuf,
    read: Pool<SqliteConnectionManager>,
    write: Pool<SqliteConnectionManager>,
}

/// RwLock-wrapped so tests can transparently rebuild the pools when they
/// swap `HELMOR_DATA_DIR`. In production [`init_pools`] runs once and the
/// lock sees a single writer forever.
fn pool_slot() -> &'static RwLock<Option<PoolBundle>> {
    static P: OnceLock<RwLock<Option<PoolBundle>>> = OnceLock::new();
    P.get_or_init(|| RwLock::new(None))
}

const READ_POOL_SIZE: u32 = 8;
const WRITE_POOL_SIZE: u32 = 1;
const POOL_GET_TIMEOUT: Duration = Duration::from_secs(30);

/// Unified per-connection initialization. Applied by both pools and by any
/// ad-hoc `Connection::open` sites (schema init, tests, import).
///
/// Writable-only PRAGMAs (journal_mode, synchronous, busy_timeout) are
/// skipped on read-only connections: SQLite can't rewrite the journal
/// header from a read-only handle, and busy_timeout is moot for readers
/// in WAL mode (readers never block). `journal_mode=WAL` only needs to be
/// set ONCE per DB file (it persists), done on the first writable open.
pub fn init_connection(conn: &Connection, writable: bool) -> rusqlite::Result<()> {
    // Read-compatible PRAGMAs — safe and useful on either handle type.
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "cache_size", -20_000)?; // 20 MiB
    conn.pragma_update(None, "mmap_size", 268_435_456i64)?; // 256 MiB

    if writable {
        // journal_mode is persisted to the DB file on first set; idempotent here.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(Duration::from_secs(3))?;
        // TODO(tech-debt): enable foreign_keys=ON once an orphan-cleanup migration lands.
    }

    conn.set_prepared_statement_cache_capacity(256);
    Ok(())
}

fn build_bundle(path: std::path::PathBuf) -> Result<PoolBundle> {
    let write_mgr = SqliteConnectionManager::file(&path)
        .with_flags(
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_init(|c| init_connection(c, true));
    let write = Pool::builder()
        .max_size(WRITE_POOL_SIZE)
        .connection_timeout(POOL_GET_TIMEOUT)
        .build(write_mgr)
        .map_err(|e| anyhow!("Failed to build write pool: {e}"))?;

    let read_mgr = SqliteConnectionManager::file(&path)
        .with_flags(OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .with_init(|c| init_connection(c, false));
    let read = Pool::builder()
        .max_size(READ_POOL_SIZE)
        .connection_timeout(POOL_GET_TIMEOUT)
        .build(read_mgr)
        .map_err(|e| anyhow!("Failed to build read pool: {e}"))?;

    Ok(PoolBundle { path, read, write })
}

/// Initialise both pools against the current `HELMOR_DATA_DIR`. Called once
/// during app startup. In tests, [`read_conn`] / [`write_conn`] auto-rebuild
/// the pools whenever the data dir changes, so individual test helpers
/// don't need to remember to call this.
pub fn init_pools() -> Result<()> {
    let path = crate::data_dir::db_path()?;
    tracing::info!(
        path = %path.display(),
        read_pool_size = READ_POOL_SIZE,
        write_pool_size = WRITE_POOL_SIZE,
        "db: initialising pools"
    );
    let bundle = build_bundle(path)?;
    *pool_slot()
        .write()
        .map_err(|_| anyhow!("pool lock poisoned"))? = Some(bundle);
    Ok(())
}

/// Ensure pools exist and point at the current `HELMOR_DATA_DIR`. Rebuilds
/// transparently if the data dir has changed (tests) or if pools were
/// never built (first call).
///
/// Prod fast path skips `db_path()` resolution: pools are built once at
/// startup and never swapped. Tests still resolve every call so they can
/// hot-swap `HELMOR_DATA_DIR`.
fn with_bundle<T>(f: impl FnOnce(&PoolBundle) -> Result<T>) -> Result<T> {
    #[cfg(not(test))]
    {
        let guard = pool_slot()
            .read()
            .map_err(|_| anyhow!("pool lock poisoned"))?;
        if let Some(bundle) = guard.as_ref() {
            return f(bundle);
        }
    }

    let current_path = crate::data_dir::db_path()?;

    {
        let guard = pool_slot()
            .read()
            .map_err(|_| anyhow!("pool lock poisoned"))?;
        if let Some(bundle) = guard.as_ref() {
            if bundle.path == current_path {
                return f(bundle);
            }
        }
    }

    // Slow path: need to (re)build. Double-check under the write lock.
    let mut guard = pool_slot()
        .write()
        .map_err(|_| anyhow!("pool lock poisoned"))?;
    if guard
        .as_ref()
        .map(|b| b.path != current_path)
        .unwrap_or(true)
    {
        tracing::debug!(
            path = %current_path.display(),
            "db: rebuilding pool bundle (first access or HELMOR_DATA_DIR changed)"
        );
        *guard = Some(build_bundle(current_path)?);
    }
    f(guard.as_ref().expect("pool bundle just initialised"))
}

/// Log any pool borrow that takes longer than this. Below the threshold we
/// stay silent to avoid flooding the hot streaming path; above it, the
/// delay is a signal that another caller is holding the writer too long.
const SLOW_BORROW_WARN_MS: u128 = 100;

/// Borrow a read connection from the read pool. WAL lets multiple readers
/// proceed concurrently and never block the writer.
#[track_caller]
pub fn read_conn() -> Result<PooledConn> {
    // Capture caller OUTSIDE the closure: `#[track_caller]` only propagates
    // across the direct call boundary, so calling `Location::caller()`
    // inside `with_bundle`'s closure would resolve to db.rs itself.
    let caller = Location::caller();
    with_bundle(|bundle| {
        let start = std::time::Instant::now();
        let conn = bundle
            .read
            .get()
            .map_err(|e| anyhow!("Failed to borrow read connection: {e}"))?;
        let elapsed_ms = start.elapsed().as_millis();
        if elapsed_ms >= SLOW_BORROW_WARN_MS {
            tracing::warn!(
                elapsed_ms,
                pool_state = ?bundle.read.state(),
                caller_file = caller.file(),
                caller_line = caller.line(),
                "db: slow read_conn borrow"
            );
        }
        Ok(conn)
    })
}

/// Borrow the writer connection. Pool `max_size = 1`, so callers serialize
/// at the pool layer — no SQLITE_BUSY from intra-process contention.
/// Hold for as short as possible; long-held writes starve all other writers.
#[track_caller]
pub fn write_conn() -> Result<PooledConn> {
    let caller = Location::caller();
    with_bundle(|bundle| {
        let start = std::time::Instant::now();
        let conn = bundle.write.get().map_err(|e| {
            tracing::error!(
                elapsed_ms = start.elapsed().as_millis(),
                pool_state = ?bundle.write.state(),
                caller_file = caller.file(),
                caller_line = caller.line(),
                "db: write_conn borrow failed (pool timeout? holder stuck?): {e}"
            );
            anyhow!("Failed to borrow write connection: {e}")
        })?;
        let elapsed_ms = start.elapsed().as_millis();
        if elapsed_ms >= SLOW_BORROW_WARN_MS {
            tracing::warn!(
                elapsed_ms,
                pool_state = ?bundle.write.state(),
                caller_file = caller.file(),
                caller_line = caller.line(),
                "db: slow write_conn borrow — another writer held the pool"
            );
        }
        Ok(conn)
    })
}

/// Run a read-only closure with a pool-borrowed connection.
#[allow(dead_code)]
pub fn read<F, T>(f: F) -> Result<T>
where
    F: FnOnce(&Connection) -> Result<T>,
{
    let conn = read_conn()?;
    f(&conn)
}

/// Run a write closure inside a transaction. Commits on Ok, rolls back on Err.
#[allow(dead_code)]
pub fn write_transaction<F, T>(f: F) -> Result<T>
where
    F: FnOnce(&Transaction) -> Result<T>,
{
    let mut conn = write_conn()?;
    let tx = conn.transaction()?;
    let result = f(&tx)?;
    tx.commit()?;
    Ok(result)
}

// ── Utilities ────────────────────────────────────────────────────────────

/// Current UTC timestamp in RFC 3339 / millisecond precision.
pub fn current_timestamp() -> Result<String> {
    Ok(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn test_env() -> crate::testkit::TestEnv {
        crate::testkit::TestEnv::new("pool")
    }

    #[test]
    fn write_pool_serializes_concurrent_writers_without_sqlite_busy() {
        // Regression for the locked-DB storm: with max_size=1, concurrent
        // writers must queue at the pool layer and never surface SQLITE_BUSY.
        let _env = test_env();
        write_conn()
            .unwrap()
            .execute_batch("CREATE TABLE counters (id INTEGER PRIMARY KEY, v INTEGER)")
            .unwrap();
        write_conn()
            .unwrap()
            .execute("INSERT INTO counters (id, v) VALUES (1, 0)", [])
            .unwrap();

        let handles: Vec<_> = (0..16)
            .map(|_| {
                thread::spawn(|| {
                    for _ in 0..25 {
                        let conn = write_conn().expect("pool borrow");
                        conn.execute("UPDATE counters SET v = v + 1 WHERE id = 1", [])
                            .expect("no SQLITE_BUSY");
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let final_v: i64 = read_conn()
            .unwrap()
            .query_row("SELECT v FROM counters WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(final_v, 16 * 25);
    }

    #[test]
    fn streaming_short_borrow_leaves_writer_available() {
        // Regression for the reviewer's Finding 1: as long as streaming
        // short-borrows the writer, unrelated writes must still acquire the
        // single writer without hitting the 30s connection_timeout.
        let _env = test_env();
        write_conn()
            .unwrap()
            .execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY)")
            .unwrap();

        // Simulate a long-running stream that *briefly* borrows the writer
        // per-event, without ever holding it across iterations.
        let streaming = thread::spawn(|| {
            for i in 0..50 {
                let conn = write_conn().expect("streaming per-event borrow");
                conn.execute("INSERT INTO t (id) VALUES (?1)", [i]).unwrap();
                drop(conn);
                thread::sleep(std::time::Duration::from_millis(2));
            }
        });

        // Concurrently, an unrelated write (e.g. mark_session_read) must
        // succeed without waiting anywhere near the pool timeout.
        let start = std::time::Instant::now();
        for i in 100..110 {
            write_conn()
                .expect("unrelated write should not starve")
                .execute("INSERT INTO t (id) VALUES (?1)", [i])
                .unwrap();
        }
        let elapsed = start.elapsed();
        streaming.join().unwrap();

        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "unrelated writes starved by streaming: {:?}",
            elapsed,
        );
    }

    #[test]
    fn read_pool_connection_is_read_only() {
        // Regression for the reviewer's Finding 4: the read-pool handle
        // must actually reject writes, so callers can't accidentally route
        // writes through the read pool.
        let _env = test_env();
        write_conn()
            .unwrap()
            .execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY)")
            .unwrap();

        let conn = read_conn().unwrap();
        let err = conn
            .execute("INSERT INTO t (id) VALUES (1)", [])
            .unwrap_err();
        let msg = err.to_string().to_lowercase();
        assert!(
            msg.contains("read-only") || msg.contains("readonly"),
            "expected read-only rejection, got: {msg}",
        );
    }
}
