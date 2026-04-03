use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::{
    ffi::OsStr,
    fs,
    process::Command,
    path::{Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};

use rusqlite::{Connection, OpenFlags, Row};
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
pub struct WorkspaceSidebarRow {
    pub id: String,
    pub title: String,
    pub avatar: String,
    pub active: bool,
    pub directory_name: String,
    pub repo_name: String,
    pub repo_icon_src: Option<String>,
    pub repo_initials: String,
    pub state: String,
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
    pub derived_status: String,
    pub manual_status: Option<String>,
    pub active: bool,
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
    pub derived_status: String,
    pub manual_status: Option<String>,
    pub active: bool,
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

fn record_to_sidebar_row(record: WorkspaceRecord) -> WorkspaceSidebarRow {
    let title = display_title(&record);
    let repo_initials = repo_initials_for_name(&record.repo_name);

    WorkspaceSidebarRow {
        avatar: repo_initials.clone(),
        active: record.state == "ready",
        title,
        id: record.id,
        directory_name: record.directory_name,
        repo_name: record.repo_name,
        repo_icon_src: repo_icon_src_for_root_path(record.root_path.as_deref()),
        repo_initials,
        state: record.state,
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
        active: record.state == "ready",
        title: display_title(&record),
        id: record.id,
        directory_name: record.directory_name,
        repo_name: record.repo_name,
        repo_icon_src: repo_icon_src_for_root_path(record.root_path.as_deref()),
        repo_initials,
        state: record.state,
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
        active: record.state == "ready",
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
    rows.sort_by(|left, right| {
        right
            .active
            .cmp(&left.active)
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
    });
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

fn load_workspace_records() -> Result<Vec<WorkspaceRecord>, String> {
    let connection = open_fixture_connection()?;
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
        derived_status: row.get(8)?,
        manual_status: row.get(9)?,
        branch: row.get(10)?,
        initialization_parent_branch: row.get(11)?,
        intended_target_branch: row.get(12)?,
        notes: row.get(13)?,
        pinned_at: row.get(14)?,
        active_session_id: row.get(15)?,
        active_session_title: row.get(16)?,
        active_session_agent_type: row.get(17)?,
        active_session_status: row.get(18)?,
        pr_title: row.get(19)?,
        pr_description: row.get(20)?,
        archive_commit: row.get(21)?,
        session_count: row.get(22)?,
        message_count: row.get(23)?,
        attachment_count: row.get(24)?,
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

    Connection::open_with_flags(db_path, flags).map_err(|error| error.to_string())
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
                      branch, initialization_parent_branch, intended_target_branch, notes,
                      pinned_at, active_session_id, pr_title, pr_description, archive_commit,
                      created_at, updated_at
                    ) VALUES (?1, 'repo-1', ?2, 'archived', 'in-progress', NULL, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
                      branch, initialization_parent_branch, intended_target_branch, notes,
                      pinned_at, active_session_id, pr_title, pr_description, archive_commit,
                      created_at
                    ) VALUES (?1, 'repo-1', ?2, 'archived', 'in-progress', NULL, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, ?5, CURRENT_TIMESTAMP)
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
                      branch, initialization_parent_branch, intended_target_branch, notes,
                      pinned_at, active_session_id, pr_title, pr_description, archive_commit,
                      created_at, updated_at
                    ) VALUES (?1, 'repo-1', ?2, 'ready', 'in-progress', NULL, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
                      branch, initialization_parent_branch, intended_target_branch, notes,
                      pinned_at, active_session_id, pr_title, pr_description, archive_commit,
                      created_at
                    ) VALUES (?1, 'repo-1', ?2, 'ready', 'in-progress', NULL, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, NULL, CURRENT_TIMESTAMP)
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
        let updated_at_column = if include_updated_at {
            ",\n              updated_at TEXT DEFAULT CURRENT_TIMESTAMP"
        } else {
            ""
        };

        format!(
            r#"
            CREATE TABLE repos (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              remote_url TEXT,
              default_branch TEXT,
              root_path TEXT NOT NULL
            );

            CREATE TABLE workspaces (
              id TEXT PRIMARY KEY,
              repository_id TEXT NOT NULL,
              directory_name TEXT,
              state TEXT,
              derived_status TEXT,
              manual_status TEXT,
              branch TEXT,
              initialization_parent_branch TEXT,
              intended_target_branch TEXT,
              notes TEXT,
              pinned_at TEXT,
              active_session_id TEXT,
              pr_title TEXT,
              pr_description TEXT,
              archive_commit TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP
              {updated_at_column}
            );

            CREATE TABLE sessions (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              title TEXT,
              agent_type TEXT,
              status TEXT,
              model TEXT,
              permission_mode TEXT,
              claude_session_id TEXT,
              unread_count INTEGER DEFAULT 0,
              context_token_count INTEGER DEFAULT 0,
              context_used_percent REAL,
              thinking_enabled INTEGER DEFAULT 0,
              codex_thinking_level TEXT,
              fast_mode INTEGER DEFAULT 0,
              agent_personality TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
              last_user_message_at TEXT,
              resume_session_at TEXT,
              is_hidden INTEGER DEFAULT 0,
              is_compacting INTEGER DEFAULT 0
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
