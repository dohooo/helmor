use std::sync::Mutex;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::CmdResult;
use crate::workspace_state;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSessionTitleRequest {
    pub session_id: String,
    pub user_message: String,
    pub title_seed: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSessionTitleResponse {
    pub title: Option<String>,
    pub branch_renamed: bool,
    pub skipped: bool,
}

/// Sidecar response timeout. The sidecar gives Claude 30 s and Codex fallback
/// another 30 s, so keep a small buffer here for request handoff and delivery.
const TITLE_GEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(65);

fn can_replace_session_title(current_title: &str, title_seed: Option<&str>) -> bool {
    current_title == "Untitled"
        || title_seed
            .map(str::trim)
            .filter(|seed| !seed.is_empty())
            .is_some_and(|seed| current_title == seed)
}

pub async fn generate_session_title(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: GenerateSessionTitleRequest,
) -> CmdResult<GenerateSessionTitleResponse> {
    let connection =
        open_write_connection().map_err(|e| anyhow::anyhow!("Failed to open DB: {e}"))?;
    let (current_title, action_kind): (String, Option<super::ActionKind>) = connection
        .query_row(
            "SELECT title, action_kind FROM sessions WHERE id = ?1",
            [&request.session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| anyhow::anyhow!("Session not found: {e}"))?;

    let should_generate_title = action_kind.is_none()
        && can_replace_session_title(&current_title, request.title_seed.as_deref());
    tracing::debug!(
        session_id = %request.session_id,
        current_title,
        title_seed = request.title_seed.as_deref().unwrap_or(""),
        should_generate_title,
        "generate_session_title title gating resolved"
    );

    let workspace_info: Option<(String, Option<String>, String, Option<String>)> =
        if action_kind.is_none() {
            let sql = format!(
                r#"SELECT w.id, r.root_path, w.directory_name, w.branch
                   FROM workspaces w
                   JOIN repos r ON r.id = w.repository_id
                   JOIN sessions s ON s.workspace_id = w.id
                   WHERE s.id = ?1 AND w.state {}"#,
                workspace_state::OPERATIONAL_FILTER,
            );
            connection
                .query_row(&sql, [&request.session_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .ok()
        } else {
            None
        };

    let branch_settings = crate::settings::load_branch_prefix_settings().unwrap_or(
        crate::settings::BranchPrefixSettings {
            branch_prefix_type: None,
            branch_prefix_custom: None,
        },
    );

    let should_generate_branch =
        workspace_info
            .as_ref()
            .is_some_and(|(_, _, directory_name, branch)| {
                branch.as_deref().is_some_and(|current_branch| {
                    crate::helpers::is_default_branch_name(
                        current_branch,
                        directory_name,
                        &branch_settings,
                    )
                })
            });

    if !should_generate_title && !should_generate_branch {
        tracing::debug!(
            session_id = %request.session_id,
            "generate_session_title skipped: neither title nor branch needs generation"
        );
        return Ok(GenerateSessionTitleResponse {
            title: None,
            branch_renamed: false,
            skipped: true,
        });
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
        let session_id_for_logs = session_id.clone();
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
                            tracing::debug!(
                                session_id = %session_id_for_logs,
                                generated_title = title.as_deref().unwrap_or(""),
                                generated_branch = branch_name.as_deref().unwrap_or(""),
                                "generate_session_title received titleGenerated"
                            );
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

    let mut title_renamed = false;
    if should_generate_title {
        if let Some(ref title) = generated_title {
            let connection =
                open_write_connection().map_err(|e| anyhow::anyhow!("Failed to open DB: {e}"))?;
            let latest_title: String = connection
                .query_row(
                    "SELECT title FROM sessions WHERE id = ?1",
                    [&session_id],
                    |row| row.get(0),
                )
                .map_err(|e| anyhow::anyhow!("Failed to re-read session title: {e}"))?;

            if can_replace_session_title(&latest_title, request.title_seed.as_deref()) {
                crate::sessions::rename_session(&session_id, title)
                    .map_err(|e| anyhow::anyhow!("Failed to rename session: {e}"))?;
                title_renamed = true;
                tracing::debug!(
                    session_id = %session_id,
                    title,
                    latest_title,
                    title_seed = request.title_seed.as_deref().unwrap_or(""),
                    "Auto session rename applied"
                );
            } else {
                tracing::debug!(
                    session_id = %session_id,
                    latest_title,
                    title_seed = request.title_seed.as_deref().unwrap_or(""),
                    "Skipping auto session rename: title changed while generation was in flight"
                );
            }
        }
    }

    let mut branch_renamed = false;
    if should_generate_branch {
        if let (Some(branch_segment), Some((workspace_id, root_path, directory_name, _))) =
            (generated_branch.as_deref(), workspace_info)
        {
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
                let base_branch =
                    crate::helpers::branch_name_for_directory(branch_segment, &branch_settings);

                // Deduplicate: if the target branch already exists in git,
                // append -2, -3, ... until we find a free name. Prevents
                // collisions when multiple workspaces generate the same
                // branch name from similar prompts.
                let new_branch = if let Some(ref repo_root) = root_path {
                    let repo = std::path::Path::new(repo_root);
                    if repo.is_dir() {
                        deduplicate_branch_name(&base_branch, repo)
                    } else {
                        base_branch
                    }
                } else {
                    base_branch
                };

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
                        } else {
                            branch_renamed = true;
                        }
                    }
                }
            }
        }
    }

    Ok(GenerateSessionTitleResponse {
        title: title_renamed.then_some(generated_title).flatten(),
        branch_renamed,
        skipped: false,
    })
}

/// If `base` already exists as a local branch, try `base-2`, `base-3`, …
/// up to a small limit. Returns the first free name, or `base` unchanged
/// if the check itself fails (defensive: let `git branch -m` report the
/// real error).
fn deduplicate_branch_name(base: &str, repo_root: &std::path::Path) -> String {
    let repo_root_str = repo_root.display().to_string();
    let exists = |name: &str| -> bool {
        crate::git_ops::run_git(
            [
                "-C",
                &repo_root_str,
                "rev-parse",
                "--verify",
                &format!("refs/heads/{name}"),
            ],
            None,
        )
        .is_ok()
    };
    if !exists(base) {
        return base.to_string();
    }
    for n in 2..=100 {
        let candidate = format!("{base}-{n}");
        if !exists(&candidate) {
            return candidate;
        }
    }
    // All 100 slots taken — return base and let git report the error.
    base.to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSlashCommandsRequest {
    pub provider: String,
    pub working_directory: Option<String>,
    /// Repo id of the workspace — used to serve a repo-level fallback when the
    /// exact workspace cache is cold (different workspaces on the same repo
    /// usually share the same skill directories).
    pub repo_id: Option<String>,
}

/// Sidecar timeout for `listSlashCommands`. Claude's in-sidecar AbortController
/// fires at 20s; leave some buffer so the sidecar error surfaces first.
const LIST_SLASH_COMMANDS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandEntry {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandsResponse {
    pub commands: Vec<SlashCommandEntry>,
}

pub async fn list_slash_commands(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    cache: tauri::State<'_, super::slash_commands::SlashCommandCache>,
    request: ListSlashCommandsRequest,
) -> CmdResult<SlashCommandsResponse> {
    let cwd = request.working_directory.as_deref().unwrap_or("");
    let repo_id = request.repo_id.as_deref().unwrap_or("");
    tracing::debug!(
        provider = %request.provider,
        cwd,
        repo_id,
        "list_slash_commands request"
    );

    // Guard: if cwd is provided but doesn't exist (archived/deleted workspace),
    // skip the sidecar call. Spawning Claude CLI in a missing dir makes bun
    // auto-create `node_modules/.bun` at that path, resurrecting the dir.
    if !cwd.is_empty() && !std::path::Path::new(cwd).is_dir() {
        tracing::debug!(
            cwd,
            "list_slash_commands: cwd missing, returning empty (cached repo fallback may still apply)"
        );
        if !repo_id.is_empty() {
            let rkey = super::slash_commands::repo_key(&request.provider, repo_id);
            if let Some(commands) = cache.get_repo(&rkey) {
                return Ok(SlashCommandsResponse { commands });
            }
        }
        return Ok(SlashCommandsResponse {
            commands: Vec::new(),
        });
    }

    let ws_key = super::slash_commands::workspace_key(
        &request.provider,
        request.working_directory.as_deref(),
    );

    // 1. Workspace-level exact hit → return instantly + SWR refresh.
    if let Some(commands) = cache.get_workspace(&ws_key) {
        spawn_background_refresh(&app, &cache, &request, ws_key);
        return Ok(SlashCommandsResponse { commands });
    }

    // 2. Repo-level fallback → return stale-but-plausible + SWR refresh.
    if !repo_id.is_empty() {
        let rkey = super::slash_commands::repo_key(&request.provider, repo_id);
        if let Some(commands) = cache.get_repo(&rkey) {
            tracing::debug!(
                provider = %request.provider,
                cwd,
                repo_id,
                count = commands.len(),
                "list_slash_commands serving repo fallback"
            );
            spawn_background_refresh(&app, &cache, &request, ws_key);
            return Ok(SlashCommandsResponse { commands });
        }
    }

    // 3. Cold miss on both tiers — synchronous sidecar fetch.
    tracing::debug!(
        provider = %request.provider,
        cwd,
        repo_id,
        "list_slash_commands cache miss; fetching full result synchronously"
    );
    let commands = fetch_from_sidecar(&sidecar, &request)?;
    tracing::debug!(
        provider = %request.provider,
        cwd,
        repo_id,
        count = commands.len(),
        "list_slash_commands sync fetch succeeded"
    );
    cache.set(ws_key, request.repo_id.as_deref(), commands.clone());
    Ok(SlashCommandsResponse { commands })
}

/// Prewarm the slash-command cache for a single workspace (both providers).
/// Safe to call repeatedly — the cache's per-key refresh lock dedupes.
pub fn prewarm_slash_command_cache_for_workspace(app: &AppHandle, workspace_id: &str) {
    let app = app.clone();
    let workspace_id = workspace_id.to_string();
    let _ = std::thread::Builder::new()
        .name("slash-cmd-prewarm-ws".into())
        .spawn(move || {
            let record = match crate::models::workspaces::load_workspace_record_by_id(&workspace_id)
            {
                Ok(Some(r)) => r,
                Ok(None) => {
                    tracing::debug!(workspace_id, "Slash-command prewarm: workspace not found");
                    return;
                }
                Err(e) => {
                    tracing::warn!(workspace_id, error = %e, "Slash-command prewarm: load failed");
                    return;
                }
            };
            // Skip archived workspaces — their `root_path` still points at the
            // old worktree location in DB, but the directory is gone. Spawning
            // Claude CLI there makes bun auto-create `node_modules/.bun`,
            // resurrecting the archived dir as a ghost.
            if !record.state.is_operational() {
                tracing::debug!(
                    workspace_id,
                    state = %record.state,
                    "Slash-command prewarm: skipping non-operational workspace"
                );
                return;
            }
            let Some(root_path) = record
                .root_path
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
            else {
                tracing::debug!(
                    workspace_id,
                    "Slash-command prewarm: workspace has no root_path"
                );
                return;
            };
            dispatch_prewarm_for(&app, root_path, &record.repo_id);
        });
}

/// Prewarm on startup: only the last-selected workspace (persisted in
/// `settings.app.last_workspace_id`). The frontend's workspace-switch handler
/// also fires `prewarm_slash_commands_for_workspace` on initial selection —
/// `SlashCommandCache::try_start_refresh` dedupes the two calls.
pub fn prewarm_slash_command_cache(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("slash-cmd-prewarm".into())
        .spawn(move || {
            let last_id = match crate::models::settings::load_setting_value("app.last_workspace_id")
            {
                Ok(Some(id)) if !id.trim().is_empty() => id,
                _ => {
                    tracing::debug!(
                        "Slash-command prewarm skipped: no last_workspace_id persisted"
                    );
                    return;
                }
            };
            tracing::debug!(workspace_id = %last_id, "Slash-command prewarm using last workspace");
            prewarm_slash_command_cache_for_workspace(&app, &last_id);
        });
}

fn dispatch_prewarm_for(app: &AppHandle, root_path: &str, repo_id: &str) {
    let cache: tauri::State<'_, super::slash_commands::SlashCommandCache> = app.state();
    for provider in ["claude", "codex"] {
        let request = ListSlashCommandsRequest {
            provider: provider.to_string(),
            working_directory: Some(root_path.to_string()),
            repo_id: Some(repo_id.to_string()),
        };
        let ws_key = super::slash_commands::workspace_key(provider, Some(root_path));
        tracing::debug!(
            provider,
            cwd = root_path,
            repo_id,
            "Slash-command prewarm dispatching background refresh"
        );
        spawn_background_refresh(app, &cache, &request, ws_key);
    }
}

/// Blocking sidecar call for `listSlashCommands`. Used by both the
/// synchronous cold-miss path and the background refresh thread.
fn fetch_from_sidecar(
    sidecar: &crate::sidecar::ManagedSidecar,
    request: &ListSlashCommandsRequest,
) -> CmdResult<Vec<SlashCommandEntry>> {
    let request_id = Uuid::new_v4().to_string();

    let mut params = serde_json::Map::new();
    params.insert("provider".into(), Value::String(request.provider.clone()));
    if let Some(cwd) = request.working_directory.as_ref() {
        params.insert("cwd".into(), Value::String(cwd.clone()));
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

    let mut commands: Vec<SlashCommandEntry> = Vec::new();
    let mut error: Option<String> = None;

    loop {
        match rx.recv_timeout(LIST_SLASH_COMMANDS_TIMEOUT) {
            Ok(event) => match event.event_type() {
                "slashCommandsListed" => {
                    if let Some(entries) = event.raw.get("commands").and_then(Value::as_array) {
                        for entry in entries {
                            let Some(name) = entry.get("name").and_then(Value::as_str) else {
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
                error = Some(format!(
                    "listSlashCommands timed out after {}s",
                    LIST_SLASH_COMMANDS_TIMEOUT.as_secs()
                ));
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                error = Some("Sidecar disconnected while waiting for slash commands".to_string());
                break;
            }
        }
    }

    sidecar.unsubscribe(&request_id);
    if let Some(message) = error {
        Err(anyhow::anyhow!("listSlashCommands failed: {message}").into())
    } else {
        Ok(commands)
    }
}

/// Fire-and-forget background thread that refreshes the workspace-level
/// cache entry. Writes into both workspace and repo tiers on success.
fn spawn_background_refresh(
    app: &AppHandle,
    cache: &super::slash_commands::SlashCommandCache,
    request: &ListSlashCommandsRequest,
    ws_key: super::slash_commands::WorkspaceKey,
) {
    if !cache.try_start_refresh(&ws_key) {
        tracing::debug!(
            provider = %request.provider,
            cwd = request.working_directory.as_deref().unwrap_or(""),
            "Background slash command refresh skipped; another refresh is in flight"
        );
        return;
    }

    tracing::debug!(
        provider = %request.provider,
        cwd = request.working_directory.as_deref().unwrap_or(""),
        "Background slash command refresh started"
    );

    let app = app.clone();
    let request = request.clone();
    let refresh_key = ws_key.clone();

    std::thread::Builder::new()
        .name("slash-cmd-refresh".into())
        .spawn(move || {
            let sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecar> = app.state();
            let cache_state: tauri::State<'_, super::slash_commands::SlashCommandCache> =
                app.state();

            match fetch_from_sidecar(&sidecar_state, &request) {
                Ok(commands) => {
                    tracing::debug!(
                        provider = %request.provider,
                        cwd = request.working_directory.as_deref().unwrap_or(""),
                        count = commands.len(),
                        "Background slash command refresh succeeded"
                    );
                    cache_state.set(ws_key, request.repo_id.as_deref(), commands);
                }
                Err(e) => {
                    // Don't clear the cache — stale local data is better than nothing.
                    tracing::warn!("Background slash command refresh failed: {e:?}");
                }
            }

            cache_state.finish_refresh(&refresh_key);
        })
        .ok();
}

fn open_write_connection() -> Result<rusqlite::Connection> {
    crate::models::db::open_connection(true)
}

// ---------------------------------------------------------------------------
// Dynamic model list
// ---------------------------------------------------------------------------

use super::catalog::{AgentModelOption, AgentModelSection, AgentModelSectionStatus};

/// Per-provider cached model options. Each provider is cached independently
/// so a transient failure in one doesn't wipe the other's good data.
static CLAUDE_CACHE: Mutex<Vec<AgentModelOption>> = Mutex::new(Vec::new());
static CODEX_CACHE: Mutex<Vec<AgentModelOption>> = Mutex::new(Vec::new());

enum ProviderModelFetchResult {
    Ready(Vec<AgentModelOption>),
    Unavailable(String),
    Error(String),
}

struct ResolvedProviderModels {
    options: Vec<AgentModelOption>,
    status: AgentModelSectionStatus,
}

/// Fetch models from both providers via sidecar. Each provider's result is
/// cached independently — if a provider fails, its last good cache is used.
pub fn fetch_agent_model_sections(
    sidecar: &crate::sidecar::ManagedSidecar,
) -> Vec<AgentModelSection> {
    let claude_models = resolve_with_cache(
        fetch_models_for_provider(sidecar, "claude"),
        &CLAUDE_CACHE,
        "claude",
    );
    let codex_models = resolve_with_cache(
        fetch_models_for_provider(sidecar, "codex"),
        &CODEX_CACHE,
        "codex",
    );

    vec![
        AgentModelSection {
            id: "claude".to_string(),
            label: "Claude Code".to_string(),
            status: claude_models.status,
            options: claude_models.options,
        },
        AgentModelSection {
            id: "codex".to_string(),
            label: "Codex".to_string(),
            status: codex_models.status,
            options: codex_models.options,
        },
    ]
}

/// Use cached data for transient fetch errors, but never for a provider that
/// is confirmed unavailable on this machine.
fn resolve_with_cache(
    result: ProviderModelFetchResult,
    cache: &Mutex<Vec<AgentModelOption>>,
    provider: &str,
) -> ResolvedProviderModels {
    let mut cached = cache.lock().unwrap_or_else(|e| e.into_inner());
    match result {
        ProviderModelFetchResult::Ready(fresh) => {
            *cached = fresh.clone();
            ResolvedProviderModels {
                options: fresh,
                status: AgentModelSectionStatus::Ready,
            }
        }
        ProviderModelFetchResult::Unavailable(reason) => {
            cached.clear();
            tracing::info!(provider, reason, "Provider unavailable for model list");
            ResolvedProviderModels {
                options: vec![],
                status: AgentModelSectionStatus::Unavailable,
            }
        }
        ProviderModelFetchResult::Error(reason) => {
            if !cached.is_empty() {
                tracing::info!(
                    provider,
                    reason,
                    "Using cached model list after fetch error"
                );
            } else {
                tracing::warn!(provider, reason, "Model list fetch failed");
            }
            ResolvedProviderModels {
                options: cached.clone(),
                status: AgentModelSectionStatus::Error,
            }
        }
    }
}

fn fetch_models_for_provider(
    sidecar: &crate::sidecar::ManagedSidecar,
    provider: &str,
) -> ProviderModelFetchResult {
    let request_id = Uuid::new_v4().to_string();

    let mut params = serde_json::Map::new();
    params.insert("provider".into(), Value::String(provider.to_string()));

    let sidecar_req = crate::sidecar::SidecarRequest {
        id: request_id.clone(),
        method: "listModels".to_string(),
        params: Value::Object(params),
    };

    let rx = sidecar.subscribe(&request_id);
    if let Err(e) = sidecar.send(&sidecar_req) {
        sidecar.unsubscribe(&request_id);
        return ProviderModelFetchResult::Error(format!(
            "listModels sidecar send failed for {provider}: {e}"
        ));
    }

    let timeout = std::time::Duration::from_secs(15);
    let mut models: Vec<AgentModelOption> = Vec::new();

    loop {
        match rx.recv_timeout(timeout) {
            Ok(event) => match event.event_type() {
                "modelsListed" => {
                    if let Some(entries) = event.raw.get("models").and_then(Value::as_array) {
                        for entry in entries {
                            let Some(id) = entry.get("id").and_then(Value::as_str) else {
                                continue;
                            };
                            let label = entry
                                .get("label")
                                .and_then(Value::as_str)
                                .unwrap_or(id)
                                .to_string();
                            let cli_model = entry
                                .get("cliModel")
                                .and_then(Value::as_str)
                                .unwrap_or(id)
                                .to_string();
                            let effort_levels = entry
                                .get("effortLevels")
                                .and_then(Value::as_array)
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(Value::as_str)
                                        .map(str::to_string)
                                        .collect()
                                })
                                .unwrap_or_default();
                            let supports_fast_mode = entry
                                .get("supportsFastMode")
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                            models.push(AgentModelOption {
                                id: id.to_string(),
                                provider: provider.to_string(),
                                label,
                                cli_model,
                                effort_levels,
                                supports_fast_mode,
                            });
                        }
                    }
                    tracing::info!(provider, count = models.len(), "Dynamic model list loaded");
                    break;
                }
                "error" => {
                    let msg = event
                        .raw
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown error");
                    sidecar.unsubscribe(&request_id);
                    return classify_model_list_error(msg);
                }
                _ => {}
            },
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                sidecar.unsubscribe(&request_id);
                return ProviderModelFetchResult::Error(format!(
                    "listModels timed out for {provider}"
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                sidecar.unsubscribe(&request_id);
                return ProviderModelFetchResult::Error(format!(
                    "Sidecar disconnected while fetching models for {provider}"
                ));
            }
        }
    }

    sidecar.unsubscribe(&request_id);
    ProviderModelFetchResult::Ready(models)
}

fn classify_model_list_error(message: &str) -> ProviderModelFetchResult {
    if is_provider_unavailable_error(message) {
        return ProviderModelFetchResult::Unavailable(message.to_string());
    }
    ProviderModelFetchResult::Error(message.to_string())
}

fn is_provider_unavailable_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("enoent")
        || normalized.contains("no such file or directory")
        || normalized.contains("command not found")
        || normalized.contains("executable not found")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_missing_binary_errors_as_unavailable() {
        assert!(is_provider_unavailable_error(
            "spawn codex ENOENT: No such file or directory"
        ));
        assert!(is_provider_unavailable_error(
            "Claude Code executable not found at /tmp/cli.js"
        ));
    }

    #[test]
    fn leaves_timeouts_as_transient_errors() {
        assert!(!is_provider_unavailable_error(
            "listModels timed out after 15000ms"
        ));
    }
}
