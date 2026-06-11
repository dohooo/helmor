//! Resolves the per-workspace preconditions every GitHub call needs:
//! workspace row, owner+repo from the remote URL, the PR head branch,
//! the bound forge account login, and whether the local branch has a
//! remote-tracking ref. Higher-level entry points (`mod.rs`,
//! `pull_request`, `actions`) consume a `GithubContext` instead of
//! re-deriving these values four times.

use anyhow::{bail, Result};

use crate::{models::workspaces as workspace_models, workspace_state::WorkspaceState};

use super::api::parse_github_remote;
use crate::forge::branch::{forge_head_branch_for, ForgeHeadRef};

/// Snapshot of every value the GitHub backend needs once we've decided
/// the workspace looks viable enough to query. The pre-flight in
/// `mod.rs` builds one of these and hands it to per-operation helpers.
#[derive(Debug, Clone)]
pub(super) struct GithubContext {
    pub owner: String,
    pub name: String,
    /// Branch name to pass as GitHub's `headRefName`. If the local
    /// branch tracks a differently named remote branch, this is the
    /// upstream branch name rather than the local branch name.
    pub branch: String,
    /// gh account login bound to this repo. Always non-empty (NULL
    /// rows short-circuit before a context is ever produced).
    pub login: String,
    /// `true` when the workspace's branch is published on the remote — a
    /// queryable ref exists, via the local remote-tracking ref or an
    /// `ls-remote` fallback. Drives the "branch never published"
    /// short-circuit. (See `forge::branch::ForgeHeadRef::published`.)
    pub published: bool,
}

/// Outcome of pre-flight resolution. Each non-`Ready` arm tells the
/// caller exactly why the workspace can't reach a GitHub call, so the
/// caller can map that to the right `ForgeActionStatus` shape /
/// `Option<ChangeRequestInfo>` shape without sprinkling early-returns
/// through every entry point.
pub(super) enum GithubResolution {
    /// All preconditions satisfied — proceed with API calls.
    Ready(GithubContext),
    /// Workspace is in `Initializing` (Phase 1, before the worktree is
    /// checked out). No PR can possibly exist yet.
    Initializing,
    /// Repo doesn't have a github.com remote / branch / etc. Caller
    /// surfaces an "unavailable" status.
    Unavailable(&'static str),
    /// `repos.forge_login` is NULL or no longer present in
    /// `gh auth status` (account logged out). Caller surfaces
    /// "unauthenticated" so the inspector swaps to Connect.
    Unauthenticated,
}

/// Resolve owner/repo, PR head branch, bound login, and remote-tracking
/// state. NULL/blank `forge_login` → `Unauthenticated`. No auth probe:
/// logout surfaces lazily (API 401 / create-PR check).
pub(super) fn load_github_context(workspace_id: &str) -> Result<GithubResolution> {
    let Some(record) = workspace_models::load_workspace_record_by_id(workspace_id)? else {
        bail!("Workspace not found: {workspace_id}");
    };

    if record.state == WorkspaceState::Initializing {
        return Ok(GithubResolution::Initializing);
    }

    let Some(remote_url) = record.remote_url.as_deref() else {
        return Ok(GithubResolution::Unavailable("Workspace has no remote"));
    };
    let Some((owner, name)) = parse_github_remote(remote_url) else {
        return Ok(GithubResolution::Unavailable(
            "Workspace remote is not a GitHub repository",
        ));
    };
    let Some(branch) = record
        .branch
        .as_deref()
        .filter(|b| !b.is_empty())
        .map(ToOwned::to_owned)
    else {
        return Ok(GithubResolution::Unavailable(
            "Workspace has no current branch",
        ));
    };

    // NULL/blank binding → Connect CTA. A bound-but-logged-out account is
    // not probed here; it surfaces lazily (API 401 / create-PR check).
    let persisted_login = record
        .forge_login
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(login) = persisted_login else {
        return Ok(GithubResolution::Unauthenticated);
    };

    let ForgeHeadRef { branch, published } = forge_head_branch_for(&record, &branch);

    Ok(GithubResolution::Ready(GithubContext {
        owner,
        name,
        branch,
        login: login.to_string(),
        published,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ops;
    use rusqlite::Connection;

    /// Insert a repo row with the given remote URL + optional forge_login
    /// binding. Bypasses `testkit::insert_repo` so we can populate the
    /// extra columns the resolver inspects (remote_url, forge_login,
    /// forge_provider).
    fn insert_repo(
        conn: &Connection,
        id: &str,
        name: &str,
        remote_url: Option<&str>,
        forge_login: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO repos (id, name, default_branch, remote, remote_url, \
             forge_provider, forge_login) \
             VALUES (?1, ?2, 'main', 'origin', ?3, 'github', ?4)",
            rusqlite::params![id, name, remote_url, forge_login],
        )
        .unwrap();
    }

    /// Insert a workspace row with explicit state + branch.
    fn insert_workspace(
        conn: &Connection,
        id: &str,
        repo_id: &str,
        state: &str,
        branch: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state, \
             status, branch, intended_target_branch, display_order) \
             VALUES (?1, ?2, 'workspace-dir', ?3, 'in-progress', ?4, 'main', ?5)",
            rusqlite::params![
                id,
                repo_id,
                state,
                branch,
                crate::workspace::sidebar_order::ORDER_STEP
            ],
        )
        .unwrap();
    }

    #[test]
    fn returns_initializing_when_workspace_state_is_initializing() {
        let env = crate::testkit::TestEnv::new("github-ctx-initializing");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-1",
            "Repo",
            Some("git@github.com:octocat/hello-world.git"),
            Some("octocat"),
        );
        insert_workspace(&conn, "w-1", "r-1", "initializing", Some("feature"));
        drop(conn);

        let resolution = load_github_context("w-1").unwrap();
        assert!(matches!(resolution, GithubResolution::Initializing));
    }

    #[test]
    fn returns_unavailable_when_remote_url_is_missing() {
        let env = crate::testkit::TestEnv::new("github-ctx-no-remote");
        let conn = env.db_connection();
        insert_repo(&conn, "r-2", "Repo", None, Some("octocat"));
        insert_workspace(&conn, "w-2", "r-2", "ready", Some("feature"));
        drop(conn);

        let resolution = load_github_context("w-2").unwrap();
        assert!(matches!(
            resolution,
            GithubResolution::Unavailable("Workspace has no remote")
        ));
    }

    #[test]
    fn returns_unavailable_when_remote_is_not_github() {
        let env = crate::testkit::TestEnv::new("github-ctx-non-github");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-3",
            "Repo",
            Some("https://gitlab.com/foo/bar.git"),
            Some("octocat"),
        );
        insert_workspace(&conn, "w-3", "r-3", "ready", Some("feature"));
        drop(conn);

        let resolution = load_github_context("w-3").unwrap();
        assert!(matches!(
            resolution,
            GithubResolution::Unavailable("Workspace remote is not a GitHub repository")
        ));
    }

    #[test]
    fn returns_unavailable_when_branch_is_missing() {
        let env = crate::testkit::TestEnv::new("github-ctx-no-branch");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-4",
            "Repo",
            Some("git@github.com:octocat/hello-world.git"),
            Some("octocat"),
        );
        insert_workspace(&conn, "w-4", "r-4", "ready", None);
        drop(conn);

        let resolution = load_github_context("w-4").unwrap();
        assert!(matches!(
            resolution,
            GithubResolution::Unavailable("Workspace has no current branch")
        ));
    }

    #[test]
    fn returns_unauthenticated_when_forge_login_is_null() {
        let env = crate::testkit::TestEnv::new("github-ctx-null-login");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-5",
            "Repo",
            Some("git@github.com:octocat/hello-world.git"),
            None,
        );
        insert_workspace(&conn, "w-5", "r-5", "ready", Some("feature"));
        drop(conn);

        let resolution = load_github_context("w-5").unwrap();
        assert!(matches!(resolution, GithubResolution::Unauthenticated));
    }

    /// Whitespace-only forge_login is the same as null — the resolver
    /// trims + filter-empties before deciding the binding is intact.
    #[test]
    fn returns_unauthenticated_when_forge_login_is_whitespace_only() {
        let env = crate::testkit::TestEnv::new("github-ctx-blank-login");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-6",
            "Repo",
            Some("git@github.com:octocat/hello-world.git"),
            Some("   "),
        );
        insert_workspace(&conn, "w-6", "r-6", "ready", Some("feature"));
        drop(conn);

        let resolution = load_github_context("w-6").unwrap();
        assert!(matches!(resolution, GithubResolution::Unauthenticated));
    }

    #[test]
    fn returns_ready_with_parsed_owner_repo_branch_when_preconditions_satisfied() {
        let env = crate::testkit::TestEnv::new("github-ctx-ready");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-8",
            "Repo",
            Some("git@github.com:octocat/hello-world.git"),
            Some("octocat"),
        );
        insert_workspace(&conn, "w-8", "r-8", "ready", Some("feature/auth"));
        drop(conn);

        let resolution = load_github_context("w-8").unwrap();
        let GithubResolution::Ready(ctx) = resolution else {
            panic!("expected Ready, got something else");
        };
        assert_eq!(ctx.owner, "octocat");
        assert_eq!(ctx.name, "hello-world");
        assert_eq!(ctx.branch, "feature/auth");
        assert_eq!(ctx.login, "octocat");
        // No worktree on disk → branch not published. Real workspaces
        // populate this via git, but the resolver still hands a Ready
        // context back so the caller can decide whether to short-circuit
        // on `published`.
        assert!(!ctx.published);
    }

    #[test]
    fn uses_upstream_branch_name_when_local_branch_was_renamed() {
        let env = crate::testkit::TestEnv::new("github-ctx-renamed-local-branch");
        let origin = crate::testkit::GitTestRepo::init();
        let workspace_dir = crate::data_dir::workspace_dir("Repo", "workspace-dir").unwrap();
        std::fs::create_dir_all(workspace_dir.parent().unwrap()).unwrap();
        git_ops::run_git(
            [
                "clone",
                &origin.path().display().to_string(),
                &workspace_dir.display().to_string(),
            ],
            None,
        )
        .unwrap();
        git_ops::run_git(
            ["config", "user.email", "helmor@example.com"],
            Some(&workspace_dir),
        )
        .unwrap();
        git_ops::run_git(["config", "user.name", "Helmor Test"], Some(&workspace_dir)).unwrap();
        git_ops::run_git(
            ["checkout", "-b", "feature/local-name"],
            Some(&workspace_dir),
        )
        .unwrap();
        git_ops::run_git(
            [
                "push",
                "--set-upstream",
                "origin",
                "HEAD:refs/heads/feature/remote-name",
            ],
            Some(&workspace_dir),
        )
        .unwrap();

        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-renamed",
            "Repo",
            Some("git@github.com:octocat/hello-world.git"),
            Some("octocat"),
        );
        insert_workspace(
            &conn,
            "w-renamed",
            "r-renamed",
            "ready",
            Some("feature/local-name"),
        );
        drop(conn);

        let resolution = load_github_context("w-renamed").unwrap();
        let GithubResolution::Ready(ctx) = resolution else {
            panic!("expected Ready");
        };
        assert_eq!(ctx.branch, "feature/remote-name");
        assert!(ctx.published);
    }

    /// Branch is published on the remote, but the local worktree has neither
    /// upstream config nor a `refs/remotes/origin/<branch>` ref (e.g. a push
    /// that never updated the local ref). The remote fallback must keep
    /// `published` true so the open PR still surfaces.
    #[test]
    fn ready_with_remote_tracking_when_branch_published_but_local_ref_missing() {
        let env = crate::testkit::TestEnv::new("github-ctx-published-no-local-ref");
        let origin = crate::testkit::GitTestRepo::init();
        let workspace_dir = crate::data_dir::workspace_dir("Repo", "workspace-dir").unwrap();
        std::fs::create_dir_all(workspace_dir.parent().unwrap()).unwrap();
        git_ops::run_git(
            [
                "clone",
                &origin.path().display().to_string(),
                &workspace_dir.display().to_string(),
            ],
            None,
        )
        .unwrap();
        git_ops::run_git(
            ["config", "user.email", "helmor@example.com"],
            Some(&workspace_dir),
        )
        .unwrap();
        git_ops::run_git(["config", "user.name", "Helmor Test"], Some(&workspace_dir)).unwrap();
        git_ops::run_git(
            ["checkout", "-b", "feature/published"],
            Some(&workspace_dir),
        )
        .unwrap();
        git_ops::run_git(
            ["push", "origin", "HEAD:refs/heads/feature/published"],
            Some(&workspace_dir),
        )
        .unwrap();
        // Erase every local trace of the push so only the remote knows.
        git_ops::run_git(
            ["update-ref", "-d", "refs/remotes/origin/feature/published"],
            Some(&workspace_dir),
        )
        .unwrap();

        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-published",
            "Repo",
            Some("git@github.com:octocat/hello-world.git"),
            Some("octocat"),
        );
        insert_workspace(
            &conn,
            "w-published",
            "r-published",
            "ready",
            Some("feature/published"),
        );
        drop(conn);

        let resolution = load_github_context("w-published").unwrap();
        let GithubResolution::Ready(ctx) = resolution else {
            panic!("expected Ready");
        };
        assert_eq!(ctx.branch, "feature/published");
        assert!(
            ctx.published,
            "remote fallback should recognise the published branch",
        );
    }

    #[test]
    fn returns_ready_for_https_remote_form() {
        let env = crate::testkit::TestEnv::new("github-ctx-https");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-9",
            "Repo",
            Some("https://github.com/octocat/hello-world.git"),
            Some("octocat"),
        );
        insert_workspace(&conn, "w-9", "r-9", "ready", Some("main"));
        drop(conn);

        let resolution = load_github_context("w-9").unwrap();
        let GithubResolution::Ready(ctx) = resolution else {
            panic!("expected Ready");
        };
        assert_eq!(ctx.owner, "octocat");
        assert_eq!(ctx.name, "hello-world");
    }

    /// The resolver bails when no workspace row matches — we want a
    /// distinct error here (not a silent `Unavailable`) so callers
    /// surface the bug.
    #[test]
    fn errors_when_workspace_does_not_exist() {
        let _env = crate::testkit::TestEnv::new("github-ctx-missing");
        let result = load_github_context("does-not-exist");
        assert!(result.is_err());
    }
}
