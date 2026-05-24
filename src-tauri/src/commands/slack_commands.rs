//! IPC commands for the Slack Context source.
//!
//! Only path here: `slack_import_from_desktop` reads the user's
//! locally-installed Slack desktop session and imports every workspace
//! the user is already signed into. No in-app sign-in flow — that path
//! was tried and abandoned (Slack actively blocks non-Electron
//! webviews from completing auth).

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::Context;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle};

use crate::models::slack_workspaces;
use crate::slack::{
    agent_context::{self, AgentContextInputs},
    api as slack_api, credentials, desktop_scrape, detail, files as slack_files, inbox,
    types::{SlackFileRef, SlackWorkspace},
};
use crate::ui_sync::{self, UiMutationEvent};

use super::common::{run_blocking, CmdResult};

#[tauri::command]
pub async fn slack_list_workspaces() -> CmdResult<Vec<SlackWorkspace>> {
    run_blocking(slack_workspaces::list_workspaces).await
}

#[tauri::command]
pub async fn slack_disconnect_workspace(app: AppHandle, team_id: String) -> CmdResult<()> {
    let app_handle = app.clone();
    run_blocking(move || {
        // Clear keyring first — even if the DB delete fails, the
        // credential is gone, which is the security-relevant outcome.
        let _ = credentials::clear_credentials(&team_id);
        slack_workspaces::delete_workspace(&team_id)
            .context("Failed to delete slack workspace row")?;
        ui_sync::publish(&app_handle, UiMutationEvent::SlackWorkspacesChanged);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn slack_list_inbox_items(
    app: AppHandle,
    team_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> CmdResult<crate::slack::types::SlackInboxPage> {
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let app_handle = app.clone();
    let team_id_for_lookup = team_id.clone();
    run_blocking(move || {
        let workspace = slack_workspaces::get_workspace(&team_id_for_lookup)?
            .with_context(|| format!("Slack workspace {team_id_for_lookup} is not connected"))?;
        match inbox::list_inbox_items(
            &workspace.team_id,
            &workspace.my_user_id,
            cursor.as_deref(),
            limit,
        ) {
            Ok(page) => Ok(page),
            Err(error) => {
                if slack_api::is_invalid_auth(&error) {
                    let _ = credentials::clear_credentials(&workspace.team_id);
                    ui_sync::publish(
                        &app_handle,
                        UiMutationEvent::SlackTokenInvalidated {
                            team_id: workspace.team_id.clone(),
                        },
                    );
                }
                Err(error)
            }
        }
    })
    .await
}

/// Sort hint forwarded to `search.messages`. Mirrors
/// `crate::slack::api::SearchSort` but stays string-shaped at the IPC
/// boundary so the wire format is self-describing in logs.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlackSearchSort {
    /// Newest first — Slack's `sort=timestamp`. Default for the
    /// inbox-style list users see when typing in the search box.
    Newest,
    /// Slack's `sort=score` — relevance ranking from the search index.
    Relevance,
}

impl From<SlackSearchSort> for slack_api::SearchSort {
    fn from(value: SlackSearchSort) -> Self {
        match value {
            SlackSearchSort::Newest => slack_api::SearchSort::Timestamp,
            SlackSearchSort::Relevance => slack_api::SearchSort::Score,
        }
    }
}

#[tauri::command]
pub async fn slack_search_messages(
    app: AppHandle,
    team_id: String,
    query: String,
    sort: Option<SlackSearchSort>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> CmdResult<crate::slack::types::SlackInboxPage> {
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let sort = sort.unwrap_or(SlackSearchSort::Newest).into();
    let app_handle = app.clone();
    let team_id_for_lookup = team_id.clone();
    run_blocking(move || {
        let workspace = slack_workspaces::get_workspace(&team_id_for_lookup)?
            .with_context(|| format!("Slack workspace {team_id_for_lookup} is not connected"))?;
        match inbox::search(&workspace.team_id, &query, sort, cursor.as_deref(), limit) {
            Ok(page) => Ok(page),
            Err(error) => {
                if slack_api::is_invalid_auth(&error) {
                    let _ = credentials::clear_credentials(&workspace.team_id);
                    ui_sync::publish(
                        &app_handle,
                        UiMutationEvent::SlackTokenInvalidated {
                            team_id: workspace.team_id.clone(),
                        },
                    );
                }
                Err(error)
            }
        }
    })
    .await
}

/// Progress notification streamed back to the frontend while the
/// `slack_prepare_thread_context` command runs. Drives the "Preparing
/// Slack context…" toast.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum SlackPrepareProgress {
    /// First step — calling `slack_get_thread_detail` to pull the
    /// thread structure. No counts because we don't know how many
    /// files there will be yet.
    FetchingThread,
    /// Pre-warming the file cache, one file at a time. `current` is
    /// 0-indexed across the run; `total` stays stable across the
    /// caching phase so the frontend can render an X/Y label.
    CachingFiles { current: usize, total: usize },
}

/// Output of `slack_prepare_thread_context` — the enriched submit text
/// destined for the composer + the cached image paths the frontend
/// should attach as `kind: "image"` insert items so the agent gets
/// them as vision input (not just a text reference).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackPreparedContext {
    pub submit_text: String,
    pub files_total: usize,
    pub files_cached: usize,
    /// Absolute local paths of every cached image / gif / video-poster
    /// in the thread. Ordering: chronological by message, then by
    /// per-message declaration order. De-duped by Slack file id so a
    /// re-shared attachment appears once even if it crosses multiple
    /// replies. Frontend wraps each path in a `kind: "image"`
    /// ComposerInsertItem; the existing composer pipeline carries it
    /// to the spawned agent as a vision attachment.
    pub image_paths: Vec<String>,
}

/// Drives the "Add to context" button on a Slack inbox card.
///
/// Walks: fetch the thread → for every image/gif/video poster file,
/// hit `slack::files::resolve_to_path` to pre-warm the on-disk cache →
/// stitch a prompt-friendly markdown string via
/// `agent_context::format_thread_for_agent` and return it.
///
/// File-cache failures are non-fatal per-file: the bad file is just
/// rendered with its name + permalink (no `Local path:` line) so the
/// agent at least knows it existed. We report cache totals back so
/// the frontend can surface partial-success toasts.
#[tauri::command]
pub async fn slack_prepare_thread_context(
    progress: Channel<SlackPrepareProgress>,
    team_id: String,
    channel_id: String,
    thread_ts: Option<String>,
    anchor_ts: String,
) -> CmdResult<SlackPreparedContext> {
    run_blocking(move || {
        let workspace = slack_workspaces::get_workspace(&team_id)?
            .with_context(|| format!("Slack workspace {team_id} is not connected"))?;

        let _ = progress.send(SlackPrepareProgress::FetchingThread);
        let detail = detail::get_thread_detail(
            &workspace.team_id,
            &channel_id,
            thread_ts.as_deref(),
            &anchor_ts,
        )
        .context("Fetch Slack thread for context preparation")?;

        // Collect every file we want to cache. Images and gifs use
        // `preview_url` (the thumb), videos prefer `previewUrl` (which
        // is `thumb_video` from detail.rs) — full video bytes are too
        // big to pre-cache here.
        let prefetch_targets: Vec<(String, String)> = detail
            .messages
            .iter()
            .flat_map(|m| m.files.iter().map(file_prefetch_url))
            .flatten()
            .collect();
        let total = prefetch_targets.len();

        let mut cache_paths: HashMap<String, PathBuf> = HashMap::new();
        for (i, (file_id, slack_url)) in prefetch_targets.iter().enumerate() {
            let _ = progress.send(SlackPrepareProgress::CachingFiles { current: i, total });
            match slack_files::resolve_to_path(slack_url) {
                Ok(path) => {
                    cache_paths.insert(file_id.clone(), path);
                }
                Err(error) => {
                    tracing::warn!(
                        file_id = %file_id,
                        url = %slack_url,
                        error = %format!("{error:#}"),
                        "Failed to pre-cache Slack file for agent context",
                    );
                }
            }
        }

        let submit_text = agent_context::format_thread_for_agent(
            &detail,
            &AgentContextInputs {
                my_user_id: &workspace.my_user_id,
                workspace_name: &workspace.team_name,
                cache_paths: &cache_paths,
                // Caps the rendered thread to keep the prompt bounded.
                // 50 covers nearly every real conversation while still
                // protecting against runaway megathread injection.
                max_messages: 50,
            },
        );

        // Order + dedup logic lives in `agent_context::collect_image_paths`
        // so it can be unit-tested without spinning up workspace creds.
        let image_paths = agent_context::collect_image_paths(&detail, &cache_paths);

        let result = SlackPreparedContext {
            submit_text,
            files_total: total,
            files_cached: cache_paths.len(),
            image_paths,
        };
        Ok(result)
    })
    .await
}

/// Pick the URL we should pre-cache for one file. Returns `None` for
/// categories we don't render inline (audio / pdf / other) — those
/// still surface as a name + permalink chip in the prompt, but we
/// don't burn the bandwidth pre-fetching them.
fn file_prefetch_url(file: &SlackFileRef) -> Option<(String, String)> {
    let category = file.category.as_str();
    if !matches!(category, "image" | "gif" | "video") {
        return None;
    }
    let url = file.preview_url.as_deref()?.to_string();
    Some((file.id.clone(), url))
}

/// Return the workspace's custom-emoji map (`name -> image_url`).
/// Built-in unicode emojis are NOT included — those are bundled
/// frontend-side in `src/lib/slack-emoji-builtin.ts`. Aliases are
/// followed once so callers see only direct URLs.
///
/// Cached in-process with a 1h TTL (`api::emoji_list`). On every call
/// we still hit the cache first; the underlying API request only fires
/// when the cache miss-or-expires.
#[tauri::command]
pub async fn slack_list_emoji(
    app: AppHandle,
    team_id: String,
) -> CmdResult<std::collections::HashMap<String, String>> {
    let app_handle = app.clone();
    run_blocking(move || {
        let creds = match credentials::load_credentials(&team_id)? {
            Some(c) => c,
            None => anyhow::bail!("Slack workspace {team_id} is not connected"),
        };
        match slack_api::emoji_list(&team_id, &creds) {
            Ok(map) => Ok(map),
            Err(error) => {
                if slack_api::is_invalid_auth(&error) {
                    let _ = credentials::clear_credentials(&team_id);
                    ui_sync::publish(
                        &app_handle,
                        UiMutationEvent::SlackTokenInvalidated {
                            team_id: team_id.clone(),
                        },
                    );
                }
                Err(error)
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn slack_get_thread_detail(
    app: AppHandle,
    team_id: String,
    channel_id: String,
    thread_ts: Option<String>,
    anchor_ts: String,
) -> CmdResult<crate::slack::types::SlackThreadDetail> {
    let app_handle = app.clone();
    let team_id_for_emit = team_id.clone();
    run_blocking(move || {
        match detail::get_thread_detail(&team_id, &channel_id, thread_ts.as_deref(), &anchor_ts) {
            Ok(detail) => Ok(detail),
            Err(error) => {
                if slack_api::is_invalid_auth(&error) {
                    let _ = credentials::clear_credentials(&team_id_for_emit);
                    ui_sync::publish(
                        &app_handle,
                        UiMutationEvent::SlackTokenInvalidated {
                            team_id: team_id_for_emit,
                        },
                    );
                }
                Err(error)
            }
        }
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackImportResult {
    /// Workspaces that scraped + auth_test'd successfully and are now
    /// persisted.
    pub imported: Vec<SlackWorkspace>,
    /// Per-workspace failures (display only; nothing to retry yet).
    pub failed: Vec<SlackImportFailure>,
    /// Workspaces the scrape found but the user is already connected to
    /// (no-op, included for UI transparency).
    pub already_connected: Vec<SlackWorkspace>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackImportFailure {
    pub team_id: String,
    pub team_name: String,
    pub reason: String,
}

/// Scrape the local Slack desktop session (macOS only in v1) and import
/// every workspace whose token validates against `auth.test`. Returns a
/// per-workspace breakdown so the UI can show what happened.
///
/// Threat model note: this path reads from `~/Library/Application
/// Support/Slack/` and from the user's login Keychain (for the Safe
/// Storage key). Both are accessible without any prompts because the
/// user owns the data — same trust boundary as Slack desktop itself.
#[tauri::command]
pub async fn slack_import_from_desktop(app: AppHandle) -> CmdResult<SlackImportResult> {
    let app_handle = app.clone();
    run_blocking(move || {
        let discovered = desktop_scrape::scrape().context("Couldn't read Slack desktop session")?;
        if discovered.is_empty() {
            return Ok(SlackImportResult {
                imported: Vec::new(),
                failed: Vec::new(),
                already_connected: Vec::new(),
            });
        }

        let mut imported = Vec::new();
        let mut failed = Vec::new();
        let mut already = Vec::new();

        for team in discovered {
            match slack_api::auth_test(&team.creds) {
                Ok(identity) => {
                    // Trust auth.test's identity over what the leveldb said;
                    // it's the live server-side truth (handles renamed teams,
                    // stale local cache, etc).
                    let workspace = SlackWorkspace {
                        team_id: identity.team_id.clone(),
                        team_name: if identity.team_name.is_empty() {
                            team.team_name
                        } else {
                            identity.team_name
                        },
                        team_domain: derive_team_domain(&identity.url).unwrap_or(team.team_domain),
                        my_user_id: identity.my_user_id,
                        added_at: Utc::now().timestamp(),
                    };

                    let pre_existing = slack_workspaces::get_workspace(&workspace.team_id)
                        .ok()
                        .flatten()
                        .is_some();

                    if let Err(error) =
                        credentials::store_credentials(&workspace.team_id, &team.creds)
                    {
                        failed.push(SlackImportFailure {
                            team_id: workspace.team_id.clone(),
                            team_name: workspace.team_name.clone(),
                            reason: format!("Couldn't save credential: {error:#}"),
                        });
                        continue;
                    }
                    if let Err(error) = slack_workspaces::upsert_workspace(&workspace) {
                        failed.push(SlackImportFailure {
                            team_id: workspace.team_id.clone(),
                            team_name: workspace.team_name.clone(),
                            reason: format!("Couldn't save workspace row: {error:#}"),
                        });
                        continue;
                    }
                    if pre_existing {
                        already.push(workspace);
                    } else {
                        imported.push(workspace);
                    }
                }
                Err(error) => {
                    let reason = if slack_api::is_invalid_auth(&error) {
                        "Token rejected by Slack (signed out elsewhere?)".to_string()
                    } else {
                        format!("{error:#}")
                    };
                    failed.push(SlackImportFailure {
                        team_id: team.team_id,
                        team_name: team.team_name,
                        reason,
                    });
                }
            }
        }

        if !imported.is_empty() || !already.is_empty() {
            ui_sync::publish(&app_handle, UiMutationEvent::SlackWorkspacesChanged);
        }

        Ok(SlackImportResult {
            imported,
            failed,
            already_connected: already,
        })
    })
    .await
}

fn derive_team_domain(team_url: &str) -> Option<String> {
    // Slack's `auth.test` returns `url: "https://teamname.slack.com/"`.
    // The subdomain is the canonical team domain.
    let url = url::Url::parse(team_url).ok()?;
    let host = url.host_str()?;
    let subdomain = host.split('.').next()?;
    if subdomain.is_empty() {
        None
    } else {
        Some(subdomain.to_string())
    }
}
