use super::support::*;

#[test]
fn create_workspace_from_repo_creates_ready_workspace_and_initial_session() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

    // No setup script → goes straight to "ready".
    assert_eq!(response.created_state, "ready");
    assert!(
        helpers::WORKSPACE_NAMES.contains(&response.directory_name.as_str()),
        "Expected a name from WORKSPACE_NAMES, got: {}",
        response.directory_name
    );
    assert!(
        response.branch.starts_with("caspian/"),
        "Expected caspian/ prefix, got: {}",
        response.branch
    );

    let workspace_dir = harness.workspace_dir(&response.directory_name);
    assert!(workspace_dir.join(".git").exists());
    assert!(workspace_dir.join(".context/notes.md").exists());
    assert!(workspace_dir.join(".context/todos.md").exists());
    assert!(workspace_dir.join(".context/attachments").is_dir());

    let connection = Connection::open(harness.db_path()).unwrap();
    let (
        state,
        branch,
        placeholder_branch_name,
        initialization_parent_branch,
        intended_target_branch,
        initialization_files_copied,
        active_session_id,
    ): (String, String, String, String, String, i64, String) = connection
        .query_row(
            r#"
            SELECT state, branch, placeholder_branch_name, initialization_parent_branch,
              intended_target_branch, initialization_files_copied,
              active_session_id
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
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .unwrap();
    let (session_title, session_model, session_agent_type, session_permission_mode, thinking_enabled): (
        String,
        Option<String>,
        Option<String>,
        String,
        i64,
    ) = connection
        .query_row(
            "SELECT title, model, agent_type, permission_mode, thinking_enabled FROM sessions WHERE id = ?1",
            [&active_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();

    assert_eq!(state, "ready");
    assert!(
        branch.starts_with("caspian/"),
        "Expected caspian/ prefix, got: {branch}"
    );
    assert_eq!(branch, placeholder_branch_name);
    assert_eq!(initialization_parent_branch, "main");
    assert_eq!(intended_target_branch, "main");
    assert!(initialization_files_copied > 0);
    assert_eq!(session_title, "Untitled");
    assert_eq!(session_model, None, "new session should have no model");
    assert_eq!(
        session_agent_type, None,
        "new session should have no agent_type"
    );
    assert_eq!(session_permission_mode, "default");
    assert_eq!(thinking_enabled, 1);
}

#[test]
fn create_workspace_from_repo_defers_setup_when_script_configured() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    harness.commit_repo_files(&[("helmor.json", r#"{"scripts":{"setup":"echo hello"}}"#)]);

    let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

    // Setup script detected → deferred to frontend inspector.
    assert_eq!(response.created_state, "setup_pending");

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
        response.branch.starts_with("caspian/") && response.branch.ends_with("-v2"),
        "Expected caspian/*-v2 branch, got: {}",
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
