//! Detail payloads returned by `forge::gitlab::inbox::get_inbox_item_detail`.
//! Pulled into `forge::inbox` to participate in the cross-provider
//! `InboxItemDetail` enum.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabIssueDetail {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub state: String,
    pub author_login: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub closed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabMergeRequestDetail {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub state: String,
    pub merged: bool,
    pub draft: bool,
    pub author_login: Option<String>,
    pub source_branch: Option<String>,
    pub target_branch: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}
