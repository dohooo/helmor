use crate::forge::{
    self,
    accounts::{self, ForgeAccount},
    forge_backend_for, ChangeRequestInfo, ForgeActionStatus, ForgeDetection, ForgeLabelOption,
    ForgeProvider, InboxFilters, InboxItemDetail, InboxKind, InboxKindLabels, InboxPage,
    InboxSource, RemoteState,
};
// `accounts` re-exports the dispatchers; provider-specific work
// happens inside `forge::github::accounts` / `forge::gitlab::accounts`
// via the `ForgeAccountBackend` trait.
use crate::ui_sync::{self, UiMutationEvent};
use crate::workspace::scripts::{ScriptContext, ScriptEvent, ScriptProcessManager};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{ipc::Channel, State};

use super::common::{run_blocking, CmdResult};

/// Per-workspace marker for "we already published Unauthenticated for this
/// workspace". The action-status poll fires every ~60s while not OK; without
/// edge-detection it would republish the same event on every tick and fan
/// out a cache-wide invalidation storm. Registered as Tauri AppState so its
/// lifecycle tracks the app and tests can construct their own.
#[derive(Default)]
pub struct ForgeAuthEdgeStore {
    published_unauth: Mutex<HashSet<String>>,
}

#[tauri::command]
pub async fn get_workspace_forge(workspace_id: String) -> CmdResult<ForgeDetection> {
    run_blocking(move || forge::get_workspace_forge(&workspace_id)).await
}

/// Enumerate all gh accounts (across every host) plus one glab account
/// per `gitlab_hosts` entry. Used by Settings → Account to render the
/// avatar/name/login/email roster.
#[tauri::command]
pub async fn list_forge_accounts(gitlab_hosts: Vec<String>) -> CmdResult<Vec<ForgeAccount>> {
    run_blocking(move || Ok(accounts::list_forge_accounts(&gitlab_hosts))).await
}

/// One kind per call. Frontend must check `list_inbox_kind_labels`
/// first — `(Gitlab, Discussions)` errors out (not supported).
/// `cursor` is opaque; `limit` clamps to [1, 100].
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn list_inbox_items(
    provider: ForgeProvider,
    kind: InboxKind,
    login: String,
    host: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
    repo: Option<String>,
    filters: Option<InboxFilters>,
) -> CmdResult<InboxPage> {
    let limit = limit.unwrap_or(20).clamp(1, 100) as usize;
    run_blocking(move || {
        let Some(backend) = forge_backend_for(provider) else {
            return Ok(InboxPage {
                items: Vec::new(),
                next_cursor: None,
            });
        };
        match kind {
            InboxKind::Issues => backend.list_inbox_issues(
                &login,
                host.as_deref(),
                cursor.as_deref(),
                limit,
                repo.as_deref(),
                filters,
            ),
            InboxKind::Prs => backend.list_inbox_prs(
                &login,
                host.as_deref(),
                cursor.as_deref(),
                limit,
                repo.as_deref(),
                filters,
            ),
            InboxKind::Discussions => backend.list_inbox_discussions(
                &login,
                host.as_deref(),
                cursor.as_deref(),
                limit,
                repo.as_deref(),
                filters,
            ),
        }
    })
    .await
}

/// Inbox kinds the forge supports, paired with their labels (the strings
/// the frontend renders). GitHub returns `[issues, prs, discussions]`
/// with PR-flavoured copy; GitLab returns `[issues, prs]` with
/// MR-flavoured copy and no Discussions entry. The frontend reads
/// labels from the response and never branches on provider for copy.
#[tauri::command]
pub async fn list_inbox_kind_labels(provider: ForgeProvider) -> CmdResult<Vec<InboxKindLabels>> {
    run_blocking(move || {
        let Some(backend) = forge_backend_for(provider) else {
            return Ok(Vec::new());
        };
        Ok(backend.inbox_kind_labels())
    })
    .await
}

/// Repository label set for the labels multi-select in Settings →
/// Context. Routes via the forge backend so both GitHub and GitLab
/// share one command. `host` is required for GitLab (self-hosted
/// instances differ per project) and ignored by GitHub today.
#[tauri::command]
pub async fn list_forge_labels(
    provider: ForgeProvider,
    login: String,
    host: Option<String>,
    repos: Vec<String>,
) -> CmdResult<Vec<ForgeLabelOption>> {
    run_blocking(move || {
        let Some(backend) = forge_backend_for(provider) else {
            return Ok(Vec::new());
        };
        backend.list_repo_labels(&login, host.as_deref(), &repos)
    })
    .await
}

/// Fetch native detail data for one inbox item. `host` mirrors
/// `list_inbox_items` — needed for self-hosted GitLab so the call hits
/// the same instance the item came from.
#[tauri::command]
pub async fn get_inbox_item_detail(
    provider: ForgeProvider,
    login: String,
    host: Option<String>,
    source: InboxSource,
    external_id: String,
) -> CmdResult<Option<InboxItemDetail>> {
    run_blocking(move || {
        let Some(backend) = forge_backend_for(provider) else {
            return Ok(None);
        };
        backend.get_inbox_item_detail(&login, host.as_deref(), source, &external_id)
    })
    .await
}

/// Resolve the gh/glab account bound to a workspace's parent repo and
/// return its display profile (avatar / name / email). Powers the
/// branch-chip avatar; reuses the per-process profile cache.
#[tauri::command]
pub async fn get_workspace_account_profile(
    workspace_id: String,
) -> CmdResult<Option<ForgeAccount>> {
    run_blocking(move || accounts::workspace_account_profile(&workspace_id)).await
}

/// Download an avatar URL (if not already cached) and return the
/// absolute filesystem path. The frontend wraps it with `convertFileSrc`
/// to render via the `asset://` protocol — saves an HTTP round trip and
/// re-decode on every page navigation.
#[tauri::command]
pub async fn cache_forge_avatar(url: String) -> CmdResult<String> {
    run_blocking(move || {
        let path = forge::avatar_cache::cached_avatar_path(&url)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

/// Just the login names on `(provider, host)`. Lightweight — does not
/// fetch per-account profile data via `gh api /user`. Used by the
/// onboarding flow's `pollUntilReady` loop: snapshot the set before
/// the embedded auth terminal opens, then poll until the set grows
/// (= a new account got registered).
#[tauri::command]
pub async fn list_forge_logins(
    provider: ForgeProvider,
    host: String,
    force_refresh: Option<bool>,
) -> CmdResult<Vec<String>> {
    run_blocking(move || {
        if force_refresh.unwrap_or(false) {
            accounts::invalidate_caches_for_host(provider, &host);
        }
        match accounts::backend_for(provider) {
            Some(backend) => backend.list_logins(&host),
            None => Ok(Vec::new()),
        }
    })
    .await
}

/// Re-run auto-bind for every repo whose `forge_login` is still NULL.
/// Frontend triggers this from the Settings → Account "Add account"
/// flow once a fresh login appears, so legacy / previously-unbindable
/// repos pick up the new credentials without an app restart. Returns
/// the number of repos that ended up bound on this sweep so the caller
/// can decide whether to invalidate caches.
#[tauri::command]
pub async fn backfill_forge_repo_bindings(app: tauri::AppHandle) -> CmdResult<usize> {
    let summary = run_blocking(forge::accounts::backfill_unbound_repos).await?;
    if summary.bound > 0 {
        ui_sync::publish(&app, UiMutationEvent::RepositoryListChanged);
    }
    Ok(summary.bound)
}

fn forge_cli_auth_script_type(provider: ForgeProvider, host: &str, instance_id: &str) -> String {
    format!("forge-cli-auth:{provider:?}:{host}:{instance_id}")
}

const FORGE_CLI_AUTH_REPO_ID: &str = "__helmor_onboarding_forge__";

#[tauri::command]
pub async fn spawn_forge_cli_auth_terminal(
    manager: State<'_, ScriptProcessManager>,
    provider: ForgeProvider,
    host: Option<String>,
    instance_id: String,
    channel: Channel<ScriptEvent>,
) -> CmdResult<()> {
    let host = host.unwrap_or_else(|| "gitlab.com".to_string());
    let command = forge::forge_cli_auth_command(provider, Some(&host))?;
    let working_dir = std::env::var("HOME")
        .ok()
        .filter(|home| !home.trim().is_empty())
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| path.display().to_string())
        })
        .unwrap_or_else(|| "/".to_string());
    let context = ScriptContext {
        root_path: working_dir.clone(),
        workspace_path: None,
        workspace_name: None,
        default_branch: None,
    };
    let mgr = manager.inner().clone();
    let script_type = forge_cli_auth_script_type(provider, &host, &instance_id);

    tauri::async_runtime::spawn_blocking(move || {
        // Auto-type the auth command via the run_terminal_session boot
        // input — written synchronously to the PTY master right after
        // the shell registers, so a frontend re-render-driven
        // cleanup→respawn can't drop the bytes.
        let boot_input = format!("{command}; exit\n");
        if let Err(error) = crate::workspace::scripts::run_terminal_session(
            &mgr,
            FORGE_CLI_AUTH_REPO_ID,
            &script_type,
            None,
            &working_dir,
            &context,
            channel.clone(),
            Some(&boot_input),
        ) {
            let _ = channel.send(ScriptEvent::Error {
                message: error.to_string(),
            });
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_forge_cli_auth_terminal(
    manager: State<'_, ScriptProcessManager>,
    provider: ForgeProvider,
    host: Option<String>,
    instance_id: String,
) -> CmdResult<bool> {
    let host = host.unwrap_or_else(|| "gitlab.com".to_string());
    let key = (
        FORGE_CLI_AUTH_REPO_ID.to_string(),
        forge_cli_auth_script_type(provider, &host, &instance_id),
        None,
    );
    Ok(manager.kill(&key))
}

/// Drop the per-process forge caches (login enumeration, status pairs,
/// profile) for `(provider, host)`. Frontend calls this immediately
/// after the auth terminal exits so the very next `list_forge_logins`
/// poll bypasses the rate-limiter cache and sees the new login.
#[tauri::command]
pub async fn invalidate_forge_caches(
    provider: ForgeProvider,
    host: Option<String>,
) -> CmdResult<()> {
    let host = host.unwrap_or_else(|| "gitlab.com".to_string());
    run_blocking(move || {
        accounts::invalidate_caches_for_host(provider, &host);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn write_forge_cli_auth_terminal_stdin(
    manager: State<'_, ScriptProcessManager>,
    provider: ForgeProvider,
    host: Option<String>,
    instance_id: String,
    data: String,
) -> CmdResult<bool> {
    let host = host.unwrap_or_else(|| "gitlab.com".to_string());
    let key = (
        FORGE_CLI_AUTH_REPO_ID.to_string(),
        forge_cli_auth_script_type(provider, &host, &instance_id),
        None,
    );
    Ok(manager.write_stdin(&key, data.as_bytes())?)
}

#[tauri::command]
pub async fn resize_forge_cli_auth_terminal(
    manager: State<'_, ScriptProcessManager>,
    provider: ForgeProvider,
    host: Option<String>,
    instance_id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<bool> {
    let host = host.unwrap_or_else(|| "gitlab.com".to_string());
    let key = (
        FORGE_CLI_AUTH_REPO_ID.to_string(),
        forge_cli_auth_script_type(provider, &host, &instance_id),
        None,
    );
    Ok(manager.resize(&key, cols, rows)?)
}

#[tauri::command]
pub async fn refresh_workspace_change_request(
    workspace_id: String,
    app: tauri::AppHandle,
) -> CmdResult<Option<ChangeRequestInfo>> {
    let lookup_workspace_id = workspace_id.clone();
    let (result, workspace_status_changed) = run_blocking(move || {
        let result = forge::refresh_workspace_change_request(&lookup_workspace_id)?;
        let changed =
            crate::workspaces::sync_workspace_pr_state(&lookup_workspace_id, result.as_ref())?;
        Ok::<_, anyhow::Error>((result, changed))
    })
    .await?;
    if workspace_status_changed {
        ui_sync::publish(
            &app,
            UiMutationEvent::WorkspaceChangeRequestChanged { workspace_id },
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn get_workspace_forge_action_status(
    workspace_id: String,
    app: tauri::AppHandle,
    edge_store: State<'_, ForgeAuthEdgeStore>,
) -> CmdResult<ForgeActionStatus> {
    let lookup_workspace_id = workspace_id.clone();
    let status =
        run_blocking(move || forge::lookup_workspace_forge_action_status(&lookup_workspace_id))
            .await?;
    if should_publish_workspace_forge_changed(&edge_store, &workspace_id, status.remote_state) {
        ui_sync::publish(
            &app,
            UiMutationEvent::WorkspaceForgeChanged { workspace_id },
        );
    }
    Ok(status)
}

#[tauri::command]
pub async fn get_workspace_forge_check_insert_text(
    workspace_id: String,
    item_id: String,
) -> CmdResult<String> {
    run_blocking(move || forge::lookup_workspace_forge_check_insert_text(&workspace_id, &item_id))
        .await
}

#[tauri::command]
pub async fn merge_workspace_change_request(
    workspace_id: String,
    app: tauri::AppHandle,
) -> CmdResult<Option<ChangeRequestInfo>> {
    run_change_request_action(workspace_id, app, forge::merge_workspace_change_request).await
}

#[tauri::command]
pub async fn close_workspace_change_request(
    workspace_id: String,
    app: tauri::AppHandle,
) -> CmdResult<Option<ChangeRequestInfo>> {
    run_change_request_action(workspace_id, app, forge::close_workspace_change_request).await
}

async fn run_change_request_action(
    workspace_id: String,
    app: tauri::AppHandle,
    action: fn(&str) -> anyhow::Result<Option<ChangeRequestInfo>>,
) -> CmdResult<Option<ChangeRequestInfo>> {
    let sync_workspace_id = workspace_id.clone();
    let (result, workspace_status_changed) = run_blocking(move || {
        let result = action(&sync_workspace_id)?;
        let changed =
            crate::workspaces::sync_workspace_pr_state(&sync_workspace_id, result.as_ref())?;
        Ok::<_, anyhow::Error>((result, changed))
    })
    .await?;
    if workspace_status_changed {
        ui_sync::publish(
            &app,
            UiMutationEvent::WorkspaceChangeRequestChanged { workspace_id },
        );
    }
    Ok(result)
}

fn should_publish_workspace_forge_changed(
    store: &ForgeAuthEdgeStore,
    workspace_id: &str,
    remote_state: RemoteState,
) -> bool {
    let mut published = store
        .published_unauth
        .lock()
        .expect("forge auth edge store mutex poisoned");
    if remote_state == RemoteState::Unauthenticated {
        // `insert` returns true only on first insertion → that's the edge
        // we want to publish on. Subsequent ticks with the same state no-op.
        published.insert(workspace_id.to_string())
    } else {
        // Any other state clears the marker so a future flip back into
        // Unauthenticated republishes once.
        published.remove(workspace_id);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_unauthenticated_tick_publishes_then_subsequent_ticks_do_not() {
        let store = ForgeAuthEdgeStore::default();
        let ws = "ws";
        assert!(should_publish_workspace_forge_changed(
            &store,
            ws,
            RemoteState::Unauthenticated
        ));
        assert!(!should_publish_workspace_forge_changed(
            &store,
            ws,
            RemoteState::Unauthenticated
        ));
        assert!(!should_publish_workspace_forge_changed(
            &store,
            ws,
            RemoteState::Unauthenticated
        ));
    }

    #[test]
    fn non_unauth_states_never_publish_and_clear_the_marker() {
        let store = ForgeAuthEdgeStore::default();
        let ws = "ws";
        for state in [
            RemoteState::Ok,
            RemoteState::NoPr,
            RemoteState::Unavailable,
            RemoteState::Error,
        ] {
            assert!(!should_publish_workspace_forge_changed(&store, ws, state));
        }
    }

    #[test]
    fn flipping_back_to_unauthenticated_republishes_once() {
        let store = ForgeAuthEdgeStore::default();
        let ws = "ws";
        assert!(should_publish_workspace_forge_changed(
            &store,
            ws,
            RemoteState::Unauthenticated
        ));
        // Recovered.
        assert!(!should_publish_workspace_forge_changed(
            &store,
            ws,
            RemoteState::Ok
        ));
        // Lost auth again — must publish.
        assert!(should_publish_workspace_forge_changed(
            &store,
            ws,
            RemoteState::Unauthenticated
        ));
        assert!(!should_publish_workspace_forge_changed(
            &store,
            ws,
            RemoteState::Unauthenticated
        ));
    }

    #[test]
    fn workspaces_track_independent_edges() {
        let store = ForgeAuthEdgeStore::default();
        assert!(should_publish_workspace_forge_changed(
            &store,
            "ws-a",
            RemoteState::Unauthenticated
        ));
        assert!(should_publish_workspace_forge_changed(
            &store,
            "ws-b",
            RemoteState::Unauthenticated
        ));
        assert!(!should_publish_workspace_forge_changed(
            &store,
            "ws-a",
            RemoteState::Unauthenticated
        ));
    }
}
