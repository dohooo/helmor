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

/// Phase-2 cache value: keep the success / failure distinction so a
/// `list_logins` failure can't be misread as "no accounts on this
/// host". `anyhow::Error` isn't `Clone`, so we drop the message after
/// logging once — the cache only needs to remember "we tried, it
/// didn't work, don't clobber".
enum CachedLogins {
    Ok(Vec<String>),
    Failed,
}

/// What phase 2 should do with one stale-binding candidate, given
/// the cached `list_logins` result for its host. Pulled out as an
/// enum + pure helper so the regression-prone branch can be unit
/// tested without standing up a fake `ForgeAccountBackend`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StaleBindingAction {
    /// `list_logins` failed — leave the binding alone.
    Skip,
    /// Bound login still authenticated; binding is healthy.
    Keep,
    /// Bound login no longer authenticated; clear and re-bind.
    ClearAndRebind,
}

fn classify_stale_binding(bound_login: &str, cached: &CachedLogins) -> StaleBindingAction {
    match cached {
        CachedLogins::Failed => StaleBindingAction::Skip,
        CachedLogins::Ok(logins) => {
            if logins.iter().any(|login| login == bound_login) {
                StaleBindingAction::Keep
            } else {
                StaleBindingAction::ClearAndRebind
            }
        }
    }
}

/// Re-run [`auto_bind_repo_account`] for every repo whose binding is
/// either missing or stale. Two phases:
///
///   1. **Unbound** (`forge_login IS NULL`) — covers fresh imports
///      from before the multi-account migration plus any post-login
///      retries triggered when the user adds a new gh / glab account.
///   2. **Stale** (`forge_login` set but the login is no longer in
///      `gh / glab auth status`) — covers the user running
///      `gh auth logout <login>` outside of Helmor. Without this
///      pass, the inspector would keep showing "Unauthenticated" for
///      that repo until the user manually re-bound it via Settings →
///      Repository, even though a different logged-in account might
///      already have access.
///
/// Per-host `list_logins` results are cached across phase 2 so the
/// sweep makes one CLI call per host instead of one per stale repo.
///
/// Errors on individual repos are swallowed (logged at warn) so one
/// bad row doesn't break the rest of the sweep. Returns the totals
/// so the caller can publish a single `RepositoryListChanged` if
/// anything actually changed.
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

    // Phase 2: stale bindings. Group by (provider, host) so we issue
    // one `list_logins` per host even with many repos pointing at it.
    //
    // CRITICAL: `list_logins` failure is NOT the same as
    // "no accounts on this host". A network blip / `gh auth status`
    // timeout / Keychain unlock delay during boot must not collapse
    // into an empty Vec — that would let the loop below treat every
    // bound repo as stale and clear all GitHub bindings on disk.
    // Cache the `CachedLogins` enum so a single failure is logged
    // once per host instead of N times for N repos.
    use std::collections::HashMap;
    let mut logins_by_host: HashMap<(ForgeProvider, String), CachedLogins> = HashMap::new();
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
        let cache_key = (target.provider, target.host.clone());
        let cached = logins_by_host.entry(cache_key).or_insert_with(|| {
            match backend_for(target.provider) {
                Some(backend) => match backend.list_logins(&target.host) {
                    Ok(logins) => CachedLogins::Ok(logins),
                    Err(error) => {
                        tracing::warn!(
                            provider = target.provider.as_storage_str(),
                            host = %target.host,
                            error = %format!("{error:#}"),
                            "Backfill phase 2: list_logins failed; preserving existing bindings on this host"
                        );
                        CachedLogins::Failed
                    }
                },
                None => CachedLogins::Ok(Vec::new()),
            }
        });
        match classify_stale_binding(&entry.login, cached) {
            StaleBindingAction::Skip => {
                // Conservative: a transient `list_logins` failure
                // shouldn't silently clobber the user's binding.
                // Same defensive instinct as the `repo_accessible`
                // skip elsewhere — one-time hiccups don't get to
                // mutate ground truth.
                continue;
            }
            StaleBindingAction::Keep => {
                // Bound login is still authenticated — leave it
                // alone. We deliberately don't re-probe
                // `repo_accessible`; a one-time perms hiccup
                // shouldn't silently steal the binding from one
                // signed-in account to another.
                continue;
            }
            StaleBindingAction::ClearAndRebind => {
                // Fall through to the clear + re-bind block below.
            }
        }
        // The bound login is gone from the CLI. Clear and re-bind.
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

    // Regression coverage for the phase-2 bug where a transient
    // `list_logins` failure (network blip, glab process killed, slow
    // bundled binary on first launch) would clobber every binding on
    // the host. `Failed` must always map to `Skip`.
    #[test]
    fn classify_stale_binding_skips_when_list_logins_failed() {
        assert_eq!(
            classify_stale_binding("octocat", &CachedLogins::Failed),
            StaleBindingAction::Skip,
        );
    }

    #[test]
    fn classify_stale_binding_keeps_when_login_still_authenticated() {
        let logins = CachedLogins::Ok(vec!["octocat".to_string(), "hubot".to_string()]);
        assert_eq!(
            classify_stale_binding("octocat", &logins),
            StaleBindingAction::Keep,
        );
    }

    #[test]
    fn classify_stale_binding_clears_when_login_absent() {
        let logins = CachedLogins::Ok(vec!["hubot".to_string()]);
        assert_eq!(
            classify_stale_binding("octocat", &logins),
            StaleBindingAction::ClearAndRebind,
        );
    }

    #[test]
    fn classify_stale_binding_clears_when_no_one_is_signed_in() {
        let logins = CachedLogins::Ok(Vec::new());
        assert_eq!(
            classify_stale_binding("octocat", &logins),
            StaleBindingAction::ClearAndRebind,
        );
    }
}
