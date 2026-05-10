//! Provider-agnostic inbox types.
//!
//! Both GitHub and GitLab back-ends produce items that match the
//! [`InboxItem`] shape. Provider-specific filter knobs (scope qualifiers,
//! draft toggles, …) live in `forge::github::inbox` and
//! `forge::gitlab::inbox`; this module hosts only the cross-provider
//! contract that the Tauri command + frontend talk to.

use serde::{Deserialize, Serialize};

use super::github::inbox::detail::{
    GithubDiscussionDetail, GithubIssueDetail, GithubPullRequestDetail,
};
use super::gitlab::inbox::detail::{GitlabIssueDetail, GitlabMergeRequestDetail};

/// Per-kind toggle the user picks in Settings → Inbox. Each forge maps
/// the kinds onto its own concrete sources (`GithubIssue` ↔ `Issue`,
/// `GithubPr` ↔ `MergeRequest`, etc.). `discussions` is GitHub-only —
/// the GitLab backend ignores it.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxToggles {
    pub issues: bool,
    pub prs: bool,
    pub discussions: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxFilters {
    pub query: Option<String>,
    pub state: Option<InboxStateFilter>,
    pub scope: Option<Vec<InboxScopeFilter>>,
    pub sort: Option<InboxSortFilter>,
    pub draft: Option<InboxDraftFilter>,
    pub labels: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxStateFilter {
    Open,
    Closed,
    Merged,
    All,
    Answered,
    Unanswered,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Ord, PartialOrd, Hash)]
#[serde(rename_all = "camelCase")]
pub enum InboxScopeFilter {
    Involves,
    Assigned,
    Mentioned,
    Created,
    Author,
    Assignee,
    Mentions,
    ReviewRequested,
    ReviewedBy,
    All,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxSortFilter {
    Updated,
    Created,
    Comments,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxDraftFilter {
    Exclude,
    Include,
    Only,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPage {
    pub items: Vec<InboxItem>,
    /// Opaque cursor — null when no more items in any source. Pass back
    /// verbatim to fetch the next page.
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    /// Stable, source-prefixed key safe to use as React key + chip key.
    pub id: String,
    pub source: InboxSource,
    pub external_id: String,
    pub external_url: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub state: Option<InboxState>,
    /// Unix milliseconds — already converted from ISO 8601 in the
    /// adapter so the frontend's "Xh ago" formatter works directly.
    pub last_activity_at: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InboxSource {
    GithubIssue,
    GithubPr,
    GithubDiscussion,
    GitlabIssue,
    GitlabMr,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxState {
    pub label: String,
    pub tone: InboxStateTone,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxStateTone {
    Open,
    Closed,
    Merged,
    Draft,
    Answered,
    Unanswered,
    Urgent,
    Neutral,
}

/// The high-level kind of inbox item (issue / pull-or-merge request /
/// discussion). Both forges map this to their concrete sources via
/// their own `InboxToggles`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InboxKind {
    Issues,
    Prs,
    Discussions,
}

/// One repository label as exposed by the forge's labels API. Both
/// GitHub (`/repos/.../labels`) and GitLab (`/projects/.../labels`)
/// return the same `(name, color, description)` shape, so this is
/// shared.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeLabelOption {
    pub name: String,
    pub color: Option<String>,
    pub description: Option<String>,
}

/// Per-forge labels for one inbox kind. **Single source of truth for
/// every PR-vs-MR copy difference** — the frontend renders these
/// directly and never branches on provider for naming. Presence of an
/// entry also gates whether that sub-tab renders at all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxKindLabels {
    pub kind: InboxKind,
    /// Sub-tab dropdown label, e.g. "Issues" / "PRs" / "MRs".
    pub short: String,
    /// Title-cased plural for empty states / section headers,
    /// e.g. "Pull requests" / "Merge requests".
    pub plural: String,
    /// Lowercase singular for inline mentions, e.g. "pull request" /
    /// "merge request".
    pub singular: String,
}

/// Cross-provider detail union. Each variant is boxed so the enum
/// stays small even as backends grow richer payloads.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum InboxItemDetail {
    GithubIssue(Box<GithubIssueDetail>),
    GithubPr(Box<GithubPullRequestDetail>),
    GithubDiscussion(Box<GithubDiscussionDetail>),
    GitlabIssue(Box<GitlabIssueDetail>),
    GitlabMr(Box<GitlabMergeRequestDetail>),
}
