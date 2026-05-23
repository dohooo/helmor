//! IPC commands for the Slack Context source.
//!
//! Only path here: `slack_import_from_desktop` reads the user's
//! locally-installed Slack desktop session and imports every workspace
//! the user is already signed into. No in-app sign-in flow — that path
//! was tried and abandoned (Slack actively blocks non-Electron
//! webviews from completing auth).

use anyhow::Context;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::models::slack_workspaces;
use crate::slack::{
    api as slack_api, credentials, desktop_scrape, detail, inbox, types::SlackWorkspace,
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
    let team_id_for_lookup = team_id.clone();
    run_blocking(move || {
        let workspace = slack_workspaces::get_workspace(&team_id_for_lookup)?
            .with_context(|| format!("Slack workspace {team_id_for_lookup} is not connected"))?;
        let creds = match credentials::load_credentials(&workspace.team_id)? {
            Some(c) => c,
            None => anyhow::bail!("No stored Slack credentials for team {}", workspace.team_id),
        };
        match slack_api::emoji_list(&workspace.team_id, &creds) {
            Ok(map) => Ok(map),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
