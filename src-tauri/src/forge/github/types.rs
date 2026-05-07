//! Serde DTOs for the GitHub GraphQL responses + REST check-run detail
//! shape. Kept in one file so the JSON contracts the higher-level
//! modules consume live next to each other (mirrors gitlab/types.rs).

use serde::Deserialize;

// ---------- Pull-request lookup envelope (lookup_workspace_pr) ----------

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GraphqlEnvelope {
    pub data: Option<GraphqlData>,
    pub errors: Option<Vec<GraphqlError>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GraphqlData {
    pub repository: Option<Repository>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct Repository {
    #[serde(rename = "pullRequests")]
    pub pull_requests: PullRequestConnection,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct PullRequestConnection {
    pub nodes: Vec<PullRequestNode>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct PullRequestNode {
    /// GraphQL node ID (e.g. "PR_kwDO..."). Only populated when the
    /// query explicitly selects `id`; the lookup query omits it so this
    /// is `None` on the primary path.
    pub id: Option<String>,
    pub url: String,
    pub number: i64,
    pub state: String,
    pub title: String,
    pub merged: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GraphqlError {
    pub message: String,
}

// ---------- Action-status envelope (lookup_workspace_pr_action_status) ----------

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ActionGraphqlEnvelope {
    pub data: Option<ActionGraphqlData>,
    pub errors: Option<Vec<GraphqlError>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ActionGraphqlData {
    pub repository: Option<ActionRepository>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ActionRepository {
    #[serde(rename = "pullRequests")]
    pub pull_requests: ActionPullRequestConnection,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ActionPullRequestConnection {
    pub nodes: Vec<ActionPullRequestNode>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActionPullRequestNode {
    pub url: String,
    pub number: i64,
    pub state: String,
    pub title: String,
    pub merged: bool,
    pub review_decision: Option<String>,
    pub mergeable: Option<String>,
    pub commits: ActionCommitConnection,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ActionCommitConnection {
    pub nodes: Vec<ActionPullRequestCommitNode>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ActionPullRequestCommitNode {
    pub commit: ActionCommitNode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActionCommitNode {
    pub status_check_rollup: Option<ActionStatusCheckRollup>,
    pub deployments: ActionDeploymentConnection,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ActionStatusCheckRollup {
    pub contexts: ActionCheckContextConnection,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ActionCheckContextConnection {
    pub nodes: Vec<ActionCheckContextNode>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "__typename")]
pub(super) enum ActionCheckContextNode {
    CheckRun(ActionCheckRunNode),
    StatusContext(ActionStatusContextNode),
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActionCheckRunNode {
    pub database_id: Option<i64>,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub details_url: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub check_suite: Option<ActionCheckSuite>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActionCheckSuite {
    pub app: Option<ActionCheckApp>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ActionCheckApp {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActionStatusContextNode {
    pub context: String,
    pub state: String,
    pub target_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ActionDeploymentConnection {
    pub nodes: Vec<ActionDeploymentNode>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActionDeploymentNode {
    pub id: String,
    pub environment: Option<String>,
    pub latest_status: Option<ActionDeploymentStatusNode>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActionDeploymentStatusNode {
    pub state: String,
    pub log_url: Option<String>,
    pub environment_url: Option<String>,
}

// ---------- REST: GET /repos/.../check-runs/:id ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GithubCheckRunDetail {
    pub details_url: Option<String>,
    pub html_url: Option<String>,
    pub output: Option<GithubCheckRunOutput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GithubCheckRunOutput {
    pub title: Option<String>,
    pub summary: Option<String>,
    pub text: Option<String>,
}
