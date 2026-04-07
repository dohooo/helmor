//! Public API surface for the dev HTTP server.
//!
//! Re-exports model layer functions so `helmor-dev-server` can call them
//! without the Tauri command wrappers.

use std::collections::HashMap;

use anyhow::{Context, Result};

use crate::models::{db, editor_files, repos, sessions, settings, workspaces, DetectedEditor};

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

pub fn list_session_thread_messages(
    session_id: &str,
) -> Result<Vec<crate::pipeline::types::ThreadMessageLike>> {
    let historical = sessions::list_session_historical_records(session_id)?;
    Ok(crate::pipeline::MessagePipeline::convert_historical(
        &historical,
    ))
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
// Session write operations
// ---------------------------------------------------------------------------

pub fn create_session(workspace_id: &str) -> Result<sessions::CreateSessionResponse> {
    sessions::create_session(workspace_id)
}

pub fn delete_session(session_id: &str) -> Result<()> {
    sessions::delete_session(session_id)
}

pub fn hide_session(session_id: &str) -> Result<()> {
    sessions::hide_session(session_id)
}

pub fn unhide_session(session_id: &str) -> Result<()> {
    sessions::unhide_session(session_id)
}

pub fn rename_session(session_id: &str, title: &str) -> Result<()> {
    sessions::rename_session(session_id, title)
}

pub fn mark_session_read(session_id: &str) -> Result<()> {
    sessions::mark_session_read(session_id)
}

pub fn update_session_settings(
    session_id: &str,
    effort_level: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<()> {
    let connection = db::open_connection(true)?;
    connection
        .execute(
            r#"
            UPDATE sessions SET
              effort_level = COALESCE(?2, effort_level),
              permission_mode = COALESCE(?3, permission_mode)
            WHERE id = ?1
            "#,
            rusqlite::params![session_id, effort_level, permission_mode],
        )
        .context("Failed to update session settings")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Workspace write operations
// ---------------------------------------------------------------------------

pub fn mark_workspace_read(workspace_id: &str) -> Result<()> {
    workspaces::mark_workspace_read(workspace_id)
}

pub fn mark_workspace_unread(workspace_id: &str) -> Result<()> {
    workspaces::mark_workspace_unread(workspace_id)
}

pub fn pin_workspace(workspace_id: &str) -> Result<()> {
    workspaces::pin_workspace(workspace_id)
}

pub fn unpin_workspace(workspace_id: &str) -> Result<()> {
    workspaces::unpin_workspace(workspace_id)
}

pub fn set_workspace_manual_status(workspace_id: &str, status: Option<&str>) -> Result<()> {
    workspaces::set_workspace_manual_status(workspace_id, status)
}

pub fn archive_workspace(workspace_id: &str) -> Result<workspaces::ArchiveWorkspaceResponse> {
    workspaces::archive_workspace_impl(workspace_id)
}

pub fn restore_workspace(workspace_id: &str) -> Result<workspaces::RestoreWorkspaceResponse> {
    workspaces::restore_workspace_impl(workspace_id)
}

pub fn create_workspace_from_repo(repo_id: &str) -> Result<workspaces::CreateWorkspaceResponse> {
    workspaces::create_workspace_from_repo_impl(repo_id)
}

pub fn permanently_delete_workspace(workspace_id: &str) -> Result<()> {
    workspaces::permanently_delete_workspace(workspace_id)
}

pub fn update_intended_target_branch(workspace_id: &str, target_branch: &str) -> Result<()> {
    workspaces::update_intended_target_branch(workspace_id, target_branch)
}

pub fn update_app_settings(updates: HashMap<String, String>) -> Result<()> {
    for (key, value) in &updates {
        if !key.starts_with("app.") && !key.starts_with("branch_prefix_") {
            continue;
        }
        settings::upsert_setting_value(key, value)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Streaming agent support
// ---------------------------------------------------------------------------

use crate::agents::{
    find_model_definition, resolve_working_directory, AgentSendRequest, AgentStreamEvent,
    AgentStreamStartResponse,
};
use crate::sidecar::{ManagedSidecar, SidecarRequest};

/// Start a streaming agent request via the sidecar.
///
/// Returns the stream ID and a sync receiver that yields `AgentStreamEvent`s.
/// The caller is responsible for consuming the receiver (e.g. forwarding to SSE).
pub fn start_agent_stream(
    sidecar: &ManagedSidecar,
    request: AgentSendRequest,
) -> Result<(
    AgentStreamStartResponse,
    std::sync::mpsc::Receiver<AgentStreamEvent>,
)> {
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        anyhow::bail!("Prompt cannot be empty.");
    }

    let model = find_model_definition(&request.model_id)
        .ok_or_else(|| anyhow::anyhow!("Unknown model id: {}", request.model_id))?;

    if request.provider != model.provider {
        anyhow::bail!(
            "Model {} does not belong to provider {}.",
            request.model_id,
            request.provider
        );
    }

    let working_directory = resolve_working_directory(request.working_directory.as_deref())?;
    let stream_id = uuid::Uuid::new_v4().to_string();

    let resume_session_id = request.session_id.clone().or_else(|| {
        request.helmor_session_id.as_deref().and_then(|hsid| {
            let conn = db::open_connection(false).ok()?;
            let (stored_sid, stored_provider): (Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT provider_session_id, agent_type FROM sessions WHERE id = ?1",
                    [hsid],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok()?;
            let sid = stored_sid?;
            if stored_provider.unwrap_or_default() == model.provider {
                Some(sid)
            } else {
                None
            }
        })
    });

    let helmor_session_id = request.helmor_session_id.clone();
    let sidecar_session_id = helmor_session_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let sidecar_req = SidecarRequest {
        id: stream_id.clone(),
        method: "sendMessage".to_string(),
        params: serde_json::json!({
            "sessionId": sidecar_session_id,
            "prompt": prompt,
            "model": model.cli_model,
            "cwd": working_directory.display().to_string(),
            "resume": resume_session_id,
            "provider": model.provider,
            "effortLevel": request.effort_level,
            "permissionMode": request.permission_mode,
        }),
    };

    // Subscribe BEFORE sending
    let sidecar_rx = sidecar.subscribe(&stream_id);

    if let Err(e) = sidecar.send(&sidecar_req) {
        sidecar.unsubscribe(&stream_id);
        anyhow::bail!("Sidecar send failed: {e}");
    }

    // Create a channel that converts SidecarEvents → AgentStreamEvents
    let (tx, rx) = std::sync::mpsc::channel::<AgentStreamEvent>();
    let rid = stream_id.clone();
    let model_id = model.id.to_string();
    let provider = model.provider.to_string();
    let model_cli = model.cli_model.to_string();
    let working_dir_str = working_directory.display().to_string();
    let context_key = stream_id.clone();
    let pipeline_session_id = sidecar_session_id.clone();

    std::thread::Builder::new()
        .name(format!("dev-stream-{}", &stream_id[..8]))
        .spawn(move || {
            let mut pipeline = crate::pipeline::MessagePipeline::new(
                &provider,
                &model_cli,
                &context_key,
                &pipeline_session_id,
            );

            for event in sidecar_rx.iter() {
                match event.event_type() {
                    "end" => {
                        let _ = tx.send(AgentStreamEvent::Done {
                            provider: provider.clone(),
                            model_id: model_id.clone(),
                            resolved_model: model_id.clone(),
                            session_id: event.session_id().map(str::to_string),
                            working_directory: working_dir_str.clone(),
                            persisted: false,
                        });
                        break;
                    }
                    "aborted" => {
                        let reason = event
                            .raw
                            .get("reason")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("user_requested")
                            .to_string();
                        let _ = tx.send(AgentStreamEvent::Aborted {
                            provider: provider.clone(),
                            model_id: model_id.clone(),
                            resolved_model: model_id.clone(),
                            session_id: event.session_id().map(str::to_string),
                            working_directory: working_dir_str.clone(),
                            persisted: false,
                            reason,
                        });
                        break;
                    }
                    "error" => {
                        let msg = event
                            .raw
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("Unknown sidecar error")
                            .to_string();
                        let _ = tx.send(AgentStreamEvent::Error {
                            message: msg,
                            persisted: false,
                        });
                        break;
                    }
                    _ => {
                        let line = serde_json::to_string(&event.raw).unwrap_or_default();
                        if !line.is_empty() && line != "{}" {
                            match pipeline.push_event(&event.raw, &line) {
                                crate::pipeline::PipelineEmit::Full(messages) => {
                                    let _ = tx.send(AgentStreamEvent::Update { messages });
                                }
                                crate::pipeline::PipelineEmit::Partial(message) => {
                                    let _ = tx.send(AgentStreamEvent::StreamingPartial { message });
                                }
                                crate::pipeline::PipelineEmit::None => {}
                            }
                        }
                    }
                }
            }
            drop(sidecar_rx);
            let _ = &rid;
        })
        .context("Failed to spawn dev stream reader thread")?;

    Ok((AgentStreamStartResponse { stream_id }, rx))
}

pub fn stop_agent_stream(
    sidecar: &ManagedSidecar,
    session_id: &str,
    provider: Option<&str>,
) -> Result<()> {
    let stop_req = SidecarRequest {
        id: uuid::Uuid::new_v4().to_string(),
        method: "stopSession".to_string(),
        params: serde_json::json!({
            "sessionId": session_id,
            "provider": provider.unwrap_or("claude"),
        }),
    };
    sidecar
        .send(&stop_req)
        .map_err(|e| anyhow::anyhow!("Failed to stop session: {e}"))?;
    Ok(())
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
