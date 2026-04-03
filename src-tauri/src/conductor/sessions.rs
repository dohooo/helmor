use std::path::Path;

use rusqlite::Transaction;
use serde::Serialize;
use serde_json::Value;

use super::db;

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
    pub claude_session_id: Option<String>,
    pub unread_count: i64,
    pub context_token_count: i64,
    pub context_used_percent: Option<f64>,
    pub thinking_enabled: bool,
    pub codex_thinking_level: Option<String>,
    pub fast_mode: bool,
    pub agent_personality: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_user_message_at: Option<String>,
    pub resume_session_at: Option<String>,
    pub is_hidden: bool,
    pub is_compacting: bool,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessageRecord {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub content_is_json: bool,
    pub parsed_content: Option<Value>,
    pub created_at: String,
    pub sent_at: Option<String>,
    pub cancelled_at: Option<String>,
    pub model: Option<String>,
    pub sdk_message_id: Option<String>,
    pub last_assistant_message_id: Option<String>,
    pub turn_id: Option<String>,
    pub is_resumable_message: Option<bool>,
    pub attachment_count: i64,
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

pub fn list_workspace_sessions(
    workspace_id: &str,
) -> Result<Vec<WorkspaceSessionSummary>, String> {
    let connection = db::open_connection(false)?;
    let active_session_id: Option<String> = connection
        .query_row(
            "SELECT active_session_id FROM workspaces WHERE id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    let mut statement = connection
        .prepare(
            r#"
            SELECT
              s.id,
              s.workspace_id,
              s.title,
              s.agent_type,
              s.status,
              s.model,
              s.permission_mode,
              s.claude_session_id,
              s.unread_count,
              s.context_token_count,
              s.context_used_percent,
              s.thinking_enabled,
              s.codex_thinking_level,
              s.fast_mode,
              s.agent_personality,
              s.created_at,
              s.updated_at,
              s.last_user_message_at,
              s.resume_session_at,
              s.is_hidden,
              s.is_compacting
            FROM sessions s
            WHERE s.workspace_id = ?1
            ORDER BY
              CASE WHEN s.id = ?2 THEN 0 ELSE 1 END,
              datetime(s.updated_at) DESC,
              datetime(s.created_at) DESC
            "#,
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map((workspace_id, active_session_id.as_deref()), |row| {
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
                claude_session_id: row.get(7)?,
                unread_count: row.get(8)?,
                context_token_count: row.get(9)?,
                context_used_percent: row.get(10)?,
                thinking_enabled: row.get::<_, i64>(11)? != 0,
                codex_thinking_level: row.get(12)?,
                fast_mode: row.get::<_, i64>(13)? != 0,
                agent_personality: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
                last_user_message_at: row.get(17)?,
                resume_session_at: row.get(18)?,
                is_hidden: row.get::<_, i64>(19)? != 0,
                is_compacting: row.get::<_, i64>(20)? != 0,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn list_session_messages(session_id: &str) -> Result<Vec<SessionMessageRecord>, String> {
    let connection = db::open_connection(false)?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT
              sm.id,
              sm.session_id,
              sm.role,
              sm.content,
              sm.created_at,
              sm.sent_at,
              sm.cancelled_at,
              sm.model,
              sm.sdk_message_id,
              sm.last_assistant_message_id,
              sm.turn_id,
              sm.is_resumable_message,
              (
                SELECT COUNT(*)
                FROM attachments a
                WHERE a.session_message_id = sm.id
              ) AS attachment_count
            FROM session_messages sm
            WHERE sm.session_id = ?1
            ORDER BY
              COALESCE(julianday(sm.sent_at), julianday(sm.created_at)) ASC,
              sm.rowid ASC
            "#,
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([session_id], |row| {
            let content: String = row.get(3)?;
            let parsed_content = serde_json::from_str::<Value>(&content).ok();
            let is_resumable_message = row.get::<_, Option<i64>>(11)?.map(|value| value != 0);

            Ok(SessionMessageRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content_is_json: parsed_content.is_some(),
                parsed_content,
                content,
                created_at: row.get(4)?,
                sent_at: row.get(5)?,
                cancelled_at: row.get(6)?,
                model: row.get(7)?,
                sdk_message_id: row.get(8)?,
                last_assistant_message_id: row.get(9)?,
                turn_id: row.get(10)?,
                is_resumable_message,
                attachment_count: row.get(12)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn list_session_attachments(session_id: &str) -> Result<Vec<SessionAttachmentRecord>, String> {
    let connection = db::open_connection(false)?;
    let mut statement = connection
        .prepare(
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
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([session_id], |row| {
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
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

// ---- Session read/unread functions ----

pub fn mark_session_read(session_id: &str) -> Result<(), String> {
    let mut connection = db::open_connection(true)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start mark-read transaction: {error}"))?;

    mark_session_read_in_transaction(&transaction, session_id)?;

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit session read transaction: {error}"))
}

pub(crate) fn mark_session_read_in_transaction(
    transaction: &Transaction<'_>,
    session_id: &str,
) -> Result<(), String> {
    let workspace_id: String = transaction
        .query_row(
            "SELECT workspace_id FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| {
            format!("Failed to resolve workspace for session {session_id}: {error}")
        })?;

    let updated_rows = transaction
        .execute(
            "UPDATE sessions SET unread_count = 0 WHERE id = ?1",
            [session_id],
        )
        .map_err(|error| format!("Failed to mark session {session_id} as read: {error}"))?;

    if updated_rows != 1 {
        return Err(format!(
            "Session read update affected {updated_rows} rows for session {session_id}"
        ));
    }

    sync_workspace_unread_in_transaction(transaction, &workspace_id)
}

pub(crate) fn mark_workspace_read_in_transaction(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "UPDATE sessions SET unread_count = 0 WHERE workspace_id = ?1",
            [workspace_id],
        )
        .map_err(|error| {
            format!("Failed to clear unread sessions for workspace {workspace_id}: {error}")
        })?;

    let updated_rows = transaction
        .execute(
            "UPDATE workspaces SET unread = 0 WHERE id = ?1",
            [workspace_id],
        )
        .map_err(|error| {
            format!("Failed to mark workspace {workspace_id} as read: {error}")
        })?;

    if updated_rows != 1 {
        return Err(format!(
            "Workspace read update affected {updated_rows} rows for workspace {workspace_id}"
        ));
    }

    Ok(())
}

pub(crate) fn mark_workspace_unread_in_transaction(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<(), String> {
    let updated_rows = transaction
        .execute(
            "UPDATE workspaces SET unread = 1 WHERE id = ?1",
            [workspace_id],
        )
        .map_err(|error| {
            format!("Failed to mark workspace {workspace_id} as unread: {error}")
        })?;

    if updated_rows != 1 {
        return Err(format!(
            "Workspace unread update affected {updated_rows} rows for workspace {workspace_id}"
        ));
    }

    Ok(())
}

pub(crate) fn sync_workspace_unread_in_transaction(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<(), String> {
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
        .map_err(|error| {
            format!("Failed to sync unread state for workspace {workspace_id}: {error}")
        })?;

    if updated_rows != 1 {
        return Err(format!(
            "Unread sync affected {updated_rows} rows for workspace {workspace_id}"
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        conn
    }

    fn seed(conn: &Connection) {
        conn.execute("INSERT INTO repos (id, name) VALUES ('r1', 'test-repo')", []).unwrap();
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
        let conn = test_db();
        seed(&conn);
        let count: i64 = conn
            .query_row("SELECT count(*) FROM sessions WHERE workspace_id = 'w1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);

        let title: String = conn
            .query_row("SELECT title FROM sessions WHERE id = 's1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Test Session");
    }

    #[test]
    fn message_json_detection() {
        let conn = test_db();
        seed(&conn);
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content) VALUES ('m1', 's1', 'assistant', ?1)",
            [r#"{"type":"assistant","message":{"content":[]}}"#],
        ).unwrap();
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content) VALUES ('m2', 's1', 'user', 'plain text')",
            [],
        ).unwrap();

        let content: String = conn
            .query_row("SELECT content FROM session_messages WHERE id = 'm1'", [], |r| r.get(0))
            .unwrap();
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&content);
        assert!(parsed.is_ok());

        let content2: String = conn
            .query_row("SELECT content FROM session_messages WHERE id = 'm2'", [], |r| r.get(0))
            .unwrap();
        let parsed2: Result<serde_json::Value, _> = serde_json::from_str(&content2);
        assert!(parsed2.is_err());
    }

    #[test]
    fn attachment_table_empty_by_default() {
        let conn = test_db();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn messages_ordered_by_created_at() {
        let conn = test_db();
        seed(&conn);
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES ('m1', 's1', 'user', 'first', '2026-01-01T00:00:00')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES ('m2', 's1', 'assistant', 'second', '2026-01-01T00:01:00')",
            [],
        ).unwrap();

        let mut stmt = conn.prepare(
            "SELECT role FROM session_messages WHERE session_id = 's1' ORDER BY created_at ASC"
        ).unwrap();
        let roles: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(roles, vec!["user", "assistant"]);
    }
}
