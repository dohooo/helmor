use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GiteaUser {
    pub(super) login: Option<String>,
    pub(super) user_name: Option<String>,
    pub(super) full_name: Option<String>,
    pub(super) avatar_url: Option<String>,
    pub(super) email: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GiteaBranchRef {
    #[serde(rename = "ref")]
    pub(super) branch_ref: Option<String>,
    pub(super) sha: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GiteaPullRequest {
    pub(super) number: i64,
    pub(super) title: String,
    pub(super) body: Option<String>,
    pub(super) state: String,
    pub(super) html_url: String,
    pub(super) draft: Option<bool>,
    pub(super) merged: Option<bool>,
    pub(super) created_at: Option<String>,
    pub(super) updated_at: Option<String>,
    pub(super) user: Option<GiteaUser>,
    pub(super) head: Option<GiteaBranchRef>,
    pub(super) base: Option<GiteaBranchRef>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GiteaPullRequestMergeability {
    pub(super) mergeable: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GiteaLabel {
    pub(super) name: String,
    pub(super) color: Option<String>,
    pub(super) description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GiteaIssue {
    pub(super) number: i64,
    pub(super) title: String,
    pub(super) body: Option<String>,
    pub(super) state: String,
    pub(super) html_url: String,
    pub(super) created_at: Option<String>,
    pub(super) updated_at: Option<String>,
    pub(super) closed_at: Option<String>,
    pub(super) user: Option<GiteaUser>,
    pub(super) pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GiteaWorkflowRunsResponse {
    pub(super) workflow_runs: Vec<GiteaWorkflowRun>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GiteaWorkflowRun {
    pub(super) id: i64,
    pub(super) display_title: Option<String>,
    pub(super) html_url: Option<String>,
    pub(super) status: Option<String>,
    pub(super) conclusion: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GiteaCommitStatus {
    pub(super) id: i64,
    pub(super) context: Option<String>,
    pub(super) description: Option<String>,
    pub(super) status: String,
    pub(super) target_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GiteaCombinedStatus {
    pub(super) statuses: Option<Vec<GiteaCommitStatus>>,
}
