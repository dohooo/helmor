//! GitLab-specific implementation of [`ForgeAccountBackend`].
//!
//! GitLab is one-account-per-host (per the user-product agreement), so
//! enumeration boils down to "for each host glab knows about, fetch the
//! profile via `glab api user`". We discover hosts from `glab auth
//! status` itself rather than relying solely on the caller's
//! repo-derived hint, so accounts authenticated before any repo is
//! added still surface in the Accounts UI.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::forge::accounts::{AuthCheck, ForgeAccount, ForgeAccountBackend};
use crate::forge::command::{command_detail, run_command, CommandOutput};
use crate::forge::types::ForgeProvider;

use super::api::{encode_path_component, looks_like_auth_error, looks_like_missing_error};

/// Singleton handle wired into [`crate::forge::accounts::backend_for`].
pub(crate) static BACKEND: GitlabAccountBackend = GitlabAccountBackend;

pub(crate) struct GitlabAccountBackend;

impl ForgeAccountBackend for GitlabAccountBackend {
    fn list_accounts(&self, hosts_hint: &[String]) -> Result<Vec<ForgeAccount>> {
        // Discover all logged-in (host, login) pairs from glab itself.
        // The hint only adds hosts glab might not have surfaced yet
        // (theoretical — `glab auth status` is the source of truth).
        let mut pairs = list_glab_logged_in_pairs().unwrap_or_else(|error| {
            tracing::warn!(
                error = %format!("{error:#}"),
                "Failed to enumerate `glab auth status`; falling back to hosts hint"
            );
            Vec::new()
        });
        for hint in hosts_hint {
            if pairs.iter().any(|(host, _)| host == hint) {
                continue;
            }
            // Fall back to a per-host query: turns up legacy hosts that
            // for some reason got dropped from the global status output.
            match list_gitlab_logins(hint) {
                Ok(logins) => {
                    for login in logins {
                        pairs.push((hint.clone(), login));
                    }
                }
                Err(error) => tracing::warn!(
                    host = %hint,
                    error = %format!("{error:#}"),
                    "Failed to query `glab auth status --hostname`; skipping",
                ),
            }
        }

        // Fan profile fetches across one thread per host. Each fetch is
        // a `glab api` subprocess + HTTPS roundtrip — N×latency in
        // serial dominates Settings → Accounts on first paint.
        let accounts = std::thread::scope(|scope| {
            let handles: Vec<_> = pairs
                .iter()
                .map(|(host, login)| {
                    scope.spawn(move || fetch_gitlab_account_with_login(host, login))
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|handle| handle.join().ok())
                .collect::<Vec<_>>()
        });
        Ok(accounts)
    }

    fn list_logins(&self, host: &str) -> Result<Vec<String>> {
        list_gitlab_logins(host)
    }

    fn check_auth(&self, host: &str, login: &str) -> AuthCheck {
        check_gitlab_auth(host, login)
    }

    fn repo_accessible(&self, host: &str, _login: &str, owner: &str, name: &str) -> Result<bool> {
        gitlab_repo_accessible(host, owner, name)
    }

    fn fetch_profile(&self, host: &str, login: &str) -> Result<ForgeAccount> {
        let profile = fetch_gitlab_profile(host)?;
        let resolved_login = profile
            .username
            .clone()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| login.to_string());
        Ok(ForgeAccount {
            provider: ForgeProvider::Gitlab,
            host: host.to_string(),
            login: resolved_login,
            name: profile.name,
            avatar_url: profile.avatar_url,
            email: profile.email,
            active: true,
        })
    }

    fn run_cli(&self, host: &str, _login: &str, args: &[&str]) -> Result<CommandOutput> {
        // glab routes via `--hostname`; per-host config picks the right
        // token automatically (one account per host).
        let mut full_args: Vec<&str> = vec!["--hostname", host];
        full_args.extend_from_slice(args);
        run_command("glab", full_args.iter().copied()).with_context(|| {
            format!(
                "Failed to spawn `glab --hostname {host} {}`",
                args.join(" ")
            )
        })
    }
}

// ---------------- glab enumeration ----------------

fn list_gitlab_logins(host: &str) -> Result<Vec<String>> {
    if let Some(cached) = logins_cache::get(host) {
        return Ok(cached);
    }
    // glab missing must surface as `Err` (Indeterminate downstream),
    // not `Ok(empty)` — the latter would let `check_gitlab_auth`
    // judge every bound login as `LoggedOut` and clear bindings.
    let auth_output =
        run_command("glab", ["auth", "status", "--hostname", host]).map_err(|error| {
            anyhow!("Failed to spawn `glab auth status --hostname {host}`: {error}")
        })?;
    if !auth_output.success {
        // Only `Ok(empty)` for unambiguous "no credentials" output;
        // ambiguous failures (401/403/network) surface as `Err` →
        // `Indeterminate` downstream.
        let signal = format!("{}\n{}", auth_output.stderr, auth_output.stdout);
        if looks_like_definitively_unauthenticated(&signal) {
            logins_cache::put(host, Vec::new());
            return Ok(Vec::new());
        }
        return Err(anyhow!(
            "`glab auth status --hostname {host}` failed: {}",
            command_detail(&auth_output)
        ));
    }
    // Prefer the canonical username from `glab api user` over the
    // auth-status "as <user>" string. For project access tokens, glab
    // reports the bot's full token-style identifier
    // (`project_<id>_bot_<sha>`) but `api user` returns the bot user's
    // actual `username` field — which is what GitHub also stores in
    // `forge_login`, what the resolver uses for branch prefixes, and
    // what the AccountList joins repo bindings against. Falling back to
    // the auth-status name keeps things working when the API call
    // fails (no network, missing scope, etc.).
    let logins: Vec<String> = if let Some(username) = fetch_canonical_glab_username(host) {
        vec![username]
    } else {
        parse_glab_login(&auth_output.stderr)
            .or_else(|| parse_glab_login(&auth_output.stdout))
            .into_iter()
            .collect()
    };
    logins_cache::put(host, logins.clone());
    Ok(logins)
}

/// Tight subset of [`looks_like_auth_error`]: matches only patterns
/// that mean "no credentials at all on this host", not transient
/// 401/403/network failures.
fn looks_like_definitively_unauthenticated(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("no token found")
        || normalized.contains("not logged in")
        || normalized.contains("not logged into")
}

/// Mirrors `check_github_auth`: any `list_gitlab_logins` failure
/// degrades to `Indeterminate` so transient glab issues preserve
/// the binding.
fn check_gitlab_auth(host: &str, login: &str) -> AuthCheck {
    match list_gitlab_logins(host) {
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
                "glab auth probe failed; treating as Indeterminate"
            );
            AuthCheck::Indeterminate
        }
    }
}

/// Per-process rate limiter for `glab auth status` (per-host). Mirrors
/// the GitHub side; see comments on `github::accounts::logins_cache`
/// for the full rationale.
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

/// `glab api user --hostname X`'s `username` field — the API-side name,
/// which always matches what other GitLab UIs and the branch-prefix
/// resolver expect. Returns `None` on any failure (caller falls back
/// to the auth-status string). Hits the same per-process profile
/// cache as `fetch_gitlab_profile`, so back-to-back `list_logins` +
/// `list_accounts` calls share a single `glab api user` round-trip.
fn fetch_canonical_glab_username(host: &str) -> Option<String> {
    let profile = fetch_gitlab_profile(host).ok()?;
    profile
        .username
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Per-process dedupe cache for `glab api user` profile responses.
/// Mirrors the GitHub side: 30-second TTL, only there to keep a
/// single `list_forge_accounts` invocation from fanning out HTTPS
/// calls per-host when both `list_logins` (via
/// `fetch_canonical_glab_username`) and the per-account profile
/// fetch hit the same host. Identity freshness is owned by the
/// frontend: `forgeAccountsQueryOptions` caches forever
/// (`staleTime: Infinity`) but refetches on every window focus
/// (`refetchOnWindowFocus: "always"`), so a `glab auth logout`
/// outside Helmor surfaces on the next focus. `invalidate()` is
/// exposed for explicit eviction (logout / unbind paths) but the
/// TTL covers the common case.
mod profile_cache {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};
    use std::time::{Duration, Instant};

    use super::GitlabUserResponse;

    const TTL: Duration = Duration::from_secs(30);

    struct Entry {
        profile: GitlabUserResponse,
        cached_at: Instant,
    }

    static CACHE: LazyLock<Mutex<HashMap<String, Entry>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    pub(super) fn get(host: &str) -> Option<GitlabUserResponse> {
        let mut cache = CACHE.lock().ok()?;
        let fresh = cache
            .get(host)
            .filter(|entry| entry.cached_at.elapsed() < TTL);
        if fresh.is_some() {
            return fresh.map(|e| e.profile.clone());
        }
        cache.remove(host);
        None
    }

    pub(super) fn put(host: &str, profile: GitlabUserResponse) {
        let Ok(mut cache) = CACHE.lock() else {
            return;
        };
        cache.insert(
            host.to_string(),
            Entry {
                profile,
                cached_at: Instant::now(),
            },
        );
    }

    pub(super) fn invalidate(host: &str) {
        let Ok(mut cache) = CACHE.lock() else {
            return;
        };
        cache.remove(host);
    }
}

/// Run `glab auth status` (no `--hostname`) and parse out every
/// `(host, login)` pair the CLI surfaces. This is how a self-hosted
/// host shows up in the Accounts UI before the user has added any repo
/// from it — the repo-derived `hosts_hint` would otherwise be empty.
///
/// Throttled by the same short TTL as the per-host listings: a burst
/// of refocuses would otherwise re-spawn `glab auth status` once per
/// Settings → Accounts mount.
fn list_glab_logged_in_pairs() -> Result<Vec<(String, String)>> {
    if let Some(cached) = pairs_cache::get() {
        return Ok(cached);
    }
    let pairs = match run_command("glab", ["auth", "status"]) {
        Ok(output) if output.success => {
            // glab prints the structured detail to stderr; stdout is
            // usually empty but we feed both through the same parser
            // to be robust against future format changes.
            let mut combined = String::with_capacity(output.stderr.len() + output.stdout.len() + 1);
            combined.push_str(&output.stderr);
            if !combined.is_empty() && !combined.ends_with('\n') {
                combined.push('\n');
            }
            combined.push_str(&output.stdout);
            parse_glab_logged_in_pairs(&combined)
        }
        Ok(_) => Vec::new(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(anyhow!("Failed to spawn `glab auth status`: {error}")),
    };
    pairs_cache::put(pairs.clone());
    Ok(pairs)
}

/// Single-slot rate limiter for `glab auth status` (no host).
mod pairs_cache {
    use std::sync::{LazyLock, Mutex};
    use std::time::{Duration, Instant};

    const TTL: Duration = Duration::from_secs(2);

    struct Entry {
        pairs: Vec<(String, String)>,
        cached_at: Instant,
    }

    static CACHE: LazyLock<Mutex<Option<Entry>>> = LazyLock::new(|| Mutex::new(None));

    pub(super) fn get() -> Option<Vec<(String, String)>> {
        let mut slot = CACHE.lock().ok()?;
        let fresh = slot
            .as_ref()
            .filter(|entry| entry.cached_at.elapsed() < TTL)
            .map(|entry| entry.pairs.clone());
        if fresh.is_some() {
            return fresh;
        }
        *slot = None;
        None
    }

    pub(super) fn put(pairs: Vec<(String, String)>) {
        let Ok(mut slot) = CACHE.lock() else {
            return;
        };
        *slot = Some(Entry {
            pairs,
            cached_at: Instant::now(),
        });
    }

    pub(super) fn invalidate() {
        if let Ok(mut slot) = CACHE.lock() {
            *slot = None;
        }
    }
}

/// Drop all cached state for `host` so the next `list_logins` /
/// `list_accounts` call hits the wire. Called from the post-auth
/// path so freshly-added logins are visible without a 30s wait.
pub(crate) fn invalidate_caches_for_host(host: &str) {
    logins_cache::invalidate(host);
    pairs_cache::invalidate();
    profile_cache::invalidate(host);
}

fn fetch_gitlab_account_with_login(host: &str, login: &str) -> ForgeAccount {
    let profile = fetch_gitlab_profile(host).ok();
    ForgeAccount {
        provider: ForgeProvider::Gitlab,
        host: host.to_string(),
        login: profile
            .as_ref()
            .and_then(|p| p.username.clone())
            .unwrap_or_else(|| login.to_string()),
        name: profile.as_ref().and_then(|p| p.name.clone()),
        avatar_url: profile.as_ref().and_then(|p| p.avatar_url.clone()),
        email: profile.and_then(|p| p.email),
        active: true,
    }
}

fn fetch_gitlab_profile(host: &str) -> Result<GitlabUserResponse> {
    if let Some(cached) = profile_cache::get(host) {
        return Ok(cached);
    }
    let output = run_command("glab", ["api", "--hostname", host, "user"])
        .with_context(|| format!("Failed to spawn `glab api --hostname {host} user`"))?;
    if !output.success {
        return Err(anyhow!(
            "`glab api --hostname {host} user` failed: {}",
            command_detail(&output)
        ));
    }
    let parsed: GitlabUserResponse = serde_json::from_str(&output.stdout)
        .with_context(|| format!("Failed to decode `glab api user` for {host}"))?;
    profile_cache::put(host, parsed.clone());
    Ok(parsed)
}

/// "Can this account *push* to this project?" — read access alone
/// isn't enough; auto-bind would surface a login that can only
/// browse, which would silently fail the moment Helmor tries to
/// commit. `GET /projects/:id` returns a `permissions` object with
/// a direct `project_access` and an inherited `group_access`,
/// either of which is enough — we take the higher of the two and
/// require Developer (30+), the lowest tier that can push to
/// unprotected branches. Maintainers (40) and Owners (50)
/// naturally satisfy this. Reporters (20) and Guests (10) don't.
const GITLAB_DEVELOPER_ACCESS_LEVEL: i32 = 30;

fn gitlab_repo_accessible(host: &str, owner: &str, name: &str) -> Result<bool> {
    let path = format!(
        "projects/{}",
        encode_path_component(&format!("{owner}/{name}"))
    );
    let output = run_command("glab", ["api", "--hostname", host, path.as_str()])
        .with_context(|| format!("Failed to spawn `glab api {path}`"))?;
    if !output.success {
        let detail = command_detail(&output);
        if looks_like_missing_error(&detail) || looks_like_auth_error(&detail) {
            return Ok(false);
        }
        return Err(anyhow!("`glab api {path}` failed: {detail}"));
    }
    parse_project_push_permission(&output.stdout)
        .with_context(|| format!("Failed to decode `glab api {path}`"))
}

/// `Ok(true)` when the higher of `project_access` / `group_access`
/// is at least Developer (30). Pure JSON shape — split out so the
/// access-level threshold ("Developer can push to unprotected
/// branches") has explicit test coverage independent of the CLI.
fn parse_project_push_permission(stdout: &str) -> Result<bool> {
    let parsed: GitlabProjectPermissionsResponse = serde_json::from_str(stdout)
        .with_context(|| "Failed to decode `glab api projects/...` payload".to_string())?;
    let highest = parsed
        .permissions
        .as_ref()
        .map(|p| {
            let project = p
                .project_access
                .as_ref()
                .and_then(|a| a.access_level)
                .unwrap_or(0);
            let group = p
                .group_access
                .as_ref()
                .and_then(|a| a.access_level)
                .unwrap_or(0);
            project.max(group)
        })
        .unwrap_or(0);
    Ok(highest >= GITLAB_DEVELOPER_ACCESS_LEVEL)
}

#[derive(Debug, Deserialize)]
struct GitlabProjectPermissionsResponse {
    permissions: Option<GitlabProjectPermissions>,
}

#[derive(Debug, Deserialize)]
struct GitlabProjectPermissions {
    project_access: Option<GitlabAccessLevel>,
    group_access: Option<GitlabAccessLevel>,
}

#[derive(Debug, Deserialize)]
struct GitlabAccessLevel {
    access_level: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitlabUserResponse {
    username: Option<String>,
    name: Option<String>,
    avatar_url: Option<String>,
    email: Option<String>,
}

/// `glab auth status` decorates each detail line with leading whitespace
/// and a status glyph (`✓`, `✗`, `*`, etc.) before the human prose.
/// Strip the decoration, locate `Logged in to <host> as <user>`, and
/// stop at the first separator after the username.
fn parse_glab_login(text: &str) -> Option<String> {
    parse_glab_logged_in_pairs(text)
        .into_iter()
        .next()
        .map(|(_, login)| login)
}

/// Walk every `Logged in to <host> as <user>` line in `glab auth
/// status` output and return the `(host, login)` pairs in order.
/// Used by the global enumeration path to discover hosts the caller
/// hasn't seen yet (e.g., the user `glab auth login`'d but hasn't
/// added a repo from that host).
fn parse_glab_logged_in_pairs(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let body = raw.trim_start_matches(|c: char| {
            c.is_whitespace() || c == '✓' || c == '✗' || c == '*' || c == '-' || c == '•'
        });
        let Some(after_to) = body.strip_prefix("Logged in to ") else {
            continue;
        };
        let Some((host, after_as)) = after_to.split_once(" as ") else {
            continue;
        };
        let host = host.trim().trim_end_matches(['.', ',', ';', ':']);
        let login = after_as
            .split(|c: char| c.is_whitespace() || c == '(' || c == ')')
            .next()
            .unwrap_or("")
            .trim_end_matches(['.', ',', ';', ':']);
        if !host.is_empty() && !login.is_empty() {
            out.push((host.to_string(), login.to_string()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_glab_login_extracts_login() {
        let stderr = "  ✓ Logged in to gitlab.com as octo (/path/to/config)\n";
        assert_eq!(parse_glab_login(stderr), Some("octo".to_string()));
    }

    #[test]
    fn parse_glab_login_returns_none_when_not_logged_in() {
        assert_eq!(parse_glab_login(""), None);
        assert_eq!(parse_glab_login("✗ Not logged in"), None);
    }

    /// Regression: the parser used to bail on the very first line via `?`
    /// when the user's `glab auth status` opened with banner lines
    /// (multi-config warning + host header) before the real "Logged in"
    /// detail. The login should still be extracted.
    #[test]
    fn parse_glab_login_skips_leading_banner_lines() {
        let stderr = "Warning: Multiple config files found. Only the first one will be used.\n  Using: /Users/x/.config/glab-cli/config.yml\n  Ignoring: /Users/x/Library/Application Support/glab-cli/config.yml\nConsider consolidating to one location to avoid confusion.\nngit.hundun.cn\n  ✓ Logged in to ngit.hundun.cn as liangeqiang (/Users/x/.config/glab-cli/config.yml)\n  ✓ Git operations for ngit.hundun.cn configured to use ssh protocol.\n";
        assert_eq!(parse_glab_login(stderr), Some("liangeqiang".to_string()),);
    }

    #[test]
    fn parse_glab_logged_in_pairs_returns_each_host() {
        let stderr = "Warning: Multiple config files found. Only the first one will be used.\n  Using: /Users/x/.config/glab-cli/config.yml\n  Ignoring: /Users/x/Library/Application Support/glab-cli/config.yml\nConsider consolidating to one location to avoid confusion.\ngitlab.com\n  ✓ Logged in to gitlab.com as project_81779216_bot_fa867c9cb2ba96a31bf4682a9d25d687 (/Users/x/.config/glab-cli/config.yml)\n  ✓ Git operations for gitlab.com configured to use https protocol.\n  ✓ API calls for gitlab.com are made over https protocol.\n  ✓ REST API Endpoint: https://gitlab.com/api/v4/\n  ✓ GraphQL Endpoint: https://gitlab.com/api/graphql/\n  ✓ Token found: ************\nngit.hundun.cn\n  ✓ Logged in to ngit.hundun.cn as liangeqiang (/Users/x/.config/glab-cli/config.yml)\n  ✓ Git operations for ngit.hundun.cn configured to use https protocol.\n  ✓ Token found: ************\n";
        assert_eq!(
            parse_glab_logged_in_pairs(stderr),
            vec![
                (
                    "gitlab.com".to_string(),
                    "project_81779216_bot_fa867c9cb2ba96a31bf4682a9d25d687".to_string(),
                ),
                ("ngit.hundun.cn".to_string(), "liangeqiang".to_string()),
            ],
        );
    }

    #[test]
    fn parse_glab_logged_in_pairs_empty_on_no_logins() {
        assert!(parse_glab_logged_in_pairs("").is_empty());
        assert!(parse_glab_logged_in_pairs("✗ Not logged in to any host").is_empty());
    }

    // ---------------- looks_like_definitively_unauthenticated ----------------
    //
    // The tighter check that gates `list_gitlab_logins`'s `Ok(empty)`
    // branch. Anything not matched here surfaces as `Err` so the
    // AuthCheck layer maps it to `Indeterminate` instead of clobbering
    // the user's binding on a transient hiccup.

    #[test]
    fn definitive_unauth_matches_no_token_and_not_logged_in() {
        assert!(looks_like_definitively_unauthenticated(
            "! No token found (checked config file, keyring, and environment variables)."
        ));
        assert!(looks_like_definitively_unauthenticated(
            "✗ Not logged in to gitlab.com"
        ));
        assert!(looks_like_definitively_unauthenticated(
            "you are not logged into any GitLab hosts"
        ));
    }

    #[test]
    fn definitive_unauth_does_not_match_transient_failures() {
        // The bug we're fixing: a 401 from the validation probe could
        // be transient (server hiccup, rate limit, brief token-rotation
        // window). Treating it as definitive logout is what flickered
        // the inspector's Connect CTA and cleared bindings.
        assert!(!looks_like_definitively_unauthenticated(
            "API call failed: GET https://gitlab.example.com/api/v4/user: 401 {message: 401 Unauthorized}"
        ));
        assert!(!looks_like_definitively_unauthenticated(
            "could not authenticate to one or more of the configured GitLab instances"
        ));
        assert!(!looks_like_definitively_unauthenticated(
            "HTTP 403 Forbidden"
        ));
        assert!(!looks_like_definitively_unauthenticated("connection reset"));
    }

    // ---------------- parse_project_push_permission ----------------
    //
    // GitLab access levels (constants are GitLab's, not ours):
    //   10 Guest, 20 Reporter, 30 Developer, 40 Maintainer, 50 Owner.
    // Auto-bind needs *push*, so the threshold is Developer (30).

    #[test]
    fn parse_project_push_permission_true_for_developer_via_project_access() {
        let stdout = r#"{
            "id": 1,
            "permissions": {
                "project_access": {"access_level": 30, "notification_level": 3},
                "group_access": null
            }
        }"#;
        assert!(parse_project_push_permission(stdout).unwrap());
    }

    #[test]
    fn parse_project_push_permission_true_for_maintainer() {
        let stdout = r#"{
            "permissions": {
                "project_access": {"access_level": 40, "notification_level": 3},
                "group_access": null
            }
        }"#;
        assert!(parse_project_push_permission(stdout).unwrap());
    }

    #[test]
    fn parse_project_push_permission_false_for_reporter() {
        // Reporter (20) — read-only on most workflows. Must NOT be
        // auto-bound or push will silently fail.
        let stdout = r#"{
            "permissions": {
                "project_access": {"access_level": 20, "notification_level": 3},
                "group_access": null
            }
        }"#;
        assert!(!parse_project_push_permission(stdout).unwrap());
    }

    #[test]
    fn parse_project_push_permission_false_for_guest() {
        let stdout = r#"{
            "permissions": {
                "project_access": {"access_level": 10, "notification_level": 0},
                "group_access": null
            }
        }"#;
        assert!(!parse_project_push_permission(stdout).unwrap());
    }

    #[test]
    fn parse_project_push_permission_uses_higher_of_project_and_group() {
        // Project says Reporter, Group inherits Maintainer. The user
        // can push because the group level wins. This is the
        // canonical "subgroup admin" pattern in shared-monorepo
        // setups.
        let stdout = r#"{
            "permissions": {
                "project_access": {"access_level": 20},
                "group_access": {"access_level": 40}
            }
        }"#;
        assert!(parse_project_push_permission(stdout).unwrap());
    }

    #[test]
    fn parse_project_push_permission_handles_null_access_levels() {
        // Both blocks present but with `access_level: null` — treat
        // as 0 (no permission), don't blow up.
        let stdout = r#"{
            "permissions": {
                "project_access": {"access_level": null},
                "group_access": {"access_level": null}
            }
        }"#;
        assert!(!parse_project_push_permission(stdout).unwrap());
    }

    #[test]
    fn parse_project_push_permission_false_when_permissions_missing() {
        // Anonymous response or scope without `permissions` — treat
        // as not pushable. Mirrors the GitHub side.
        let stdout = r#"{ "id": 1, "name": "x" }"#;
        assert!(!parse_project_push_permission(stdout).unwrap());
    }

    #[test]
    fn parse_project_push_permission_errors_on_malformed_json() {
        assert!(parse_project_push_permission("{not json").is_err());
    }
}
