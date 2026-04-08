use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

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
///
/// Retained for commands that don't target a specific existing workspace
/// (e.g. `add_repository_from_local_path`, `create_workspace_from_repo`).
/// Commands that operate on a known workspace should prefer the per-workspace
/// lock from [`workspace_mutation_lock`].
pub static WORKSPACE_MUTATION_LOCK: Mutex<()> = Mutex::const_new(());

/// Per-workspace mutation lock map. Each workspace gets its own
/// `tokio::sync::Mutex` so that heavy git operations on one workspace
/// (e.g. `git reset --hard` inside `update_intended_target_branch`) do not
/// block unrelated commands on other workspaces.
///
/// The outer `std::sync::Mutex` protects the `HashMap` itself and is held
/// only for the brief map lookup / insertion — never across I/O.
fn per_workspace_locks() -> &'static std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static MAP: OnceLock<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    MAP.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Return a shareable handle to the per-workspace mutation lock for
/// `workspace_id`. The returned `Arc<Mutex<()>>` can be `.lock().await`-ed
/// from async Tauri commands or `.blocking_lock()`-ed from std threads.
pub fn workspace_mutation_lock(workspace_id: &str) -> Arc<Mutex<()>> {
    let mut map = per_workspace_locks()
        .lock()
        .expect("per-workspace lock map poisoned");
    map.entry(workspace_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Remove the per-workspace mutation lock for a deleted workspace so the
/// static map does not grow unboundedly.
pub fn remove_workspace_lock(workspace_id: &str) {
    if let Ok(mut map) = per_workspace_locks().lock() {
        map.remove(workspace_id);
    }
}

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
