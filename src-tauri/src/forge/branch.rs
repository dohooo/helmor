//! Shared helpers for resolving the branch name a forge API should query
//! against. Both `forge::github::context` and `forge::gitlab::context`
//! consume these so the providers stay aligned on workspaces whose local
//! branch name differs from upstream (e.g. after `git branch -m` or
//! `git push HEAD:refs/heads/<other>`).

use crate::{git_ops, models::workspaces::WorkspaceRecord};

/// Resolve the branch name to use as the forge's PR/MR head reference.
/// Returns the upstream branch name when the workspace has a
/// remote-tracking ref, otherwise falls back to the local branch name.
/// Second tuple element is `true` when a remote-tracking ref was found.
pub(in crate::forge) fn forge_head_branch_for(
    record: &WorkspaceRecord,
    local_branch: &str,
) -> (String, bool) {
    let Some(remote_tracking_ref) = workspace_remote_tracking_ref(record) else {
        return (local_branch.to_string(), false);
    };
    let head_branch = remote_tracking_branch_name(&remote_tracking_ref)
        .unwrap_or(local_branch)
        .to_string();
    (head_branch, true)
}

fn remote_tracking_branch_name(remote_tracking_ref: &str) -> Option<&str> {
    remote_tracking_ref
        .split_once('/')
        .map(|(_, branch)| branch)
        .filter(|branch| !branch.is_empty())
}

fn workspace_remote_tracking_ref(record: &WorkspaceRecord) -> Option<String> {
    let Ok(workspace_dir) = crate::workspace::helpers::workspace_path(record) else {
        return None;
    };
    if !workspace_dir.exists() {
        return None;
    }
    git_ops::resolve_remote_tracking_ref(&workspace_dir, record.remote.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_tracking_branch_name_strips_remote_prefix() {
        assert_eq!(
            remote_tracking_branch_name("origin/feature/login"),
            Some("feature/login"),
        );
    }

    #[test]
    fn remote_tracking_branch_name_returns_none_for_empty_branch() {
        assert_eq!(remote_tracking_branch_name("origin/"), None);
    }

    #[test]
    fn remote_tracking_branch_name_returns_none_when_no_slash() {
        assert_eq!(remote_tracking_branch_name("origin"), None);
    }
}
