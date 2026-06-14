//! Shared helpers for resolving the branch name a forge API should query
//! against. Both `forge::github::context` and `forge::gitlab::context`
//! consume these so the providers stay aligned on workspaces whose local
//! branch name differs from upstream (e.g. after `git branch -m` or
//! `git push HEAD:refs/heads/<other>`).

use crate::{git_ops, models::workspaces::WorkspaceRecord};

/// The branch a forge should use as its PR/MR head ref, plus whether that
/// branch is published on the remote. `published` is the canonical,
/// provider-agnostic name for this flag — both `forge::github::context` and
/// `forge::gitlab::context` store it under the same name.
pub(in crate::forge) struct ForgeHeadRef {
    /// Branch name to pass as GitHub's `headRefName` / GitLab's
    /// `source_branch`. The upstream branch name when it differs from local.
    pub branch: String,
    /// `true` when the branch has a ref the forge API can match against —
    /// resolved from the local remote-tracking ref, or (when that's missing)
    /// a remote `ls-remote` lookup.
    pub published: bool,
}

/// Resolve the forge head ref for `record`. Prefers the upstream branch name
/// when the workspace has a remote-tracking ref, otherwise falls back to the
/// local branch name.
pub(in crate::forge) fn forge_head_branch_for(
    record: &WorkspaceRecord,
    local_branch: &str,
) -> ForgeHeadRef {
    if let Some(remote_tracking_ref) = workspace_remote_tracking_ref(record) {
        let branch = remote_tracking_branch_name(&remote_tracking_ref)
            .unwrap_or(local_branch)
            .to_string();
        return ForgeHeadRef {
            branch,
            published: true,
        };
    }
    // No local remote-tracking ref — but the branch can still be published on
    // the remote (a push that never updated the local ref, a pruned ref, or a
    // PR opened by an agent before its session settled). Without this fallback
    // those workspaces false-negative forever: `published == false`
    // short-circuits PR lookup, so the open PR never surfaces. A same-named
    // push is the realistic case, so the local branch name is the head ref.
    if branch_published_on_remote(record, local_branch) {
        return ForgeHeadRef {
            branch: local_branch.to_string(),
            published: true,
        };
    }
    ForgeHeadRef {
        branch: local_branch.to_string(),
        published: false,
    }
}

/// Network fallback: does `<remote>` actually carry `<branch>`? Only reached
/// when the local worktree has no remote-tracking ref, so it costs an extra
/// `ls-remote` for genuinely-unpublished branches but recovers the published
/// ones the local refs can't see.
fn branch_published_on_remote(record: &WorkspaceRecord, branch: &str) -> bool {
    let Ok(workspace_dir) = crate::workspace::helpers::workspace_path(record) else {
        return false;
    };
    if !workspace_dir.exists() {
        return false;
    }
    let Some(remote) = record
        .remote
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    git_ops::remote_branch_exists(&workspace_dir, remote, branch)
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
