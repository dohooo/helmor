//! In-app feedback + "Quick fix" contribution flow.
//!
//! This module backs the Feedback button next to Settings:
//!   - `github_rest::fork_helmor_upstream` — POST /repos/{owner}/{repo}/forks
//!   - `github_rest::create_helmor_issue`  — POST /repos/{owner}/{repo}/issues
//!   - `find_existing_helmor_workspace`    — look for a local workspace already
//!     pointing at the helmor upstream (or a user fork of it), so the wizard
//!     can skip the fork + clone steps on second use.
//!
//! The upstream repo is hard-coded: users do not need to configure anything.

use anyhow::Result;
use serde::Serialize;

use crate::{github::graphql::parse_github_remote, models::workspaces as workspace_models};

pub mod github_rest;

/// GitHub login (owner) of the Helmor upstream repository.
pub const HELMOR_UPSTREAM_OWNER: &str = "Dohoo";
/// Repository name of the Helmor upstream.
pub const HELMOR_UPSTREAM_REPO: &str = "helmor";

/// A local workspace already pointing at the helmor repo (upstream or fork).
///
/// Returned to the frontend so the feedback wizard can skip the fork + clone
/// steps on repeat use. The repo id is the key: the wizard uses it to open a
/// fresh workspace on the same repo (new branch) for a new quick-fix.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingHelmorWorkspace {
    pub workspace_id: String,
    pub repo_id: String,
    pub repo_name: String,
    pub branch: Option<String>,
}

/// Returns `true` when a git remote URL points at the helmor upstream, or at
/// a fork whose repo name matches helmor (case-insensitive).
///
/// We match on the repo name rather than the owner so a user who has forked
/// `Dohoo/helmor` to `their-login/helmor` is recognised as "already set up".
/// A renamed fork (`fork-user/helmor-plus`) is deliberately NOT matched —
/// those users don't need this wizard.
pub(crate) fn matches_helmor_remote(remote_url: &str) -> bool {
    let Some((_, name)) = parse_github_remote(remote_url) else {
        return false;
    };
    name.eq_ignore_ascii_case(HELMOR_UPSTREAM_REPO)
}

/// Find the most-recently-created local workspace that points at the helmor
/// repo. `load_workspace_records` already orders by `created_at DESC`, so we
/// simply return the first match. Zero network calls.
pub fn find_existing_helmor_workspace() -> Result<Option<ExistingHelmorWorkspace>> {
    let records = workspace_models::load_workspace_records()?;
    for record in records {
        let Some(remote_url) = record.remote_url.as_deref() else {
            continue;
        };
        if matches_helmor_remote(remote_url) {
            return Ok(Some(ExistingHelmorWorkspace {
                workspace_id: record.id,
                repo_id: record.repo_id,
                repo_name: record.repo_name,
                branch: record.branch,
            }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_upstream_https() {
        assert!(matches_helmor_remote("https://github.com/Dohoo/helmor.git"));
        assert!(matches_helmor_remote("https://github.com/Dohoo/helmor"));
    }

    #[test]
    fn matches_upstream_ssh() {
        assert!(matches_helmor_remote("git@github.com:Dohoo/helmor.git"));
    }

    #[test]
    fn matches_user_fork() {
        assert!(matches_helmor_remote(
            "https://github.com/some-user/helmor.git"
        ));
    }

    #[test]
    fn matches_case_insensitive_repo_name() {
        assert!(matches_helmor_remote("https://github.com/Fork/Helmor.git"));
        assert!(matches_helmor_remote("https://github.com/Fork/HELMOR"));
    }

    #[test]
    fn rejects_renamed_fork() {
        assert!(!matches_helmor_remote(
            "https://github.com/fork-user/helmor-plus.git"
        ));
        assert!(!matches_helmor_remote(
            "https://github.com/fork-user/my-helmor.git"
        ));
    }

    #[test]
    fn rejects_non_github_remote() {
        assert!(!matches_helmor_remote("https://gitlab.com/foo/helmor.git"));
        assert!(!matches_helmor_remote(""));
        assert!(!matches_helmor_remote("not-a-url"));
    }
}
