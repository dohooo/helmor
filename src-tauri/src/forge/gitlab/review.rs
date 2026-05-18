//! MR approvals → review decision.
//!
//! GitLab Premium ships an "Approvals" API that returns how many
//! approvals a merge request needs and how many are outstanding. We map
//! the combination to the same `APPROVED` string GitHub's GraphQL
//! `reviewDecision` field uses — that lets the inspector render a single
//! review row without caring which backend supplied it.

use anyhow::{Context, Result};

use super::api::{encode_path_component, glab_api};
use super::context::GitlabContext;
use super::types::GitlabApprovals;

pub(super) fn load_review_decision(context: &GitlabContext, mr_iid: i64) -> Result<Option<String>> {
    let endpoint = format!(
        "projects/{}/merge_requests/{mr_iid}/approvals",
        encode_path_component(&context.full_path),
    );
    let output = glab_api(&context.remote.host, [endpoint.as_str()])?;
    if !output.success {
        return Ok(None);
    }

    let approvals = serde_json::from_str::<GitlabApprovals>(&output.stdout)
        .context("Failed to decode GitLab approvals response")?;
    Ok(gitlab_review_decision(&approvals))
}

fn gitlab_review_decision(approvals: &GitlabApprovals) -> Option<String> {
    let required = approvals.approvals_required.unwrap_or(0);
    let left = approvals.approvals_left.unwrap_or(required);
    let approved_count = approvals.approved_by.as_ref().map_or(0, Vec::len);

    if required > 0 && left == 0 {
        return Some("APPROVED".to_string());
    }
    if required == 0 && approved_count > 0 {
        return Some("APPROVED".to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::super::types::GitlabApprovedBy;
    use super::*;

    #[test]
    fn maps_gitlab_required_approvals_to_approved_review_decision() {
        let approvals = GitlabApprovals {
            approvals_required: Some(2),
            approvals_left: Some(0),
            approved_by: Some(vec![GitlabApprovedBy {}, GitlabApprovedBy {}]),
        };

        assert_eq!(
            gitlab_review_decision(&approvals).as_deref(),
            Some("APPROVED")
        );
    }

    #[test]
    fn leaves_gitlab_review_pending_when_required_approvals_are_missing() {
        let approvals = GitlabApprovals {
            approvals_required: Some(2),
            approvals_left: Some(1),
            approved_by: Some(vec![GitlabApprovedBy {}]),
        };

        assert_eq!(gitlab_review_decision(&approvals), None);
    }

    #[test]
    fn treats_optional_gitlab_approval_as_approved_when_someone_approved() {
        let approvals = GitlabApprovals {
            approvals_required: Some(0),
            approvals_left: Some(0),
            approved_by: Some(vec![GitlabApprovedBy {}]),
        };

        assert_eq!(
            gitlab_review_decision(&approvals).as_deref(),
            Some("APPROVED")
        );
    }
}
