use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::CmdResult;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSessionTitleRequest {
    pub session_id: String,
    pub user_message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSessionTitleResponse {
    pub title: Option<String>,
    pub skipped: bool,
}

/// Sidecar response timeout — generous to cover LLM latency + sidecar's own
/// 15 s abort, but bounded so we never block a Tauri command thread forever.
const TITLE_GEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub async fn generate_session_title(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: GenerateSessionTitleRequest,
) -> CmdResult<GenerateSessionTitleResponse> {
    {
        let connection =
            open_write_connection().map_err(|e| anyhow::anyhow!("Failed to open DB: {e}"))?;
        let current_title: String = connection
            .query_row(
                "SELECT title FROM sessions WHERE id = ?1",
                [&request.session_id],
                |row| row.get(0),
            )
            .map_err(|e| anyhow::anyhow!("Session not found: {e}"))?;

        if current_title != "Untitled" {
            return Ok(GenerateSessionTitleResponse {
                title: None,
                skipped: true,
            });
        }
    }

    let request_id = Uuid::new_v4().to_string();
    let sidecar_req = crate::sidecar::SidecarRequest {
        id: request_id.clone(),
        method: "generateTitle".to_string(),
        params: serde_json::json!({
            "userMessage": request.user_message,
        }),
    };

    let rx = sidecar.subscribe(&request_id);

    if let Err(e) = sidecar.send(&sidecar_req) {
        sidecar.unsubscribe(&request_id);
        return Err(anyhow::anyhow!("Sidecar send failed: {e}").into());
    }

    let session_id = request.session_id.clone();
    let result: (Option<String>, Option<String>) = tauri::async_runtime::spawn_blocking({
        let rid = request_id;
        move || {
            let sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecar> = app.state();
            let mut title: Option<String> = None;
            let mut branch_name: Option<String> = None;

            loop {
                match rx.recv_timeout(TITLE_GEN_TIMEOUT) {
                    Ok(event) => match event.event_type() {
                        "titleGenerated" => {
                            title = event
                                .raw
                                .get("title")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .filter(|text| !text.is_empty());
                            branch_name = event
                                .raw
                                .get("branchName")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .filter(|branch| !branch.is_empty());
                            break;
                        }
                        "error" => {
                            let message = event
                                .raw
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Unknown error");
                            tracing::error!("generate_session_title: sidecar error: {message}");
                            break;
                        }
                        _ => {}
                    },
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        tracing::error!(
                            "generate_session_title: timed out after {TITLE_GEN_TIMEOUT:?}"
                        );
                        break;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        tracing::error!("generate_session_title: sidecar disconnected");
                        break;
                    }
                }
            }

            sidecar_state.unsubscribe(&rid);
            (title, branch_name)
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("Title generation task failed: {e}"))?;

    let (generated_title, generated_branch) = result;

    if let Some(ref title) = generated_title {
        crate::sessions::rename_session(&session_id, title)
            .map_err(|e| anyhow::anyhow!("Failed to rename session: {e}"))?;
    }

    if let Some(ref branch_segment) = generated_branch {
        // Look up workspace via sessions.workspace_id — works for any session,
        // not just the currently active one.
        let workspace_info: Option<(String, Option<String>, String)> = {
            let connection =
                open_write_connection().map_err(|e| anyhow::anyhow!("Failed to open DB: {e}"))?;
            connection
                .query_row(
                    r#"SELECT w.id, r.root_path, w.directory_name
                       FROM workspaces w
                       JOIN repos r ON r.id = w.repository_id
                       JOIN sessions s ON s.workspace_id = w.id
                       WHERE s.id = ?1 AND w.state = 'ready'"#,
                    [&session_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .ok()
        };

        if let Some((workspace_id, root_path, directory_name)) = workspace_info {
            let branch_settings = crate::settings::load_branch_prefix_settings().unwrap_or(
                crate::settings::BranchPrefixSettings {
                    branch_prefix_type: None,
                    branch_prefix_custom: None,
                },
            );

            // Acquire per-workspace lock so concurrent title-gens serialise
            // their branch renames instead of racing on `git branch -m`.
            let ws_lock = crate::models::db::workspace_mutation_lock(&workspace_id);
            let _guard = ws_lock.lock().await;

            // Re-read branch under lock to avoid TOCTOU: if another title-gen
            // already renamed the branch, we'll see the updated value and skip.
            let connection =
                open_write_connection().map_err(|e| anyhow::anyhow!("Failed to open DB: {e}"))?;
            let old_branch: Option<String> = connection
                .query_row(
                    "SELECT branch FROM workspaces WHERE id = ?1",
                    [&workspace_id],
                    |row| row.get(0),
                )
                .ok()
                .flatten();

            if !old_branch.as_deref().is_some_and(|b| {
                crate::helpers::is_default_branch_name(b, &directory_name, &branch_settings)
            }) {
                tracing::debug!(
                    workspace_id = %workspace_id,
                    "Skipping auto branch rename: branch already differs from default"
                );
            } else {
                let new_branch =
                    crate::helpers::branch_name_for_directory(branch_segment, &branch_settings);

                if old_branch.as_deref() != Some(new_branch.as_str()) {
                    let fs_rename_attempted = matches!(
                        (&old_branch, &root_path),
                        (Some(_), Some(ref repo_root)) if std::path::Path::new(repo_root).is_dir()
                    );

                    let fs_rename_ok = if let (Some(ref old_name), Some(ref repo_root)) =
                        (&old_branch, &root_path)
                    {
                        if std::path::Path::new(repo_root).is_dir() {
                            match crate::git_ops::run_git(
                                ["-C", repo_root, "branch", "-m", old_name, &new_branch],
                                None,
                            ) {
                                Ok(_) => true,
                                Err(error) => {
                                    tracing::error!(old = old_name, new = %new_branch, "git branch -m failed: {error:#}; leaving branch unchanged");
                                    false
                                }
                            }
                        } else {
                            true
                        }
                    } else {
                        true
                    };

                    if fs_rename_ok {
                        if let Err(error) = connection.execute(
                            "UPDATE workspaces SET branch = ?1 WHERE id = ?2",
                            (&new_branch, &workspace_id),
                        ) {
                            tracing::error!(workspace_id = %workspace_id, "DB UPDATE workspaces.branch failed: {error:#}");
                            if fs_rename_attempted {
                                if let (Some(ref old_name), Some(ref repo_root)) =
                                    (&old_branch, &root_path)
                                {
                                    if let Err(rb_err) = crate::git_ops::run_git(
                                        ["-C", repo_root, "branch", "-m", &new_branch, old_name],
                                        None,
                                    ) {
                                        tracing::error!(fs = %new_branch, db = old_name, "FS rollback git branch -m also failed: {rb_err:#} — manual reconciliation required");
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(GenerateSessionTitleResponse {
        title: generated_title,
        skipped: false,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSlashCommandsRequest {
    pub provider: String,
    pub working_directory: Option<String>,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandEntry {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    pub source: String,
}

pub async fn list_slash_commands(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: ListSlashCommandsRequest,
) -> CmdResult<Vec<SlashCommandEntry>> {
    let request_id = Uuid::new_v4().to_string();

    let mut params = serde_json::Map::new();
    params.insert("provider".into(), Value::String(request.provider.clone()));
    if let Some(cwd) = request.working_directory.as_ref() {
        params.insert("cwd".into(), Value::String(cwd.clone()));
    }
    if let Some(model) = request.model_id.as_ref() {
        params.insert("model".into(), Value::String(model.clone()));
    }

    let sidecar_req = crate::sidecar::SidecarRequest {
        id: request_id.clone(),
        method: "listSlashCommands".to_string(),
        params: Value::Object(params),
    };

    let rx = sidecar.subscribe(&request_id);
    if let Err(e) = sidecar.send(&sidecar_req) {
        sidecar.unsubscribe(&request_id);
        return Err(anyhow::anyhow!("Sidecar send failed: {e}").into());
    }

    let result: CmdResult<Vec<SlashCommandEntry>> = tauri::async_runtime::spawn_blocking({
        let rid = request_id.clone();
        move || {
            let sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecar> = app.state();
            let mut commands: Vec<SlashCommandEntry> = Vec::new();
            let mut error: Option<String> = None;
            let timeout = std::time::Duration::from_secs(10);

            loop {
                match rx.recv_timeout(timeout) {
                    Ok(event) => match event.event_type() {
                        "slashCommandsListed" => {
                            if let Some(entries) =
                                event.raw.get("commands").and_then(Value::as_array)
                            {
                                for entry in entries {
                                    let Some(name) = entry.get("name").and_then(Value::as_str)
                                    else {
                                        continue;
                                    };
                                    let description = entry
                                        .get("description")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_string();
                                    let argument_hint = entry
                                        .get("argumentHint")
                                        .and_then(Value::as_str)
                                        .filter(|hint| !hint.is_empty())
                                        .map(str::to_string);
                                    let source = entry
                                        .get("source")
                                        .and_then(Value::as_str)
                                        .unwrap_or("builtin")
                                        .to_string();
                                    commands.push(SlashCommandEntry {
                                        name: name.to_string(),
                                        description,
                                        argument_hint,
                                        source,
                                    });
                                }
                            }
                            break;
                        }
                        "error" => {
                            error = Some(
                                event
                                    .raw
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Unknown error")
                                    .to_string(),
                            );
                            break;
                        }
                        _ => {}
                    },
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        error = Some("listSlashCommands timed out after 10s".to_string());
                        break;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        error = Some(
                            "Sidecar disconnected while waiting for slash commands".to_string(),
                        );
                        break;
                    }
                }
            }

            sidecar_state.unsubscribe(&rid);
            if let Some(message) = error {
                Err(anyhow::anyhow!("listSlashCommands failed: {message}").into())
            } else {
                Ok(commands)
            }
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("listSlashCommands task failed: {e}"))?;

    result
}

fn open_write_connection() -> Result<rusqlite::Connection> {
    crate::models::db::open_connection(true)
}
