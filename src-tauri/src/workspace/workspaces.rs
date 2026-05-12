use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::{
    db,
    error::{coded, ErrorCode},
    forge::ChangeRequestInfo,
    helpers,
    models::workspaces::{self as workspace_models, WorkspaceRecord},
    sessions,
    workspace_pr_sync::PrSyncState,
    workspace_state::{WorkspaceMode, WorkspaceState},
    workspace_status::WorkspaceStatus,
};

pub use super::archive::{
    start_archive_workspace, ArchiveExecutionFailedPayload, ArchiveExecutionSucceededPayload,
    ArchiveJobManager, PrepareArchiveWorkspaceResponse,
};
pub use super::branching::{
    _reset_prefetch_rate_limit, continue_workspace_from_target_branch, list_remote_branches,
    prefetch_remote_refs, push_workspace_to_remote, refresh_remote_and_realign,
    rename_workspace_branch, sync_workspace_with_target_branch, update_intended_target_branch,
    update_intended_target_branch_local, ContinueWorkspaceResponse, PrefetchRemoteRefsResponse,
    PushWorkspaceToRemoteResponse, SyncWorkspaceTargetOutcome, SyncWorkspaceTargetResponse,
    UpdateIntendedTargetBranchInternal, UpdateIntendedTargetBranchResponse,
};
pub use super::lifecycle::{
    archive_workspace_impl, cleanup_orphaned_initializing_workspaces,
    create_workspace_from_repo_impl, execute_archive_plan, finalize_workspace_from_repo_impl,
    move_local_workspace_to_worktree_impl, prepare_archive_plan, prepare_local_workspace_impl,
    prepare_workspace_from_repo_impl, restore_workspace_impl, validate_archive_workspace,
    validate_restore_workspace, ArchivePreparedPlan, ArchiveWorkspaceResponse, BranchRename,
    CreateWorkspaceResponse, FinalizeWorkspaceResponse, MoveLocalToWorktreeResponse,
    PrepareWorkspaceResponse, RestoreWorkspaceResponse, TargetBranchConflict,
    ValidateRestoreResponse,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSidebarRow {
    pub id: String,
    pub title: String,
    pub avatar: String,
    pub directory_name: String,
    pub repo_id: String,
    pub repo_name: String,
    pub repo_icon_src: Option<String>,
    pub repo_initials: String,
    pub state: WorkspaceState,
    pub mode: WorkspaceMode,
    pub has_unread: bool,
    pub workspace_unread: i64,
    pub unread_session_count: i64,
    pub status: WorkspaceStatus,
    pub branch: Option<String>,
    pub active_session_id: Option<String>,
    pub active_session_title: Option<String>,
    pub active_session_agent_type: Option<String>,
    pub active_session_status: Option<String>,
    pub primary_session_id: Option<String>,
    pub primary_session_title: Option<String>,
    pub primary_session_agent_type: Option<String>,
    pub pr_title: Option<String>,
    pub pr_sync_state: PrSyncState,
    pub pr_url: Option<String>,
    pub pinned_at: Option<String>,
    pub session_count: i64,
    pub message_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_user_message_at: Option<String>,
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
    pub repo_id: String,
    pub repo_name: String,
    pub repo_icon_src: Option<String>,
    pub repo_initials: String,
    pub state: WorkspaceState,
    pub mode: WorkspaceMode,
    pub has_unread: bool,
    pub workspace_unread: i64,
    pub unread_session_count: i64,
    pub status: WorkspaceStatus,
    pub branch: Option<String>,
    pub active_session_id: Option<String>,
    pub active_session_title: Option<String>,
    pub active_session_agent_type: Option<String>,
    pub active_session_status: Option<String>,
    pub primary_session_id: Option<String>,
    pub primary_session_title: Option<String>,
    pub primary_session_agent_type: Option<String>,
    pub pr_title: Option<String>,
    pub pr_sync_state: PrSyncState,
    pub pr_url: Option<String>,
    pub pinned_at: Option<String>,
    pub session_count: i64,
    pub message_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_user_message_at: Option<String>,
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
    pub state: WorkspaceState,
    pub has_unread: bool,
    pub workspace_unread: i64,
    pub unread_session_count: i64,
    pub status: WorkspaceStatus,
    pub active_session_id: Option<String>,
    pub active_session_title: Option<String>,
    pub active_session_agent_type: Option<String>,
    pub active_session_status: Option<String>,
    pub branch: Option<String>,
    pub initialization_parent_branch: Option<String>,
    pub intended_target_branch: Option<String>,
    pub mode: WorkspaceMode,
    pub pinned_at: Option<String>,
    pub pr_title: Option<String>,
    pub pr_sync_state: PrSyncState,
    pub pr_url: Option<String>,
    pub archive_commit: Option<String>,
    pub session_count: i64,
    pub message_count: i64,
    /// Cached forge classification ("github" / "gitlab" / "unknown") on
    /// the parent repo. Drives whether the right-top "Connect" button
    /// targets `gh auth login` or `glab auth login`.
    pub forge_provider: Option<String>,
    /// gh/glab account login bound to this repo. NULL when no account
    /// has been bound (auto-detect didn't find one); the UI shows the
    /// "Connect" prompt in that case.
    pub forge_login: Option<String>,
    /// Timestamp of the most recent successful setup-script run for
    /// this workspace. NULL if setup has never been run (or the
    /// workspace was created before this column existed). Drives the
    /// inspector's Setup tab "ran in another session" notice.
    pub setup_completed_at: Option<String>,
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

    // `load_workspace_records` already returns rows in newest-created-first
    // order. Iterating in that order and bucketing into status groups means
    // each group naturally inherits the same stable order, no per-group
    // re-sort needed.
    for record in workspace_models::load_workspace_records()? {
        if record.state == WorkspaceState::Archived {
            continue;
        }
        let is_pinned = record.pinned_at.is_some();
        let row = record_to_sidebar_row(record);
        if is_pinned {
            pinned.push(row);
        } else {
            match row.status {
                WorkspaceStatus::Done => done.push(row),
                WorkspaceStatus::Review => review.push(row),
                WorkspaceStatus::Backlog => backlog.push(row),
                WorkspaceStatus::Canceled => canceled.push(row),
                WorkspaceStatus::InProgress => progress.push(row),
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
        .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    Ok(record_to_detail(record))
}

// ---- Read / unread ----

pub fn mark_workspace_read(workspace_id: &str) -> Result<()> {
    let mut connection = db::write_conn()?;
    let transaction = connection
        .transaction()
        .context("Failed to start workspace-read transaction")?;

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

    transaction
        .commit()
        .context("Failed to commit workspace read transaction")
}

pub fn mark_workspace_unread(workspace_id: &str) -> Result<()> {
    let mut connection = db::write_conn()?;
    let transaction = connection
        .transaction()
        .context("Failed to start workspace-unread transaction")?;

    sessions::mark_workspace_unread_in_transaction(&transaction, workspace_id)?;

    transaction
        .commit()
        .context("Failed to commit workspace unread transaction")
}

pub fn pin_workspace(workspace_id: &str) -> Result<()> {
    let connection = db::write_conn()?;
    connection
        .execute(
            "UPDATE workspaces SET pinned_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1",
            [workspace_id],
        )
        .context("Failed to pin workspace")?;
    Ok(())
}

pub fn unpin_workspace(workspace_id: &str) -> Result<()> {
    let connection = db::write_conn()?;
    connection
        .execute(
            "UPDATE workspaces SET pinned_at = NULL, updated_at = datetime('now') WHERE id = ?1",
            [workspace_id],
        )
        .context("Failed to unpin workspace")?;
    Ok(())
}

pub fn set_workspace_status(workspace_id: &str, status: WorkspaceStatus) -> Result<()> {
    let connection = db::write_conn()?;
    connection
        .execute(
            "UPDATE workspaces SET status = ?2, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![workspace_id, status],
        )
        .context("Failed to set workspace status")?;
    Ok(())
}

pub fn sync_workspace_pr_state(
    workspace_id: &str,
    change_request: Option<&ChangeRequestInfo>,
) -> Result<bool> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;
    if !record.state.is_operational() {
        return Ok(false);
    }

    let next_state = stabilize_pr_sync_state(
        record.pr_sync_state,
        pr_sync_state_from_change_request(change_request),
    );

    // Always reflect the live request's title/url when present; clear them
    // when the PR has disappeared. Lets the inspector render the PR badge
    // optimistically on next visit without waiting for the live fetch.
    let (next_title, next_url) = match change_request {
        Some(cr) => (Some(cr.title.clone()), Some(cr.url.clone())),
        None => (None, None),
    };

    let state_changed = record.pr_sync_state != next_state;
    let title_changed = record.pr_title != next_title;
    let url_changed = record.pr_url != next_url;
    if !state_changed && !title_changed && !url_changed {
        return Ok(false);
    }

    let target_status = if state_changed {
        match next_state {
            PrSyncState::Open => Some(WorkspaceStatus::Review),
            PrSyncState::Closed => Some(WorkspaceStatus::Canceled),
            PrSyncState::Merged => Some(WorkspaceStatus::Done),
            PrSyncState::None => None,
        }
    } else {
        None
    };

    let connection = db::write_conn()?;
    if let Some(status) = target_status {
        connection
            .execute(
                r#"
                UPDATE workspaces
                SET pr_sync_state = ?2,
                    pr_title = ?3,
                    pr_url = ?4,
                    status = ?5,
                    updated_at = datetime('now')
                WHERE id = ?1
                "#,
                rusqlite::params![workspace_id, next_state, next_title, next_url, status],
            )
            .context("Failed to sync workspace PR state")?;
    } else {
        connection
            .execute(
                r#"
                UPDATE workspaces
                SET pr_sync_state = ?2,
                    pr_title = ?3,
                    pr_url = ?4,
                    updated_at = datetime('now')
                WHERE id = ?1
                "#,
                rusqlite::params![workspace_id, next_state, next_title, next_url],
            )
            .context("Failed to record workspace PR sync state")?;
    }
    Ok(true)
}

fn pr_sync_state_from_change_request(change_request: Option<&ChangeRequestInfo>) -> PrSyncState {
    let Some(change_request) = change_request else {
        return PrSyncState::None;
    };
    if change_request.is_merged {
        return PrSyncState::Merged;
    }
    match change_request.state.as_str() {
        "OPEN" => PrSyncState::Open,
        "CLOSED" => PrSyncState::Closed,
        "MERGED" => PrSyncState::Merged,
        _ => PrSyncState::None,
    }
}

fn stabilize_pr_sync_state(current: PrSyncState, next: PrSyncState) -> PrSyncState {
    match (current, next) {
        (PrSyncState::Merged | PrSyncState::Closed, PrSyncState::Open) => current,
        _ => next,
    }
}

// ---- Linked directories (the /add-dir feature) ----
//
// Stored as a JSON array of absolute paths in `workspaces.linked_directory_paths`.
// Schema pre-dates the feature (Conductor import compatibility); we own it now.

pub fn get_workspace_linked_directories(workspace_id: &str) -> Result<Vec<String>> {
    let connection = db::read_conn()?;
    let raw: Option<String> = connection
        .query_row(
            "SELECT linked_directory_paths FROM workspaces WHERE id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .context("Failed to read linked_directory_paths")?;
    Ok(parse_linked_directory_paths(raw.as_deref()))
}

/// One entry in the `/add-dir` picker's "known workspaces" list. Mirrors
/// the sidebar row's display fields so the popup looks and reads the
/// same as Helmor's workspace list (repo icon + humanized title +
/// branch). `absolute_path` is the only non-display field — it's what
/// we persist into `linked_directory_paths` on selection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateDirectory {
    pub workspace_id: String,
    pub title: String,
    pub repo_name: String,
    pub repo_icon_src: Option<String>,
    pub repo_initials: String,
    pub branch: Option<String>,
    pub absolute_path: String,
}

/// List every ready (non-archived, non-initializing) workspace across all
/// repos as candidate directories for `/add-dir`. `exclude_workspace_id`
/// is typically the currently-active workspace — the one the user is
/// composing a prompt for — which we filter out since "link yourself to
/// yourself" is nonsense.
pub fn list_candidate_directories(
    exclude_workspace_id: Option<&str>,
) -> Result<Vec<CandidateDirectory>> {
    let records = workspace_models::load_workspace_records()?;
    let mut out = Vec::with_capacity(records.len());
    for record in records {
        if record.state != WorkspaceState::Ready {
            continue;
        }
        if exclude_workspace_id == Some(record.id.as_str()) {
            continue;
        }
        // `workspace_dir` needs the data dir to be set. A single
        // unresolvable row shouldn't hide the rest, so skip silently.
        let Ok(path) = helpers::workspace_path(&record) else {
            continue;
        };
        let title = helpers::display_title(&record);
        let repo_initials = helpers::repo_initials_for_name(&record.repo_name);
        let repo_icon_src = helpers::repo_icon_src_for_root_path(record.root_path.as_deref());
        out.push(CandidateDirectory {
            workspace_id: record.id,
            title,
            repo_name: record.repo_name,
            repo_icon_src,
            repo_initials,
            branch: record.branch,
            absolute_path: path.display().to_string(),
        });
    }
    // Sort by title then repo for a stable, human-friendly display.
    out.sort_by(|a, b| {
        a.title
            .to_lowercase()
            .cmp(&b.title.to_lowercase())
            .then_with(|| a.repo_name.to_lowercase().cmp(&b.repo_name.to_lowercase()))
    });
    Ok(out)
}

pub fn set_workspace_linked_directories(
    workspace_id: &str,
    directories: Vec<String>,
) -> Result<Vec<String>> {
    let normalized = normalize_linked_directories(directories);
    let payload = if normalized.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&normalized).context("Failed to encode linked directories")?)
    };
    let connection = db::write_conn()?;
    let updated = connection
        .execute(
            "UPDATE workspaces SET linked_directory_paths = ?2, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![workspace_id, payload],
        )
        .context("Failed to set linked_directory_paths")?;
    if updated != 1 {
        bail!("Linked-directories update affected {updated} rows for {workspace_id}");
    }
    Ok(normalized)
}

/// Parse the JSON-encoded `linked_directory_paths` column. Tolerant: any
/// corrupt / legacy value yields an empty list rather than an error, so a
/// user can always reset by saving a fresh list.
pub fn parse_linked_directory_paths(raw: Option<&str>) -> Vec<String> {
    let trimmed = raw.map(str::trim).unwrap_or("");
    if trimmed.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<String>>(trimmed)
        .map(normalize_linked_directories)
        .unwrap_or_default()
}

fn normalize_linked_directories(input: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(input.len());
    for raw in input {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = trimmed.to_string();
        if seen.insert(path.clone()) {
            out.push(path);
        }
    }
    out
}

#[cfg(test)]
mod linked_directories_tests {
    use super::{normalize_linked_directories, parse_linked_directory_paths};

    #[test]
    fn parses_valid_json_array() {
        let parsed = parse_linked_directory_paths(Some(r#"["/a","/b"]"#));
        assert_eq!(parsed, vec!["/a".to_string(), "/b".to_string()]);
    }

    #[test]
    fn empty_and_null_inputs_return_empty() {
        assert!(parse_linked_directory_paths(None).is_empty());
        assert!(parse_linked_directory_paths(Some("")).is_empty());
        assert!(parse_linked_directory_paths(Some("   ")).is_empty());
    }

    #[test]
    fn malformed_json_falls_back_to_empty() {
        assert!(parse_linked_directory_paths(Some("not json")).is_empty());
        assert!(parse_linked_directory_paths(Some("{\"a\":1}")).is_empty());
    }

    #[test]
    fn normalize_trims_and_dedupes() {
        let out = normalize_linked_directories(vec![
            "  /a  ".to_string(),
            "".to_string(),
            "/b".to_string(),
            "/a".to_string(),
        ]);
        assert_eq!(out, vec!["/a".to_string(), "/b".to_string()]);
    }
}

#[cfg(test)]
mod candidate_directories_tests {
    use super::list_candidate_directories;

    fn with_env<F: FnOnce(&rusqlite::Connection)>(f: F) {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::data_dir::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::set_var("HELMOR_DATA_DIR", dir.path());
        crate::data_dir::ensure_directory_structure().unwrap();
        let conn = rusqlite::Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        f(&conn);
        std::env::remove_var("HELMOR_DATA_DIR");
    }

    fn seed_repo(conn: &rusqlite::Connection, id: &str, name: &str) {
        conn.execute(
            "INSERT INTO repos (id, name, default_branch) VALUES (?1, ?2, 'main')",
            [id, name],
        )
        .unwrap();
    }
    fn seed_workspace(
        conn: &rusqlite::Connection,
        id: &str,
        repo_id: &str,
        dir: &str,
        branch: Option<&str>,
        state: &str,
    ) {
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state,
             status, branch) VALUES (?1, ?2, ?3, ?4, 'in-progress', ?5)",
            rusqlite::params![id, repo_id, dir, state, branch],
        )
        .unwrap();
    }

    #[test]
    fn returns_ready_workspaces_across_all_repos() {
        with_env(|conn| {
            seed_repo(conn, "r1", "alpha");
            seed_repo(conn, "r2", "bravo");
            seed_workspace(conn, "w1", "r1", "feat-a", Some("feat/a"), "ready");
            seed_workspace(conn, "w2", "r2", "main-b", Some("main"), "ready");
            let out = list_candidate_directories(None).unwrap();
            let titles: Vec<&str> = out.iter().map(|c| c.title.as_str()).collect();
            // `display_title` humanizes directory names for rows without a
            // PR / session title — "feat-a" → "Feat A", "main-b" → "Main B".
            assert!(titles.iter().any(|t| t == &"Feat A"));
            assert!(titles.iter().any(|t| t == &"Main B"));
        });
    }

    #[test]
    fn skips_non_ready_workspaces() {
        with_env(|conn| {
            seed_repo(conn, "r1", "alpha");
            seed_workspace(conn, "w1", "r1", "ready", Some("main"), "ready");
            seed_workspace(conn, "w2", "r1", "initing", Some("main"), "initializing");
            seed_workspace(conn, "w3", "r1", "done", Some("main"), "archived");
            let out = list_candidate_directories(None).unwrap();
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].workspace_id, "w1");
        });
    }

    #[test]
    fn excludes_the_currently_active_workspace() {
        with_env(|conn| {
            seed_repo(conn, "r1", "alpha");
            seed_workspace(conn, "w1", "r1", "one", Some("main"), "ready");
            seed_workspace(conn, "w2", "r1", "two", Some("main"), "ready");
            let out = list_candidate_directories(Some("w1")).unwrap();
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].workspace_id, "w2");
        });
    }

    #[test]
    fn includes_absolute_path_and_branch_metadata() {
        with_env(|conn| {
            seed_repo(conn, "r1", "alpha");
            seed_workspace(conn, "w1", "r1", "feat-x", Some("feat/x"), "ready");
            let out = list_candidate_directories(None).unwrap();
            let row = &out[0];
            assert_eq!(row.branch.as_deref(), Some("feat/x"));
            assert_eq!(row.repo_name, "alpha");
            // repo_initials are derived from the repo name at display time.
            assert!(!row.repo_initials.is_empty());
            assert!(row.absolute_path.ends_with("/alpha/feat-x"));
        });
    }
}

// ---- Select visible workspace for repo ----

pub(crate) fn select_visible_workspace_for_repo(
    repo_id: &str,
) -> Result<Option<(String, WorkspaceState)>> {
    let mut visible_records = workspace_models::load_workspace_records()?
        .into_iter()
        .filter(|record| record.repo_id == repo_id && record.state != WorkspaceState::Archived)
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
        repo_id: record.repo_id,
        repo_name: record.repo_name,
        repo_icon_src: helpers::repo_icon_src_for_root_path(record.root_path.as_deref()),
        repo_initials,
        state: record.state,
        mode: record.mode,
        has_unread: record.has_unread,
        workspace_unread: record.workspace_unread,
        unread_session_count: record.unread_session_count,
        status: record.status,
        branch: record.branch,
        active_session_id: record.active_session_id,
        active_session_title: record.active_session_title,
        active_session_agent_type: record.active_session_agent_type,
        active_session_status: record.active_session_status,
        primary_session_id: record.primary_session_id,
        primary_session_title: record.primary_session_title,
        primary_session_agent_type: record.primary_session_agent_type,
        pr_title: record.pr_title,
        pr_sync_state: record.pr_sync_state,
        pr_url: record.pr_url,
        pinned_at: record.pinned_at,
        session_count: record.session_count,
        message_count: record.message_count,
        created_at: record.created_at,
        updated_at: record.updated_at,
        last_user_message_at: record.last_user_message_at,
    }
}

pub fn record_to_summary(record: WorkspaceRecord) -> WorkspaceSummary {
    let repo_initials = helpers::repo_initials_for_name(&record.repo_name);
    // Local workspaces: replace the stored snapshot with the live HEAD
    // so the sidebar/hover-card never shows a stale branch label.
    let branch = helpers::live_branch_label(&record);

    WorkspaceSummary {
        title: helpers::display_title(&record),
        id: record.id,
        directory_name: record.directory_name,
        repo_id: record.repo_id,
        repo_name: record.repo_name,
        repo_icon_src: helpers::repo_icon_src_for_root_path(record.root_path.as_deref()),
        repo_initials,
        state: record.state,
        mode: record.mode,
        has_unread: record.has_unread,
        workspace_unread: record.workspace_unread,
        unread_session_count: record.unread_session_count,
        status: record.status,
        branch,
        active_session_id: record.active_session_id,
        active_session_title: record.active_session_title,
        active_session_agent_type: record.active_session_agent_type,
        active_session_status: record.active_session_status,
        primary_session_id: record.primary_session_id,
        primary_session_title: record.primary_session_title,
        primary_session_agent_type: record.primary_session_agent_type,
        pr_title: record.pr_title,
        pr_sync_state: record.pr_sync_state,
        pr_url: record.pr_url,
        pinned_at: record.pinned_at,
        session_count: record.session_count,
        message_count: record.message_count,
        created_at: record.created_at,
        updated_at: record.updated_at,
        last_user_message_at: record.last_user_message_at,
    }
}

pub fn record_to_detail(record: WorkspaceRecord) -> WorkspaceDetail {
    let repo_initials = helpers::repo_initials_for_name(&record.repo_name);

    // Use the workspace path as root_path so Claude Code/Codex operate in the
    // correct directory. For worktree workspaces this is the helmor data
    // dir; for local it's the source repo's root. Archived workspaces have
    // no on-disk path — return None so the frontend knows agent messaging
    // is unavailable.
    let worktree_path = helpers::workspace_path(&record).ok().and_then(|p| {
        if p.is_dir() {
            p.to_str().map(|s| s.to_string())
        } else {
            None
        }
    });
    // Local workspaces: substitute the stored branch snapshot with the
    // live HEAD so the header reflects whatever the user (or another
    // local create) just checked out.
    let branch = helpers::live_branch_label(&record);

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
        unread_session_count: record.unread_session_count,
        status: record.status,
        active_session_id: record.active_session_id,
        active_session_title: record.active_session_title,
        active_session_agent_type: record.active_session_agent_type,
        active_session_status: record.active_session_status,
        branch,
        mode: record.mode,
        initialization_parent_branch: record.initialization_parent_branch,
        intended_target_branch: record.intended_target_branch,
        pinned_at: record.pinned_at,
        pr_title: record.pr_title,
        pr_sync_state: record.pr_sync_state,
        pr_url: record.pr_url,
        archive_commit: record.archive_commit,
        session_count: record.session_count,
        message_count: record.message_count,
        forge_provider: record.forge_provider,
        forge_login: record.forge_login,
        setup_completed_at: record.setup_completed_at,
    }
}

/// Degrade operational workspaces whose directory no longer exists on disk
/// to the `archived` state — preserving all chat history (sessions +
/// session_messages) so the user can still find their conversations.
///
/// Called once at startup so that externally-deleted directories don't
/// cause repeated errors (e.g. git-status polling a missing path every
/// 10 s). The legacy behavior here was `permanently_delete_workspace`,
/// which silently destroyed `session_messages` rows — never acceptable:
/// a user may have rm -rf'd the worktree but still wants the chat history.
///
/// Archived rows are never touched (the worktree being gone is by design
/// for those; their state is already correct).
///
/// Returns the number of workspaces that were degraded.
pub fn purge_orphaned_workspaces() -> Result<usize> {
    let connection = db::read_conn()?;
    // Local workspaces' "directory" IS the user's repo root — we never
    // consider those orphaned, even if `r.root_path` is currently
    // missing (the user might be on a removable drive). Filter them out
    // server-side via `w.mode = 'worktree'`.
    let mut stmt = connection.prepare(&format!(
        "SELECT w.id, r.name, w.directory_name, w.state
         FROM workspaces w
         JOIN repos r ON r.id = w.repository_id
         WHERE w.state {} AND COALESCE(w.mode, 'worktree') = 'worktree'",
        crate::workspace_state::OPERATIONAL_FILTER
    ))?;
    let orphans: Vec<(String, String, String, WorkspaceState)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, WorkspaceState>(3)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .filter(|(_, repo_name, dir_name, _)| {
            crate::data_dir::workspace_dir(repo_name, dir_name)
                .map(|p| !p.is_dir())
                .unwrap_or(false)
        })
        .collect();
    // Release the read connection so `degrade_workspace_to_archived`
    // (which takes a write conn) doesn't deadlock on SQLite.
    drop(stmt);
    drop(connection);

    let mut count = 0;
    for (id, repo_name, dir_name, state) in &orphans {
        // Defense in depth: even if the SQL filter ever regresses, never
        // re-archive something that's already archived.
        if *state == WorkspaceState::Archived {
            tracing::warn!(
                workspace_id = %id,
                "Skipping archived workspace in orphan reconcile"
            );
            continue;
        }
        match degrade_workspace_to_archived(id) {
            Ok(true) => {
                count += 1;
                tracing::info!(
                    workspace_id = %id,
                    path = %format!("{}/{}", repo_name, dir_name),
                    "Degraded orphaned workspace to archived (directory missing; chat history preserved)"
                );
            }
            Ok(false) => {
                // Another thread got there first (already archived).
            }
            Err(e) => {
                tracing::warn!(
                    workspace_id = %id,
                    "Failed to degrade orphaned workspace: {e:#}"
                );
            }
        }
    }
    Ok(count)
}

/// Flip a single workspace row from its current operational state to
/// `archived`, without touching sessions / session_messages. Used by
/// [`purge_orphaned_workspaces`] to reconcile workspaces whose worktree
/// vanished externally. Idempotent: returns `Ok(false)` if the row is
/// not operational or doesn't exist.
pub fn degrade_workspace_to_archived(workspace_id: &str) -> Result<bool> {
    let connection = db::write_conn()?;
    let rows = connection
        .execute(
            &format!(
                "UPDATE workspaces
             SET state = 'archived',
                 updated_at = datetime('now')
             WHERE id = ?1 AND state {}",
                crate::workspace_state::OPERATIONAL_FILTER
            ),
            [workspace_id],
        )
        .context("Failed to degrade workspace to archived")?;
    Ok(rows > 0)
}

/// Permanently delete a workspace and all its data (sessions, messages)
/// from the database, plus any filesystem artifacts (worktree directory).
pub fn permanently_delete_workspace(workspace_id: &str) -> Result<()> {
    let mut connection = db::write_conn()?;

    // Load workspace info for filesystem cleanup. Skips the dir delete
    // step for local-mode rows (whose "dir" is the user's repo root).
    let record: Option<(
        String,
        String,
        WorkspaceState,
        crate::workspace_state::WorkspaceMode,
    )> = connection
        .query_row(
            "SELECT r.name, w.directory_name, w.state, COALESCE(w.mode, 'worktree')
                 FROM workspaces w JOIN repos r ON r.id = w.repository_id WHERE w.id = ?1",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok();

    // Delete all DB records in a transaction
    let transaction = connection
        .transaction()
        .context("Failed to start delete workspace transaction")?;

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

    // Filesystem cleanup (best-effort). Local workspaces never own
    // their directory — that's the user's repo, never delete it.
    if let Some((repo_name, directory_name, _state, mode)) = record {
        if mode == crate::workspace_state::WorkspaceMode::Worktree {
            if let Ok(ws_dir) = crate::data_dir::workspace_dir(&repo_name, &directory_name) {
                if ws_dir.is_dir() {
                    std::fs::remove_dir_all(&ws_dir).ok();
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{insert_repo, insert_workspace, TestEnv, WorkspaceFixture};
    use std::fs;

    fn count_workspaces(env: &TestEnv) -> usize {
        env.db_connection()
            .query_row("SELECT COUNT(*) FROM workspaces", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap() as usize
    }

    fn workspace_state(env: &TestEnv, id: &str) -> Option<String> {
        env.db_connection()
            .query_row("SELECT state FROM workspaces WHERE id = ?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .ok()
    }

    fn count_session_messages(env: &TestEnv, workspace_id: &str) -> i64 {
        env.db_connection()
            .query_row(
                "SELECT COUNT(*) FROM session_messages sm
                 JOIN sessions s ON s.id = sm.session_id
                 WHERE s.workspace_id = ?1",
                [workspace_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
    }

    #[test]
    fn purge_skips_archived_even_when_worktree_missing() {
        let env = TestEnv::new("purge-archived");
        let conn = env.db_connection();
        insert_repo(&conn, "r1", "demo", None);
        insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "w-archived",
                repo_id: "r1",
                directory_name: "alpha",
                state: WorkspaceState::Archived.as_str(),
                branch: Some("feature/alpha"),
                intended_target_branch: None,
            },
        );

        let purged = purge_orphaned_workspaces().unwrap();

        assert_eq!(purged, 0, "archived workspace must not be re-archived");
        assert_eq!(count_workspaces(&env), 1, "DB row must remain");
        assert_eq!(
            workspace_state(&env, "w-archived").as_deref(),
            Some("archived")
        );
    }

    #[test]
    fn purge_degrades_ready_workspace_with_missing_dir_to_archived() {
        let env = TestEnv::new("purge-ready");
        let conn = env.db_connection();
        insert_repo(&conn, "r1", "demo", None);
        insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "w-ready",
                repo_id: "r1",
                directory_name: "beta",
                state: WorkspaceState::Ready.as_str(),
                branch: Some("feature/beta"),
                intended_target_branch: None,
            },
        );
        // Simulate a session with chat history so we can verify it survives.
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title) VALUES ('s1', 'w-ready', 'idle', 'Test')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_messages (id, session_id, sent_at, content) VALUES ('m1', 's1', datetime('now'), '{}')",
            [],
        )
        .unwrap();
        assert_eq!(count_session_messages(&env, "w-ready"), 1);
        // No worktree dir created — simulates external deletion.

        let degraded = purge_orphaned_workspaces().unwrap();

        assert_eq!(
            degraded, 1,
            "ready workspace with missing dir must be degraded"
        );
        assert_eq!(
            count_workspaces(&env),
            1,
            "DB row must be preserved, not deleted"
        );
        assert_eq!(
            workspace_state(&env, "w-ready").as_deref(),
            Some("archived"),
            "state must flip to archived"
        );
        assert_eq!(
            count_session_messages(&env, "w-ready"),
            1,
            "chat history must survive the degrade",
        );
    }

    #[test]
    fn purge_does_not_degrade_initializing_workspace_with_missing_dir() {
        let env = TestEnv::new("purge-initializing");
        let conn = env.db_connection();
        insert_repo(&conn, "r1", "demo", None);
        insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "w-initializing",
                repo_id: "r1",
                directory_name: "delta",
                state: WorkspaceState::Initializing.as_str(),
                branch: Some("feature/delta"),
                intended_target_branch: None,
            },
        );

        let degraded = purge_orphaned_workspaces().unwrap();

        assert_eq!(degraded, 0);
        assert_eq!(
            workspace_state(&env, "w-initializing").as_deref(),
            Some("initializing"),
        );
    }

    #[test]
    fn purge_keeps_workspace_when_dir_exists() {
        let env = TestEnv::new("purge-present");
        let conn = env.db_connection();
        insert_repo(&conn, "r1", "demo", None);
        insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "w-live",
                repo_id: "r1",
                directory_name: "gamma",
                state: WorkspaceState::Ready.as_str(),
                branch: Some("feature/gamma"),
                intended_target_branch: None,
            },
        );
        let ws_dir = crate::data_dir::workspace_dir("demo", "gamma").unwrap();
        fs::create_dir_all(&ws_dir).unwrap();

        let purged = purge_orphaned_workspaces().unwrap();

        assert_eq!(purged, 0);
        assert_eq!(count_workspaces(&env), 1);
        assert_eq!(workspace_state(&env, "w-live").as_deref(), Some("ready"));
    }

    #[test]
    fn pr_sync_moves_only_on_lifecycle_transitions() {
        let env = TestEnv::new("pr-sync-transitions");
        let conn = env.db_connection();
        insert_repo(&conn, "r1", "demo", None);
        insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "w-pr",
                repo_id: "r1",
                directory_name: "alpha",
                state: WorkspaceState::Ready.as_str(),
                branch: Some("feature/alpha"),
                intended_target_branch: None,
            },
        );

        let open = ChangeRequestInfo {
            url: "https://example.test/pr/1".to_string(),
            number: 1,
            state: "OPEN".to_string(),
            title: "PR".to_string(),
            is_merged: false,
        };
        assert!(sync_workspace_pr_state("w-pr", Some(&open)).unwrap());
        assert_eq!(
            workspace_statuses(&env, "w-pr"),
            ("review".to_string(), "open".to_string())
        );

        conn.execute(
            "UPDATE workspaces SET status = 'in-progress' WHERE id = 'w-pr'",
            [],
        )
        .unwrap();
        assert!(!sync_workspace_pr_state("w-pr", Some(&open)).unwrap());
        assert_eq!(
            workspace_statuses(&env, "w-pr"),
            ("in-progress".to_string(), "open".to_string())
        );

        let merged = ChangeRequestInfo {
            state: "MERGED".to_string(),
            is_merged: true,
            ..open
        };
        assert!(sync_workspace_pr_state("w-pr", Some(&merged)).unwrap());
        assert_eq!(
            workspace_statuses(&env, "w-pr"),
            ("done".to_string(), "merged".to_string())
        );
    }

    #[test]
    fn pr_sync_does_not_regress_terminal_state_to_open() {
        let env = TestEnv::new("pr-sync-terminal-no-regress");
        let conn = env.db_connection();
        insert_repo(&conn, "r1", "demo", None);
        insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "w-pr",
                repo_id: "r1",
                directory_name: "alpha",
                state: WorkspaceState::Ready.as_str(),
                branch: Some("feature/alpha"),
                intended_target_branch: None,
            },
        );
        // Pre-seed title/url so the stale_open call won't dirty them either —
        // that lets the assertion below specifically test the *state freeze*.
        conn.execute(
            "UPDATE workspaces SET status = 'done', pr_sync_state = 'merged', pr_title = 'PR', pr_url = 'https://example.test/pr/1' WHERE id = 'w-pr'",
            [],
        )
        .unwrap();

        let stale_open = ChangeRequestInfo {
            url: "https://example.test/pr/1".to_string(),
            number: 1,
            state: "OPEN".to_string(),
            title: "PR".to_string(),
            is_merged: false,
        };

        assert!(!sync_workspace_pr_state("w-pr", Some(&stale_open)).unwrap());
        assert_eq!(
            workspace_statuses(&env, "w-pr"),
            ("done".to_string(), "merged".to_string())
        );
    }

    #[test]
    fn pr_sync_reports_change_when_request_disappears() {
        let env = TestEnv::new("pr-sync-none-return");
        let conn = env.db_connection();
        insert_repo(&conn, "r1", "demo", None);
        insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "w-pr",
                repo_id: "r1",
                directory_name: "alpha",
                state: WorkspaceState::Ready.as_str(),
                branch: Some("feature/alpha"),
                intended_target_branch: None,
            },
        );
        conn.execute(
            "UPDATE workspaces SET status = 'done', pr_sync_state = 'merged' WHERE id = 'w-pr'",
            [],
        )
        .unwrap();

        assert!(sync_workspace_pr_state("w-pr", None).unwrap());
        assert_eq!(
            workspace_statuses(&env, "w-pr"),
            ("done".to_string(), "none".to_string())
        );
    }

    #[test]
    fn pr_sync_persists_title_and_url() {
        let env = TestEnv::new("pr-sync-persists-title-url");
        let conn = env.db_connection();
        insert_repo(&conn, "r1", "demo", None);
        insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "w-pr",
                repo_id: "r1",
                directory_name: "alpha",
                state: WorkspaceState::Ready.as_str(),
                branch: Some("feature/alpha"),
                intended_target_branch: None,
            },
        );

        let open = ChangeRequestInfo {
            url: "https://github.com/acme/widgets/pull/42".to_string(),
            number: 42,
            state: "OPEN".to_string(),
            title: "Add cool feature".to_string(),
            is_merged: false,
        };
        assert!(sync_workspace_pr_state("w-pr", Some(&open)).unwrap());
        assert_eq!(
            workspace_pr_metadata(&env, "w-pr"),
            (
                Some("Add cool feature".to_string()),
                Some("https://github.com/acme/widgets/pull/42".to_string()),
            )
        );

        // Same state, but the title or url moved on the remote — should write
        // the new metadata and report a change so the UI invalidates.
        let renamed = ChangeRequestInfo {
            title: "Renamed PR".to_string(),
            ..open
        };
        assert!(sync_workspace_pr_state("w-pr", Some(&renamed)).unwrap());
        assert_eq!(
            workspace_pr_metadata(&env, "w-pr").0,
            Some("Renamed PR".to_string())
        );

        // Calling again with identical data is a no-op.
        assert!(!sync_workspace_pr_state("w-pr", Some(&renamed)).unwrap());
    }

    #[test]
    fn pr_sync_clears_title_and_url_when_request_disappears() {
        let env = TestEnv::new("pr-sync-clears-title-url");
        let conn = env.db_connection();
        insert_repo(&conn, "r1", "demo", None);
        insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "w-pr",
                repo_id: "r1",
                directory_name: "alpha",
                state: WorkspaceState::Ready.as_str(),
                branch: Some("feature/alpha"),
                intended_target_branch: None,
            },
        );
        conn.execute(
            "UPDATE workspaces SET pr_sync_state = 'open', pr_title = 'old', pr_url = 'https://example.test/pr/1' WHERE id = 'w-pr'",
            [],
        )
        .unwrap();

        assert!(sync_workspace_pr_state("w-pr", None).unwrap());
        assert_eq!(workspace_pr_metadata(&env, "w-pr"), (None, None));
    }

    fn workspace_statuses(env: &TestEnv, id: &str) -> (String, String) {
        env.db_connection()
            .query_row(
                "SELECT status, pr_sync_state FROM workspaces WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    fn workspace_pr_metadata(env: &TestEnv, id: &str) -> (Option<String>, Option<String>) {
        env.db_connection()
            .query_row(
                "SELECT pr_title, pr_url FROM workspaces WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }
}
