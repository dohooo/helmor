//! Per-repo gh/glab account binding — orchestration layer.
//!
//! Mirrors the [`super::provider::WorkspaceForgeBackend`] pattern: a
//! [`ForgeAccountBackend`] trait sits in the `forge::` umbrella, with
//! provider-specific implementations living under [`super::github::accounts`]
//! and [`super::gitlab::accounts`]. Top-level helpers in this file
//! dispatch by provider so cross-cutting callers (the auto-bind hook,
//! the Settings → Account panel, the right-top workspace chip) never
//! need to branch on `ForgeProvider` themselves.

use anyhow::{Context, Result};
use serde::Serialize;
use std::str::FromStr;

use super::command::CommandOutput;
use super::remote::parse_remote;
use super::types::ForgeProvider;
use crate::repos;

/// Public profile of a single gh/glab account, surfaced to the
/// frontend's Settings → Account panel. `active` is true for the gh
/// account currently marked active by `gh auth switch`; for GitLab
/// (one-account-per-host) it's always true.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeAccount {
    pub provider: ForgeProvider,
    pub host: String,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub email: Option<String>,
    pub active: bool,
}

/// Tristate auth probe result. `LoggedOut` only when we definitively
/// read the CLI account store and the entry is absent; everything else
/// (process error, transient state, parse failure) is `Indeterminate`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuthCheck {
    LoggedIn,
    LoggedOut,
    Indeterminate,
}

impl AuthCheck {
    pub(crate) fn is_definitely_logged_out(self) -> bool {
        matches!(self, AuthCheck::LoggedOut)
    }
}

/// Provider-agnostic account operations. Each method may interpret
/// `host` / `login` slightly differently — GitLab ignores `login` since
/// it has at most one account per host, while GitHub uses `(host,
/// login)` as the full identity.
pub(crate) trait ForgeAccountBackend: Sync {
    /// Enumerate all accounts (with profile) for this forge.
    /// `hosts_hint` is ignored by GitHub (gh exposes its own host list)
    /// and treated as the host roster by GitLab.
    fn list_accounts(&self, hosts_hint: &[String]) -> Result<Vec<ForgeAccount>>;

    /// Login names for `host`. Used by auto-bind to iterate candidates
    /// without paying the per-account profile fetch.
    fn list_logins(&self, host: &str) -> Result<Vec<String>>;

    /// Single source of truth for "is `(host, login)` still in the CLI
    /// account store?". Implementations must surface transient CLI
    /// failures as `Indeterminate`, never `LoggedOut`.
    fn check_auth(&self, host: &str, login: &str) -> AuthCheck;

    /// 200 → `Ok(true)`, 404 / auth-rejected → `Ok(false)`, anything
    /// else → `Err`.
    fn repo_accessible(&self, host: &str, login: &str, owner: &str, name: &str) -> Result<bool>;

    /// Display profile for a single `(host, login)`. Hits the same
    /// per-process cache as [`list_accounts`] so spot-fetches (e.g. the
    /// branch-chip avatar) don't fan out a second `gh api /user`
    /// roundtrip when the Settings panel already warmed it.
    fn fetch_profile(&self, host: &str, login: &str) -> Result<ForgeAccount>;

    /// Spawn the forge CLI scoped to `(host, login)`. GitHub sets
    /// `GH_TOKEN`; GitLab passes `--hostname`.
    #[allow(dead_code)] // Reserved for callers that need a unified runner.
    fn run_cli(&self, host: &str, login: &str, args: &[&str]) -> Result<CommandOutput>;
}

pub(crate) fn backend_for(provider: ForgeProvider) -> Option<&'static dyn ForgeAccountBackend> {
    match provider {
        ForgeProvider::Github => Some(&super::github::accounts::BACKEND),
        ForgeProvider::Gitlab => Some(&super::gitlab::accounts::BACKEND),
        ForgeProvider::Unknown => None,
    }
}

// ---------------- Top-level dispatchers ----------------

/// All gh accounts plus one glab account per `gitlab_hosts` entry.
/// Errors from individual backends are logged and skipped so a transient
/// problem with one CLI doesn't blank the whole panel.
pub(crate) fn list_forge_accounts(gitlab_hosts: &[String]) -> Vec<ForgeAccount> {
    let mut accounts = Vec::new();
    if let Some(backend) = backend_for(ForgeProvider::Github) {
        match backend.list_accounts(&[]) {
            Ok(items) => accounts.extend(items),
            Err(error) => tracing::warn!(
                error = %format!("{error:#}"),
                "Failed to enumerate GitHub accounts"
            ),
        }
    }
    if let Some(backend) = backend_for(ForgeProvider::Gitlab) {
        match backend.list_accounts(gitlab_hosts) {
            Ok(items) => accounts.extend(items),
            Err(error) => tracing::warn!(
                error = %format!("{error:#}"),
                "Failed to enumerate GitLab accounts"
            ),
        }
    }
    accounts
}

/// Drop the per-process forge caches (login enumeration, status
/// pairs, profile) for `(provider, host)` so the next `list_logins`
/// / `list_accounts` call hits the CLI fresh. Called after the auth
/// terminal exits — without this the short TTL can still hold the
/// pre-login state and the post-auth poll would spin until expiry.
pub(crate) fn invalidate_caches_for_host(provider: ForgeProvider, host: &str) {
    match provider {
        ForgeProvider::Github => crate::forge::github::accounts::invalidate_caches_for_host(host),
        ForgeProvider::Gitlab => crate::forge::gitlab::accounts::invalidate_caches_for_host(host),
        ForgeProvider::Unknown => {}
    }
}

/// Resolve the forge account bound to a workspace's parent repo and
/// fetch its display profile. Returns `None` when no provider, no
/// remote URL, or no bound login. Reuses the per-process profile
/// cache populated by Settings → Account.
pub fn workspace_account_profile(workspace_id: &str) -> Result<Option<ForgeAccount>> {
    let Some(workspace) = crate::models::workspaces::load_workspace_record_by_id(workspace_id)?
    else {
        return Ok(None);
    };
    let login = match workspace.forge_login.as_deref() {
        Some(value) if !value.trim().is_empty() => value,
        _ => return Ok(None),
    };
    let Some(target) = forge_target_from(
        workspace.forge_provider.as_deref(),
        workspace.remote_url.as_deref(),
    ) else {
        return Ok(None);
    };
    let Some(backend) = backend_for(target.provider) else {
        return Ok(None);
    };
    Ok(Some(backend.fetch_profile(&target.host, login)?))
}

// ---------------- Auto-bind ----------------

/// Resolved forge identity for a repo: provider, host, owner, name. The
/// caller probes `repo_accessible` against candidate logins (auto-bind)
/// or runs CLI commands once a login is bound.
#[derive(Debug, Clone)]
pub(crate) struct RepoForgeTarget {
    pub provider: ForgeProvider,
    pub host: String,
    pub owner: String,
    pub name: String,
}

/// Parse `(forge_provider, remote_url)` from a repo row into a target.
/// `None` when the inputs aren't sufficient (no remote URL, unknown
/// provider, malformed URL).
pub(crate) fn forge_target_from(
    forge_provider: Option<&str>,
    remote_url: Option<&str>,
) -> Option<RepoForgeTarget> {
    let provider = forge_provider
        .and_then(|value| ForgeProvider::from_str(value).ok())
        .unwrap_or(ForgeProvider::Unknown);
    if matches!(provider, ForgeProvider::Unknown) {
        return None;
    }
    let remote_url = remote_url?;
    let parsed = parse_remote(remote_url)?;
    if parsed.namespace.is_empty() || parsed.repo.is_empty() {
        return None;
    }
    Some(RepoForgeTarget {
        provider,
        host: parsed.host,
        owner: parsed.namespace,
        name: parsed.repo,
    })
}

/// Auto-detect which logged-in gh/glab account has access to this repo
/// and persist the binding into `repos.forge_login`. Returns the bound
/// login on success (or `Ok(None)` when no candidate had access).
/// Errors only on truly unexpected CLI failures; the standard "no auth"
/// / "no network" / "404" cases all return `Ok(None)` so the caller can
/// keep going and let the user resolve via Connect.
pub(crate) fn auto_bind_repo_account(repo_id: &str) -> Result<Option<String>> {
    let Some(record) = repos::load_repository_by_id(repo_id)? else {
        return Ok(None);
    };
    let Some(target) = forge_target_from(
        record.forge_provider.as_deref(),
        record_remote_url(&record).as_deref(),
    ) else {
        return Ok(None);
    };
    let Some(backend) = backend_for(target.provider) else {
        return Ok(None);
    };

    let candidates = backend.list_logins(&target.host).with_context(|| {
        format!(
            "Failed to list {} accounts",
            target.provider.as_storage_str()
        )
    })?;
    if candidates.is_empty() {
        return Ok(None);
    }

    // Probe every candidate so we can both pick a winner *and*
    // surface a warning when more than one account claims access —
    // first-match-wins is fine in practice but the user should know
    // they have an ambiguous binding so they can override it from
    // Settings → Repository if the auto-pick is wrong.
    let mut accessible: Vec<String> = Vec::new();
    for login in &candidates {
        match backend.repo_accessible(&target.host, login, &target.owner, &target.name) {
            Ok(true) => accessible.push(login.clone()),
            Ok(false) => continue,
            Err(error) => {
                tracing::warn!(
                    repo_id,
                    login = %login,
                    error = %format!("{error:#}"),
                    "Forge access probe failed; trying next candidate"
                );
            }
        }
    }
    let Some(chosen) = accessible.first().cloned() else {
        return Ok(None);
    };
    if accessible.len() > 1 {
        tracing::warn!(
            repo_id,
            provider = target.provider.as_storage_str(),
            host = %target.host,
            chosen = %chosen,
            candidates = ?accessible,
            "Multiple logged-in accounts can access this repo — picked the first; user can override from Settings → Repository"
        );
    }
    repos::update_repository_forge_login(repo_id, Some(&chosen))?;
    tracing::info!(
        repo_id,
        provider = target.provider.as_storage_str(),
        host = %target.host,
        login = %chosen,
        "Auto-bound repo to forge account"
    );
    Ok(Some(chosen))
}

/// Outcome of a backfill sweep — number of NULL bindings we managed to
/// bind, vs. the total candidates we examined. Returned so the caller
/// can decide whether to broadcast a `RepositoryListChanged` event.
#[derive(Debug, Clone, Copy, Default)]
pub struct BackfillSummary {
    pub examined: usize,
    pub bound: usize,
}

/// Two phases: bind repos with NULL `forge_login`, then re-bind ones
/// whose stored login `check_auth` reports definitively gone.
/// Per-row errors are swallowed (logged at warn).
pub fn backfill_unbound_repos() -> Result<BackfillSummary> {
    let unbound = repos::list_repos_needing_forge_binding()
        .context("Failed to list repos needing forge binding")?;
    let stale = repos::list_forge_bound_repos()
        .context("Failed to list forge-bound repos for stale-binding check")?;
    let mut summary = BackfillSummary {
        examined: unbound.len() + stale.len(),
        ..Default::default()
    };

    // Phase 1: NULL bindings.
    for repo_id in &unbound {
        match auto_bind_repo_account(repo_id) {
            Ok(Some(login)) => {
                summary.bound += 1;
                tracing::info!(
                    repo_id = %repo_id,
                    login = %login,
                    "Backfilled forge_login binding"
                );
            }
            Ok(None) => {
                tracing::debug!(
                    repo_id = %repo_id,
                    "Backfill found no logged-in account with access"
                );
            }
            Err(error) => {
                tracing::warn!(
                    repo_id = %repo_id,
                    error = %format!("{error:#}"),
                    "Backfill auto-bind raised an error; skipping"
                );
            }
        }
    }

    // Phase 2: stale bindings. Backend `check_auth` shares the
    // per-process logins cache (2s TTL) so repeated calls dedupe.
    for entry in &stale {
        let Some(record) = repos::load_repository_by_id(&entry.id).ok().flatten() else {
            continue;
        };
        let Some(target) = forge_target_from(
            record.forge_provider.as_deref(),
            record_remote_url(&record).as_deref(),
        ) else {
            continue;
        };
        let Some(backend) = backend_for(target.provider) else {
            continue;
        };
        if !backend
            .check_auth(&target.host, &entry.login)
            .is_definitely_logged_out()
        {
            // LoggedIn or Indeterminate — preserve the binding.
            continue;
        }
        // The bound login is definitively gone from the CLI. Clear
        // and re-bind.
        if let Err(error) = repos::update_repository_forge_login(&entry.id, None) {
            tracing::warn!(
                repo_id = %entry.id,
                stale_login = %entry.login,
                error = %format!("{error:#}"),
                "Failed to clear stale forge_login; skipping"
            );
            continue;
        }
        match auto_bind_repo_account(&entry.id) {
            Ok(Some(login)) => {
                summary.bound += 1;
                tracing::info!(
                    repo_id = %entry.id,
                    stale_login = %entry.login,
                    new_login = %login,
                    "Re-bound stale forge_login"
                );
            }
            Ok(None) => {
                tracing::info!(
                    repo_id = %entry.id,
                    stale_login = %entry.login,
                    "Cleared stale forge_login; no replacement account had access"
                );
            }
            Err(error) => {
                tracing::warn!(
                    repo_id = %entry.id,
                    stale_login = %entry.login,
                    error = %format!("{error:#}"),
                    "Re-bind raised an error after clearing stale forge_login; skipping"
                );
            }
        }
    }

    Ok(summary)
}

fn record_remote_url(record: &repos::RepositoryRecord) -> Option<String> {
    // `remote_url` lives on the repos row but isn't carried by
    // `RepositoryRecord` today. Pull it via a focused query; the
    // auto-bind path runs once per repo creation so the extra read is
    // cheap.
    let connection = match crate::db::read_conn() {
        Ok(connection) => connection,
        Err(error) => {
            tracing::warn!(error = %error, "Failed to open db while loading remote_url");
            return None;
        }
    };
    connection
        .query_row(
            "SELECT remote_url FROM repos WHERE id = ?1",
            [&record.id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forge_target_from_parses_github_remote() {
        let target = forge_target_from(
            Some("github"),
            Some("git@github.com:octocat/hello-world.git"),
        )
        .unwrap();
        assert_eq!(target.provider, ForgeProvider::Github);
        assert_eq!(target.host, "github.com");
        assert_eq!(target.owner, "octocat");
        assert_eq!(target.name, "hello-world");
    }

    #[test]
    fn forge_target_from_parses_nested_gitlab_namespace() {
        let target = forge_target_from(
            Some("gitlab"),
            Some("git@gitlab.example.com:platform/tools/api.git"),
        )
        .unwrap();
        assert_eq!(target.provider, ForgeProvider::Gitlab);
        assert_eq!(target.host, "gitlab.example.com");
        assert_eq!(target.owner, "platform/tools");
        assert_eq!(target.name, "api");
    }

    #[test]
    fn forge_target_from_returns_none_for_unknown_or_missing_inputs() {
        assert!(forge_target_from(Some("unknown"), Some("git@github.com:x/y.git")).is_none());
        assert!(forge_target_from(Some("github"), None).is_none());
        assert!(forge_target_from(None, Some("git@github.com:x/y.git")).is_none());
    }

    // Stale-binding judgement now lives inside each backend's
    // `check_auth`; see `forge::github::accounts::tests` and
    // `forge::gitlab::accounts::tests` for the per-state coverage.
    // The Phase-2 loop here just consumes the boolean
    // `is_definitely_logged_out()`.
    #[test]
    fn auth_check_is_definitely_logged_out_only_for_logged_out() {
        assert!(AuthCheck::LoggedOut.is_definitely_logged_out());
        assert!(!AuthCheck::LoggedIn.is_definitely_logged_out());
        assert!(!AuthCheck::Indeterminate.is_definitely_logged_out());
    }
}
