use anyhow::{bail, Context, Result};
use rusqlite::Row;

use crate::{
    repos,
    workspace_pr_sync::PrSyncState,
    workspace_state::{WorkspaceMode, WorkspaceState},
    workspace_status::WorkspaceStatus,
};

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
    pub state: WorkspaceState,
    pub has_unread: bool,
    pub workspace_unread: i64,
    pub unread_session_count: i64,
    pub status: WorkspaceStatus,
    pub branch: Option<String>,
    pub initialization_parent_branch: Option<String>,
    pub intended_target_branch: Option<String>,
    pub mode: WorkspaceMode,
    pub pinned_at: Option<String>,
    pub active_session_id: Option<String>,
    pub active_session_title: Option<String>,
    pub active_session_agent_type: Option<String>,
    pub active_session_status: Option<String>,
    /// "Primary" session = the non-hidden, non-action session in this
    /// workspace with the most messages. Falls back to most recently
    /// updated when message counts tie. None for workspaces with no
    /// real conversation yet (only action / hidden sessions).
    pub primary_session_id: Option<String>,
    pub primary_session_title: Option<String>,
    pub primary_session_agent_type: Option<String>,
    pub pr_title: Option<String>,
    pub pr_sync_state: PrSyncState,
    pub pr_url: Option<String>,
    pub archive_commit: Option<String>,
    pub session_count: i64,
    pub message_count: i64,
    pub remote: Option<String>,
    pub forge_provider: Option<String>,
    /// gh/glab account login bound to the parent repo. NULL means
    /// auto-detect found no logged-in account with access (or the row
    /// predates the binding feature).
    pub forge_login: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Most recent `last_user_message_at` across all sessions in the
    /// workspace. `None` for workspaces with no user messages yet.
    pub last_user_message_at: Option<String>,
}

pub const WORKSPACE_RECORD_SQL: &str = r#"
    WITH
    -- One per-session message count, computed once. Reused by both
    -- `message_stats` (workspace-level total via SUM) and
    -- `primary_session` (per-session ranking). Avoids scanning the
    -- (potentially huge) `session_messages` table twice. Index
    -- `idx_session_messages_sent_at(session_id, sent_at)` makes the
    -- group-by index-only.
    session_message_counts AS (
      SELECT session_id, COUNT(*) AS message_count
      FROM session_messages
      GROUP BY session_id
    ),
    -- Per-workspace session aggregates derived in a single sweep:
    -- session_count, unread_session_count, message_count, last_user_msg.
    -- One scan of `sessions` (covered by idx_sessions_workspace_id)
    -- + one LEFT JOIN to the cached session_message_counts.
    --
    -- `last_user_message_at` intentionally MAXes across ALL sessions
    -- (including hidden / action sessions). It signals "any user
    -- activity in this workspace at all" — distinct from
    -- `primary_session` below which excludes hidden / action sessions
    -- because that is for choosing the displayed conversation title.
    workspace_session_stats AS (
      SELECT
        s.workspace_id,
        COUNT(*) AS session_count,
        SUM(CASE WHEN COALESCE(s.unread_count, 0) > 0 THEN 1 ELSE 0 END) AS unread_session_count,
        COALESCE(SUM(smc.message_count), 0) AS message_count,
        MAX(s.last_user_message_at) AS last_user_message_at
      FROM sessions s
      LEFT JOIN session_message_counts smc ON smc.session_id = s.id
      GROUP BY s.workspace_id
    ),
    -- Pick the "real" conversation per workspace: the non-hidden,
    -- non-action session with the most messages. Ties broken by most
    -- recent updated_at, then session id for determinism. Action /
    -- hidden sessions (commit-and-push, create-pr, etc.) are excluded
    -- so a fleeting one-off doesn't masquerade as the workspace's
    -- topic.
    primary_session AS (
      SELECT session_id, workspace_id, session_title, session_agent_type
      FROM (
        SELECT
          s.id AS session_id,
          s.workspace_id,
          s.title AS session_title,
          s.agent_type AS session_agent_type,
          ROW_NUMBER() OVER (
            PARTITION BY s.workspace_id
            ORDER BY
              COALESCE(smc.message_count, 0) DESC,
              s.updated_at DESC,
              s.id DESC
          ) AS rn
        FROM sessions s
        LEFT JOIN session_message_counts smc ON smc.session_id = s.id
        WHERE COALESCE(s.is_hidden, 0) = 0
          AND s.action_kind IS NULL
      )
      WHERE rn = 1
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
        WHEN COALESCE(w.unread, 0) > 0 OR COALESCE(wss.unread_session_count, 0) > 0 THEN 1
        ELSE 0
      END AS has_unread,
      COALESCE(w.unread, 0) AS workspace_unread,
      COALESCE(wss.unread_session_count, 0) AS unread_session_count,
      COALESCE(w.status, 'in-progress') AS status,
      w.branch,
      w.initialization_parent_branch,
      w.intended_target_branch,
      COALESCE(w.mode, 'worktree') AS mode,
      w.pinned_at,
      w.active_session_id,
      s.title AS active_session_title,
      s.agent_type AS active_session_agent_type,
      s.status AS active_session_status,
      ps.session_id AS primary_session_id,
      ps.session_title AS primary_session_title,
      ps.session_agent_type AS primary_session_agent_type,
      w.pr_title,
      COALESCE(w.pr_sync_state, 'none') AS pr_sync_state,
      w.pr_url,
      w.archive_commit,
      COALESCE(wss.session_count, 0) AS session_count,
      COALESCE(wss.message_count, 0) AS message_count,
      r.remote,
      r.forge_provider,
      r.forge_login,
      w.created_at,
      w.updated_at,
      wss.last_user_message_at
    FROM workspaces w
    JOIN repos r ON r.id = w.repository_id
    LEFT JOIN sessions s ON s.id = w.active_session_id
    LEFT JOIN workspace_session_stats wss ON wss.workspace_id = w.id
    LEFT JOIN primary_session ps ON ps.workspace_id = w.id
"#;

pub fn load_workspace_records() -> Result<Vec<WorkspaceRecord>> {
    let connection = db::read_conn()?;
    let sql = format!(
        "{WORKSPACE_RECORD_SQL} ORDER BY datetime(w.created_at) DESC, datetime(w.updated_at) DESC, w.id DESC"
    );
    let mut statement = connection.prepare(&sql)?;

    let rows = statement.query_map([], workspace_record_from_row)?;

    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn load_workspace_record_by_id(workspace_id: &str) -> Result<Option<WorkspaceRecord>> {
    let connection = db::read_conn()?;
    let mut statement =
        connection.prepare(format!("{WORKSPACE_RECORD_SQL} WHERE w.id = ?1").as_str())?;

    let mut rows = statement.query_map([workspace_id], workspace_record_from_row)?;

    match rows.next() {
        Some(result) => Ok(result.map(Some)?),
        None => Ok(None),
    }
}

pub fn load_archived_workspace_records() -> Result<Vec<WorkspaceRecord>> {
    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(&format!(
            // Archived list sorts by `updated_at DESC` so the most recently
            // archived workspace shows at the top — `archive_workspace_impl`
            // explicitly bumps `updated_at` to `now` when transitioning the
            // state to 'archived', so this column doubles as "archived at"
            // for ordering purposes (no separate column needed).
            "{WORKSPACE_RECORD_SQL} WHERE w.state = ?1 ORDER BY w.updated_at DESC"
        ))
        .context("Failed to prepare archived workspaces query")?;

    let rows = statement.query_map([WorkspaceState::Archived], workspace_record_from_row)?;

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
    insert_initializing_workspace_and_session_with_mode(
        repository,
        workspace_id,
        session_id,
        directory_name,
        branch,
        default_branch,
        WorkspaceMode::Worktree,
        timestamp,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_initializing_workspace_and_session_with_mode(
    repository: &repos::RepositoryRecord,
    workspace_id: &str,
    session_id: &str,
    directory_name: &str,
    branch: &str,
    default_branch: &str,
    mode: WorkspaceMode,
    timestamp: &str,
) -> Result<()> {
    let mut connection = db::write_conn()?;
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
              state,
              initialization_parent_branch,
              intended_target_branch,
              mode,
              status,
              unread,
              created_at,
              updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'in-progress', 0, ?10, ?10)
            "#,
            (
                workspace_id,
                repository.id.as_str(),
                directory_name,
                session_id,
                branch,
                WorkspaceState::Initializing,
                default_branch,
                default_branch,
                mode,
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
              fast_mode,
              created_at,
              updated_at,
              is_hidden
            ) VALUES (?1, ?2, 'Untitled', 'idle', 'default', 0, 0, ?3, ?3, 0)
            "#,
            (session_id, workspace_id, timestamp),
        )
        .context("Failed to insert initial session")?;

    transaction
        .commit()
        .context("Failed to commit create-workspace transaction")
}

/// Atomically convert a local-mode workspace into a worktree-mode one.
/// Used by the move-local-to-worktree flow once the new worktree
/// directory + branch have been created on disk.
pub(crate) fn convert_to_worktree(
    workspace_id: &str,
    directory_name: &str,
    branch: &str,
    intended_target_branch: &str,
    initialization_parent_branch: &str,
    timestamp: &str,
) -> Result<()> {
    let connection = db::write_conn()?;
    let updated = connection
        .execute(
            r#"
            UPDATE workspaces
            SET mode = 'worktree',
                directory_name = ?2,
                branch = ?3,
                intended_target_branch = ?4,
                initialization_parent_branch = ?5,
                updated_at = ?6
            WHERE id = ?1 AND COALESCE(mode, 'worktree') = 'local'
            "#,
            (
                workspace_id,
                directory_name,
                branch,
                intended_target_branch,
                initialization_parent_branch,
                timestamp,
            ),
        )
        .with_context(|| {
            format!("Failed to convert workspace {workspace_id} from local to worktree")
        })?;
    if updated != 1 {
        bail!(
            "Workspace {workspace_id} could not be converted to worktree (already worktree or missing)"
        );
    }
    Ok(())
}

pub(crate) fn update_workspace_state(
    workspace_id: &str,
    state: WorkspaceState,
    timestamp: &str,
) -> Result<()> {
    let connection = db::write_conn()?;
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

pub(crate) fn delete_workspace_and_session_rows(workspace_id: &str) -> Result<()> {
    let mut connection = db::write_conn()?;
    let transaction = connection
        .transaction()
        .context("Failed to start create cleanup transaction")?;

    transaction
        .execute(
            "DELETE FROM session_messages
             WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
            [workspace_id],
        )
        .context("Failed to delete create-flow session messages")?;
    transaction
        .execute(
            "DELETE FROM sessions WHERE workspace_id = ?1",
            [workspace_id],
        )
        .context("Failed to delete create-flow sessions")?;
    transaction
        .execute("DELETE FROM workspaces WHERE id = ?1", [workspace_id])
        .context("Failed to delete create-flow workspace")?;

    transaction
        .commit()
        .context("Failed to commit create cleanup transaction")
}

/// Orphan lookup for the startup cleanup path: returns workspace rows
/// stuck in `initializing` state whose `created_at` is older than
/// `max_age_seconds` seconds ago. These are typically left behind when
/// the app was force-quit during Phase 2 of workspace creation.
pub(crate) fn list_initializing_workspaces_older_than(
    max_age_seconds: i64,
) -> Result<Vec<OrphanedInitializingWorkspace>> {
    let connection = db::read_conn()?;
    let cutoff = format!("datetime('now', '-{} seconds')", max_age_seconds.max(0));
    let sql = format!("{WORKSPACE_RECORD_SQL} WHERE w.state = ?1 AND w.created_at < {cutoff}",);
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(
        [WorkspaceState::Initializing.as_str()],
        workspace_record_from_row,
    )?;

    let records: Vec<WorkspaceRecord> = rows.collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(records
        .into_iter()
        .map(|record| OrphanedInitializingWorkspace { record })
        .collect())
}

pub(crate) struct OrphanedInitializingWorkspace {
    pub record: WorkspaceRecord,
}

pub(crate) fn update_archived_workspace_state(
    workspace_id: &str,
    archive_commit: &str,
) -> Result<()> {
    let mut connection = db::write_conn()?;
    let transaction = connection
        .transaction()
        .context("Failed to start archive transaction")?;

    let updated_rows = transaction
        .execute(
            r#"
            UPDATE workspaces
            SET state = ?3,
                archive_commit = ?2,
                updated_at = datetime('now')
            WHERE id = ?1 AND state IN (?4, ?5)
            "#,
            (
                workspace_id,
                archive_commit,
                WorkspaceState::Archived,
                WorkspaceState::Ready,
                WorkspaceState::SetupPending,
            ),
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
    target_branch_override: Option<&str>,
) -> Result<()> {
    let mut connection = db::write_conn()?;
    let transaction = connection
        .transaction()
        .context("Failed to start restore transaction")?;

    let updated_rows = transaction
        .execute(
            r#"
            UPDATE workspaces
            SET state = ?2,
                updated_at = datetime('now')
            WHERE id = ?1 AND state = ?3
            "#,
            (
                workspace_id,
                WorkspaceState::Ready,
                WorkspaceState::Archived,
            ),
        )
        .context("Failed to update workspace restore state")?;

    if updated_rows != 1 {
        bail!("Restore state update affected {updated_rows} rows for workspace {workspace_id}");
    }

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
        unread_session_count: row.get(10)?,
        status: row.get(11)?,
        branch: row.get(12)?,
        initialization_parent_branch: row.get(13)?,
        intended_target_branch: row.get(14)?,
        mode: row.get(15)?,
        pinned_at: row.get(16)?,
        active_session_id: row.get(17)?,
        active_session_title: row.get(18)?,
        active_session_agent_type: row.get(19)?,
        active_session_status: row.get(20)?,
        primary_session_id: row.get(21)?,
        primary_session_title: row.get(22)?,
        primary_session_agent_type: row.get(23)?,
        pr_title: row.get(24)?,
        pr_sync_state: row.get(25)?,
        pr_url: row.get(26)?,
        archive_commit: row.get(27)?,
        session_count: row.get(28)?,
        message_count: row.get(29)?,
        remote: row.get(30)?,
        forge_provider: row.get(31)?,
        forge_login: row.get(32)?,
        created_at: row.get(33)?,
        updated_at: row.get(34)?,
        last_user_message_at: row.get(35)?,
    })
}
