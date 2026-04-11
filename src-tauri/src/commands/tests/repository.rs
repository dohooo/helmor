use super::support::*;

#[test]
fn list_repositories_filters_hidden_and_sorts_by_display_order() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.insert_repo("repo-hidden", "hidden-repo", 0, 1);
    harness.insert_repo("repo-alpha", "alpha-repo", 0, 0);

    let repositories = repos::list_repositories().unwrap();
    let repository_names = repositories
        .iter()
        .map(|repository| repository.name.as_str())
        .collect::<Vec<_>>();

    assert_eq!(repository_names, vec!["alpha-repo", "demo-repo"]);
}

#[test]
fn add_repository_from_local_path_adds_repo_and_first_workspace() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    let added_repo_root = harness.root.join("added-repo");

    fs::create_dir_all(&added_repo_root).unwrap();
    init_create_git_repo_for_repo_test(&added_repo_root);
    let normalized_repo_root = repos::normalize_filesystem_path(&added_repo_root).unwrap();

    let response =
        repos::add_repository_from_local_path(added_repo_root.to_str().unwrap()).unwrap();
    let connection = Connection::open(harness.db_path()).unwrap();
    let (repo_count, workspace_count, session_count): (i64, i64, i64) = connection
        .query_row(
            r#"SELECT (SELECT COUNT(*) FROM repos WHERE root_path = ?1), (SELECT COUNT(*) FROM workspaces WHERE repository_id = ?2), (SELECT COUNT(*) FROM sessions WHERE workspace_id = ?3)"#,
            (
                normalized_repo_root.as_str(),
                &response.repository_id,
                response.created_workspace_id.as_deref().unwrap(),
            ),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let (remote, default_branch): (Option<String>, String) = connection
        .query_row(
            "SELECT remote, default_branch FROM repos WHERE id = ?1",
            [&response.repository_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let created_workspace_state: String = connection
        .query_row(
            "SELECT state FROM workspaces WHERE id = ?1",
            [response.selected_workspace_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();

    assert!(response.created_repository);
    assert_eq!(repo_count, 1);
    assert_eq!(workspace_count, 1);
    assert_eq!(session_count, 1);
    assert_eq!(response.created_workspace_state, "ready");
    assert_eq!(created_workspace_state, "ready");
    assert_eq!(default_branch, "main");
    assert_eq!(remote, Some("origin".to_string()));
}

#[test]
fn add_repository_from_local_path_focuses_existing_workspace_for_duplicate_repo() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    let created = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

    let response =
        repos::add_repository_from_local_path(harness.source_repo_root.to_str().unwrap()).unwrap();
    let connection = Connection::open(harness.db_path()).unwrap();
    let (repo_count, workspace_count): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM repos), (SELECT COUNT(*) FROM workspaces)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    assert!(!response.created_repository);
    assert_eq!(response.created_workspace_id, None);
    assert_eq!(response.selected_workspace_id, created.created_workspace_id);
    assert_eq!(response.created_workspace_state, "ready");
    assert_eq!(repo_count, 1);
    assert_eq!(workspace_count, 1);
}

#[test]
fn add_repository_from_local_path_rejects_non_git_directory_without_side_effects() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    let plain_dir = harness.root.join("not-a-repo");
    fs::create_dir_all(&plain_dir).unwrap();

    let error = repos::add_repository_from_local_path(plain_dir.to_str().unwrap()).unwrap_err();
    let connection = Connection::open(harness.db_path()).unwrap();
    let (repo_count, workspace_count): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM repos), (SELECT COUNT(*) FROM workspaces)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    assert!(error.to_string().contains("Git working tree"));
    assert_eq!(repo_count, 1);
    assert_eq!(workspace_count, 0);
}

#[test]
fn update_repository_default_branch_persists_new_value() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    repos::update_repository_default_branch(&harness.repo_id, "develop").unwrap();

    let repo = repos::load_repository_by_id(&harness.repo_id)
        .unwrap()
        .unwrap();
    assert_eq!(repo.default_branch.as_deref(), Some("develop"));
}

#[test]
fn update_repository_default_branch_rejects_unknown_repo() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _harness = CreateTestHarness::new();

    let err = repos::update_repository_default_branch("nonexistent", "main").unwrap_err();
    assert!(
        err.to_string().contains("not found"),
        "Expected not-found error, got: {err}"
    );
}

#[test]
fn update_repository_remote_persists_new_value() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let root = harness.source_repo_root.to_str().unwrap();
    git_ops::run_git(["-C", root, "remote", "add", "upstream", root], None).unwrap();
    git_ops::run_git(["-C", root, "fetch", "upstream"], None).unwrap();

    repos::update_repository_remote(&harness.repo_id, "upstream").unwrap();

    let repo = repos::load_repository_by_id(&harness.repo_id)
        .unwrap()
        .unwrap();
    assert_eq!(repo.remote.as_deref(), Some("upstream"));
}

#[test]
fn update_repository_remote_rejects_unknown_repo() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _harness = CreateTestHarness::new();

    let err = repos::update_repository_remote("nonexistent", "origin").unwrap_err();
    assert!(
        err.to_string().contains("not found"),
        "Expected not-found error, got: {err}"
    );
}

#[test]
fn list_repo_remotes_returns_configured_remotes() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let remotes = repos::list_repo_remotes(&harness.repo_id).unwrap();
    assert!(
        remotes.contains(&"origin".to_string()),
        "Expected origin in remotes, got: {remotes:?}"
    );

    let root = harness.source_repo_root.to_str().unwrap();
    git_ops::run_git(["-C", root, "remote", "add", "upstream", root], None).unwrap();

    let remotes = repos::list_repo_remotes(&harness.repo_id).unwrap();
    assert_eq!(remotes, vec!["origin", "upstream"]);
}

#[test]
fn create_workspace_rejects_repo_without_remote() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let root = harness.source_repo_root.to_str().unwrap();
    git_ops::run_git(["-C", root, "remote", "remove", "origin"], None).unwrap();

    let err = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap_err();
    assert!(
        err.to_string().contains("no remote"),
        "Expected 'no remote' error, got: {err}"
    );
}

#[test]
fn create_workspace_uses_configured_remote() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let root = harness.source_repo_root.to_str().unwrap();
    git_ops::run_git(["-C", root, "remote", "rename", "origin", "upstream"], None).unwrap();

    let err = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap_err();
    assert!(err.to_string().contains("no remote"));

    repos::update_repository_remote(&harness.repo_id, "upstream").unwrap();
    let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();
    assert_eq!(response.created_state, "ready");
}

#[test]
fn update_repository_remote_also_updates_default_branch() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let root = harness.source_repo_root.to_str().unwrap();
    git_ops::run_git(["-C", root, "checkout", "-b", "develop"], None).unwrap();
    git_ops::run_git(["-C", root, "checkout", "main"], None).unwrap();

    let upstream_bare = harness.root.join("upstream-bare.git");
    git_ops::run_git(
        ["clone", "--bare", root, upstream_bare.to_str().unwrap()],
        None,
    )
    .unwrap();
    git_ops::run_git(
        [
            "-C",
            upstream_bare.to_str().unwrap(),
            "symbolic-ref",
            "HEAD",
            "refs/heads/develop",
        ],
        None,
    )
    .unwrap();

    git_ops::run_git(
        [
            "-C",
            root,
            "remote",
            "add",
            "upstream",
            upstream_bare.to_str().unwrap(),
        ],
        None,
    )
    .unwrap();
    git_ops::run_git(["-C", root, "fetch", "upstream"], None).unwrap();

    let repo_before = repos::load_repository_by_id(&harness.repo_id)
        .unwrap()
        .unwrap();
    assert_eq!(repo_before.default_branch.as_deref(), Some("main"));

    repos::update_repository_remote(&harness.repo_id, "upstream").unwrap();

    let repo_after = repos::load_repository_by_id(&harness.repo_id)
        .unwrap()
        .unwrap();
    assert_eq!(repo_after.remote.as_deref(), Some("upstream"));
    assert_eq!(repo_after.default_branch.as_deref(), Some("develop"));
}

#[test]
fn update_repository_remote_rejects_remote_without_head() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let bare_dir = harness.root.join("bare-remote");
    git_ops::run_git(["init", "--bare", bare_dir.to_str().unwrap()], None).unwrap();
    let root = harness.source_repo_root.to_str().unwrap();
    git_ops::run_git(
        [
            "-C",
            root,
            "remote",
            "add",
            "empty-remote",
            bare_dir.to_str().unwrap(),
        ],
        None,
    )
    .unwrap();

    let err = repos::update_repository_remote(&harness.repo_id, "empty-remote").unwrap_err();
    assert!(
        err.to_string().contains("HEAD"),
        "Expected HEAD-related error, got: {err}"
    );
}

#[test]
fn update_repository_remote_reports_orphaned_workspaces() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let ws = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

    let root = harness.source_repo_root.to_str().unwrap();
    git_ops::run_git(["-C", root, "remote", "add", "upstream", root], None).unwrap();
    git_ops::run_git(["-C", root, "fetch", "upstream"], None).unwrap();

    let response = repos::update_repository_remote(&harness.repo_id, "upstream").unwrap();
    assert_eq!(response.orphaned_workspace_count, 0);

    let conn = Connection::open(harness.db_path()).unwrap();
    conn.execute(
        "UPDATE workspaces SET intended_target_branch = 'nonexistent-branch' WHERE id = ?1",
        [&ws.created_workspace_id],
    )
    .unwrap();

    let response = repos::update_repository_remote(&harness.repo_id, "origin").unwrap();
    assert_eq!(response.orphaned_workspace_count, 1);
}

#[test]
fn update_repository_remote_preserves_workspace_target_branches() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let ws = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();
    let conn = Connection::open(harness.db_path()).unwrap();
    conn.execute(
        "UPDATE workspaces SET intended_target_branch = 'develop' WHERE id = ?1",
        [&ws.created_workspace_id],
    )
    .unwrap();

    let root = harness.source_repo_root.to_str().unwrap();
    git_ops::run_git(["-C", root, "remote", "add", "upstream", root], None).unwrap();
    git_ops::run_git(["-C", root, "fetch", "upstream"], None).unwrap();
    repos::update_repository_remote(&harness.repo_id, "upstream").unwrap();

    let target: String = conn
        .query_row(
            "SELECT intended_target_branch FROM workspaces WHERE id = ?1",
            [&ws.created_workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(target, "develop");
}

#[test]
fn add_repository_picks_first_remote_when_no_origin() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let new_repo = harness.root.join("multi-remote-repo");
    fs::create_dir_all(&new_repo).unwrap();
    let root = new_repo.to_str().unwrap();
    git_ops::run_git(["init", "-b", "main", root], None).unwrap();
    fs::write(new_repo.join("file.txt"), "content").unwrap();
    git_ops::run_git(["-C", root, "add", "."], None).unwrap();
    git_ops::run_git(
        [
            "-C",
            root,
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Helmor",
            "-c",
            "user.email=helmor@example.com",
            "commit",
            "-m",
            "init",
        ],
        None,
    )
    .unwrap();
    git_ops::run_git(["-C", root, "remote", "add", "beta", root], None).unwrap();
    git_ops::run_git(["-C", root, "remote", "add", "alpha", root], None).unwrap();
    git_ops::run_git(["-C", root, "fetch", "alpha"], None).unwrap();
    git_ops::run_git(["-C", root, "fetch", "beta"], None).unwrap();

    let response = repos::add_repository_from_local_path(root).unwrap();
    assert!(response.created_repository);

    let repo = repos::load_repository_by_id(&response.repository_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        repo.remote.as_deref(),
        Some("alpha"),
        "Should pick first remote alphabetically"
    );
}

fn init_create_git_repo_for_repo_test(repo_root: &Path) {
    let root = repo_root.to_str().unwrap();
    git_ops::run_git(["init", "-b", "main", root], None).unwrap();
    fs::write(repo_root.join("tracked.txt"), "main").unwrap();
    git_ops::run_git(["-C", root, "add", "tracked.txt"], None).unwrap();
    git_ops::run_git(
        [
            "-C",
            root,
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Helmor",
            "-c",
            "user.email=helmor@example.com",
            "commit",
            "-m",
            "initial",
        ],
        None,
    )
    .unwrap();
    git_ops::run_git(["-C", root, "remote", "add", "origin", root], None).unwrap();
    git_ops::run_git(["-C", root, "fetch", "origin"], None).unwrap();
}
