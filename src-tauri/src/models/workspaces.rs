use std::path::Path;

use anyhow::{bail, Context, Result};
use rusqlite::Row;

use crate::{helpers, repos};

use super::db;

#[derive(Debug)]
pub struct WorkspaceRecord {
    pub id: String,
    pub repo_id: String,
    pub repo_name: String,
    pub remote_url: Option<String>,
    pub default_branch: Option<String>,
    pub root_path: Option<String>,
    pub directory_name: String,
    pub state: String,
    pub has_unread: bool,
    pub workspace_unread: i64,
    pub session_unread_total: i64,
    pub unread_session_count: i64,
    pub derived_status: String,
    pub manual_status: Option<String>,
    pub branch: Option<String>,
    pub initialization_parent_branch: Option<String>,
    pub intended_target_branch: Option<String>,
    pub notes: Option<String>,
    pub pinned_at: Option<String>,
    pub active_session_id: Option<String>,
    pub active_session_title: Option<String>,
    pub active_session_agent_type: Option<String>,
    pub active_session_status: Option<String>,
    pub pr_title: Option<String>,
    pub pr_description: Option<String>,
    pub archive_commit: Option<String>,
    pub session_count: i64,
    pub message_count: i64,
    pub attachment_count: i64,
    pub remote: Option<String>,
}

pub const WORKSPACE_RECORD_SQL: &str = r#"
    WITH session_stats AS (
      SELECT
        workspace_id,
        SUM(COALESCE(unread_count, 0)) AS session_unread_total,
        SUM(CASE WHEN COALESCE(unread_count, 0) > 0 THEN 1 ELSE 0 END) AS unread_session_count,
        COUNT(*) AS session_count
      FROM sessions
      GROUP BY workspace_id
    ),
    message_stats AS (
      SELECT
        ws.workspace_id,
        COUNT(*) AS message_count
      FROM sessions ws
      JOIN session_messages sm ON sm.session_id = ws.id
      GROUP BY ws.workspace_id
    ),
    attachment_stats AS (
      SELECT
        ws.workspace_id,
        COUNT(*) AS attachment_count
      FROM sessions ws
      JOIN attachments a ON a.session_id = ws.id
      GROUP BY ws.workspace_id
    )
    SELECT
      w.id,
      r.id AS repo_id,
      r.name AS repo_name,
      r.remote_url,
      r.default_branch,
      r.root_path,
      w.directory_name,
      w.state,
      CASE
        WHEN COALESCE(w.unread, 0) > 0 OR COALESCE(ss.session_unread_total, 0) > 0 THEN 1
        ELSE 0
      END AS has_unread,
      COALESCE(w.unread, 0) AS workspace_unread,
      COALESCE(ss.session_unread_total, 0) AS session_unread_total,
      COALESCE(ss.unread_session_count, 0) AS unread_session_count,
      COALESCE(w.derived_status, 'in-progress') AS derived_status,
      w.manual_status,
      w.branch,
      w.initialization_parent_branch,
      w.intended_target_branch,
      w.notes,
      w.pinned_at,
      w.active_session_id,
      s.title AS active_session_title,
      s.agent_type AS active_session_agent_type,
      s.status AS active_session_status,
      w.pr_title,
      w.pr_description,
      w.archive_commit,
      COALESCE(ss.session_count, 0) AS session_count,
      COALESCE(ms.message_count, 0) AS message_count,
      COALESCE(att.attachment_count, 0) AS attachment_count,
      r.remote
    FROM workspaces w
    JOIN repos r ON r.id = w.repository_id
    LEFT JOIN sessions s ON s.id = w.active_session_id
    LEFT JOIN session_stats ss ON ss.workspace_id = w.id
    LEFT JOIN message_stats ms ON ms.workspace_id = w.id
    LEFT JOIN attachment_stats att ON att.workspace_id = w.id
"#;

pub fn load_workspace_records() -> Result<Vec<WorkspaceRecord>> {
    let connection = db::open_connection(false)?;
    let sql = format!("{WORKSPACE_RECORD_SQL} ORDER BY w.updated_at DESC");
    let mut statement = connection.prepare(&sql)?;

    let rows = statement.query_map([], workspace_record_from_row)?;

    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn load_workspace_record_by_id(workspace_id: &str) -> Result<Option<WorkspaceRecord>> {
    let connection = db::open_connection(false)?;
    let mut statement =
        connection.prepare(format!("{WORKSPACE_RECORD_SQL} WHERE w.id = ?1").as_str())?;

    let mut rows = statement.query_map([workspace_id], workspace_record_from_row)?;

    match rows.next() {
        Some(result) => Ok(result.map(Some)?),
        None => Ok(None),
    }
}

pub fn load_archived_workspace_records() -> Result<Vec<WorkspaceRecord>> {
    let connection = db::open_connection(false)?;
    let mut statement = connection
        .prepare(&format!(
            // Archived list sorts by `updated_at DESC` so the most recently
            // archived workspace shows at the top — `archive_workspace_impl`
            // explicitly bumps `updated_at` to `now` when transitioning the
            // state to 'archived', so this column doubles as "archived at"
            // for ordering purposes (no separate column needed).
            "{WORKSPACE_RECORD_SQL} WHERE w.state = 'archived' ORDER BY w.updated_at DESC"
        ))
        .context("Failed to prepare archived workspaces query")?;

    let rows = statement.query_map([], workspace_record_from_row)?;

    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub(crate) fn insert_initializing_workspace_and_session(
    repository: &repos::RepositoryRecord,
    workspace_id: &str,
    session_id: &str,
    directory_name: &str,
    branch: &str,
    default_branch: &str,
    timestamp: &str,
) -> Result<()> {
    let mut connection = db::open_connection(true)?;
    let transaction = connection
        .transaction()
        .context("Failed to start create-workspace transaction")?;

    transaction
        .execute(
            r#"
            INSERT INTO workspaces (
              id,
              repository_id,
              directory_name,
              active_session_id,
              branch,
              placeholder_branch_name,
              state,
              initialization_parent_branch,
              intended_target_branch,
              derived_status,
              unread,
              initialization_files_copied,
              created_at,
              updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'initializing', ?7, ?8, 'in-progress', 0, 0, ?9, ?9)
            "#,
            (
                workspace_id,
                repository.id.as_str(),
                directory_name,
                session_id,
                branch,
                branch,
                default_branch,
                default_branch,
                timestamp,
            ),
        )
        .context("Failed to insert initializing workspace")?;

    transaction
        .execute(
            r#"
            INSERT INTO sessions (
              id,
              workspace_id,
              title,
              status,
              permission_mode,
              unread_count,
              context_token_count,
              thinking_enabled,
              fast_mode,
              created_at,
              updated_at,
              is_hidden,
              is_compacting
            ) VALUES (?1, ?2, 'Untitled', 'idle', 'default', 0, 0, 1, 0, ?3, ?3, 0, 0)
            "#,
            (session_id, workspace_id, timestamp),
        )
        .context("Failed to insert initial session")?;

    transaction
        .commit()
        .context("Failed to commit create-workspace transaction")
}

pub(crate) fn update_workspace_initialization_metadata(
    workspace_id: &str,
    initialization_files_copied: i64,
    timestamp: &str,
) -> Result<()> {
    let connection = db::open_connection(true)?;
    let updated_rows = connection
        .execute(
            r#"
            UPDATE workspaces
            SET initialization_files_copied = ?2,
                updated_at = ?3
            WHERE id = ?1
            "#,
            (workspace_id, initialization_files_copied, timestamp),
        )
        .context("Failed to update workspace initialization metadata")?;

    if updated_rows != 1 {
        bail!(
            "Workspace initialization metadata update affected {updated_rows} rows for {workspace_id}"
        );
    }

    Ok(())
}

pub(crate) fn update_workspace_state(
    workspace_id: &str,
    state: &str,
    timestamp: &str,
) -> Result<()> {
    let connection = db::open_connection(true)?;
    let updated_rows = connection
        .execute(
            "UPDATE workspaces SET state = ?2, updated_at = ?3 WHERE id = ?1",
            (workspace_id, state, timestamp),
        )
        .with_context(|| format!("Failed to update workspace state to {state}"))?;

    if updated_rows != 1 {
        bail!("Workspace state update affected {updated_rows} rows for {workspace_id}");
    }

    Ok(())
}

pub(crate) fn delete_workspace_and_session_rows(
    workspace_id: &str,
    session_id: &str,
) -> Result<()> {
    let mut connection = db::open_connection(true)?;
    let transaction = connection
        .transaction()
        .context("Failed to start create cleanup transaction")?;

    transaction
        .execute(
            "DELETE FROM attachments WHERE session_id = ?1",
            [session_id],
        )
        .context("Failed to delete create-flow attachments")?;
    transaction
        .execute(
            "DELETE FROM session_messages WHERE session_id = ?1",
            [session_id],
        )
        .context("Failed to delete create-flow session messages")?;
    transaction
        .execute("DELETE FROM sessions WHERE id = ?1", [session_id])
        .context("Failed to delete create-flow session")?;
    transaction
        .execute("DELETE FROM workspaces WHERE id = ?1", [workspace_id])
        .context("Failed to delete create-flow workspace")?;

    transaction
        .commit()
        .context("Failed to commit create cleanup transaction")
}

pub(crate) fn update_archived_workspace_state(
    workspace_id: &str,
    archive_commit: &str,
) -> Result<()> {
    let mut connection = db::open_connection(true)?;
    let transaction = connection
        .transaction()
        .context("Failed to start archive transaction")?;

    let updated_rows = transaction
        .execute(
            r#"
            UPDATE workspaces
            SET state = 'archived',
                archive_commit = ?2,
                updated_at = datetime('now')
            WHERE id = ?1 AND state = 'ready'
            "#,
            (workspace_id, archive_commit),
        )
        .context("Failed to update workspace archive state")?;

    if updated_rows != 1 {
        bail!("Archive state update affected {updated_rows} rows for workspace {workspace_id}");
    }

    transaction
        .commit()
        .context("Failed to commit archive transaction")
}

pub(crate) fn update_restored_workspace_state(
    workspace_id: &str,
    archived_context_dir: &Path,
    workspace_context_dir: &Path,
    target_branch_override: Option<&str>,
) -> Result<()> {
    let mut connection = db::open_connection(true)?;
    let transaction = connection
        .transaction()
        .context("Failed to start restore transaction")?;

    let old_prefix = helpers::attachment_prefix(&archived_context_dir.join("attachments"));
    let new_prefix = helpers::attachment_prefix(&workspace_context_dir.join("attachments"));
    let updated_rows = transaction
        .execute(
            r#"
            UPDATE workspaces
            SET state = 'ready',
                updated_at = datetime('now')
            WHERE id = ?1 AND state = 'archived'
            "#,
            [workspace_id],
        )
        .context("Failed to update workspace restore state")?;

    if updated_rows != 1 {
        bail!("Restore state update affected {updated_rows} rows for workspace {workspace_id}");
    }

    transaction
        .execute(
            r#"
            UPDATE attachments
            SET path = REPLACE(path, ?1, ?2)
            WHERE session_id IN (
              SELECT id FROM sessions WHERE workspace_id = ?3
            )
              AND path LIKE ?4
            "#,
            (
                &old_prefix,
                &new_prefix,
                workspace_id,
                format!("{old_prefix}%"),
            ),
        )
        .context("Failed to update restored attachment paths")?;

    if let Some(new_target) = target_branch_override {
        transaction
            .execute(
                "UPDATE workspaces SET intended_target_branch = ?1 WHERE id = ?2",
                [new_target, workspace_id],
            )
            .context("Failed to update intended_target_branch during restore")?;
    }

    transaction
        .commit()
        .context("Failed to commit restore transaction")
}

fn workspace_record_from_row(row: &Row<'_>) -> rusqlite::Result<WorkspaceRecord> {
    Ok(WorkspaceRecord {
        id: row.get(0)?,
        repo_id: row.get(1)?,
        repo_name: row.get(2)?,
        remote_url: row.get(3)?,
        default_branch: row.get(4)?,
        root_path: row.get(5)?,
        directory_name: row.get(6)?,
        state: row.get(7)?,
        has_unread: row.get::<_, i64>(8)? != 0,
        workspace_unread: row.get(9)?,
        session_unread_total: row.get(10)?,
        unread_session_count: row.get(11)?,
        derived_status: row.get(12)?,
        manual_status: row.get(13)?,
        branch: row.get(14)?,
        initialization_parent_branch: row.get(15)?,
        intended_target_branch: row.get(16)?,
        notes: row.get(17)?,
        pinned_at: row.get(18)?,
        active_session_id: row.get(19)?,
        active_session_title: row.get(20)?,
        active_session_agent_type: row.get(21)?,
        active_session_status: row.get(22)?,
        pr_title: row.get(23)?,
        pr_description: row.get(24)?,
        archive_commit: row.get(25)?,
        session_count: row.get(26)?,
        message_count: row.get(27)?,
        attachment_count: row.get(28)?,
        remote: row.get(29)?,
    })
}
