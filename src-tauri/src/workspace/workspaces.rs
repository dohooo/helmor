use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::{
    db, helpers,
    models::workspaces::{self as workspace_models, WorkspaceRecord},
    sessions,
};

pub use super::archive::{
    start_archive_workspace, ArchiveExecutionFailedPayload, ArchiveExecutionSucceededPayload,
    ArchiveJobManager, PrepareArchiveWorkspaceResponse,
};
pub use super::branching::{
    _reset_prefetch_rate_limit, list_remote_branches, prefetch_remote_refs,
    push_workspace_to_remote, refresh_remote_and_realign, rename_workspace_branch,
    sync_workspace_with_target_branch, update_intended_target_branch,
    update_intended_target_branch_local, PrefetchRemoteRefsResponse, PushWorkspaceToRemoteResponse,
    SyncWorkspaceTargetOutcome, SyncWorkspaceTargetResponse, UpdateIntendedTargetBranchInternal,
    UpdateIntendedTargetBranchResponse,
};
pub use super::lifecycle::{
    archive_workspace_impl, create_workspace_from_repo_impl, prepare_archive_plan,
    restore_workspace_impl, validate_archive_workspace, validate_restore_workspace,
    ArchivePreparedPlan, ArchiveWorkspaceResponse, BranchRename, CreateWorkspaceResponse,
    RestoreWorkspaceResponse, TargetBranchConflict, ValidateRestoreResponse,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSidebarRow {
    pub id: String,
    pub title: String,
    pub avatar: String,
    pub directory_name: String,
    pub repo_name: String,
    pub repo_icon_src: Option<String>,
    pub repo_initials: String,
    pub state: String,
    pub has_unread: bool,
    pub workspace_unread: i64,
    pub session_unread_total: i64,
    pub unread_session_count: i64,
    pub derived_status: String,
    pub manual_status: Option<String>,
    pub branch: Option<String>,
    pub active_session_id: Option<String>,
    pub active_session_title: Option<String>,
    pub active_session_agent_type: Option<String>,
    pub active_session_status: Option<String>,
    pub pr_title: Option<String>,
    pub pinned_at: Option<String>,
    pub session_count: i64,
    pub message_count: i64,
    pub attachment_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSidebarGroup {
    pub id: String,
    pub label: String,
    pub tone: String,
    pub rows: Vec<WorkspaceSidebarRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub id: String,
    pub title: String,
    pub directory_name: String,
    pub repo_name: String,
    pub repo_icon_src: Option<String>,
    pub repo_initials: String,
    pub state: String,
    pub has_unread: bool,
    pub workspace_unread: i64,
    pub session_unread_total: i64,
    pub unread_session_count: i64,
    pub derived_status: String,
    pub manual_status: Option<String>,
    pub branch: Option<String>,
    pub active_session_id: Option<String>,
    pub active_session_title: Option<String>,
    pub active_session_agent_type: Option<String>,
    pub active_session_status: Option<String>,
    pub pr_title: Option<String>,
    pub session_count: i64,
    pub message_count: i64,
    pub attachment_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDetail {
    pub id: String,
    pub title: String,
    pub repo_id: String,
    pub repo_name: String,
    pub repo_icon_src: Option<String>,
    pub repo_initials: String,
    pub remote: Option<String>,
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
    pub active_session_id: Option<String>,
    pub active_session_title: Option<String>,
    pub active_session_agent_type: Option<String>,
    pub active_session_status: Option<String>,
    pub branch: Option<String>,
    pub initialization_parent_branch: Option<String>,
    pub intended_target_branch: Option<String>,
    pub notes: Option<String>,
    pub pinned_at: Option<String>,
    pub pr_title: Option<String>,
    pub pr_description: Option<String>,
    pub archive_commit: Option<String>,
    pub session_count: i64,
    pub message_count: i64,
    pub attachment_count: i64,
}

// Workspace persistence lives in `crate::models::workspaces`.

// ---- Sidebar groups ----

pub fn list_workspace_groups() -> Result<Vec<WorkspaceSidebarGroup>> {
    let mut pinned = Vec::new();
    let mut done = Vec::new();
    let mut review = Vec::new();
    let mut progress = Vec::new();
    let mut backlog = Vec::new();
    let mut canceled = Vec::new();

    // `load_workspace_records` already returns rows in `updated_at DESC` order
    // (newest first). Iterating in that order and bucketing into status groups
    // means each group naturally inherits the same stable order, no per-group
    // re-sort needed.
    for record in workspace_models::load_workspace_records()? {
        if record.state == "archived" {
            continue;
        }
        let is_pinned = record.pinned_at.is_some();
        let row = record_to_sidebar_row(record);
        if is_pinned {
            pinned.push(row);
        } else {
            match helpers::group_id_from_status(&row.manual_status, &row.derived_status) {
                "done" => done.push(row),
                "review" => review.push(row),
                "backlog" => backlog.push(row),
                "canceled" => canceled.push(row),
                _ => progress.push(row),
            }
        }
    }

    Ok(vec![
        WorkspaceSidebarGroup {
            id: "pinned".to_string(),
            label: "Pinned".to_string(),
            tone: "pinned".to_string(),
            rows: pinned,
        },
        WorkspaceSidebarGroup {
            id: "done".to_string(),
            label: "Done".to_string(),
            tone: "done".to_string(),
            rows: done,
        },
        WorkspaceSidebarGroup {
            id: "review".to_string(),
            label: "In review".to_string(),
            tone: "review".to_string(),
            rows: review,
        },
        WorkspaceSidebarGroup {
            id: "progress".to_string(),
            label: "In progress".to_string(),
            tone: "progress".to_string(),
            rows: progress,
        },
        WorkspaceSidebarGroup {
            id: "backlog".to_string(),
            label: "Backlog".to_string(),
            tone: "backlog".to_string(),
            rows: backlog,
        },
        WorkspaceSidebarGroup {
            id: "canceled".to_string(),
            label: "Canceled".to_string(),
            tone: "canceled".to_string(),
            rows: canceled,
        },
    ])
}

pub fn list_archived_workspaces() -> Result<Vec<WorkspaceSummary>> {
    let archived = workspace_models::load_archived_workspace_records()?
        .into_iter()
        .map(record_to_summary)
        .collect::<Vec<_>>();

    Ok(archived)
}

pub fn get_workspace(workspace_id: &str) -> Result<WorkspaceDetail> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    Ok(record_to_detail(record))
}

// ---- Mark read / unread ----

pub fn mark_workspace_read(workspace_id: &str) -> Result<()> {
    let mut connection = db::open_connection(true)?;
    let transaction = connection
        .transaction()
        .context("Failed to start workspace-read transaction")?;

    sessions::mark_workspace_read_in_transaction(&transaction, workspace_id)?;

    transaction
        .commit()
        .context("Failed to commit workspace read transaction")
}

pub fn mark_workspace_unread(workspace_id: &str) -> Result<()> {
    let mut connection = db::open_connection(true)?;
    let transaction = connection
        .transaction()
        .context("Failed to start workspace-unread transaction")?;

    sessions::mark_workspace_unread_in_transaction(&transaction, workspace_id)?;

    transaction
        .commit()
        .context("Failed to commit workspace unread transaction")
}

pub fn pin_workspace(workspace_id: &str) -> Result<()> {
    let connection = db::open_connection(true)?;
    connection
        .execute(
            "UPDATE workspaces SET pinned_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1",
            [workspace_id],
        )
        .context("Failed to pin workspace")?;
    Ok(())
}

pub fn unpin_workspace(workspace_id: &str) -> Result<()> {
    let connection = db::open_connection(true)?;
    connection
        .execute(
            "UPDATE workspaces SET pinned_at = NULL, updated_at = datetime('now') WHERE id = ?1",
            [workspace_id],
        )
        .context("Failed to unpin workspace")?;
    Ok(())
}

pub fn set_workspace_manual_status(workspace_id: &str, status: Option<&str>) -> Result<()> {
    let connection = db::open_connection(true)?;
    connection
        .execute(
            "UPDATE workspaces SET manual_status = ?2, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![workspace_id, status],
        )
        .context("Failed to set workspace manual status")?;
    Ok(())
}

// ---- Select visible workspace for repo ----

pub(crate) fn select_visible_workspace_for_repo(repo_id: &str) -> Result<Option<(String, String)>> {
    let mut visible_records = workspace_models::load_workspace_records()?
        .into_iter()
        .filter(|record| record.repo_id == repo_id && record.state != "archived")
        .collect::<Vec<_>>();

    visible_records.sort_by(|left, right| {
        helpers::sidebar_sort_rank(left)
            .cmp(&helpers::sidebar_sort_rank(right))
            .then_with(|| {
                helpers::display_title(left)
                    .to_lowercase()
                    .cmp(&helpers::display_title(right).to_lowercase())
            })
    });

    Ok(visible_records
        .into_iter()
        .next()
        .map(|record| (record.id, record.state)))
}

// ---- Record-to-DTO conversion ----

pub fn record_to_sidebar_row(record: WorkspaceRecord) -> WorkspaceSidebarRow {
    let title = helpers::display_title(&record);
    let repo_initials = helpers::repo_initials_for_name(&record.repo_name);

    WorkspaceSidebarRow {
        avatar: repo_initials.clone(),
        title,
        id: record.id,
        directory_name: record.directory_name,
        repo_name: record.repo_name,
        repo_icon_src: helpers::repo_icon_src_for_root_path(record.root_path.as_deref()),
        repo_initials,
        state: record.state,
        has_unread: record.has_unread,
        workspace_unread: record.workspace_unread,
        session_unread_total: record.session_unread_total,
        unread_session_count: record.unread_session_count,
        derived_status: record.derived_status,
        manual_status: record.manual_status,
        branch: record.branch,
        active_session_id: record.active_session_id,
        active_session_title: record.active_session_title,
        active_session_agent_type: record.active_session_agent_type,
        active_session_status: record.active_session_status,
        pr_title: record.pr_title,
        pinned_at: record.pinned_at,
        session_count: record.session_count,
        message_count: record.message_count,
        attachment_count: record.attachment_count,
    }
}

pub fn record_to_summary(record: WorkspaceRecord) -> WorkspaceSummary {
    let repo_initials = helpers::repo_initials_for_name(&record.repo_name);

    WorkspaceSummary {
        title: helpers::display_title(&record),
        id: record.id,
        directory_name: record.directory_name,
        repo_name: record.repo_name,
        repo_icon_src: helpers::repo_icon_src_for_root_path(record.root_path.as_deref()),
        repo_initials,
        state: record.state,
        has_unread: record.has_unread,
        workspace_unread: record.workspace_unread,
        session_unread_total: record.session_unread_total,
        unread_session_count: record.unread_session_count,
        derived_status: record.derived_status,
        manual_status: record.manual_status,
        branch: record.branch,
        active_session_id: record.active_session_id,
        active_session_title: record.active_session_title,
        active_session_agent_type: record.active_session_agent_type,
        active_session_status: record.active_session_status,
        pr_title: record.pr_title,
        session_count: record.session_count,
        message_count: record.message_count,
        attachment_count: record.attachment_count,
    }
}

pub fn record_to_detail(record: WorkspaceRecord) -> WorkspaceDetail {
    let repo_initials = helpers::repo_initials_for_name(&record.repo_name);

    // Use the worktree path as root_path so Claude Code/Codex operate in the
    // correct workspace directory, not the source repository.
    // Archived workspaces have no worktree — return None so the frontend
    // knows agent messaging is unavailable.
    let worktree_path = crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)
        .ok()
        .and_then(|p| {
            if p.is_dir() {
                p.to_str().map(|s| s.to_string())
            } else {
                None
            }
        });

    WorkspaceDetail {
        title: helpers::display_title(&record),
        id: record.id,
        repo_id: record.repo_id,
        repo_name: record.repo_name,
        repo_icon_src: helpers::repo_icon_src_for_root_path(record.root_path.as_deref()),
        repo_initials,
        remote: record.remote,
        remote_url: record.remote_url,
        default_branch: record.default_branch,
        root_path: worktree_path,
        directory_name: record.directory_name,
        state: record.state,
        has_unread: record.has_unread,
        workspace_unread: record.workspace_unread,
        session_unread_total: record.session_unread_total,
        unread_session_count: record.unread_session_count,
        derived_status: record.derived_status,
        manual_status: record.manual_status,
        active_session_id: record.active_session_id,
        active_session_title: record.active_session_title,
        active_session_agent_type: record.active_session_agent_type,
        active_session_status: record.active_session_status,
        branch: record.branch,
        initialization_parent_branch: record.initialization_parent_branch,
        intended_target_branch: record.intended_target_branch,
        notes: record.notes,
        pinned_at: record.pinned_at,
        pr_title: record.pr_title,
        pr_description: record.pr_description,
        archive_commit: record.archive_commit,
        session_count: record.session_count,
        message_count: record.message_count,
        attachment_count: record.attachment_count,
    }
}

/// Remove DB records for workspaces whose directory no longer exists on disk.
///
/// Called once at startup so that externally-deleted directories don't cause
/// repeated errors (e.g. git-status polling a missing path every 10 s).
pub fn purge_orphaned_workspaces() -> Result<usize> {
    let connection = db::open_connection(false)?;
    let mut stmt = connection.prepare(
        "SELECT w.id, r.name, w.directory_name
         FROM workspaces w
         JOIN repos r ON r.id = w.repository_id",
    )?;
    let orphans: Vec<(String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .filter(|(_, repo_name, dir_name)| {
            crate::data_dir::workspace_dir(repo_name, dir_name)
                .map(|p| !p.is_dir())
                .unwrap_or(false)
        })
        .collect();

    let count = orphans.len();
    for (id, repo_name, dir_name) in &orphans {
        if let Err(e) = permanently_delete_workspace(id) {
            tracing::warn!(workspace_id = %id, "Failed to purge orphaned workspace: {e:#}");
        } else {
            tracing::info!(
                workspace_id = %id,
                path = %format!("{}/{}", repo_name, dir_name),
                "Purged orphaned workspace (directory missing)"
            );
        }
    }
    Ok(count)
}

/// Permanently delete a workspace and all its data (sessions, messages,
/// attachments, diff_comments) from the database, plus any filesystem
/// artifacts (worktree directory, archived context).
pub fn permanently_delete_workspace(workspace_id: &str) -> Result<()> {
    let mut connection = db::open_connection(true)?;

    // Load workspace info for filesystem cleanup
    let record: Option<(String, String, String)> = connection
        .query_row(
            "SELECT r.name, w.directory_name, w.state FROM workspaces w JOIN repos r ON r.id = w.repository_id WHERE w.id = ?1",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();

    // Delete all DB records in a transaction
    let transaction = connection
        .transaction()
        .context("Failed to start delete workspace transaction")?;

    transaction
        .execute(
            "DELETE FROM diff_comments WHERE workspace_id = ?1",
            [workspace_id],
        )
        .context("Failed to delete workspace diff comments")?;
    transaction
        .execute(
            "DELETE FROM attachments WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
            [workspace_id],
        )
        .context("Failed to delete workspace attachments")?;
    transaction
        .execute(
            "DELETE FROM session_messages WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
            [workspace_id],
        )
        .context("Failed to delete workspace session messages")?;
    transaction
        .execute(
            "DELETE FROM sessions WHERE workspace_id = ?1",
            [workspace_id],
        )
        .context("Failed to delete workspace sessions")?;
    let deleted_rows = transaction
        .execute("DELETE FROM workspaces WHERE id = ?1", [workspace_id])
        .context("Failed to delete workspace row")?;

    if deleted_rows != 1 {
        bail!("Workspace delete affected {deleted_rows} rows for {workspace_id}");
    }

    transaction
        .commit()
        .context("Failed to commit delete workspace transaction")?;

    // Clean up in-memory caches for the deleted workspace.
    super::branching::clear_prefetch_rate_limit(workspace_id);
    db::remove_workspace_lock(workspace_id);

    // Filesystem cleanup (best-effort)
    if let Some((repo_name, directory_name, state)) = record {
        // Remove worktree directory
        if let Ok(ws_dir) = crate::data_dir::workspace_dir(&repo_name, &directory_name) {
            if ws_dir.is_dir() {
                std::fs::remove_dir_all(&ws_dir).ok();
            }
        }
        // Remove archived context
        if state == "archived" {
            if let Ok(data_dir) = crate::data_dir::data_dir() {
                let archived = data_dir
                    .join("archived-contexts")
                    .join(&repo_name)
                    .join(&directory_name);
                if archived.is_dir() {
                    std::fs::remove_dir_all(&archived).ok();
                }
            }
        }
    }

    Ok(())
}
