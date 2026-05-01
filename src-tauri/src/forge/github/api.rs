//! Thin wrapper around `gh api graphql …` plus the remote-URL parsing
//! every endpoint call needs. Higher-level modules (`pull_request`,
//! `actions`) call [`run_graphql`] / [`run_graphql_raw`] with the query
//! and variables and get a strongly-typed envelope back.
//!
//! Multi-account support comes for free: every `gh api` call routes
//! through `super::accounts::run_cli_with_login`, which sets `GH_TOKEN`
//! per-spawn so we never mutate gh's global "active account" pointer.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use super::accounts as gh_accounts;
use crate::forge::command::{command_detail, CommandOutput};

pub(super) const GITHUB_HOST: &str = "github.com";

/// `gh api graphql` either returned a usable JSON body or it told us
/// the user's token was rejected. Splitting the latter out lets callers
/// degrade to the inspector "Connect" CTA without surfacing a generic
/// error.
pub(super) enum GraphqlOutcome<T> {
    Ok(T),
    Auth,
}

/// Run `gh api graphql -f query=… -f var=…` deserialised into `T`.
pub(super) fn run_graphql<T: for<'de> Deserialize<'de>>(
    login: &str,
    query: &str,
    variables: &[(&str, &str)],
) -> Result<GraphqlOutcome<T>> {
    match run_graphql_command(login, query, variables)? {
        GraphqlOutcome::Auth => Ok(GraphqlOutcome::Auth),
        GraphqlOutcome::Ok(output) => {
            let parsed = serde_json::from_str::<T>(&output.stdout)
                .with_context(|| "Failed to decode GitHub GraphQL response".to_string())?;
            Ok(GraphqlOutcome::Ok(parsed))
        }
    }
}

/// Same as [`run_graphql`] but leaves the response as `serde_json::Value`
/// for callers (mutation paths) that pluck individual fields out.
pub(super) fn run_graphql_raw(
    login: &str,
    query: &str,
    variables: &[(&str, &str)],
) -> Result<GraphqlOutcome<serde_json::Value>> {
    match run_graphql_command(login, query, variables)? {
        GraphqlOutcome::Auth => Ok(GraphqlOutcome::Auth),
        GraphqlOutcome::Ok(output) => {
            let parsed = serde_json::from_str::<serde_json::Value>(&output.stdout)
                .with_context(|| "Failed to decode GitHub GraphQL response".to_string())?;
            Ok(GraphqlOutcome::Ok(parsed))
        }
    }
}

fn run_graphql_command(
    login: &str,
    query: &str,
    variables: &[(&str, &str)],
) -> Result<GraphqlOutcome<CommandOutput>> {
    let mut args: Vec<String> = vec![
        "api".to_string(),
        "--hostname".to_string(),
        GITHUB_HOST.to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={query}"),
    ];
    for (key, value) in variables {
        args.push("-f".to_string());
        args.push(format!("{key}={value}"));
    }

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = match gh_accounts::run_cli_with_login(GITHUB_HOST, login, &arg_refs) {
        Ok(output) => output,
        Err(error) => {
            // `gh auth token --user X` failing → that account is gone
            // from the local credential store (user signed out from
            // elsewhere). Surface as auth-needed so the inspector
            // shows "Connect" instead of a generic error.
            let message = format!("{error:#}");
            if looks_like_auth_rejection(&message) {
                return Ok(GraphqlOutcome::Auth);
            }
            return Err(error.context("Failed to spawn `gh api graphql`"));
        }
    };

    if output.success {
        return Ok(GraphqlOutcome::Ok(output));
    }

    let detail = command_detail(&output);
    if looks_like_auth_rejection(&detail) {
        return Ok(GraphqlOutcome::Auth);
    }
    Err(anyhow!("`gh api graphql` failed: {detail}"))
}

pub(super) fn looks_like_auth_rejection(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    // HTTP-side rejection signals.
    normalized.contains("401")
        || normalized.contains("403")
        || normalized.contains("bad credentials")
        // Local-side: the bound account is missing from `gh`'s
        // credential store entirely (logged out from elsewhere). We
        // hit this through `gh auth token --user X` returning non-zero.
        || normalized.contains("no oauth token")
        || normalized.contains("not logged in")
        || normalized.contains("not logged into")
        || normalized.contains("gh auth token --user")
}

/// Parse `https://github.com/owner/repo(.git)` and `git@github.com:owner/repo(.git)`
/// remotes into `(owner, repo)`. Returns `None` for non-GitHub remotes.
pub(super) fn parse_github_remote(remote: &str) -> Option<(String, String)> {
    let remote = remote.trim();
    // SSH form: git@github.com:owner/repo(.git)
    if let Some(rest) = remote.strip_prefix("git@github.com:") {
        return split_owner_repo(rest.trim_end_matches(".git"));
    }
    // HTTPS form: https://github.com/owner/repo(.git) or with auth prefix.
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "git://github.com/",
        "ssh://git@github.com/",
    ] {
        if let Some(rest) = remote.strip_prefix(prefix) {
            return split_owner_repo(rest.trim_end_matches(".git"));
        }
    }
    None
}

fn split_owner_repo(s: &str) -> Option<(String, String)> {
    let trimmed = s.trim_matches('/');
    let mut parts = trimmed.splitn(2, '/');
    let owner = parts.next()?.trim();
    let name = parts.next()?.trim();
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some((owner.to_string(), name.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_remote() {
        let parsed = parse_github_remote("https://github.com/octocat/hello-world.git");
        assert_eq!(
            parsed,
            Some(("octocat".to_string(), "hello-world".to_string()))
        );
    }

    #[test]
    fn parses_https_remote_without_git_suffix() {
        let parsed = parse_github_remote("https://github.com/octocat/hello-world");
        assert_eq!(
            parsed,
            Some(("octocat".to_string(), "hello-world".to_string()))
        );
    }

    #[test]
    fn parses_ssh_remote() {
        let parsed = parse_github_remote("git@github.com:octocat/hello-world.git");
        assert_eq!(
            parsed,
            Some(("octocat".to_string(), "hello-world".to_string()))
        );
    }

    #[test]
    fn rejects_non_github_remote() {
        assert_eq!(parse_github_remote("https://gitlab.com/foo/bar.git"), None);
    }

    #[test]
    fn rejects_malformed_remote() {
        assert_eq!(parse_github_remote("https://github.com/"), None);
        assert_eq!(parse_github_remote("git@github.com:incomplete"), None);
    }

    #[test]
    fn parses_ssh_scheme_form() {
        let parsed = parse_github_remote("ssh://git@github.com/octocat/hello-world.git");
        assert_eq!(
            parsed,
            Some(("octocat".to_string(), "hello-world".to_string()))
        );
    }

    #[test]
    fn handles_trailing_slash_on_remote() {
        let parsed = parse_github_remote("https://github.com/octocat/hello-world/");
        assert_eq!(
            parsed,
            Some(("octocat".to_string(), "hello-world".to_string()))
        );
    }

    #[test]
    fn parses_padded_remote_input() {
        let parsed = parse_github_remote("  https://github.com/octocat/hello-world.git  ");
        assert_eq!(
            parsed,
            Some(("octocat".to_string(), "hello-world".to_string()))
        );
    }

    #[test]
    fn rejects_other_forges() {
        assert_eq!(parse_github_remote("https://gitlab.com/foo/bar.git"), None);
        assert_eq!(parse_github_remote("git@bitbucket.org:foo/bar.git"), None);
        assert_eq!(parse_github_remote("https://example.com/foo/bar"), None);
    }

    #[test]
    fn split_owner_repo_trims_whitespace() {
        assert_eq!(
            split_owner_repo("  octocat / hello-world  "),
            Some(("octocat".to_string(), "hello-world".to_string()))
        );
    }

    #[test]
    fn split_owner_repo_rejects_blank_segments() {
        assert_eq!(split_owner_repo(" / hello-world"), None);
        assert_eq!(split_owner_repo("octocat / "), None);
        assert_eq!(split_owner_repo("/"), None);
    }

    #[test]
    fn looks_like_auth_rejection_matches_canonical_phrases() {
        assert!(looks_like_auth_rejection("HTTP 401: Bad credentials"));
        assert!(looks_like_auth_rejection("HTTP 403: Forbidden"));
        assert!(looks_like_auth_rejection("Bad credentials"));
        assert!(!looks_like_auth_rejection("HTTP 500: Server Error"));
        assert!(!looks_like_auth_rejection("connection reset"));
    }
}
