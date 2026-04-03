use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::{
    collections::HashSet,
    ffi::OsStr,
    fs,
    process::Command,
    path::{Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};

use rusqlite::{Connection, OpenFlags, Row, Transaction};
use serde::Serialize;
use serde_json::Value;

const FIXTURE_BASE_DIR: &str = ".local-data/conductor";
static WORKSPACE_MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConductorFixtureInfo {
    pub data_mode: String,
    pub fixture_root: String,
    pub db_path: String,
    pub archive_root: String,
}

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
pub struct RepositoryCreateOption {
    pub id: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub repo_icon_src: Option<String>,
    pub repo_initials: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRepositoryDefaults {
    pub last_clone_directory: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRepositoryResponse {
    pub repository_id: String,
    pub created_repository: bool,
    pub selected_workspace_id: String,
    pub created_workspace_id: Option<String>,
    pub created_workspace_state: String,
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

#[derive(Debug)]
struct WorkspaceRecord {
    id: String,
    repo_id: String,
    repo_name: String,
    remote_url: Option<String>,
    default_branch: Option<String>,
    root_path: Option<String>,
    directory_name: String,
    state: String,
    has_unread: bool,
    workspace_unread: i64,
    session_unread_total: i64,
    unread_session_count: i64,
    derived_status: String,
    manual_status: Option<String>,
    branch: Option<String>,
    initialization_parent_branch: Option<String>,
    intended_target_branch: Option<String>,
    notes: Option<String>,
    pinned_at: Option<String>,
    active_session_id: Option<String>,
    active_session_title: Option<String>,
    active_session_agent_type: Option<String>,
    active_session_status: Option<String>,
    pr_title: Option<String>,
    pr_description: Option<String>,
    archive_commit: Option<String>,
    session_count: i64,
    message_count: i64,
    attachment_count: i64,
}

#[derive(Debug, Clone)]
struct FixtureRepositoryRecord {
    id: String,
    name: String,
    default_branch: Option<String>,
    root_path: String,
    setup_script: Option<String>,
}

#[derive(Debug, Clone)]
struct BranchPrefixSettings {
    branch_prefix_type: Option<String>,
    branch_prefix_custom: Option<String>,
}

#[derive(Debug, Clone)]
struct ResolvedRepositoryInput {
    name: String,
    normalized_root_path: String,
    remote: Option<String>,
    remote_url: Option<String>,
    default_branch: String,
}

#[tauri::command]
pub fn get_conductor_fixture_info() -> Result<ConductorFixtureInfo, String> {
    let fixture_root = resolve_fixture_root()?;
    let db_path = fixture_root.join("com.conductor.app/conductor.db");
    let archive_root = fixture_root.join("helmor/archived-contexts");

    Ok(ConductorFixtureInfo {
        data_mode: "fixture".to_string(),
        fixture_root: fixture_root.display().to_string(),
        db_path: db_path.display().to_string(),
        archive_root: archive_root.display().to_string(),
    })
}

#[tauri::command]
pub fn list_fixture_repositories() -> Result<Vec<RepositoryCreateOption>, String> {
    let fixture_root = resolve_fixture_root()?;
    list_fixture_repositories_at(&fixture_root)
}

#[tauri::command]
pub fn get_fixture_add_repository_defaults() -> Result<AddRepositoryDefaults, String> {
    let fixture_root = resolve_fixture_root()?;
    get_fixture_add_repository_defaults_at(&fixture_root)
}

#[tauri::command]
pub fn add_fixture_repository_from_local_path(
    folder_path: String,
) -> Result<AddRepositoryResponse, String> {
    let _lock = WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| "Workspace mutation lock poisoned".to_string())?;
    let fixture_root = resolve_fixture_root()?;

    add_fixture_repository_from_local_path_at(&fixture_root, &folder_path)
}

#[tauri::command]
pub fn create_fixture_workspace_from_repo(
    repo_id: String,
) -> Result<CreateWorkspaceResponse, String> {
    let _lock = WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| "Workspace mutation lock poisoned".to_string())?;
    let fixture_root = resolve_fixture_root()?;

    create_fixture_workspace_from_repo_at(&fixture_root, &repo_id)
}

#[tauri::command]
pub fn list_workspace_groups() -> Result<Vec<WorkspaceSidebarGroup>, String> {
    let records = load_workspace_records()?
        .into_iter()
        .filter(|record| record.state != "archived")
        .collect::<Vec<_>>();
    let mut done = Vec::new();
    let mut review = Vec::new();
    let mut progress = Vec::new();
    let mut backlog = Vec::new();
    let mut canceled = Vec::new();

    for record in records {
        let row = record_to_sidebar_row(record);
        match group_id_from_status(&row.manual_status, &row.derived_status) {
            "done" => done.push(row),
            "review" => review.push(row),
            "backlog" => backlog.push(row),
            "canceled" => canceled.push(row),
            _ => progress.push(row),
        }
    }

    sort_sidebar_rows(&mut done);
    sort_sidebar_rows(&mut review);
    sort_sidebar_rows(&mut progress);
    sort_sidebar_rows(&mut backlog);
    sort_sidebar_rows(&mut canceled);

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

#[tauri::command]
pub fn list_archived_workspaces() -> Result<Vec<WorkspaceSummary>, String> {
    let mut archived = load_workspace_records()?
        .into_iter()
        .filter(|record| record.state == "archived")
        .map(record_to_summary)
        .collect::<Vec<_>>();

    archived.sort_by(|left, right| left.title.to_lowercase().cmp(&right.title.to_lowercase()));

    Ok(archived)
}

#[tauri::command]
pub fn get_workspace(workspace_id: String) -> Result<WorkspaceDetail, String> {
    let record = load_workspace_record_by_id(&workspace_id)?
        .ok_or_else(|| format!("Workspace not found: {workspace_id}"))?;

    Ok(record_to_detail(record))
}

#[tauri::command]
pub fn list_workspace_sessions(
    workspace_id: String,
) -> Result<Vec<WorkspaceSessionSummary>, String> {
    load_workspace_sessions_by_workspace_id(&workspace_id)
}

#[tauri::command]
pub fn list_session_messages(session_id: String) -> Result<Vec<SessionMessageRecord>, String> {
    load_session_messages_by_session_id(&session_id)
}

#[tauri::command]
pub fn list_session_attachments(
    session_id: String,
) -> Result<Vec<SessionAttachmentRecord>, String> {
    load_session_attachments_by_session_id(&session_id)
}

#[tauri::command]
pub fn mark_fixture_session_read(session_id: String) -> Result<(), String> {
    let _lock = WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| "Workspace mutation lock poisoned".to_string())?;
    let fixture_root = resolve_fixture_root()?;

    mark_fixture_session_read_at(&fixture_root, &session_id)
}

#[tauri::command]
pub fn mark_fixture_workspace_read(workspace_id: String) -> Result<(), String> {
    let _lock = WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| "Workspace mutation lock poisoned".to_string())?;
    let fixture_root = resolve_fixture_root()?;

    mark_fixture_workspace_read_at(&fixture_root, &workspace_id)
}

#[tauri::command]
pub fn mark_fixture_workspace_unread(workspace_id: String) -> Result<(), String> {
    let _lock = WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| "Workspace mutation lock poisoned".to_string())?;
    let fixture_root = resolve_fixture_root()?;

    mark_fixture_workspace_unread_at(&fixture_root, &workspace_id)
}

#[tauri::command]
pub fn restore_fixture_workspace(workspace_id: String) -> Result<RestoreWorkspaceResponse, String> {
    let _lock = WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| "Restore lock poisoned".to_string())?;
    let fixture_root = resolve_fixture_root()?;

    restore_fixture_workspace_at(&fixture_root, &workspace_id)
}

#[tauri::command]
pub fn archive_fixture_workspace(workspace_id: String) -> Result<ArchiveWorkspaceResponse, String> {
    let _lock = WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| "Workspace mutation lock poisoned".to_string())?;
    let fixture_root = resolve_fixture_root()?;

    archive_fixture_workspace_at(&fixture_root, &workspace_id)
}

fn list_fixture_repositories_at(
    fixture_root: &Path,
) -> Result<Vec<RepositoryCreateOption>, String> {
    let connection = open_fixture_connection_at(fixture_root, false)?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT
              id,
              name,
              default_branch,
              root_path
            FROM repos
            WHERE COALESCE(hidden, 0) = 0
            ORDER BY COALESCE(display_order, 0) ASC, LOWER(name) ASC
            "#,
        )
        .map_err(|error| format!("Failed to prepare fixture repository list query: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let root_path: Option<String> = row.get(3)?;

            Ok(RepositoryCreateOption {
                id: row.get(0)?,
                name: name.clone(),
                default_branch: row.get(2)?,
                repo_icon_src: repo_icon_src_for_root_path(root_path.as_deref()),
                repo_initials: repo_initials_for_name(&name),
            })
        })
        .map_err(|error| format!("Failed to load fixture repositories: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to deserialize fixture repositories: {error}"))
}

fn get_fixture_add_repository_defaults_at(
    fixture_root: &Path,
) -> Result<AddRepositoryDefaults, String> {
    Ok(AddRepositoryDefaults {
        last_clone_directory: load_setting_value_at(fixture_root, "last_clone_directory")?,
    })
}

fn add_fixture_repository_from_local_path_at(
    fixture_root: &Path,
    folder_path: &str,
) -> Result<AddRepositoryResponse, String> {
    let resolved_repository = resolve_repository_from_local_path(folder_path)?;
    let last_clone_directory = Path::new(&resolved_repository.normalized_root_path)
        .parent()
        .map(|parent| parent.display().to_string());

    let existing_repository = load_fixture_repository_by_root_path_from_fixture(
        fixture_root,
        &resolved_repository.normalized_root_path,
    )?;

    if let Some(last_clone_directory) = last_clone_directory.as_deref() {
        upsert_setting_value_at(fixture_root, "last_clone_directory", last_clone_directory)?;
    }

    if let Some(repository) = existing_repository {
        if let Some((selected_workspace_id, selected_workspace_state)) =
            select_visible_workspace_for_repo_at(fixture_root, &repository.id)?
        {
            return Ok(AddRepositoryResponse {
                repository_id: repository.id,
                created_repository: false,
                selected_workspace_id,
                created_workspace_id: None,
                created_workspace_state: selected_workspace_state,
            });
        }

        let create_response =
            create_fixture_workspace_from_repo_at(fixture_root, &repository.id).map_err(|error| {
                format!("Repository already exists, but workspace create failed: {error}")
            })?;

        return Ok(AddRepositoryResponse {
            repository_id: repository.id,
            created_repository: false,
            selected_workspace_id: create_response.selected_workspace_id.clone(),
            created_workspace_id: Some(create_response.created_workspace_id),
            created_workspace_state: create_response.created_state,
        });
    }

    let repository_id =
        insert_fixture_repository_at(fixture_root, &resolved_repository).map_err(|error| {
            format!("Failed to persist repository {}: {error}", resolved_repository.name)
        })?;
    let create_result = create_fixture_workspace_from_repo_at(fixture_root, &repository_id);

    match create_result {
        Ok(create_response) => Ok(AddRepositoryResponse {
            repository_id,
            created_repository: true,
            selected_workspace_id: create_response.selected_workspace_id.clone(),
            created_workspace_id: Some(create_response.created_workspace_id),
            created_workspace_state: create_response.created_state,
        }),
        Err(error) => {
            let _ = delete_fixture_repository_at(fixture_root, &repository_id);
            Err(format!("First workspace create failed: {error}"))
        }
    }
}

fn create_fixture_workspace_from_repo_at(
    fixture_root: &Path,
    repo_id: &str,
) -> Result<CreateWorkspaceResponse, String> {
    let repository = load_fixture_repository_by_id_from_fixture(fixture_root, repo_id)?
        .ok_or_else(|| format!("Repository not found: {repo_id}"))?;
    let repo_root = PathBuf::from(repository.root_path.trim());
    ensure_git_repository(&repo_root)?;

    let directory_name = allocate_directory_name_for_repo(fixture_root, repo_id)?;
    let branch_settings = load_branch_prefix_settings_at(fixture_root)?;
    let branch = branch_name_for_directory(&directory_name, &branch_settings);
    let default_branch = repository
        .default_branch
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "main".to_string());
    let workspace_id = uuid::Uuid::new_v4().to_string();
    let session_id = uuid::Uuid::new_v4().to_string();
    let workspace_dir = fixture_workspace_dir(fixture_root, &repository.name, &directory_name);
    let mirror_dir = fixture_repo_mirror_dir(fixture_root, &repository.name);
    let setup_root_dir = fixture_repo_setup_root_dir(fixture_root, &repository.name);
    let logs_dir = fixture_workspace_logs_dir(fixture_root, &workspace_id);
    let initialization_log_path = logs_dir.join("initialization.log");
    let setup_log_path = logs_dir.join("setup.log");
    let timestamp = current_fixture_timestamp(fixture_root)?;
    let mut created_worktree = false;
    let mut created_setup_root = false;

    fs::create_dir_all(&logs_dir).map_err(|error| {
        format!(
            "Failed to create workspace log directory {}: {error}",
            logs_dir.display()
        )
    })?;

    insert_initializing_workspace_and_session(
        fixture_root,
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

    let create_result = (|| -> Result<CreateWorkspaceResponse, String> {
        if workspace_dir.exists() {
            let error = format!(
                "Workspace target already exists at {}",
                workspace_dir.display()
            );
            let _ = write_log_file(&initialization_log_path, &error);
            return Err(error);
        }

        ensure_fixture_repo_mirror(&repo_root, &mirror_dir)?;
        let tracked_start_ref = remote_tracking_branch_ref(&default_branch);
        verify_commitish_exists_in_mirror(&mirror_dir, &tracked_start_ref, &format!(
            "Default branch is missing in source repo: {default_branch}"
        ))?;
        let init_log = match create_fixture_worktree_from_start_point(
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
                let _ = write_log_file(&initialization_log_path, &error);
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

        create_workspace_context_scaffold(&workspace_dir)?;
        let initialization_files_copied = tracked_file_count(&workspace_dir)?;

        update_workspace_initialization_metadata(
            fixture_root,
            &workspace_id,
            initialization_files_copied,
            &timestamp,
        )?;
        update_workspace_state(fixture_root, &workspace_id, "setting_up", &timestamp)?;

        refresh_fixture_repo_setup_root(&mirror_dir, &setup_root_dir, &tracked_start_ref)?;
        created_setup_root = true;

        let setup_hook = match resolve_setup_hook(&repository, &workspace_dir, &setup_root_dir) {
            Ok(value) => value,
            Err(error) => {
                let _ = write_log_file(&setup_log_path, &error);
                return Err(error);
            }
        };
        run_setup_hook(
            setup_hook.as_deref(),
            &workspace_dir,
            &setup_root_dir,
            &setup_log_path,
        )?;
        update_workspace_state(fixture_root, &workspace_id, "ready", &timestamp)?;

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
                fixture_root,
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
        let _ = remove_fixture_worktree(&mirror_dir, &setup_root_dir);
        let _ = fs::remove_dir_all(&setup_root_dir);
    }

    result
}

fn record_to_sidebar_row(record: WorkspaceRecord) -> WorkspaceSidebarRow {
    let title = display_title(&record);
    let repo_initials = repo_initials_for_name(&record.repo_name);

    WorkspaceSidebarRow {
        avatar: repo_initials.clone(),
        title,
        id: record.id,
        directory_name: record.directory_name,
        repo_name: record.repo_name,
        repo_icon_src: repo_icon_src_for_root_path(record.root_path.as_deref()),
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

fn record_to_summary(record: WorkspaceRecord) -> WorkspaceSummary {
    let repo_initials = repo_initials_for_name(&record.repo_name);

    WorkspaceSummary {
        title: display_title(&record),
        id: record.id,
        directory_name: record.directory_name,
        repo_name: record.repo_name,
        repo_icon_src: repo_icon_src_for_root_path(record.root_path.as_deref()),
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

fn record_to_detail(record: WorkspaceRecord) -> WorkspaceDetail {
    let repo_initials = repo_initials_for_name(&record.repo_name);

    WorkspaceDetail {
        title: display_title(&record),
        id: record.id,
        repo_id: record.repo_id,
        repo_name: record.repo_name,
        repo_icon_src: repo_icon_src_for_root_path(record.root_path.as_deref()),
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

fn display_title(record: &WorkspaceRecord) -> String {
    if let Some(pr_title) = non_empty(&record.pr_title) {
        return pr_title.to_string();
    }

    if let Some(session_title) = non_empty(&record.active_session_title) {
        if session_title != "Untitled" {
            return session_title.to_string();
        }
    }

    humanize_directory_name(&record.directory_name)
}

const REPO_ICON_CANDIDATES: &[&str] = &[
    "public/apple-touch-icon.png",
    "apple-touch-icon.png",
    "public/favicon.svg",
    "favicon.svg",
    "public/favicon.png",
    "public/icon.png",
    "public/logo.png",
    "favicon.png",
    "app/icon.png",
    "src/app/icon.png",
    "public/favicon.ico",
    "favicon.ico",
    "app/favicon.ico",
    "static/favicon.ico",
    "src-tauri/icons/icon.png",
    "assets/icon.png",
    "src/assets/icon.png",
];

fn repo_icon_path_for_root_path(root_path: Option<&str>) -> Option<String> {
    let root_path = root_path?.trim();

    if root_path.is_empty() {
        return None;
    }

    let root = Path::new(root_path);

    for candidate in REPO_ICON_CANDIDATES {
        let path = root.join(candidate);

        if path.is_file() {
            return Some(path.display().to_string());
        }
    }

    None
}

fn repo_icon_src_for_root_path(root_path: Option<&str>) -> Option<String> {
    let icon_path = repo_icon_path_for_root_path(root_path)?;
    let mime_type = repo_icon_mime_type(Path::new(&icon_path));
    let bytes = fs::read(icon_path).ok()?;

    Some(format!(
        "data:{mime_type};base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

fn repo_icon_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        _ => "image/png",
    }
}

fn repo_initials_for_name(repo_name: &str) -> String {
    let segments = repo_name
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();

    let mut initials = String::new();

    if segments.len() >= 2 {
        for segment in segments.iter().take(2) {
            if let Some(character) = segment.chars().next() {
                initials.push(character.to_ascii_uppercase());
            }
        }
    }

    if initials.is_empty() {
        for character in repo_name.chars().filter(|character| character.is_ascii_alphanumeric()) {
            initials.push(character.to_ascii_uppercase());

            if initials.len() == 2 {
                break;
            }
        }
    }

    if initials.is_empty() {
        "WS".to_string()
    } else {
        initials
    }
}

fn group_id_from_status(manual_status: &Option<String>, derived_status: &str) -> &'static str {
    let status = non_empty(manual_status)
        .unwrap_or(derived_status)
        .trim()
        .to_ascii_lowercase();

    match status.as_str() {
        "done" => "done",
        "review" | "in-review" => "review",
        "backlog" => "backlog",
        "cancelled" | "canceled" => "canceled",
        _ => "progress",
    }
}

fn sort_sidebar_rows(rows: &mut [WorkspaceSidebarRow]) {
    rows.sort_by(|left, right| left.title.to_lowercase().cmp(&right.title.to_lowercase()));
}

fn humanize_directory_name(directory_name: &str) -> String {
    directory_name
        .split(['-', '_'])
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let mut characters = segment.chars();
            match characters.next() {
                Some(first) if first.is_ascii_alphabetic() => {
                    let mut label = String::new();
                    label.push(first.to_ascii_uppercase());
                    label.push_str(characters.as_str());
                    label
                }
                Some(first) => {
                    let mut label = String::new();
                    label.push(first);
                    label.push_str(characters.as_str());
                    label
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|inner| !inner.trim().is_empty())
}

const STAR_PROPER_NAMES: &[&str] = &[
    "acamar", "achernar", "acrux", "adhafera", "adhara", "ain", "albali", "albireo",
    "alkaid", "alkalurops", "alkaphrah", "alpheratz", "alrakis", "altair", "alya",
    "ancha", "ankaa", "antares", "aran", "arcturus", "aspidiske", "atik", "atria",
    "avior", "bellatrix", "betelgeuse", "canopus", "capella", "castor", "cebalrai",
    "deneb", "denebola", "diadem", "diphda", "electra", "elnath", "enif", "etamin",
    "fomalhaut", "furud", "gacrux", "gienah", "hamal", "hassaleh", "hydrobius",
    "izar", "jabbah", "kaus", "kochab", "lesath", "maia", "markab", "meissa",
    "menkalinan", "merak", "miaplacidus", "mimosa", "mintaka", "mirach", "mirfak",
    "mizar", "naos", "nashira", "nunki", "peacock", "phact", "phecda", "pleione",
    "polaris", "pollux", "procyon", "propus", "regulus", "rigel", "rotanev",
    "sabik", "sadr", "saiph", "scheat", "schedar", "secunda", "sham", "sheliak",
    "sirius", "spica", "sualocin", "suhail", "tarazed", "tejat", "thuban",
    "unukalhai", "vega", "wezen", "yildun", "zaniah", "zaurak", "zubenelgenubi",
];

fn resolve_repository_from_local_path(folder_path: &str) -> Result<ResolvedRepositoryInput, String> {
    let selected_path = PathBuf::from(folder_path.trim());

    if folder_path.trim().is_empty() {
        return Err("No repository folder was selected.".to_string());
    }

    if !selected_path.exists() {
        return Err(format!(
            "Selected path does not exist: {}",
            selected_path.display()
        ));
    }

    if !selected_path.is_dir() {
        return Err(format!(
            "Selected path is not a directory: {}",
            selected_path.display()
        ));
    }

    let selected_path_arg = selected_path.display().to_string();
    let inside_work_tree = run_git(
        [
            "-C",
            selected_path_arg.as_str(),
            "rev-parse",
            "--is-inside-work-tree",
        ],
        None,
    )
    .map_err(|error| format!("Selected directory is not a Git working tree: {error}"))?;

    if inside_work_tree.trim() != "true" {
        return Err(format!(
            "Selected directory is not a Git working tree: {}",
            selected_path.display()
        ));
    }

    let normalized_root_path = run_git(
        [
            "-C",
            selected_path_arg.as_str(),
            "rev-parse",
            "--show-toplevel",
        ],
        None,
    )
    .map_err(|error| format!("Failed to resolve Git repository root: {error}"))?;
    let normalized_root_path = normalized_root_path.trim().to_string();
    let normalized_root = Path::new(&normalized_root_path);
    let name = normalized_root
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToOwned::to_owned)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "Failed to derive repository name from {}",
                normalized_root.display()
            )
        })?;

    let remote = resolve_repository_remote(normalized_root)?;
    let remote_url = match remote.as_deref() {
        Some(remote_name) => Some(resolve_repository_remote_url(normalized_root, remote_name)?),
        None => None,
    };
    let default_branch =
        resolve_repository_default_branch(normalized_root, remote.as_deref()).ok_or_else(|| {
            format!(
                "Unable to resolve a default branch for repository {}",
                normalized_root.display()
            )
        })?;

    Ok(ResolvedRepositoryInput {
        name,
        normalized_root_path,
        remote,
        remote_url,
        default_branch,
    })
}

fn resolve_repository_remote(repo_root: &Path) -> Result<Option<String>, String> {
    let repo_root_arg = repo_root.display().to_string();
    let output = run_git(["-C", repo_root_arg.as_str(), "remote"], None)
        .map_err(|error| format!("Failed to read repository remotes: {error}"))?;
    let remotes = output
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    if remotes.iter().any(|remote| remote == "origin") {
        return Ok(Some("origin".to_string()));
    }

    if remotes.len() == 1 {
        return Ok(remotes.first().cloned());
    }

    Ok(None)
}

fn resolve_repository_remote_url(repo_root: &Path, remote: &str) -> Result<String, String> {
    let repo_root_arg = repo_root.display().to_string();
    run_git(
        ["-C", repo_root_arg.as_str(), "remote", "get-url", remote],
        None,
    )
    .map(|value| value.trim().to_string())
    .map_err(|error| format!("Failed to resolve remote URL for {remote}: {error}"))
}

fn resolve_repository_default_branch(repo_root: &Path, remote: Option<&str>) -> Option<String> {
    if let Some(remote) = remote {
        if let Ok(symbolic_ref) = resolve_default_branch_from_remote_head(repo_root, remote) {
            return Some(symbolic_ref);
        }
    }

    resolve_current_branch(repo_root)
}

fn resolve_default_branch_from_remote_head(repo_root: &Path, remote: &str) -> Result<String, String> {
    let repo_root_arg = repo_root.display().to_string();
    let output = run_git(
        [
            "-C",
            repo_root_arg.as_str(),
            "symbolic-ref",
            "--quiet",
            "--short",
            &format!("refs/remotes/{remote}/HEAD"),
        ],
        None,
    )
    .map_err(|error| format!("Failed to resolve remote HEAD for {remote}: {error}"))?;

    let prefix = format!("{remote}/");
    output
        .trim()
        .strip_prefix(prefix.as_str())
        .map(ToOwned::to_owned)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Remote HEAD for {remote} did not include a branch name"))
}

fn resolve_current_branch(repo_root: &Path) -> Option<String> {
    let repo_root_arg = repo_root.display().to_string();
    let branch = run_git(["-C", repo_root_arg.as_str(), "branch", "--show-current"], None).ok()?;
    let branch = branch.trim();

    if branch.is_empty() || branch == "HEAD" {
        None
    } else {
        Some(branch.to_string())
    }
}

fn load_fixture_repository_by_id_from_fixture(
    fixture_root: &Path,
    repo_id: &str,
) -> Result<Option<FixtureRepositoryRecord>, String> {
    let connection = open_fixture_connection_at(fixture_root, false)?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, name, default_branch, root_path, setup_script
            FROM repos
            WHERE id = ?1
            "#,
        )
        .map_err(|error| format!("Failed to prepare repository lookup for {repo_id}: {error}"))?;

    let mut rows = statement
        .query_map([repo_id], |row| {
            Ok(FixtureRepositoryRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                default_branch: row.get(2)?,
                root_path: row.get(3)?,
                setup_script: row.get(4)?,
            })
        })
        .map_err(|error| format!("Failed to query repository {repo_id}: {error}"))?;

    match rows.next() {
        Some(result) => result
            .map(Some)
            .map_err(|error| format!("Failed to deserialize repository {repo_id}: {error}")),
        None => Ok(None),
    }
}

fn load_fixture_repository_by_root_path_from_fixture(
    fixture_root: &Path,
    root_path: &str,
) -> Result<Option<FixtureRepositoryRecord>, String> {
    let connection = open_fixture_connection_at(fixture_root, false)?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, name, default_branch, root_path, setup_script
            FROM repos
            ORDER BY created_at ASC
            "#,
        )
        .map_err(|error| format!("Failed to prepare repository root lookup: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(FixtureRepositoryRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                default_branch: row.get(2)?,
                root_path: row.get(3)?,
                setup_script: row.get(4)?,
            })
        })
        .map_err(|error| format!("Failed to query repository rows for {root_path}: {error}"))?;

    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to deserialize repository for {root_path}: {error}"))?;
    let normalized_requested_root =
        normalize_filesystem_path(Path::new(root_path)).unwrap_or_else(|| root_path.to_string());

    for repository in rows {
        if repository.root_path == root_path {
            return Ok(Some(repository));
        }

        let normalized_repository_root = normalize_filesystem_path(Path::new(&repository.root_path))
            .unwrap_or_else(|| repository.root_path.clone());

        if normalized_repository_root == normalized_requested_root {
            return Ok(Some(repository));
        }
    }

    Ok(None)
}

fn normalize_filesystem_path(path: &Path) -> Option<String> {
    fs::canonicalize(path)
        .ok()
        .map(|canonicalized| canonicalized.display().to_string())
}

fn load_setting_value_at(fixture_root: &Path, key: &str) -> Result<Option<String>, String> {
    let connection = open_fixture_connection_at(fixture_root, false)?;
    let mut statement = connection
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|error| format!("Failed to prepare settings lookup for {key}: {error}"))?;
    let mut rows = statement
        .query_map([key], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Failed to query settings value for {key}: {error}"))?;

    match rows.next() {
        Some(result) => result
            .map(Some)
            .map_err(|error| format!("Failed to deserialize settings value for {key}: {error}")),
        None => Ok(None),
    }
}

fn upsert_setting_value_at(fixture_root: &Path, key: &str, value: &str) -> Result<(), String> {
    let connection = open_fixture_connection_at(fixture_root, true)?;
    connection
        .execute(
            r#"
            INSERT INTO settings (key, value, created_at, updated_at)
            VALUES (?1, ?2, datetime('now'), datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = datetime('now')
            "#,
            (key, value),
        )
        .map_err(|error| format!("Failed to store setting {key}: {error}"))?;

    Ok(())
}

fn insert_fixture_repository_at(
    fixture_root: &Path,
    repository: &ResolvedRepositoryInput,
) -> Result<String, String> {
    let connection = open_fixture_connection_at(fixture_root, true)?;
    let next_display_order: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(display_order), 0) + 1 FROM repos",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to resolve next repository display order: {error}"))?;
    let repo_id = uuid::Uuid::new_v4().to_string();

    connection
        .execute(
            r#"
            INSERT INTO repos (
              id,
              name,
              root_path,
              remote,
              remote_url,
              default_branch,
              display_order,
              hidden,
              setup_script,
              run_script,
              archive_script,
              conductor_config,
              icon,
              created_at,
              updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, NULL, NULL, NULL, NULL, datetime('now'), datetime('now'))
            "#,
            (
                repo_id.as_str(),
                repository.name.as_str(),
                repository.normalized_root_path.as_str(),
                repository.remote.as_deref(),
                repository.remote_url.as_deref(),
                repository.default_branch.as_str(),
                next_display_order,
            ),
        )
        .map_err(|error| format!("Failed to insert repository {}: {error}", repository.name))?;

    Ok(repo_id)
}

fn delete_fixture_repository_at(fixture_root: &Path, repo_id: &str) -> Result<(), String> {
    let connection = open_fixture_connection_at(fixture_root, true)?;
    let deleted_rows = connection
        .execute("DELETE FROM repos WHERE id = ?1", [repo_id])
        .map_err(|error| format!("Failed to delete repository {repo_id}: {error}"))?;

    if deleted_rows != 1 {
        return Err(format!(
            "Repository delete affected {deleted_rows} rows for {repo_id}"
        ));
    }

    Ok(())
}

fn select_visible_workspace_for_repo_at(
    fixture_root: &Path,
    repo_id: &str,
) -> Result<Option<(String, String)>, String> {
    let mut visible_records = load_workspace_records_at(fixture_root)?
        .into_iter()
        .filter(|record| record.repo_id == repo_id && record.state != "archived")
        .collect::<Vec<_>>();

    visible_records.sort_by(|left, right| {
        sidebar_sort_rank(left)
            .cmp(&sidebar_sort_rank(right))
            .then_with(|| display_title(left).to_lowercase().cmp(&display_title(right).to_lowercase()))
    });

    Ok(visible_records
        .into_iter()
        .next()
        .map(|record| (record.id, record.state)))
}

fn sidebar_sort_rank(record: &WorkspaceRecord) -> usize {
    match group_id_from_status(&record.manual_status, &record.derived_status) {
        "done" => 0,
        "review" => 1,
        "progress" => 2,
        "backlog" => 3,
        "canceled" => 4,
        _ => 5,
    }
}

fn load_branch_prefix_settings_at(fixture_root: &Path) -> Result<BranchPrefixSettings, String> {
    let connection = open_fixture_connection_at(fixture_root, false)?;
    let mut statement = connection
        .prepare(
            "SELECT key, value FROM settings WHERE key IN ('branch_prefix_type', 'branch_prefix_custom')",
        )
        .map_err(|error| format!("Failed to prepare branch settings query: {error}"))?;

    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("Failed to query branch settings: {error}"))?;

    let mut settings = BranchPrefixSettings {
        branch_prefix_type: None,
        branch_prefix_custom: None,
    };

    for row in rows {
        let (key, value) = row.map_err(|error| format!("Failed to read branch settings row: {error}"))?;
        match key.as_str() {
            "branch_prefix_type" => settings.branch_prefix_type = Some(value),
            "branch_prefix_custom" => settings.branch_prefix_custom = Some(value),
            _ => {}
        }
    }

    Ok(settings)
}

fn branch_name_for_directory(
    directory_name: &str,
    settings: &BranchPrefixSettings,
) -> String {
    let prefix = match settings
        .branch_prefix_type
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("custom") => settings
            .branch_prefix_custom
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(""),
        _ => "",
    };

    format!("{prefix}{directory_name}")
}

fn allocate_directory_name_for_repo(
    fixture_root: &Path,
    repo_id: &str,
) -> Result<String, String> {
    let connection = open_fixture_connection_at(fixture_root, false)?;
    let mut statement = connection
        .prepare(
            "SELECT directory_name FROM workspaces WHERE repository_id = ?1 AND directory_name IS NOT NULL",
        )
        .map_err(|error| format!("Failed to prepare workspace name query: {error}"))?;

    let names = statement
        .query_map([repo_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Failed to query existing workspace names: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read existing workspace names: {error}"))?;

    let used = names
        .into_iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<HashSet<_>>();

    for star_name in STAR_PROPER_NAMES {
        if !used.contains(*star_name) {
            return Ok((*star_name).to_string());
        }
    }

    for version in 2..=999 {
        for star_name in STAR_PROPER_NAMES {
            let candidate = format!("{star_name}-v{version}");
            if !used.contains(candidate.as_str()) {
                return Ok(candidate);
            }
        }
    }

    Err("Unable to allocate a workspace name from the vendored star list".to_string())
}

fn current_fixture_timestamp(fixture_root: &Path) -> Result<String, String> {
    let connection = open_fixture_connection_at(fixture_root, false)?;
    connection
        .query_row("SELECT datetime('now')", [], |row| row.get(0))
        .map_err(|error| format!("Failed to resolve fixture timestamp: {error}"))
}

#[allow(clippy::too_many_arguments)]
fn insert_initializing_workspace_and_session(
    fixture_root: &Path,
    repository: &FixtureRepositoryRecord,
    workspace_id: &str,
    session_id: &str,
    directory_name: &str,
    branch: &str,
    default_branch: &str,
    timestamp: &str,
    initialization_log_path: &Path,
    setup_log_path: &Path,
) -> Result<(), String> {
    let mut connection = open_fixture_connection_at(fixture_root, true)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start create-workspace transaction: {error}"))?;

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
        .map_err(|error| format!("Failed to insert initializing workspace: {error}"))?;

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
        .map_err(|error| format!("Failed to insert initial session: {error}"))?;

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit create-workspace transaction: {error}"))
}

fn update_workspace_initialization_metadata(
    fixture_root: &Path,
    workspace_id: &str,
    initialization_files_copied: i64,
    timestamp: &str,
) -> Result<(), String> {
    let connection = open_fixture_connection_at(fixture_root, true)?;
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
        .map_err(|error| format!("Failed to update workspace initialization metadata: {error}"))?;

    if updated_rows != 1 {
        return Err(format!(
            "Workspace initialization metadata update affected {updated_rows} rows for {workspace_id}"
        ));
    }

    Ok(())
}

fn update_workspace_state(
    fixture_root: &Path,
    workspace_id: &str,
    state: &str,
    timestamp: &str,
) -> Result<(), String> {
    let connection = open_fixture_connection_at(fixture_root, true)?;
    let updated_rows = connection
        .execute(
            "UPDATE workspaces SET state = ?2, updated_at = ?3 WHERE id = ?1",
            (workspace_id, state, timestamp),
        )
        .map_err(|error| format!("Failed to update workspace state to {state}: {error}"))?;

    if updated_rows != 1 {
        return Err(format!(
            "Workspace state update affected {updated_rows} rows for {workspace_id}"
        ));
    }

    Ok(())
}

fn delete_workspace_and_session_rows(
    fixture_root: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let mut connection = open_fixture_connection_at(fixture_root, true)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start create cleanup transaction: {error}"))?;

    transaction
        .execute("DELETE FROM attachments WHERE session_id = ?1", [session_id])
        .map_err(|error| format!("Failed to delete create-flow attachments: {error}"))?;
    transaction
        .execute("DELETE FROM session_messages WHERE session_id = ?1", [session_id])
        .map_err(|error| format!("Failed to delete create-flow session messages: {error}"))?;
    transaction
        .execute("DELETE FROM sessions WHERE id = ?1", [session_id])
        .map_err(|error| format!("Failed to delete create-flow session: {error}"))?;
    transaction
        .execute("DELETE FROM workspaces WHERE id = ?1", [workspace_id])
        .map_err(|error| format!("Failed to delete create-flow workspace: {error}"))?;

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit create cleanup transaction: {error}"))
}

fn fixture_workspace_logs_dir(fixture_root: &Path, workspace_id: &str) -> PathBuf {
    fixture_root
        .join("helmor/logs/workspaces")
        .join(workspace_id)
}

fn remote_tracking_branch_ref(default_branch: &str) -> String {
    format!("refs/remotes/origin/{default_branch}")
}

fn verify_commitish_exists_in_mirror(
    mirror_dir: &Path,
    commitish: &str,
    error_message: &str,
) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let verify_ref = format!("{commitish}^{{commit}}");
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "rev-parse",
            "--verify",
            verify_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .map_err(|_| error_message.to_string())
}

fn create_fixture_worktree_from_start_point(
    mirror_dir: &Path,
    workspace_dir: &Path,
    branch: &str,
    start_point: &str,
) -> Result<String, String> {
    let mirror_dir = mirror_dir.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "worktree",
            "add",
            "-b",
            branch,
            workspace_dir_arg.as_str(),
            start_point,
        ],
        None,
    )
    .map_err(|error| {
        format!(
            "Failed to create fixture worktree at {} for branch {} from {}: {error}",
            workspace_dir.display(),
            branch,
            start_point
        )
    })
}

fn refresh_fixture_repo_setup_root(
    mirror_dir: &Path,
    setup_root_dir: &Path,
    start_point: &str,
) -> Result<(), String> {
    if setup_root_dir.exists() {
        let _ = remove_fixture_worktree(mirror_dir, setup_root_dir);
        let _ = fs::remove_dir_all(setup_root_dir);
    }

    fs::create_dir_all(
        setup_root_dir
            .parent()
            .ok_or_else(|| format!("Setup root path has no parent: {}", setup_root_dir.display()))?,
    )
    .map_err(|error| {
        format!(
            "Failed to create setup root parent for {}: {error}",
            setup_root_dir.display()
        )
    })?;

    let mirror_dir = mirror_dir.display().to_string();
    let setup_root_dir_arg = setup_root_dir.display().to_string();
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "worktree",
            "add",
            "--detach",
            setup_root_dir_arg.as_str(),
            start_point,
        ],
        None,
    )
    .map(|_| ())
    .map_err(|error| {
        format!(
            "Failed to materialize setup root at {} from {}: {error}",
            setup_root_dir.display(),
            start_point
        )
    })
}

fn remove_fixture_branch(mirror_dir: &Path, branch: &str) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let branch_ref = format!("refs/heads/{branch}");
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "update-ref",
            "-d",
            branch_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .or_else(|error| {
        if error.contains("cannot lock ref") || error.contains("does not exist") {
            Ok(())
        } else {
            Err(format!("Failed to remove fixture branch {branch}: {error}"))
        }
    })
}

fn create_workspace_context_scaffold(workspace_dir: &Path) -> Result<(), String> {
    let context_dir = workspace_dir.join(".context");
    let attachments_dir = context_dir.join("attachments");
    fs::create_dir_all(&attachments_dir).map_err(|error| {
        format!(
            "Failed to create workspace context scaffold under {}: {error}",
            context_dir.display()
        )
    })?;

    write_file_if_missing(&context_dir.join("notes.md"), "# Notes\n")?;
    write_file_if_missing(&context_dir.join("todos.md"), "# Todos\n")?;

    Ok(())
}

fn write_file_if_missing(path: &Path, contents: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    fs::write(path, contents)
        .map_err(|error| format!("Failed to write scaffold file {}: {error}", path.display()))
}

fn tracked_file_count(workspace_dir: &Path) -> Result<i64, String> {
    let workspace_dir = workspace_dir.display().to_string();
    let output = run_git(["-C", workspace_dir.as_str(), "ls-files"], None).map_err(|error| {
        format!(
            "Failed to count tracked files for workspace {}: {error}",
            workspace_dir
        )
    })?;

    Ok(output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count() as i64)
}

fn resolve_setup_hook(
    repository: &FixtureRepositoryRecord,
    workspace_dir: &Path,
    mirror_dir: &Path,
) -> Result<Option<PathBuf>, String> {
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
        return Err(format!(
            "Configured setup script is missing at {}",
            resolved_path.display()
        ));
    }

    Ok(Some(resolved_path))
}

fn load_setup_script_from_conductor_json(workspace_dir: &Path) -> Result<Option<String>, String> {
    let conductor_json_path = workspace_dir.join("conductor.json");
    if !conductor_json_path.is_file() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&conductor_json_path).map_err(|error| {
        format!(
            "Failed to read conductor.json at {}: {error}",
            conductor_json_path.display()
        )
    })?;
    let json: Value = serde_json::from_str(&contents).map_err(|error| {
        format!(
            "Failed to parse conductor.json at {}: {error}",
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
        .replace("$CONDUCTOR_WORKSPACE_PATH", &workspace_dir.display().to_string());
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
) -> Result<(), String> {
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
            format!("Failed to execute setup script {}: {error}", setup_script.display())
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
        Err(format!("Setup script failed for {}: {detail}", setup_script.display()))
    }
}

fn command_for_script(script_path: &Path) -> Result<(String, Vec<String>), String> {
    let contents = fs::read_to_string(script_path).map_err(|error| {
        format!(
            "Failed to inspect setup script {}: {error}",
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

fn write_log_file(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Failed to create log directory {}: {error}", parent.display())
        })?;
    }

    fs::write(path, contents)
        .map_err(|error| format!("Failed to write log file {}: {error}", path.display()))
}

fn cleanup_failed_created_workspace(
    fixture_root: &Path,
    workspace_id: &str,
    session_id: &str,
    mirror_dir: &Path,
    workspace_dir: &Path,
    branch: &str,
    created_worktree: bool,
) {
    if created_worktree && workspace_dir.exists() {
        let _ = remove_fixture_worktree(mirror_dir, workspace_dir);
        let _ = fs::remove_dir_all(workspace_dir);
    }

    let _ = remove_fixture_branch(mirror_dir, branch);
    let _ = delete_workspace_and_session_rows(fixture_root, workspace_id, session_id);
}

fn load_workspace_records() -> Result<Vec<WorkspaceRecord>, String> {
    let fixture_root = resolve_fixture_root()?;
    load_workspace_records_at(&fixture_root)
}

fn load_workspace_records_at(fixture_root: &Path) -> Result<Vec<WorkspaceRecord>, String> {
    let connection = open_fixture_connection_at(fixture_root, false)?;
    let mut statement = connection
        .prepare(WORKSPACE_RECORD_SQL)
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([], workspace_record_from_row)
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn load_workspace_record_by_id(workspace_id: &str) -> Result<Option<WorkspaceRecord>, String> {
    let fixture_root = resolve_fixture_root()?;
    load_workspace_record_by_id_from_fixture(&fixture_root, workspace_id)
}

fn load_workspace_record_by_id_from_fixture(
    fixture_root: &Path,
    workspace_id: &str,
) -> Result<Option<WorkspaceRecord>, String> {
    let connection = open_fixture_connection_at(fixture_root, false)?;
    let mut statement = connection
        .prepare(format!("{WORKSPACE_RECORD_SQL} WHERE w.id = ?1").as_str())
        .map_err(|error| error.to_string())?;

    let mut rows = statement
        .query_map([workspace_id], workspace_record_from_row)
        .map_err(|error| error.to_string())?;

    match rows.next() {
        Some(result) => result.map(Some).map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

fn mark_fixture_session_read_at(fixture_root: &Path, session_id: &str) -> Result<(), String> {
    let mut connection = open_fixture_connection_at(fixture_root, true)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start mark-read transaction: {error}"))?;

    mark_session_read_in_transaction(&transaction, session_id)?;

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit session read transaction: {error}"))
}

fn mark_fixture_workspace_read_at(fixture_root: &Path, workspace_id: &str) -> Result<(), String> {
    let mut connection = open_fixture_connection_at(fixture_root, true)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start workspace-read transaction: {error}"))?;

    mark_workspace_read_in_transaction(&transaction, workspace_id)?;

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit workspace read transaction: {error}"))
}

fn mark_fixture_workspace_unread_at(fixture_root: &Path, workspace_id: &str) -> Result<(), String> {
    let mut connection = open_fixture_connection_at(fixture_root, true)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start workspace-unread transaction: {error}"))?;

    mark_workspace_unread_in_transaction(&transaction, workspace_id)?;

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit workspace unread transaction: {error}"))
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
        .map_err(|error| format!("Failed to resolve workspace for session {session_id}: {error}"))?;

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
        .map_err(|error| format!("Failed to clear unread sessions for workspace {workspace_id}: {error}"))?;

    let updated_rows = transaction
        .execute(
            "UPDATE workspaces SET unread = 0 WHERE id = ?1",
            [workspace_id],
        )
        .map_err(|error| format!("Failed to mark workspace {workspace_id} as read: {error}"))?;

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
        .map_err(|error| format!("Failed to mark workspace {workspace_id} as unread: {error}"))?;

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
        .map_err(|error| format!("Failed to sync unread state for workspace {workspace_id}: {error}"))?;

    if updated_rows != 1 {
        return Err(format!(
            "Unread sync affected {updated_rows} rows for workspace {workspace_id}"
        ));
    }

    Ok(())
}

fn archive_fixture_workspace_at(
    fixture_root: &Path,
    workspace_id: &str,
) -> Result<ArchiveWorkspaceResponse, String> {
    let record = load_workspace_record_by_id_from_fixture(fixture_root, workspace_id)?
        .ok_or_else(|| format!("Workspace not found: {workspace_id}"))?;

    if record.state != "ready" {
        return Err(format!("Workspace is not ready: {workspace_id}"));
    }

    let repo_root = non_empty(&record.root_path)
        .map(PathBuf::from)
        .ok_or_else(|| format!("Workspace {workspace_id} is missing repo root_path"))?;
    let branch = non_empty(&record.branch)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Workspace {workspace_id} is missing branch"))?;

    let workspace_dir = fixture_workspace_dir(fixture_root, &record.repo_name, &record.directory_name);
    if !workspace_dir.is_dir() {
        return Err(format!(
            "Archive source workspace is missing from fixture at {}",
            workspace_dir.display()
        ));
    }

    let archived_context_dir =
        fixture_archived_context_dir(fixture_root, &record.repo_name, &record.directory_name);
    if archived_context_dir.exists() {
        return Err(format!(
            "Archived context target already exists at {}",
            archived_context_dir.display()
        ));
    }

    fs::create_dir_all(
        archived_context_dir.parent().ok_or_else(|| {
            format!(
                "Archived context target has no parent: {}",
                archived_context_dir.display()
            )
        })?,
    )
    .map_err(|error| {
        format!(
            "Failed to create archived context parent directory for {}: {error}",
            archived_context_dir.display()
        )
    })?;

    let mirror_dir = fixture_repo_mirror_dir(fixture_root, &record.repo_name);
    ensure_fixture_repo_mirror(&repo_root, &mirror_dir)?;

    let archive_commit = current_workspace_head_commit(&workspace_dir)?;
    verify_commit_exists_in_mirror(&mirror_dir, &archive_commit)?;

    let workspace_context_dir = workspace_dir.join(".context");
    let staged_archive_dir = staged_archive_context_dir(&archived_context_dir);
    create_staged_archive_context(&workspace_context_dir, &staged_archive_dir)?;

    if let Err(error) = remove_fixture_worktree(&mirror_dir, &workspace_dir) {
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
        return Err(format!(
            "Failed to move archived context into {}: {error}",
            archived_context_dir.display()
        ));
    }

    if let Err(error) =
        update_archived_workspace_state(fixture_root, workspace_id, &archive_commit)
    {
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

fn restore_fixture_workspace_at(
    fixture_root: &Path,
    workspace_id: &str,
) -> Result<RestoreWorkspaceResponse, String> {
    let record = load_workspace_record_by_id_from_fixture(fixture_root, workspace_id)?
        .ok_or_else(|| format!("Workspace not found: {workspace_id}"))?;

    if record.state != "archived" {
        return Err(format!("Workspace is not archived: {workspace_id}"));
    }

    let repo_root = non_empty(&record.root_path)
        .map(PathBuf::from)
        .ok_or_else(|| format!("Workspace {workspace_id} is missing repo root_path"))?;
    let branch = non_empty(&record.branch)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Workspace {workspace_id} is missing branch"))?;
    let archive_commit = non_empty(&record.archive_commit)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Workspace {workspace_id} is missing archive_commit"))?;

    let workspace_dir = fixture_workspace_dir(fixture_root, &record.repo_name, &record.directory_name);
    if workspace_dir.exists() {
        return Err(format!(
            "Restore target already exists at {}",
            workspace_dir.display()
        ));
    }

    let archived_context_dir =
        fixture_archived_context_dir(fixture_root, &record.repo_name, &record.directory_name);
    if !archived_context_dir.is_dir() {
        return Err(format!(
            "Archived context directory is missing at {}",
            archived_context_dir.display()
        ));
    }

    fs::create_dir_all(
        workspace_dir
            .parent()
            .ok_or_else(|| format!("Workspace restore target has no parent: {}", workspace_dir.display()))?,
    )
    .map_err(|error| {
        format!(
            "Failed to create workspace parent directory for {}: {error}",
            workspace_dir.display()
        )
    })?;

    let mirror_dir = fixture_repo_mirror_dir(fixture_root, &record.repo_name);
    ensure_fixture_repo_mirror(&repo_root, &mirror_dir)?;
    verify_branch_exists_in_mirror(&mirror_dir, &branch)?;
    verify_commit_exists_in_mirror(&mirror_dir, &archive_commit)?;
    point_branch_to_archive_commit(&mirror_dir, &branch, &archive_commit)?;
    create_fixture_worktree(&mirror_dir, &workspace_dir, &branch)?;

    let staged_archive_dir = staged_archive_context_dir(&archived_context_dir);
    fs::rename(&archived_context_dir, &staged_archive_dir).map_err(|error| {
        cleanup_failed_restore(&mirror_dir, &workspace_dir, None, &staged_archive_dir, &archived_context_dir);
        format!(
            "Failed to stage archived context {}: {error}",
            archived_context_dir.display()
        )
    })?;

    let workspace_context_dir = workspace_dir.join(".context");
    if let Err(error) = copy_dir_all(&staged_archive_dir, &workspace_context_dir) {
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
        fixture_root,
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
            "[restore_fixture_workspace] Failed to delete staged archived context {}: {error}",
            staged_archive_dir.display()
        );
    }

    Ok(RestoreWorkspaceResponse {
        restored_workspace_id: workspace_id.to_string(),
        restored_state: "ready".to_string(),
        selected_workspace_id: workspace_id.to_string(),
    })
}

fn update_restored_workspace_state(
    fixture_root: &Path,
    workspace_id: &str,
    archived_context_dir: &Path,
    workspace_context_dir: &Path,
) -> Result<(), String> {
    let mut connection = open_fixture_connection_at(fixture_root, true)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start restore transaction: {error}"))?;

    let old_prefix = attachment_prefix(&archived_context_dir.join("attachments"));
    let new_prefix = attachment_prefix(&workspace_context_dir.join("attachments"));
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
        .map_err(|error| format!("Failed to update workspace restore state: {error}"))?;

    if updated_rows != 1 {
        return Err(format!(
            "Restore state update affected {updated_rows} rows for workspace {workspace_id}"
        ));
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
            (&old_prefix, &new_prefix, workspace_id, format!("{old_prefix}%")),
        )
        .map_err(|error| format!("Failed to update restored attachment paths: {error}"))?;

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit restore transaction: {error}"))
}

fn update_archived_workspace_state(
    fixture_root: &Path,
    workspace_id: &str,
    archive_commit: &str,
) -> Result<(), String> {
    let mut connection = open_fixture_connection_at(fixture_root, true)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start archive transaction: {error}"))?;

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
        .map_err(|error| format!("Failed to update workspace archive state: {error}"))?;

    if updated_rows != 1 {
        return Err(format!(
            "Archive state update affected {updated_rows} rows for workspace {workspace_id}"
        ));
    }

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit archive transaction: {error}"))
}

fn ensure_fixture_repo_mirror(source_repo_root: &Path, mirror_dir: &Path) -> Result<(), String> {
    ensure_git_repository(source_repo_root)?;
    fs::create_dir_all(
        mirror_dir
            .parent()
            .ok_or_else(|| format!("Mirror path has no parent: {}", mirror_dir.display()))?,
    )
    .map_err(|error| {
        format!(
            "Failed to create fixture repo mirror parent for {}: {error}",
            mirror_dir.display()
        )
    })?;

    if mirror_dir.exists() {
        let mirror_dir = mirror_dir.display().to_string();
        run_git(
            ["--git-dir", mirror_dir.as_str(), "rev-parse", "--git-dir"],
            None,
        )?;
    } else {
        let source_repo_root = source_repo_root.display().to_string();
        let mirror_dir = mirror_dir.display().to_string();
        run_git(
            [
                "clone",
                "--mirror",
                "--no-local",
                source_repo_root.as_str(),
                mirror_dir.as_str(),
            ],
            None,
        )?;
    }

    let source_repo_root = source_repo_root.display().to_string();
    let mirror_dir = mirror_dir.display().to_string();
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "fetch",
            "--prune",
            source_repo_root.as_str(),
            "+refs/heads/*:refs/remotes/origin/*",
        ],
        None,
    )?;

    Ok(())
}

fn ensure_git_repository(repo_root: &Path) -> Result<(), String> {
    let repo_root = repo_root.display().to_string();
    run_git(
        ["-C", repo_root.as_str(), "rev-parse", "--show-toplevel"],
        None,
    )
    .map(|_| ())
    .map_err(|error| format!("Fixture restore repo source is invalid: {error}"))
}

fn verify_branch_exists_in_mirror(mirror_dir: &Path, branch: &str) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let branch_ref = format!("refs/remotes/origin/{branch}");
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "rev-parse",
            "--verify",
            branch_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .map_err(|_| format!("Archived workspace branch no longer exists in source repo: {branch}"))
}

fn verify_commit_exists_in_mirror(mirror_dir: &Path, archive_commit: &str) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let commit_ref = format!("{archive_commit}^{{commit}}");
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "rev-parse",
            "--verify",
            commit_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .map_err(|_| format!("Archived workspace commit is missing in source repo: {archive_commit}"))
}

fn point_branch_to_archive_commit(
    mirror_dir: &Path,
    branch: &str,
    archive_commit: &str,
) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let branch_ref = format!("refs/heads/{branch}");
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "update-ref",
            branch_ref.as_str(),
            archive_commit,
        ],
        None,
    )
    .map(|_| ())
    .map_err(|error| format!("Failed to point fixture branch {branch} at {archive_commit}: {error}"))
}

fn current_workspace_head_commit(workspace_dir: &Path) -> Result<String, String> {
    let workspace_dir = workspace_dir.display().to_string();
    let commit = run_git(["-C", workspace_dir.as_str(), "rev-parse", "HEAD"], None)
        .map_err(|error| {
            format!(
                "Failed to resolve archive commit from fixture workspace {}: {error}",
                workspace_dir
            )
        })?;

    if commit.trim().is_empty() {
        return Err(format!(
            "Resolved empty archive commit for fixture workspace {}",
            workspace_dir
        ));
    }

    Ok(commit)
}

fn create_fixture_worktree(
    mirror_dir: &Path,
    workspace_dir: &Path,
    branch: &str,
) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "worktree",
            "add",
            workspace_dir_arg.as_str(),
            branch,
        ],
        None,
    )
    .map(|_| ())
    .map_err(|error| {
        format!(
            "Failed to create fixture worktree at {} for branch {}: {error}",
            workspace_dir.display(),
            branch
        )
    })
}

fn remove_fixture_worktree(mirror_dir: &Path, workspace_dir: &Path) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "worktree",
            "remove",
            "--force",
            workspace_dir_arg.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .map_err(|error| {
        format!(
            "Failed to remove fixture worktree at {}: {error}",
            workspace_dir.display()
        )
    })
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

    let mirror_dir = mirror_dir.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    let _ = run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
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

    let _ = point_branch_to_archive_commit(mirror_dir, branch, archive_commit);

    if !workspace_dir.exists() {
        let _ = create_fixture_worktree(mirror_dir, workspace_dir, branch);
    }

    if staged_archive_dir.exists() {
        let _ = fs::remove_dir_all(workspace_context_dir);
        let _ = copy_dir_contents(staged_archive_dir, workspace_context_dir);
        let _ = fs::remove_dir_all(staged_archive_dir);
    }
}

fn fixture_archived_context_dir(
    fixture_root: &Path,
    repo_name: &str,
    directory_name: &str,
) -> PathBuf {
    fixture_root
        .join("helmor/archived-contexts")
        .join(repo_name)
        .join(directory_name)
}

fn fixture_workspace_dir(fixture_root: &Path, repo_name: &str, directory_name: &str) -> PathBuf {
    fixture_root
        .join("helmor/workspaces")
        .join(repo_name)
        .join(directory_name)
}

fn fixture_repo_mirror_dir(fixture_root: &Path, repo_name: &str) -> PathBuf {
    fixture_root.join("helmor/repos").join(repo_name)
}

fn fixture_repo_setup_root_dir(fixture_root: &Path, repo_name: &str) -> PathBuf {
    fixture_root.join("helmor/repo-roots").join(repo_name)
}

fn staged_archive_context_dir(archived_context_dir: &Path) -> PathBuf {
    archived_context_dir.with_file_name(format!(
        ".{}-restore-staged-{}",
        archived_context_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("workspace"),
        uuid::Uuid::new_v4()
    ))
}

fn attachment_prefix(path: &Path) -> String {
    let mut prefix = path.display().to_string();
    if !prefix.ends_with('/') {
        prefix.push('/');
    }
    prefix
}

fn create_staged_archive_context(
    workspace_context_dir: &Path,
    staged_archive_dir: &Path,
) -> Result<(), String> {
    if staged_archive_dir.exists() {
        return Err(format!(
            "Archive staging directory already exists at {}",
            staged_archive_dir.display()
        ));
    }

    fs::create_dir_all(staged_archive_dir).map_err(|error| {
        format!(
            "Failed to create archive staging directory {}: {error}",
            staged_archive_dir.display()
        )
    })?;

    if workspace_context_dir.is_dir() {
        if let Err(error) = copy_dir_contents(workspace_context_dir, staged_archive_dir) {
            let _ = fs::remove_dir_all(staged_archive_dir);
            return Err(error);
        }
    } else if workspace_context_dir.exists() {
        let _ = fs::remove_dir_all(staged_archive_dir);
        return Err(format!(
            "Fixture workspace context path is not a directory: {}",
            workspace_context_dir.display()
        ));
    }

    Ok(())
}

fn copy_dir_contents(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        fs::create_dir_all(destination).map_err(|error| {
            format!(
                "Failed to create directory {}: {error}",
                destination.display()
            )
        })?;
        return Ok(());
    }

    if !source.is_dir() {
        return Err(format!("Expected directory at {}", source.display()));
    }

    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Failed to create directory {}: {error}",
            destination.display()
        )
    })?;

    let entries = fs::read_dir(source)
        .map_err(|error| format!("Failed to read directory {}: {error}", source.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let entry_source = entry.path();
        let entry_destination = destination.join(entry.file_name());
        copy_dir_all(&entry_source, &entry_destination)?;
    }

    Ok(())
}

fn copy_dir_all(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Failed to read {}: {error}", source.display()))?;

    if metadata.file_type().is_symlink() {
        return copy_symlink(source, destination);
    }

    if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create parent directory for {}: {error}",
                    destination.display()
                )
            })?;
        }
        fs::copy(source, destination).map_err(|error| {
            format!(
                "Failed to copy {} to {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
        return Ok(());
    }

    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Failed to create directory {}: {error}",
            destination.display()
        )
    })?;

    let entries = fs::read_dir(source)
        .map_err(|error| format!("Failed to read directory {}: {error}", source.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let entry_source = entry.path();
        let entry_destination = destination.join(entry.file_name());
        copy_dir_all(&entry_source, &entry_destination)?;
    }

    Ok(())
}

#[cfg(unix)]
fn copy_symlink(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create parent directory for symlink {}: {error}",
                destination.display()
            )
        })?;
    }

    let link_target = fs::read_link(source)
        .map_err(|error| format!("Failed to read symlink {}: {error}", source.display()))?;
    symlink(&link_target, destination).map_err(|error| {
        format!(
            "Failed to copy symlink {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

#[cfg(not(unix))]
fn copy_symlink(source: &Path, destination: &Path) -> Result<(), String> {
    let target = fs::read_link(source)
        .map_err(|error| format!("Failed to read symlink {}: {error}", source.display()))?;
    let resolved = source
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(target);
    copy_dir_all(&resolved, destination)
}

fn run_git<I, S>(args: I, current_dir: Option<&Path>) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args = args
        .into_iter()
        .map(|value| value.as_ref().to_owned())
        .collect::<Vec<_>>();
    let mut command = Command::new("git");
    command.args(&args);

    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }

    let output = command.output().map_err(|error| {
        format!(
            "Failed to run git {}: {error}",
            args.iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(" ")
        )
    })?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("git exited with status {}", output.status)
    };

    Err(detail)
}

fn load_workspace_sessions_by_workspace_id(
    workspace_id: &str,
) -> Result<Vec<WorkspaceSessionSummary>, String> {
    let connection = open_fixture_connection()?;
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

fn load_session_messages_by_session_id(
    session_id: &str,
) -> Result<Vec<SessionMessageRecord>, String> {
    let connection = open_fixture_connection()?;
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

fn load_session_attachments_by_session_id(
    session_id: &str,
) -> Result<Vec<SessionAttachmentRecord>, String> {
    let connection = open_fixture_connection()?;
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
    })
}

const WORKSPACE_RECORD_SQL: &str = r#"
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

fn open_fixture_connection() -> Result<Connection, String> {
    let fixture_root = resolve_fixture_root()?;
    open_fixture_connection_at(&fixture_root, false)
}

fn open_fixture_connection_at(fixture_root: &Path, writable: bool) -> Result<Connection, String> {
    let db_path = resolve_fixture_db_path_at(fixture_root);
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
    };

    let connection = Connection::open_with_flags(db_path, flags).map_err(|error| error.to_string())?;

    if writable {
        connection
            .busy_timeout(std::time::Duration::from_secs(3))
            .map_err(|error| error.to_string())?;
    }

    Ok(connection)
}

pub(crate) fn resolve_fixture_db_path() -> Result<PathBuf, String> {
    Ok(resolve_fixture_db_path_at(&resolve_fixture_root()?))
}

fn resolve_fixture_db_path_at(fixture_root: &Path) -> PathBuf {
    fixture_root.join("com.conductor.app/conductor.db")
}

pub(crate) fn resolve_fixture_root() -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("HELMOR_CONDUCTOR_FIXTURE_ROOT") {
        let path = PathBuf::from(root);
        validate_fixture_root(&path)?;
        return Ok(path);
    }

    let base_dir = project_root().join(FIXTURE_BASE_DIR);
    let mut candidates = fs::read_dir(&base_dir)
        .map_err(|error| {
            format!(
                "Failed to read fixture base directory {}: {error}",
                base_dir.display()
            )
        })?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_dir())
                .unwrap_or(false)
        })
        .map(|entry| {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);

            (modified, entry.path())
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| right.0.cmp(&left.0));

    let fixture_root = candidates
        .into_iter()
        .map(|(_, path)| path)
        .find(|path| validate_fixture_root(path).is_ok())
        .ok_or_else(|| {
            format!(
                "No valid Conductor fixture found under {}",
                base_dir.display()
            )
        })?;

    Ok(fixture_root)
}

fn validate_fixture_root(path: &Path) -> Result<(), String> {
    let db_path = path.join("com.conductor.app/conductor.db");
    let archive_root = path.join("helmor/archived-contexts");

    if !db_path.is_file() {
        return Err(format!("Missing fixture database at {}", db_path.display()));
    }

    if !archive_root.is_dir() {
        return Err(format!(
            "Missing archived contexts directory at {}",
            archive_root.display()
        ));
    }

    Ok(())
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have a repo root parent")
        .to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::Mutex;

    static TEST_FIXTURE_LOCK: Mutex<()> = Mutex::new(());

    struct RestoreTestHarness {
        root: PathBuf,
        fixture_root: PathBuf,
        source_repo_root: PathBuf,
        workspace_id: String,
        session_id: String,
        repo_name: String,
        directory_name: String,
        branch: String,
    }

    impl RestoreTestHarness {
        fn new(include_updated_at: bool) -> Self {
            let root = std::env::temp_dir().join(format!("helmor-restore-test-{}", uuid::Uuid::new_v4()));
            let fixture_root = root.join("fixture");
            let source_repo_root = root.join("source-repo");

            fs::create_dir_all(&source_repo_root).unwrap();
            init_git_repo(&source_repo_root);

            let archive_commit = run_git(
                ["-C", source_repo_root.to_str().unwrap(), "rev-parse", "HEAD"],
                None,
            )
            .unwrap();

            run_git(
                ["-C", source_repo_root.to_str().unwrap(), "checkout", "main"],
                None,
            )
            .unwrap();

            let repo_name = "demo-repo".to_string();
            let directory_name = "archived-city".to_string();
            let workspace_id = "workspace-1".to_string();
            let session_id = "session-1".to_string();
            let branch = "feature/restore-target".to_string();

            fs::create_dir_all(fixture_root.join("com.conductor.app")).unwrap();
            fs::create_dir_all(
                fixture_root
                    .join("helmor/archived-contexts")
                    .join(&repo_name)
                    .join(&directory_name)
                    .join("attachments"),
            )
            .unwrap();
            fs::create_dir_all(fixture_root.join("helmor/workspaces").join(&repo_name)).unwrap();

            fs::write(
                fixture_root
                    .join("helmor/archived-contexts")
                    .join(&repo_name)
                    .join(&directory_name)
                    .join("notes.md"),
                "archived notes",
            )
            .unwrap();
            fs::write(
                fixture_root
                    .join("helmor/archived-contexts")
                    .join(&repo_name)
                    .join(&directory_name)
                    .join("attachments")
                    .join("evidence.txt"),
                "evidence",
            )
            .unwrap();

            create_fixture_db(
                &fixture_root.join("com.conductor.app/conductor.db"),
                &source_repo_root,
                &repo_name,
                &directory_name,
                &workspace_id,
                &session_id,
                &branch,
                &archive_commit,
                include_updated_at,
            );

            Self {
                root,
                fixture_root,
                source_repo_root,
                workspace_id,
                session_id,
                repo_name,
                directory_name,
                branch,
            }
        }

        fn archived_context_dir(&self) -> PathBuf {
            fixture_archived_context_dir(&self.fixture_root, &self.repo_name, &self.directory_name)
        }

        fn workspace_dir(&self) -> PathBuf {
            fixture_workspace_dir(&self.fixture_root, &self.repo_name, &self.directory_name)
        }

        fn mirror_dir(&self) -> PathBuf {
            fixture_repo_mirror_dir(&self.fixture_root, &self.repo_name)
        }

        fn attachment_path(&self) -> String {
            self.workspace_dir()
                .join(".context/attachments/evidence.txt")
                .display()
                .to_string()
        }
    }

    impl Drop for RestoreTestHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct ArchiveTestHarness {
        root: PathBuf,
        fixture_root: PathBuf,
        workspace_id: String,
        session_id: String,
        repo_name: String,
        directory_name: String,
        head_commit: String,
    }

    impl ArchiveTestHarness {
        fn new(include_updated_at: bool) -> Self {
            let root = std::env::temp_dir().join(format!("helmor-archive-test-{}", uuid::Uuid::new_v4()));
            let fixture_root = root.join("fixture");
            let source_repo_root = root.join("source-repo");

            fs::create_dir_all(&source_repo_root).unwrap();
            init_git_repo(&source_repo_root);

            let repo_name = "demo-repo".to_string();
            let directory_name = "ready-city".to_string();
            let workspace_id = "workspace-archive".to_string();
            let session_id = "session-archive".to_string();
            let branch = "feature/restore-target".to_string();
            let head_commit = run_git(
                ["-C", source_repo_root.to_str().unwrap(), "rev-parse", "HEAD"],
                None,
            )
            .unwrap();

            fs::create_dir_all(fixture_root.join("com.conductor.app")).unwrap();
            fs::create_dir_all(fixture_root.join("helmor/archived-contexts").join(&repo_name)).unwrap();
            fs::create_dir_all(fixture_root.join("helmor/workspaces").join(&repo_name)).unwrap();

            create_ready_fixture_db(
                &fixture_root.join("com.conductor.app/conductor.db"),
                &source_repo_root,
                &repo_name,
                &directory_name,
                &workspace_id,
                &session_id,
                &branch,
                include_updated_at,
            );

            let mirror_dir = fixture_repo_mirror_dir(&fixture_root, &repo_name);
            let workspace_dir = fixture_workspace_dir(&fixture_root, &repo_name, &directory_name);
            ensure_fixture_repo_mirror(&source_repo_root, &mirror_dir).unwrap();
            point_branch_to_archive_commit(&mirror_dir, &branch, &head_commit).unwrap();
            create_fixture_worktree(&mirror_dir, &workspace_dir, &branch).unwrap();
            fs::create_dir_all(workspace_dir.join(".context/attachments")).unwrap();
            fs::write(workspace_dir.join(".context/notes.md"), "ready notes").unwrap();
            fs::write(
                workspace_dir.join(".context/attachments/evidence.txt"),
                "ready evidence",
            )
            .unwrap();

            Self {
                root,
                fixture_root,
                workspace_id,
                session_id,
                repo_name,
                directory_name,
                head_commit,
            }
        }

        fn archived_context_dir(&self) -> PathBuf {
            fixture_archived_context_dir(&self.fixture_root, &self.repo_name, &self.directory_name)
        }

        fn workspace_dir(&self) -> PathBuf {
            fixture_workspace_dir(&self.fixture_root, &self.repo_name, &self.directory_name)
        }

        fn mirror_dir(&self) -> PathBuf {
            fixture_repo_mirror_dir(&self.fixture_root, &self.repo_name)
        }

        fn attachment_path(&self) -> String {
            self.workspace_dir()
                .join(".context/attachments/evidence.txt")
                .display()
                .to_string()
        }
    }

    impl Drop for ArchiveTestHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct CreateTestHarness {
        root: PathBuf,
        fixture_root: PathBuf,
        source_repo_root: PathBuf,
        repo_id: String,
        repo_name: String,
    }

    impl CreateTestHarness {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "helmor-create-test-{}",
                uuid::Uuid::new_v4()
            ));
            let fixture_root = root.join("fixture");
            let source_repo_root = root.join("source-repo");
            let repo_id = "repo-create".to_string();
            let repo_name = "demo-repo".to_string();

            fs::create_dir_all(&source_repo_root).unwrap();
            init_create_git_repo(&source_repo_root);

            fs::create_dir_all(fixture_root.join("com.conductor.app")).unwrap();
            fs::create_dir_all(fixture_root.join("helmor/archived-contexts")).unwrap();
            fs::create_dir_all(fixture_root.join("helmor/workspaces")).unwrap();
            fs::create_dir_all(fixture_root.join("helmor/repos")).unwrap();
            fs::create_dir_all(fixture_root.join("helmor/logs/workspaces")).unwrap();

            create_workspace_fixture_db(
                &fixture_root.join("com.conductor.app/conductor.db"),
                &source_repo_root,
                &repo_id,
                &repo_name,
            );

            Self {
                root,
                fixture_root,
                source_repo_root,
                repo_id,
                repo_name,
            }
        }

        fn db_path(&self) -> PathBuf {
            self.fixture_root.join("com.conductor.app/conductor.db")
        }

        fn workspace_dir(&self, directory_name: &str) -> PathBuf {
            fixture_workspace_dir(&self.fixture_root, &self.repo_name, directory_name)
        }

        fn set_repo_setup_script(&self, script: Option<&str>) {
            let connection = Connection::open(self.db_path()).unwrap();
            connection
                .execute(
                    "UPDATE repos SET setup_script = ?2 WHERE id = ?1",
                    (&self.repo_id, script),
                )
                .unwrap();
        }

        fn insert_workspace_name(&self, directory_name: &str) {
            let connection = Connection::open(self.db_path()).unwrap();
            connection
                .execute(
                    r#"
                    INSERT INTO workspaces (
                      id, repository_id, directory_name, active_session_id, branch,
                      placeholder_branch_name, state, initialization_parent_branch,
                      intended_target_branch, derived_status, unread, created_at, updated_at
                    ) VALUES (?1, ?2, ?3, NULL, ?4, ?4, 'ready', 'main', 'main', 'in-progress', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    "#,
                    (
                        format!("workspace-{directory_name}"),
                        &self.repo_id,
                        directory_name,
                        format!("caspian/{directory_name}"),
                    ),
                )
                .unwrap();
        }

        fn insert_repo(
            &self,
            repo_id: &str,
            repo_name: &str,
            display_order: i64,
            hidden: i64,
        ) {
            let connection = Connection::open(self.db_path()).unwrap();
            connection
                .execute(
                    r#"
                    INSERT INTO repos (
                      id, remote_url, name, default_branch, root_path, setup_script, created_at,
                      updated_at, display_order, hidden
                    ) VALUES (?1, NULL, ?2, 'main', ?3, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?4, ?5)
                    "#,
                    (
                        repo_id,
                        repo_name,
                        self.source_repo_root.to_str().unwrap(),
                        display_order,
                        hidden,
                    ),
                )
                .unwrap();
        }

        fn commit_repo_files(&self, files: &[(&str, &str)]) {
            for (relative_path, contents) in files {
                let path = self.source_repo_root.join(relative_path);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).unwrap();
                }
                fs::write(&path, contents).unwrap();
                make_executable_if_script(&path);
                run_git(
                    [
                        "-C",
                        self.source_repo_root.to_str().unwrap(),
                        "add",
                        relative_path,
                    ],
                    None,
                )
                .unwrap();
            }

            run_git(
                [
                    "-C",
                    self.source_repo_root.to_str().unwrap(),
                    "-c",
                    "user.name=Helmor",
                    "-c",
                    "user.email=helmor@example.com",
                    "commit",
                    "-m",
                    &format!("add {}", files[0].0),
                ],
                None,
            )
            .unwrap();
        }
    }

    impl Drop for CreateTestHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn restore_fixture_workspace_recreates_worktree_and_context() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(true);

        let response =
            restore_fixture_workspace_at(&harness.fixture_root, &harness.workspace_id).unwrap();

        assert_eq!(response.restored_workspace_id, harness.workspace_id);
        assert_eq!(response.restored_state, "ready");
        assert_eq!(response.selected_workspace_id, harness.workspace_id);
        assert!(harness.mirror_dir().exists());
        assert!(harness.workspace_dir().join(".git").exists());
        assert!(harness.workspace_dir().join("tracked.txt").exists());
        assert!(harness.workspace_dir().join(".context/notes.md").exists());
        assert!(harness.workspace_dir().join(".context/attachments/evidence.txt").exists());
        assert!(!harness.archived_context_dir().exists());

        let connection =
            Connection::open(harness.fixture_root.join("com.conductor.app/conductor.db")).unwrap();
        let state: String = connection
            .query_row(
                "SELECT state FROM workspaces WHERE id = ?1",
                [&harness.workspace_id],
                |row| row.get(0),
            )
            .unwrap();
        let attachment_path: String = connection
            .query_row(
                "SELECT path FROM attachments WHERE session_id = ?1",
                [&harness.session_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(state, "ready");
        assert_eq!(attachment_path, harness.attachment_path());
    }

    #[test]
    fn archive_fixture_workspace_moves_context_and_removes_worktree() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(true);

        let response =
            archive_fixture_workspace_at(&harness.fixture_root, &harness.workspace_id).unwrap();

        assert_eq!(response.archived_workspace_id, harness.workspace_id);
        assert_eq!(response.archived_state, "archived");
        assert!(!harness.workspace_dir().exists());
        assert!(harness.archived_context_dir().join("notes.md").exists());
        assert!(harness
            .archived_context_dir()
            .join("attachments/evidence.txt")
            .exists());

        let worktree_list = run_git(
            [
                "--git-dir",
                harness.mirror_dir().to_str().unwrap(),
                "worktree",
                "list",
            ],
            None,
        )
        .unwrap();
        assert!(!worktree_list.contains(harness.workspace_dir().to_str().unwrap()));

        let connection =
            Connection::open(harness.fixture_root.join("com.conductor.app/conductor.db")).unwrap();
        let (state, archive_commit, attachment_path): (String, String, String) = connection
            .query_row(
                "SELECT state, archive_commit, (SELECT path FROM attachments WHERE session_id = ?2) FROM workspaces WHERE id = ?1",
                (&harness.workspace_id, &harness.session_id),
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(state, "archived");
        assert_eq!(archive_commit, harness.head_commit);
        assert_eq!(attachment_path, harness.attachment_path());
    }

    #[test]
    fn restore_fixture_workspace_fails_when_target_directory_exists() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(true);
        fs::create_dir_all(harness.workspace_dir()).unwrap();

        let error =
            restore_fixture_workspace_at(&harness.fixture_root, &harness.workspace_id).unwrap_err();

        assert!(error.contains("already exists"));
        assert!(harness.archived_context_dir().exists());

        let connection =
            Connection::open(harness.fixture_root.join("com.conductor.app/conductor.db")).unwrap();
        let state: String = connection
            .query_row(
                "SELECT state FROM workspaces WHERE id = ?1",
                [&harness.workspace_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "archived");
    }

    #[test]
    fn restore_fixture_workspace_fails_when_branch_no_longer_exists() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(true);
        run_git(
            [
                "-C",
                harness.source_repo_root.to_str().unwrap(),
                "branch",
                "-D",
                harness.branch.as_str(),
            ],
            None,
        )
        .unwrap();

        let error =
            restore_fixture_workspace_at(&harness.fixture_root, &harness.workspace_id).unwrap_err();

        assert!(error.contains("branch no longer exists"));
        assert!(!harness.workspace_dir().exists());
        assert!(harness.archived_context_dir().exists());
    }

    #[test]
    fn restore_fixture_workspace_cleans_up_when_db_update_fails() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(false);

        let error =
            restore_fixture_workspace_at(&harness.fixture_root, &harness.workspace_id).unwrap_err();

        assert!(error.contains("update workspace restore state"));
        assert!(!harness.workspace_dir().exists());
        assert!(harness.archived_context_dir().exists());
    }

    #[test]
    fn archive_fixture_workspace_cleans_up_when_db_update_fails() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(false);

        let error =
            archive_fixture_workspace_at(&harness.fixture_root, &harness.workspace_id).unwrap_err();

        assert!(error.contains("update workspace archive state"));
        assert!(harness.workspace_dir().exists());
        assert!(harness.workspace_dir().join(".context/notes.md").exists());
        assert!(harness
            .workspace_dir()
            .join(".context/attachments/evidence.txt")
            .exists());
        assert!(!harness.archived_context_dir().exists());

        let connection =
            Connection::open(harness.fixture_root.join("com.conductor.app/conductor.db")).unwrap();
        let state: String = connection
            .query_row(
                "SELECT state FROM workspaces WHERE id = ?1",
                [&harness.workspace_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "ready");
    }

    #[test]
    fn workspace_record_marks_unread_when_session_has_unread_even_if_workspace_flag_is_clear() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(true);
        let connection =
            Connection::open(harness.fixture_root.join("com.conductor.app/conductor.db")).unwrap();

        connection
            .execute("UPDATE sessions SET unread_count = 1 WHERE id = ?1", [&harness.session_id])
            .unwrap();
        connection
            .execute("UPDATE workspaces SET unread = 0 WHERE id = ?1", [&harness.workspace_id])
            .unwrap();

        let record = load_workspace_record_by_id_from_fixture(&harness.fixture_root, &harness.workspace_id)
            .unwrap()
            .unwrap();

        assert!(record.has_unread);
        assert_eq!(record.workspace_unread, 0);
        assert_eq!(record.session_unread_total, 1);
        assert_eq!(record.unread_session_count, 1);
    }

    #[test]
    fn archived_workspace_summary_reports_unread_state() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(true);
        let connection =
            Connection::open(harness.fixture_root.join("com.conductor.app/conductor.db")).unwrap();

        connection
            .execute("UPDATE sessions SET unread_count = 1 WHERE id = ?1", [&harness.session_id])
            .unwrap();
        connection
            .execute("UPDATE workspaces SET unread = 0 WHERE id = ?1", [&harness.workspace_id])
            .unwrap();

        let record = load_workspace_record_by_id_from_fixture(&harness.fixture_root, &harness.workspace_id)
            .unwrap()
            .unwrap();
        let summary = record_to_summary(record);

        assert!(summary.has_unread);
        assert_eq!(summary.session_unread_total, 1);
        assert_eq!(summary.unread_session_count, 1);
    }

    #[test]
    fn mark_fixture_session_read_clears_session_and_workspace_unread() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(true);
        let connection =
            Connection::open(harness.fixture_root.join("com.conductor.app/conductor.db")).unwrap();

        connection
            .execute("UPDATE sessions SET unread_count = 1 WHERE id = ?1", [&harness.session_id])
            .unwrap();
        connection
            .execute("UPDATE workspaces SET unread = 1 WHERE id = ?1", [&harness.workspace_id])
            .unwrap();

        mark_fixture_session_read_at(&harness.fixture_root, &harness.session_id).unwrap();

        let (session_unread, workspace_unread): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT unread_count FROM sessions WHERE id = ?1), (SELECT unread FROM workspaces WHERE id = ?2)",
                (&harness.session_id, &harness.workspace_id),
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(session_unread, 0);
        assert_eq!(workspace_unread, 0);
    }

    #[test]
    fn mark_fixture_workspace_read_clears_all_workspace_sessions() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(true);
        let connection =
            Connection::open(harness.fixture_root.join("com.conductor.app/conductor.db")).unwrap();

        connection
            .execute("UPDATE sessions SET unread_count = 1 WHERE id = ?1", [&harness.session_id])
            .unwrap();
        connection
            .execute(
                r#"
                INSERT INTO sessions (
                  id, workspace_id, title, agent_type, status, model, permission_mode,
                  claude_session_id, unread_count, context_token_count, context_used_percent,
                  thinking_enabled, codex_thinking_level, fast_mode, agent_personality,
                  created_at, updated_at, last_user_message_at, resume_session_at,
                  is_hidden, is_compacting
                ) VALUES ('session-archive-2', ?1, 'Second session', 'claude', 'idle', 'opus', 'default', NULL, 2, 0, NULL, 0, NULL, 0, 'none', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 0, 0)
                "#,
                [&harness.workspace_id],
            )
            .unwrap();
        connection
            .execute("UPDATE workspaces SET unread = 1 WHERE id = ?1", [&harness.workspace_id])
            .unwrap();

        mark_fixture_workspace_read_at(&harness.fixture_root, &harness.workspace_id).unwrap();

        let (session_unread_total, workspace_unread): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COALESCE(SUM(unread_count), 0) FROM sessions WHERE workspace_id = ?1), (SELECT unread FROM workspaces WHERE id = ?1)",
                [&harness.workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(session_unread_total, 0);
        assert_eq!(workspace_unread, 0);
    }

    #[test]
    fn mark_fixture_workspace_unread_sets_workspace_flag_without_touching_sessions() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(true);
        let connection =
            Connection::open(harness.fixture_root.join("com.conductor.app/conductor.db")).unwrap();

        connection
            .execute("UPDATE sessions SET unread_count = 0 WHERE id = ?1", [&harness.session_id])
            .unwrap();
        connection
            .execute("UPDATE workspaces SET unread = 0 WHERE id = ?1", [&harness.workspace_id])
            .unwrap();

        mark_fixture_workspace_unread_at(&harness.fixture_root, &harness.workspace_id).unwrap();

        let (session_unread_total, workspace_unread): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COALESCE(SUM(unread_count), 0) FROM sessions WHERE workspace_id = ?1), (SELECT unread FROM workspaces WHERE id = ?1)",
                [&harness.workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(session_unread_total, 0);
        assert_eq!(workspace_unread, 1);
    }

    #[test]
    fn ensure_fixture_repo_mirror_refreshes_with_existing_checked_out_worktree() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(true);
        let mirror_dir = harness.mirror_dir();
        let first_workspace_dir = harness.workspace_dir();

        run_git(
            [
                "-C",
                harness.source_repo_root.to_str().unwrap(),
                "checkout",
                "main",
            ],
            None,
        )
        .unwrap();
        run_git(
            [
                "-C",
                harness.source_repo_root.to_str().unwrap(),
                "checkout",
                "-b",
                "feature/second-restore-target",
            ],
            None,
        )
        .unwrap();
        fs::write(harness.source_repo_root.join("second.txt"), "second branch").unwrap();
        run_git(
            ["-C", harness.source_repo_root.to_str().unwrap(), "add", "second.txt"],
            None,
        )
        .unwrap();
        run_git(
            [
                "-C",
                harness.source_repo_root.to_str().unwrap(),
                "-c",
                "user.name=Helmor",
                "-c",
                "user.email=helmor@example.com",
                "commit",
                "-m",
                "second restore target",
            ],
            None,
        )
        .unwrap();
        let second_commit = run_git(
            [
                "-C",
                harness.source_repo_root.to_str().unwrap(),
                "rev-parse",
                "HEAD",
            ],
            None,
        )
        .unwrap();

        ensure_fixture_repo_mirror(&harness.source_repo_root, &mirror_dir).unwrap();
        verify_branch_exists_in_mirror(&mirror_dir, &harness.branch).unwrap();
        point_branch_to_archive_commit(&mirror_dir, &harness.branch, second_commit.as_str()).unwrap();
        create_fixture_worktree(&mirror_dir, &first_workspace_dir, &harness.branch).unwrap();

        ensure_fixture_repo_mirror(&harness.source_repo_root, &mirror_dir).unwrap();
        verify_branch_exists_in_mirror(&mirror_dir, "feature/second-restore-target").unwrap();
    }

    #[test]
    fn list_fixture_repositories_filters_hidden_and_sorts_by_display_order() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        harness.insert_repo("repo-hidden", "hidden-repo", 0, 1);
        harness.insert_repo("repo-alpha", "alpha-repo", 0, 0);

        let repositories = list_fixture_repositories_at(&harness.fixture_root).unwrap();
        let repository_names = repositories
            .iter()
            .map(|repository| repository.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(repository_names, vec!["alpha-repo", "demo-repo"]);
    }

    #[test]
    fn create_fixture_workspace_from_repo_creates_ready_workspace_and_initial_session() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();

        harness.commit_repo_files(&[
            (
                "conductor.json",
                r#"{"scripts":{"setup":"$CONDUCTOR_ROOT_PATH/conductor-setup.sh"}}"#,
            ),
            (
                "conductor-setup.sh",
                "#!/bin/sh\nset -e\nprintf '%s' \"$CONDUCTOR_ROOT_PATH\" > \"$CONDUCTOR_WORKSPACE_PATH/.context/setup-root.txt\"\nprintf 'json' > \"$CONDUCTOR_WORKSPACE_PATH/setup-from-json.txt\"\n",
            ),
        ]);

        let response =
            create_fixture_workspace_from_repo_at(&harness.fixture_root, &harness.repo_id).unwrap();

        assert_eq!(response.created_state, "ready");
        assert_eq!(response.directory_name, "acamar");
        assert_eq!(response.branch, "caspian/acamar");

        let workspace_dir = harness.workspace_dir("acamar");
        assert!(workspace_dir.join(".git").exists());
        assert!(workspace_dir.join(".context/notes.md").exists());
        assert!(workspace_dir.join(".context/todos.md").exists());
        assert!(workspace_dir.join(".context/attachments").is_dir());
        assert!(workspace_dir.join(".context/setup-root.txt").exists());
        assert!(workspace_dir.join("setup-from-json.txt").exists());

        let connection = Connection::open(harness.db_path()).unwrap();
        let (
            state,
            branch,
            placeholder_branch_name,
            initialization_parent_branch,
            intended_target_branch,
            initialization_files_copied,
            setup_log_path,
            initialization_log_path,
            active_session_id,
        ): (
            String,
            String,
            String,
            String,
            String,
            i64,
            String,
            String,
            String,
        ) = connection
            .query_row(
                r#"
                SELECT
                  state,
                  branch,
                  placeholder_branch_name,
                  initialization_parent_branch,
                  intended_target_branch,
                  initialization_files_copied,
                  setup_log_path,
                  initialization_log_path,
                  active_session_id
                FROM workspaces
                WHERE id = ?1
                "#,
                [&response.created_workspace_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )
            .unwrap();
        let (session_title, session_model, session_permission_mode, thinking_enabled): (
            String,
            String,
            String,
            i64,
        ) = connection
            .query_row(
                "SELECT title, model, permission_mode, thinking_enabled FROM sessions WHERE id = ?1",
                [&active_session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(state, "ready");
        assert_eq!(branch, "caspian/acamar");
        assert_eq!(placeholder_branch_name, "caspian/acamar");
        assert_eq!(initialization_parent_branch, "main");
        assert_eq!(intended_target_branch, "main");
        assert!(initialization_files_copied > 0);
        assert!(Path::new(&setup_log_path).is_file());
        assert!(Path::new(&initialization_log_path).is_file());
        assert_eq!(session_title, "Untitled");
        assert_eq!(session_model, "opus");
        assert_eq!(session_permission_mode, "default");
        assert_eq!(thinking_enabled, 1);
    }

    #[test]
    fn create_fixture_workspace_from_repo_prefers_repo_setup_script_over_conductor_json() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        harness.set_repo_setup_script(Some("$CONDUCTOR_ROOT_PATH/repo-settings-setup.sh"));
        harness.commit_repo_files(&[
            (
                "conductor.json",
                r#"{"scripts":{"setup":"$CONDUCTOR_ROOT_PATH/conductor-setup.sh"}}"#,
            ),
            (
                "conductor-setup.sh",
                "#!/bin/sh\nset -e\nprintf 'json' > \"$CONDUCTOR_WORKSPACE_PATH/json-setup.txt\"\n",
            ),
            (
                "repo-settings-setup.sh",
                "#!/bin/sh\nset -e\nprintf 'repo' > \"$CONDUCTOR_WORKSPACE_PATH/repo-setup.txt\"\n",
            ),
        ]);

        let response =
            create_fixture_workspace_from_repo_at(&harness.fixture_root, &harness.repo_id).unwrap();
        let workspace_dir = harness.workspace_dir(&response.directory_name);

        assert!(workspace_dir.join("repo-setup.txt").exists());
        assert!(!workspace_dir.join("json-setup.txt").exists());
    }

    #[test]
    fn create_fixture_workspace_from_repo_uses_v2_suffix_after_star_list_is_exhausted() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();

        for star_name in STAR_PROPER_NAMES {
            harness.insert_workspace_name(star_name);
        }

        let response =
            create_fixture_workspace_from_repo_at(&harness.fixture_root, &harness.repo_id).unwrap();

        assert_eq!(response.directory_name, "acamar-v2");
        assert_eq!(response.branch, "caspian/acamar-v2");
    }

    #[test]
    fn create_fixture_workspace_from_repo_cleans_up_after_worktree_failure() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        let conflicting_workspace_dir = harness.workspace_dir("acamar");

        fs::create_dir_all(&conflicting_workspace_dir).unwrap();
        fs::write(conflicting_workspace_dir.join("keep.txt"), "keep").unwrap();

        let error =
            create_fixture_workspace_from_repo_at(&harness.fixture_root, &harness.repo_id).unwrap_err();

        assert!(error.contains("already exists"));
        assert!(conflicting_workspace_dir.join("keep.txt").exists());

        let connection = Connection::open(harness.db_path()).unwrap();
        let (workspace_count, session_count): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM workspaces), (SELECT COUNT(*) FROM sessions)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(workspace_count, 0);
        assert_eq!(session_count, 0);
    }

    #[test]
    fn create_fixture_workspace_from_repo_cleans_up_after_setup_failure_and_keeps_logs() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();

        harness.commit_repo_files(&[
            (
                "conductor.json",
                r#"{"scripts":{"setup":"$CONDUCTOR_ROOT_PATH/conductor-setup.sh"}}"#,
            ),
            (
                "conductor-setup.sh",
                "#!/bin/sh\nset -e\necho 'failing setup'\nexit 7\n",
            ),
        ]);

        let error =
            create_fixture_workspace_from_repo_at(&harness.fixture_root, &harness.repo_id).unwrap_err();

        assert!(error.contains("Setup script failed"));
        assert!(!harness.workspace_dir("acamar").exists());

        let connection = Connection::open(harness.db_path()).unwrap();
        let (workspace_count, session_count): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM workspaces), (SELECT COUNT(*) FROM sessions)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(workspace_count, 0);
        assert_eq!(session_count, 0);

        let log_root = harness.fixture_root.join("helmor/logs/workspaces");
        let mut log_files = fs::read_dir(&log_root)
            .unwrap()
            .flat_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        log_files.sort();

        assert!(!log_files.is_empty());
        let setup_log = log_files[0].join("setup.log");
        assert!(setup_log.is_file());
        let setup_log_contents = fs::read_to_string(setup_log).unwrap();
        assert!(setup_log_contents.contains("failing setup"));
    }

    #[test]
    fn add_fixture_repository_from_local_path_adds_repo_and_first_workspace() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        let added_repo_root = harness.root.join("added-repo");

        fs::create_dir_all(&added_repo_root).unwrap();
        init_create_git_repo(&added_repo_root);
        let normalized_repo_root = normalize_filesystem_path(&added_repo_root).unwrap();

        let response = add_fixture_repository_from_local_path_at(
            &harness.fixture_root,
            added_repo_root.to_str().unwrap(),
        )
        .unwrap();
        let connection = Connection::open(harness.db_path()).unwrap();
        let (repo_count, workspace_count, session_count): (i64, i64, i64) = connection
            .query_row(
                r#"
                SELECT
                  (SELECT COUNT(*) FROM repos WHERE root_path = ?1),
                  (SELECT COUNT(*) FROM workspaces WHERE repository_id = ?2),
                  (SELECT COUNT(*) FROM sessions WHERE workspace_id = ?3)
                "#,
                (
                    normalized_repo_root.as_str(),
                    &response.repository_id,
                    response.created_workspace_id.as_deref().unwrap(),
                ),
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let (remote, remote_url, default_branch): (Option<String>, Option<String>, String) =
            connection
                .query_row(
                    "SELECT remote, remote_url, default_branch FROM repos WHERE id = ?1",
                    [&response.repository_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
        let created_workspace_state: String = connection
            .query_row(
                "SELECT state FROM workspaces WHERE id = ?1",
                [response.selected_workspace_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();

        assert!(response.created_repository);
        assert_eq!(repo_count, 1);
        assert_eq!(workspace_count, 1);
        assert_eq!(session_count, 1);
        assert_eq!(response.created_workspace_state, "ready");
        assert_eq!(created_workspace_state, "ready");
        assert_eq!(default_branch, "main");
        assert_eq!(remote, None);
        assert_eq!(remote_url, None);
    }

    #[test]
    fn add_fixture_repository_from_local_path_normalizes_subdirectory_selection() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        let added_repo_root = harness.root.join("normalized-repo");
        let nested_dir = added_repo_root.join("packages/app");

        fs::create_dir_all(&added_repo_root).unwrap();
        init_create_git_repo(&added_repo_root);
        fs::create_dir_all(&nested_dir).unwrap();
        let normalized_repo_root = normalize_filesystem_path(&added_repo_root).unwrap();

        let response = add_fixture_repository_from_local_path_at(
            &harness.fixture_root,
            nested_dir.to_str().unwrap(),
        )
        .unwrap();
        let connection = Connection::open(harness.db_path()).unwrap();
        let (stored_name, stored_root): (String, String) = connection
            .query_row(
                "SELECT name, root_path FROM repos WHERE id = ?1",
                [&response.repository_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(stored_name, "normalized-repo");
        assert_eq!(stored_root, normalized_repo_root);
    }

    #[test]
    fn add_fixture_repository_from_local_path_accepts_repo_without_remote() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        let added_repo_root = harness.root.join("no-remote-repo");

        fs::create_dir_all(&added_repo_root).unwrap();
        init_create_git_repo(&added_repo_root);

        let response = add_fixture_repository_from_local_path_at(
            &harness.fixture_root,
            added_repo_root.to_str().unwrap(),
        )
        .unwrap();
        let connection = Connection::open(harness.db_path()).unwrap();
        let (remote, remote_url, default_branch): (Option<String>, Option<String>, String) =
            connection
                .query_row(
                    "SELECT remote, remote_url, default_branch FROM repos WHERE id = ?1",
                    [&response.repository_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();

        assert_eq!(remote, None);
        assert_eq!(remote_url, None);
        assert_eq!(default_branch, "main");
    }

    #[test]
    fn add_fixture_repository_from_local_path_focuses_existing_workspace_for_duplicate_repo() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        let created = create_fixture_workspace_from_repo_at(&harness.fixture_root, &harness.repo_id).unwrap();

        let response = add_fixture_repository_from_local_path_at(
            &harness.fixture_root,
            harness.source_repo_root.to_str().unwrap(),
        )
        .unwrap();
        let connection = Connection::open(harness.db_path()).unwrap();
        let (repo_count, workspace_count): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM repos), (SELECT COUNT(*) FROM workspaces)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert!(!response.created_repository);
        assert_eq!(response.created_workspace_id, None);
        assert_eq!(response.selected_workspace_id, created.created_workspace_id);
        assert_eq!(response.created_workspace_state, "ready");
        assert_eq!(repo_count, 1);
        assert_eq!(workspace_count, 1);
    }

    #[test]
    fn add_fixture_repository_from_local_path_creates_first_workspace_for_duplicate_repo_without_workspace() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();

        let response = add_fixture_repository_from_local_path_at(
            &harness.fixture_root,
            harness.source_repo_root.to_str().unwrap(),
        )
        .unwrap();
        let connection = Connection::open(harness.db_path()).unwrap();
        let (repo_count, workspace_count): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM repos), (SELECT COUNT(*) FROM workspaces)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert!(!response.created_repository);
        assert!(response.created_workspace_id.is_some());
        assert_eq!(repo_count, 1);
        assert_eq!(workspace_count, 1);
    }

    #[test]
    fn add_fixture_repository_from_local_path_rejects_non_git_directory_without_side_effects() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        let plain_dir = harness.root.join("not-a-repo");

        fs::create_dir_all(&plain_dir).unwrap();

        let error = add_fixture_repository_from_local_path_at(
            &harness.fixture_root,
            plain_dir.to_str().unwrap(),
        )
        .unwrap_err();
        let connection = Connection::open(harness.db_path()).unwrap();
        let (repo_count, workspace_count): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM repos), (SELECT COUNT(*) FROM workspaces)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert!(error.contains("Git working tree"));
        assert_eq!(repo_count, 1);
        assert_eq!(workspace_count, 0);
    }

    #[test]
    fn add_fixture_repository_from_local_path_rolls_back_new_repo_when_first_workspace_create_fails() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        let added_repo_root = harness.root.join("rollback-repo");

        fs::create_dir_all(&added_repo_root).unwrap();
        init_create_git_repo(&added_repo_root);

        let conflicting_workspace_dir =
            fixture_workspace_dir(&harness.fixture_root, "rollback-repo", "acamar");
        fs::create_dir_all(&conflicting_workspace_dir).unwrap();
        fs::write(conflicting_workspace_dir.join("keep.txt"), "keep").unwrap();

        let error = add_fixture_repository_from_local_path_at(
            &harness.fixture_root,
            added_repo_root.to_str().unwrap(),
        )
        .unwrap_err();
        let connection = Connection::open(harness.db_path()).unwrap();
        let (repo_count, workspace_count): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM repos WHERE root_path = ?1), (SELECT COUNT(*) FROM workspaces)",
                [added_repo_root.to_str().unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert!(error.contains("First workspace create failed"));
        assert_eq!(repo_count, 0);
        assert_eq!(workspace_count, 0);
        assert!(conflicting_workspace_dir.join("keep.txt").exists());
    }

    #[test]
    fn add_fixture_repository_from_local_path_updates_last_clone_directory() {
        let _guard = TEST_FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        let added_repo_root = harness.root.join("last-clone-repo");

        fs::create_dir_all(&added_repo_root).unwrap();
        init_create_git_repo(&added_repo_root);
        let normalized_repo_root = normalize_filesystem_path(&added_repo_root).unwrap();

        add_fixture_repository_from_local_path_at(
            &harness.fixture_root,
            added_repo_root.to_str().unwrap(),
        )
        .unwrap();
        let connection = Connection::open(harness.db_path()).unwrap();
        let stored_last_clone_directory: String = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'last_clone_directory'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(
            stored_last_clone_directory,
            Path::new(&normalized_repo_root)
                .parent()
                .unwrap()
                .display()
                .to_string()
        );
    }

    fn init_create_git_repo(repo_root: &Path) {
        run_git(["init", "-b", "main", repo_root.to_str().unwrap()], None).unwrap();
        fs::write(repo_root.join("tracked.txt"), "main").unwrap();
        run_git(
            ["-C", repo_root.to_str().unwrap(), "add", "tracked.txt"],
            None,
        )
        .unwrap();
        run_git(
            [
                "-C",
                repo_root.to_str().unwrap(),
                "-c",
                "user.name=Helmor",
                "-c",
                "user.email=helmor@example.com",
                "commit",
                "-m",
                "initial",
            ],
            None,
        )
        .unwrap();
    }

    #[cfg(unix)]
    fn make_executable_if_script(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        if path.extension().and_then(|value| value.to_str()) == Some("sh") {
            let metadata = fs::metadata(path).unwrap();
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).unwrap();
        }
    }

    #[cfg(not(unix))]
    fn make_executable_if_script(_path: &Path) {}

    fn init_git_repo(repo_root: &Path) {
        run_git(["init", "-b", "main", repo_root.to_str().unwrap()], None).unwrap();
        fs::write(repo_root.join("tracked.txt"), "main").unwrap();
        run_git(
            ["-C", repo_root.to_str().unwrap(), "add", "tracked.txt"],
            None,
        )
        .unwrap();
        run_git(
            [
                "-C",
                repo_root.to_str().unwrap(),
                "-c",
                "user.name=Helmor",
                "-c",
                "user.email=helmor@example.com",
                "commit",
                "-m",
                "initial",
            ],
            None,
        )
        .unwrap();
        run_git(
            [
                "-C",
                repo_root.to_str().unwrap(),
                "checkout",
                "-b",
                "feature/restore-target",
            ],
            None,
        )
        .unwrap();
        fs::write(repo_root.join("tracked.txt"), "archived snapshot").unwrap();
        run_git(
            ["-C", repo_root.to_str().unwrap(), "add", "tracked.txt"],
            None,
        )
        .unwrap();
        run_git(
            [
                "-C",
                repo_root.to_str().unwrap(),
                "-c",
                "user.name=Helmor",
                "-c",
                "user.email=helmor@example.com",
                "commit",
                "-m",
                "archived snapshot",
            ],
            None,
        )
        .unwrap();
    }

    fn create_workspace_fixture_db(
        db_path: &Path,
        source_repo_root: &Path,
        repo_id: &str,
        repo_name: &str,
    ) {
        let connection = Connection::open(db_path).unwrap();
        connection
            .execute_batch(&fixture_schema_sql(true))
            .unwrap();
        connection
            .execute(
                r#"
                INSERT INTO repos (
                  id, remote_url, name, default_branch, root_path, setup_script, created_at,
                  updated_at, display_order, hidden
                ) VALUES (?1, NULL, ?2, 'main', ?3, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 0)
                "#,
                (repo_id, repo_name, source_repo_root.to_str().unwrap()),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO settings (key, value, created_at, updated_at) VALUES ('branch_prefix_type', 'custom', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO settings (key, value, created_at, updated_at) VALUES ('branch_prefix_custom', 'caspian/', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                [],
            )
            .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn create_fixture_db(
        db_path: &Path,
        source_repo_root: &Path,
        repo_name: &str,
        directory_name: &str,
        workspace_id: &str,
        session_id: &str,
        branch: &str,
        archive_commit: &str,
        include_updated_at: bool,
    ) {
        let connection = Connection::open(db_path).unwrap();
        connection
            .execute_batch(&fixture_schema_sql(include_updated_at))
            .unwrap();

        connection
            .execute(
                "INSERT INTO repos (id, name, remote_url, default_branch, root_path) VALUES (?1, ?2, NULL, 'main', ?3)",
                ["repo-1", repo_name, source_repo_root.to_str().unwrap()],
            )
            .unwrap();
        if include_updated_at {
            connection
                .execute(
                    r#"
                    INSERT INTO workspaces (
                      id, repository_id, directory_name, state, derived_status, manual_status,
                      unread, branch, initialization_parent_branch, intended_target_branch, notes,
                      pinned_at, active_session_id, pr_title, pr_description, archive_commit,
                      created_at, updated_at
                    ) VALUES (?1, 'repo-1', ?2, 'archived', 'in-progress', NULL, 0, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    "#,
                    [workspace_id, directory_name, branch, session_id, archive_commit],
                )
                .unwrap();
        } else {
            connection
                .execute(
                    r#"
                    INSERT INTO workspaces (
                      id, repository_id, directory_name, state, derived_status, manual_status,
                      unread, branch, initialization_parent_branch, intended_target_branch, notes,
                      pinned_at, active_session_id, pr_title, pr_description, archive_commit,
                      created_at
                    ) VALUES (?1, 'repo-1', ?2, 'archived', 'in-progress', NULL, 0, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, ?5, CURRENT_TIMESTAMP)
                    "#,
                    [workspace_id, directory_name, branch, session_id, archive_commit],
                )
                .unwrap();
        }

        connection
            .execute(
                r#"
                INSERT INTO sessions (
                  id, workspace_id, title, agent_type, status, model, permission_mode,
                  claude_session_id, unread_count, context_token_count, context_used_percent,
                  thinking_enabled, codex_thinking_level, fast_mode, agent_personality,
                  created_at, updated_at, last_user_message_at, resume_session_at,
                  is_hidden, is_compacting
                ) VALUES (?1, ?2, 'Archived session', 'claude', 'idle', 'opus', 'default', NULL, 0, 0, NULL, 0, NULL, 0, 'none', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 0, 0)
                "#,
                [session_id, workspace_id],
            )
            .unwrap();

        let archived_attachment_path = fixture_archived_context_dir(
            db_path
                .parent()
                .unwrap()
                .parent()
                .unwrap(),
            repo_name,
            directory_name,
        )
        .join("attachments/evidence.txt")
        .display()
        .to_string();

        connection
            .execute(
                "INSERT INTO attachments (id, session_id, session_message_id, type, original_name, path, is_loading, is_draft, created_at) VALUES ('attachment-1', ?1, NULL, 'text', 'evidence.txt', ?2, 0, 0, CURRENT_TIMESTAMP)",
                [session_id, archived_attachment_path.as_str()],
            )
            .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn create_ready_fixture_db(
        db_path: &Path,
        source_repo_root: &Path,
        repo_name: &str,
        directory_name: &str,
        workspace_id: &str,
        session_id: &str,
        branch: &str,
        include_updated_at: bool,
    ) {
        let connection = Connection::open(db_path).unwrap();
        connection
            .execute_batch(&fixture_schema_sql(include_updated_at))
            .unwrap();

        connection
            .execute(
                "INSERT INTO repos (id, name, remote_url, default_branch, root_path) VALUES (?1, ?2, NULL, 'main', ?3)",
                ["repo-1", repo_name, source_repo_root.to_str().unwrap()],
            )
            .unwrap();

        if include_updated_at {
            connection
                .execute(
                    r#"
                    INSERT INTO workspaces (
                      id, repository_id, directory_name, state, derived_status, manual_status,
                      unread, branch, initialization_parent_branch, intended_target_branch, notes,
                      pinned_at, active_session_id, pr_title, pr_description, archive_commit,
                      created_at, updated_at
                    ) VALUES (?1, 'repo-1', ?2, 'ready', 'in-progress', NULL, 0, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    "#,
                    (workspace_id, directory_name, branch, session_id),
                )
                .unwrap();
        } else {
            connection
                .execute(
                    r#"
                    INSERT INTO workspaces (
                      id, repository_id, directory_name, state, derived_status, manual_status,
                      unread, branch, initialization_parent_branch, intended_target_branch, notes,
                      pinned_at, active_session_id, pr_title, pr_description, archive_commit,
                      created_at
                    ) VALUES (?1, 'repo-1', ?2, 'ready', 'in-progress', NULL, 0, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, NULL, CURRENT_TIMESTAMP)
                    "#,
                    (workspace_id, directory_name, branch, session_id),
                )
                .unwrap();
        }

        connection
            .execute(
                r#"
                INSERT INTO sessions (
                  id, workspace_id, title, agent_type, status, model, permission_mode,
                  claude_session_id, unread_count, context_token_count, context_used_percent,
                  thinking_enabled, codex_thinking_level, fast_mode, agent_personality,
                  created_at, updated_at, last_user_message_at, resume_session_at,
                  is_hidden, is_compacting
                ) VALUES (?1, ?2, 'Ready session', 'claude', 'idle', 'opus', 'default', NULL, 0, 0, NULL, 0, NULL, 0, 'none', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 0, 0)
                "#,
                [session_id, workspace_id],
            )
            .unwrap();

        let workspace_attachment_path = fixture_workspace_dir(
            db_path
                .parent()
                .unwrap()
                .parent()
                .unwrap(),
            repo_name,
            directory_name,
        )
        .join(".context/attachments/evidence.txt")
        .display()
        .to_string();

        connection
            .execute(
                "INSERT INTO attachments (id, session_id, session_message_id, type, original_name, path, is_loading, is_draft, created_at) VALUES ('attachment-1', ?1, NULL, 'text', 'evidence.txt', ?2, 0, 0, CURRENT_TIMESTAMP)",
                [session_id, workspace_attachment_path.as_str()],
            )
            .unwrap();
    }

    fn fixture_schema_sql(include_updated_at: bool) -> String {
        let workspaces_updated_at_column = if include_updated_at {
            ",\n              updated_at TEXT DEFAULT CURRENT_TIMESTAMP"
        } else {
            ""
        };

        format!(
            r#"
            CREATE TABLE repos (
              id TEXT PRIMARY KEY,
              remote_url TEXT,
              name TEXT NOT NULL,
              default_branch TEXT DEFAULT 'main',
              root_path TEXT NOT NULL,
              setup_script TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
              storage_version INTEGER DEFAULT 1,
              archive_script TEXT,
              display_order INTEGER DEFAULT 0,
              run_script TEXT,
              run_script_mode TEXT DEFAULT 'concurrent',
              remote TEXT,
              custom_prompt_code_review TEXT,
              custom_prompt_create_pr TEXT,
              custom_prompt_rename_branch TEXT,
              conductor_config TEXT,
              custom_prompt_general TEXT,
              icon TEXT,
              hidden INTEGER DEFAULT 0,
              custom_prompt_fix_errors TEXT,
              custom_prompt_resolve_merge_conflicts TEXT
            );

            CREATE TABLE settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE workspaces (
              id TEXT PRIMARY KEY,
              repository_id TEXT NOT NULL,
              DEPRECATED_city_name TEXT,
              directory_name TEXT,
              DEPRECATED_archived INTEGER DEFAULT 0,
              active_session_id TEXT,
              branch TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              state TEXT,
              derived_status TEXT,
              manual_status TEXT,
              unread INTEGER DEFAULT 0,
              placeholder_branch_name TEXT,
              initialization_parent_branch TEXT,
              big_terminal_mode INTEGER DEFAULT 0,
              setup_log_path TEXT,
              initialization_log_path TEXT,
              initialization_files_copied INTEGER,
              pinned_at TEXT,
              linked_workspace_ids TEXT,
              notes TEXT,
              intended_target_branch TEXT,
              pr_title TEXT,
              pr_description TEXT,
              archive_commit TEXT,
              secondary_directory_name TEXT,
              linked_directory_paths TEXT
              {workspaces_updated_at_column}
            );

            CREATE TABLE sessions (
              id TEXT PRIMARY KEY,
              status TEXT,
              claude_session_id TEXT,
              unread_count INTEGER DEFAULT 0,
              freshly_compacted INTEGER DEFAULT 0,
              context_token_count INTEGER DEFAULT 0,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
              is_compacting INTEGER DEFAULT 0,
              model TEXT,
              permission_mode TEXT,
              DEPRECATED_thinking_level TEXT DEFAULT 'NONE',
              last_user_message_at TEXT,
              resume_session_at TEXT,
              workspace_id TEXT NOT NULL,
              is_hidden INTEGER DEFAULT 0,
              agent_type TEXT,
              title TEXT DEFAULT 'Untitled',
              context_used_percent REAL,
              thinking_enabled INTEGER DEFAULT 1,
              codex_thinking_level TEXT,
              fast_mode INTEGER DEFAULT 0,
              agent_personality TEXT
            );

            CREATE TABLE session_messages (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              role TEXT,
              content TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              sent_at TEXT,
              cancelled_at TEXT,
              model TEXT,
              sdk_message_id TEXT,
              last_assistant_message_id TEXT,
              turn_id TEXT,
              is_resumable_message INTEGER
            );

            CREATE TABLE attachments (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              session_message_id TEXT,
              type TEXT,
              original_name TEXT,
              path TEXT,
              is_loading INTEGER DEFAULT 0,
              is_draft INTEGER DEFAULT 0,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            "#
        )
    }
}
