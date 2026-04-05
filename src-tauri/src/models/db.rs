use std::sync::Mutex;

use anyhow::Result;
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags};

pub static WORKSPACE_MUTATION_LOCK: Mutex<()> = Mutex::new(());

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
