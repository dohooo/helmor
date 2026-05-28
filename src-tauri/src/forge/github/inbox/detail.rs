//! Detail payloads returned by `forge::github::inbox::get_inbox_item_detail`.
//! Pulled into `forge::inbox` to participate in the cross-provider
//! `InboxItemDetail` enum.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueDetail {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub state: String,
    pub state_reason: Option<String>,
    pub author_login: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub closed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullRequestDetail {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub state: String,
    pub merged: bool,
    pub draft: bool,
    pub author_login: Option<String>,
    pub base_ref_name: Option<String>,
    pub head_ref_name: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDiscussionDetail {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub answered: Option<bool>,
    pub author_login: Option<String>,
    pub category_name: Option<String>,
    pub category_emoji: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}
