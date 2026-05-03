//! Resolves the per-workspace preconditions every GitHub call needs:
//! workspace row, owner+repo from the remote URL, the PR head branch,
//! the bound forge account login, and whether the local branch has a
//! remote-tracking ref. Higher-level entry points (`mod.rs`,
//! `pull_request`, `actions`) consume a `GithubContext` instead of
//! re-deriving these values four times.

use anyhow::{bail, Result};

use crate::{models::workspaces as workspace_models, workspace_state::WorkspaceState};

use super::api::parse_github_remote;
use crate::forge::branch::forge_head_branch_for;

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
    /// `true` when the workspace's branch has a remote-tracking ref
    /// resolvable via `git rev-parse`. Drives the
    /// "branch never published" short-circuit.
    pub has_remote_tracking: bool,
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

/// Run the pre-flight against the workspace row + gh auth state.
/// `host_authenticated` controls whether the resolver also consults
/// `gh auth status` to invalidate the binding when the bound login no
/// longer has a token. We pass `false` from internal callers that
/// already need to handle auth errors themselves (the action-status
/// path runs the probe earlier so it can mirror the GitLab flow).
pub(super) fn load_github_context(
    workspace_id: &str,
    host_authenticated: HostAuthCheck,
) -> Result<GithubResolution> {
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

    // Auth-binding check runs BEFORE the remote-tracking short-circuit
    // so an externally-logged-out account surfaces a Connect CTA even
    // on workspaces that never published their branch (mirrors the
    // GitLab pre-flight in forge::gitlab::lookup_workspace_mr_action_status).
    let persisted_login = record
        .forge_login
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(login) = persisted_login else {
        return Ok(GithubResolution::Unauthenticated);
    };
    if matches!(host_authenticated, HostAuthCheck::Probe) && login_definitely_logged_out(login) {
        return Ok(GithubResolution::Unauthenticated);
    }

    let (branch, has_remote_tracking) = forge_head_branch_for(&record, &branch);

    Ok(GithubResolution::Ready(GithubContext {
        owner,
        name,
        branch,
        login: login.to_string(),
        has_remote_tracking,
    }))
}

/// Whether the action-status pre-flight should consult `gh auth status`.
/// Lookup paths skip the probe (they tolerate an auth fall-through and
/// degrade to `None`); the action-status entry runs it because that's
/// the surface the inspector reads to decide whether to show Connect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HostAuthCheck {
    Skip,
    Probe,
}

/// Routes through `check_auth`; `Indeterminate` and `LoggedIn`
/// preserve the binding.
fn login_definitely_logged_out(login: &str) -> bool {
    let Some(backend) = crate::forge::accounts::backend_for(crate::forge::ForgeProvider::Github)
    else {
        // Backend missing (Unknown provider): preserve binding,
        // we can't probe.
        return false;
    };
    backend
        .check_auth(super::api::GITHUB_HOST, login)
        .is_definitely_logged_out()
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
             status, branch, intended_target_branch) \
             VALUES (?1, ?2, 'workspace-dir', ?3, 'in-progress', ?4, 'main')",
            rusqlite::params![id, repo_id, state, branch],
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

        let resolution = load_github_context("w-1", HostAuthCheck::Skip).unwrap();
        assert!(matches!(resolution, GithubResolution::Initializing));
    }

    #[test]
    fn returns_unavailable_when_remote_url_is_missing() {
        let env = crate::testkit::TestEnv::new("github-ctx-no-remote");
        let conn = env.db_connection();
        insert_repo(&conn, "r-2", "Repo", None, Some("octocat"));
        insert_workspace(&conn, "w-2", "r-2", "ready", Some("feature"));
        drop(conn);

        let resolution = load_github_context("w-2", HostAuthCheck::Skip).unwrap();
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

        let resolution = load_github_context("w-3", HostAuthCheck::Skip).unwrap();
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

        let resolution = load_github_context("w-4", HostAuthCheck::Skip).unwrap();
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

        let resolution = load_github_context("w-5", HostAuthCheck::Skip).unwrap();
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

        let resolution = load_github_context("w-6", HostAuthCheck::Skip).unwrap();
        assert!(matches!(resolution, GithubResolution::Unauthenticated));
    }

    /// `Probe` mode also returns `Unauthenticated` for NULL forge_login
    /// without ever calling `gh auth status` (that branch short-circuits
    /// before the probe). Critical for the inspector auth-removal
    /// fix: the probe is added work, never a regression for the
    /// already-handled NULL case.
    #[test]
    fn probe_mode_short_circuits_on_null_forge_login() {
        let env = crate::testkit::TestEnv::new("github-ctx-probe-null");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-7",
            "Repo",
            Some("git@github.com:octocat/hello-world.git"),
            None,
        );
        insert_workspace(&conn, "w-7", "r-7", "ready", Some("feature"));
        drop(conn);

        let resolution = load_github_context("w-7", HostAuthCheck::Probe).unwrap();
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

        let resolution = load_github_context("w-8", HostAuthCheck::Skip).unwrap();
        let GithubResolution::Ready(ctx) = resolution else {
            panic!("expected Ready, got something else");
        };
        assert_eq!(ctx.owner, "octocat");
        assert_eq!(ctx.name, "hello-world");
        assert_eq!(ctx.branch, "feature/auth");
        assert_eq!(ctx.login, "octocat");
        // No worktree on disk → no remote-tracking ref. Real workspaces
        // populate this via git, but the resolver still hands a Ready
        // context back so the caller can decide whether to short-circuit
        // on `has_remote_tracking`.
        assert!(!ctx.has_remote_tracking);
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

        let resolution = load_github_context("w-renamed", HostAuthCheck::Skip).unwrap();
        let GithubResolution::Ready(ctx) = resolution else {
            panic!("expected Ready");
        };
        assert_eq!(ctx.branch, "feature/remote-name");
        assert!(ctx.has_remote_tracking);
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

        let resolution = load_github_context("w-9", HostAuthCheck::Skip).unwrap();
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
        let result = load_github_context("does-not-exist", HostAuthCheck::Skip);
        assert!(result.is_err());
    }
}
