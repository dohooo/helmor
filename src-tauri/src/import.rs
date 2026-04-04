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
pub fn import_from_conductor(repo_filter: Option<&str>) -> Result<ImportResult, String> {
    let source_path = crate::data_dir::conductor_source_db_path()
        .ok_or("Conductor database not found at ~/Library/Application Support/com.conductor.app/conductor.db")?;

    let source_display = source_path.display().to_string();

    // Open source as read-only — safe even if Conductor is running
    let source = Connection::open_with_flags(
        &source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Failed to open Conductor database: {error}"))?;

    // Fail fast: validate repo exists in source BEFORE touching destination
    if let Some(repo_name) = repo_filter {
        source
            .query_row(
                "SELECT id FROM repos WHERE name = ?1 LIMIT 1",
                [repo_name],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| format!("Repo '{repo_name}' not found in source Conductor database"))?;
    }

    let dest_path = crate::data_dir::db_path()?;
    let backup_path = dest_path.with_extension("db.bak");

    // If the destination already has data, back it up first
    if dest_path.is_file() {
        std::fs::copy(&dest_path, &backup_path).map_err(|error| {
            format!(
                "Failed to create backup at {}: {error}",
                backup_path.display()
            )
        })?;
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

    // All post-backup operations: on ANY failure, restore from .bak
    let post_backup_result = (|| -> Result<(), String> {
        if let Some(repo_name) = repo_filter {
            filter_to_repo(&dest, repo_name)?;
        }
        redact_sensitive_settings(&dest)?;
        Ok(())
    })();

    if let Err(error) = post_backup_result {
        drop(dest);
        restore_backup(&dest_path, &backup_path);
        return Err(error);
    }

    // VACUUM is non-fatal — data is already correct
    let _ = dest.execute_batch("VACUUM;");

    // Stats collection is non-fatal
    let repos_count = count_rows(&dest, "repos").unwrap_or(0);
    let workspaces_count = count_rows(&dest, "workspaces").unwrap_or(0);
    let sessions_count = count_rows(&dest, "sessions").unwrap_or(0);
    let messages_count = count_rows(&dest, "session_messages").unwrap_or(0);

    Ok(ImportResult {
        success: true,
        source_path: source_display,
        repos_count,
        workspaces_count,
        sessions_count,
        messages_count,
    })
}

/// Restore the database from the .bak file after a failed post-backup operation.
fn restore_backup(dest_path: &std::path::Path, backup_path: &std::path::Path) {
    if backup_path.is_file() {
        if let Err(error) = std::fs::copy(backup_path, dest_path) {
            eprintln!(
                "CRITICAL: Failed to restore database backup from {} to {}: {error}",
                backup_path.display(),
                dest_path.display()
            );
        }
    }
}

/// Filter the imported database to only keep data for a specific repo.
fn filter_to_repo(connection: &Connection, repo_name: &str) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|error| error.to_string())?;

    let repo_id: String = connection
        .query_row(
            "SELECT id FROM repos WHERE name = ?1 LIMIT 1",
            [repo_name],
            |row| row.get(0),
        )
        .map_err(|_| format!("Repo '{repo_name}' not found in source database"))?;

    let params: &[&dyn rusqlite::types::ToSql] = &[&repo_id];

    connection
        .execute(
            "DELETE FROM attachments WHERE session_id NOT IN (
                SELECT s.id FROM sessions s
                JOIN workspaces w ON w.id = s.workspace_id
                WHERE w.repository_id = ?1
            )",
            params,
        )
        .map_err(|error| format!("Filter attachments failed: {error}"))?;

    connection
        .execute(
            "DELETE FROM session_messages WHERE session_id NOT IN (
                SELECT s.id FROM sessions s
                JOIN workspaces w ON w.id = s.workspace_id
                WHERE w.repository_id = ?1
            )",
            params,
        )
        .map_err(|error| format!("Filter messages failed: {error}"))?;

    connection
        .execute(
            "DELETE FROM sessions WHERE workspace_id NOT IN (
                SELECT id FROM workspaces WHERE repository_id = ?1
            )",
            params,
        )
        .map_err(|error| format!("Filter sessions failed: {error}"))?;

    connection
        .execute("DELETE FROM workspaces WHERE repository_id != ?1", params)
        .map_err(|error| format!("Filter workspaces failed: {error}"))?;

    connection
        .execute("DELETE FROM repos WHERE id != ?1", params)
        .map_err(|error| format!("Filter repos failed: {error}"))?;

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

/// Merge Conductor data into Helmor without replacing existing records.
///
/// Uses ATTACH DATABASE + INSERT OR IGNORE: only adds records that
/// don't already exist in Helmor (matched by primary key).
/// Existing Helmor data is never modified or deleted.
pub fn merge_from_conductor() -> Result<ImportResult, String> {
    let source_path = crate::data_dir::conductor_source_db_path()
        .ok_or("Conductor database not found")?;
    let source_display = source_path.display().to_string();
    let dest_path = crate::data_dir::db_path()?;

    let connection = Connection::open_with_flags(
        &dest_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Failed to open Helmor database: {error}"))?;

    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?;

    // Attach the Conductor DB as a read-only source
    connection
        .execute(
            "ATTACH DATABASE ?1 AS conductor",
            [source_path.to_string_lossy().as_ref()],
        )
        .map_err(|error| format!("Failed to attach Conductor database: {error}"))?;

    // All merges inside a single transaction for atomicity
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| format!("Failed to start transaction: {error}"))?;

    let merge_result = (|| -> Result<(), String> {
        let tables = [
            "repos",
            "workspaces",
            "sessions",
            "session_messages",
            "attachments",
            "diff_comments",
            "settings",
        ];

        for table in &tables {
            let columns = get_table_columns(&connection, table)?;
            let col_list = columns.join(", ");

            // For settings: redact tokens in the SELECT so we never write
            // sensitive values into Helmor. Existing Helmor settings are
            // untouched because of INSERT OR IGNORE.
            let select = if *table == "settings" {
                format!(
                    "SELECT {col_list} FROM (
                        SELECT *, CASE WHEN lower(key) LIKE '%token%' THEN '[REDACTED]' ELSE value END AS value
                        FROM conductor.{table}
                    )"
                )
            } else {
                format!("SELECT {col_list} FROM conductor.{table}")
            };

            connection
                .execute(&format!("INSERT OR IGNORE INTO main.{table} ({col_list}) {select}"), [])
                .map_err(|error| format!("Failed to merge {table}: {error}"))?;
        }

        Ok(())
    })();

    if let Err(error) = merge_result {
        let _ = connection.execute_batch("ROLLBACK");
        let _ = connection.execute("DETACH DATABASE conductor", []);
        return Err(error);
    }

    connection
        .execute_batch("COMMIT")
        .map_err(|error| format!("Failed to commit: {error}"))?;

    connection
        .execute("DETACH DATABASE conductor", [])
        .map_err(|error| format!("Failed to detach: {error}"))?;

    let repos_count = count_rows(&connection, "repos")?;
    let workspaces_count = count_rows(&connection, "workspaces")?;
    let sessions_count = count_rows(&connection, "sessions")?;
    let messages_count = count_rows(&connection, "session_messages")?;

    Ok(ImportResult {
        success: true,
        source_path: source_display,
        repos_count,
        workspaces_count,
        sessions_count,
        messages_count,
    })
}

/// Get column names for a table (from the main schema).
fn get_table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("Failed to get columns for {table}: {error}"))?;

    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();

    if columns.is_empty() {
        return Err(format!("Table {table} has no columns"));
    }

    Ok(columns)
}

/// Check if the Conductor database is available for import.
pub fn conductor_source_available() -> bool {
    crate::data_dir::conductor_source_db_path().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_to_repo_deletes_unrelated_data() {
        let source = Connection::open_in_memory().unwrap();
        crate::schema::ensure_schema(&source).unwrap();

        // Insert two repos
        source.execute("INSERT INTO repos (id, name) VALUES ('r1', 'keep-me')", []).unwrap();
        source.execute("INSERT INTO repos (id, name) VALUES ('r2', 'delete-me')", []).unwrap();
        source.execute("INSERT INTO workspaces (id, repository_id, directory_name) VALUES ('w1', 'r1', 'd1')", []).unwrap();
        source.execute("INSERT INTO workspaces (id, repository_id, directory_name) VALUES ('w2', 'r2', 'd2')", []).unwrap();
        source.execute("INSERT INTO sessions (id, workspace_id) VALUES ('s1', 'w1')", []).unwrap();
        source.execute("INSERT INTO sessions (id, workspace_id) VALUES ('s2', 'w2')", []).unwrap();
        source.execute("INSERT INTO session_messages (id, session_id, role, content) VALUES ('m1', 's1', 'user', 'hi')", []).unwrap();
        source.execute("INSERT INTO session_messages (id, session_id, role, content) VALUES ('m2', 's2', 'user', 'bye')", []).unwrap();

        filter_to_repo(&source, "keep-me").unwrap();

        let repo_count: i64 = source.query_row("SELECT count(*) FROM repos", [], |r| r.get(0)).unwrap();
        let ws_count: i64 = source.query_row("SELECT count(*) FROM workspaces", [], |r| r.get(0)).unwrap();
        let sess_count: i64 = source.query_row("SELECT count(*) FROM sessions", [], |r| r.get(0)).unwrap();
        let msg_count: i64 = source.query_row("SELECT count(*) FROM session_messages", [], |r| r.get(0)).unwrap();

        assert_eq!(repo_count, 1);
        assert_eq!(ws_count, 1);
        assert_eq!(sess_count, 1);
        assert_eq!(msg_count, 1);
    }

    #[test]
    fn filter_to_repo_errors_on_unknown_repo() {
        let source = Connection::open_in_memory().unwrap();
        crate::schema::ensure_schema(&source).unwrap();

        let result = filter_to_repo(&source, "nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn redact_sensitive_settings_removes_tokens() {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::ensure_schema(&conn).unwrap();

        conn.execute("INSERT INTO settings (key, value) VALUES ('api_token', 'secret123')", []).unwrap();
        conn.execute("INSERT INTO settings (key, value) VALUES ('username', 'john')", []).unwrap();

        redact_sensitive_settings(&conn).unwrap();

        let token: String = conn.query_row("SELECT value FROM settings WHERE key = 'api_token'", [], |r| r.get(0)).unwrap();
        let username: String = conn.query_row("SELECT value FROM settings WHERE key = 'username'", [], |r| r.get(0)).unwrap();

        assert_eq!(token, "[REDACTED]");
        assert_eq!(username, "john");
    }

    #[test]
    fn count_rows_works() {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::ensure_schema(&conn).unwrap();

        assert_eq!(count_rows(&conn, "repos").unwrap(), 0);

        conn.execute("INSERT INTO repos (id, name) VALUES ('r1', 'test')", []).unwrap();
        assert_eq!(count_rows(&conn, "repos").unwrap(), 1);
    }
}
