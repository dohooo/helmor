use crate::models::sessions::mark_session_read_in_transaction;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, Manager};
use uuid::Uuid;

use crate::error::CommandError;

type CmdResult<T> = std::result::Result<T, CommandError>;

// ---------------------------------------------------------------------------
// Streaming event types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AgentStreamEvent {
    /// Full snapshot — sent on finalization events (assistant, user, result).
    /// The frontend replaces its entire message array.
    Update {
        messages: Vec<crate::pipeline::types::ThreadMessageLike>,
    },
    /// Only the streaming partial changed — sent on stream deltas.
    /// The frontend replaces only the trailing streaming message.
    /// IPC payload: ~one message instead of the entire conversation.
    StreamingPartial {
        message: crate::pipeline::types::ThreadMessageLike,
    },
    Done {
        provider: String,
        model_id: String,
        resolved_model: String,
        session_id: Option<String>,
        working_directory: String,
        persisted: bool,
    },
    /// User-initiated termination (stop button or app shutdown). The UI
    /// treats this as a non-error state. Persisted state includes the
    /// flushed turns and sets `sessions.status = 'aborted'`.
    Aborted {
        provider: String,
        model_id: String,
        resolved_model: String,
        session_id: Option<String>,
        working_directory: String,
        persisted: bool,
        reason: String,
    },
    PermissionRequest {
        #[serde(rename = "permissionId")]
        permission_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "toolInput")]
        tool_input: Value,
        title: Option<String>,
        description: Option<String>,
    },
    Error {
        message: String,
        persisted: bool,
        /// True when the error is an unexpected internal failure (e.g. sidecar
        /// crash). The frontend should show a generic message instead of details.
        internal: bool,
    },
}

// ---------------------------------------------------------------------------
// Active streams registry — tracks in-flight sendMessage requests so that
// graceful shutdown can iterate them and send a stopSession to each.
// ---------------------------------------------------------------------------

/// Identifying info for an in-flight stream, kept in `ActiveStreams`.
#[derive(Debug, Clone)]
pub struct ActiveStreamHandle {
    /// Sidecar request id (also the listener key in `ManagedSidecar`).
    pub request_id: String,
    /// The id passed as `sessionId` in the sidecar `sendMessage` params.
    /// `stopSession` needs this to find the right `AbortController` inside
    /// the sidecar's session manager.
    pub sidecar_session_id: String,
    /// Provider tag — picks the right session manager on the sidecar side.
    pub provider: String,
}

/// Tauri-managed registry of in-flight streams. Cheap to clone the handles;
/// the lock is held only briefly inside register/unregister/snapshot.
#[derive(Default)]
pub struct ActiveStreams {
    inner: Arc<Mutex<HashMap<String, ActiveStreamHandle>>>,
}

impl ActiveStreams {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, handle: ActiveStreamHandle) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(handle.request_id.clone(), handle);
        }
    }

    pub fn unregister(&self, request_id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(request_id);
        }
    }

    pub fn snapshot(&self) -> Vec<ActiveStreamHandle> {
        self.inner
            .lock()
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|map| map.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Abort all active streams and wait (up to `timeout`) for them to drain.
/// Sends a `stopSession` for each in-flight request, then polls
/// `ActiveStreams` until every entry unregisters itself. If the timeout
/// fires first, the sidecar process's Drop impl SIGKILLs it.
pub fn abort_all_active_streams_blocking(
    sidecar: &crate::sidecar::ManagedSidecar,
    active: &ActiveStreams,
    timeout: Duration,
) {
    let handles = active.snapshot();
    if handles.is_empty() {
        return;
    }

    tracing::info!(count = handles.len(), "Graceful shutdown — aborting active streams");

    for handle in &handles {
        let stop_req = crate::sidecar::SidecarRequest {
            id: Uuid::new_v4().to_string(),
            method: "stopSession".to_string(),
            params: serde_json::json!({
                "sessionId": handle.sidecar_session_id,
                "provider": handle.provider,
            }),
        };
        if let Err(e) = sidecar.send(&stop_req) {
            tracing::error!(request_id = %handle.request_id, "Failed to send stopSession during shutdown: {e}");
        }
    }

    // Poll until all streams have unregistered themselves (each per-request
    // event loop unregisters as soon as it processes the aborted event and
    // returns from the spawn_blocking closure).
    let start = Instant::now();
    let poll = Duration::from_millis(50);
    while !active.is_empty() && start.elapsed() < timeout {
        std::thread::sleep(poll);
    }

    let remaining = active.len();
    if remaining == 0 {
        tracing::info!("Graceful shutdown — all streams drained cleanly");
    } else {
        tracing::info!(remaining, "Graceful shutdown — timeout, streams still active");
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamStartResponse {
    pub stream_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelOption {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub cli_model: String,
    pub badge: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelSection {
    pub id: String,
    pub label: String,
    pub options: Vec<AgentModelOption>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendRequest {
    pub provider: String,
    pub model_id: String,
    pub prompt: String,
    pub session_id: Option<String>,
    pub helmor_session_id: Option<String>,
    pub working_directory: Option<String>,
    pub effort_level: Option<String>,
    pub permission_mode: Option<String>,
    pub user_message_id: Option<String>,
    /// Workspace-relative paths from the @-mention picker.
    #[serde(default)]
    pub files: Option<Vec<String>>,
}

// Re-export pipeline types used by persistence functions in this file.
use crate::pipeline::types::{AgentUsage, CollectedTurn};

/// Context shared across incremental persistence calls within a single exchange.
struct ExchangeContext {
    helmor_session_id: String,
    turn_id: String,
    model_id: String,
    model_provider: String,
    assistant_sdk_message_id: String,
    user_message_id: String,
}

#[derive(Debug, Clone, Copy)]
pub struct AgentModelDefinition {
    pub id: &'static str,
    pub provider: &'static str,
    pub label: &'static str,
    pub cli_model: &'static str,
    pub badge: Option<&'static str>,
}

const CLAUDE_MODEL_DEFINITIONS: &[AgentModelDefinition] = &[
    AgentModelDefinition {
        id: "opus-1m",
        provider: "claude",
        label: "Opus 4.6 1M",
        cli_model: "opus[1m]",
        badge: Some("NEW"),
    },
    AgentModelDefinition {
        id: "opus",
        provider: "claude",
        label: "Opus 4.6",
        cli_model: "opus",
        badge: None,
    },
    AgentModelDefinition {
        id: "sonnet",
        provider: "claude",
        label: "Sonnet 4.6",
        cli_model: "sonnet",
        badge: None,
    },
    AgentModelDefinition {
        id: "haiku",
        provider: "claude",
        label: "Haiku 4.5",
        cli_model: "haiku",
        badge: None,
    },
];

const CODEX_MODEL_DEFINITIONS: &[AgentModelDefinition] = &[
    AgentModelDefinition {
        id: "gpt-5.4",
        provider: "codex",
        label: "GPT-5.4",
        cli_model: "gpt-5.4",
        badge: Some("NEW"),
    },
    AgentModelDefinition {
        id: "gpt-5.4-mini",
        provider: "codex",
        label: "GPT-5.4-Mini",
        cli_model: "gpt-5.4-mini",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.3-codex",
        provider: "codex",
        label: "GPT-5.3-Codex",
        cli_model: "gpt-5.3-codex",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.2-codex",
        provider: "codex",
        label: "GPT-5.2-Codex",
        cli_model: "gpt-5.2-codex",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.2",
        provider: "codex",
        label: "GPT-5.2",
        cli_model: "gpt-5.2",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.1-codex-max",
        provider: "codex",
        label: "GPT-5.1-Codex-Max",
        cli_model: "gpt-5.1-codex-max",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.1-codex-mini",
        provider: "codex",
        label: "GPT-5.1-Codex-Mini",
        cli_model: "gpt-5.1-codex-mini",
        badge: None,
    },
];

#[tauri::command]
pub fn list_agent_model_sections() -> Vec<AgentModelSection> {
    vec![
        AgentModelSection {
            id: "claude".to_string(),
            label: "Claude Code".to_string(),
            options: CLAUDE_MODEL_DEFINITIONS
                .iter()
                .map(model_definition_to_option)
                .collect(),
        },
        AgentModelSection {
            id: "codex".to_string(),
            label: "Codex".to_string(),
            options: CODEX_MODEL_DEFINITIONS
                .iter()
                .map(model_definition_to_option)
                .collect(),
        },
    ]
}

#[tauri::command]
pub async fn send_agent_message_stream(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: AgentSendRequest,
    on_event: Channel<AgentStreamEvent>,
) -> CmdResult<()> {
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(anyhow::anyhow!("Prompt cannot be empty.").into());
    }

    let model = find_model_definition(&request.model_id)
        .ok_or_else(|| anyhow::anyhow!("Unknown model id: {}", request.model_id))?;

    if request.provider != model.provider {
        return Err(anyhow::anyhow!(
            "Model {} does not belong to provider {}.",
            request.model_id,
            request.provider
        )
        .into());
    }

    let working_directory = resolve_working_directory(request.working_directory.as_deref())?;
    let stream_id = Uuid::new_v4().to_string();

    let active_streams = app.state::<ActiveStreams>();

    // All providers go through the sidecar
    stream_via_sidecar(
        app.clone(),
        on_event,
        &sidecar,
        &active_streams,
        &stream_id,
        model,
        &prompt,
        &request,
        &working_directory,
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStopRequest {
    pub session_id: String,
    pub provider: Option<String>,
}

#[tauri::command]
pub async fn stop_agent_stream(
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: AgentStopRequest,
) -> CmdResult<()> {
    let stop_req = crate::sidecar::SidecarRequest {
        id: Uuid::new_v4().to_string(),
        method: "stopSession".to_string(),
        params: serde_json::json!({
            "sessionId": request.session_id,
            "provider": request.provider.unwrap_or_else(|| "claude".to_string()),
        }),
    };
    sidecar
        .send(&stop_req)
        .map_err(|e| anyhow::anyhow!("Failed to stop session: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponseRequest {
    pub permission_id: String,
    pub behavior: String,
}

#[tauri::command]
pub async fn respond_to_permission_request(
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: PermissionResponseRequest,
) -> CmdResult<()> {
    tracing::info!(permission_id = %request.permission_id, behavior = %request.behavior, "Permission response");
    let req = crate::sidecar::SidecarRequest {
        id: Uuid::new_v4().to_string(),
        method: "permissionResponse".to_string(),
        params: serde_json::json!({
            "permissionId": request.permission_id,
            "behavior": request.behavior,
        }),
    };
    sidecar
        .send(&req)
        .map_err(|e| anyhow::anyhow!("Failed to send permission response: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Session auto-title generation
// ---------------------------------------------------------------------------

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

/// Generate a short title for a session based on the user's first message.
///
/// Checks if the session title is still "Untitled" — if it has already been
/// renamed, the call is a no-op (returns `skipped: true`).
///
/// Uses the sidecar's `generateTitle` method (Claude haiku) to produce
/// a concise title, then persists it to the database.
#[tauri::command]
pub async fn generate_session_title(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: GenerateSessionTitleRequest,
) -> CmdResult<GenerateSessionTitleResponse> {
    // 1. Check whether the session still needs a title
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

    // 2. Ask the sidecar to generate a title
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

    // 3. Wait for the titleGenerated or error event (blocking thread)
    let session_id = request.session_id.clone();
    let result: (Option<String>, Option<String>) = tauri::async_runtime::spawn_blocking({
        let rid = request_id;
        move || {
            let sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecar> = app.state();
            let mut title: Option<String> = None;
            let mut branch_name: Option<String> = None;

            for event in rx.iter() {
                match event.event_type() {
                    "titleGenerated" => {
                        title = event
                            .raw
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .filter(|t| !t.is_empty());
                        branch_name = event
                            .raw
                            .get("branchName")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .filter(|b| !b.is_empty());
                        break;
                    }
                    "error" => {
                        let msg = event
                            .raw
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Unknown error");
                        tracing::error!("generate_session_title: sidecar error: {msg}");
                        break;
                    }
                    _ => {
                        // Ignore intermediate events (e.g. streaming deltas)
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

    // 4. Persist title to DB
    if let Some(ref title) = generated_title {
        crate::models::sessions::rename_session(&session_id, title)
            .map_err(|e| anyhow::anyhow!("Failed to rename session: {e}"))?;
    }

    // 5. Rename git branch if a branch name was generated
    if let Some(ref branch_segment) = generated_branch {
        let connection =
            open_write_connection().map_err(|e| anyhow::anyhow!("Failed to open DB: {e}"))?;

        // Find the workspace for this session
        let ws_info: Option<(String, Option<String>, Option<String>)> = connection
            .query_row(
                r#"SELECT w.id, w.branch, r.root_path
                   FROM workspaces w
                   JOIN repos r ON r.id = w.repository_id
                   WHERE w.active_session_id = ?1 AND w.state = 'ready'"#,
                [&session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();

        if let Some((workspace_id, old_branch, root_path)) = ws_info {
            let branch_settings = crate::models::settings::load_branch_prefix_settings().unwrap_or(
                crate::models::settings::BranchPrefixSettings {
                    branch_prefix_type: None,
                    branch_prefix_custom: None,
                },
            );
            let new_branch =
                crate::models::helpers::branch_name_for_directory(branch_segment, &branch_settings);

            if old_branch.as_deref() != Some(new_branch.as_str()) {
                // Rename the workspace's branch on disk and in the DB.
                //
                // Both must succeed (or both must be skipped) — otherwise the
                // worktree's actual branch and `workspaces.branch` drift, and
                // the next archive/restore deletes/restores the wrong branch.
                //
                // The whole rename is best-effort cosmetics for the title-
                // generation flow, so any failure is logged and swallowed
                // — but never partial.
                let fs_rename_attempted = matches!(
                    (&old_branch, &root_path),
                    (Some(_), Some(repo_root)) if std::path::Path::new(repo_root).is_dir()
                );

                let fs_rename_ok = if let (Some(ref old_name), Some(ref repo_root)) =
                    (&old_branch, &root_path)
                {
                    if std::path::Path::new(repo_root).is_dir() {
                        match crate::models::git_ops::run_git(
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

                // Only touch the DB if the FS side either succeeded or was
                // skipped entirely (no repo). Skipping the DB update on FS
                // failure keeps the two sides consistent at the OLD name.
                if fs_rename_ok {
                    if let Err(error) = connection.execute(
                        "UPDATE workspaces SET branch = ?1 WHERE id = ?2",
                        (&new_branch, &workspace_id),
                    ) {
                        tracing::error!(workspace_id = %workspace_id, "DB UPDATE workspaces.branch failed: {error:#}");
                        // Roll back the FS rename so the two sides agree.
                        if fs_rename_attempted {
                            if let (Some(ref old_name), Some(ref repo_root)) =
                                (&old_branch, &root_path)
                            {
                                if let Err(rb_err) = crate::models::git_ops::run_git(
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

    Ok(GenerateSessionTitleResponse {
        title: generated_title,
        skipped: false,
    })
}

// ---------------------------------------------------------------------------
// Slash command discovery — unified across providers.
// ---------------------------------------------------------------------------

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

/// Look up the slash commands the composer popup should show. The Claude
/// path uses the SDK's `Query.supportedCommands()` control protocol; the
/// Codex path scans the documented Codex skill directories on disk. Both
/// produce the same shape so the frontend can render either uniformly.
#[tauri::command]
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
                            if let Some(arr) = event.raw.get("commands").and_then(Value::as_array) {
                                for entry in arr {
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
                                        .filter(|s| !s.is_empty())
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
            if let Some(msg) = error {
                Err(anyhow::anyhow!("listSlashCommands failed: {msg}").into())
            } else {
                Ok(commands)
            }
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("listSlashCommands task failed: {e}"))?;

    result
}

#[allow(clippy::too_many_arguments)]
fn stream_via_sidecar(
    app: AppHandle,
    on_event: Channel<AgentStreamEvent>,
    sidecar: &crate::sidecar::ManagedSidecar,
    active_streams: &ActiveStreams,
    stream_id: &str,
    model: &AgentModelDefinition,
    prompt: &str,
    request: &AgentSendRequest,
    working_directory: &Path,
) -> CmdResult<()> {
    let request_id = stream_id.to_string();

    tracing::debug!(
        provider = %model.provider,
        model = %model.cli_model,
        cwd = %working_directory.display(),
        prompt_len = prompt.len(),
        "stream_via_sidecar"
    );

    // Resume id: prefer the one the frontend passed, otherwise look it up
    // in the DB. Provider isolation only — passing a Codex thread id to
    // Claude (or vice versa) is the only thing we filter out.
    let resume_session_id = request.session_id.clone().or_else(|| {
        request.helmor_session_id.as_deref().and_then(|hsid| {
            let conn = open_write_connection().ok()?;
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

    tracing::debug!(
        resume_session_id = ?resume_session_id,
        helmor_session_id = ?request.helmor_session_id,
        provider = %model.provider,
        "Session resume context"
    );

    let helmor_session_id = request.helmor_session_id.clone();

    // Sidecar needs a string session id; fall back to a throwaway UUID
    // when the frontend didn't attach one (e.g. pre-persistence calls).
    let sidecar_session_id = helmor_session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let sidecar_req = crate::sidecar::SidecarRequest {
        id: request_id.clone(),
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

    // Subscribe to events for this request BEFORE sending (no race)
    let rx = sidecar.subscribe(&request_id);

    if let Err(e) = sidecar.send(&sidecar_req) {
        sidecar.unsubscribe(&request_id);
        return Err(anyhow::anyhow!("Sidecar send failed: {e}").into());
    }

    // Register in the active-streams registry so graceful shutdown can find
    // and abort us. Unregistration happens at the end of the spawn_blocking
    // closure below — covering all exit paths (end / aborted / error / EOF).
    active_streams.register(ActiveStreamHandle {
        request_id: request_id.clone(),
        sidecar_session_id: sidecar_session_id.clone(),
        provider: model.provider.to_string(),
    });

    // Read events in background and forward to frontend via Channel
    let model_id = model.id.to_string();
    let provider = model.provider.to_string();
    let model_copy = *model;
    let prompt_copy = prompt.to_string();
    let working_dir_str = working_directory.display().to_string();
    let hsid_copy = helmor_session_id;
    let effort_copy = request.effort_level.clone();
    let permission_mode_copy = request.permission_mode.clone();
    let user_message_id_copy = request.user_message_id.clone();
    let files_copy = request.files.clone().unwrap_or_default();
    let rid = request_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecar> = app.state();
        let active_streams_state: tauri::State<'_, ActiveStreams> = app.state();
        let mut resolved_session_id: Option<String> = None;
        // Pipeline produces `ThreadMessageLike[]` directly, with hash-based
        // change detection to skip redundant emits.
        let context_key = rid.clone();
        let pipeline_session_id = hsid_copy.clone().unwrap_or_else(|| context_key.clone());
        let mut pipeline = hsid_copy.as_ref().map(|_| {
            crate::pipeline::MessagePipeline::new(
                provider.as_str(),
                model_copy.cli_model,
                &context_key,
                &pipeline_session_id,
            )
        });
        let mut event_count: u64 = 0;

        // --- Incremental persistence setup ---
        let mut exchange_ctx: Option<ExchangeContext> = None;
        let mut persisted_turn_count: usize = 0;
        let db_conn = if hsid_copy.is_some() {
            open_write_connection().ok()
        } else {
            None
        };

        if let (Some(hsid), Some(conn)) = (&hsid_copy, &db_conn) {
            let ctx = ExchangeContext {
                helmor_session_id: hsid.clone(),
                turn_id: Uuid::new_v4().to_string(),
                model_id: model_copy.id.to_string(),
                model_provider: model_copy.provider.to_string(),
                assistant_sdk_message_id: format!("helmor-assistant-{}", Uuid::new_v4()),
                user_message_id: user_message_id_copy
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
            };

            match persist_user_message(conn, &ctx, &prompt_copy, &files_copy) {
                Ok(()) => {
                    tracing::debug!(rid = %rid, "User message persisted to DB");
                    exchange_ctx = Some(ctx);
                }
                Err(e) => {
                    tracing::error!(rid = %rid, "Failed to persist user message: {e}");
                }
            }
        }

        tracing::debug!(rid = %rid, "Waiting for sidecar events...");

        // Receive events from our dedicated channel (dispatched by request ID)
        for event in rx.iter() {
            event_count += 1;

            // Sole writer of `provider_session_id`. The first event with a
            // session_id wins; everything after is a no-op. If no event ever
            // carries one, the row stays untouched.
            if let Some(sid) = event.session_id() {
                if resolved_session_id.is_none() {
                    resolved_session_id = Some(sid.to_string());
                    if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
                        if let Err(e) = conn.execute(
                            "UPDATE sessions SET provider_session_id = ?2, agent_type = ?3 WHERE id = ?1",
                            params![ctx.helmor_session_id, sid, ctx.model_provider],
                        ) {
                            tracing::error!(rid = %rid, "Failed to persist session id: {e}");
                        } else {
                            tracing::debug!(rid = %rid, provider_session_id = sid, "Session ID persisted");
                        }
                    }
                }
            }

            match event.event_type() {
                "end" | "aborted" => {
                    let is_aborted = event.event_type() == "aborted";
                    let reason = if is_aborted {
                        Some(
                            event
                                .raw
                                .get("reason")
                                .and_then(Value::as_str)
                                .unwrap_or("user_requested")
                                .to_string(),
                        )
                    } else {
                        None
                    };
                    let status = if is_aborted { "aborted" } else { "idle" };

                    let persisted = exchange_ctx.is_some();
                    let mut resolved_model = model_copy.cli_model.to_string();

                    if let Some(mut pl) = pipeline.take() {
                        if is_aborted {
                            pl.accumulator.mark_pending_tools_aborted();
                        }

                        // flush BEFORE notice so historical reload (rowid order)
                        // shows the notice after the in-progress assistant turn.
                        pl.accumulator.flush_pending();

                        if is_aborted {
                            pl.accumulator.append_aborted_notice();
                        }

                        if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
                            let model_str = pl.accumulator.resolved_model().to_string();
                            while persisted_turn_count < pl.accumulator.turns_len() {
                                match persist_turn_message(
                                    conn,
                                    ctx,
                                    pl.accumulator.turn_at(persisted_turn_count),
                                    &model_str,
                                ) {
                                    Ok(_) => persisted_turn_count += 1,
                                    Err(e) => {
                                        tracing::error!(turn = persisted_turn_count, "Failed to persist turn: {e}");
                                        break;
                                    }
                                }
                            }
                        }

                        if is_aborted {
                            let final_messages = pl.finish();
                            let _ = on_event.send(AgentStreamEvent::Update {
                                messages: final_messages,
                            });
                        }

                        let output = pl.accumulator.drain_output(resolved_session_id.as_deref());
                        if !output.assistant_text.is_empty() {
                            resolved_model = output.resolved_model.clone();
                        }
                        if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
                            // abort skips the result row — no usage/duration to show
                            let persistence_result = if is_aborted {
                                finalize_session_metadata(
                                    conn,
                                    ctx,
                                    status,
                                    effort_copy.as_deref(),
                                    permission_mode_copy.as_deref(),
                                )
                            } else {
                                persist_result_and_finalize(
                                    conn,
                                    ctx,
                                    &output.resolved_model,
                                    &output.assistant_text,
                                    effort_copy.as_deref(),
                                    permission_mode_copy.as_deref(),
                                    &output.usage,
                                    output.result_json.as_deref(),
                                    status,
                                )
                            };
                            if let Err(e) = persistence_result {
                                tracing::error!(rid = %rid, "Failed to finalize exchange: {e}");
                            }
                        }
                    }

                    let _ = if let Some(reason) = reason {
                        on_event.send(AgentStreamEvent::Aborted {
                            provider: provider.clone(),
                            model_id: model_id.clone(),
                            resolved_model,
                            session_id: resolved_session_id.clone(),
                            working_directory: working_dir_str.clone(),
                            persisted,
                            reason,
                        })
                    } else {
                        on_event.send(AgentStreamEvent::Done {
                            provider: provider.clone(),
                            model_id: model_id.clone(),
                            resolved_model,
                            session_id: resolved_session_id.clone(),
                            working_directory: working_dir_str.clone(),
                            persisted,
                        })
                    };
                    break;
                }
                "permissionRequest" => {
                    let permission_id = event
                        .raw
                        .get("permissionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let tool_name = event
                        .raw
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let tool_input = event
                        .raw
                        .get("toolInput")
                        .cloned()
                        .unwrap_or(Value::Object(Default::default()));
                    let title = event
                        .raw
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let description = event
                        .raw
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    tracing::debug!(rid = %rid, tool = %tool_name, permission_id = %permission_id, "Permission request");
                    let _ = on_event.send(AgentStreamEvent::PermissionRequest {
                        permission_id,
                        tool_name,
                        tool_input,
                        title,
                        description,
                    });
                }
                "error" => {
                    let msg = event
                        .raw
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown sidecar error")
                        .to_string();
                    let internal = event
                        .raw
                        .get("internal")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    tracing::debug!(rid = %rid, internal, "Sidecar error: {msg}");
                    let _ = on_event.send(AgentStreamEvent::Error {
                        message: msg,
                        persisted: exchange_ctx.is_some(),
                        internal,
                    });
                    break;
                }
                _ => {
                    let line = serde_json::to_string(&event.raw).unwrap_or_default();
                    if !line.is_empty() && line != "{}" {
                        if let Some(pl) = pipeline.as_mut() {
                            let emit = pl.push_event(&event.raw, &line);

                            // Persist newly completed turns
                            if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
                                let model_str = pl.accumulator.resolved_model().to_string();
                                while persisted_turn_count < pl.accumulator.turns_len() {
                                    match persist_turn_message(
                                        conn,
                                        ctx,
                                        pl.accumulator.turn_at(persisted_turn_count),
                                        &model_str,
                                    ) {
                                        Ok(_) => {
                                            persisted_turn_count += 1;
                                        }
                                        Err(e) => {
                                            tracing::error!(turn = persisted_turn_count, "Failed to persist turn: {e}");
                                            break;
                                        }
                                    }
                                }
                            }

                            // Emit based on pipeline output type
                            match emit {
                                crate::pipeline::PipelineEmit::Full(messages) => {
                                    let _ = on_event.send(AgentStreamEvent::Update { messages });
                                }
                                crate::pipeline::PipelineEmit::Partial(message) => {
                                    let _ = on_event
                                        .send(AgentStreamEvent::StreamingPartial { message });
                                }
                                crate::pipeline::PipelineEmit::None => {}
                            }
                        }
                    }
                }
            }
        }

        tracing::debug!(rid = %rid, event_count, "Event loop exited");
        sidecar_state.unsubscribe(&rid);
        // Always unregister — covers all exit paths (end / aborted / error /
        // sidecar EOF / channel close on shutdown). The graceful-shutdown
        // poller in abort_all_active_streams_blocking is waiting for this.
        active_streams_state.unregister(&rid);
    });

    Ok(())
}
// Test helpers driving the pipeline accumulator directly.
#[cfg(test)]
fn parse_claude_output(
    stdout: &str,
    fallback_session_id: Option<&str>,
    fallback_model: &str,
) -> crate::pipeline::types::ParsedAgentOutput {
    let mut accumulator =
        crate::pipeline::accumulator::StreamAccumulator::new("claude", fallback_model);
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        accumulator.push_event(&value, line);
    }
    accumulator.flush_pending();
    accumulator.drain_output(fallback_session_id)
}

#[cfg(test)]
fn parse_codex_output(
    stdout: &str,
    fallback_session_id: Option<&str>,
    fallback_model: &str,
) -> crate::pipeline::types::ParsedAgentOutput {
    let mut accumulator =
        crate::pipeline::accumulator::StreamAccumulator::new("codex", fallback_model);
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        accumulator.push_event(&value, line);
    }
    accumulator.flush_pending();
    accumulator.drain_output(fallback_session_id)
}

pub(crate) fn resolve_working_directory(provided: Option<&str>) -> Result<PathBuf> {
    if let Some(path) = non_empty(provided) {
        let directory = PathBuf::from(path);
        if directory.is_dir() {
            return Ok(directory);
        }
    }

    std::env::current_dir().context("Failed to resolve working directory")
}

// ---------------------------------------------------------------------------
// Incremental persistence — each message is INSERT-ed as it arrives
// ---------------------------------------------------------------------------

/// Persist the user's prompt as the first message of the exchange.
/// Wraps as `{"type":"user_prompt","text":"...","files":[...]}`.
fn persist_user_message(
    conn: &Connection,
    ctx: &ExchangeContext,
    prompt: &str,
    files: &[String],
) -> Result<()> {
    let now = current_timestamp_string()?;
    let user_message_id = ctx.user_message_id.clone();
    let mut payload = serde_json::json!({
        "type": "user_prompt",
        "text": prompt,
    });
    if !files.is_empty() {
        payload["files"] = serde_json::Value::Array(
            files
                .iter()
                .map(|p| serde_json::Value::String(p.clone()))
                .collect(),
        );
    }
    let content = payload.to_string();

    conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at,
              model, last_assistant_message_id, turn_id,
              is_resumable_message
            ) VALUES (?1, ?2, 'user', ?3, ?4, ?4, ?5, ?6, ?7, 0)
            "#,
        params![
            user_message_id,
            ctx.helmor_session_id,
            content,
            now,
            ctx.model_id,
            ctx.assistant_sdk_message_id,
            ctx.turn_id
        ],
    )?;
    Ok(())
}

/// Persist a single intermediate turn (assistant message or user tool
/// result). Called each time the accumulator produces a complete turn
/// during streaming. Returns the DB message ID.
fn persist_turn_message(
    conn: &Connection,
    ctx: &ExchangeContext,
    turn: &CollectedTurn,
    resolved_model: &str,
) -> Result<String> {
    let now = current_timestamp_string()?;
    let msg_id = Uuid::new_v4().to_string();

    conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at,
              model, turn_id, is_resumable_message
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, 0)
            "#,
        params![
            msg_id,
            ctx.helmor_session_id,
            turn.role,
            turn.content_json,
            now,
            resolved_model,
            ctx.turn_id
        ],
    )?;
    Ok(msg_id)
}

/// Insert the result summary row + run the session/workspace metadata
/// updates. Used by the normal completion path.
#[allow(clippy::too_many_arguments)]
fn persist_result_and_finalize(
    conn: &Connection,
    ctx: &ExchangeContext,
    resolved_model: &str,
    assistant_text: &str,
    effort_level: Option<&str>,
    permission_mode: Option<&str>,
    usage: &AgentUsage,
    raw_result_json: Option<&str>,
    status: &str,
) -> Result<()> {
    let now = current_timestamp_string()?;
    let result_message_id = Uuid::new_v4().to_string();

    let result_payload = raw_result_json.map(str::to_string).unwrap_or_else(|| {
        serde_json::json!({
            "type": "result",
            "subtype": if status == "aborted" { "aborted" } else { "success" },
            "result": assistant_text,
            "usage": {
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
            }
        })
        .to_string()
    });

    let transaction = conn.unchecked_transaction()?;

    transaction.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at,
              model, sdk_message_id, turn_id,
              is_resumable_message
            ) VALUES (?1, ?2, 'assistant', ?3, ?4, ?4, ?5, ?6, ?7, 0)
            "#,
        params![
            result_message_id,
            ctx.helmor_session_id,
            result_payload,
            now,
            resolved_model,
            ctx.assistant_sdk_message_id,
            ctx.turn_id
        ],
    )?;

    finalize_session_metadata_in_transaction(
        &transaction,
        ctx,
        &now,
        status,
        effort_level,
        permission_mode,
    )?;

    transaction
        .commit()
        .context("Failed to commit result and finalize transaction")
}

/// Update session.status / workspace / read marker without inserting a
/// result row. Used by the abort path — abort doesn't have meaningful
/// usage/duration data, so a result row would render as the misleading
/// "Done" label via build_result_label.
fn finalize_session_metadata(
    conn: &Connection,
    ctx: &ExchangeContext,
    status: &str,
    effort_level: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<()> {
    let now = current_timestamp_string()?;
    let transaction = conn.unchecked_transaction()?;
    finalize_session_metadata_in_transaction(
        &transaction,
        ctx,
        &now,
        status,
        effort_level,
        permission_mode,
    )?;
    transaction
        .commit()
        .context("Failed to commit finalize_session_metadata transaction")
}

fn finalize_session_metadata_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    ctx: &ExchangeContext,
    now: &str,
    status: &str,
    effort_level: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<()> {
    transaction.execute(
        r#"
            UPDATE sessions
            SET
              status = ?5,
              model = ?2,
              agent_type = ?3,
              last_user_message_at = ?4,
              effort_level = COALESCE(?6, effort_level),
              permission_mode = COALESCE(?7, permission_mode)
            WHERE id = ?1
            "#,
        params![
            ctx.helmor_session_id,
            ctx.model_id,
            ctx.model_provider,
            now,
            status,
            effort_level,
            permission_mode
        ],
    )?;

    transaction.execute(
        r#"
            UPDATE workspaces
            SET
              active_session_id = ?2
            WHERE id = (SELECT workspace_id FROM sessions WHERE id = ?1)
            "#,
        params![ctx.helmor_session_id, ctx.helmor_session_id],
    )?;

    mark_session_read_in_transaction(transaction, &ctx.helmor_session_id)?;
    Ok(())
}

fn open_write_connection() -> Result<Connection> {
    crate::models::db::open_connection(true)
}

fn current_timestamp_string() -> Result<String> {
    crate::models::db::current_timestamp()
}

pub fn find_model_definition(model_id: &str) -> Option<&'static AgentModelDefinition> {
    CLAUDE_MODEL_DEFINITIONS
        .iter()
        .chain(CODEX_MODEL_DEFINITIONS.iter())
        .find(|model| model.id == model_id)
}

fn model_definition_to_option(model: &AgentModelDefinition) -> AgentModelOption {
    AgentModelOption {
        id: model.id.to_string(),
        provider: model.provider.to_string(),
        label: model.label.to_string(),
        cli_model: model.cli_model.to_string(),
        badge: model.badge.map(str::to_string),
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|inner| !inner.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // parse_claude_output
    // -----------------------------------------------------------------------

    #[test]
    fn parse_claude_output_extracts_text_from_stream_deltas() {
        let stdout = r#"
            {"type":"stream_event","event":{"delta":{"text":"Hello "}}}
            {"type":"stream_event","event":{"delta":{"text":"world"}}}
            {"type":"result","result":"Hello world","session_id":"sess-123","usage":{"input_tokens":10,"output_tokens":5}}
        "#;

        let output = parse_claude_output(stdout, None, "opus");
        assert_eq!(output.assistant_text, "Hello world");
        assert_eq!(output.session_id.as_deref(), Some("sess-123"));
        assert_eq!(output.usage.input_tokens, Some(10));
        assert_eq!(output.usage.output_tokens, Some(5));
    }

    #[test]
    fn parse_claude_output_extracts_thinking() {
        let stdout = r#"
            {"type":"stream_event","event":{"delta":{"thinking":"Let me think..."}}}
            {"type":"stream_event","event":{"delta":{"text":"Answer"}}}
            {"type":"result","result":"Answer","usage":{}}
        "#;

        let output = parse_claude_output(stdout, None, "opus");
        assert_eq!(output.assistant_text, "Answer");
        assert_eq!(output.thinking_text.as_deref(), Some("Let me think..."));
    }

    #[test]
    fn parse_claude_output_uses_fallback_session_id() {
        let stdout = r#"
            {"type":"stream_event","event":{"delta":{"text":"Hi"}}}
            {"type":"result","result":"Hi","usage":{}}
        "#;

        let output = parse_claude_output(stdout, Some("fallback-id"), "opus");
        assert_eq!(output.session_id.as_deref(), Some("fallback-id"));
    }

    #[test]
    fn parse_claude_output_returns_empty_text_on_no_assistant_content() {
        let stdout = r#"{"type":"result","result":"","usage":{}}"#;
        let output = parse_claude_output(stdout, None, "opus");
        assert!(output.assistant_text.is_empty());
        assert!(output.thinking_text.is_none());
    }

    #[test]
    fn parse_claude_output_extracts_model_name() {
        let stdout = r#"
            {"type":"assistant","model":"claude-opus-4-20250514","message":{"content":[{"type":"text","text":"Hi"}]}}
            {"type":"result","result":"Hi","usage":{}}
        "#;

        let output = parse_claude_output(stdout, None, "opus");
        assert_eq!(output.resolved_model, "claude-opus-4-20250514");
    }

    // -----------------------------------------------------------------------
    // parse_codex_output
    // -----------------------------------------------------------------------

    #[test]
    fn parse_codex_output_extracts_agent_message() {
        let stdout = r#"
            {"type":"thread.started","thread_id":"thread-abc"}
            {"type":"item.completed","item":{"type":"agent_message","text":"Hello from Codex"}}
            {"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4");
        assert_eq!(output.assistant_text, "Hello from Codex");
        assert_eq!(output.session_id.as_deref(), Some("thread-abc"));
        assert_eq!(output.usage.input_tokens, Some(100));
        assert_eq!(output.usage.output_tokens, Some(20));
    }

    #[test]
    fn parse_codex_output_uses_thread_resumed() {
        let stdout = r#"
            {"type":"thread.resumed","thread_id":"thread-xyz"}
            {"type":"item.completed","item":{"type":"agent_message","text":"Resumed"}}
            {"type":"turn.completed","usage":{}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4");
        assert_eq!(output.session_id.as_deref(), Some("thread-xyz"));
    }

    #[test]
    fn parse_codex_output_returns_empty_text_on_no_agent_message() {
        let stdout = r#"{"type":"thread.started","thread_id":"t1"}"#;
        let output = parse_codex_output(stdout, None, "gpt-5.4");
        assert!(output.assistant_text.is_empty());
        assert_eq!(output.session_id.as_deref(), Some("t1"));
    }

    #[test]
    fn parse_codex_output_joins_multiple_messages() {
        let stdout = r#"
            {"type":"item.completed","item":{"type":"agent_message","text":"Part 1"}}
            {"type":"item.completed","item":{"type":"agent_message","text":"Part 2"}}
            {"type":"turn.completed","usage":{}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4");
        assert!(output.assistant_text.contains("Part 1"));
        assert!(output.assistant_text.contains("Part 2"));
    }

    // -----------------------------------------------------------------------
    // non_empty helper
    // -----------------------------------------------------------------------

    #[test]
    fn non_empty_filters_correctly() {
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some("")), None);
        assert_eq!(non_empty(Some("  ")), None);
        assert_eq!(non_empty(Some("hello")), Some("hello"));
    }

    // -----------------------------------------------------------------------
    // parse_codex_output — persistence (turns + result_json)
    // -----------------------------------------------------------------------

    #[test]
    fn parse_codex_output_collects_text_and_result() {
        let stdout = r#"
            {"type":"thread.started","thread_id":"t1"}
            {"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}
            {"type":"item.completed","item":{"type":"command_execution","command":"ls"}}
            {"type":"item.completed","item":{"type":"agent_message","text":"Done"}}
            {"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":10}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4");
        // Assistant text should combine all agent_message texts
        assert!(output.assistant_text.contains("Hello"));
        assert!(output.assistant_text.contains("Done"));
        // result_json should be the turn.completed line
        assert!(output.result_json.is_some());
        assert!(output.result_json.unwrap().contains("turn.completed"));
        // Usage should be captured
        assert_eq!(output.usage.input_tokens, Some(50));
        assert_eq!(output.usage.output_tokens, Some(10));
    }

    // -----------------------------------------------------------------------
    // find_model_definition — provider lookup
    // -----------------------------------------------------------------------

    #[test]
    fn find_model_definition_resolves_providers() {
        let claude = find_model_definition("opus-1m").unwrap();
        assert_eq!(claude.provider, "claude");

        let codex = find_model_definition("gpt-5.4").unwrap();
        assert_eq!(codex.provider, "codex");

        assert!(find_model_definition("nonexistent").is_none());
    }

    // -----------------------------------------------------------------------
    // Incremental persistence — integration tests with real DB
    // -----------------------------------------------------------------------

    fn setup_test_db(dir: &std::path::Path) -> std::path::PathBuf {
        let db_path = dir.join("helmor.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO repos (id, name) VALUES ('r1', 'test-repo')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state) VALUES ('w1', 'r1', 'test', 'ready')",
            [],
        ).unwrap();
        db_path
    }

    #[test]
    fn incremental_persist_writes_effort_and_permission_mode() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::data_dir::TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", dir.path());

        let db_path = setup_test_db(dir.path());
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title) VALUES ('s1', 'w1', 'idle', 'Test')",
            [],
        ).unwrap();

        let ctx = ExchangeContext {
            helmor_session_id: "s1".to_string(),
            turn_id: Uuid::new_v4().to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            assistant_sdk_message_id: format!("helmor-assistant-{}", Uuid::new_v4()),
            user_message_id: Uuid::new_v4().to_string(),
        };

        // 1. Persist user message
        persist_user_message(&conn, &ctx, "Hello", &[]).unwrap();

        persist_result_and_finalize(
            &conn,
            &ctx,
            "claude-opus-4-20250514",
            "Response text",
            Some("max"),
            Some("plan"),
            &AgentUsage {
                input_tokens: Some(100),
                output_tokens: Some(50),
            },
            None,
            "idle",
        )
        .unwrap();

        // Verify session metadata
        let (effort, perm, agent_type, model_id): (String, String, String, String) = conn
            .query_row(
                "SELECT effort_level, permission_mode, agent_type, model FROM sessions WHERE id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(effort, "max", "effort_level should be persisted");
        assert_eq!(perm, "plan", "permission_mode should be persisted");
        assert_eq!(
            agent_type, "claude",
            "agent_type should be set from model provider"
        );
        assert_eq!(model_id, "opus-1m", "model should be persisted");

        // Verify messages were created (user + result)
        let msg_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM session_messages WHERE session_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            msg_count >= 2,
            "Should have at least user + result messages, got {msg_count}"
        );

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn incremental_persist_preserves_existing_values_when_null() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::data_dir::TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", dir.path());

        let db_path = setup_test_db(dir.path());
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, effort_level, permission_mode) VALUES ('s1', 'w1', 'idle', 'high', 'acceptEdits')",
            [],
        ).unwrap();

        let ctx = ExchangeContext {
            helmor_session_id: "s1".to_string(),
            turn_id: Uuid::new_v4().to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            assistant_sdk_message_id: format!("helmor-assistant-{}", Uuid::new_v4()),
            user_message_id: Uuid::new_v4().to_string(),
        };

        persist_user_message(&conn, &ctx, "Hi", &[]).unwrap();
        persist_result_and_finalize(
            &conn,
            &ctx,
            "opus",
            "Reply",
            None, // effort_level = None → should keep 'high'
            None, // permission_mode = None → should keep 'acceptEdits'
            &AgentUsage {
                input_tokens: None,
                output_tokens: None,
            },
            None,
            "idle",
        )
        .unwrap();

        let (effort, perm): (String, String) = conn
            .query_row(
                "SELECT effort_level, permission_mode FROM sessions WHERE id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(
            effort, "high",
            "effort_level should be preserved when None passed"
        );
        assert_eq!(
            perm, "acceptEdits",
            "permission_mode should be preserved when None passed"
        );

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn incremental_persist_turn_messages() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::data_dir::TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", dir.path());

        let db_path = setup_test_db(dir.path());
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title) VALUES ('s1', 'w1', 'idle', 'Test')",
            [],
        ).unwrap();

        let ctx = ExchangeContext {
            helmor_session_id: "s1".to_string(),
            turn_id: Uuid::new_v4().to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            assistant_sdk_message_id: format!("helmor-assistant-{}", Uuid::new_v4()),
            user_message_id: Uuid::new_v4().to_string(),
        };

        // Persist user message
        persist_user_message(&conn, &ctx, "Do something", &[]).unwrap();

        // Persist two intermediate turns
        let turn1 = CollectedTurn {
            role: "assistant".to_string(),
            content_json:
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"I'll help"}]}}"#
                    .to_string(),
        };
        let turn2 = CollectedTurn {
            role: "user".to_string(),
            content_json:
                r#"{"type":"user","content":[{"type":"tool_result","tool_use_id":"t1"}]}"#
                    .to_string(),
        };

        let _ = persist_turn_message(&conn, &ctx, &turn1, "opus").unwrap();
        let _ = persist_turn_message(&conn, &ctx, &turn2, "opus").unwrap();

        // Verify: 3 messages so far (user + 2 turns), all with same turn_id
        let msg_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM session_messages WHERE session_id = 's1' AND turn_id = ?1",
                [&ctx.turn_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(msg_count, 3, "Should have user + 2 turn messages");

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn model_definitions_have_unique_ids() {
        let all: Vec<_> = CLAUDE_MODEL_DEFINITIONS
            .iter()
            .chain(CODEX_MODEL_DEFINITIONS.iter())
            .collect();
        let mut ids: Vec<&str> = all.iter().map(|m| m.id).collect();
        let len_before = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), len_before, "Duplicate model IDs found");
    }
}
