//! Serde DTOs mapping GitLab REST responses (via `glab api …`) into Rust.
//!
//! Kept field-for-field close to the REST payload — transformations into
//! Helmor's neutral `ChangeRequestInfo` / `ForgeActionItem` shapes
//! live in the sibling modules (`merge_request`, `pipeline`, `review`).

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GitlabMergeRequest {
    pub(super) iid: i64,
    pub(super) title: String,
    pub(super) state: String,
    pub(super) web_url: String,
    pub(super) merged_at: Option<String>,
    pub(super) merge_status: Option<String>,
    pub(super) detailed_merge_status: Option<String>,
    pub(super) has_conflicts: Option<bool>,
    pub(super) head_pipeline: Option<GitlabPipeline>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GitlabPipeline {
    pub(super) id: Option<i64>,
    pub(super) status: Option<String>,
    pub(super) web_url: Option<String>,
    pub(super) duration: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GitlabJob {
    pub(super) id: i64,
    pub(super) name: String,
    pub(super) status: String,
    pub(super) web_url: Option<String>,
    pub(super) duration: Option<f64>,
    pub(super) started_at: Option<String>,
    pub(super) finished_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GitlabApprovals {
    pub(super) approvals_required: Option<i64>,
    pub(super) approvals_left: Option<i64>,
    pub(super) approved_by: Option<Vec<GitlabApprovedBy>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GitlabApprovedBy {}
