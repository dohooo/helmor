//! Fetch the PR comments + review summaries for a workspace's branch.
//!
//! Single GraphQL round-trip: locate the PR by `headRefName` (same as
//! `pull_request::find_workspace_pr`), then pull `comments(first: 100)`
//! and `reviews(first: 100)` in one query. Inline per-line review
//! comments are intentionally NOT surfaced — without code-line context
//! they read as noise; users who want them click through to GitHub.

use anyhow::{anyhow, Result};
use serde::Deserialize;

use crate::forge::types::{PrCommentInfo, PrCommentKind};

use super::api::{run_graphql, GraphqlOutcome};
use super::context::GithubContext;

const PR_COMMENTS_QUERY: &str = r#"
query($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN, MERGED, CLOSED], first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        isCrossRepository
        comments(first: 100) {
          nodes {
            id
            url
            createdAt
            body
            author { login avatarUrl }
          }
        }
        reviews(first: 100) {
          nodes {
            id
            url
            state
            submittedAt
            createdAt
            body
            author { login avatarUrl }
          }
        }
      }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
struct CommentsEnvelope {
    data: Option<CommentsData>,
    #[serde(default)]
    errors: Option<Vec<CommentsError>>,
}

#[derive(Debug, Deserialize)]
struct CommentsData {
    repository: Option<CommentsRepository>,
}

#[derive(Debug, Deserialize)]
struct CommentsRepository {
    #[serde(rename = "pullRequests")]
    pull_requests: PullRequestConnection,
}

#[derive(Debug, Deserialize)]
struct PullRequestConnection {
    nodes: Vec<PullRequestCommentsNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestCommentsNode {
    is_cross_repository: bool,
    comments: CommentConnection,
    reviews: ReviewConnection,
}

#[derive(Debug, Deserialize)]
struct CommentConnection {
    nodes: Vec<CommentNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentNode {
    id: String,
    url: String,
    created_at: String,
    body: String,
    author: Option<AuthorNode>,
}

#[derive(Debug, Deserialize)]
struct ReviewConnection {
    nodes: Vec<ReviewNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewNode {
    id: String,
    url: String,
    state: String,
    submitted_at: Option<String>,
    created_at: String,
    body: String,
    author: Option<AuthorNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorNode {
    login: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CommentsError {
    message: String,
}

/// Fetch the issue comments + review summaries for the workspace's
/// in-repo PR. Newest-first. Empty when no PR is found / no token.
pub(super) fn fetch_pr_comments(context: &GithubContext) -> Result<Vec<PrCommentInfo>> {
    let parsed: CommentsEnvelope = match run_graphql(
        &context.login,
        PR_COMMENTS_QUERY,
        &[
            ("owner", context.owner.as_str()),
            ("name", context.name.as_str()),
            ("head", context.branch.as_str()),
        ],
    )? {
        GraphqlOutcome::Auth => return Ok(Vec::new()),
        GraphqlOutcome::Ok(value) => value,
    };

    if let Some(errors) = parsed.errors.as_ref() {
        if !errors.is_empty() {
            // Repo-not-accessible degrades to empty list rather than an
            // error so the inspector can keep painting the rest of the
            // Review tab.
            let benign = errors.iter().any(|e| {
                e.message.contains("Could not resolve to a Repository")
                    || e.message.contains("NOT_FOUND")
            });
            if benign {
                return Ok(Vec::new());
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

    let Some(repo) = parsed.data.and_then(|d| d.repository) else {
        return Ok(Vec::new());
    };
    // `headRefName:` matches across forks; drop cross-repo PRs to mirror
    // `pull_request::pick_in_repo_pr`.
    let Some(node) = repo
        .pull_requests
        .nodes
        .into_iter()
        .find(|n| !n.is_cross_repository)
    else {
        return Ok(Vec::new());
    };

    let mut entries: Vec<PrCommentInfo> = Vec::new();
    for c in node.comments.nodes {
        entries.push(PrCommentInfo {
            id: c.id,
            kind: PrCommentKind::Issue,
            author_login: c
                .author
                .as_ref()
                .and_then(|a| a.login.clone())
                .unwrap_or_else(|| "ghost".to_string()),
            author_avatar_url: c.author.and_then(|a| a.avatar_url),
            body: c.body,
            created_at: c.created_at,
            url: c.url,
            review_state: None,
        });
    }
    for r in node.reviews.nodes {
        // GitHub returns PENDING review drafts via the API even though
        // they're invisible to other users. Skip them — the workspace
        // owner sees their own draft locally and we don't want to leak
        // them into the timeline.
        if r.state == "PENDING" {
            continue;
        }
        entries.push(PrCommentInfo {
            id: r.id,
            kind: PrCommentKind::Review,
            author_login: r
                .author
                .as_ref()
                .and_then(|a| a.login.clone())
                .unwrap_or_else(|| "ghost".to_string()),
            author_avatar_url: r.author.and_then(|a| a.avatar_url),
            body: r.body,
            created_at: r.submitted_at.unwrap_or(r.created_at),
            url: r.url,
            review_state: Some(r.state),
        });
    }

    // Newest-first. The sidebar's purpose is "what's new since I last
    // looked," not chronological read-through.
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(entries)
}
