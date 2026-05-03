use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::Value;

use crate::agents::ActionKind;
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
    pub fast_mode: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_user_message_at: Option<String>,
    pub is_hidden: bool,
    /// Non-null when the session was created as a one-off "action" dispatch
    /// (e.g. "create-pr", "commit-and-push"). The inspector commit button
    /// uses this to drive post-stream verifiers and the auto-close behavior.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_kind: Option<ActionKind>,
    pub active: bool,
}

pub fn list_workspace_sessions(workspace_id: &str) -> Result<Vec<WorkspaceSessionSummary>> {
    let connection = db::read_conn()?;
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
              s.fast_mode,
              s.created_at,
              s.updated_at,
              s.last_user_message_at,
              s.is_hidden,
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
            fast_mode: row.get::<_, i64>(10)? != 0,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
            last_user_message_at: row.get(13)?,
            is_hidden: row.get::<_, i64>(14)? != 0,
            action_kind: row.get(15)?,
        })
    })?;

    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn list_session_historical_records(session_id: &str) -> Result<Vec<HistoricalRecord>> {
    let connection = db::read_conn()?;
    list_session_historical_records_with_connection(&connection, session_id)
}

fn adjacent_visible_session_id(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    session_id: &str,
) -> Result<Option<String>> {
    let mut statement = transaction.prepare(
        r#"
            SELECT id FROM sessions
            WHERE workspace_id = ?1 AND COALESCE(is_hidden, 0) = 0
            ORDER BY datetime(created_at) ASC
            "#,
    )?;
    let visible_session_ids = statement
        .query_map([workspace_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let Some(index) = visible_session_ids
        .iter()
        .position(|candidate| candidate == session_id)
    else {
        return Ok(None);
    };

    Ok(visible_session_ids
        .get(index + 1)
        .or_else(|| {
            index
                .checked_sub(1)
                .and_then(|prev| visible_session_ids.get(prev))
        })
        .cloned())
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
            ORDER BY sm.sent_at ASC, sm.rowid ASC
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

// ---- Session read/unread functions ----

pub fn mark_session_read(session_id: &str) -> Result<()> {
    let mut connection = db::write_conn()?;
    let transaction = connection
        .transaction()
        .context("Failed to start mark-read transaction")?;

    mark_session_read_in_transaction(&transaction, session_id)?;

    transaction
        .commit()
        .context("Failed to commit session read transaction")
}

pub fn mark_session_unread(session_id: &str) -> Result<()> {
    let mut connection = db::write_conn()?;
    let transaction = connection
        .transaction()
        .context("Failed to start mark-unread transaction")?;

    mark_session_unread_in_transaction(&transaction, session_id)?;

    transaction
        .commit()
        .context("Failed to commit session unread transaction")
}

pub(crate) fn mark_session_unread_in_transaction(
    transaction: &Transaction<'_>,
    session_id: &str,
) -> Result<()> {
    // Bump to at least 1 — idempotent for a session that's already marked
    // unread, and avoids drifting upwards on repeated background completions.
    // `workspaces.unread` is an independent flag, not mirrored from sessions,
    // so we don't touch it here; `has_unread` is derived as
    // `workspaces.unread OR (any session unread_count > 0)`.
    let updated_rows = transaction
        .execute(
            "UPDATE sessions SET unread_count = MAX(COALESCE(unread_count, 0), 1) WHERE id = ?1",
            [session_id],
        )
        .with_context(|| format!("Failed to mark session {session_id} as unread"))?;

    // 0 rows = session was deleted mid-flight; benign race, skip silently.
    // >1 rows = duplicate primary key, genuinely broken schema.
    if updated_rows > 1 {
        bail!("Session unread update affected {updated_rows} rows for session {session_id}");
    }

    Ok(())
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

    // Clearing a session only drops the workspace flag when nothing else in
    // the workspace is still unread; otherwise the workspace stays marked.
    clear_workspace_unread_if_no_session_unread_in_transaction(transaction, &workspace_id)
}

pub(crate) fn mark_workspace_unread_in_transaction(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<()> {
    // `workspaces.unread` is an independent flag. Setting it directly is
    // enough — sessions are left alone. `has_unread` is derived as
    // `workspaces.unread OR (any session unread_count > 0)`.
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

/// Clears `workspaces.unread` only if every session in the workspace is
/// already read. Called from `mark_session_read_in_transaction` so the
/// workspace flag disappears together with the last unread session, but is
/// preserved while any session still has unread content.
pub(crate) fn clear_workspace_unread_if_no_session_unread_in_transaction(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<()> {
    transaction
        .execute(
            r#"
            UPDATE workspaces
            SET unread = 0
            WHERE id = ?1
              AND NOT EXISTS (
                SELECT 1
                FROM sessions
                WHERE workspace_id = ?1
                  AND COALESCE(unread_count, 0) > 0
              )
            "#,
            [workspace_id],
        )
        .with_context(|| format!("Failed to clear workspace unread for {workspace_id}"))?;

    // Idempotent: zero rows updated is fine — it just means the workspace
    // still has unread sessions (or the flag was already 0).
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session_id: String,
}

/// Forge-aware variant. Looks up the workspace's stored `forge_provider`
/// so a GitLab workspace gets "Create MR" / "Open MR" instead of the
/// GitHub-flavored defaults. Falls back to the plain `default_title` when
/// we have no provider info (e.g. pre-migration rows).
fn default_session_title_for_action_kind_with_workspace(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    action_kind: Option<ActionKind>,
) -> Result<String> {
    let Some(kind) = action_kind else {
        return Ok("Untitled".to_string());
    };

    // Only CreatePr/OpenPr care about the forge nouns — skip the query
    // otherwise.
    if !matches!(kind, ActionKind::CreatePr | ActionKind::OpenPr) {
        return Ok(kind.default_title().to_string());
    }

    let provider: Option<String> = transaction
        .query_row(
            "SELECT r.forge_provider \
             FROM workspaces w JOIN repos r ON r.id = w.repository_id \
             WHERE w.id = ?1",
            [workspace_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .with_context(|| format!("Failed to read forge_provider for {workspace_id}"))?
        .flatten();

    let change_request_name = match provider.as_deref() {
        Some("gitlab") => "MR",
        _ => "PR",
    };
    Ok(kind.default_title_for_change_request(change_request_name))
}

pub fn create_session(
    workspace_id: &str,
    action_kind: Option<ActionKind>,
    permission_mode: Option<&str>,
) -> Result<CreateSessionResponse> {
    let mut connection = db::write_conn()?;

    // `model` is left NULL on create: the frontend owns model selection via
    // `settings.defaultModelId` (kept valid by `useEnsureDefaultModel`), and
    // the value gets persisted into `sessions.model` by the agent streaming
    // finalizer on the first message. Reading settings here would be a
    // redundant second source of truth.
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
    let title = default_session_title_for_action_kind_with_workspace(
        &transaction,
        workspace_id,
        action_kind,
    )?;

    transaction
        .execute(
            r#"
            INSERT INTO sessions (id, workspace_id, status, title, permission_mode, action_kind, model, effort_level)
            VALUES (?1, ?2, 'idle', ?3, ?4, ?5, NULL, ?6)
            "#,
            (
                &session_id,
                workspace_id,
                &title,
                permission_mode.unwrap_or("default"),
                action_kind,
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
    let conn = db::read_conn()?;
    let model: Option<String> = conn
        .query_row(
            "SELECT model FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .with_context(|| format!("Failed to read model for session {session_id}"))?;
    Ok(model.filter(|s| !s.is_empty()))
}

/// Read the opaque `context_usage_meta` JSON for the composer's
/// context-usage ring. Returns `Ok(None)` for missing rows OR empty meta —
/// the ring renders a placeholder either way and the frontend RPC contract
/// promises null on "not recorded yet". This matters for the create→fetch
/// race and the delete-while-mounted race.
pub fn get_session_context_usage(session_id: &str) -> Result<Option<String>> {
    let conn = db::read_conn()?;
    read_session_context_usage(&conn, session_id)
}

fn read_session_context_usage(conn: &Connection, session_id: &str) -> Result<Option<String>> {
    let meta: Option<String> = match conn.query_row(
        "SELECT context_usage_meta FROM sessions WHERE id = ?1",
        [session_id],
        |row| row.get(0),
    ) {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(err) => {
            return Err(err).with_context(|| {
                format!("Failed to read context_usage_meta for session {session_id}")
            });
        }
    };
    Ok(meta.filter(|s| !s.is_empty()))
}

/// Read the opaque `codex_goal_meta` JSON for the panel-header goal banner.
/// `None` means no active goal (cleared, never set, or unknown session).
pub fn get_session_codex_goal(session_id: &str) -> Result<Option<String>> {
    let conn = db::read_conn()?;
    let meta: Option<String> = match conn.query_row(
        "SELECT codex_goal_meta FROM sessions WHERE id = ?1",
        [session_id],
        |row| row.get(0),
    ) {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(err) => {
            return Err(err).with_context(|| {
                format!("Failed to read codex_goal_meta for session {session_id}")
            });
        }
    };
    Ok(meta.filter(|s| !s.is_empty()))
}

pub fn rename_session(session_id: &str, title: &str) -> Result<()> {
    let connection = db::write_conn()?;

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
    let mut connection = db::write_conn()?;
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

    // If this was the workspace's active session, switch to its right neighbor,
    // falling back to the left neighbor when closing the rightmost tab.
    let current_active: Option<String> = transaction
        .query_row(
            "SELECT active_session_id FROM workspaces WHERE id = ?1",
            [&workspace_id],
            |row| row.get(0),
        )
        .context("Failed to read active session for workspace")?;
    let next_session_id = if current_active.as_deref() == Some(session_id) {
        adjacent_visible_session_id(&transaction, &workspace_id, session_id)?
    } else {
        None
    };

    transaction
        .execute(
            "UPDATE sessions SET is_hidden = 1 WHERE id = ?1",
            [session_id],
        )
        .with_context(|| format!("Failed to hide session {session_id}"))?;

    // A hidden session can no longer contribute to the workspace unread dot —
    // the user can't reach it to clear it. Drop its unread_count so the
    // workspace flag can fall off too when this was the last unread session.
    mark_session_read_in_transaction(&transaction, session_id)?;

    if current_active.as_deref() == Some(session_id) {
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
    let connection = db::write_conn()?;
    connection
        .execute(
            "UPDATE sessions SET is_hidden = 0 WHERE id = ?1",
            [session_id],
        )
        .with_context(|| format!("Failed to unhide session {session_id}"))?;
    Ok(())
}

pub fn delete_session(session_id: &str) -> Result<()> {
    let mut connection = db::write_conn()?;
    let transaction = connection.transaction()?;

    // Resolve workspace before deleting, so we can fix active_session_id
    let workspace_id: Option<String> = transaction
        .query_row(
            "SELECT workspace_id FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .ok();

    let current_active: Option<String> = if let Some(ws_id) = &workspace_id {
        transaction
            .query_row(
                "SELECT active_session_id FROM workspaces WHERE id = ?1",
                [ws_id],
                |row| row.get(0),
            )
            .ok()
    } else {
        None
    };
    let next_session_id = match (&workspace_id, current_active.as_deref()) {
        (Some(ws_id), Some(active_id)) if active_id == session_id => {
            adjacent_visible_session_id(&transaction, ws_id, session_id)?
        }
        _ => None,
    };

    transaction
        .execute(
            "DELETE FROM session_messages WHERE session_id = ?1",
            [session_id],
        )
        .context("Failed to delete messages")?;
    transaction
        .execute("DELETE FROM sessions WHERE id = ?1", [session_id])
        .context("Failed to delete session")?;

    // If this was active, persist the same right-then-left tab fallback as the UI.
    if let Some(ws_id) = &workspace_id {
        transaction
            .execute(
                "UPDATE workspaces SET active_session_id = ?1 WHERE id = ?2 AND active_session_id = ?3",
                (next_session_id.as_deref(), ws_id, session_id),
            )
            .context("Failed to update active session")?;
    }

    transaction
        .commit()
        .context("Failed to commit session deletion")?;
    Ok(())
}

pub fn list_hidden_sessions(workspace_id: &str) -> Result<Vec<WorkspaceSessionSummary>> {
    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT
              s.id, s.workspace_id, s.title, s.agent_type, s.status, s.model,
              s.permission_mode, s.provider_session_id, s.effort_level,
              s.unread_count, s.fast_mode, s.created_at, s.updated_at,
              s.last_user_message_at, s.is_hidden, s.action_kind
            FROM sessions s
            WHERE s.workspace_id = ?1 AND s.is_hidden = 1
            ORDER BY datetime(s.created_at) ASC
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
                fast_mode: row.get::<_, i64>(10)? != 0,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
                last_user_message_at: row.get(13)?,
                is_hidden: row.get::<_, i64>(14)? != 0,
                action_kind: row.get(15)?,
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
            "INSERT INTO workspaces (id, repository_id, directory_name, state, status) VALUES ('w1', 'r1', 'test-dir', 'active', 'in-progress')",
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
            "UPDATE sessions SET created_at = '2026-01-01T00:00:00', updated_at = '2026-01-01T00:00:00' WHERE id = 's1'",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title, created_at, updated_at) VALUES ('s2', 'w1', 'idle', 'Second Session', '2026-01-02T00:00:00', '2026-01-02T00:00:00')",
            [],
        ).unwrap();
    }

    fn seed_three_sessions(conn: &Connection) {
        seed_two_sessions(conn);
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title, created_at, updated_at) VALUES ('s3', 'w1', 'idle', 'Third Session', '2026-01-03T00:00:00', '2026-01-03T00:00:00')",
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
                "SELECT id FROM sessions WHERE workspace_id = 'w1' AND COALESCE(is_hidden, 0) = 0 ORDER BY datetime(created_at) ASC LIMIT 1",
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
                "SELECT id FROM sessions WHERE workspace_id = 'w1' AND COALESCE(is_hidden, 0) = 0 ORDER BY datetime(created_at) ASC LIMIT 1",
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
    fn adjacent_visible_session_prefers_right_then_left() {
        let (mut conn, _dir) = test_db();
        seed_three_sessions(&conn);
        let transaction = conn.transaction().unwrap();

        assert_eq!(
            adjacent_visible_session_id(&transaction, "w1", "s1").unwrap(),
            Some("s2".to_string())
        );
        assert_eq!(
            adjacent_visible_session_id(&transaction, "w1", "s2").unwrap(),
            Some("s3".to_string())
        );
        assert_eq!(
            adjacent_visible_session_id(&transaction, "w1", "s3").unwrap(),
            Some("s2".to_string())
        );
    }

    #[test]
    fn delete_session_clears_active_session_id() {
        let (conn, _dir) = test_db();
        seed_with_active_session(&conn);
        assert_eq!(get_active_session_id(&conn, "w1"), Some("s1".to_string()));

        // Delete s1 — simulates the transactional logic in delete_session()
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
    fn delete_active_session_switches_to_adjacent_visible_session() {
        let (mut conn, _dir) = test_db();
        seed_three_sessions(&conn);
        conn.execute(
            "UPDATE workspaces SET active_session_id = 's2' WHERE id = 'w1'",
            [],
        )
        .unwrap();

        let transaction = conn.transaction().unwrap();
        let next_session_id = adjacent_visible_session_id(&transaction, "w1", "s2").unwrap();
        transaction
            .execute("DELETE FROM session_messages WHERE session_id = 's2'", [])
            .unwrap();
        transaction
            .execute("DELETE FROM sessions WHERE id = 's2'", [])
            .unwrap();
        transaction
            .execute(
                "UPDATE workspaces SET active_session_id = ?1 WHERE id = 'w1' AND active_session_id = 's2'",
                [next_session_id.as_deref()],
            )
            .unwrap();
        transaction.commit().unwrap();

        assert_eq!(get_active_session_id(&conn, "w1"), Some("s3".to_string()));
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
    fn action_session_title_uses_mr_wording_on_gitlab() {
        let (conn, _dir) = test_db();
        seed(&conn);
        conn.execute(
            "UPDATE repos SET forge_provider = 'gitlab' WHERE id = 'r1'",
            [],
        )
        .unwrap();
        let tx = conn.unchecked_transaction().unwrap();

        let gitlab_title = default_session_title_for_action_kind_with_workspace(
            &tx,
            "w1",
            Some(ActionKind::CreatePr),
        )
        .unwrap();
        assert_eq!(gitlab_title, "Create MR");

        let open_title = default_session_title_for_action_kind_with_workspace(
            &tx,
            "w1",
            Some(ActionKind::OpenPr),
        )
        .unwrap();
        assert_eq!(open_title, "Open MR");

        // Non-PR kinds still use their normal title.
        let merge_title = default_session_title_for_action_kind_with_workspace(
            &tx,
            "w1",
            Some(ActionKind::Merge),
        )
        .unwrap();
        assert_eq!(merge_title, "Merge");

        // No action kind → "Untitled".
        let untitled =
            default_session_title_for_action_kind_with_workspace(&tx, "w1", None).unwrap();
        assert_eq!(untitled, "Untitled");
    }

    #[test]
    fn action_session_title_keeps_pr_wording_on_github_or_missing_provider() {
        let (conn, _dir) = test_db();
        seed(&conn);
        let tx = conn.unchecked_transaction().unwrap();

        // forge_provider is NULL (legacy row) → default to PR wording.
        let null_title = default_session_title_for_action_kind_with_workspace(
            &tx,
            "w1",
            Some(ActionKind::CreatePr),
        )
        .unwrap();
        assert_eq!(null_title, "Create PR");

        // forge_provider = 'github' → also PR.
        tx.execute(
            "UPDATE repos SET forge_provider = 'github' WHERE id = 'r1'",
            [],
        )
        .unwrap();
        let gh_title = default_session_title_for_action_kind_with_workspace(
            &tx,
            "w1",
            Some(ActionKind::CreatePr),
        )
        .unwrap();
        assert_eq!(gh_title, "Create PR");
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
    fn list_hidden_sessions_orders_by_created_at() {
        let (conn, _dir) = test_db();
        seed_with_active_session(&conn);
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title, created_at, updated_at, is_hidden) VALUES ('s2', 'w1', 'idle', 'Second Session', '2026-01-02T00:00:00', '2026-01-03T00:00:00', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE sessions SET is_hidden = 1, updated_at = '2026-01-04T00:00:00' WHERE id = 's1'",
            [],
        )
        .unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT id FROM sessions WHERE workspace_id = 'w1' AND is_hidden = 1 ORDER BY datetime(created_at) ASC",
            )
            .unwrap();
        let hidden_ids = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(std::result::Result::ok)
            .collect::<Vec<String>>();
        assert_eq!(hidden_ids, vec!["s2", "s1"]);
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

    #[test]
    fn read_session_context_usage_handles_missing_session() {
        let (conn, _dir) = test_db();
        seed(&conn);
        // No row for "ghost" — must be Ok(None), NOT an error.
        let meta = read_session_context_usage(&conn, "ghost").unwrap();
        assert_eq!(meta, None);
    }

    #[test]
    fn read_session_context_usage_returns_none_for_null_meta() {
        let (conn, _dir) = test_db();
        seed(&conn);
        // Seeded session has context_usage_meta NULL by default.
        let meta = read_session_context_usage(&conn, "s1").unwrap();
        assert_eq!(meta, None);
    }

    #[test]
    fn read_session_context_usage_returns_stored_string() {
        let (conn, _dir) = test_db();
        seed(&conn);
        conn.execute(
            "UPDATE sessions SET context_usage_meta = ?1 WHERE id = 's1'",
            [r#"{"totalTokens":7}"#],
        )
        .unwrap();
        let meta = read_session_context_usage(&conn, "s1").unwrap();
        assert_eq!(meta.as_deref(), Some(r#"{"totalTokens":7}"#));
    }

    #[test]
    fn read_session_context_usage_filters_empty_string_to_none() {
        let (conn, _dir) = test_db();
        seed(&conn);
        conn.execute(
            "UPDATE sessions SET context_usage_meta = '' WHERE id = 's1'",
            [],
        )
        .unwrap();
        let meta = read_session_context_usage(&conn, "s1").unwrap();
        assert_eq!(meta, None);
    }
}
