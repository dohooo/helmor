//! Public API surface for the dev HTTP server.
//!
//! Re-exports model layer functions so `helmor-dev-server` can call them
//! without the Tauri command wrappers.

use std::collections::HashMap;

use anyhow::Result;

use crate::models::{db, editor_files, repos, sessions, workspaces, DetectedEditor};

// ---------------------------------------------------------------------------
// Workspace queries
// ---------------------------------------------------------------------------

pub fn list_workspace_groups() -> Result<Vec<workspaces::WorkspaceSidebarGroup>> {
    workspaces::list_workspace_groups()
}

pub fn get_workspace(id: &str) -> Result<workspaces::WorkspaceDetail> {
    workspaces::get_workspace(id)
}

pub fn list_archived_workspaces() -> Result<Vec<workspaces::WorkspaceSummary>> {
    workspaces::list_archived_workspaces()
}

// ---------------------------------------------------------------------------
// Session / message queries
// ---------------------------------------------------------------------------

pub fn list_workspace_sessions(
    workspace_id: &str,
) -> Result<Vec<sessions::WorkspaceSessionSummary>> {
    sessions::list_workspace_sessions(workspace_id)
}

pub fn list_session_messages(session_id: &str) -> Result<Vec<sessions::SessionMessageRecord>> {
    sessions::list_session_messages(session_id)
}

pub fn list_session_attachments(
    session_id: &str,
) -> Result<Vec<sessions::SessionAttachmentRecord>> {
    sessions::list_session_attachments(session_id)
}

pub fn list_hidden_sessions(workspace_id: &str) -> Result<Vec<sessions::WorkspaceSessionSummary>> {
    sessions::list_hidden_sessions(workspace_id)
}

// ---------------------------------------------------------------------------
// Repos / models / misc
// ---------------------------------------------------------------------------

pub fn list_repositories() -> Result<Vec<repos::RepositoryCreateOption>> {
    repos::list_repositories()
}

pub fn list_agent_model_sections() -> Vec<crate::agents::AgentModelSection> {
    crate::agents::list_agent_model_sections()
}

pub fn get_data_info() -> Result<crate::models::DataInfo> {
    let data_dir = crate::data_dir::data_dir()?;
    let db_path = crate::data_dir::db_path()?;
    Ok(crate::models::DataInfo {
        data_mode: crate::data_dir::data_mode_label().to_string(),
        data_dir: data_dir.display().to_string(),
        db_path: db_path.display().to_string(),
    })
}

pub fn get_app_settings() -> Result<HashMap<String, String>> {
    let conn = db::open_connection(false)?;
    let mut stmt = conn.prepare(
        "SELECT key, value FROM settings WHERE key LIKE 'app.%' OR key LIKE 'branch_prefix_%'",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut map = HashMap::new();
    for row in rows.flatten() {
        map.insert(row.0, row.1);
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// Editor file operations
// ---------------------------------------------------------------------------

pub fn read_editor_file(path: &str) -> Result<editor_files::EditorFileReadResponse> {
    editor_files::read_editor_file(path)
}

pub fn write_editor_file(
    path: &str,
    content: &str,
) -> Result<editor_files::EditorFileWriteResponse> {
    editor_files::write_editor_file(path, content)
}

pub fn stat_editor_file(path: &str) -> Result<editor_files::EditorFileStatResponse> {
    editor_files::stat_editor_file(path)
}

pub fn list_editor_files(
    workspace_root_path: &str,
) -> Result<Vec<editor_files::EditorFileListItem>> {
    editor_files::list_editor_files(workspace_root_path)
}

pub fn list_editor_files_with_content(
    workspace_root_path: &str,
) -> Result<editor_files::EditorFilesWithContentResponse> {
    editor_files::list_editor_files_with_content(workspace_root_path)
}

pub fn list_workspace_changes(
    workspace_root_path: &str,
) -> Result<Vec<editor_files::EditorFileListItem>> {
    editor_files::list_workspace_changes(workspace_root_path)
}

pub fn list_workspace_changes_with_content(
    workspace_root_path: &str,
) -> Result<editor_files::EditorFilesWithContentResponse> {
    editor_files::list_workspace_changes_with_content(workspace_root_path)
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

pub fn detect_installed_editors() -> Result<Vec<DetectedEditor>> {
    let mut editors = Vec::new();

    let candidates: &[(&str, &str, &[&str])] = &[
        (
            "cursor",
            "Cursor",
            &["/Applications/Cursor.app", "$HOME/Applications/Cursor.app"],
        ),
        (
            "vscode",
            "VS Code",
            &[
                "/Applications/Visual Studio Code.app",
                "$HOME/Applications/Visual Studio Code.app",
            ],
        ),
        (
            "vscode-insiders",
            "VS Code Insiders",
            &[
                "/Applications/Visual Studio Code - Insiders.app",
                "$HOME/Applications/Visual Studio Code - Insiders.app",
            ],
        ),
        (
            "windsurf",
            "Windsurf",
            &[
                "/Applications/Windsurf.app",
                "$HOME/Applications/Windsurf.app",
            ],
        ),
        (
            "zed",
            "Zed",
            &["/Applications/Zed.app", "$HOME/Applications/Zed.app"],
        ),
        (
            "webstorm",
            "WebStorm",
            &[
                "/Applications/WebStorm.app",
                "$HOME/Applications/WebStorm.app",
            ],
        ),
        (
            "sublime",
            "Sublime Text",
            &[
                "/Applications/Sublime Text.app",
                "$HOME/Applications/Sublime Text.app",
            ],
        ),
    ];

    let home = std::env::var("HOME").unwrap_or_default();

    for (id, name, paths) in candidates {
        for path in *paths {
            let resolved = path.replace("$HOME", &home);
            if std::path::Path::new(&resolved).exists() {
                editors.push(DetectedEditor {
                    id: id.to_string(),
                    name: name.to_string(),
                    path: resolved,
                });
                break;
            }
        }
    }

    Ok(editors)
}
