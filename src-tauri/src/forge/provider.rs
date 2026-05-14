use anyhow::{bail, Result};

use crate::forge::{github, gitlab};

use super::inbox::{
    ForgeLabelOption, InboxFilters, InboxItemDetail, InboxKind, InboxKindLabels, InboxPage,
    InboxSource, InboxToggles,
};
use super::types::{ChangeRequestInfo, ForgeActionStatus, ForgeProvider};

/// Per-provider backend for workspace-scoped + account-scoped forge ops.
/// Capability gaps (e.g. GitLab has no Discussions) are encoded by
/// omitting the kind from `inbox_kind_labels()`; reaching the
/// corresponding trait method is a router bug.
pub(crate) trait WorkspaceForgeBackend {
    // Workspace-scoped
    fn lookup_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>>;
    fn action_status(&self, workspace_id: &str) -> Result<ForgeActionStatus>;
    fn check_insert_text(&self, workspace_id: &str, item_id: &str) -> Result<String>;
    fn merge_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>>;
    fn close_change_request(&self, workspace_id: &str) -> Result<Option<ChangeRequestInfo>>;

    // Account-scoped (inbox / Add-Context)

    /// Inbox kinds this forge produces, paired with their labels. The
    /// frontend reads copy from this list — never branches on provider
    /// for "PR" vs "MR" etc. An omitted kind (e.g. GitLab Discussions)
    /// = not supported.
    fn inbox_kind_labels(&self) -> Vec<InboxKindLabels>;

    /// `host` targets the API host (critical for self-hosted GitLab).
    /// `None` falls back to deriving from `login` (global feed case).
    fn list_inbox_issues(
        &self,
        login: &str,
        host: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        repo_filter: Option<&str>,
        filters: Option<InboxFilters>,
    ) -> Result<InboxPage>;

    fn list_inbox_prs(
        &self,
        login: &str,
        host: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        repo_filter: Option<&str>,
        filters: Option<InboxFilters>,
    ) -> Result<InboxPage>;

    /// GitLab impl `bail!`s — no equivalent feature. Frontend gates
    /// this kind out via `inbox_kind_labels()`.
    fn list_inbox_discussions(
        &self,
        login: &str,
        host: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        repo_filter: Option<&str>,
        filters: Option<InboxFilters>,
    ) -> Result<InboxPage>;

    /// Backends `unreachable!` on sources that aren't theirs.
    fn get_inbox_item_detail(
        &self,
        login: &str,
        host: Option<&str>,
        source: InboxSource,
        external_id: &str,
    ) -> Result<Option<InboxItemDetail>>;

    /// Union of labels across `repos`. `host` is required for GitLab.
    fn list_repo_labels(
        &self,
        login: &str,
        host: Option<&str>,
        repos: &[String],
    ) -> Result<Vec<ForgeLabelOption>>;
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

    fn inbox_kind_labels(&self) -> Vec<InboxKindLabels> {
        vec![
            InboxKindLabels {
                kind: InboxKind::Issues,
                short: "Issues".to_string(),
                plural: "Issues".to_string(),
                singular: "issue".to_string(),
            },
            InboxKindLabels {
                kind: InboxKind::Prs,
                short: "PRs".to_string(),
                plural: "Pull requests".to_string(),
                singular: "pull request".to_string(),
            },
            InboxKindLabels {
                kind: InboxKind::Discussions,
                short: "Discussions".to_string(),
                plural: "Discussions".to_string(),
                singular: "discussion".to_string(),
            },
        ]
    }

    fn list_inbox_issues(
        &self,
        login: &str,
        _host: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        repo_filter: Option<&str>,
        filters: Option<InboxFilters>,
    ) -> Result<InboxPage> {
        // GitHub: `gh` is hard-coded to `github.com` (GitHub Enterprise
        // multi-host isn't wired up yet), so `host` is informational
        // only. When GHE support lands, plumb it through.
        let toggles = InboxToggles {
            issues: true,
            prs: false,
            discussions: false,
        };
        github::inbox::list_inbox_items(login, toggles, cursor, limit, repo_filter, filters)
    }

    fn list_inbox_prs(
        &self,
        login: &str,
        _host: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        repo_filter: Option<&str>,
        filters: Option<InboxFilters>,
    ) -> Result<InboxPage> {
        let toggles = InboxToggles {
            issues: false,
            prs: true,
            discussions: false,
        };
        github::inbox::list_inbox_items(login, toggles, cursor, limit, repo_filter, filters)
    }

    fn list_inbox_discussions(
        &self,
        login: &str,
        _host: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        repo_filter: Option<&str>,
        filters: Option<InboxFilters>,
    ) -> Result<InboxPage> {
        let toggles = InboxToggles {
            issues: false,
            prs: false,
            discussions: true,
        };
        github::inbox::list_inbox_items(login, toggles, cursor, limit, repo_filter, filters)
    }

    fn get_inbox_item_detail(
        &self,
        login: &str,
        _host: Option<&str>,
        source: InboxSource,
        external_id: &str,
    ) -> Result<Option<InboxItemDetail>> {
        github::inbox::get_inbox_item_detail(login, source, external_id)
    }

    fn list_repo_labels(
        &self,
        login: &str,
        _host: Option<&str>,
        repos: &[String],
    ) -> Result<Vec<ForgeLabelOption>> {
        // GitHub host is pinned to github.com today (see comment on
        // `list_inbox_issues`); plumb through when GHE lands.
        github::inbox::list_repo_labels(login, repos)
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

    fn inbox_kind_labels(&self) -> Vec<InboxKindLabels> {
        // GitLab has no Discussions equivalent. Omitting it from this
        // list is the contract that tells the frontend "don't render
        // a Discussions sub-tab"; omitting it is also why
        // `list_inbox_discussions` below can `unimplemented!()`
        // without callers ever tripping it.
        vec![
            InboxKindLabels {
                kind: InboxKind::Issues,
                short: "Issues".to_string(),
                plural: "Issues".to_string(),
                singular: "issue".to_string(),
            },
            InboxKindLabels {
                kind: InboxKind::Prs,
                short: "MRs".to_string(),
                plural: "Merge requests".to_string(),
                singular: "merge request".to_string(),
            },
        ]
    }

    fn list_inbox_issues(
        &self,
        login: &str,
        host: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        repo_filter: Option<&str>,
        filters: Option<InboxFilters>,
    ) -> Result<InboxPage> {
        let toggles = InboxToggles {
            issues: true,
            prs: false,
            discussions: false,
        };
        gitlab::inbox::list_inbox_items(login, host, toggles, cursor, limit, repo_filter, filters)
    }

    fn list_inbox_prs(
        &self,
        login: &str,
        host: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        repo_filter: Option<&str>,
        filters: Option<InboxFilters>,
    ) -> Result<InboxPage> {
        let toggles = InboxToggles {
            issues: false,
            prs: true,
            discussions: false,
        };
        gitlab::inbox::list_inbox_items(login, host, toggles, cursor, limit, repo_filter, filters)
    }

    /// GitLab has no Discussions equivalent. Frontend gates Discussions
    /// out via `inbox_kind_labels()`; reaching here is a router bug.
    /// `bail!` rather than `unimplemented!` so the error surfaces
    /// cleanly through `tokio::spawn_blocking` instead of as a generic
    /// "panicked" message.
    fn list_inbox_discussions(
        &self,
        _login: &str,
        _host: Option<&str>,
        _cursor: Option<&str>,
        _limit: usize,
        _repo_filter: Option<&str>,
        _filters: Option<InboxFilters>,
    ) -> Result<InboxPage> {
        bail!("GitLab does not support Discussions; this is a router bug")
    }

    fn get_inbox_item_detail(
        &self,
        login: &str,
        host: Option<&str>,
        source: InboxSource,
        external_id: &str,
    ) -> Result<Option<InboxItemDetail>> {
        gitlab::inbox::get_inbox_item_detail(login, host, source, external_id)
    }

    fn list_repo_labels(
        &self,
        login: &str,
        host: Option<&str>,
        repos: &[String],
    ) -> Result<Vec<ForgeLabelOption>> {
        // GitLab needs an explicit host — login alone can't tell us
        // which instance the project lives on (the user's login may be
        // bound to a different GitLab than the project itself).
        let Some(host) = host else {
            return Ok(Vec::new());
        };
        gitlab::inbox::list_repo_labels(host, login, repos)
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
