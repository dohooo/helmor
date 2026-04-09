//! GitHub GraphQL helpers used by in-app features that talk directly to
//! api.github.com (e.g. the commit button's post-stream PR verification).
//!
//! Unlike `github_cli.rs`, which shells out to `gh`, this module goes straight
//! to the v4 GraphQL endpoint using the OAuth access token persisted by the
//! device-flow identity stored in `auth.rs`. It exists so Helmor can look up
//! PR state without requiring `gh` to be installed on the user's machine.

use anyhow::{anyhow, bail, Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{auth, workspaces};

/// A single pull request surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestInfo {
    /// Full `https://github.com/owner/repo/pull/N` URL.
    pub url: String,
    /// Numeric PR id (`N` in the URL).
    pub number: i64,
    /// GitHub PR state — one of `OPEN`, `CLOSED`, `MERGED`.
    pub state: String,
    /// PR title as shown on GitHub.
    pub title: String,
    /// `true` when the PR has been merged into its base branch.
    pub is_merged: bool,
}

/// Look up the (most recent) pull request matching this workspace's current
/// branch on GitHub.
///
/// Returns:
///   - `Ok(Some(pr))` when a PR is found for `headRefName == branch`.
///   - `Ok(None)` when there's no matching PR, when the workspace has no
///     github.com remote, when the user isn't connected to GitHub, or when
///     the access token has been revoked.
///   - `Err(_)` only for unexpected transport / parse failures (so the caller
///     can surface a distinct "something went wrong" state).
pub fn lookup_workspace_pr(workspace_id: &str) -> Result<Option<PullRequestInfo>> {
    let Some(record) = workspaces::load_workspace_record_by_id(workspace_id)? else {
        bail!("Workspace not found: {workspace_id}");
    };

    let Some(remote_url) = record.remote_url.as_deref() else {
        return Ok(None);
    };
    let Some((owner, name)) = parse_github_remote(remote_url) else {
        // Not a github.com remote — nothing to query.
        return Ok(None);
    };
    let Some(branch) = record.branch.as_deref().filter(|b| !b.is_empty()) else {
        return Ok(None);
    };

    let Some(access_token) = auth::load_valid_github_access_token()? else {
        // User isn't connected, or their refresh token has expired.
        return Ok(None);
    };

    let client = Client::builder()
        .build()
        .context("Failed to build GitHub HTTP client")?;

    let query = r#"
query($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN, MERGED, CLOSED], first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        url
        number
        state
        title
        merged
      }
    }
  }
}
"#;

    let body = json!({
        "query": query,
        "variables": {
            "owner": owner,
            "name": name,
            "head": branch,
        },
    });

    let response = client
        .post("https://api.github.com/graphql")
        .header(USER_AGENT, "Helmor")
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .json(&body)
        .send()
        .context("Failed to reach GitHub GraphQL API")?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        // Token was rejected — treat as "not connected" rather than erroring.
        return Ok(None);
    }
    if !status.is_success() {
        return Err(anyhow!(
            "GitHub GraphQL API returned HTTP {status}: {}",
            response.text().unwrap_or_default()
        ));
    }

    let parsed: GraphqlEnvelope = response
        .json()
        .context("Failed to decode GitHub GraphQL response")?;

    if let Some(errors) = &parsed.errors {
        if !errors.is_empty() {
            // "Could not resolve to a Repository" means the token doesn't
            // have access to this repo (private + insufficient scope) or the
            // repo doesn't exist. Treat like "not connected" — return None
            // so the caller degrades gracefully instead of surfacing an error.
            let is_repo_not_found = errors.iter().any(|e| {
                e.message.contains("Could not resolve to a Repository")
                    || e.message.contains("NOT_FOUND")
            });
            if is_repo_not_found {
                return Ok(None);
            }
            // Other GraphQL errors are unexpected — propagate.
            return Err(anyhow!(
                "GitHub GraphQL errors: {}",
                errors
                    .iter()
                    .map(|e| e.message.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
    }

    let Some(data) = parsed.data else {
        return Ok(None);
    };
    let Some(repository) = data.repository else {
        return Ok(None);
    };

    let Some(node) = repository.pull_requests.nodes.into_iter().next() else {
        return Ok(None);
    };

    Ok(Some(PullRequestInfo {
        url: node.url,
        number: node.number,
        state: node.state,
        title: node.title,
        is_merged: node.merged,
    }))
}

/// Merge a workspace's open PR via the GitHub GraphQL `mergePullRequest`
/// mutation. Returns the updated `PullRequestInfo` on success, or `None`
/// when the PR can't be found / user isn't connected.
pub fn merge_workspace_pr(workspace_id: &str) -> Result<Option<PullRequestInfo>> {
    let pr = lookup_workspace_pr(workspace_id)?;
    let Some(pr) = pr else {
        return Ok(None);
    };
    if pr.state != "OPEN" {
        bail!("PR #{} is not open (state: {})", pr.number, pr.state);
    }

    let access_token = auth::load_valid_github_access_token()?;
    let Some(access_token) = access_token else {
        return Ok(None);
    };

    // We need the PR's GraphQL node ID. Re-query with node ID included.
    let Some(record) = workspaces::load_workspace_record_by_id(workspace_id)? else {
        bail!("Workspace not found: {workspace_id}");
    };
    let Some(remote_url) = record.remote_url.as_deref() else {
        return Ok(None);
    };
    let Some((owner, name)) = parse_github_remote(remote_url) else {
        return Ok(None);
    };
    let Some(branch) = record.branch.as_deref().filter(|b| !b.is_empty()) else {
        return Ok(None);
    };

    let client = Client::builder()
        .build()
        .context("Failed to build GitHub HTTP client")?;

    // Fetch PR node ID
    let id_query = r#"
query($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN], first: 1) {
      nodes { id, url, number, state, title, merged }
    }
  }
}
"#;
    let id_body = json!({
        "query": id_query,
        "variables": { "owner": owner, "name": name, "head": branch },
    });

    let id_response: GraphqlEnvelope = client
        .post("https://api.github.com/graphql")
        .header(USER_AGENT, "Helmor")
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .json(&id_body)
        .send()
        .context("Failed to reach GitHub GraphQL API")?
        .json()
        .context("Failed to decode GraphQL response")?;

    let pr_node_id = id_response
        .data
        .and_then(|d| d.repository)
        .and_then(|r| r.pull_requests.nodes.into_iter().next())
        .map(|n| n.id);
    let Some(pr_node_id) = pr_node_id.flatten() else {
        bail!("Could not resolve PR node ID for #{}", pr.number);
    };

    // Execute merge mutation
    let merge_mutation = r#"
mutation($prId: ID!) {
  mergePullRequest(input: { pullRequestId: $prId }) {
    pullRequest { url, number, state, title, merged }
  }
}
"#;
    let merge_body = json!({
        "query": merge_mutation,
        "variables": { "prId": pr_node_id },
    });

    let merge_response: serde_json::Value = client
        .post("https://api.github.com/graphql")
        .header(USER_AGENT, "Helmor")
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .json(&merge_body)
        .send()
        .context("Failed to call mergePullRequest")?
        .json()
        .context("Failed to decode merge response")?;

    if let Some(errors) = merge_response.get("errors") {
        if let Some(arr) = errors.as_array() {
            if !arr.is_empty() {
                let msgs: Vec<&str> = arr
                    .iter()
                    .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                    .collect();
                bail!("mergePullRequest failed: {}", msgs.join("; "));
            }
        }
    }

    // Return refreshed PR info
    lookup_workspace_pr(workspace_id)
}

/// Close a workspace's open PR via the GitHub GraphQL `closePullRequest`
/// mutation. Returns the updated `PullRequestInfo` on success.
pub fn close_workspace_pr(workspace_id: &str) -> Result<Option<PullRequestInfo>> {
    let pr = lookup_workspace_pr(workspace_id)?;
    let Some(pr) = pr else {
        return Ok(None);
    };
    if pr.state != "OPEN" {
        bail!("PR #{} is not open (state: {})", pr.number, pr.state);
    }

    let access_token = auth::load_valid_github_access_token()?;
    let Some(access_token) = access_token else {
        return Ok(None);
    };

    let Some(record) = workspaces::load_workspace_record_by_id(workspace_id)? else {
        bail!("Workspace not found: {workspace_id}");
    };
    let Some(remote_url) = record.remote_url.as_deref() else {
        return Ok(None);
    };
    let Some((owner, name)) = parse_github_remote(remote_url) else {
        return Ok(None);
    };
    let Some(branch) = record.branch.as_deref().filter(|b| !b.is_empty()) else {
        return Ok(None);
    };

    let client = Client::builder()
        .build()
        .context("Failed to build GitHub HTTP client")?;

    // Fetch PR node ID
    let id_query = r#"
query($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN], first: 1) {
      nodes { id, url, number, state, title, merged }
    }
  }
}
"#;
    let id_body = json!({
        "query": id_query,
        "variables": { "owner": owner, "name": name, "head": branch },
    });

    let id_response: GraphqlEnvelope = client
        .post("https://api.github.com/graphql")
        .header(USER_AGENT, "Helmor")
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .json(&id_body)
        .send()
        .context("Failed to reach GitHub GraphQL API")?
        .json()
        .context("Failed to decode GraphQL response")?;

    let pr_node_id = id_response
        .data
        .and_then(|d| d.repository)
        .and_then(|r| r.pull_requests.nodes.into_iter().next())
        .map(|n| n.id);
    let Some(pr_node_id) = pr_node_id.flatten() else {
        bail!("Could not resolve PR node ID for #{}", pr.number);
    };

    let close_mutation = r#"
mutation($prId: ID!) {
  closePullRequest(input: { pullRequestId: $prId }) {
    pullRequest { url, number, state, title, merged }
  }
}
"#;
    let close_body = json!({
        "query": close_mutation,
        "variables": { "prId": pr_node_id },
    });

    let close_response: serde_json::Value = client
        .post("https://api.github.com/graphql")
        .header(USER_AGENT, "Helmor")
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .json(&close_body)
        .send()
        .context("Failed to call closePullRequest")?
        .json()
        .context("Failed to decode close response")?;

    if let Some(errors) = close_response.get("errors") {
        if let Some(arr) = errors.as_array() {
            if !arr.is_empty() {
                let msgs: Vec<&str> = arr
                    .iter()
                    .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                    .collect();
                bail!("closePullRequest failed: {}", msgs.join("; "));
            }
        }
    }

    lookup_workspace_pr(workspace_id)
}

/// Parse `https://github.com/owner/repo(.git)` and `git@github.com:owner/repo(.git)`
/// remotes into `(owner, repo)`. Returns `None` for non-GitHub remotes.
fn parse_github_remote(remote: &str) -> Option<(String, String)> {
    let remote = remote.trim();
    // SSH form: git@github.com:owner/repo(.git)
    if let Some(rest) = remote.strip_prefix("git@github.com:") {
        return split_owner_repo(rest.trim_end_matches(".git"));
    }
    // HTTPS form: https://github.com/owner/repo(.git)  or with auth prefix.
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

#[derive(Debug, Clone, Deserialize)]
struct GraphqlEnvelope {
    data: Option<GraphqlData>,
    errors: Option<Vec<GraphqlError>>,
}

#[derive(Debug, Clone, Deserialize)]
struct GraphqlData {
    repository: Option<Repository>,
}

#[derive(Debug, Clone, Deserialize)]
struct Repository {
    #[serde(rename = "pullRequests")]
    pull_requests: PullRequestConnection,
}

#[derive(Debug, Clone, Deserialize)]
struct PullRequestConnection {
    nodes: Vec<PullRequestNode>,
}

#[derive(Debug, Clone, Deserialize)]
struct PullRequestNode {
    /// GraphQL node ID (e.g. "PR_kwDO..."). Only populated when the query
    /// explicitly selects `id`; the lookup query omits it so this is
    /// `None` on the primary path.
    id: Option<String>,
    url: String,
    number: i64,
    state: String,
    title: String,
    merged: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct GraphqlError {
    message: String,
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
}
