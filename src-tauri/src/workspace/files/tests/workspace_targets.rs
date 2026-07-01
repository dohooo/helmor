use std::{fs, path::Path};

use rusqlite::Connection;

use crate::{data_dir::TEST_ENV_LOCK as TEST_LOCK, git_ops};

use super::{
    parse_workspace_path, query_local_workspace_target, query_workspace_target,
    query_workspace_target_by_id, resolve_target_ref_for_workspace,
    support::{test_db_with_workspace, TestDataDir},
};

#[test]
fn parse_workspace_path_normal() {
    let path = Path::new("/Users/x/helmor-dev/workspaces/my-repo/feature-branch");
    let (repo, dir) = parse_workspace_path(path).unwrap();
    assert_eq!(repo, "my-repo");
    assert_eq!(dir, "feature-branch");
}

#[test]
fn parse_workspace_path_root_returns_none() {
    assert!(parse_workspace_path(Path::new("/")).is_none());
}

#[test]
fn parse_workspace_path_single_component_returns_none() {
    assert!(parse_workspace_path(Path::new("/tmp")).is_none());
}

#[test]
fn query_target_returns_intended_target_branch() {
    let conn = test_db_with_workspace(Some("origin"), Some("develop"), "main");
    let result = query_workspace_target(&conn, "test-repo", "ws-dir");
    assert_eq!(
        result,
        Some((Some("origin".to_string()), "develop".to_string()))
    );
}

#[test]
fn query_target_falls_back_to_default_branch() {
    let conn = test_db_with_workspace(Some("origin"), None, "main");
    let result = query_workspace_target(&conn, "test-repo", "ws-dir");
    assert_eq!(
        result,
        Some((Some("origin".to_string()), "main".to_string()))
    );
}

#[test]
fn query_target_preserves_absent_remote() {
    let conn = test_db_with_workspace(None, Some("develop"), "main");
    let result = query_workspace_target(&conn, "test-repo", "ws-dir");
    // No remote configured → remote stays None (no fake "origin" default).
    assert_eq!(result, Some((None, "develop".to_string())));
}

#[test]
fn query_target_custom_remote() {
    let conn = test_db_with_workspace(Some("upstream"), Some("release"), "main");
    let result = query_workspace_target(&conn, "test-repo", "ws-dir");
    assert_eq!(
        result,
        Some((Some("upstream".to_string()), "release".to_string()))
    );
}

#[test]
fn query_target_returns_none_for_unknown_workspace() {
    let conn = test_db_with_workspace(Some("origin"), Some("develop"), "main");
    let result = query_workspace_target(&conn, "test-repo", "nonexistent");
    assert!(result.is_none());
}

#[test]
fn query_target_returns_none_for_archived_workspace() {
    let conn = Connection::open_in_memory().unwrap();
    crate::schema::ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO repos (id, name, default_branch) VALUES ('r1', 'test-repo', 'main')",
        [],
    )
    .unwrap();
    conn.execute(
		"INSERT INTO workspaces (id, repository_id, directory_name, state, status, intended_target_branch, display_order)
		 VALUES ('w1', 'r1', 'ws-dir', 'archived', 'done', 'develop', ?1)",
		[crate::workspace::sidebar_order::ORDER_STEP],
	)
	.unwrap();

    let result = query_workspace_target(&conn, "test-repo", "ws-dir");
    assert!(result.is_none(), "archived workspaces should not match");
}

#[test]
fn query_local_target_matches_repo_root_path() {
    let repo_root = tempfile::tempdir().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    crate::schema::ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO repos (id, name, root_path, default_branch, remote)
		 VALUES ('r1', 'com.xiaomi.robovac', ?1, 'main', 'origin')",
        [repo_root.path().display().to_string()],
    )
    .unwrap();
    conn.execute(
		"INSERT INTO workspaces (id, repository_id, directory_name, mode, state, status, intended_target_branch, display_order)
		 VALUES ('w1', 'r1', '', 'local', 'ready', 'in-progress', 'dev_ov21', ?1)",
		[crate::workspace::sidebar_order::ORDER_STEP],
	)
	.unwrap();

    let result = query_local_workspace_target(&conn, repo_root.path());
    assert_eq!(
        result,
        Some((Some("origin".to_string()), "dev_ov21".to_string()))
    );
}

#[test]
fn query_local_target_returns_none_when_repo_root_is_ambiguous() {
    let repo_root = tempfile::tempdir().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    crate::schema::ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO repos (id, name, root_path, default_branch, remote)
		 VALUES ('r1', 'com.xiaomi.robovac', ?1, 'main', 'origin')",
        [repo_root.path().display().to_string()],
    )
    .unwrap();
    for (id, target, order) in [
        (
            "w1",
            "dev_ov21",
            crate::workspace::sidebar_order::ORDER_STEP,
        ),
        (
            "w2",
            "dev_alt",
            crate::workspace::sidebar_order::ORDER_STEP * 2,
        ),
    ] {
        conn.execute(
			"INSERT INTO workspaces (id, repository_id, directory_name, mode, state, status, intended_target_branch, display_order)
			 VALUES (?1, 'r1', '', 'local', 'ready', 'in-progress', ?2, ?3)",
			rusqlite::params![id, target, order],
		)
		.unwrap();
    }

    let result = query_local_workspace_target(&conn, repo_root.path());
    assert_eq!(result, None);
}

#[test]
fn query_target_by_id_disambiguates_local_workspaces_on_same_repo_root() {
    let repo_root = tempfile::tempdir().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    crate::schema::ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO repos (id, name, root_path, default_branch, remote)
		 VALUES ('r1', 'com.xiaomi.robovac', ?1, 'main', 'origin')",
        [repo_root.path().display().to_string()],
    )
    .unwrap();
    for (id, target, order) in [
        (
            "w1",
            "dev_ov21",
            crate::workspace::sidebar_order::ORDER_STEP,
        ),
        (
            "w2",
            "dev_alt",
            crate::workspace::sidebar_order::ORDER_STEP * 2,
        ),
    ] {
        conn.execute(
			"INSERT INTO workspaces (id, repository_id, directory_name, mode, state, status, intended_target_branch, display_order)
			 VALUES (?1, 'r1', '', 'local', 'ready', 'in-progress', ?2, ?3)",
			rusqlite::params![id, target, order],
		)
		.unwrap();
    }

    let result = query_workspace_target_by_id(&conn, "w2", repo_root.path());
    assert_eq!(
        result,
        Some((Some("origin".to_string()), "dev_alt".to_string()))
    );
}

#[test]
fn resolve_target_ref_uses_configured_target_branch() {
    let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let test_dir = TestDataDir::new("merge-base-target");

    let repo_root = test_dir.root.join("source-repo");
    fs::create_dir_all(&repo_root).unwrap();
    git_ops::run_git(["init", "-b", "main"], Some(&repo_root)).unwrap();
    git_ops::run_git(
        ["config", "user.email", "test@helmor.test"],
        Some(&repo_root),
    )
    .unwrap();
    git_ops::run_git(["config", "user.name", "Test"], Some(&repo_root)).unwrap();
    git_ops::run_git(["config", "commit.gpgsign", "false"], Some(&repo_root)).unwrap();
    fs::write(repo_root.join("f.txt"), "base\n").unwrap();
    git_ops::run_git(["add", "."], Some(&repo_root)).unwrap();
    git_ops::run_git(["commit", "-m", "init"], Some(&repo_root)).unwrap();

    git_ops::run_git(["checkout", "-b", "custom/target"], Some(&repo_root)).unwrap();
    fs::write(repo_root.join("target.txt"), "target\n").unwrap();
    git_ops::run_git(["add", "."], Some(&repo_root)).unwrap();
    git_ops::run_git(["commit", "-m", "target commit"], Some(&repo_root)).unwrap();

    git_ops::run_git(["checkout", "-b", "workspace/dev"], Some(&repo_root)).unwrap();
    fs::write(repo_root.join("work.txt"), "work\n").unwrap();
    git_ops::run_git(["add", "."], Some(&repo_root)).unwrap();
    git_ops::run_git(["commit", "-m", "workspace commit"], Some(&repo_root)).unwrap();
    git_ops::run_git(["checkout", "main"], Some(&repo_root)).unwrap();

    let workspace_dir = crate::data_dir::workspace_dir("merge-base-repo", "merge-base-ws").unwrap();
    git_ops::run_git(
        [
            "worktree",
            "add",
            workspace_dir.to_str().unwrap(),
            "workspace/dev",
        ],
        Some(&repo_root),
    )
    .unwrap();

    let conn = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    conn.execute(
		"INSERT INTO repos (id, name, root_path, default_branch, remote) VALUES ('r1', 'merge-base-repo', ?1, 'main', 'origin')",
		[repo_root.display().to_string()],
	)
	.unwrap();
    conn.execute(
		"INSERT INTO workspaces (id, repository_id, directory_name, state, status, intended_target_branch, display_order)
		 VALUES ('w1', 'r1', 'merge-base-ws', 'ready', 'in-progress', 'custom/target', ?1)",
		[crate::workspace::sidebar_order::ORDER_STEP],
	)
	.unwrap();
    drop(conn);

    let resolved = resolve_target_ref_for_workspace(&workspace_dir, None).unwrap();
    assert_eq!(
        resolved, "refs/heads/custom/target",
        "should resolve to the configured target branch ref"
    );
}

#[test]
fn resolve_target_ref_uses_local_workspace_root_target() {
    let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let test_dir = TestDataDir::new("local-workspace-target");

    let repo_root = test_dir.root.join("com.xiaomi.robovac");
    fs::create_dir_all(&repo_root).unwrap();
    git_ops::run_git(["init", "-b", "main"], Some(&repo_root)).unwrap();
    git_ops::run_git(
        ["config", "user.email", "test@helmor.test"],
        Some(&repo_root),
    )
    .unwrap();
    git_ops::run_git(["config", "user.name", "Test"], Some(&repo_root)).unwrap();
    git_ops::run_git(["config", "commit.gpgsign", "false"], Some(&repo_root)).unwrap();
    fs::write(repo_root.join("f.txt"), "base\n").unwrap();
    git_ops::run_git(["add", "."], Some(&repo_root)).unwrap();
    git_ops::run_git(["commit", "-m", "init"], Some(&repo_root)).unwrap();

    git_ops::run_git(["checkout", "-b", "dev_ov21"], Some(&repo_root)).unwrap();
    fs::write(repo_root.join("dev.txt"), "dev\n").unwrap();
    git_ops::run_git(["add", "."], Some(&repo_root)).unwrap();
    git_ops::run_git(["commit", "-m", "dev commit"], Some(&repo_root)).unwrap();

    let conn = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    conn.execute(
        "INSERT INTO repos (id, name, root_path, default_branch, remote)
		 VALUES ('r1', 'com.xiaomi.robovac', ?1, 'main', 'origin')",
        [repo_root.display().to_string()],
    )
    .unwrap();
    conn.execute(
		"INSERT INTO workspaces (id, repository_id, directory_name, mode, state, status, intended_target_branch, display_order)
		 VALUES ('w1', 'r1', '', 'local', 'ready', 'in-progress', 'dev_ov21', ?1)",
		[crate::workspace::sidebar_order::ORDER_STEP],
	)
	.unwrap();
    drop(conn);

    let resolved = resolve_target_ref_for_workspace(&repo_root, Some("w1")).unwrap();
    assert_eq!(
        resolved, "refs/heads/dev_ov21",
        "local workspace roots should use their stored target branch, not origin/main fallback"
    );
}

#[test]
fn resolve_target_ref_uses_workspace_id_when_local_roots_are_shared() {
    let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let test_dir = TestDataDir::new("local-workspace-target-disambiguated");

    let repo_root = test_dir.root.join("com.xiaomi.robovac");
    fs::create_dir_all(&repo_root).unwrap();
    git_ops::run_git(["init", "-b", "main"], Some(&repo_root)).unwrap();
    git_ops::run_git(
        ["config", "user.email", "test@helmor.test"],
        Some(&repo_root),
    )
    .unwrap();
    git_ops::run_git(["config", "user.name", "Test"], Some(&repo_root)).unwrap();
    git_ops::run_git(["config", "commit.gpgsign", "false"], Some(&repo_root)).unwrap();
    fs::write(repo_root.join("f.txt"), "base\n").unwrap();
    git_ops::run_git(["add", "."], Some(&repo_root)).unwrap();
    git_ops::run_git(["commit", "-m", "init"], Some(&repo_root)).unwrap();

    for (branch, file) in [("dev_ov21", "dev.txt"), ("dev_alt", "alt.txt")] {
        git_ops::run_git(["checkout", "-B", branch, "main"], Some(&repo_root)).unwrap();
        fs::write(repo_root.join(file), branch).unwrap();
        git_ops::run_git(["add", "."], Some(&repo_root)).unwrap();
        git_ops::run_git(["commit", "-m", branch], Some(&repo_root)).unwrap();
    }
    git_ops::run_git(["checkout", "dev_alt"], Some(&repo_root)).unwrap();

    let conn = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    conn.execute(
        "INSERT INTO repos (id, name, root_path, default_branch, remote)
		 VALUES ('r1', 'com.xiaomi.robovac', ?1, 'main', 'origin')",
        [repo_root.display().to_string()],
    )
    .unwrap();
    for (id, target, order) in [
        (
            "w1",
            "dev_ov21",
            crate::workspace::sidebar_order::ORDER_STEP,
        ),
        (
            "w2",
            "dev_alt",
            crate::workspace::sidebar_order::ORDER_STEP * 2,
        ),
    ] {
        conn.execute(
			"INSERT INTO workspaces (id, repository_id, directory_name, mode, state, status, intended_target_branch, display_order)
			 VALUES (?1, 'r1', '', 'local', 'ready', 'in-progress', ?2, ?3)",
			rusqlite::params![id, target, order],
		)
		.unwrap();
    }
    drop(conn);

    let resolved = resolve_target_ref_for_workspace(&repo_root, Some("w2")).unwrap();
    assert_eq!(
        resolved, "refs/heads/dev_alt",
        "workspace id should disambiguate local rows sharing one repo root"
    );
}
