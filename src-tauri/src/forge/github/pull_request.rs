//! Pull-request operations: lookup the most recent PR for a branch
//! plus the merge / close mutations. The GraphQL machinery itself
//! lives in `super::api`; this module owns the queries + result
//! transformations.

use anyhow::{anyhow, bail, Context, Result};

use crate::forge::ChangeRequestInfo;

use super::api::{run_graphql, run_graphql_raw, GraphqlOutcome};
use super::context::GithubContext;
use super::pr_match::matches_workspace_pr;
use super::types::{GraphqlEnvelope, PullRequestNode};

// `first: 10` leaves room for the cross-repo filter to find the in-repo match.
const PR_LOOKUP_QUERY: &str = r#"
query($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN, MERGED, CLOSED], first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        url
        number
        state
        title
        merged
        isCrossRepository
        headRepositoryOwner { login }
      }
    }
  }
}
"#;

const PR_NODE_ID_QUERY: &str = r#"
query($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN], first: 5) {
      nodes { id, url, number, state, title, merged, isCrossRepository, headRepositoryOwner { login } }
    }
  }
}
"#;

// Repo-level merge settings query. We pick a `mergeMethod` from these
// flags before issuing the merge mutation — sending it without a
// method would default to MERGE and fail on repos that disallow merge
// commits ("Merge commits are not allowed on this repository.").
const REPO_MERGE_METHODS_QUERY: &str = r#"
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    fn as_graphql(self) -> &'static str {
        match self {
            Self::Merge => "MERGE",
            Self::Squash => "SQUASH",
            Self::Rebase => "REBASE",
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct AllowedMergeMethods {
    merge: bool,
    squash: bool,
    rebase: bool,
}

impl AllowedMergeMethods {
    /// Pick the first allowed method in MERGE → SQUASH → REBASE order.
    /// MERGE first matches the historical default (and what users
    /// usually mean by "Merge"); the others are fallbacks for repos
    /// that disable merge commits.
    fn pick(self) -> Option<MergeMethod> {
        if self.merge {
            Some(MergeMethod::Merge)
        } else if self.squash {
            Some(MergeMethod::Squash)
        } else if self.rebase {
            Some(MergeMethod::Rebase)
        } else {
            None
        }
    }
}

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
        .and_then(|r| pick_workspace_pr(r.pull_requests.nodes, &context.login))
        .map(pr_info))
}

fn pick_workspace_pr(nodes: Vec<PullRequestNode>, bound_login: &str) -> Option<PullRequestNode> {
    nodes.into_iter().find(|node| {
        matches_workspace_pr(
            node.is_cross_repository,
            node.head_repository_owner.as_ref(),
            bound_login,
        )
    })
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
        .and_then(|r| pick_workspace_pr(r.pull_requests.nodes, &context.login))
        .and_then(|n| n.id))
}

/// Run the `mergePullRequest` mutation for `pr_node_id`.
///
/// Queries the repo's allowed merge methods first and picks one
/// (MERGE → SQUASH → REBASE). Sending the mutation without an explicit
/// `mergeMethod` defaults to MERGE and fails on repos that disallow
/// merge commits.
pub(super) fn merge_pull_request(context: &GithubContext, pr_node_id: &str) -> Result<()> {
    let methods = fetch_allowed_merge_methods(context)
        .context("Failed to query repository merge settings")?;
    let Some(method) = methods.pick() else {
        bail!("Repository does not allow any merge method (merge / squash / rebase all disabled)");
    };
    run_pr_mutation(&context.login, &merge_mutation_for(method), pr_node_id)
}

fn merge_mutation_for(method: MergeMethod) -> String {
    format!(
        r#"
mutation($prId: ID!) {{
  mergePullRequest(input: {{ pullRequestId: $prId, mergeMethod: {} }}) {{
    pullRequest {{ url, number, state, title, merged }}
  }}
}}
"#,
        method.as_graphql()
    )
}

fn fetch_allowed_merge_methods(context: &GithubContext) -> Result<AllowedMergeMethods> {
    let parsed: serde_json::Value = match run_graphql_raw(
        &context.login,
        REPO_MERGE_METHODS_QUERY,
        &[
            ("owner", context.owner.as_str()),
            ("name", context.name.as_str()),
        ],
    )? {
        GraphqlOutcome::Auth => bail!("GitHub token was rejected"),
        GraphqlOutcome::Ok(value) => value,
    };
    if let Some(errors) = parsed.get("errors").and_then(|v| v.as_array()) {
        if !errors.is_empty() {
            let msgs: Vec<&str> = errors
                .iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                .collect();
            bail!("GraphQL query failed: {}", msgs.join("; "));
        }
    }
    let repo = parsed
        .pointer("/data/repository")
        .ok_or_else(|| anyhow!("Repository missing from merge-methods response"))?;
    Ok(AllowedMergeMethods {
        merge: repo
            .get("mergeCommitAllowed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        squash: repo
            .get("squashMergeAllowed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        rebase: repo
            .get("rebaseMergeAllowed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
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
    use super::super::types::HeadRepositoryOwner;
    use super::*;

    fn make_node(state: &str, merged: bool) -> PullRequestNode {
        PullRequestNode {
            id: None,
            url: "https://github.com/octocat/hello-world/pull/1".to_string(),
            number: 1,
            state: state.to_string(),
            title: "Update".to_string(),
            merged,
            is_cross_repository: false,
            head_repository_owner: None,
        }
    }

    fn make_node_with_cross_repo(
        state: &str,
        number: i64,
        cross: bool,
        owner: Option<&str>,
    ) -> PullRequestNode {
        PullRequestNode {
            id: None,
            url: format!("https://github.com/octocat/hello-world/pull/{number}"),
            number,
            state: state.to_string(),
            title: "Update".to_string(),
            merged: false,
            is_cross_repository: cross,
            head_repository_owner: owner.map(|login| HeadRepositoryOwner {
                login: login.to_string(),
            }),
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

    #[test]
    fn pick_prefers_merge_when_available() {
        let methods = AllowedMergeMethods {
            merge: true,
            squash: true,
            rebase: true,
        };
        assert_eq!(methods.pick(), Some(MergeMethod::Merge));
    }

    /// The original bug: repo disallows merge commits, only squash is
    /// on. Picker must fall back to SQUASH instead of failing.
    #[test]
    fn pick_falls_back_to_squash_when_merge_disabled() {
        let methods = AllowedMergeMethods {
            merge: false,
            squash: true,
            rebase: true,
        };
        assert_eq!(methods.pick(), Some(MergeMethod::Squash));
    }

    #[test]
    fn pick_falls_back_to_rebase_when_only_rebase_allowed() {
        let methods = AllowedMergeMethods {
            merge: false,
            squash: false,
            rebase: true,
        };
        assert_eq!(methods.pick(), Some(MergeMethod::Rebase));
    }

    #[test]
    fn pick_returns_none_when_all_disabled() {
        assert_eq!(AllowedMergeMethods::default().pick(), None);
    }

    // Regression: workspace on `main` got auto-canceled by a fork's closed `main` PR.
    #[test]
    fn pick_workspace_pr_skips_unrelated_cross_repository_nodes() {
        let nodes = vec![
            make_node_with_cross_repo("CLOSED", 433, true, Some("other-user")),
            make_node_with_cross_repo("OPEN", 100, false, None),
        ];
        let picked = pick_workspace_pr(nodes, "octocat").expect("expected an in-repo PR");
        assert_eq!(picked.number, 100);
    }

    #[test]
    fn pick_workspace_pr_matches_cross_repository_node_from_bound_login() {
        let nodes = vec![make_node_with_cross_repo("OPEN", 473, true, Some("Aidxun"))];
        let picked = pick_workspace_pr(nodes, "aidxun").expect("expected bound fork PR");
        assert_eq!(picked.number, 473);
    }

    #[test]
    fn pick_workspace_pr_does_not_match_cross_repository_node_for_different_login() {
        let nodes = vec![make_node_with_cross_repo(
            "OPEN",
            473,
            true,
            Some("fork-owner"),
        )];
        assert!(pick_workspace_pr(nodes, "authorized-collaborator").is_none());
    }

    #[test]
    fn pick_workspace_pr_returns_none_when_only_unrelated_cross_repo_matches() {
        let nodes = vec![make_node_with_cross_repo(
            "CLOSED",
            433,
            true,
            Some("other-user"),
        )];
        assert!(pick_workspace_pr(nodes, "octocat").is_none());
    }

    #[test]
    fn pick_workspace_pr_returns_none_for_cross_repo_without_owner() {
        let nodes = vec![make_node_with_cross_repo("CLOSED", 433, true, None)];
        assert!(pick_workspace_pr(nodes, "octocat").is_none());
    }

    #[test]
    fn pick_workspace_pr_preserves_order_when_first_node_is_in_repo() {
        let nodes = vec![
            make_node_with_cross_repo("OPEN", 100, false, None),
            make_node_with_cross_repo("CLOSED", 99, false, None),
        ];
        let picked = pick_workspace_pr(nodes, "octocat").expect("expected first in-repo PR");
        assert_eq!(picked.number, 100);
    }

    #[test]
    fn merge_mutation_inlines_method_literal() {
        let body = merge_mutation_for(MergeMethod::Squash);
        assert!(body.contains("mergeMethod: SQUASH"));
        assert!(body.contains("pullRequestId: $prId"));
    }
}
