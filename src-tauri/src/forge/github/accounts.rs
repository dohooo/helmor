//! GitHub-specific implementation of [`ForgeAccountBackend`].
//!
//! Owns every gh-CLI-shaped concern:
//!   - Enumerating accounts via `gh auth status --json hosts`
//!   - Fetching display profiles via `gh api /user`
//!   - Probing repo access via `gh api /repos/{owner}/{name}`
//!   - Setting `GH_TOKEN` per spawn so multi-account commands target a
//!     specific user without flipping `gh auth switch` globally.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::collections::HashMap;

use crate::forge::accounts::{AuthCheck, ForgeAccount, ForgeAccountBackend};
use crate::forge::command::{command_detail, run_command, run_command_with_env, CommandOutput};
use crate::forge::types::ForgeProvider;

/// Singleton handle wired into [`crate::forge::accounts::backend_for`].
pub(crate) static BACKEND: GithubAccountBackend = GithubAccountBackend;

pub(crate) struct GithubAccountBackend;

impl ForgeAccountBackend for GithubAccountBackend {
    fn list_accounts(&self, _hosts_hint: &[String]) -> Result<Vec<ForgeAccount>> {
        // gh enumerates its own host list; the caller's `hosts_hint` is
        // a glab-only signal and gets ignored here.
        list_github_accounts_full()
    }

    fn list_logins(&self, host: &str) -> Result<Vec<String>> {
        list_github_logins(host)
    }

    fn check_auth(&self, host: &str, login: &str) -> AuthCheck {
        check_github_auth(host, login)
    }

    fn repo_accessible(&self, host: &str, login: &str, owner: &str, name: &str) -> Result<bool> {
        github_repo_accessible(host, login, owner, name)
    }

    fn fetch_profile(&self, host: &str, login: &str) -> Result<ForgeAccount> {
        let profile = fetch_github_profile(host, login)?;
        Ok(ForgeAccount {
            provider: ForgeProvider::Github,
            host: host.to_string(),
            login: login.to_string(),
            name: profile.name,
            avatar_url: profile.avatar_url,
            email: profile.email,
            active: false,
        })
    }

    fn run_cli(&self, host: &str, login: &str, args: &[&str]) -> Result<CommandOutput> {
        run_cli_with_login(host, login, args)
    }
}

// ---------------- gh-specific runners (used by graphql.rs) ----------------

/// Read the token for a specific gh user on a given host from
/// `gh auth token --user <login>`. Used to set `GH_TOKEN` per-spawn so
/// multi-account commands target the right account without mutating gh's
/// global "active" pointer. The `host` is required — passing the wrong
/// host produces tokens for a different login (or a not-found error)
/// because GHE accounts and github.com accounts live in separate
/// `hosts.yml` buckets.
pub(crate) fn token_for_user_on_host(host: &str, login: &str) -> Result<String> {
    // Validate against hosts.yml first: macOS keychain entries can
    // outlive their hosts.yml registration, in which case `gh auth
    // token --user X` returns a token but `gh pr create` falls back
    // to a different user. Only bail on definite LoggedOut.
    if check_github_auth(host, login).is_definitely_logged_out() {
        return Err(anyhow!(
            "gh user {login} is not logged in (not present in `gh auth status` for {host})"
        ));
    }
    let output = run_command("gh", ["auth", "token", "--user", login])
        .with_context(|| format!("Failed to spawn `gh auth token --user {login}`"))?;
    if !output.success {
        return Err(anyhow!(
            "`gh auth token --user {login}` failed: {}",
            command_detail(&output)
        ));
    }
    let token = output.stdout.trim().to_string();
    if token.is_empty() {
        return Err(anyhow!("`gh auth token --user {login}` returned empty"));
    }
    Ok(token)
}

/// Spawn `gh <args>` with `GH_TOKEN` set to `(host, login)`'s token. Caller
/// is still responsible for adding `--hostname <host>` to `args` when the
/// command consults gh's host config (most `gh api ...` calls do).
pub(crate) fn run_cli_with_login(host: &str, login: &str, args: &[&str]) -> Result<CommandOutput> {
    let token = token_for_user_on_host(host, login)?;
    run_command_with_env("gh", args.iter().copied(), &[("GH_TOKEN", token.as_str())])
        .with_context(|| format!("Failed to spawn `gh {}`", args.join(" ")))
}

// ---------------- gh auth status enumeration ----------------

fn list_github_logins(host: &str) -> Result<Vec<String>> {
    if let Some(cached) = logins_cache::get(host) {
        return Ok(cached);
    }
    let output = run_command(
        "gh",
        ["auth", "status", "--hostname", host, "--json", "hosts"],
    )
    .with_context(|| format!("Failed to spawn `gh auth status --hostname {host}`"))?;

    if !output.success {
        if looks_like_unauthenticated(&command_detail(&output)) {
            // Cache the empty result too — "no logins on this host"
            // is a real answer worth dedupe'ing for 30s. Hard errors
            // (network, gh missing, etc.) bypass the cache below.
            logins_cache::put(host, Vec::new());
            return Ok(Vec::new());
        }
        return Err(anyhow!(
            "`gh auth status --hostname {host}` failed: {}",
            command_detail(&output)
        ));
    }

    let logins = parse_logins_for_host(&output.stdout, host)?;
    logins_cache::put(host, logins.clone());
    Ok(logins)
}

/// All non-empty logins for `host`. State filtering is intentionally
/// absent — that's what answers "is this login still in gh's store?"
/// without conflating transient `state: "error"` with logout.
/// Contrast with [`parse_account_slots`], which DOES filter by state
/// because the Settings → Accounts roster only shows currently usable
/// accounts.
fn parse_logins_for_host(stdout: &str, host: &str) -> Result<Vec<String>> {
    let parsed: GhAuthStatusResponse = serde_json::from_str(stdout)
        .with_context(|| "Failed to decode `gh auth status --json hosts` output".to_string())?;
    Ok(parsed
        .hosts
        .get(host)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let login = entry.login.as_deref().unwrap_or("").trim();
                    if login.is_empty() {
                        None
                    } else {
                        Some(login.to_string())
                    }
                })
                .collect()
        })
        .unwrap_or_default())
}

fn check_github_auth(host: &str, login: &str) -> AuthCheck {
    match list_github_logins(host) {
        Ok(logins) => {
            if logins.iter().any(|candidate| candidate == login) {
                AuthCheck::LoggedIn
            } else {
                AuthCheck::LoggedOut
            }
        }
        Err(error) => {
            tracing::warn!(
                host = %host,
                login = %login,
                error = %format!("{error:#}"),
                "gh auth probe failed; treating as Indeterminate"
            );
            AuthCheck::Indeterminate
        }
    }
}

/// Per-process rate limiter for `gh auth status --hostname X`. The
/// frontend's identity-info queries refetch on every window focus
/// (`refetchOnWindowFocus: "always"` + `staleTime: Infinity`), so
/// without this layer a quick burst of refocuses or a screen full
/// of mounted consumers would fan out one CLI invocation each.
/// Two seconds keeps the UI responsive after auth changes while still
/// capping bursty focus/mount probes to a conservative request rate.
mod logins_cache {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};
    use std::time::{Duration, Instant};

    const TTL: Duration = Duration::from_secs(2);

    struct Entry {
        logins: Vec<String>,
        cached_at: Instant,
    }

    static CACHE: LazyLock<Mutex<HashMap<String, Entry>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    pub(super) fn get(host: &str) -> Option<Vec<String>> {
        let mut cache = CACHE.lock().ok()?;
        let fresh = cache
            .get(host)
            .filter(|entry| entry.cached_at.elapsed() < TTL)
            .map(|entry| entry.logins.clone());
        if fresh.is_some() {
            return fresh;
        }
        cache.remove(host);
        None
    }

    pub(super) fn put(host: &str, logins: Vec<String>) {
        let Ok(mut cache) = CACHE.lock() else {
            return;
        };
        cache.insert(
            host.to_string(),
            Entry {
                logins,
                cached_at: Instant::now(),
            },
        );
    }

    pub(super) fn invalidate(host: &str) {
        if let Ok(mut cache) = CACHE.lock() {
            cache.remove(host);
        }
    }
}

/// Drop all cached state for `host` so the next `list_logins` /
/// `list_accounts` call hits the wire. Called from the post-auth
/// path so freshly-added logins are visible without a 30s wait.
pub(crate) fn invalidate_caches_for_host(host: &str) {
    logins_cache::invalidate(host);
    profile_cache::invalidate_host(host);
}

fn list_github_accounts_full() -> Result<Vec<ForgeAccount>> {
    let output = run_command("gh", ["auth", "status", "--json", "hosts"])
        .with_context(|| "Failed to spawn `gh auth status --json hosts`".to_string())?;
    if !output.success {
        if looks_like_unauthenticated(&command_detail(&output)) {
            return Ok(Vec::new());
        }
        return Err(anyhow!(
            "`gh auth status --json hosts` failed: {}",
            command_detail(&output)
        ));
    }

    // Collect the (host, login, active) tuples first so we can fan
    // the per-account `gh api /user` calls out across threads. The
    // serial version was the dominant cost on the Connect-then-open-
    // Settings flow: with N accounts you'd wait N × HTTPS roundtrips
    // before the first avatar showed up.
    let slots: Vec<AccountSlot> = parse_account_slots(&output.stdout)?;

    // Fan the profile fetches out across one thread per account.
    // Each fetch is a `gh` subprocess + HTTPS round-trip, so the
    // parallelism cap doesn't really matter — even 10 in flight is
    // a few KB of RAM each. `std::thread::scope` ensures the threads
    // join before we return, so `slots` outlives the borrows safely.
    let accounts = std::thread::scope(|scope| {
        let handles: Vec<_> = slots
            .iter()
            .map(|slot| {
                scope.spawn(move || {
                    let profile = match fetch_github_profile(&slot.host, &slot.login) {
                        Ok(p) => Some(p),
                        Err(error) => {
                            tracing::warn!(
                                host = %slot.host,
                                login = %slot.login,
                                error = %format!("{error:#}"),
                                "Failed to fetch GitHub profile via `gh api /user`; row will lack avatar/name/email"
                            );
                            None
                        }
                    };
                    ForgeAccount {
                        provider: ForgeProvider::Github,
                        host: slot.host.clone(),
                        login: slot.login.clone(),
                        name: profile.as_ref().and_then(|p| p.name.clone()),
                        avatar_url: profile.as_ref().and_then(|p| p.avatar_url.clone()),
                        email: profile.and_then(|p| p.email),
                        active: slot.active,
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("profile fetch worker panicked"))
            .collect::<Vec<_>>()
    });

    Ok(accounts)
}

/// `(host, login, active)` tuple lifted out of a `gh auth status
/// --json hosts` payload. Internal staging type for the parallel
/// profile-fetch fan-out in `list_github_accounts_full`.
struct AccountSlot {
    host: String,
    login: String,
    active: bool,
}

/// Decode the full `gh auth status --json hosts` payload into the
/// account slots we'll fan profile fetches over. Pure — same filter
/// rules as `parse_logins_for_host` (state == "success", non-empty
/// trimmed login). Stable iteration order is NOT guaranteed (the
/// underlying `HashMap` walk order is unspecified); callers that
/// surface UI based on the order should sort downstream.
fn parse_account_slots(stdout: &str) -> Result<Vec<AccountSlot>> {
    let parsed: GhAuthStatusFullResponse = serde_json::from_str(stdout)
        .with_context(|| "Failed to decode `gh auth status --json hosts` output".to_string())?;
    Ok(parsed
        .hosts
        .into_iter()
        .flat_map(|(host, entries)| {
            entries
                .into_iter()
                .filter(|entry| entry.state.as_deref() == Some("success"))
                .filter_map(move |entry| {
                    let login = entry.login.filter(|value| !value.trim().is_empty())?;
                    Some(AccountSlot {
                        host: host.clone(),
                        login,
                        active: entry.active.unwrap_or(false),
                    })
                })
                .collect::<Vec<_>>()
        })
        .collect())
}

fn fetch_github_profile(host: &str, login: &str) -> Result<GithubUserResponse> {
    if let Some(cached) = profile_cache::get(host, login) {
        return Ok(cached);
    }
    let args = [
        "api",
        "--hostname",
        host,
        "-H",
        "Accept: application/vnd.github+json",
        "/user",
    ];
    let output = run_cli_with_login(host, login, &args)?;
    if !output.success {
        return Err(anyhow!(
            "`gh api /user` failed for {login}: {}",
            command_detail(&output)
        ));
    }
    let parsed: GithubUserResponse = serde_json::from_str(&output.stdout)
        .with_context(|| format!("Failed to decode `gh api /user` for {login}"))?;
    profile_cache::put(host, login, parsed.clone());
    Ok(parsed)
}

/// Per-process dedupe cache for `gh api /user` profile responses.
/// Short 30-second TTL: this layer only exists to keep a single
/// `list_forge_accounts` invocation from fanning out N HTTPS calls
/// when the same `(host, login)` is hit multiple times in one pass.
/// The frontend caches the underlying query forever
/// (`forgeAccountsQueryOptions` → `staleTime: Infinity`) but
/// refetches on every window focus (`refetchOnWindowFocus: "always"`),
/// so identity freshness is the frontend's job — a long Rust-side TTL
/// would silently override that contract. `invalidate()` is exposed
/// for explicit eviction (logout / unbind paths) but the TTL covers
/// the common case.
mod profile_cache {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};
    use std::time::{Duration, Instant};

    use super::GithubUserResponse;

    const TTL: Duration = Duration::from_secs(30);

    struct Entry {
        profile: GithubUserResponse,
        cached_at: Instant,
    }

    static CACHE: LazyLock<Mutex<HashMap<(String, String), Entry>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    fn key(host: &str, login: &str) -> (String, String) {
        (host.to_string(), login.to_string())
    }

    pub(super) fn get(host: &str, login: &str) -> Option<GithubUserResponse> {
        let mut cache = CACHE.lock().ok()?;
        let k = key(host, login);
        let fresh = cache
            .get(&k)
            .filter(|entry| entry.cached_at.elapsed() < TTL);
        if fresh.is_some() {
            return fresh.map(|e| e.profile.clone());
        }
        // Drop the expired entry on the way out so the map doesn't
        // accumulate dead keys for accounts the user has since
        // signed out of.
        cache.remove(&k);
        None
    }

    pub(super) fn put(host: &str, login: &str, profile: GithubUserResponse) {
        let Ok(mut cache) = CACHE.lock() else {
            return;
        };
        cache.insert(
            key(host, login),
            Entry {
                profile,
                cached_at: Instant::now(),
            },
        );
    }

    #[allow(dead_code)]
    pub(super) fn invalidate(host: &str, login: &str) {
        let Ok(mut cache) = CACHE.lock() else {
            return;
        };
        cache.remove(&key(host, login));
    }

    /// Drop every cached profile for `host` regardless of login —
    /// used post-auth where the caller doesn't know which logins
    /// were just added (or rotated).
    pub(super) fn invalidate_host(host: &str) {
        let Ok(mut cache) = CACHE.lock() else {
            return;
        };
        cache.retain(|(h, _), _| h != host);
    }
}

/// "Can this account *push* to this repo?" — read access alone isn't
/// enough for auto-bind because Helmor commits and pushes via the
/// bound account; we'd be misleading the user by binding to a login
/// they can only browse with. GitHub's authenticated
/// `GET /repos/{owner}/{repo}` returns a `permissions` object whose
/// `push` flag we honour. (Anonymous responses don't carry that
/// field, but we always go through `run_cli_with_login` so the
/// request is authenticated.)
fn github_repo_accessible(host: &str, login: &str, owner: &str, name: &str) -> Result<bool> {
    let path = format!("/repos/{owner}/{name}");
    let args = [
        "api",
        "--hostname",
        host,
        "-H",
        "Accept: application/vnd.github+json",
        path.as_str(),
    ];
    let output = run_cli_with_login(host, login, &args)
        .with_context(|| format!("Failed to spawn `gh api {path}`"))?;
    if !output.success {
        let detail = command_detail(&output);
        if looks_like_not_found(&detail) || looks_like_unauthenticated(&detail) {
            return Ok(false);
        }
        return Err(anyhow!("`gh api {path}` failed for {login}: {detail}"));
    }
    parse_repo_push_permission(&output.stdout)
        .with_context(|| format!("Failed to decode `gh api {path}` for {login}"))
}

/// `Ok(true)` when GitHub's `GET /repos/{owner}/{repo}` response
/// carries `permissions.push == true`. Anonymous responses lack the
/// `permissions` object entirely → `Ok(false)`. Pure JSON shape —
/// split out so the threshold ("push, not just pull") has explicit
/// test coverage.
fn parse_repo_push_permission(stdout: &str) -> Result<bool> {
    let parsed: GithubRepoPermissionsResponse = serde_json::from_str(stdout)
        .with_context(|| "Failed to decode `gh api /repos/...` payload".to_string())?;
    Ok(parsed.permissions.is_some_and(|p| p.push))
}

#[derive(Debug, Deserialize)]
struct GithubRepoPermissionsResponse {
    permissions: Option<GithubRepoPermissions>,
}

#[derive(Debug, Deserialize)]
struct GithubRepoPermissions {
    push: bool,
}

// ---------------- JSON shapes ----------------

#[derive(Debug, Clone, Deserialize)]
struct GhAuthStatusResponse {
    hosts: HashMap<String, Vec<GhHostStatusEntry>>,
}

#[derive(Debug, Clone, Deserialize)]
struct GhHostStatusEntry {
    // `state` is intentionally not deserialized — see comment on
    // `parse_logins_for_host`. We only care about presence + login.
    login: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GhAuthStatusFullResponse {
    hosts: HashMap<String, Vec<GhHostStatusFullEntry>>,
}

#[derive(Debug, Clone, Deserialize)]
struct GhHostStatusFullEntry {
    state: Option<String>,
    login: Option<String>,
    active: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct GithubUserResponse {
    name: Option<String>,
    avatar_url: Option<String>,
    email: Option<String>,
}

// ---------------- Error classifiers ----------------

fn looks_like_unauthenticated(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("401 unauthorized")
        || normalized.contains("bad credentials")
        || normalized.contains("not logged in")
        || normalized.contains("not logged into")
        || normalized.contains("not authenticated")
        || normalized.contains("authentication failed")
        || normalized.contains("gh auth login")
        || normalized.contains("no token found")
        || normalized.contains("has not been authenticated")
}

fn looks_like_not_found(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("404") || normalized.contains("not found")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_like_not_found_matches_canonical_phrases() {
        assert!(looks_like_not_found("HTTP 404"));
        assert!(looks_like_not_found("Not Found"));
        assert!(!looks_like_not_found("permission denied"));
    }

    #[test]
    fn looks_like_unauthenticated_matches_canonical_phrases() {
        assert!(looks_like_unauthenticated("HTTP 401 Unauthorized"));
        assert!(looks_like_unauthenticated("Bad credentials"));
        assert!(looks_like_unauthenticated("not logged in"));
        assert!(!looks_like_unauthenticated("connection reset"));
    }

    // ---------------- parse_logins_for_host ----------------

    #[test]
    fn parse_logins_for_host_keeps_all_entries_regardless_of_state() {
        // gh marks an entry's `state` based on its most recent token
        // validation: "success" when validation succeeded, "error"
        // when it failed (could be transient — network blip, rate
        // limit). We do NOT filter on state — entry presence alone
        // answers "is this login still in gh's account store?".
        // Filtering used to flicker the inspector's Connect CTA on
        // every transient gh hiccup.
        let stdout = r#"{
            "hosts": {
                "github.com": [
                    {"state":"success","login":"octocat"},
                    {"state":"error","login":"hubot"},
                    {"state":"success","login":"alice"}
                ]
            }
        }"#;
        assert_eq!(
            parse_logins_for_host(stdout, "github.com").unwrap(),
            vec![
                "octocat".to_string(),
                "hubot".to_string(),
                "alice".to_string(),
            ],
        );
    }

    #[test]
    fn parse_logins_for_host_filters_blank_logins() {
        // Whitespace-only or absent `login` fields shouldn't pollute
        // the user-visible login list.
        let stdout = r#"{
            "hosts": {
                "github.com": [
                    {"state":"success","login":"  "},
                    {"state":"success","login":""},
                    {"state":"success","login":null},
                    {"state":"success","login":"octocat"}
                ]
            }
        }"#;
        assert_eq!(
            parse_logins_for_host(stdout, "github.com").unwrap(),
            vec!["octocat".to_string()],
        );
    }

    #[test]
    fn parse_logins_for_host_returns_empty_when_host_absent() {
        let stdout = r#"{ "hosts": { "ghe.example.com": [{"state":"success","login":"alice"}] } }"#;
        // We asked for github.com — ghe.example.com's login should
        // not leak into a different host's auth list.
        assert!(parse_logins_for_host(stdout, "github.com")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn parse_logins_for_host_returns_empty_for_empty_hosts_object() {
        let stdout = r#"{ "hosts": {} }"#;
        assert!(parse_logins_for_host(stdout, "github.com")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn parse_logins_for_host_errors_on_malformed_json() {
        assert!(parse_logins_for_host("{not json", "github.com").is_err());
    }

    // ---------------- parse_account_slots ----------------

    #[test]
    fn parse_account_slots_yields_one_slot_per_active_login() {
        let stdout = r#"{
            "hosts": {
                "github.com": [
                    {"state":"success","login":"octocat","active":true},
                    {"state":"success","login":"hubot","active":false}
                ]
            }
        }"#;
        let mut slots = parse_account_slots(stdout).unwrap();
        slots.sort_by(|a, b| a.login.cmp(&b.login));
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].login, "hubot");
        assert!(!slots[0].active);
        assert_eq!(slots[1].login, "octocat");
        assert!(slots[1].active);
    }

    #[test]
    fn parse_account_slots_defaults_active_when_absent() {
        // Older gh versions omit `active` entirely; treat as inactive
        // rather than panicking.
        let stdout = r#"{
            "hosts": {
                "github.com": [{"state":"success","login":"octocat"}]
            }
        }"#;
        let slots = parse_account_slots(stdout).unwrap();
        assert_eq!(slots.len(), 1);
        assert!(!slots[0].active);
    }

    #[test]
    fn parse_account_slots_drops_failure_entries() {
        // A host where the user re-auth'd but a stale entry is still
        // marked failure — only the success entries should make it
        // through to the avatar fan-out.
        let stdout = r#"{
            "hosts": {
                "github.com": [
                    {"state":"failure","login":"octocat"},
                    {"state":"success","login":"alice"}
                ]
            }
        }"#;
        let slots = parse_account_slots(stdout).unwrap();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].login, "alice");
    }

    #[test]
    fn parse_account_slots_handles_multiple_hosts() {
        // GH Enterprise + github.com in a single payload — both must
        // be carried through with their host attribution intact.
        let stdout = r#"{
            "hosts": {
                "github.com": [{"state":"success","login":"alice","active":true}],
                "ghe.example.com": [{"state":"success","login":"alice-ghe","active":true}]
            }
        }"#;
        let mut slots = parse_account_slots(stdout).unwrap();
        slots.sort_by(|a, b| a.host.cmp(&b.host));
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].host, "ghe.example.com");
        assert_eq!(slots[0].login, "alice-ghe");
        assert_eq!(slots[1].host, "github.com");
        assert_eq!(slots[1].login, "alice");
    }

    // ---------------- parse_repo_push_permission ----------------

    #[test]
    fn parse_repo_push_permission_true_when_push_set() {
        // Authenticated `GET /repos/{owner}/{repo}` returns
        // `permissions: { push: true }` for collaborators with write
        // access. Auto-bind needs *push* not just pull.
        let stdout = r#"{
            "id": 1,
            "name": "hello-world",
            "permissions": { "admin": false, "push": true, "pull": true }
        }"#;
        assert!(parse_repo_push_permission(stdout).unwrap());
    }

    #[test]
    fn parse_repo_push_permission_false_when_only_pull() {
        // Read-only collaborators / public-repo browsers — must not
        // be auto-bound, since Helmor pushes via the bound account.
        let stdout = r#"{
            "id": 1,
            "name": "hello-world",
            "permissions": { "admin": false, "push": false, "pull": true }
        }"#;
        assert!(!parse_repo_push_permission(stdout).unwrap());
    }

    #[test]
    fn parse_repo_push_permission_false_when_permissions_missing() {
        // Anonymous responses (or scopes that don't expose the
        // `permissions` object) — treat as "not writeable" rather
        // than failing the probe.
        let stdout = r#"{ "id": 1, "name": "hello-world" }"#;
        assert!(!parse_repo_push_permission(stdout).unwrap());
    }

    #[test]
    fn parse_repo_push_permission_errors_on_malformed_json() {
        assert!(parse_repo_push_permission("not json").is_err());
    }
}
