use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use rusqlite::{Connection, OpenFlags, Row};
use serde::Serialize;
use serde_json::Value;

const FIXTURE_BASE_DIR: &str = ".local-data/conductor";

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
    let connection = open_fixture_connection()?;
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
    let db_path = resolve_fixture_db_path()?;

    Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn resolve_fixture_db_path() -> Result<PathBuf, String> {
    Ok(resolve_fixture_root()?.join("com.conductor.app/conductor.db"))
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
