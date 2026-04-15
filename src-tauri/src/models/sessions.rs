use std::path::Path;

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, Transaction};
use serde::Serialize;
use serde_json::Value;

use crate::pipeline::types::HistoricalRecord;

use super::{db, settings};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionSummary {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub agent_type: Option<String>,
    pub status: String,
    pub model: Option<String>,
    pub permission_mode: String,
    pub provider_session_id: Option<String>,
    pub effort_level: Option<String>,
    pub unread_count: i64,
    pub context_token_count: i64,
    pub context_used_percent: Option<f64>,
    pub thinking_enabled: bool,
    pub fast_mode: bool,
    pub agent_personality: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_user_message_at: Option<String>,
    pub resume_session_at: Option<String>,
    pub is_hidden: bool,
    pub is_compacting: bool,
    /// Non-null when the session was created as a one-off "action" dispatch
    /// (e.g. "create-pr", "commit-and-push"). The inspector commit button
    /// uses this to drive post-stream verifiers and the auto-close behavior.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_kind: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAttachmentRecord {
    pub id: String,
    pub session_id: String,
    pub session_message_id: Option<String>,
    pub attachment_type: Option<String>,
    pub original_name: Option<String>,
    pub path: Option<String>,
    pub path_exists: bool,
    pub is_loading: bool,
    pub is_draft: bool,
    pub created_at: String,
}

pub fn list_workspace_sessions(workspace_id: &str) -> Result<Vec<WorkspaceSessionSummary>> {
    let connection = db::open_connection(false)?;
    let active_session_id: Option<String> = connection.query_row(
        "SELECT active_session_id FROM workspaces WHERE id = ?1",
        [workspace_id],
        |row| row.get(0),
    )?;

    let mut statement = connection.prepare(
        r#"
            SELECT
              s.id,
              s.workspace_id,
              s.title,
              s.agent_type,
              s.status,
              s.model,
              s.permission_mode,
              s.provider_session_id,
              s.effort_level,
              s.unread_count,
              s.context_token_count,
              s.context_used_percent,
              s.thinking_enabled,
              s.fast_mode,
              s.agent_personality,
              s.created_at,
              s.updated_at,
              s.last_user_message_at,
              s.resume_session_at,
              s.is_hidden,
              s.is_compacting,
              s.action_kind
            FROM sessions s
            WHERE s.workspace_id = ?1 AND COALESCE(s.is_hidden, 0) = 0
            ORDER BY
              datetime(s.created_at) ASC
            "#,
    )?;

    let rows = statement.query_map([workspace_id], |row| {
        let id: String = row.get(0)?;

        Ok(WorkspaceSessionSummary {
            active: active_session_id.as_deref() == Some(id.as_str()),
            id,
            workspace_id: row.get(1)?,
            title: row.get(2)?,
            agent_type: row.get(3)?,
            status: row.get(4)?,
            model: row.get(5)?,
            permission_mode: row.get(6)?,
            provider_session_id: row.get(7)?,
            effort_level: row.get(8)?,
            unread_count: row.get(9)?,
            context_token_count: row.get(10)?,
            context_used_percent: row.get(11)?,
            thinking_enabled: row.get::<_, i64>(12)? != 0,
            fast_mode: row.get::<_, i64>(13)? != 0,
            agent_personality: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
            last_user_message_at: row.get(17)?,
            resume_session_at: row.get(18)?,
            is_hidden: row.get::<_, i64>(19)? != 0,
            is_compacting: row.get::<_, i64>(20)? != 0,
            action_kind: row.get(21)?,
        })
    })?;

    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn list_session_historical_records(session_id: &str) -> Result<Vec<HistoricalRecord>> {
    let connection = db::open_connection(false)?;
    list_session_historical_records_with_connection(&connection, session_id)
}

fn list_session_historical_records_with_connection(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<HistoricalRecord>> {
    let mut statement = connection.prepare(
        r#"
            SELECT
              sm.id,
              sm.role,
              sm.content,
              sm.created_at
            FROM session_messages sm
            WHERE sm.session_id = ?1
            ORDER BY
              COALESCE(julianday(sm.sent_at), julianday(sm.created_at)) ASC,
              sm.rowid ASC
            "#,
    )?;

    let rows = statement.query_map([session_id], |row| {
        let content: String = row.get(2)?;
        // After the user_prompt migration the column is JSON-only. We still
        // try-parse instead of unwrapping so a corrupted row can't bring the
        // whole load down — `None` flows through to the adapter which renders
        // a system "Event" placeholder.
        let parsed_content = serde_json::from_str::<Value>(&content).ok();

        Ok(HistoricalRecord {
            id: row.get(0)?,
            role: row.get(1)?,
            content,
            parsed_content,
            created_at: row.get(3)?,
        })
    })?;

    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn list_session_attachments(session_id: &str) -> Result<Vec<SessionAttachmentRecord>> {
    let connection = db::open_connection(false)?;
    let mut statement = connection.prepare(
        r#"
            SELECT
              a.id,
              a.session_id,
              a.session_message_id,
              a.type,
              a.original_name,
              a.path,
              a.is_loading,
              a.is_draft,
              a.created_at
            FROM attachments a
            WHERE a.session_id = ?1
            ORDER BY datetime(a.created_at) ASC, a.id ASC
            "#,
    )?;

    let rows = statement.query_map([session_id], |row| {
        let path: Option<String> = row.get(5)?;
        let path_exists = path
            .as_deref()
            .map(|path| Path::new(path).exists())
            .unwrap_or(false);

        Ok(SessionAttachmentRecord {
            id: row.get(0)?,
            session_id: row.get(1)?,
            session_message_id: row.get(2)?,
            attachment_type: row.get(3)?,
            original_name: row.get(4)?,
            path,
            path_exists,
            is_loading: row.get::<_, i64>(6)? != 0,
            is_draft: row.get::<_, i64>(7)? != 0,
            created_at: row.get(8)?,
        })
    })?;

    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

// ---- Session read/unread functions ----

pub fn mark_session_read(session_id: &str) -> Result<()> {
    let mut connection = db::open_connection(true)?;
    let transaction = connection
        .transaction()
        .context("Failed to start mark-read transaction")?;

    mark_session_read_in_transaction(&transaction, session_id)?;

    transaction
        .commit()
        .context("Failed to commit session read transaction")
}

pub(crate) fn mark_session_read_in_transaction(
    transaction: &Transaction<'_>,
    session_id: &str,
) -> Result<()> {
    let workspace_id: String = transaction
        .query_row(
            "SELECT workspace_id FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .with_context(|| format!("Failed to resolve workspace for session {session_id}"))?;

    let updated_rows = transaction
        .execute(
            "UPDATE sessions SET unread_count = 0 WHERE id = ?1",
            [session_id],
        )
        .with_context(|| format!("Failed to mark session {session_id} as read"))?;

    if updated_rows != 1 {
        bail!("Session read update affected {updated_rows} rows for session {session_id}");
    }

    sync_workspace_unread_in_transaction(transaction, &workspace_id)
}

pub(crate) fn mark_workspace_read_in_transaction(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<()> {
    transaction
        .execute(
            "UPDATE sessions SET unread_count = 0 WHERE workspace_id = ?1",
            [workspace_id],
        )
        .with_context(|| format!("Failed to clear unread sessions for workspace {workspace_id}"))?;

    let updated_rows = transaction
        .execute(
            "UPDATE workspaces SET unread = 0 WHERE id = ?1",
            [workspace_id],
        )
        .with_context(|| format!("Failed to mark workspace {workspace_id} as read"))?;

    if updated_rows != 1 {
        bail!("Workspace read update affected {updated_rows} rows for workspace {workspace_id}");
    }

    Ok(())
}

pub(crate) fn mark_workspace_unread_in_transaction(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<()> {
    let updated_rows = transaction
        .execute(
            "UPDATE workspaces SET unread = 1 WHERE id = ?1",
            [workspace_id],
        )
        .with_context(|| format!("Failed to mark workspace {workspace_id} as unread"))?;

    if updated_rows != 1 {
        bail!("Workspace unread update affected {updated_rows} rows for workspace {workspace_id}");
    }

    Ok(())
}

pub(crate) fn sync_workspace_unread_in_transaction(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<()> {
    let updated_rows = transaction
        .execute(
            r#"
            UPDATE workspaces
            SET unread = CASE
              WHEN EXISTS (
                SELECT 1
                FROM sessions
                WHERE workspace_id = ?1
                  AND COALESCE(unread_count, 0) > 0
              ) THEN 1
              ELSE 0
            END
            WHERE id = ?1
            "#,
            [workspace_id],
        )
        .with_context(|| format!("Failed to sync unread state for workspace {workspace_id}"))?;

    if updated_rows != 1 {
        bail!("Unread sync affected {updated_rows} rows for workspace {workspace_id}");
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session_id: String,
}

pub fn create_session(
    workspace_id: &str,
    action_kind: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<CreateSessionResponse> {
    let mut connection = db::open_connection(true)?;

    // Read user's default model/effort from settings
    let default_model = settings::load_setting_value("app.default_model_id")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty() && s != "default");
    let default_effort = settings::load_setting_value("app.default_effort")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "high".to_string());

    let transaction = connection
        .transaction()
        .context("Failed to start create-session transaction")?;

    // Validate workspace exists
    let workspace_exists: bool = transaction
        .query_row(
            "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
            [workspace_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .with_context(|| format!("Failed to verify workspace {workspace_id}"))?;

    if !workspace_exists {
        bail!("Workspace {workspace_id} does not exist");
    }

    let session_id = uuid::Uuid::new_v4().to_string();

    transaction
        .execute(
            r#"
            INSERT INTO sessions (id, workspace_id, status, title, permission_mode, action_kind, model, effort_level)
            VALUES (?1, ?2, 'idle', 'Untitled', ?3, ?4, ?5, ?6)
            "#,
            (
                &session_id,
                workspace_id,
                permission_mode.unwrap_or("default"),
                action_kind,
                &default_model,
                &default_effort,
            ),
        )
        .context("Failed to create session")?;

    // Set as active session on the workspace
    let updated_rows = transaction
        .execute(
            "UPDATE workspaces SET active_session_id = ?1 WHERE id = ?2",
            (&session_id, workspace_id),
        )
        .context("Failed to set active session")?;

    if updated_rows != 1 {
        bail!("Active session update affected {updated_rows} rows for workspace {workspace_id}");
    }

    transaction
        .commit()
        .context("Failed to commit create-session")?;

    Ok(CreateSessionResponse { session_id })
}

/// Read the `model` column from a session row.
pub fn get_session_model(session_id: &str) -> Result<Option<String>> {
    let conn = db::open_connection(false)?;
    let model: Option<String> = conn
        .query_row(
            "SELECT model FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .with_context(|| format!("Failed to read model for session {session_id}"))?;
    Ok(model.filter(|s| !s.is_empty()))
}

pub fn rename_session(session_id: &str, title: &str) -> Result<()> {
    let connection = db::open_connection(true)?;

    let updated_rows = connection
        .execute(
            "UPDATE sessions SET title = ?1 WHERE id = ?2",
            (title, session_id),
        )
        .with_context(|| format!("Failed to rename session {session_id}"))?;

    if updated_rows != 1 {
        bail!("Session rename affected {updated_rows} rows for session {session_id}");
    }

    Ok(())
}

pub fn hide_session(session_id: &str) -> Result<()> {
    let mut connection = db::open_connection(true)?;
    let transaction = connection
        .transaction()
        .context("Failed to start hide-session transaction")?;

    // Resolve workspace and mark session as hidden
    let workspace_id: String = transaction
        .query_row(
            "SELECT workspace_id FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .with_context(|| format!("Failed to find session {session_id}"))?;

    transaction
        .execute(
            "UPDATE sessions SET is_hidden = 1 WHERE id = ?1",
            [session_id],
        )
        .with_context(|| format!("Failed to hide session {session_id}"))?;

    // If this was the workspace's active session, switch to the next visible one
    let current_active: Option<String> = transaction
        .query_row(
            "SELECT active_session_id FROM workspaces WHERE id = ?1",
            [&workspace_id],
            |row| row.get(0),
        )
        .context("Failed to read active session for workspace")?;

    if current_active.as_deref() == Some(session_id) {
        let next_session_id: Option<String> = transaction
            .query_row(
                r#"
                SELECT id FROM sessions
                WHERE workspace_id = ?1 AND COALESCE(is_hidden, 0) = 0
                ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
                LIMIT 1
                "#,
                [&workspace_id],
                |row| row.get(0),
            )
            .ok();

        transaction
            .execute(
                "UPDATE workspaces SET active_session_id = ?1 WHERE id = ?2",
                (next_session_id.as_deref(), &workspace_id),
            )
            .context("Failed to update active session")?;
    }

    transaction
        .commit()
        .context("Failed to commit hide-session")
}

pub fn unhide_session(session_id: &str) -> Result<()> {
    let connection = db::open_connection(true)?;
    connection
        .execute(
            "UPDATE sessions SET is_hidden = 0 WHERE id = ?1",
            [session_id],
        )
        .with_context(|| format!("Failed to unhide session {session_id}"))?;
    Ok(())
}

pub fn delete_session(session_id: &str) -> Result<()> {
    let mut connection = db::open_connection(true)?;
    let transaction = connection.transaction()?;

    // Resolve workspace before deleting, so we can fix active_session_id
    let workspace_id: Option<String> = transaction
        .query_row(
            "SELECT workspace_id FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .ok();

    transaction
        .execute(
            "DELETE FROM attachments WHERE session_id = ?1",
            [session_id],
        )
        .context("Failed to delete attachments")?;
    transaction
        .execute(
            "DELETE FROM session_messages WHERE session_id = ?1",
            [session_id],
        )
        .context("Failed to delete messages")?;
    transaction
        .execute("DELETE FROM sessions WHERE id = ?1", [session_id])
        .context("Failed to delete session")?;

    // Clear active_session_id if it pointed to the deleted session
    if let Some(ws_id) = &workspace_id {
        transaction
            .execute(
                "UPDATE workspaces SET active_session_id = NULL WHERE id = ?1 AND active_session_id = ?2",
                (ws_id, session_id),
            )
            .context("Failed to clear active session")?;
    }

    transaction
        .commit()
        .context("Failed to commit session deletion")?;
    Ok(())
}

pub fn list_hidden_sessions(workspace_id: &str) -> Result<Vec<WorkspaceSessionSummary>> {
    let connection = db::open_connection(false)?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT
              s.id, s.workspace_id, s.title, s.agent_type, s.status, s.model,
              s.permission_mode, s.provider_session_id, s.effort_level, s.unread_count,
              s.context_token_count, s.context_used_percent, s.thinking_enabled,
              s.fast_mode, s.agent_personality,
              s.created_at, s.updated_at, s.last_user_message_at,
              s.resume_session_at, s.is_hidden, s.is_compacting, s.action_kind
            FROM sessions s
            WHERE s.workspace_id = ?1 AND s.is_hidden = 1
            ORDER BY datetime(s.updated_at) DESC
            "#,
        )
        .context("Failed to prepare hidden sessions query")?;

    let rows = statement
        .query_map([workspace_id], |row| {
            let id: String = row.get(0)?;
            Ok(WorkspaceSessionSummary {
                active: false,
                id,
                workspace_id: row.get(1)?,
                title: row.get(2)?,
                agent_type: row.get(3)?,
                status: row.get(4)?,
                model: row.get(5)?,
                permission_mode: row.get(6)?,
                provider_session_id: row.get(7)?,
                effort_level: row.get(8)?,
                unread_count: row.get(9)?,
                context_token_count: row.get(10)?,
                context_used_percent: row.get(11)?,
                thinking_enabled: row.get::<_, i64>(12)? != 0,
                fast_mode: row.get::<_, i64>(13)? != 0,
                agent_personality: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
                last_user_message_at: row.get(17)?,
                resume_session_at: row.get(18)?,
                is_hidden: row.get::<_, i64>(19)? != 0,
                is_compacting: row.get::<_, i64>(20)? != 0,
                action_kind: row.get(21)?,
            })
        })
        .context("Failed to query hidden sessions")?;

    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("Failed to read hidden sessions")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_db() -> (Connection, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = Connection::open(&db_path).unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        (conn, dir)
    }

    fn seed(conn: &Connection) {
        conn.execute(
            "INSERT INTO repos (id, name) VALUES ('r1', 'test-repo')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status) VALUES ('w1', 'r1', 'test-dir', 'active', 'in-progress')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title) VALUES ('s1', 'w1', 'idle', 'Test Session')",
            [],
        ).unwrap();
    }

    #[test]
    fn session_row_exists_after_insert() {
        let (conn, _dir) = test_db();
        seed(&conn);
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sessions WHERE workspace_id = 'w1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let title: String = conn
            .query_row("SELECT title FROM sessions WHERE id = 's1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "Test Session");
    }

    #[test]
    fn loader_parses_json_content_and_tolerates_unparseable_rows() {
        // After the user_prompt migration, every new row holds JSON. The
        // loader still try-parses (vs unwrap) so a corrupted/legacy row
        // can't bring the whole load down — it falls through with
        // parsed_content = None and the adapter renders a placeholder.
        let (conn, _dir) = test_db();
        seed(&conn);
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content) VALUES ('m1', 's1', 'assistant', ?1)",
            [r#"{"type":"assistant","message":{"content":[]}}"#],
        ).unwrap();
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content) VALUES ('m2', 's1', 'user', 'plain text')",
            [],
        ).unwrap();

        let records = list_session_historical_records_with_connection(&conn, "s1").unwrap();
        let json_record = records.iter().find(|r| r.id == "m1").unwrap();
        let text_record = records.iter().find(|r| r.id == "m2").unwrap();

        assert!(
            json_record.parsed_content.is_some(),
            "valid JSON content should parse"
        );
        assert!(
            text_record.parsed_content.is_none(),
            "non-JSON content should leave parsed_content None instead of erroring"
        );
    }

    #[test]
    fn attachment_table_empty_by_default() {
        let (conn, _dir) = test_db();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    fn seed_with_active_session(conn: &Connection) {
        seed(conn);
        conn.execute(
            "UPDATE workspaces SET active_session_id = 's1' WHERE id = 'w1'",
            [],
        )
        .unwrap();
    }

    fn seed_two_sessions(conn: &Connection) {
        seed_with_active_session(conn);
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title, updated_at) VALUES ('s2', 'w1', 'idle', 'Second Session', '2026-01-02T00:00:00')",
            [],
        ).unwrap();
    }

    fn get_active_session_id(conn: &Connection, workspace_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT active_session_id FROM workspaces WHERE id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn count_sessions(conn: &Connection, workspace_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE workspace_id = ?1",
            [workspace_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn count_hidden_sessions(conn: &Connection, workspace_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE workspace_id = ?1 AND is_hidden = 1",
            [workspace_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn hide_session_clears_active_session_id() {
        let (conn, _dir) = test_db();
        seed_with_active_session(&conn);
        assert_eq!(get_active_session_id(&conn, "w1"), Some("s1".to_string()));

        // Hide s1 — simulates the transactional logic in hide_session()
        conn.execute("UPDATE sessions SET is_hidden = 1 WHERE id = 's1'", [])
            .unwrap();

        let next: Option<String> = conn
            .query_row(
                "SELECT id FROM sessions WHERE workspace_id = 'w1' AND COALESCE(is_hidden, 0) = 0 ORDER BY datetime(updated_at) DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .ok();

        conn.execute(
            "UPDATE workspaces SET active_session_id = ?1 WHERE id = 'w1' AND active_session_id = 's1'",
            [next.as_deref()],
        ).unwrap();

        // No visible sessions left, so active_session_id should be NULL
        assert_eq!(get_active_session_id(&conn, "w1"), None);
        assert_eq!(count_hidden_sessions(&conn, "w1"), 1);
    }

    #[test]
    fn hide_session_switches_to_next_visible_session() {
        let (conn, _dir) = test_db();
        seed_two_sessions(&conn);
        assert_eq!(get_active_session_id(&conn, "w1"), Some("s1".to_string()));

        // Hide s1 — should switch active to s2
        conn.execute("UPDATE sessions SET is_hidden = 1 WHERE id = 's1'", [])
            .unwrap();

        let next: Option<String> = conn
            .query_row(
                "SELECT id FROM sessions WHERE workspace_id = 'w1' AND COALESCE(is_hidden, 0) = 0 ORDER BY datetime(updated_at) DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .ok();

        conn.execute(
            "UPDATE workspaces SET active_session_id = ?1 WHERE id = 'w1' AND active_session_id = 's1'",
            [next.as_deref()],
        ).unwrap();

        assert_eq!(get_active_session_id(&conn, "w1"), Some("s2".to_string()));
    }

    #[test]
    fn delete_session_clears_active_session_id() {
        let (conn, _dir) = test_db();
        seed_with_active_session(&conn);
        assert_eq!(get_active_session_id(&conn, "w1"), Some("s1".to_string()));

        // Delete s1 — simulates the transactional logic in delete_session()
        conn.execute("DELETE FROM attachments WHERE session_id = 's1'", [])
            .unwrap();
        conn.execute("DELETE FROM session_messages WHERE session_id = 's1'", [])
            .unwrap();
        conn.execute("DELETE FROM sessions WHERE id = 's1'", [])
            .unwrap();
        conn.execute(
            "UPDATE workspaces SET active_session_id = NULL WHERE id = 'w1' AND active_session_id = 's1'",
            [],
        ).unwrap();

        assert_eq!(get_active_session_id(&conn, "w1"), None);
        assert_eq!(count_sessions(&conn, "w1"), 0);
    }

    #[test]
    fn create_session_validates_workspace_exists() {
        let (conn, _dir) = test_db();
        // No seed — workspace 'w1' does not exist
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspaces WHERE id = 'w1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "workspace should not exist");

        // Attempting to insert a session for a non-existent workspace should
        // be caught by the validation check (not by FK, since FK may not be enforced)
        let workspace_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM workspaces WHERE id = 'w1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap();
        assert!(!workspace_exists);
    }

    #[test]
    fn create_session_sets_active_session_id() {
        let (conn, _dir) = test_db();
        seed(&conn);
        assert_eq!(get_active_session_id(&conn, "w1"), None);

        // Simulate create_session logic
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title, permission_mode) VALUES ('s_new', 'w1', 'idle', 'Untitled', 'default')",
            [],
        ).unwrap();
        let updated = conn
            .execute(
                "UPDATE workspaces SET active_session_id = 's_new' WHERE id = 'w1'",
                [],
            )
            .unwrap();
        assert_eq!(updated, 1);
        assert_eq!(
            get_active_session_id(&conn, "w1"),
            Some("s_new".to_string())
        );
    }

    #[test]
    fn unhide_session_restores_visibility() {
        let (conn, _dir) = test_db();
        seed_with_active_session(&conn);

        // Hide then unhide
        conn.execute("UPDATE sessions SET is_hidden = 1 WHERE id = 's1'", [])
            .unwrap();
        assert_eq!(count_hidden_sessions(&conn, "w1"), 1);

        conn.execute("UPDATE sessions SET is_hidden = 0 WHERE id = 's1'", [])
            .unwrap();
        assert_eq!(count_hidden_sessions(&conn, "w1"), 0);

        let visible: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE workspace_id = 'w1' AND COALESCE(is_hidden, 0) = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(visible, 1);
    }

    #[test]
    fn messages_ordered_by_created_at() {
        let (conn, _dir) = test_db();
        seed(&conn);
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES ('m1', 's1', 'user', 'first', '2026-01-01T00:00:00')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES ('m2', 's1', 'assistant', 'second', '2026-01-01T00:01:00')",
            [],
        ).unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT role FROM session_messages WHERE session_id = 's1' ORDER BY created_at ASC",
            )
            .unwrap();
        let roles: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(roles, vec!["user", "assistant"]);
    }
}
