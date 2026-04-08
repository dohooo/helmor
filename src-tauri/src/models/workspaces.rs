use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;

use super::{db, git_ops, helpers, repos, sessions, settings};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreWorkspaceResponse {
    pub restored_workspace_id: String,
    pub restored_state: String,
    pub selected_workspace_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveWorkspaceResponse {
    pub archived_workspace_id: String,
    pub archived_state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceResponse {
    pub created_workspace_id: String,
    pub selected_workspace_id: String,
    pub created_state: String,
    pub directory_name: String,
    pub branch: String,
}

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
      COALESCE(att.attachment_count, 0) AS attachment_count
    FROM workspaces w
    JOIN repos r ON r.id = w.repository_id
    LEFT JOIN sessions s ON s.id = w.active_session_id
    LEFT JOIN session_stats ss ON ss.workspace_id = w.id
    LEFT JOIN message_stats ms ON ms.workspace_id = w.id
    LEFT JOIN attachment_stats att ON att.workspace_id = w.id
"#;

// ---- Loading workspace records ----

pub fn load_workspace_records() -> Result<Vec<WorkspaceRecord>> {
    let connection = db::open_connection(false)?;
    // Sort by `updated_at DESC`. This column doubles as a "most recent
    // user-driven workspace action" timestamp because of how it's maintained:
    //
    //   - Bumped by:  create / archive / restore / pin / unpin /
    //                 set_workspace_manual_status / setup metadata writes.
    //   - NOT bumped: mark_read / mark_unread, update_intended_target_branch,
    //                 branch rename, session UPDATE, session_messages INSERT
    //                 (we have no auto-update triggers on workspaces, so
    //                 background activity is invisible to it).
    //
    // The net effect is: the sidebar order is stable for a workspace until
    // the user takes a structural action on it, at which point the workspace
    // floats to the top of its group. Concretely this means an unarchived
    // workspace appears at the top of its destination group — matching the
    // optimistic-placement we do on the frontend, so there's no jump after
    // canonical invalidation.
    let sql = format!("{WORKSPACE_RECORD_SQL} ORDER BY w.updated_at DESC");
    let mut statement = connection.prepare(&sql)?;

    let rows = statement.query_map([], helpers::workspace_record_from_row)?;

    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn load_workspace_record_by_id(workspace_id: &str) -> Result<Option<WorkspaceRecord>> {
    let connection = db::open_connection(false)?;
    let mut statement =
        connection.prepare(format!("{WORKSPACE_RECORD_SQL} WHERE w.id = ?1").as_str())?;

    let mut rows = statement.query_map([workspace_id], helpers::workspace_record_from_row)?;

    match rows.next() {
        Some(result) => Ok(result.map(Some)?),
        None => Ok(None),
    }
}

// ---- Sidebar groups ----

pub fn list_workspace_groups() -> Result<Vec<WorkspaceSidebarGroup>> {
    let mut pinned = Vec::new();
    let mut done = Vec::new();
    let mut review = Vec::new();
    let mut progress = Vec::new();
    let mut backlog = Vec::new();
    let mut canceled = Vec::new();

    // `load_workspace_records` already returns rows in `created_at DESC` order
    // (newest first). Iterating in that order and bucketing into status groups
    // means each group naturally inherits the same stable order, no per-group
    // re-sort needed.
    for record in load_workspace_records()? {
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

    let archived = statement
        .query_map([], helpers::workspace_record_from_row)?
        .filter_map(|row| row.ok())
        .map(record_to_summary)
        .collect::<Vec<_>>();

    Ok(archived)
}

pub fn get_workspace(workspace_id: &str) -> Result<WorkspaceDetail> {
    let record = load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    Ok(record_to_detail(record))
}

// ---- Remote branches ----

pub fn list_remote_branches(workspace_id: &str) -> Result<Vec<String>> {
    let record = load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    let repo_root = helpers::non_empty(&record.root_path)
        .map(PathBuf::from)
        .with_context(|| format!("Workspace {workspace_id} is missing repo root_path"))?;

    git_ops::ensure_git_repository(&repo_root)?;
    // Read cached remote branches (no network). A background fetch
    // runs on workspace creation; users can also trigger a manual refresh.
    git_ops::list_remote_branches(&repo_root)
}

// ---- Update intended target branch ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateIntendedTargetBranchResponse {
    /// `true` if the workspace's local branch was hard-reset to `origin/<target>`.
    /// `false` if only the stored intent was updated (worktree dirty, branch
    /// already has user commits, baseline missing, etc.).
    pub reset: bool,
    pub target_branch: String,
}

/// Internal result of the synchronous (local-only) phase of a branch switch.
/// Carries the post-reset HEAD SHA so the caller can chain a background
/// remote-refresh against it.
#[derive(Debug)]
pub struct UpdateIntendedTargetBranchInternal {
    pub reset: bool,
    pub target_branch: String,
    /// `Some(sha)` only when a local reset actually happened.
    pub post_reset_sha: Option<String>,
}

/// Tauri-facing entry point. Performs the fast local realignment synchronously,
/// then schedules a background fetch from `origin` to silently re-align to the
/// freshest tip if it is still safe.
///
/// The background fetch is dispatched via `tauri::async_runtime::spawn_blocking`
/// rather than `std::thread::spawn` so it runs on Tokio's bounded blocking
/// pool. Combined with the `GIT_NETWORK_TIMEOUT` cap inside `fetch_remote_branch`,
/// this guarantees that even pathological hangs only ever consume
/// `pool_size × timeout` threads before draining — no unbounded OS-thread leak.
pub fn update_intended_target_branch(
    workspace_id: &str,
    target_branch: &str,
) -> Result<UpdateIntendedTargetBranchResponse> {
    let internal = update_intended_target_branch_local(workspace_id, target_branch)?;

    if let Some(post_reset_sha) = internal.post_reset_sha.clone() {
        let workspace_id_owned = workspace_id.to_string();
        let target_branch_owned = internal.target_branch.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = refresh_remote_and_realign(
                &workspace_id_owned,
                &target_branch_owned,
                &post_reset_sha,
            );
        });
    }

    Ok(UpdateIntendedTargetBranchResponse {
        reset: internal.reset,
        target_branch: internal.target_branch,
    })
}

/// Synchronous local-only phase of a branch switch. Always updates the DB
/// `intended_target_branch`, then attempts a fast local reset to the cached
/// `origin/<target>` if all safety checks pass. Never hits the network.
///
/// Exposed (without spawning the background thread) so tests can drive the
/// local phase deterministically.
pub fn update_intended_target_branch_local(
    workspace_id: &str,
    target_branch: &str,
) -> Result<UpdateIntendedTargetBranchInternal> {
    // Step 1 — always persist the user's intent. The dropdown is, semantically,
    // "the branch this workspace eventually wants to merge into", so the
    // selection itself should never be blocked by local state.
    {
        let connection = db::open_connection(true)?;
        let updated_rows = connection
            .execute(
                "UPDATE workspaces SET intended_target_branch = ?2 WHERE id = ?1 AND state = 'ready'",
                (workspace_id, target_branch),
            )
            .context("Failed to update intended target branch")?;

        if updated_rows != 1 {
            bail!(
                "Cannot update target branch: workspace {workspace_id} not found or not in ready state"
            );
        }
    }

    // Step 2 — re-read the record and try to realign the local branch to the
    // new target if it is safe to do so.
    let record = load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found after intent update: {workspace_id}"))?;

    let post_reset_sha = try_realign_local_branch(&record, target_branch)?;

    if post_reset_sha.is_some() {
        // Update the baseline so future "fresh branch" checks compare against
        // the new starting point rather than the original parent.
        let connection = db::open_connection(true)?;
        connection
            .execute(
                "UPDATE workspaces SET initialization_parent_branch = ?2 WHERE id = ?1",
                (workspace_id, target_branch),
            )
            .context("Failed to update initialization parent branch after reset")?;
    }

    Ok(UpdateIntendedTargetBranchInternal {
        reset: post_reset_sha.is_some(),
        target_branch: target_branch.to_string(),
        post_reset_sha,
    })
}

/// Try to hard-reset the workspace's currently checked-out branch onto the
/// locally cached `refs/remotes/origin/<target_branch>`. Never fetches.
///
/// Returns:
/// - `Ok(Some(post_reset_sha))` — reset was performed; carries the new HEAD SHA.
/// - `Ok(None)` — workspace is not in a state where realignment is safe;
///   silent fallback (not an error).
/// - `Err(_)` — the reset was attempted but the underlying git command failed;
///   surfaced to the caller so the user is informed.
fn try_realign_local_branch(
    record: &WorkspaceRecord,
    target_branch: &str,
) -> Result<Option<String>> {
    if record.state != "ready" {
        return Ok(None);
    }
    if helpers::non_empty(&record.root_path).is_none() {
        return Ok(None);
    }
    if helpers::non_empty(&record.branch).is_none() {
        return Ok(None);
    }
    let Some(init_parent) = helpers::non_empty(&record.initialization_parent_branch) else {
        // No baseline recorded → cannot tell whether the branch is "fresh".
        return Ok(None);
    };

    let workspace_dir = crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
    if !workspace_dir.is_dir() {
        return Ok(None);
    }

    // Precheck: the cached `origin/<target>` ref must already exist locally.
    // Since the dropdown only lists branches present under `refs/remotes/origin/`,
    // this should normally pass — but a manual prune could remove it between
    // dropdown open and click, in which case we silently fall back.
    if !matches!(
        git_ops::verify_remote_ref_exists(&workspace_dir, target_branch),
        Ok(true)
    ) {
        return Ok(None);
    }

    // Safety check 1: working tree must be completely clean (no staged,
    // unstaged, or untracked files).
    if !matches!(git_ops::working_tree_clean(&workspace_dir), Ok(true)) {
        return Ok(None);
    }

    // Safety check 2: HEAD must have zero commits beyond origin/<init_parent>.
    // If origin/<init_parent> no longer exists or rev-list otherwise errors,
    // we treat that as "cannot determine" and skip the realignment.
    let baseline_ref = format!("origin/{init_parent}");
    if !matches!(
        git_ops::commits_ahead_of(&workspace_dir, &baseline_ref),
        Ok(0)
    ) {
        return Ok(None);
    }

    // All preconditions satisfied — perform the realignment. Pure local op,
    // no fetch. From here on, any git error propagates back so the user sees
    // a failure toast and knows the worktree may have been touched.
    let target_ref = format!("origin/{target_branch}");
    git_ops::reset_current_branch_hard(&workspace_dir, &target_ref)?;

    let post_reset_sha = git_ops::current_workspace_head_commit(&workspace_dir)?;
    Ok(Some(post_reset_sha))
}

/// Background phase of a branch switch. Fetches `origin/<target_branch>`,
/// then performs a silent re-reset to the freshest tip — but only when ALL
/// of these invariants still hold:
///
/// 1. Workspace state is still `ready`
/// 2. Working tree is still completely clean
/// 3. HEAD is still exactly `post_reset_sha` (the user hasn't moved the branch
///    or switched workspaces in the meantime)
/// 4. The freshly fetched `origin/<target>` actually advanced past `post_reset_sha`
///
/// If any check fails, the function exits silently (`Ok(false)`), guaranteeing
/// the user's in-progress work is never overwritten by a background race.
///
/// Public so tests can drive it deterministically without spawning a thread.
pub fn refresh_remote_and_realign(
    workspace_id: &str,
    target_branch: &str,
    post_reset_sha: &str,
) -> Result<bool> {
    // Load the record (without holding the mutation lock) to find the workspace
    // dir. The fetch is slow, so we don't want to hold the lock across it.
    let Some(record) = load_workspace_record_by_id(workspace_id)? else {
        return Ok(false);
    };
    if record.state != "ready" {
        return Ok(false);
    }
    let workspace_dir = crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
    if !workspace_dir.is_dir() {
        return Ok(false);
    }

    // Slow part: fetch from origin. Failures (network, SSH, etc.) → silent.
    if git_ops::fetch_remote_branch(&workspace_dir, target_branch).is_err() {
        return Ok(false);
    }

    let ws_lock = db::workspace_mutation_lock(workspace_id);
    let _lock = ws_lock.blocking_lock();

    // Re-load record under the lock; abort if state changed.
    let Some(fresh_record) = load_workspace_record_by_id(workspace_id)? else {
        return Ok(false);
    };
    if fresh_record.state != "ready" {
        return Ok(false);
    }

    // Invariant: working tree still clean.
    if !matches!(git_ops::working_tree_clean(&workspace_dir), Ok(true)) {
        return Ok(false);
    }

    // Invariant: HEAD still pinned at post_reset_sha (user hasn't committed
    // or done another reset).
    let current_head = match git_ops::current_workspace_head_commit(&workspace_dir) {
        Ok(sha) => sha,
        Err(_) => return Ok(false),
    };
    if current_head != post_reset_sha {
        return Ok(false);
    }

    // Invariant: the fresh remote actually advanced past post_reset_sha.
    let new_remote_sha = match git_ops::remote_ref_sha(&workspace_dir, target_branch) {
        Ok(sha) => sha,
        Err(_) => return Ok(false),
    };
    if new_remote_sha == post_reset_sha {
        return Ok(false);
    }

    // All four invariants hold — silently re-align to the freshest tip.
    let target_ref = format!("origin/{target_branch}");
    git_ops::reset_current_branch_hard(&workspace_dir, &target_ref)?;
    Ok(true)
}

// ---- Prefetch remote refs (background freshness for the branch picker) ----

/// How long to wait between successive `git fetch --prune origin` calls for
/// the same workspace. Prevents storms when the user opens/closes the dropdown
/// rapidly.
const PREFETCH_RATE_LIMIT: Duration = Duration::from_secs(10);

fn prefetch_rate_limit_map() -> &'static Mutex<HashMap<String, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchWorkspaceRemoteRefsResponse {
    /// `true` if a fetch was actually performed, `false` if it was rate-limited
    /// (a recent fetch is still considered fresh).
    pub fetched: bool,
}

/// Fetch every branch from `origin` for this workspace's repo, pruning stale
/// remote refs. Rate-limited per workspace so callers can fire it freely
/// (e.g. on dropdown open) without thrashing the network.
pub fn prefetch_workspace_remote_refs(
    workspace_id: &str,
) -> Result<PrefetchWorkspaceRemoteRefsResponse> {
    // Rate-limit check.
    {
        let mut map = prefetch_rate_limit_map()
            .lock()
            .map_err(|_| anyhow::anyhow!("Prefetch rate-limit lock poisoned"))?;
        let now = Instant::now();
        if let Some(last) = map.get(workspace_id) {
            if now.duration_since(*last) < PREFETCH_RATE_LIMIT {
                return Ok(PrefetchWorkspaceRemoteRefsResponse { fetched: false });
            }
        }
        map.insert(workspace_id.to_string(), now);
    }

    let record = load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;
    if record.state != "ready" {
        return Ok(PrefetchWorkspaceRemoteRefsResponse { fetched: false });
    }
    let workspace_dir = crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
    if !workspace_dir.is_dir() {
        return Ok(PrefetchWorkspaceRemoteRefsResponse { fetched: false });
    }

    git_ops::fetch_all_remote(&workspace_dir)?;
    Ok(PrefetchWorkspaceRemoteRefsResponse { fetched: true })
}

/// Test-only escape hatch — clears the rate-limit map so successive calls in
/// the same test run don't get suppressed.
#[doc(hidden)]
pub fn _reset_prefetch_rate_limit() {
    if let Ok(mut map) = prefetch_rate_limit_map().lock() {
        map.clear();
    }
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
    let mut visible_records = load_workspace_records()?
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

// ---- Create workspace from repo ----

pub fn create_workspace_from_repo_impl(repo_id: &str) -> Result<CreateWorkspaceResponse> {
    let repository = repos::load_repository_by_id(repo_id)?
        .with_context(|| format!("Repository not found: {repo_id}"))?;
    let repo_root = PathBuf::from(repository.root_path.trim());
    git_ops::ensure_git_repository(&repo_root)?;

    let directory_name = helpers::allocate_directory_name_for_repo(repo_id)?;
    let branch_settings = settings::load_branch_prefix_settings()?;
    let branch = helpers::branch_name_for_directory(&directory_name, &branch_settings);
    let default_branch = repository
        .default_branch
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "main".to_string());
    let workspace_id = uuid::Uuid::new_v4().to_string();
    let session_id = uuid::Uuid::new_v4().to_string();
    let workspace_dir = crate::data_dir::workspace_dir(&repository.name, &directory_name)?;
    let setup_root_dir = crate::data_dir::data_dir()?
        .join("repo-roots")
        .join(&repository.name);
    let logs_dir = crate::data_dir::workspace_logs_dir(&workspace_id)?;
    let initialization_log_path = logs_dir.join("initialization.log");
    let setup_log_path = logs_dir.join("setup.log");
    let timestamp = db::current_timestamp()?;
    let mut created_worktree = false;
    let mut created_setup_root = false;

    fs::create_dir_all(&logs_dir).with_context(|| {
        format!(
            "Failed to create workspace log directory {}",
            logs_dir.display()
        )
    })?;

    insert_initializing_workspace_and_session(
        &repository,
        &workspace_id,
        &session_id,
        &directory_name,
        &branch,
        &default_branch,
        &timestamp,
        &initialization_log_path,
        &setup_log_path,
    )?;

    let create_result = (|| -> Result<CreateWorkspaceResponse> {
        if workspace_dir.exists() {
            let error = format!(
                "Workspace target already exists at {}",
                workspace_dir.display()
            );
            let _ = write_log_file(&initialization_log_path, &error);
            bail!("{error}");
        }

        git_ops::ensure_git_repository(&repo_root)?;
        let start_ref = git_ops::default_branch_ref(&default_branch);
        git_ops::verify_commitish_exists(
            &repo_root,
            &start_ref,
            &format!("Default branch is missing in source repo: {default_branch}"),
        )?;
        let init_log = match git_ops::create_worktree_from_start_point(
            &repo_root,
            &workspace_dir,
            &branch,
            &start_ref,
        ) {
            Ok(output) => {
                created_worktree = true;
                output
            }
            Err(error) => {
                let _ = write_log_file(&initialization_log_path, &format!("{error:#}"));
                return Err(error);
            }
        };
        write_log_file(
            &initialization_log_path,
            &format!(
                "Repository: {}\nWorkspace: {}\nBranch: {}\nStart point: {}\n\n{}",
                repository.name,
                workspace_dir.display(),
                branch,
                start_ref,
                init_log
            ),
        )?;

        helpers::create_workspace_context_scaffold(&workspace_dir)?;
        let initialization_files_copied = git_ops::tracked_file_count(&workspace_dir)?;

        update_workspace_initialization_metadata(
            &workspace_id,
            initialization_files_copied,
            &timestamp,
        )?;
        update_workspace_state(&workspace_id, "setting_up", &timestamp)?;

        git_ops::refresh_repo_setup_root(&repo_root, &setup_root_dir, &start_ref)?;
        created_setup_root = true;

        let setup_hook = match resolve_setup_hook(&repository, &workspace_dir, &setup_root_dir) {
            Ok(value) => value,
            Err(error) => {
                let _ = write_log_file(&setup_log_path, &format!("{error:#}"));
                return Err(error);
            }
        };
        run_setup_hook(
            setup_hook.as_deref(),
            &workspace_dir,
            &setup_root_dir,
            &setup_log_path,
        )?;
        update_workspace_state(&workspace_id, "ready", &timestamp)?;

        Ok(CreateWorkspaceResponse {
            created_workspace_id: workspace_id.clone(),
            selected_workspace_id: workspace_id.clone(),
            created_state: "ready".to_string(),
            directory_name,
            branch: branch.clone(),
        })
    })();

    let result = match create_result {
        Ok(response) => Ok(response),
        Err(error) => {
            cleanup_failed_created_workspace(
                &workspace_id,
                &session_id,
                &repo_root,
                &workspace_dir,
                &branch,
                created_worktree,
            );
            Err(error)
        }
    };

    if created_setup_root {
        let _ = git_ops::remove_worktree(&repo_root, &setup_root_dir);
        let _ = fs::remove_dir_all(&setup_root_dir);
    }

    result
}

// ---- Archive workspace ----

/// Snapshot of the read-only checks shared between `validate_archive_workspace`
/// and `archive_workspace_impl`. Carries the data the apply phase needs.
struct ArchivePreflightData {
    repo_root: PathBuf,
    branch: String,
    workspace_dir: PathBuf,
    archived_context_dir: PathBuf,
    archive_commit: String,
}

/// Read-only validation for archive: every check that can fail without
/// touching the filesystem destructively. Side-effect-free; safe to call from
/// the frontend before optimistically updating the UI.
fn archive_workspace_preflight(workspace_id: &str) -> Result<ArchivePreflightData> {
    let record = load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    if record.state != "ready" {
        bail!("Workspace is not ready: {workspace_id}");
    }

    let repo_root = helpers::non_empty(&record.root_path)
        .map(PathBuf::from)
        .with_context(|| format!("Workspace {workspace_id} is missing repo root_path"))?;
    let branch = helpers::non_empty(&record.branch)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Workspace {workspace_id} is missing branch"))?;

    let workspace_dir = crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
    if !workspace_dir.is_dir() {
        bail!(
            "Archive source workspace is missing at {}",
            workspace_dir.display()
        );
    }

    let archived_context_dir =
        crate::data_dir::archived_context_dir(&record.repo_name, &record.directory_name)?;
    if archived_context_dir.exists() {
        bail!(
            "Archived context target already exists at {}",
            archived_context_dir.display()
        );
    }

    let archive_commit = git_ops::current_workspace_head_commit(&workspace_dir)?;
    git_ops::verify_commit_exists(&repo_root, &archive_commit)?;

    Ok(ArchivePreflightData {
        repo_root,
        branch,
        workspace_dir,
        archived_context_dir,
        archive_commit,
    })
}

/// Tauri-callable read-only check. Returns `Ok(())` if archive will succeed
/// (filesystem state, git state, db state all valid right now). Use from the
/// frontend before applying an optimistic UI update.
pub fn validate_archive_workspace(workspace_id: &str) -> Result<()> {
    archive_workspace_preflight(workspace_id).map(|_| ())
}

pub fn archive_workspace_impl(workspace_id: &str) -> Result<ArchiveWorkspaceResponse> {
    let ArchivePreflightData {
        repo_root,
        branch,
        workspace_dir,
        archived_context_dir,
        archive_commit,
    } = archive_workspace_preflight(workspace_id)?;

    fs::create_dir_all(archived_context_dir.parent().with_context(|| {
        format!(
            "Archived context target has no parent: {}",
            archived_context_dir.display()
        )
    })?)
    .with_context(|| {
        format!(
            "Failed to create archived context parent directory for {}",
            archived_context_dir.display()
        )
    })?;

    let workspace_context_dir = workspace_dir.join(".context");
    let staged_archive_dir = helpers::staged_archive_context_dir(&archived_context_dir);
    create_staged_archive_context(&workspace_context_dir, &staged_archive_dir)?;

    if let Err(error) = git_ops::remove_worktree(&repo_root, &workspace_dir) {
        let _ = fs::remove_dir_all(&staged_archive_dir);
        return Err(error);
    }

    // Delete the branch after removing the worktree
    git_ops::run_git(
        [
            "-C",
            &repo_root.display().to_string(),
            "branch",
            "-D",
            &branch,
        ],
        None,
    )
    .ok(); // Best-effort — branch may already be gone

    if let Err(error) = fs::rename(&staged_archive_dir, &archived_context_dir) {
        cleanup_failed_archive(
            &repo_root,
            &workspace_dir,
            &workspace_context_dir,
            &branch,
            &archive_commit,
            &staged_archive_dir,
            &archived_context_dir,
        );
        bail!(
            "Failed to move archived context into {}: {error}",
            archived_context_dir.display()
        );
    }

    if let Err(error) = update_archived_workspace_state(workspace_id, &archive_commit) {
        cleanup_failed_archive(
            &repo_root,
            &workspace_dir,
            &workspace_context_dir,
            &branch,
            &archive_commit,
            &staged_archive_dir,
            &archived_context_dir,
        );
        return Err(error);
    }

    Ok(ArchiveWorkspaceResponse {
        archived_workspace_id: workspace_id.to_string(),
        archived_state: "archived".to_string(),
    })
}

// ---- Restore workspace ----

/// Snapshot of the read-only checks shared between `validate_restore_workspace`
/// and `restore_workspace_impl`. Carries the data the apply phase needs so we
/// don't reload/rederive it.
struct RestorePreflightData {
    record: WorkspaceRecord,
    repo_root: PathBuf,
    branch: String,
    archive_commit: String,
    workspace_dir: PathBuf,
    archived_context_dir: PathBuf,
}

/// Read-only validation: every check that can fail without touching the
/// filesystem in a destructive way. Returns the gathered data so the apply
/// path can reuse it. Side-effect-free — safe to call from a "can the user
/// even attempt this?" pre-check before optimistically updating the UI.
fn restore_workspace_preflight(workspace_id: &str) -> Result<RestorePreflightData> {
    let record = load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    if record.state != "archived" {
        bail!("Workspace is not archived: {workspace_id}");
    }

    let repo_root = helpers::non_empty(&record.root_path)
        .map(PathBuf::from)
        .with_context(|| format!("Workspace {workspace_id} is missing repo root_path"))?;
    let branch = helpers::non_empty(&record.branch)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Workspace {workspace_id} is missing branch"))?;
    let archive_commit = helpers::non_empty(&record.archive_commit)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Workspace {workspace_id} is missing archive_commit"))?;

    let workspace_dir = crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
    let archived_context_dir =
        crate::data_dir::archived_context_dir(&record.repo_name, &record.directory_name)?;
    if !archived_context_dir.is_dir() {
        bail!(
            "Archived context directory is missing at {}",
            archived_context_dir.display()
        );
    }

    git_ops::ensure_git_repository(&repo_root)?;
    git_ops::verify_commit_exists(&repo_root, &archive_commit)?;

    Ok(RestorePreflightData {
        record,
        repo_root,
        branch,
        archive_commit,
        workspace_dir,
        archived_context_dir,
    })
}

/// Tauri-callable read-only check: returns `Ok(())` if the workspace can be
/// restored right now, `Err(...)` with a user-facing message if not. Use this
/// from the frontend BEFORE applying an optimistic UI update so the dropdown
/// row doesn't flicker on a guaranteed failure.
pub fn validate_restore_workspace(workspace_id: &str) -> Result<()> {
    restore_workspace_preflight(workspace_id).map(|_| ())
}

pub fn restore_workspace_impl(workspace_id: &str) -> Result<RestoreWorkspaceResponse> {
    let RestorePreflightData {
        record,
        repo_root,
        branch,
        archive_commit,
        workspace_dir,
        archived_context_dir,
    } = restore_workspace_preflight(workspace_id)?;

    if workspace_dir.exists() {
        std::fs::remove_dir_all(&workspace_dir).with_context(|| {
            format!(
                "Failed to remove existing workspace directory: {}",
                workspace_dir.display()
            )
        })?;
    }

    fs::create_dir_all(workspace_dir.parent().with_context(|| {
        format!(
            "Workspace restore target has no parent: {}",
            workspace_dir.display()
        )
    })?)
    .with_context(|| {
        format!(
            "Failed to create workspace parent directory for {}",
            workspace_dir.display()
        )
    })?;

    // Resolve the branch name — if it already exists, find an available -v{N} variant
    let actual_branch = if git_ops::verify_branch_exists(&repo_root, &branch).is_ok() {
        // Branch exists — find a free -v{N} suffix
        let mut candidate = branch.clone();
        for version in 1..=999 {
            candidate = format!("{branch}-v{version}");
            if git_ops::verify_branch_exists(&repo_root, &candidate).is_err() {
                break;
            }
        }
        candidate
    } else {
        branch.clone()
    };

    // Create the branch from the archive commit (or the parent branch as fallback)
    // Prefer intended_target_branch (user may have changed it),
    // fall back to initialization_parent_branch, then "main"
    let parent_branch = helpers::non_empty(&record.intended_target_branch)
        .or_else(|| helpers::non_empty(&record.initialization_parent_branch))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "main".to_string());
    let base_ref = if git_ops::verify_commit_exists(&repo_root, &archive_commit).is_ok() {
        archive_commit.clone()
    } else {
        parent_branch.clone()
    };

    git_ops::run_git(
        [
            "-C",
            &repo_root.display().to_string(),
            "branch",
            &actual_branch,
            &base_ref,
        ],
        None,
    )
    .with_context(|| format!("Failed to create branch {actual_branch} from {base_ref}"))?;

    git_ops::create_worktree(&repo_root, &workspace_dir, &actual_branch)?;

    // Update branch name in DB if it changed.
    //
    // CRITICAL: this update MUST succeed before we proceed. The worktree is
    // already on `actual_branch` (e.g. `feature/foo-v1`), but the DB still
    // points at the old `branch` (e.g. `feature/foo`). If we let a swallowed
    // DB error slip through, every later archive deletes the wrong branch and
    // every later restore picks the wrong commit. Roll back via the same
    // cleanup helper used by the rest of this function on error paths — note
    // that the staged archive dir does not exist yet, so cleanup_failed_restore's
    // `staged_archive_dir.exists()` guard correctly skips the rename-back step.
    let staged_archive_dir = helpers::staged_archive_context_dir(&archived_context_dir);
    if actual_branch != branch {
        let conn = db::open_connection(true).map_err(|error| {
            cleanup_failed_restore(
                &repo_root,
                &workspace_dir,
                None,
                &staged_archive_dir,
                &archived_context_dir,
                &actual_branch,
            );
            error.context("Failed to open DB to persist restored branch name")
        })?;
        conn.execute(
            "UPDATE workspaces SET branch = ?1 WHERE id = ?2",
            rusqlite::params![actual_branch, workspace_id],
        )
        .map_err(|error| {
            cleanup_failed_restore(
                &repo_root,
                &workspace_dir,
                None,
                &staged_archive_dir,
                &archived_context_dir,
                &actual_branch,
            );
            anyhow::anyhow!("Failed to persist restored branch name in DB: {error}")
        })?;
    }

    fs::rename(&archived_context_dir, &staged_archive_dir).map_err(|error| {
        cleanup_failed_restore(
            &repo_root,
            &workspace_dir,
            None,
            &staged_archive_dir,
            &archived_context_dir,
            &actual_branch,
        );
        anyhow::anyhow!(
            "Failed to stage archived context {}: {error}",
            archived_context_dir.display()
        )
    })?;

    let workspace_context_dir = workspace_dir.join(".context");
    if let Err(error) = helpers::copy_dir_all(&staged_archive_dir, &workspace_context_dir) {
        cleanup_failed_restore(
            &repo_root,
            &workspace_dir,
            Some(&workspace_context_dir),
            &staged_archive_dir,
            &archived_context_dir,
            &actual_branch,
        );
        return Err(error);
    }

    if let Err(error) =
        update_restored_workspace_state(workspace_id, &archived_context_dir, &workspace_context_dir)
    {
        cleanup_failed_restore(
            &repo_root,
            &workspace_dir,
            Some(&workspace_context_dir),
            &staged_archive_dir,
            &archived_context_dir,
            &actual_branch,
        );
        return Err(error);
    }

    if let Err(error) = fs::remove_dir_all(&staged_archive_dir) {
        let _ = fs::rename(&staged_archive_dir, &archived_context_dir);
        eprintln!(
            "[restore_workspace] Failed to delete staged archived context {}: {error}",
            staged_archive_dir.display()
        );
    }

    Ok(RestoreWorkspaceResponse {
        restored_workspace_id: workspace_id.to_string(),
        restored_state: "ready".to_string(),
        selected_workspace_id: workspace_id.to_string(),
    })
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

// ---- Internal workspace DB operations ----

#[allow(clippy::too_many_arguments)]
fn insert_initializing_workspace_and_session(
    repository: &repos::RepositoryRecord,
    workspace_id: &str,
    session_id: &str,
    directory_name: &str,
    branch: &str,
    default_branch: &str,
    timestamp: &str,
    initialization_log_path: &Path,
    setup_log_path: &Path,
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
              setup_log_path,
              initialization_log_path,
              initialization_files_copied,
              created_at,
              updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'initializing', ?7, ?8, 'in-progress', 0, ?9, ?10, 0, ?11, ?11)
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
                initialization_log_path.display().to_string(),
                setup_log_path.display().to_string(),
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
              agent_type,
              status,
              model,
              permission_mode,
              provider_session_id,
              unread_count,
              context_token_count,
              context_used_percent,
              thinking_enabled,
              fast_mode,
              agent_personality,
              created_at,
              updated_at,
              last_user_message_at,
              resume_session_at,
              is_hidden,
              is_compacting
            ) VALUES (?1, ?2, 'Untitled', 'claude', 'idle', 'opus', 'default', NULL, 0, 0, NULL, 1, 0, NULL, ?3, ?3, NULL, NULL, 0, 0)
            "#,
            (session_id, workspace_id, timestamp),
        )
        .context("Failed to insert initial session")?;

    transaction
        .commit()
        .context("Failed to commit create-workspace transaction")
}

fn update_workspace_initialization_metadata(
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

fn update_workspace_state(workspace_id: &str, state: &str, timestamp: &str) -> Result<()> {
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

fn delete_workspace_and_session_rows(workspace_id: &str, session_id: &str) -> Result<()> {
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
        .ok();
    transaction.execute(
        "DELETE FROM attachments WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
        [workspace_id],
    ).ok();
    transaction.execute(
        "DELETE FROM session_messages WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
        [workspace_id],
    ).ok();
    transaction
        .execute(
            "DELETE FROM sessions WHERE workspace_id = ?1",
            [workspace_id],
        )
        .ok();
    transaction
        .execute("DELETE FROM workspaces WHERE id = ?1", [workspace_id])
        .ok();

    transaction
        .commit()
        .context("Failed to commit delete workspace transaction")?;

    // Clean up in-memory caches for the deleted workspace.
    if let Ok(mut map) = prefetch_rate_limit_map().lock() {
        map.remove(workspace_id);
    }
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

fn update_archived_workspace_state(workspace_id: &str, archive_commit: &str) -> Result<()> {
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

fn update_restored_workspace_state(
    workspace_id: &str,
    archived_context_dir: &Path,
    workspace_context_dir: &Path,
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

    transaction
        .commit()
        .context("Failed to commit restore transaction")
}

// ---- Cleanup helpers ----

fn cleanup_failed_created_workspace(
    workspace_id: &str,
    session_id: &str,
    repo_root: &Path,
    workspace_dir: &Path,
    branch: &str,
    created_worktree: bool,
) {
    if created_worktree && workspace_dir.exists() {
        let _ = git_ops::remove_worktree(repo_root, workspace_dir);
        let _ = fs::remove_dir_all(workspace_dir);
    }

    let _ = git_ops::remove_branch(repo_root, branch);
    let _ = delete_workspace_and_session_rows(workspace_id, session_id);
}

fn cleanup_failed_restore(
    repo_root: &Path,
    workspace_dir: &Path,
    workspace_context_dir: Option<&Path>,
    staged_archive_dir: &Path,
    archived_context_dir: &Path,
    branch: &str,
) {
    if let Some(context_dir) = workspace_context_dir {
        let _ = fs::remove_dir_all(context_dir);
    }

    let _ = git_ops::remove_worktree(repo_root, workspace_dir);
    let _ = fs::remove_dir_all(workspace_dir);

    // The branch was newly created by restore_workspace; delete it entirely
    // to avoid leaking -v1, -v2, … branches on repeated failures.
    let _ = git_ops::remove_branch(repo_root, branch);

    if staged_archive_dir.exists() && !archived_context_dir.exists() {
        let _ = fs::rename(staged_archive_dir, archived_context_dir);
    }
}

fn cleanup_failed_archive(
    repo_root: &Path,
    workspace_dir: &Path,
    workspace_context_dir: &Path,
    branch: &str,
    archive_commit: &str,
    staged_archive_dir: &Path,
    archived_context_dir: &Path,
) {
    if archived_context_dir.exists() && !staged_archive_dir.exists() {
        let _ = fs::rename(archived_context_dir, staged_archive_dir);
    }

    let _ = git_ops::point_branch_to_commit(repo_root, branch, archive_commit);

    if !workspace_dir.exists() {
        let _ = git_ops::create_worktree(repo_root, workspace_dir, branch);
    }

    if staged_archive_dir.exists() {
        let _ = fs::remove_dir_all(workspace_context_dir);
        let _ = helpers::copy_dir_contents(staged_archive_dir, workspace_context_dir);
        let _ = fs::remove_dir_all(staged_archive_dir);
    }
}

fn create_staged_archive_context(
    workspace_context_dir: &Path,
    staged_archive_dir: &Path,
) -> Result<()> {
    if staged_archive_dir.exists() {
        bail!(
            "Archive staging directory already exists at {}",
            staged_archive_dir.display()
        );
    }

    fs::create_dir_all(staged_archive_dir).with_context(|| {
        format!(
            "Failed to create archive staging directory {}",
            staged_archive_dir.display()
        )
    })?;

    if workspace_context_dir.is_dir() {
        if let Err(error) = helpers::copy_dir_contents(workspace_context_dir, staged_archive_dir) {
            let _ = fs::remove_dir_all(staged_archive_dir);
            return Err(error);
        }
    } else if workspace_context_dir.exists() {
        let _ = fs::remove_dir_all(staged_archive_dir);
        bail!(
            "Workspace context path is not a directory: {}",
            workspace_context_dir.display()
        );
    }

    Ok(())
}

// ---- Setup hooks ----

fn resolve_setup_hook(
    repository: &repos::RepositoryRecord,
    workspace_dir: &Path,
    setup_root_dir: &Path,
) -> Result<Option<PathBuf>> {
    let raw_setup_script = if let Some(script) = repository
        .setup_script
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(script.to_string())
    } else {
        load_setup_script_from_conductor_json(workspace_dir)?
    };

    let Some(raw_setup_script) = raw_setup_script else {
        return Ok(None);
    };

    let resolved_path = expand_hook_path(&raw_setup_script, workspace_dir, setup_root_dir);
    if !resolved_path.exists() {
        bail!(
            "Configured setup script is missing at {}",
            resolved_path.display()
        );
    }

    Ok(Some(resolved_path))
}

fn load_setup_script_from_conductor_json(workspace_dir: &Path) -> Result<Option<String>> {
    let conductor_json_path = workspace_dir.join("conductor.json");
    if !conductor_json_path.is_file() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&conductor_json_path).with_context(|| {
        format!(
            "Failed to read conductor.json at {}",
            conductor_json_path.display()
        )
    })?;
    let json: Value = serde_json::from_str(&contents).with_context(|| {
        format!(
            "Failed to parse conductor.json at {}",
            conductor_json_path.display()
        )
    })?;

    Ok(json
        .get("scripts")
        .and_then(|value| value.get("setup"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned))
}

fn expand_hook_path(raw_value: &str, workspace_dir: &Path, setup_root_dir: &Path) -> PathBuf {
    let setup_root = setup_root_dir.display().to_string();
    let expanded = raw_value
        .replace("$CONDUCTOR_ROOT_PATH", &setup_root)
        .replace(
            "$CONDUCTOR_WORKSPACE_PATH",
            &workspace_dir.display().to_string(),
        );
    let expanded_path = PathBuf::from(expanded);

    if expanded_path.is_absolute() {
        expanded_path
    } else {
        workspace_dir.join(expanded_path)
    }
}

fn run_setup_hook(
    setup_script: Option<&Path>,
    workspace_dir: &Path,
    setup_root_dir: &Path,
    log_path: &Path,
) -> Result<()> {
    let Some(setup_script) = setup_script else {
        write_log_file(log_path, "No setup script configured.\n")?;
        return Ok(());
    };

    let (program, args) = command_for_script(setup_script)?;
    let setup_root = setup_root_dir.display().to_string();
    let workspace_path = workspace_dir.display().to_string();

    let output = Command::new(&program)
        .args(&args)
        .arg(setup_script)
        .current_dir(workspace_dir)
        .env("CONDUCTOR_ROOT_PATH", &setup_root)
        .env("CONDUCTOR_WORKSPACE_PATH", &workspace_path)
        .output()
        .map_err(|error| {
            let _ = write_log_file(
                log_path,
                &format!(
                    "Failed to spawn setup script\nProgram: {}\nScript: {}\nError: {}\n",
                    program,
                    setup_script.display(),
                    error
                ),
            );
            anyhow::anyhow!(
                "Failed to execute setup script {}: {error}",
                setup_script.display()
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    write_log_file(
        log_path,
        &format!(
            "Program: {}\nScript: {}\nWorkspace: {}\nCONDUCTOR_ROOT_PATH={}\nCONDUCTOR_WORKSPACE_PATH={}\nExit status: {}\n\n[stdout]\n{}\n\n[stderr]\n{}\n",
            program,
            setup_script.display(),
            workspace_dir.display(),
            setup_root,
            workspace_path,
            output.status,
            stdout,
            stderr
        ),
    )?;

    if output.status.success() {
        Ok(())
    } else {
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("exit status {}", output.status)
        };
        bail!(
            "Setup script failed for {}: {detail}",
            setup_script.display()
        )
    }
}

fn command_for_script(script_path: &Path) -> Result<(String, Vec<String>)> {
    let contents = fs::read_to_string(script_path)
        .with_context(|| format!("Failed to inspect setup script {}", script_path.display()))?;
    let first_line = contents.lines().next().unwrap_or_default();

    if let Some(interpreter) = first_line.strip_prefix("#!") {
        let tokens = interpreter
            .split_whitespace()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if let Some((program, args)) = tokens.split_first() {
            return Ok((program.clone(), args.to_vec()));
        }
    }

    Ok(("/bin/sh".to_string(), Vec::new()))
}

fn write_log_file(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create log directory {}", parent.display()))?;
    }

    fs::write(path, contents)
        .with_context(|| format!("Failed to write log file {}", path.display()))
}
