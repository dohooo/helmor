//! Shared GitHub PR selection rules. GitHub's `headRefName` filter is
//! branch-name only, so cross-repository PRs must also match the repo's
//! bound forge account to avoid unrelated fork PRs on common branch names.

use super::types::HeadRepositoryOwner;

pub(super) fn matches_workspace_pr(
    is_cross_repository: bool,
    head_repository_owner: Option<&HeadRepositoryOwner>,
    bound_login: &str,
) -> bool {
    if !is_cross_repository {
        return true;
    }

    head_repository_owner
        .map(|owner| owner.login.eq_ignore_ascii_case(bound_login))
        .unwrap_or(false)
}
