use super::support::*;
use crate::workspace_state::WorkspaceState;

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

    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();

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

    // Worktree has NOT been created yet — that's Phase 2's job.
    let workspace_dir = harness.workspace_dir(&prepared.directory_name);
    assert!(
        !workspace_dir.exists(),
        "Phase 1 must not create the worktree"
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

    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();
    let workspace_dir = harness.workspace_dir(&prepared.directory_name);
    assert!(!workspace_dir.exists());

    let finalized = workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();

    assert_eq!(finalized.workspace_id, prepared.workspace_id);
    assert_eq!(finalized.final_state, WorkspaceState::Ready);

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

    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();
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

    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();
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

    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();

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
fn finalize_workspace_refuses_non_initializing_workspace() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();
    workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap();

    // Second finalize on the same (now ready) workspace must reject —
    // the state guard protects against accidental double-finalize that
    // would try to recreate an existing worktree.
    let error = workspaces::finalize_workspace_from_repo_impl(&prepared.workspace_id).unwrap_err();
    assert!(
        error.to_string().contains("initializing"),
        "Expected guard error, got: {error}"
    );
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
    let stale = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();
    let connection = Connection::open(harness.db_path()).unwrap();
    connection
        .execute(
            "UPDATE workspaces SET created_at = datetime('now', '-1 hour') WHERE id = ?1",
            [&stale.workspace_id],
        )
        .unwrap();

    // Row 2: fresh initializing — should be kept.
    let fresh = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();

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

    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();

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

    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();

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
    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();
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

    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();
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

    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();
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
    let keep = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();
    workspaces::finalize_workspace_from_repo_impl(&keep.workspace_id).unwrap();
    let drop = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();
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
    let prepared = workspaces::prepare_workspace_from_repo_impl(&harness.repo_id).unwrap();
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
