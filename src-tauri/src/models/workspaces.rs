use std::collections::{HashMap, HashSet};

use anyhow::{bail, Context, Result};
use rusqlite::Row;

use crate::{
    repos,
    workspace::sidebar_order,
    workspace_pr_sync::PrSyncState,
    workspace_state::{WorkspaceBranchIntent, WorkspaceMode, WorkspaceState},
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
    /// `FromBranch`: workspace owns the branch (safe to delete on archive).
    /// `UseBranch`: branch is reused, must not be deleted.
    pub branch_intent: WorkspaceBranchIntent,
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
    pub display_order: i64,
    /// `repos.display_order` for the parent repo — drives bucket ordering
    /// in the sidebar's repo grouping mode.
    pub repo_sidebar_order: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Most recent `last_user_message_at` across all sessions in the
    /// workspace. `None` for workspaces with no user messages yet.
    pub last_user_message_at: Option<String>,
    /// Timestamp of the last successful setup-script run for this
    /// workspace. `None` means setup was never run (or was skipped
    /// because the repo has no setup script).
    pub setup_completed_at: Option<String>,
    /// `repo_run_actions.id` the user last picked from the Run-tab dropdown
    /// in this workspace. `None` means "use the first action" — both for
    /// fresh workspaces and for ones whose previously-active action was
    /// deleted (the loader auto-clears stale ids).
    pub active_run_action_id: Option<String>,
    /// "manual" or "ai_triage".
    pub kind: String,
    /// False until the user sends the first message in an ai_triage workspace.
    pub ai_priming_consumed: bool,
    /// Originating triage platform for ai_triage workspaces ("github",
    /// "gitlab", "slack", "lark"). `None` for manual workspaces.
    pub triage_source_type: Option<String>,
    /// Stacked PRs: `workspaces.id` of the layer below this one (its base).
    /// `None` = bottom of stack (base is the repo default) or a non-stacked
    /// workspace. FK-by-convention; integrity enforced in the write layer.
    pub parent_workspace_id: Option<String>,
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
      COALESCE(w.branch_intent, 'from_branch') AS branch_intent,
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
      w.display_order AS display_order,
      COALESCE(r.display_order, 0) AS repo_sidebar_order,
      w.created_at,
      w.updated_at,
      wss.last_user_message_at,
      w.setup_completed_at,
      w.active_run_action_id,
      COALESCE(w.kind, 'manual') AS kind,
      COALESCE(w.ai_priming_consumed, 0) AS ai_priming_consumed,
      w.triage_source_type,
      w.parent_workspace_id
    FROM workspaces w
    JOIN repos r ON r.id = w.repository_id
    LEFT JOIN sessions s ON s.id = w.active_session_id
    LEFT JOIN workspace_session_stats wss ON wss.workspace_id = w.id
    LEFT JOIN primary_session ps ON ps.workspace_id = w.id
"#;

pub fn load_workspace_records() -> Result<Vec<WorkspaceRecord>> {
    let connection = db::read_conn()?;
    let sql = format!(
        "{WORKSPACE_RECORD_SQL} ORDER BY w.display_order ASC, datetime(w.created_at) DESC, datetime(w.updated_at) DESC, w.id DESC"
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

#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_initializing_workspace_and_session(
    repository: &repos::RepositoryRecord,
    workspace_id: &str,
    session_id: &str,
    directory_name: &str,
    branch: &str,
    default_branch: &str,
    branch_intent: WorkspaceBranchIntent,
    status: WorkspaceStatus,
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
        branch_intent,
        status,
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
    branch_intent: WorkspaceBranchIntent,
    status: WorkspaceStatus,
    timestamp: &str,
) -> Result<()> {
    let mut connection = db::write_conn()?;
    let transaction = connection
        .transaction()
        .context("Failed to start create-workspace transaction")?;
    let next_order = transaction
        .query_row(
            r#"
                SELECT COALESCE(MAX(display_order), 0) + ?2
                FROM workspaces
                WHERE state <> ?1
                  AND pinned_at IS NULL
                  AND COALESCE(status, 'in-progress') = ?3
                "#,
            rusqlite::params![WorkspaceState::Archived, sidebar_order::ORDER_STEP, status],
            |row| row.get::<_, i64>(0),
        )
        .context("Failed to compute next workspace display order")?;

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
              branch_intent,
              display_order,
              status,
              unread,
              created_at,
              updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, ?13)
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
                branch_intent,
                next_order,
                status,
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

/// Insert a Chat-mode workspace + its initial session in a single
/// transaction. Chat workspaces have no branch and no parent/intended
/// target branch — those columns stay NULL. `repository_id` points at
/// the synthetic `SYSTEM_CHAT_REPO_ID` row.
///
/// `directory_name` stores the relative scratch path
/// (`"YYYY-MM-DD/new-chat[-N]"`); `helpers::workspace_path` joins it
/// under `chats_dir` to resolve the absolute cwd at read time.
pub(crate) fn insert_chat_workspace_and_session(
    repository: &repos::RepositoryRecord,
    workspace_id: &str,
    session_id: &str,
    directory_name: &str,
    status: WorkspaceStatus,
    timestamp: &str,
) -> Result<()> {
    let mut connection = db::write_conn()?;
    let transaction = connection
        .transaction()
        .context("Failed to start create-chat-workspace transaction")?;

    let next_order = transaction
        .query_row(
            r#"
                SELECT COALESCE(MAX(display_order), 0) + ?2
                FROM workspaces
                WHERE state <> ?1
                  AND pinned_at IS NULL
                  AND COALESCE(status, 'in-progress') = ?3
                "#,
            rusqlite::params![WorkspaceState::Archived, sidebar_order::ORDER_STEP, status],
            |row| row.get::<_, i64>(0),
        )
        .context("Failed to compute next workspace display order")?;

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
              branch_intent,
              display_order,
              status,
              unread,
              created_at,
              updated_at
            ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, ?6, ?7, ?8, ?9, 0, ?10, ?10)
            "#,
            (
                workspace_id,
                repository.id.as_str(),
                directory_name,
                session_id,
                WorkspaceState::Initializing,
                WorkspaceMode::Chat,
                WorkspaceBranchIntent::UseBranch,
                next_order,
                status,
                timestamp,
            ),
        )
        .context("Failed to insert chat workspace")?;

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
        .context("Failed to insert initial chat session")?;

    transaction
        .commit()
        .context("Failed to commit create-chat-workspace transaction")
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

/// Stamp the workspace as having successfully run its setup script and
/// flip it to `ready`. Distinct from `update_workspace_state` so the
/// "skipped setup (no script)" path can stay timestamp-less — that's
/// what lets the inspector tell apart "ran in another session" vs
/// "never ran" after a restart.
pub(crate) fn mark_setup_completed(workspace_id: &str, timestamp: &str) -> Result<()> {
    let connection = db::write_conn()?;
    let updated_rows = connection
        .execute(
            "UPDATE workspaces SET state = ?2, setup_completed_at = ?3, updated_at = ?3 WHERE id = ?1",
            (workspace_id, WorkspaceState::Ready, timestamp),
        )
        .context("Failed to mark workspace setup completed")?;

    if updated_rows != 1 {
        bail!("Setup-completion update affected {updated_rows} rows for {workspace_id}");
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
            "DELETE FROM session_plan_state
             WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
            [workspace_id],
        )
        .context("Failed to delete create-flow session plan state")?;
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
        branch_intent: row.get(16)?,
        pinned_at: row.get(17)?,
        active_session_id: row.get(18)?,
        active_session_title: row.get(19)?,
        active_session_agent_type: row.get(20)?,
        active_session_status: row.get(21)?,
        primary_session_id: row.get(22)?,
        primary_session_title: row.get(23)?,
        primary_session_agent_type: row.get(24)?,
        pr_title: row.get(25)?,
        pr_sync_state: row.get(26)?,
        pr_url: row.get(27)?,
        archive_commit: row.get(28)?,
        session_count: row.get(29)?,
        message_count: row.get(30)?,
        remote: row.get(31)?,
        forge_provider: row.get(32)?,
        forge_login: row.get(33)?,
        display_order: row.get(34)?,
        repo_sidebar_order: row.get(35)?,
        created_at: row.get(36)?,
        updated_at: row.get(37)?,
        last_user_message_at: row.get(38)?,
        setup_completed_at: row.get(39)?,
        active_run_action_id: row.get(40)?,
        kind: row.get(41)?,
        ai_priming_consumed: row.get::<_, i64>(42)? != 0,
        triage_source_type: row.get(43)?,
        parent_workspace_id: row.get(44)?,
    })
}

/// Set (or clear) the stacked-PR parent link for a workspace. `Some(id)`
/// records that this workspace stacks on `id` (its base); `None` clears it.
/// Drives sidebar nesting and the future restack cascade.
pub(crate) fn set_workspace_parent_id(
    workspace_id: &str,
    parent_workspace_id: Option<&str>,
) -> Result<()> {
    let connection = db::write_conn()?;
    let updated = connection
        .execute(
            "UPDATE workspaces SET parent_workspace_id = ?1, updated_at = datetime('now') WHERE id = ?2",
            (parent_workspace_id, workspace_id),
        )
        .context("Failed to update workspace parent_workspace_id")?;
    if updated != 1 {
        bail!("Cannot set parent for workspace {workspace_id}: row not found");
    }
    Ok(())
}

/// Rename a workspace's own branch AND cascade the new name to every direct
/// stacked child whose `intended_target_branch` tracks it.
///
/// `intended_target_branch` is a denormalized cache of the parent's branch
/// (materialized when the child is stacked). Without this cascade a child's
/// target goes stale the moment the parent's branch changes — via the header
/// rename, or the LLM branch regeneration after the first message. One level
/// suffices: each child targets only its DIRECT parent's branch.
///
/// Both UPDATEs run in one transaction so a child is never left pointing at a
/// branch its parent no longer has.
pub(crate) fn update_workspace_branch(workspace_id: &str, new_branch: &str) -> Result<()> {
    let mut connection = db::write_conn()?;
    let tx = connection.transaction()?;
    let updated = tx
        .execute(
            "UPDATE workspaces SET branch = ?1 WHERE id = ?2",
            (new_branch, workspace_id),
        )
        .context("Failed to update workspace branch")?;
    if updated != 1 {
        bail!("Cannot update branch for workspace {workspace_id}: row not found");
    }
    tx.execute(
        "UPDATE workspaces SET intended_target_branch = ?1 WHERE parent_workspace_id = ?2",
        (new_branch, workspace_id),
    )
    .context("Failed to cascade branch rename to stacked children")?;
    tx.commit()
        .context("Failed to commit workspace branch update")?;
    Ok(())
}

/// One layer of a PR stack, ordered root → tip by [`load_workspace_stack`].
#[derive(Debug, Clone)]
pub struct StackLayer {
    pub id: String,
    pub repo_name: String,
    pub directory_name: String,
    /// Display title (primary session title); the presentation layer falls
    /// back to `directory_name` when this is `None`.
    pub title: Option<String>,
    pub branch: Option<String>,
    pub intended_target_branch: Option<String>,
    pub pr_sync_state: PrSyncState,
    pub pr_url: Option<String>,
    pub status: WorkspaceStatus,
    pub parent_workspace_id: Option<String>,
}

fn record_to_stack_layer(record: &WorkspaceRecord) -> StackLayer {
    StackLayer {
        id: record.id.clone(),
        repo_name: record.repo_name.clone(),
        directory_name: record.directory_name.clone(),
        title: record.primary_session_title.clone(),
        branch: record.branch.clone(),
        intended_target_branch: record.intended_target_branch.clone(),
        pr_sync_state: record.pr_sync_state,
        pr_url: record.pr_url.clone(),
        status: record.status,
        parent_workspace_id: record.parent_workspace_id.clone(),
    }
}

/// Cheap check: does any workspace point at `workspace_id` as its stack parent?
fn has_stack_children(workspace_id: &str) -> Result<bool> {
    let connection = db::read_conn()?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE parent_workspace_id = ?1)",
            [workspace_id],
            |row| row.get(0),
        )
        .context("Failed to check stack children")?;
    Ok(exists)
}

/// Load the ordered PR-stack chain (root → tip) that `workspace_id` belongs to.
///
/// A non-stacked workspace (no parent, no children) returns a single-element
/// vec containing itself. A stack never spans repos, so the walk is restricted
/// to the workspace's own repo. Defensive against dangling parent ids and
/// cycles; on a fork (a layer with multiple children) it follows the
/// earliest-created child deterministically.
pub fn load_workspace_stack(workspace_id: &str) -> Result<Vec<StackLayer>> {
    let Some(start) = load_workspace_record_by_id(workspace_id)? else {
        return Ok(Vec::new());
    };
    // Fast path: no parent and no children → not stacked. Skip the repo scan
    // (this runs on every message send for the common non-stacked workspace).
    if start.parent_workspace_id.is_none() && !has_stack_children(&start.id)? {
        return Ok(vec![record_to_stack_layer(&start)]);
    }
    let repo_id = start.repo_id.clone();

    let by_id: HashMap<String, WorkspaceRecord> = load_workspace_records()?
        .into_iter()
        .filter(|record| record.repo_id == repo_id)
        .map(|record| (record.id.clone(), record))
        .collect();

    let mut seen: HashSet<String> = HashSet::new();

    // Walk up from `start` to the root (topmost visible ancestor), then
    // reverse so the chain reads root → start.
    let mut chain: Vec<String> = Vec::new();
    let mut cursor = Some(start.id.clone());
    while let Some(id) = cursor {
        if !seen.insert(id.clone()) {
            break; // cycle guard
        }
        cursor = by_id
            .get(&id)
            .and_then(|record| record.parent_workspace_id.clone())
            .filter(|parent| by_id.contains_key(parent));
        chain.push(id);
    }
    chain.reverse();

    // Walk down from `start` following the earliest-created child each step.
    let child_of = |parent_id: &str| -> Option<&WorkspaceRecord> {
        by_id
            .values()
            .filter(|record| record.parent_workspace_id.as_deref() == Some(parent_id))
            .min_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| a.id.cmp(&b.id))
            })
    };
    let mut cursor = child_of(&start.id).map(|record| record.id.clone());
    while let Some(id) = cursor {
        if !seen.insert(id.clone()) {
            break; // cycle / already-seen guard
        }
        cursor = child_of(&id).map(|record| record.id.clone());
        chain.push(id);
    }

    Ok(chain
        .iter()
        .filter_map(|id| by_id.get(id))
        .map(record_to_stack_layer)
        .collect())
}

/// Persist the user-picked active run-action id for a workspace. Passing
/// `None` clears the column (read sites fall back to the first action).
pub fn update_workspace_active_run_action(
    workspace_id: &str,
    action_id: Option<&str>,
) -> Result<()> {
    let connection = db::write_conn()?;
    let updated = connection
        .execute(
            "UPDATE workspaces SET active_run_action_id = ?1, updated_at = datetime('now') WHERE id = ?2",
            (action_id, workspace_id),
        )
        .with_context(|| format!("Failed to update active_run_action_id for {workspace_id}"))?;

    if updated != 1 {
        bail!("Workspace not found: {workspace_id}");
    }

    Ok(())
}
