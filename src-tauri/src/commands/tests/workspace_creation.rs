use super::support::*;
use crate::workspace::sidebar_order;
use crate::workspace_state::{WorkspaceMode, WorkspaceState};
use crate::workspace_status::WorkspaceStatus;

#[test]
fn create_workspace_from_repo_creates_ready_workspace_and_initial_session() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

    // No setup script → goes straight to "ready".
    assert_eq!(response.created_state, WorkspaceState::Ready);
    assert!(
        helpers::WORKSPACE_NAMES.contains(&response.directory_name.as_str()),
        "Expected a name from WORKSPACE_NAMES, got: {}",
        response.directory_name
    );
    assert!(
        response.branch.starts_with("testuser/"),
        "Expected testuser/ prefix, got: {}",
        response.branch
    );
    assert!(!response.initial_session_id.is_empty());

    let workspace_dir = harness.workspace_dir(&response.directory_name);
    assert!(workspace_dir.join(".git").exists());

    let connection = Connection::open(harness.db_path()).unwrap();
    let (state, branch, initialization_parent_branch, intended_target_branch, active_session_id): (
        String,
        String,
        String,
        String,
        String,
    ) = connection
        .query_row(
            r#"
            SELECT state, branch, initialization_parent_branch,
              intended_target_branch, active_session_id
            FROM workspaces WHERE id = ?1
            "#,
            [&response.created_workspace_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    let (session_title, session_model, session_agent_type, session_permission_mode): (
        String,
        Option<String>,
        Option<String>,
        String,
    ) = connection
        .query_row(
            "SELECT title, model, agent_type, permission_mode FROM sessions WHERE id = ?1",
            [&active_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();

    assert_eq!(state, "ready");
    assert!(
        branch.starts_with("testuser/"),
        "Expected testuser/ prefix, got: {branch}"
    );
    assert_eq!(initialization_parent_branch, "main");
    assert_eq!(intended_target_branch, "main");
    assert_eq!(response.initial_session_id, active_session_id);
    assert_eq!(session_title, "Untitled");
    assert_eq!(session_model, None, "new session should have no model");
    assert_eq!(
        session_agent_type, None,
        "new session should have no agent_type"
    );
    assert_eq!(session_permission_mode, "default");
}

#[test]
fn prepare_local_workspace_keeps_current_branch_when_source_is_none() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let response = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();

    assert_eq!(response.state, WorkspaceState::Ready);
    assert_eq!(response.branch, "main");
    assert_eq!(response.default_branch, "main");
    assert_eq!(response.directory_name, "");
    // Local mode: prepare returns the cwd immediately so the start-page
    // submit flow can pin it onto the pending payload without waiting for
    // the workspaceDetail React Query to settle.
    assert_eq!(
        response.working_directory.as_deref(),
        Some(harness.source_repo_root.display().to_string()).as_deref(),
    );

    let connection = Connection::open(harness.db_path()).unwrap();
    let (mode_str, state_str, branch, init_parent, target_branch): (
        String,
        String,
        String,
        String,
        String,
    ) = connection
        .query_row(
            r#"
            SELECT COALESCE(mode, 'worktree'), state, branch,
                   initialization_parent_branch, intended_target_branch
            FROM workspaces WHERE id = ?1
            "#,
            [&response.workspace_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();

    assert_eq!(mode_str, "local");
    assert_eq!(state_str, "ready");
    assert_eq!(branch, "main");
    assert_eq!(init_parent, "main");
    assert_eq!(target_branch, "main");
}

#[test]
fn prepare_local_workspace_switches_branch_when_source_differs() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.create_remote_branch_with_file("develop", "develop.txt", "from develop");

    // Repo head is currently on `main` after the harness fixture.
    let response = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        Some("develop"),
        WorkspaceStatus::InProgress,
    )
    .unwrap();

    assert_eq!(response.state, WorkspaceState::Ready);
    assert_eq!(response.branch, "develop");
    assert_eq!(response.default_branch, "main");

    // Verify the source repo's HEAD actually moved.
    let head = crate::git_ops::current_branch_name(&harness.source_repo_root).unwrap();
    assert_eq!(head, "develop");

    let connection = Connection::open(harness.db_path()).unwrap();
    let (branch, init_parent, target_branch): (String, String, String) = connection
        .query_row(
            r#"
            SELECT branch, initialization_parent_branch, intended_target_branch
            FROM workspaces WHERE id = ?1
            "#,
            [&response.workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();

    assert_eq!(branch, "develop");
    assert_eq!(init_parent, "main");
    assert_eq!(target_branch, "main");
}

#[test]
fn prepare_local_workspace_checks_out_remote_only_branch_via_dwim() {
    // Local picker shares its data source with the worktree picker
    // (`listRemoteBranches`), so the user can select a branch that
    // exists only as `refs/remotes/origin/<name>`. `git checkout` DWIM
    // is expected to auto-create a local tracking branch.
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.create_remote_branch_with_file("remote-only", "ro.txt", "remote-only");
    // Drop the local ref so only `refs/remotes/origin/remote-only` remains.
    let root = harness.source_repo_root.to_str().unwrap();
    crate::git_ops::run_git(["-C", root, "branch", "-D", "remote-only"], None).unwrap();

    let response = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        Some("remote-only"),
        WorkspaceStatus::InProgress,
    )
    .unwrap();

    assert_eq!(response.branch, "remote-only");
    assert_eq!(response.default_branch, "main");
    let head = crate::git_ops::current_branch_name(&harness.source_repo_root).unwrap();
    assert_eq!(head, "remote-only");
    // DWIM should have created a local tracking branch.
    let locals = crate::git_ops::list_local_branches(&harness.source_repo_root).unwrap();
    assert!(
        locals.iter().any(|b| b == "remote-only"),
        "expected `remote-only` local branch after DWIM checkout, got: {locals:?}"
    );
}

#[test]
fn list_branches_for_local_picker_merges_local_and_remote_deduped() {
    // Local picker should see both:
    //   - branches the user already has on disk (`refs/heads/`)
    //   - branches published on `origin` (`refs/remotes/origin/`)
    // … with names that exist on both sides shown only once.
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    // `develop` ends up both as a local branch AND `origin/develop`.
    harness.create_remote_branch_with_file("develop", "develop.txt", "from develop");
    // `remote-only` simulates a branch published on origin but not
    // checked out locally.
    harness.create_remote_branch_with_file("remote-only", "ro.txt", "remote only");
    let root = harness.source_repo_root.to_str().unwrap();
    crate::git_ops::run_git(["-C", root, "branch", "-D", "remote-only"], None).unwrap();
    // `local-only` only exists locally (not pushed to origin).
    crate::git_ops::run_git(["-C", root, "branch", "local-only", "main"], None).unwrap();

    let merged = tauri::async_runtime::block_on(
        crate::commands::workspace_commands::list_branches_for_local_picker(
            harness.repo_id.clone(),
        ),
    )
    .unwrap();

    assert!(merged.contains(&"main".to_string()));
    assert!(merged.contains(&"develop".to_string()));
    assert!(merged.contains(&"local-only".to_string()));
    assert!(merged.contains(&"remote-only".to_string()));
    // `develop` exists on both sides — it must appear only once.
    assert_eq!(merged.iter().filter(|b| *b == "develop").count(), 1);
}

#[test]
fn move_workspace_in_sidebar_updates_status_and_group_order() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.insert_workspace_name("alpha");
    harness.insert_workspace_name("bravo");
    harness.insert_workspace_name("charlie");

    workspaces::move_workspace_in_sidebar("workspace-charlie", "review", None).unwrap();
    workspaces::move_workspace_in_sidebar("workspace-alpha", "review", Some("workspace-charlie"))
        .unwrap();

    let groups = workspaces::list_workspace_groups().unwrap();
    let review = groups.iter().find(|group| group.id == "review").unwrap();
    let review_ids = review
        .rows
        .iter()
        .map(|row| row.id.as_str())
        .collect::<Vec<_>>();

    assert_eq!(review_ids, vec!["workspace-alpha", "workspace-charlie"]);

    let connection = Connection::open(harness.db_path()).unwrap();
    let (alpha_status, alpha_order): (String, i64) = connection
        .query_row(
            "SELECT status, display_order FROM workspaces WHERE id = 'workspace-alpha'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let charlie_order: i64 = connection
        .query_row(
            "SELECT display_order FROM workspaces WHERE id = 'workspace-charlie'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(alpha_status, "review");
    assert!(alpha_order < charlie_order);
}

#[test]
fn move_workspace_in_sidebar_only_updates_a_single_row_in_the_common_case() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.insert_workspace_name("alpha");
    harness.insert_workspace_name("bravo");
    harness.insert_workspace_name("charlie");

    let connection = Connection::open(harness.db_path()).unwrap();
    // Lay down a sparse grid so the midpoint insertion never needs a rebalance.
    for (index, name) in ["alpha", "bravo", "charlie"].iter().enumerate() {
        connection
            .execute(
                "UPDATE workspaces SET status = 'review', display_order = ?2 WHERE id = ?1",
                (
                    format!("workspace-{name}"),
                    ((index as i64) + 1) * sidebar_order::ORDER_STEP,
                ),
            )
            .unwrap();
    }

    let before_neighbours: Vec<(String, i64)> = connection
        .prepare(
            "SELECT id, display_order FROM workspaces WHERE id IN ('workspace-alpha', 'workspace-bravo')",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();

    workspaces::move_workspace_in_sidebar("workspace-charlie", "review", Some("workspace-bravo"))
        .unwrap();

    let after_neighbours: Vec<(String, i64)> = connection
        .prepare(
            "SELECT id, display_order FROM workspaces WHERE id IN ('workspace-alpha', 'workspace-bravo')",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    // Only the moved row should change order — its neighbours stay put.
    assert_eq!(before_neighbours, after_neighbours);

    let charlie_order: i64 = connection
        .query_row(
            "SELECT display_order FROM workspaces WHERE id = 'workspace-charlie'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // Sits between alpha (1024) and bravo (2048).
    assert!(charlie_order > sidebar_order::ORDER_STEP);
    assert!(charlie_order < 2 * sidebar_order::ORDER_STEP);
}

#[test]
fn move_workspace_in_sidebar_supports_pinning_via_drag() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.insert_workspace_name("alpha");

    workspaces::move_workspace_in_sidebar("workspace-alpha", "pinned", None).unwrap();

    let connection = Connection::open(harness.db_path()).unwrap();
    let (pinned_at, status): (Option<String>, String) = connection
        .query_row(
            "SELECT pinned_at, status FROM workspaces WHERE id = 'workspace-alpha'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(pinned_at.is_some(), "drag-to-pinned should set pinned_at");
    // status is untouched — pinning preserves the original lane.
    assert_eq!(status, "in-progress");
}

#[test]
fn move_workspace_in_sidebar_drag_out_of_pinned_clears_pinned_at() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.insert_workspace_name("alpha");

    let connection = Connection::open(harness.db_path()).unwrap();
    connection
        .execute(
            "UPDATE workspaces SET pinned_at = datetime('now') WHERE id = 'workspace-alpha'",
            [],
        )
        .unwrap();

    workspaces::move_workspace_in_sidebar("workspace-alpha", "review", None).unwrap();

    let (pinned_at, status): (Option<String>, String) = connection
        .query_row(
            "SELECT pinned_at, status FROM workspaces WHERE id = 'workspace-alpha'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(pinned_at.is_none());
    assert_eq!(status, "review");
}

#[test]
fn move_workspace_in_sidebar_rebalances_when_gap_runs_out() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.insert_workspace_name("alpha");
    harness.insert_workspace_name("bravo");
    harness.insert_workspace_name("charlie");

    let connection = Connection::open(harness.db_path()).unwrap();
    // Pack alpha + bravo adjacent so there is no midpoint between them.
    connection
        .execute(
            "UPDATE workspaces SET status = 'review', display_order = 100 WHERE id = 'workspace-alpha'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE workspaces SET status = 'review', display_order = 101 WHERE id = 'workspace-bravo'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE workspaces SET status = 'review', display_order = 2048 WHERE id = 'workspace-charlie'",
            [],
        )
        .unwrap();

    workspaces::move_workspace_in_sidebar("workspace-charlie", "review", Some("workspace-bravo"))
        .unwrap();

    let mut rows: Vec<(String, i64)> = connection
        .prepare("SELECT id, display_order FROM workspaces WHERE status = 'review'")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    rows.sort_by_key(|(_, order)| *order);
    let ids: Vec<&str> = rows.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["workspace-alpha", "workspace-charlie", "workspace-bravo"]
    );
    // After rebalance every row sits on the 1024-step grid.
    for (index, (_, order)) in rows.iter().enumerate() {
        assert_eq!(*order, ((index as i64) + 1) * sidebar_order::ORDER_STEP);
    }
}

#[test]
fn move_workspace_in_sidebar_rejects_non_target_before_workspace() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.insert_workspace_name("alpha");
    harness.insert_workspace_name("bravo");

    let error =
        workspaces::move_workspace_in_sidebar("workspace-alpha", "review", Some("workspace-bravo"))
            .unwrap_err();

    assert!(
        format!("{error:#}").contains("not reorderable in target group"),
        "expected target-group reorder error, got {error:#}"
    );

    let connection = Connection::open(harness.db_path()).unwrap();
    let alpha_status: String = connection
        .query_row(
            "SELECT status FROM workspaces WHERE id = 'workspace-alpha'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(alpha_status, "in-progress");
}

#[test]
fn move_workspace_in_sidebar_rejects_cross_repo_target() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.insert_workspace_name("alpha");

    let connection = Connection::open(harness.db_path()).unwrap();
    connection
        .execute(
            "INSERT INTO repos (id, name, root_path) VALUES ('repo-other', 'other', ?1)",
            [harness.root.join("other").to_str().unwrap()],
        )
        .unwrap();

    let error = workspaces::move_workspace_in_sidebar("workspace-alpha", "repo:repo-other", None)
        .unwrap_err();

    assert!(
        format!("{error:#}").contains("same repository")
            || format!("{error:#}").contains("own repository"),
        "expected cross-repo rejection, got {error:#}"
    );
}

#[test]
fn prepare_local_workspace_rejects_dirty_tracked_changes() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.create_remote_branch_with_file("develop", "develop.txt", "from develop");

    // Modify a tracked file → must reject.
    fs::write(harness.source_repo_root.join("tracked.txt"), "modified").unwrap();

    let err = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        Some("develop"),
        WorkspaceStatus::InProgress,
    )
    .unwrap_err();
    let msg = format!("{err:#}");
    assert!(
        msg.contains("uncommitted tracked changes"),
        "expected tracked-changes error, got: {msg}"
    );
    let head = crate::git_ops::current_branch_name(&harness.source_repo_root).unwrap();
    assert_eq!(head, "main");
}

#[test]
fn prepare_local_workspace_allows_untracked_files_when_switching_branch() {
    // Untracked files don't block — `git checkout` carries them over.
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.create_remote_branch_with_file("develop", "develop.txt", "from develop");
    fs::write(harness.source_repo_root.join("scratch.txt"), "wip").unwrap();

    let response = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        Some("develop"),
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    assert_eq!(response.branch, "develop");
    let head = crate::git_ops::current_branch_name(&harness.source_repo_root).unwrap();
    assert_eq!(head, "develop");
    assert!(harness.source_repo_root.join("scratch.txt").is_file());
}

#[test]
fn prepare_local_workspace_rolls_back_db_when_checkout_fails() {
    // Checkout failure must roll back the DB row.
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    let nonexistent = "branch-that-does-not-exist-anywhere";

    let err = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        Some(nonexistent),
        WorkspaceStatus::InProgress,
    )
    .unwrap_err();
    assert!(format!("{err:#}").to_lowercase().contains("checkout"));

    let connection = Connection::open(harness.db_path()).unwrap();
    let workspace_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
        .unwrap();
    assert_eq!(workspace_count, 0);
    let head = crate::git_ops::current_branch_name(&harness.source_repo_root).unwrap();
    assert_eq!(head, "main");
}

#[test]
fn finalize_workspace_from_repo_no_ops_for_local_workspace() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let prepared = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();

    // Already-ready workspace: finalize is a benign no-op.
    let finalized = workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();

    assert_eq!(finalized.final_state, WorkspaceState::Ready);
    // Local short-circuit still returns the cwd (== repo root). Without
    // this, the frontend submit flow couldn't reuse the same payload-patch
    // path for both modes.
    assert_eq!(
        finalized.working_directory,
        harness.source_repo_root.display().to_string(),
    );
    let _ = WorkspaceMode::Worktree; // sanity: enum is in scope
}

#[test]
fn finalize_workspace_short_circuits_for_orphaned_initializing_local_row() {
    // If `prepare_local_workspace_impl` ever fails between the
    // `Initializing` insert and the `Ready` flip, the row sits as a
    // local-mode `Initializing`. A subsequent `finalize_workspace_from_repo`
    // must NOT route that row into the worktree-creation path — that would
    // resolve `workspace_dir = repo_root` and the failure cleanup
    // (`cleanup_failed_created_workspace`) could touch the user's repo.
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    fs::write(harness.source_repo_root.join("user-file.txt"), "important").unwrap();

    let prepared = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    // Force the row back into Initializing to mimic the orphaned state.
    {
        let conn = Connection::open(harness.db_path()).unwrap();
        conn.execute(
            "UPDATE workspaces SET state = 'initializing' WHERE id = ?1",
            [&prepared.workspace_id],
        )
        .unwrap();
    }

    let finalized = workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();
    // Short-circuit returns whatever state the row is in; what matters is
    // that no worktree creation / cleanup ran.
    assert_eq!(finalized.final_state, WorkspaceState::Initializing);

    // User repo untouched: file still there, branch still `main`, no
    // `.trash-*` dirs scattered around.
    assert!(harness.source_repo_root.join("user-file.txt").is_file());
    let head = crate::git_ops::current_branch_name(&harness.source_repo_root).unwrap();
    assert_eq!(head, "main");
    let parent = harness.source_repo_root.parent().unwrap();
    let trash_count = fs::read_dir(parent)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(".trash-"))
        .count();
    assert_eq!(trash_count, 0, "no .trash-* dir should exist");
}

#[test]
fn create_workspace_from_repo_defers_setup_when_script_configured_by_default() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    // Setup script configured. auto_run_setup defaults to true (DB default
    // 1), so the workspace defers to the frontend inspector for auto-run.
    harness.commit_repo_files(&[("helmor.json", r#"{"scripts":{"setup":"echo hello"}}"#)]);

    let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

    assert_eq!(response.created_state, WorkspaceState::SetupPending);

    let connection = Connection::open(harness.db_path()).unwrap();
    let state: String = connection
        .query_row(
            "SELECT state FROM workspaces WHERE id = ?1",
            [&response.created_workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "setup_pending");
}

#[test]
fn create_workspace_from_repo_stays_ready_when_auto_run_setup_disabled() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    harness.commit_repo_files(&[("helmor.json", r#"{"scripts":{"setup":"echo hello"}}"#)]);
    repos::update_repo_auto_run_setup(&harness.repo_id, false).unwrap();

    let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

    // User opted out → workspace lands in Ready; setup runs manually.
    assert_eq!(response.created_state, WorkspaceState::Ready);
}

#[test]
fn create_workspace_from_repo_uses_v2_suffix_after_star_list_is_exhausted() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    for star_name in helpers::WORKSPACE_NAMES {
        harness.insert_workspace_name(star_name);
    }

    let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

    assert!(
        response.directory_name.ends_with("-v2"),
        "Expected -v2 suffix, got: {}",
        response.directory_name
    );
    assert!(
        response.branch.starts_with("testuser/") && response.branch.ends_with("-v2"),
        "Expected testuser/*-v2 branch, got: {}",
        response.branch
    );
}

#[test]
fn create_workspace_from_repo_cleans_up_after_worktree_failure() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    for name in helpers::WORKSPACE_NAMES {
        let dir = harness.workspace_dir(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("keep.txt"), "keep").unwrap();
    }

    let error = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap_err();

    assert!(error.to_string().contains("already exists"));

    let connection = Connection::open(harness.db_path()).unwrap();
    let (workspace_count, session_count): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM workspaces), (SELECT COUNT(*) FROM sessions)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    assert_eq!(workspace_count, 0);
    assert_eq!(session_count, 0);
}

// ---------------------------------------------------------------------------
// prepare / finalize split — direct coverage
// ---------------------------------------------------------------------------

#[test]
fn prepare_workspace_inserts_initializing_row_without_creating_worktree() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    harness.commit_repo_files(&[(
        "helmor.json",
        r#"{"scripts":{"setup":"bun install","run":"bun run dev"}}"#,
    )]);

    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();

    // DB row exists in `initializing` and matches the returned metadata.
    let connection = Connection::open(harness.db_path()).unwrap();
    let (state, directory_name, branch): (String, String, String) = connection
        .query_row(
            "SELECT state, directory_name, branch FROM workspaces WHERE id = ?1",
            [&prepared.workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(state, "initializing");
    assert_eq!(directory_name, prepared.directory_name);
    assert_eq!(branch, prepared.branch);

    let session_workspace_id: String = connection
        .query_row(
            "SELECT workspace_id FROM sessions WHERE id = ?1",
            [&prepared.initial_session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(session_workspace_id, prepared.workspace_id);

    // Worktree has NOT been created yet — that's Phase 2's job. The cwd
    // field is therefore None at prepare time; the caller MUST wait for
    // finalize before reading the path.
    let workspace_dir = harness.workspace_dir(&prepared.directory_name);
    assert!(
        !workspace_dir.exists(),
        "Phase 1 must not create the worktree"
    );
    assert!(
        prepared.working_directory.is_none(),
        "worktree mode prepare must not return a cwd before finalize",
    );

    // Repo scripts came from the source repo root's helmor.json (worktree
    // is still missing, so the 3-tier priority falls back to repo root).
    assert_eq!(
        prepared.repo_scripts.setup_script.as_deref(),
        Some("bun install")
    );
    assert_eq!(
        prepared.repo_scripts.run_script.as_deref(),
        Some("bun run dev")
    );
    assert_eq!(prepared.repo_scripts.archive_script, None);
    assert!(prepared.repo_scripts.setup_from_project);
    assert!(prepared.repo_scripts.run_from_project);
}

#[test]
fn finalize_workspace_transitions_initializing_to_ready_and_creates_worktree() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    let workspace_dir = harness.workspace_dir(&prepared.directory_name);
    assert!(!workspace_dir.exists());

    let finalized = workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();

    assert_eq!(finalized.workspace_id, prepared.workspace_id);
    assert_eq!(finalized.final_state, WorkspaceState::Ready);
    // After finalize, the worktree dir is materialised — backend hands the
    // path back so the frontend can submit the first turn against the
    // correct cwd, no React Query refetch round-trip required.
    assert_eq!(
        finalized.working_directory,
        workspace_dir.display().to_string()
    );

    // Worktree exists after Phase 2.
    assert!(workspace_dir.join(".git").exists());

    // DB row flipped to ready.
    let connection = Connection::open(harness.db_path()).unwrap();
    let state: String = connection
        .query_row(
            "SELECT state FROM workspaces WHERE id = ?1",
            [&prepared.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "ready");
}

#[test]
fn finalize_workspace_reports_setup_pending_when_helmor_json_has_setup() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    // Default behavior: auto_run_setup=true, helmor.json sets a setup script
    // → workspace defers to frontend inspector.
    harness.commit_repo_files(&[("helmor.json", r#"{"scripts":{"setup":"echo hi"}}"#)]);

    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    let finalized = workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();

    assert_eq!(finalized.final_state, WorkspaceState::SetupPending);
}

#[test]
fn finalize_workspace_stays_ready_when_helmor_json_has_setup_but_auto_run_disabled() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    harness.commit_repo_files(&[("helmor.json", r#"{"scripts":{"setup":"echo hi"}}"#)]);
    repos::update_repo_auto_run_setup(&harness.repo_id, false).unwrap();

    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    let finalized = workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();

    // User opted out → setup script is configured but the workspace lands
    // in Ready; user must run setup manually.
    assert_eq!(finalized.final_state, WorkspaceState::Ready);
}

#[test]
fn finalize_workspace_cleans_up_row_on_worktree_failure() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();

    // Pre-create the target worktree dir so finalize's guard trips.
    let workspace_dir = harness.workspace_dir(&prepared.directory_name);
    fs::create_dir_all(&workspace_dir).unwrap();
    fs::write(workspace_dir.join("squat.txt"), "squat").unwrap();

    let error = workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap_err();
    assert!(error.to_string().contains("already exists"));

    // Both rows should be gone (cascade by workspace_id).
    let connection = Connection::open(harness.db_path()).unwrap();
    let (workspace_count, session_count): (i64, i64) = connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM workspaces WHERE id = ?1),
                (SELECT COUNT(*) FROM sessions WHERE workspace_id = ?1)",
            [&prepared.workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(workspace_count, 0);
    assert_eq!(session_count, 0);
}

#[test]
fn execute_archive_plan_short_circuits_for_local_workspace() {
    // CRITICAL regression test: `execute_archive_plan` is the path used
    // by the queue / kanban-style archive flow. For local mode it MUST
    // skip the worktree removal — `remove_worktree` would rename + delete
    // the user's actual repo (since workspace_dir == repo_root).
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    let prepared = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    fs::write(harness.source_repo_root.join("user.txt"), "important").unwrap();

    // The plan looks like a normal archive plan: workspace_dir == repo_root for local.
    let plan = workspaces::prepare_archive_plan(&prepared.workspace_id).unwrap();
    let _response = workspaces::execute_archive_plan(&plan).unwrap();

    // Source repo must be intact (NOT renamed to .trash-...).
    assert!(
        harness.source_repo_root.is_dir(),
        "source repo must survive"
    );
    assert!(harness.source_repo_root.join("user.txt").is_file());

    // No `.trash-*` sibling created.
    let parent = harness.source_repo_root.parent().unwrap();
    let trash_count = fs::read_dir(parent)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with(".trash-"))
        .count();
    assert_eq!(trash_count, 0, "no trash dir should have been created");
}

#[test]
fn archive_local_workspace_only_updates_db() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    // Set up a local workspace + plant some user files. Archiving must
    // NOT touch the source repo's branch or working tree.
    let prepared = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    fs::write(harness.source_repo_root.join("user.txt"), "important").unwrap();

    let response = workspaces::archive_workspace_impl(&prepared.workspace_id).unwrap();
    assert_eq!(response.archived_state, WorkspaceState::Archived);

    // Source repo intact: file present, branch unchanged.
    assert!(harness.source_repo_root.join("user.txt").is_file());
    assert_eq!(
        crate::git_ops::current_branch_name(&harness.source_repo_root).unwrap(),
        "main"
    );

    // DB row archived.
    let connection = Connection::open(harness.db_path()).unwrap();
    let state: String = connection
        .query_row(
            "SELECT state FROM workspaces WHERE id = ?1",
            [&prepared.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "archived");
}

#[test]
fn restore_local_workspace_only_flips_state() {
    // Local restore must skip every git operation the worktree path
    // performs. The user's source repo branch + working tree must
    // remain exactly as they were before the restore call.
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let prepared = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    workspaces::archive_workspace_impl(&prepared.workspace_id).unwrap();

    // After archive, simulate the user moving on with the repo: switch
    // to a new local branch + plant uncommitted work. Restore must NOT
    // touch any of this.
    crate::git_ops::run_git(
        [
            "-C",
            harness.source_repo_root.to_str().unwrap(),
            "checkout",
            "-b",
            "user-work",
        ],
        None,
    )
    .unwrap();
    fs::write(harness.source_repo_root.join("scratch.txt"), "WIP").unwrap();

    let response = workspaces::restore_workspace_impl(&prepared.workspace_id, None).unwrap();
    assert_eq!(response.restored_state, WorkspaceState::Ready);
    assert!(
        response.branch_rename.is_none(),
        "local restore must not rename branches"
    );
    assert!(
        response.restored_from_target_branch.is_none(),
        "local restore never targets a remote branch"
    );

    // Source repo untouched: still on `user-work` with the scratch
    // file present.
    assert_eq!(
        crate::git_ops::current_branch_name(&harness.source_repo_root).unwrap(),
        "user-work"
    );
    assert!(harness.source_repo_root.join("scratch.txt").is_file());

    let connection = Connection::open(harness.db_path()).unwrap();
    let state: String = connection
        .query_row(
            "SELECT state FROM workspaces WHERE id = ?1",
            [&prepared.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "ready");
}

#[test]
fn validate_restore_local_workspace_short_circuits_to_no_conflict() {
    // The pre-restore validate query also runs on archived rows. For
    // local mode it must skip the git remote checks entirely (same
    // reason as the restore path) and report no conflict.
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let prepared = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    workspaces::archive_workspace_impl(&prepared.workspace_id).unwrap();

    let validation = workspaces::validate_restore_workspace(&prepared.workspace_id).unwrap();
    assert!(validation.target_branch_conflict.is_none());
}

#[test]
fn move_local_workspace_to_worktree_carries_uncommitted_changes() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    // Create the local workspace on main.
    let prepared = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();

    // Dirty the local repo: modify a tracked-friendly file + add an untracked.
    fs::write(
        harness.source_repo_root.join("README.md"),
        "modified by user\n",
    )
    .unwrap();
    fs::write(
        harness.source_repo_root.join("scratch.txt"),
        "untracked thoughts\n",
    )
    .unwrap();

    let response =
        workspaces::move_local_workspace_to_worktree_impl(&prepared.workspace_id).unwrap();

    // Worktree should have both: tracked change reapplied, untracked copied.
    let worktree_dir = harness.workspace_dir(&response.directory_name);
    assert!(worktree_dir.is_dir(), "worktree dir was not created");
    assert_eq!(
        fs::read_to_string(worktree_dir.join("README.md")).unwrap(),
        "modified by user\n",
    );
    assert_eq!(
        fs::read_to_string(worktree_dir.join("scratch.txt")).unwrap(),
        "untracked thoughts\n",
    );

    // Local stays untouched: same branch, dirty files still there.
    let local_head = crate::git_ops::current_branch_name(&harness.source_repo_root).unwrap();
    assert_eq!(local_head, "main");
    assert_eq!(
        fs::read_to_string(harness.source_repo_root.join("README.md")).unwrap(),
        "modified by user\n",
    );
    assert!(harness.source_repo_root.join("scratch.txt").is_file());

    // DB row flipped to worktree mode.
    let connection = Connection::open(harness.db_path()).unwrap();
    let (mode_str, branch, init_parent, target_branch, dir_name): (
        String,
        String,
        String,
        String,
        String,
    ) = connection
        .query_row(
            r#"
            SELECT COALESCE(mode, 'worktree'), branch, initialization_parent_branch,
                   intended_target_branch, directory_name
            FROM workspaces WHERE id = ?1
            "#,
            [&prepared.workspace_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(mode_str, "worktree");
    assert_eq!(branch, response.branch);
    assert_eq!(init_parent, "main");
    assert_eq!(target_branch, "main");
    assert_eq!(dir_name, response.directory_name);
}

#[test]
fn move_local_workspace_to_worktree_works_on_clean_local() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let prepared = workspaces::prepare_local_workspace_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();

    // No dirty state.
    let response =
        workspaces::move_local_workspace_to_worktree_impl(&prepared.workspace_id).unwrap();

    let worktree_dir = harness.workspace_dir(&response.directory_name);
    assert!(worktree_dir.join(".git").exists());
    // Local branch stayed put.
    let local_head = crate::git_ops::current_branch_name(&harness.source_repo_root).unwrap();
    assert_eq!(local_head, "main");
}

#[test]
fn move_local_workspace_to_worktree_rejects_worktree_mode_workspace() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();

    let err =
        workspaces::move_local_workspace_to_worktree_impl(&prepared.workspace_id).unwrap_err();
    let msg = format!("{err:#}");
    assert!(
        msg.contains("not a local workspace"),
        "unexpected error: {msg}"
    );
}

#[test]
fn create_and_checkout_branch_creates_new_local_ref_and_switches_head() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    crate::git_ops::create_and_checkout_branch(&harness.source_repo_root, "experiment/foo")
        .unwrap();

    let head = crate::git_ops::current_branch_name(&harness.source_repo_root).unwrap();
    assert_eq!(head, "experiment/foo");

    let locals = crate::git_ops::list_local_branches(&harness.source_repo_root).unwrap();
    assert!(locals.iter().any(|b| b == "experiment/foo"));
}

#[test]
fn create_and_checkout_branch_rejects_existing_branch() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.create_remote_branch_with_file("dup", "dup.txt", "dup");

    let err =
        crate::git_ops::create_and_checkout_branch(&harness.source_repo_root, "dup").unwrap_err();
    assert!(
        format!("{err:#}").contains("dup"),
        "expected 'dup' in error, got: {err}"
    );
}

#[test]
fn finalize_workspace_is_idempotent_for_ready_workspace() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    let first = workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();
    assert_eq!(first.final_state, WorkspaceState::Ready);

    // Second finalize on a ready workspace is a benign no-op (also
    // covers the local-mode flow that arrives here already past
    // initializing). Worktree itself is not touched.
    let again = workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();
    assert_eq!(again.final_state, WorkspaceState::Ready);
}

// ---------------------------------------------------------------------------
// Orphan cleanup on startup
// ---------------------------------------------------------------------------

#[test]
fn cleanup_orphaned_initializing_workspaces_purges_old_rows_and_cascades_sessions() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    // Row 1: stale initializing — should be purged.
    let stale = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    let connection = Connection::open(harness.db_path()).unwrap();
    connection
        .execute(
            "UPDATE workspaces SET created_at = datetime('now', '-1 hour') WHERE id = ?1",
            [&stale.workspace_id],
        )
        .unwrap();

    // Row 2: fresh initializing — should be kept.
    let fresh = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();

    let purged = workspaces::cleanup_orphaned_initializing_workspaces(300).unwrap();
    assert_eq!(purged, 1);

    // Stale row + its session are gone.
    let stale_exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
            [&stale.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stale_exists, 0);
    let stale_sessions: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE workspace_id = ?1",
            [&stale.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stale_sessions, 0);

    // Fresh row (still within cutoff) is kept.
    let fresh_exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
            [&fresh.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(fresh_exists, 1);
}

// ---------------------------------------------------------------------------
// Initializing-state short-circuits (drive inspector / commit-button flicker
// fix: the Phase-1 paint and the Phase-2 refetch must return identical data
// so flipping `state` from initializing → ready causes zero visible change).
// ---------------------------------------------------------------------------

#[test]
fn git_action_status_returns_fresh_defaults_for_initializing_workspace() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();

    // Worktree does not exist yet — a naive git call would error. The
    // short-circuit must catch this before we ever touch the disk.
    let workspace_dir = harness.workspace_dir(&prepared.directory_name);
    assert!(!workspace_dir.exists());

    let status = tauri::async_runtime::block_on(
        crate::commands::editor_commands::get_workspace_git_action_status(
            prepared.workspace_id.clone(),
        ),
    )
    .expect("get_workspace_git_action_status should succeed for initializing workspace");

    assert_eq!(status.uncommitted_count, 0);
    assert_eq!(status.conflict_count, 0);
    assert_eq!(status.behind_target_count, 0);
    assert_eq!(status.ahead_of_remote_count, 0);
    assert_eq!(
        status.sync_status,
        git_ops::WorkspaceSyncStatus::UpToDate,
        "fresh workspace must paint as in-sync so the Phase-2 refetch causes no visual change",
    );
    assert_eq!(
        status.push_status,
        git_ops::WorkspacePushStatus::Unpublished,
    );
}

#[test]
fn pr_lookups_short_circuit_for_initializing_workspace_without_network() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();

    // `lookup_workspace_pr` and `lookup_workspace_pr_action_status` both
    // need to short-circuit to the canonical "no PR" answer — if they
    // reached the network layer here (no GitHub auth in tests), they'd
    // fail or return an "unavailable" row that would flicker when the
    // real query lands post-ready.
    let pr = crate::github_pr::lookup_workspace_pr(&prepared.workspace_id)
        .expect("lookup_workspace_pr should succeed for initializing workspace");
    assert!(pr.is_none(), "fresh workspace cannot have a PR yet");

    let status = crate::github_pr::lookup_workspace_pr_action_status(&prepared.workspace_id)
        .expect("lookup_workspace_pr_action_status should succeed for initializing workspace");
    assert!(status.change_request.is_none());
    assert!(status.deployments.is_empty());
    assert!(status.checks.is_empty());
}

// ---------------------------------------------------------------------------
// `load_repo_scripts` three-tier priority
// (worktree helmor.json > source repo root helmor.json > DB override)
// ---------------------------------------------------------------------------

#[test]
fn load_repo_scripts_priority_1_worktree_helmor_json_wins() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    // Commit a repo-root helmor.json and seed a DB script override — both
    // should be SHADOWED by the worktree's own helmor.json.
    harness.commit_repo_files(&[(
        "helmor.json",
        r#"{"scripts":{"setup":"source-root-setup","run":"source-root-run"}}"#,
    )]);
    Connection::open(harness.db_path())
        .unwrap()
        .execute(
            "UPDATE repos SET setup_script = ?1, run_script = ?2 WHERE id = ?3",
            ("db-setup", "db-run", &harness.repo_id),
        )
        .unwrap();

    // Finalize so the worktree exists, then rewrite the worktree's
    // helmor.json to a distinctly different value.
    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();
    let worktree_dir = harness.workspace_dir(&prepared.directory_name);
    fs::write(
        worktree_dir.join("helmor.json"),
        r#"{"scripts":{"setup":"worktree-setup","run":"worktree-run"}}"#,
    )
    .unwrap();

    let scripts =
        crate::repos::load_repo_scripts(&harness.repo_id, Some(&prepared.workspace_id)).unwrap();
    assert_eq!(scripts.setup_script.as_deref(), Some("worktree-setup"));
    assert_eq!(scripts.run_script.as_deref(), Some("worktree-run"));
    assert!(scripts.setup_from_project);
    assert!(scripts.run_from_project);
}

#[test]
fn load_repo_scripts_priority_2_repo_root_wins_when_worktree_missing() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    // Repo root has helmor.json, DB has its own overrides. Workspace is
    // still in Phase 1 — worktree directory does not exist yet.
    harness.commit_repo_files(&[(
        "helmor.json",
        r#"{"scripts":{"setup":"source-root-setup"}}"#,
    )]);
    Connection::open(harness.db_path())
        .unwrap()
        .execute(
            "UPDATE repos SET setup_script = ?1, run_script = ?2 WHERE id = ?3",
            ("db-setup", "db-run", &harness.repo_id),
        )
        .unwrap();

    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    let worktree_dir = harness.workspace_dir(&prepared.directory_name);
    assert!(!worktree_dir.exists());

    let scripts =
        crate::repos::load_repo_scripts(&harness.repo_id, Some(&prepared.workspace_id)).unwrap();
    // setup: worktree absent → falls to repo root.
    assert_eq!(scripts.setup_script.as_deref(), Some("source-root-setup"));
    assert!(scripts.setup_from_project);
    // run: no project value anywhere → falls to DB.
    assert_eq!(scripts.run_script.as_deref(), Some("db-run"));
    assert!(!scripts.run_from_project);
}

#[test]
fn load_repo_scripts_priority_3_falls_through_to_db_when_no_helmor_json_anywhere() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    // Neither repo root nor worktree has a helmor.json — DB override is
    // the only source.
    Connection::open(harness.db_path())
        .unwrap()
        .execute(
            "UPDATE repos SET setup_script = ?1, run_script = ?2, archive_script = ?3 WHERE id = ?4",
            ("db-setup", "db-run", "db-archive", &harness.repo_id),
        )
        .unwrap();

    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();

    let scripts =
        crate::repos::load_repo_scripts(&harness.repo_id, Some(&prepared.workspace_id)).unwrap();
    assert_eq!(scripts.setup_script.as_deref(), Some("db-setup"));
    assert_eq!(scripts.run_script.as_deref(), Some("db-run"));
    assert_eq!(scripts.archive_script.as_deref(), Some("db-archive"));
    assert!(!scripts.setup_from_project);
    assert!(!scripts.run_from_project);
    assert!(!scripts.archive_from_project);
}

// ---------------------------------------------------------------------------
// `delete_workspace_and_session_rows` cascade isolation
// ---------------------------------------------------------------------------

#[test]
fn delete_workspace_and_session_rows_leaves_other_workspaces_intact() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    // Two sibling workspaces + sessions for the same repo.
    let keep = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    workspaces::finalize_workspace_from_repo_impl(&keep.workspace_id).unwrap();
    let drop = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    workspaces::finalize_workspace_from_repo_impl(&drop.workspace_id).unwrap();

    // Plant a session_message on each so the cascade is observable across
    // every dependent table.
    let connection = Connection::open(harness.db_path()).unwrap();
    let now = crate::models::db::current_timestamp().unwrap();
    for (session_id, workspace_id) in [
        (&keep.initial_session_id, &keep.workspace_id),
        (&drop.initial_session_id, &drop.workspace_id),
    ] {
        connection
            .execute(
                "INSERT INTO session_messages (id, session_id, role, content, created_at)
                 VALUES (?1, ?2, 'user', '{}', ?3)",
                (
                    format!("msg-{workspace_id}"),
                    session_id.as_str(),
                    now.as_str(),
                ),
            )
            .unwrap();
    }

    crate::models::workspaces::delete_workspace_and_session_rows(&drop.workspace_id).unwrap();

    // Dropped workspace + everything under it is gone.
    let (dropped_ws, dropped_sessions, dropped_msgs): (i64, i64, i64) = connection
        .query_row(
            "SELECT
                    (SELECT COUNT(*) FROM workspaces WHERE id = ?1),
                    (SELECT COUNT(*) FROM sessions WHERE workspace_id = ?1),
                    (SELECT COUNT(*) FROM session_messages WHERE session_id = ?2)",
            [&drop.workspace_id, &drop.initial_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(dropped_ws, 0);
    assert_eq!(dropped_sessions, 0);
    assert_eq!(dropped_msgs, 0);

    // Sibling workspace is fully intact — cascade must not leak across
    // workspace_id.
    let (kept_ws, kept_sessions, kept_msgs): (i64, i64, i64) = connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM workspaces WHERE id = ?1),
                (SELECT COUNT(*) FROM sessions WHERE workspace_id = ?1),
                (SELECT COUNT(*) FROM session_messages WHERE session_id = ?2)",
            [&keep.workspace_id, &keep.initial_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(kept_ws, 1);
    assert_eq!(kept_sessions, 1);
    assert_eq!(kept_msgs, 1);
}

#[test]
fn cleanup_orphaned_initializing_workspaces_skips_non_initializing_states() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    // Old but already finalized — must not be touched by the purge.
    let prepared = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::InProgress,
    )
    .unwrap();
    workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();
    let connection = Connection::open(harness.db_path()).unwrap();
    connection
        .execute(
            "UPDATE workspaces SET created_at = datetime('now', '-1 hour') WHERE id = ?1",
            [&prepared.workspace_id],
        )
        .unwrap();

    let purged = workspaces::cleanup_orphaned_initializing_workspaces(300).unwrap();
    assert_eq!(purged, 0);

    let still_exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
            [&prepared.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(still_exists, 1);
}

#[test]
fn prepare_local_workspace_with_backlog_initial_status_lands_in_backlog() {
    // Pins the contract that the `initial_status` parameter actually
    // routes through to the DB. The whole reason this parameter exists
    // is so "Save for later" on the start page can land the workspace
    // directly in Backlog instead of momentarily flashing through
    // In Progress before a follow-up `setWorkspaceStatus` flips it.
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let response =
        workspaces::prepare_local_workspace_impl(&harness.repo_id, None, WorkspaceStatus::Backlog)
            .unwrap();

    let connection = Connection::open(harness.db_path()).unwrap();
    let status: String = connection
        .query_row(
            "SELECT status FROM workspaces WHERE id = ?1",
            [&response.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "backlog");
}

#[test]
fn prepare_workspace_from_repo_with_backlog_initial_status_lands_in_backlog() {
    // Same contract on the worktree path. Both impls share the same
    // DB writer (`insert_initializing_workspace_and_session_with_mode`),
    // but pinning both surfaces guards against a future refactor that
    // accidentally hard-codes "in-progress" on one of them.
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let response = workspaces::prepare_workspace_from_repo_impl(
        &harness.repo_id,
        None,
        WorkspaceStatus::Backlog,
    )
    .unwrap();

    let connection = Connection::open(harness.db_path()).unwrap();
    let status: String = connection
        .query_row(
            "SELECT status FROM workspaces WHERE id = ?1",
            [&response.workspace_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "backlog");
}
