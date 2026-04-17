use super::support::*;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    test::{mock_builder, mock_context, noop_assets},
    Manager,
};

#[test]
fn restore_workspace_recreates_worktree_and_context() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = RestoreTestHarness::new(true);

    let response = workspaces::restore_workspace_impl(&harness.workspace_id, None).unwrap();

    assert_eq!(response.restored_workspace_id, harness.workspace_id);
    assert_eq!(response.restored_state, "ready");
    assert_eq!(response.selected_workspace_id, harness.workspace_id);
    assert!(harness.source_repo_root().exists());
    assert!(harness.workspace_dir().join(".git").exists());
    assert!(harness.workspace_dir().join("tracked.txt").exists());
    assert!(harness.workspace_dir().join(".context/notes.md").exists());
    assert!(harness
        .workspace_dir()
        .join(".context/attachments/evidence.txt")
        .exists());
    assert!(!harness.archived_context_dir().exists());

    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    let state: String = connection
        .query_row(
            "SELECT state FROM workspaces WHERE id = ?1",
            [&harness.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    let attachment_path: String = connection
        .query_row(
            "SELECT path FROM attachments WHERE session_id = ?1",
            [&harness.session_id],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(state, "ready");
    assert_eq!(attachment_path, harness.attachment_path());
}

#[test]
fn archive_workspace_moves_context_and_removes_worktree() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(true);

    let response = workspaces::archive_workspace_impl(&harness.workspace_id).unwrap();

    assert_eq!(response.archived_workspace_id, harness.workspace_id);
    assert_eq!(response.archived_state, "archived");
    assert!(!harness.workspace_dir().exists());
    assert!(harness.archived_context_dir().join("notes.md").exists());
    assert!(harness
        .archived_context_dir()
        .join("attachments/evidence.txt")
        .exists());

    let worktree_list = git_ops::run_git(
        [
            "-C",
            harness.source_repo_root().to_str().unwrap(),
            "worktree",
            "list",
        ],
        None,
    )
    .unwrap();
    assert!(!worktree_list.contains(harness.workspace_dir().to_str().unwrap()));

    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    let (state, archive_commit, attachment_path): (String, String, String) = connection
        .query_row(
            "SELECT state, archive_commit, (SELECT path FROM attachments WHERE session_id = ?2) FROM workspaces WHERE id = ?1",
            (&harness.workspace_id, &harness.session_id),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();

    assert_eq!(state, "archived");
    assert_eq!(archive_commit, harness.head_commit);
    assert_eq!(attachment_path, harness.attachment_path());
}

#[test]
fn permanently_delete_archived_workspace_removes_db_rows_and_context() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(true);

    workspaces::archive_workspace_impl(&harness.workspace_id).unwrap();
    assert!(harness.archived_context_dir().exists());

    workspaces::permanently_delete_workspace(&harness.workspace_id).unwrap();

    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    let workspace_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
            [&harness.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    let session_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE workspace_id = ?1",
            [&harness.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    let message_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
            [&harness.session_id],
            |row| row.get(0),
        )
        .unwrap();
    let attachment_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM attachments WHERE session_id = ?1",
            [&harness.session_id],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(workspace_count, 0);
    assert_eq!(session_count, 0);
    assert_eq!(message_count, 0);
    assert_eq!(attachment_count, 0);
    assert!(!harness.archived_context_dir().exists());
}

#[test]
fn permanently_delete_workspace_surfaces_sql_errors() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(true);
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    connection
        .execute(
            r#"
            CREATE TRIGGER block_workspace_delete
            BEFORE DELETE ON workspaces
            BEGIN
                SELECT RAISE(FAIL, 'blocked delete');
            END;
            "#,
            [],
        )
        .unwrap();
    drop(connection);

    let error = workspaces::permanently_delete_workspace(&harness.workspace_id)
        .expect_err("delete should surface trigger failures");
    let error_text = format!("{error:#}");

    assert!(
        error_text.contains("Failed to delete workspace row")
            || error_text.contains("blocked delete"),
        "Expected delete error context, got: {error_text}"
    );

    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    let workspace_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
            [&harness.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(workspace_count, 1);
}

#[test]
fn prepare_archive_plan_is_read_only() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(true);

    let _plan = workspaces::prepare_archive_plan(&harness.workspace_id).unwrap();

    assert!(harness.workspace_dir().exists());
    assert!(!harness.archived_context_dir().exists());

    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    let state: String = connection
        .query_row(
            "SELECT state FROM workspaces WHERE id = ?1",
            [&harness.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "ready");
}

#[test]
fn archive_workspace_allows_setup_pending_state() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(true);
    harness.set_state("setup_pending");

    let response = workspaces::archive_workspace_impl(&harness.workspace_id).unwrap();

    assert_eq!(response.archived_state, "archived");
    assert!(!harness.workspace_dir().exists());
}

#[test]
fn archive_workspace_rejects_initializing_state() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(true);
    harness.set_state("initializing");

    let error = workspaces::prepare_archive_plan(&harness.workspace_id).unwrap_err();

    assert!(error.to_string().contains("not archive-ready"));
}

#[test]
fn restore_workspace_cleans_up_existing_target_directory() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = RestoreTestHarness::new(true);
    fs::create_dir_all(harness.workspace_dir()).unwrap();
    fs::write(harness.workspace_dir().join("stale.txt"), "old").unwrap();

    let result = workspaces::restore_workspace_impl(&harness.workspace_id, None);
    assert!(
        result.is_ok(),
        "Restore should succeed by replacing existing dir: {:?}",
        result.err()
    );
    assert!(!harness.workspace_dir().join("stale.txt").exists());
    assert!(harness.workspace_dir().join(".git").exists());
}

#[test]
fn restore_workspace_recreates_deleted_branch() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = RestoreTestHarness::new(true);
    git_ops::run_git(
        [
            "-C",
            harness.source_repo_root.to_str().unwrap(),
            "branch",
            "-D",
            harness.branch.as_str(),
        ],
        None,
    )
    .unwrap();

    let response = workspaces::restore_workspace_impl(&harness.workspace_id, None)
        .expect("Restore should succeed by recreating branch");
    assert!(
        harness.workspace_dir().exists(),
        "Worktree should be created"
    );
    assert!(
        response.branch_rename.is_none(),
        "Expected no branch rename when original branch was free, got {:?}",
        response.branch_rename
    );
}

#[test]
fn restore_workspace_returns_branch_rename_when_original_taken() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = RestoreTestHarness::new(true);

    let response = workspaces::restore_workspace_impl(&harness.workspace_id, None)
        .expect("Restore should succeed on a renamed branch");

    let rename = response
        .branch_rename
        .expect("branch_rename should be populated when original branch was taken");
    assert_eq!(rename.original, harness.branch);
    assert_eq!(rename.actual, format!("{}-v1", harness.branch));

    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    let stored_branch: String = connection
        .query_row(
            "SELECT branch FROM workspaces WHERE id = ?1",
            [&harness.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_branch, format!("{}-v1", harness.branch));
    assert!(harness.workspace_dir().join(".git").exists());
}

#[test]
fn restore_workspace_fails_when_archive_commit_missing() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = RestoreTestHarness::new(true);

    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    connection
        .execute(
            "UPDATE workspaces SET archive_commit = ?1 WHERE id = ?2",
            (
                "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                &harness.workspace_id,
            ),
        )
        .unwrap();
    drop(connection);

    let error = workspaces::restore_workspace_impl(&harness.workspace_id, None).unwrap_err();
    let error_text = format!("{error:#}");
    assert!(
        error_text.contains("Commit not found")
            || error_text.contains("no longer exists")
            || error_text.contains("Cannot restore"),
        "Expected a clear missing-commit error, got: {error_text}"
    );

    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    let state: String = connection
        .query_row(
            "SELECT state FROM workspaces WHERE id = ?1",
            [&harness.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "archived");
    assert!(
        harness.archived_context_dir().exists(),
        "Archived context dir should be untouched on bail-out"
    );
    assert!(
        !harness.workspace_dir().exists(),
        "Workspace dir should not be materialized when restore bails"
    );
}

#[test]
fn restore_workspace_cleans_up_when_db_update_fails() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = RestoreTestHarness::new(false);

    let error = workspaces::restore_workspace_impl(&harness.workspace_id, None).unwrap_err();

    assert!(error.to_string().contains("update workspace restore state"));
    assert!(!harness.workspace_dir().exists());
    assert!(harness.archived_context_dir().exists());
}

#[test]
fn archive_workspace_cleans_up_when_db_update_fails() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(false);

    let error = workspaces::archive_workspace_impl(&harness.workspace_id).unwrap_err();

    assert!(error.to_string().contains("update workspace archive state"));
    assert!(harness.workspace_dir().exists());
    assert!(harness.workspace_dir().join(".context/notes.md").exists());
    assert!(harness
        .workspace_dir()
        .join(".context/attachments/evidence.txt")
        .exists());
    assert!(!harness.archived_context_dir().exists());

    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    let state: String = connection
        .query_row(
            "SELECT state FROM workspaces WHERE id = ?1",
            [&harness.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "ready");
}

#[test]
fn start_archive_workspace_syncs_git_fetchers_after_success() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(true);
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    connection
        .execute("UPDATE repos SET remote = 'origin' WHERE id = 'repo-1'", [])
        .unwrap();
    drop(connection);

    let app = mock_builder()
        .manage(workspaces::ArchiveJobManager::new())
        .manage(crate::git_watcher::GitWatcherManager::new())
        .build(mock_context(noop_assets()))
        .unwrap();
    let app_handle = app.handle().clone();
    let watcher_manager = app_handle.state::<crate::git_watcher::GitWatcherManager>();

    watcher_manager.sync_from_db(app_handle.clone()).unwrap();
    assert_eq!(watcher_manager.fetcher_count(), 1);

    let archive_manager = app_handle.state::<workspaces::ArchiveJobManager>();
    archive_manager.prepare(&harness.workspace_id).unwrap();
    workspaces::start_archive_workspace(&app_handle, &harness.workspace_id).unwrap();

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        let state: String = connection
            .query_row(
                "SELECT state FROM workspaces WHERE id = ?1",
                [&harness.workspace_id],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);

        if state == "archived" && watcher_manager.fetcher_count() == 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Timed out waiting for archive success to sync git fetchers",
        );
        thread::sleep(Duration::from_millis(20));
    }

    watcher_manager.shutdown();
}

#[test]
fn source_repo_branches_accessible_for_worktree_creation() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = RestoreTestHarness::new(true);
    let source = &harness.source_repo_root;

    git_ops::run_git(["-C", source.to_str().unwrap(), "checkout", "main"], None).unwrap();
    git_ops::run_git(
        [
            "-C",
            source.to_str().unwrap(),
            "checkout",
            "-b",
            "feature/second-restore-target",
        ],
        None,
    )
    .unwrap();
    fs::write(source.join("second.txt"), "second branch").unwrap();
    git_ops::run_git(["-C", source.to_str().unwrap(), "add", "second.txt"], None).unwrap();
    git_ops::run_git(
        [
            "-C",
            source.to_str().unwrap(),
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Helmor",
            "-c",
            "user.email=helmor@example.com",
            "commit",
            "-m",
            "second restore target",
        ],
        None,
    )
    .unwrap();

    git_ops::verify_branch_exists(source, "feature/second-restore-target").unwrap();
    git_ops::verify_branch_exists(source, &harness.branch).unwrap();
}
