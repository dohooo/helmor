use anyhow::Result;
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags};
use tauri::async_runtime::Mutex;

/// Serializes any operation that mutates a workspace's filesystem state
/// (worktree creation/removal/reset) along with its DB row, so concurrent
/// commands can't interleave a half-applied filesystem change with a DB
/// update.
///
/// This is a `tokio::sync::Mutex` (re-exported via `tauri::async_runtime`)
/// rather than `std::sync::Mutex` so that it can be `.lock().await`-ed
/// directly inside async Tauri commands without needing to wrap the
/// acquisition in `spawn_blocking`. The background `refresh_remote_and_realign`
/// thread (spawned via `std::thread::spawn`, NOT a Tokio runtime worker)
/// uses `.blocking_lock()` instead.
pub static WORKSPACE_MUTATION_LOCK: Mutex<()> = Mutex::const_new(());

/// Open a connection to the Helmor database.
pub fn open_connection(writable: bool) -> Result<Connection> {
    let db_path = crate::data_dir::db_path()?;
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
    };

    open_connection_with_flags(&db_path, flags, writable)
}

/// Open a connection with explicit path and flags.
pub fn open_connection_with_flags(
    path: &std::path::Path,
    flags: OpenFlags,
    set_busy_timeout: bool,
) -> Result<Connection> {
    let connection = Connection::open_with_flags(path, flags)?;

    if set_busy_timeout {
        connection.busy_timeout(std::time::Duration::from_secs(3))?;
    }

    Ok(connection)
}

/// Get the current UTC timestamp without opening a throwaway SQLite connection.
pub fn current_timestamp() -> Result<String> {
    Ok(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
}
