use anyhow::Result;

use crate::forge::{github, gitlab};

use super::types::{ChangeRequestInfo, ForgeActionStatus, ForgeProvider, PrCommentInfo};

pub(crate) trait WorkspaceForgeBackend {
    fn lookup_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>>;
    fn action_status(&self, workspace_id: &str) -> Result<ForgeActionStatus>;
    fn check_insert_text(&self, workspace_id: &str, item_id: &str) -> Result<String>;
    fn merge_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>>;
    fn close_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>>;
    /// Update title and/or body on the workspace's open change request.
    /// Backends that don't support this yet (GitLab) return an error.
    fn update_change_request(
        &self,
        workspace_id: &str,
        title: Option<&str>,
        body: Option<&str>,
    ) -> Result<Option<ChangeRequestInfo>>;
    /// List PR comments + review summaries. Backends that don't
    /// implement it yet (GitLab) return an empty list, so the
    /// inspector's Review sub-tab degrades to an empty state instead
    /// of erroring out.
    fn list_change_request_comments(&self, _workspace_id: &str) -> Result<Vec<PrCommentInfo>> {
        Ok(Vec::new())
    }
}

struct GithubBackend;
struct GitlabBackend;

impl WorkspaceForgeBackend for GithubBackend {
    fn lookup_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
        github::lookup_workspace_pr(workspace_id)
    }

    fn action_status(&self, workspace_id: &str) -> Result<ForgeActionStatus> {
        github::lookup_workspace_pr_action_status(workspace_id)
    }

    fn check_insert_text(&self, workspace_id: &str, item_id: &str) -> Result<String> {
        github::lookup_workspace_pr_check_insert_text(workspace_id, item_id)
    }

    fn merge_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
        github::merge_workspace_pr(workspace_id)
    }

    fn close_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
        github::close_workspace_pr(workspace_id)
    }

    fn update_change_request(
        &self,
        workspace_id: &str,
        title: Option<&str>,
        body: Option<&str>,
    ) -> Result<Option<ChangeRequestInfo>> {
        github::update_workspace_pr(workspace_id, title, body)
    }

    fn list_change_request_comments(&self, workspace_id: &str) -> Result<Vec<PrCommentInfo>> {
        github::lookup_workspace_pr_comments(workspace_id)
    }
}

impl WorkspaceForgeBackend for GitlabBackend {
    fn lookup_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
        gitlab::lookup_workspace_mr(workspace_id)
    }

    fn action_status(&self, workspace_id: &str) -> Result<ForgeActionStatus> {
        gitlab::lookup_workspace_mr_action_status(workspace_id)
    }

    fn check_insert_text(&self, workspace_id: &str, item_id: &str) -> Result<String> {
        gitlab::lookup_workspace_mr_check_insert_text(workspace_id, item_id)
    }

    fn merge_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
        gitlab::merge_workspace_mr(workspace_id)
    }

    fn close_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
        gitlab::close_workspace_mr(workspace_id)
    }

    fn update_change_request(
        &self,
        _workspace_id: &str,
        _title: Option<&str>,
        _body: Option<&str>,
    ) -> Result<Option<ChangeRequestInfo>> {
        anyhow::bail!("Editing MR title/body is not implemented for GitLab yet")
    }
}

static GITHUB_BACKEND: GithubBackend = GithubBackend;
static GITLAB_BACKEND: GitlabBackend = GitlabBackend;

pub(crate) fn backend_for(provider: ForgeProvider) -> Option<&'static dyn WorkspaceForgeBackend> {
    match provider {
        ForgeProvider::Github => Some(&GITHUB_BACKEND),
        ForgeProvider::Gitlab => Some(&GITLAB_BACKEND),
        ForgeProvider::Unknown => None,
    }
}
