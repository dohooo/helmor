//! Pull-request operations: lookup the most recent PR for a branch
//! plus the merge / close mutations. The GraphQL machinery itself
//! lives in `super::api`; this module owns the queries + result
//! transformations.

use anyhow::{anyhow, bail, Result};

use crate::forge::ChangeRequestInfo;

use super::api::{run_graphql, run_graphql_raw, GraphqlOutcome};
use super::context::GithubContext;
use super::types::{GraphqlEnvelope, PullRequestNode};

const PR_LOOKUP_QUERY: &str = r#"
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

const PR_NODE_ID_QUERY: &str = r#"
query($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN], first: 1) {
      nodes { id, url, number, state, title, merged }
    }
  }
}
"#;

const MERGE_PR_MUTATION: &str = r#"
mutation($prId: ID!) {
  mergePullRequest(input: { pullRequestId: $prId }) {
    pullRequest { url, number, state, title, merged }
  }
}
"#;

const CLOSE_PR_MUTATION: &str = r#"
mutation($prId: ID!) {
  closePullRequest(input: { pullRequestId: $prId }) {
    pullRequest { url, number, state, title, merged }
  }
}
"#;

/// Fetch the most-recent PR matching this context's `(owner, name, head)`.
/// Returns `Ok(None)` when there's no matching PR, when the token has
/// no access (so caller renders "no PR"), or when the GraphQL response
/// itself reported a benign "Could not resolve repository" error.
pub(super) fn find_workspace_pr(context: &GithubContext) -> Result<Option<ChangeRequestInfo>> {
    let parsed: GraphqlEnvelope = match run_graphql(
        &context.login,
        PR_LOOKUP_QUERY,
        &[
            ("owner", context.owner.as_str()),
            ("name", context.name.as_str()),
            ("head", context.branch.as_str()),
        ],
    )? {
        GraphqlOutcome::Auth => return Ok(None),
        GraphqlOutcome::Ok(value) => value,
    };

    if let Some(errors) = &parsed.errors {
        if !errors.is_empty() {
            // "Could not resolve to a Repository" means the token doesn't
            // have access to this repo (private + insufficient scope) or
            // the repo doesn't exist. Treat like "not connected" — return
            // None so the caller degrades gracefully instead of
            // surfacing an error.
            let is_repo_not_found = errors.iter().any(|e| {
                e.message.contains("Could not resolve to a Repository")
                    || e.message.contains("NOT_FOUND")
            });
            if is_repo_not_found {
                return Ok(None);
            }
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

    Ok(parsed
        .data
        .and_then(|d| d.repository)
        .and_then(|r| r.pull_requests.nodes.into_iter().next())
        .map(pr_info))
}

/// Convert a GraphQL pull-request node into the public
/// `ChangeRequestInfo`. Tiny helper but symmetrical with
/// `forge::gitlab::merge_request::mr_info`.
fn pr_info(node: PullRequestNode) -> ChangeRequestInfo {
    ChangeRequestInfo {
        url: node.url,
        number: node.number,
        state: node.state,
        title: node.title,
        is_merged: node.merged,
    }
}

/// Fetch the GraphQL node ID for the open PR on this branch. Required
/// input to the merge / close mutations.
pub(super) fn fetch_open_pr_node_id(context: &GithubContext) -> Result<Option<String>> {
    let parsed: GraphqlEnvelope = match run_graphql(
        &context.login,
        PR_NODE_ID_QUERY,
        &[
            ("owner", context.owner.as_str()),
            ("name", context.name.as_str()),
            ("head", context.branch.as_str()),
        ],
    )? {
        GraphqlOutcome::Auth => return Ok(None),
        GraphqlOutcome::Ok(value) => value,
    };
    Ok(parsed
        .data
        .and_then(|d| d.repository)
        .and_then(|r| r.pull_requests.nodes.into_iter().next())
        .and_then(|n| n.id))
}

/// Run the `mergePullRequest` mutation for `pr_node_id`.
pub(super) fn merge_pull_request(login: &str, pr_node_id: &str) -> Result<()> {
    run_pr_mutation(login, MERGE_PR_MUTATION, pr_node_id)
}

/// Run the `closePullRequest` mutation for `pr_node_id`.
pub(super) fn close_pull_request(login: &str, pr_node_id: &str) -> Result<()> {
    run_pr_mutation(login, CLOSE_PR_MUTATION, pr_node_id)
}

fn run_pr_mutation(login: &str, mutation: &str, pr_node_id: &str) -> Result<()> {
    let parsed: serde_json::Value = match run_graphql_raw(login, mutation, &[("prId", pr_node_id)])?
    {
        GraphqlOutcome::Auth => bail!("GitHub token was rejected"),
        GraphqlOutcome::Ok(value) => value,
    };
    if let Some(errors) = parsed.get("errors").and_then(|v| v.as_array()) {
        if !errors.is_empty() {
            let msgs: Vec<&str> = errors
                .iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                .collect();
            bail!("GraphQL mutation failed: {}", msgs.join("; "));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_node(state: &str, merged: bool) -> PullRequestNode {
        PullRequestNode {
            id: None,
            url: "https://github.com/octocat/hello-world/pull/1".to_string(),
            number: 1,
            state: state.to_string(),
            title: "Update".to_string(),
            merged,
        }
    }

    #[test]
    fn pr_info_copies_fields_into_change_request_info() {
        let info = pr_info(make_node("OPEN", false));
        assert_eq!(info.url, "https://github.com/octocat/hello-world/pull/1");
        assert_eq!(info.number, 1);
        assert_eq!(info.state, "OPEN");
        assert_eq!(info.title, "Update");
        assert!(!info.is_merged);
    }

    /// Surfaces the merged flag as `is_merged` to the public type. We
    /// rely on this distinction in the inspector to decide whether to
    /// show a "merged" pill vs. an open-PR badge.
    #[test]
    fn pr_info_carries_merged_flag() {
        let info = pr_info(make_node("MERGED", true));
        assert_eq!(info.state, "MERGED");
        assert!(info.is_merged);
    }

    /// `state` is preserved verbatim — the action-status renderer treats
    /// `MERGED` and `CLOSED` differently, so any normalisation has to
    /// happen at the call site, not silently here.
    #[test]
    fn pr_info_preserves_closed_state_separately_from_merged() {
        let info = pr_info(make_node("CLOSED", false));
        assert_eq!(info.state, "CLOSED");
        assert!(!info.is_merged);
    }
}
