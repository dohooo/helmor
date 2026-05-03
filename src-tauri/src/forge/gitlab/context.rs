//! Workspace ID → the shape every GitLab call needs. Mirrors
//! `forge::github::context`: a tristate-ish [`GitlabResolution`] keeps
//! Initializing / Unavailable / Unauthenticated short-circuits out of
//! per-call sites.

use anyhow::{bail, Result};

use crate::forge::branch::forge_head_branch_for;
use crate::forge::remote::{parse_remote, ParsedRemote};
use crate::models::workspaces as workspace_models;
use crate::workspace_state::WorkspaceState;

pub(super) struct GitlabContext {
    pub(super) remote: ParsedRemote,
    pub(super) full_path: String,
    /// Branch name to pass as GitLab's `source_branch`. If the local
    /// branch tracks a differently named remote branch, this is the
    /// upstream branch name rather than the local branch name.
    pub(super) branch: String,
    pub(super) published: bool,
    /// Bound glab account. Always non-empty — `Unauthenticated`
    /// short-circuits before we'd ever produce a context with `None`.
    pub(super) login: String,
}

pub(super) enum GitlabResolution {
    Ready(GitlabContext),
    Initializing,
    Unavailable(&'static str),
    Unauthenticated,
}

pub(super) fn load_gitlab_context(workspace_id: &str) -> Result<GitlabResolution> {
    let Some(record) = workspace_models::load_workspace_record_by_id(workspace_id)? else {
        bail!("Workspace not found: {workspace_id}");
    };
    if record.state == WorkspaceState::Initializing {
        return Ok(GitlabResolution::Initializing);
    }

    let Some(remote_url) = record.remote_url.as_deref() else {
        return Ok(GitlabResolution::Unavailable("Workspace has no remote"));
    };
    let Some(remote) = parse_remote(remote_url) else {
        return Ok(GitlabResolution::Unavailable(
            "Workspace remote is not a GitLab repository",
        ));
    };
    let Some(branch) = record
        .branch
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
    else {
        return Ok(GitlabResolution::Unavailable(
            "Workspace has no current branch",
        ));
    };

    // No bound login → Unauthenticated. Mirrors the GitHub side.
    let Some(login) = record
        .forge_login
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
    else {
        return Ok(GitlabResolution::Unauthenticated);
    };

    let (branch, published) = forge_head_branch_for(&record, &branch);
    let full_path = format!("{}/{}", remote.namespace, remote.repo);

    Ok(GitlabResolution::Ready(GitlabContext {
        remote,
        full_path,
        branch,
        published,
        login,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ops;
    use rusqlite::Connection;

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
             VALUES (?1, ?2, 'main', 'origin', ?3, 'gitlab', ?4)",
            rusqlite::params![id, name, remote_url, forge_login],
        )
        .unwrap();
    }

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
        let env = crate::testkit::TestEnv::new("gitlab-ctx-initializing");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-1",
            "Repo",
            Some("git@gitlab.com:acme/repo.git"),
            Some("alice"),
        );
        insert_workspace(&conn, "w-1", "r-1", "initializing", Some("feature"));
        drop(conn);

        assert!(matches!(
            load_gitlab_context("w-1").unwrap(),
            GitlabResolution::Initializing
        ));
    }

    #[test]
    fn returns_unavailable_when_remote_url_is_missing() {
        let env = crate::testkit::TestEnv::new("gitlab-ctx-no-remote");
        let conn = env.db_connection();
        insert_repo(&conn, "r-2", "Repo", None, Some("alice"));
        insert_workspace(&conn, "w-2", "r-2", "ready", Some("feature"));
        drop(conn);

        assert!(matches!(
            load_gitlab_context("w-2").unwrap(),
            GitlabResolution::Unavailable("Workspace has no remote")
        ));
    }

    #[test]
    fn returns_unavailable_when_remote_is_unparseable() {
        let env = crate::testkit::TestEnv::new("gitlab-ctx-bad-remote");
        let conn = env.db_connection();
        insert_repo(&conn, "r-3", "Repo", Some("not a url"), Some("alice"));
        insert_workspace(&conn, "w-3", "r-3", "ready", Some("feature"));
        drop(conn);

        assert!(matches!(
            load_gitlab_context("w-3").unwrap(),
            GitlabResolution::Unavailable("Workspace remote is not a GitLab repository")
        ));
    }

    #[test]
    fn returns_unavailable_when_branch_is_missing() {
        let env = crate::testkit::TestEnv::new("gitlab-ctx-no-branch");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-4",
            "Repo",
            Some("git@gitlab.com:acme/repo.git"),
            Some("alice"),
        );
        insert_workspace(&conn, "w-4", "r-4", "ready", None);
        drop(conn);

        assert!(matches!(
            load_gitlab_context("w-4").unwrap(),
            GitlabResolution::Unavailable("Workspace has no current branch")
        ));
    }

    #[test]
    fn returns_unauthenticated_when_forge_login_is_null() {
        let env = crate::testkit::TestEnv::new("gitlab-ctx-null-login");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-5",
            "Repo",
            Some("git@gitlab.com:acme/repo.git"),
            None,
        );
        insert_workspace(&conn, "w-5", "r-5", "ready", Some("feature"));
        drop(conn);

        assert!(matches!(
            load_gitlab_context("w-5").unwrap(),
            GitlabResolution::Unauthenticated
        ));
    }

    #[test]
    fn returns_unauthenticated_when_forge_login_is_whitespace_only() {
        let env = crate::testkit::TestEnv::new("gitlab-ctx-blank-login");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-6",
            "Repo",
            Some("git@gitlab.com:acme/repo.git"),
            Some("   "),
        );
        insert_workspace(&conn, "w-6", "r-6", "ready", Some("feature"));
        drop(conn);

        assert!(matches!(
            load_gitlab_context("w-6").unwrap(),
            GitlabResolution::Unauthenticated
        ));
    }

    #[test]
    fn returns_ready_with_parsed_fields_when_preconditions_satisfied() {
        let env = crate::testkit::TestEnv::new("gitlab-ctx-ready");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-7",
            "Repo",
            Some("git@gitlab.com:acme/repo.git"),
            Some("alice"),
        );
        insert_workspace(&conn, "w-7", "r-7", "ready", Some("feature/auth"));
        drop(conn);

        let GitlabResolution::Ready(ctx) = load_gitlab_context("w-7").unwrap() else {
            panic!("expected Ready");
        };
        assert_eq!(ctx.remote.host, "gitlab.com");
        assert_eq!(ctx.full_path, "acme/repo");
        assert_eq!(ctx.branch, "feature/auth");
        assert_eq!(ctx.login, "alice");
        assert!(!ctx.published);
    }

    #[test]
    fn returns_ready_for_nested_namespace() {
        let env = crate::testkit::TestEnv::new("gitlab-ctx-nested");
        let conn = env.db_connection();
        insert_repo(
            &conn,
            "r-8",
            "Repo",
            Some("git@gitlab.example.com:platform/tools/api.git"),
            Some("bob"),
        );
        insert_workspace(&conn, "w-8", "r-8", "ready", Some("main"));
        drop(conn);

        let GitlabResolution::Ready(ctx) = load_gitlab_context("w-8").unwrap() else {
            panic!("expected Ready");
        };
        assert_eq!(ctx.remote.host, "gitlab.example.com");
        assert_eq!(ctx.full_path, "platform/tools/api");
        assert_eq!(ctx.login, "bob");
    }

    #[test]
    fn errors_when_workspace_does_not_exist() {
        let _env = crate::testkit::TestEnv::new("gitlab-ctx-missing");
        assert!(load_gitlab_context("does-not-exist").is_err());
    }

    #[test]
    fn uses_upstream_branch_name_when_local_branch_was_renamed() {
        let env = crate::testkit::TestEnv::new("gitlab-ctx-renamed-local-branch");
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
            Some("git@gitlab.com:acme/repo.git"),
            Some("alice"),
        );
        insert_workspace(
            &conn,
            "w-renamed",
            "r-renamed",
            "ready",
            Some("feature/local-name"),
        );
        drop(conn);

        let GitlabResolution::Ready(ctx) = load_gitlab_context("w-renamed").unwrap() else {
            panic!("expected Ready");
        };
        assert_eq!(ctx.branch, "feature/remote-name");
        assert!(ctx.published);
    }
}
