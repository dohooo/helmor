//! Optional import of Conductor data into the Helmor database.
//!
//! Uses the SQLite backup API to safely copy data from a running or
//! closed Conductor database without corrupting the source.

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

/// Result returned to the frontend after an import attempt.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub success: bool,
    pub source_path: String,
    pub repos_count: i64,
    pub workspaces_count: i64,
    pub sessions_count: i64,
    pub messages_count: i64,
}

/// Import Conductor data into the Helmor database.
///
/// - Opens the Conductor DB in read-only mode (safe even if Conductor is running)
/// - Uses SQLite backup API to copy all data
/// - Optionally filters to a single repository
///
/// WARNING: This replaces all data in the Helmor database.
pub fn import_conductor_data(repo_filter: Option<&str>) -> Result<ImportResult, String> {
    let source_path = crate::data_dir::conductor_source_db_path()
        .ok_or("Conductor database not found at ~/Library/Application Support/com.conductor.app/conductor.db")?;

    let source_display = source_path.display().to_string();

    // Open source as read-only — safe even if Conductor is running
    let source = Connection::open_with_flags(
        &source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Failed to open Conductor database: {error}"))?;

    let dest_path = crate::data_dir::db_path()?;

    // If the destination already has data, back it up first
    if dest_path.is_file() {
        let backup_path = dest_path.with_extension("db.bak");
        if let Err(error) = std::fs::copy(&dest_path, &backup_path) {
            eprintln!(
                "Warning: could not create backup at {}: {error}",
                backup_path.display()
            );
        }
    }

    // Open destination as writable — create if needed
    let mut dest = Connection::open_with_flags(
        &dest_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Failed to open Helmor database for import: {error}"))?;

    // Use SQLite backup API — copies page by page, safe and atomic
    {
        let backup = rusqlite::backup::Backup::new(&source, &mut dest)
            .map_err(|error| format!("Failed to start database backup: {error}"))?;
        backup
            .run_to_completion(100, std::time::Duration::from_millis(50), None)
            .map_err(|error| format!("Database backup failed: {error}"))?;
    }
    // Drop source — no longer needed
    drop(source);

    // If a repo filter is specified, delete data for other repos
    if let Some(repo_name) = repo_filter {
        filter_to_repo(&dest, repo_name)?;
    }

    // Redact sensitive settings (tokens, keys)
    redact_sensitive_settings(&dest)?;

    // Vacuum to reclaim space
    dest.execute_batch("VACUUM;")
        .map_err(|error| format!("VACUUM failed: {error}"))?;

    // Collect stats
    let repos_count = count_rows(&dest, "repos")?;
    let workspaces_count = count_rows(&dest, "workspaces")?;
    let sessions_count = count_rows(&dest, "sessions")?;
    let messages_count = count_rows(&dest, "session_messages")?;

    Ok(ImportResult {
        success: true,
        source_path: source_display,
        repos_count,
        workspaces_count,
        sessions_count,
        messages_count,
    })
}

/// Filter the imported database to only keep data for a specific repo.
fn filter_to_repo(connection: &Connection, repo_name: &str) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|error| error.to_string())?;

    let repo_id: Option<String> = connection
        .query_row(
            "SELECT id FROM repos WHERE name = ?1 LIMIT 1",
            [repo_name],
            |row| row.get(0),
        )
        .map_err(|error| format!("Repo '{repo_name}' not found: {error}"))?;

    let repo_id = repo_id.ok_or_else(|| format!("Repo '{repo_name}' not found in source database"))?;

    let statements = [
        format!(
            "DELETE FROM attachments WHERE session_id NOT IN (
                SELECT s.id FROM sessions s
                JOIN workspaces w ON w.id = s.workspace_id
                WHERE w.repository_id = '{repo_id}'
            )"
        ),
        format!(
            "DELETE FROM session_messages WHERE session_id NOT IN (
                SELECT s.id FROM sessions s
                JOIN workspaces w ON w.id = s.workspace_id
                WHERE w.repository_id = '{repo_id}'
            )"
        ),
        format!(
            "DELETE FROM sessions WHERE workspace_id NOT IN (
                SELECT id FROM workspaces WHERE repository_id = '{repo_id}'
            )"
        ),
        format!("DELETE FROM workspaces WHERE repository_id != '{repo_id}'"),
        format!("DELETE FROM repos WHERE id != '{repo_id}'"),
    ];

    for sql in &statements {
        connection
            .execute(sql, [])
            .map_err(|error| format!("Filter query failed: {error}"))?;
    }

    Ok(())
}

/// Redact token-like settings to avoid leaking secrets.
fn redact_sensitive_settings(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "UPDATE settings SET value = '[REDACTED]' WHERE lower(key) LIKE '%token%'",
            [],
        )
        .map_err(|error| format!("Failed to redact settings: {error}"))?;
    Ok(())
}

fn count_rows(connection: &Connection, table: &str) -> Result<i64, String> {
    connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Failed to count {table}: {error}"))
}

/// Check if the Conductor database is available for import.
pub fn conductor_available() -> bool {
    crate::data_dir::conductor_source_db_path().is_some()
}
