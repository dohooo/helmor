use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
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
        WHEN COALESCE(w.unread, 0) > 0 OR COALESCE((
          SELECT SUM(ws.unread_count)
          FROM sessions ws
          WHERE ws.workspace_id = w.id
        ), 0) > 0 THEN 1
        ELSE 0
      END AS has_unread,
      COALESCE(w.unread, 0) AS workspace_unread,
      COALESCE((
        SELECT SUM(ws.unread_count)
        FROM sessions ws
        WHERE ws.workspace_id = w.id
      ), 0) AS session_unread_total,
      COALESCE((
        SELECT COUNT(*)
        FROM sessions ws
        WHERE ws.workspace_id = w.id
          AND COALESCE(ws.unread_count, 0) > 0
      ), 0) AS unread_session_count,
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
      (
        SELECT COUNT(*)
        FROM sessions ws
        WHERE ws.workspace_id = w.id
      ) AS session_count,
      (
        SELECT COUNT(*)
        FROM session_messages sm
        JOIN sessions ws ON ws.id = sm.session_id
        WHERE ws.workspace_id = w.id
      ) AS message_count,
      (
        SELECT COUNT(*)
        FROM attachments a
        JOIN sessions ws ON ws.id = a.session_id
        WHERE ws.workspace_id = w.id
      ) AS attachment_count
    FROM workspaces w
    JOIN repos r ON r.id = w.repository_id
    LEFT JOIN sessions s ON s.id = w.active_session_id
"#;

// ---- Loading workspace records ----

pub fn load_workspace_records() -> Result<Vec<WorkspaceRecord>> {
    let connection = db::open_connection(false)?;
    let mut statement = connection.prepare(WORKSPACE_RECORD_SQL)?;

    let rows = statement.query_map([], helpers::workspace_record_from_row)?;

    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn load_workspace_record_by_id(
    workspace_id: &str,
) -> Result<Option<WorkspaceRecord>> {
    let connection = db::open_connection(false)?;
    let mut statement = connection
        .prepare(format!("{WORKSPACE_RECORD_SQL} WHERE w.id = ?1").as_str())?;

    let mut rows = statement
        .query_map([workspace_id], helpers::workspace_record_from_row)?;

    match rows.next() {
        Some(result) => Ok(result.map(Some)?),
        None => Ok(None),
    }
}

// ---- Sidebar groups ----

pub fn list_workspace_groups() -> Result<Vec<WorkspaceSidebarGroup>> {
    let mut done = Vec::new();
    let mut review = Vec::new();
    let mut progress = Vec::new();
    let mut backlog = Vec::new();
    let mut canceled = Vec::new();

    for record in load_workspace_records()? {
        if record.state == "archived" {
            continue;
        }
        let row = record_to_sidebar_row(record);
        match helpers::group_id_from_status(&row.manual_status, &row.derived_status) {
            "done" => done.push(row),
            "review" => review.push(row),
            "backlog" => backlog.push(row),
            "canceled" => canceled.push(row),
            _ => progress.push(row),
        }
    }

    helpers::sort_sidebar_rows(&mut done);
    helpers::sort_sidebar_rows(&mut review);
    helpers::sort_sidebar_rows(&mut progress);
    helpers::sort_sidebar_rows(&mut backlog);
    helpers::sort_sidebar_rows(&mut canceled);

    Ok(vec![
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
    let mut archived = load_workspace_records()?
        .into_iter()
        .filter(|record| record.state == "archived")
        .map(record_to_summary)
        .collect::<Vec<_>>();

    archived.sort_by(|left, right| left.title.to_lowercase().cmp(&right.title.to_lowercase()));

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

    let mirror_dir = crate::data_dir::repo_mirror_dir(&record.repo_name)?;
    git_ops::ensure_repo_mirror(&repo_root, &mirror_dir)?;
    git_ops::fetch_mirror_from_source(&repo_root, &mirror_dir)?;
    git_ops::list_remote_branches(&mirror_dir)
}

// ---- Update intended target branch ----

pub fn update_intended_target_branch(workspace_id: &str, target_branch: &str) -> Result<()> {
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

    Ok(())
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

// ---- Select visible workspace for repo ----

pub(crate) fn select_visible_workspace_for_repo(
    repo_id: &str,
) -> Result<Option<(String, String)>> {
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
    let mirror_dir = crate::data_dir::repo_mirror_dir(&repository.name)?;
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

        git_ops::ensure_repo_mirror(&repo_root, &mirror_dir)?;
        let tracked_start_ref = git_ops::remote_tracking_branch_ref(&default_branch);
        git_ops::verify_commitish_exists_in_mirror(
            &mirror_dir,
            &tracked_start_ref,
            &format!("Default branch is missing in source repo: {default_branch}"),
        )?;
        let init_log = match git_ops::create_worktree_from_start_point(
            &mirror_dir,
            &workspace_dir,
            &branch,
            &tracked_start_ref,
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
                tracked_start_ref,
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

        git_ops::refresh_repo_setup_root(&mirror_dir, &setup_root_dir, &tracked_start_ref)?;
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
                &mirror_dir,
                &workspace_dir,
                &branch,
                created_worktree,
            );
            Err(error)
        }
    };

    if created_setup_root {
        let _ = git_ops::remove_worktree(&mirror_dir, &setup_root_dir);
        let _ = fs::remove_dir_all(&setup_root_dir);
    }

    result
}

// ---- Archive workspace ----

pub fn archive_workspace_impl(workspace_id: &str) -> Result<ArchiveWorkspaceResponse> {
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

    let workspace_dir =
        crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
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

    fs::create_dir_all(
        archived_context_dir.parent().with_context(|| {
            format!(
                "Archived context target has no parent: {}",
                archived_context_dir.display()
            )
        })?,
    )
    .with_context(|| {
        format!(
            "Failed to create archived context parent directory for {}",
            archived_context_dir.display()
        )
    })?;

    let mirror_dir = crate::data_dir::repo_mirror_dir(&record.repo_name)?;
    git_ops::ensure_repo_mirror(&repo_root, &mirror_dir)?;

    let archive_commit = git_ops::current_workspace_head_commit(&workspace_dir)?;
    git_ops::verify_commit_exists_in_mirror(&mirror_dir, &archive_commit)?;

    let workspace_context_dir = workspace_dir.join(".context");
    let staged_archive_dir = helpers::staged_archive_context_dir(&archived_context_dir);
    create_staged_archive_context(&workspace_context_dir, &staged_archive_dir)?;

    if let Err(error) = git_ops::remove_worktree(&mirror_dir, &workspace_dir) {
        let _ = fs::remove_dir_all(&staged_archive_dir);
        return Err(error);
    }

    if let Err(error) = fs::rename(&staged_archive_dir, &archived_context_dir) {
        cleanup_failed_archive(
            &mirror_dir,
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
            &mirror_dir,
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

pub fn restore_workspace_impl(workspace_id: &str) -> Result<RestoreWorkspaceResponse> {
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

    let workspace_dir =
        crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
    if workspace_dir.exists() {
        bail!(
            "Restore target already exists at {}",
            workspace_dir.display()
        );
    }

    let archived_context_dir =
        crate::data_dir::archived_context_dir(&record.repo_name, &record.directory_name)?;
    if !archived_context_dir.is_dir() {
        bail!(
            "Archived context directory is missing at {}",
            archived_context_dir.display()
        );
    }

    fs::create_dir_all(
        workspace_dir.parent().with_context(|| {
            format!(
                "Workspace restore target has no parent: {}",
                workspace_dir.display()
            )
        })?,
    )
    .with_context(|| {
        format!(
            "Failed to create workspace parent directory for {}",
            workspace_dir.display()
        )
    })?;

    let mirror_dir = crate::data_dir::repo_mirror_dir(&record.repo_name)?;
    git_ops::ensure_repo_mirror(&repo_root, &mirror_dir)?;
    git_ops::verify_branch_exists_in_mirror(&mirror_dir, &branch)?;
    git_ops::verify_commit_exists_in_mirror(&mirror_dir, &archive_commit)?;
    git_ops::point_branch_to_archive_commit(&mirror_dir, &branch, &archive_commit)?;
    git_ops::create_worktree(&mirror_dir, &workspace_dir, &branch)?;

    let staged_archive_dir = helpers::staged_archive_context_dir(&archived_context_dir);
    fs::rename(&archived_context_dir, &staged_archive_dir).map_err(|error| {
        cleanup_failed_restore(
            &mirror_dir,
            &workspace_dir,
            None,
            &staged_archive_dir,
            &archived_context_dir,
        );
        anyhow::anyhow!(
            "Failed to stage archived context {}: {error}",
            archived_context_dir.display()
        )
    })?;

    let workspace_context_dir = workspace_dir.join(".context");
    if let Err(error) = helpers::copy_dir_all(&staged_archive_dir, &workspace_context_dir) {
        cleanup_failed_restore(
            &mirror_dir,
            &workspace_dir,
            Some(&workspace_context_dir),
            &staged_archive_dir,
            &archived_context_dir,
        );
        return Err(error);
    }

    if let Err(error) = update_restored_workspace_state(
        workspace_id,
        &archived_context_dir,
        &workspace_context_dir,
    ) {
        cleanup_failed_restore(
            &mirror_dir,
            &workspace_dir,
            Some(&workspace_context_dir),
            &staged_archive_dir,
            &archived_context_dir,
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

    WorkspaceDetail {
        title: helpers::display_title(&record),
        id: record.id,
        repo_id: record.repo_id,
        repo_name: record.repo_name,
        repo_icon_src: helpers::repo_icon_src_for_root_path(record.root_path.as_deref()),
        repo_initials,
        remote_url: record.remote_url,
        default_branch: record.default_branch,
        root_path: record.root_path,
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
              claude_session_id,
              unread_count,
              context_token_count,
              context_used_percent,
              thinking_enabled,
              codex_thinking_level,
              fast_mode,
              agent_personality,
              created_at,
              updated_at,
              last_user_message_at,
              resume_session_at,
              is_hidden,
              is_compacting
            ) VALUES (?1, ?2, 'Untitled', 'claude', 'idle', 'opus', 'default', NULL, 0, 0, NULL, 1, NULL, 0, NULL, ?3, ?3, NULL, NULL, 0, 0)
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

fn update_workspace_state(
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
        bail!(
            "Workspace state update affected {updated_rows} rows for {workspace_id}"
        );
    }

    Ok(())
}

fn delete_workspace_and_session_rows(
    workspace_id: &str,
    session_id: &str,
) -> Result<()> {
    let mut connection = db::open_connection(true)?;
    let transaction = connection
        .transaction()
        .context("Failed to start create cleanup transaction")?;

    transaction
        .execute("DELETE FROM attachments WHERE session_id = ?1", [session_id])
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

fn update_archived_workspace_state(
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
        bail!(
            "Archive state update affected {updated_rows} rows for workspace {workspace_id}"
        );
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
        bail!(
            "Restore state update affected {updated_rows} rows for workspace {workspace_id}"
        );
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
    mirror_dir: &Path,
    workspace_dir: &Path,
    branch: &str,
    created_worktree: bool,
) {
    if created_worktree && workspace_dir.exists() {
        let _ = git_ops::remove_worktree(mirror_dir, workspace_dir);
        let _ = fs::remove_dir_all(workspace_dir);
    }

    let _ = git_ops::remove_branch(mirror_dir, branch);
    let _ = delete_workspace_and_session_rows(workspace_id, session_id);
}

fn cleanup_failed_restore(
    mirror_dir: &Path,
    workspace_dir: &Path,
    workspace_context_dir: Option<&Path>,
    staged_archive_dir: &Path,
    archived_context_dir: &Path,
) {
    if let Some(context_dir) = workspace_context_dir {
        let _ = fs::remove_dir_all(context_dir);
    }

    let mirror_dir_str = mirror_dir.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    let _ = git_ops::run_git(
        [
            "--git-dir",
            mirror_dir_str.as_str(),
            "worktree",
            "remove",
            "--force",
            workspace_dir_arg.as_str(),
        ],
        None,
    );
    let _ = fs::remove_dir_all(workspace_dir);

    if staged_archive_dir.exists() && !archived_context_dir.exists() {
        let _ = fs::rename(staged_archive_dir, archived_context_dir);
    }
}

fn cleanup_failed_archive(
    mirror_dir: &Path,
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

    let _ = git_ops::point_branch_to_archive_commit(mirror_dir, branch, archive_commit);

    if !workspace_dir.exists() {
        let _ = git_ops::create_worktree(mirror_dir, workspace_dir, branch);
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
        if let Err(error) =
            helpers::copy_dir_contents(workspace_context_dir, staged_archive_dir)
        {
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
    mirror_dir: &Path,
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

    let resolved_path = expand_hook_path(&raw_setup_script, workspace_dir, mirror_dir);
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

fn expand_hook_path(raw_value: &str, workspace_dir: &Path, mirror_dir: &Path) -> PathBuf {
    let mirror_root = mirror_dir.display().to_string();
    let expanded = raw_value
        .replace("$CONDUCTOR_ROOT_PATH", &mirror_root)
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
    mirror_dir: &Path,
    log_path: &Path,
) -> Result<()> {
    let Some(setup_script) = setup_script else {
        write_log_file(log_path, "No setup script configured.\n")?;
        return Ok(());
    };

    let (program, args) = command_for_script(setup_script)?;
    let mirror_root = mirror_dir.display().to_string();
    let workspace_path = workspace_dir.display().to_string();

    let output = Command::new(&program)
        .args(&args)
        .arg(setup_script)
        .current_dir(workspace_dir)
        .env("CONDUCTOR_ROOT_PATH", &mirror_root)
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
            mirror_root,
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
    let contents = fs::read_to_string(script_path).with_context(|| {
        format!(
            "Failed to inspect setup script {}",
            script_path.display()
        )
    })?;
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
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "Failed to create log directory {}",
                parent.display()
            )
        })?;
    }

    fs::write(path, contents)
        .with_context(|| format!("Failed to write log file {}", path.display()))
}
