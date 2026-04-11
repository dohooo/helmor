use super::support::*;

#[test]
fn create_workspace_from_repo_creates_ready_workspace_and_initial_session() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    harness.commit_repo_files(&[
        (
            "conductor.json",
            r#"{"scripts":{"setup":"$CONDUCTOR_ROOT_PATH/conductor-setup.sh"}}"#,
        ),
        (
            "conductor-setup.sh",
            "#!/bin/sh\nset -e\nprintf '%s' \"$CONDUCTOR_ROOT_PATH\" > \"$CONDUCTOR_WORKSPACE_PATH/.context/setup-root.txt\"\nprintf 'json' > \"$CONDUCTOR_WORKSPACE_PATH/setup-from-json.txt\"\n",
        ),
    ]);

    let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

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
    assert!(workspace_dir.join(".context/setup-root.txt").exists());
    assert!(workspace_dir.join("setup-from-json.txt").exists());

    let connection = Connection::open(harness.db_path()).unwrap();
    let (
        state,
        branch,
        placeholder_branch_name,
        initialization_parent_branch,
        intended_target_branch,
        initialization_files_copied,
        setup_log_path,
        initialization_log_path,
        active_session_id,
    ): (
        String,
        String,
        String,
        String,
        String,
        i64,
        String,
        String,
        String,
    ) = connection
        .query_row(
            r#"
            SELECT state, branch, placeholder_branch_name, initialization_parent_branch,
              intended_target_branch, initialization_files_copied, setup_log_path,
              initialization_log_path, active_session_id
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
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .unwrap();
    let (session_title, session_model, session_permission_mode, thinking_enabled): (
        String,
        String,
        String,
        i64,
    ) = connection
        .query_row(
            "SELECT title, model, permission_mode, thinking_enabled FROM sessions WHERE id = ?1",
            [&active_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
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
    assert!(Path::new(&setup_log_path).is_file());
    assert!(Path::new(&initialization_log_path).is_file());
    assert_eq!(session_title, "Untitled");
    assert_eq!(session_model, "opus");
    assert_eq!(session_permission_mode, "default");
    assert_eq!(thinking_enabled, 1);
}

#[test]
fn create_workspace_from_repo_prefers_repo_setup_script_over_conductor_json() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();
    harness.set_repo_setup_script(Some("$CONDUCTOR_ROOT_PATH/repo-settings-setup.sh"));
    harness.commit_repo_files(&[
        (
            "conductor.json",
            r#"{"scripts":{"setup":"$CONDUCTOR_ROOT_PATH/conductor-setup.sh"}}"#,
        ),
        (
            "conductor-setup.sh",
            "#!/bin/sh\nset -e\nprintf 'json' > \"$CONDUCTOR_WORKSPACE_PATH/json-setup.txt\"\n",
        ),
        (
            "repo-settings-setup.sh",
            "#!/bin/sh\nset -e\nprintf 'repo' > \"$CONDUCTOR_WORKSPACE_PATH/repo-setup.txt\"\n",
        ),
    ]);

    let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();
    let workspace_dir = harness.workspace_dir(&response.directory_name);

    assert!(workspace_dir.join("repo-setup.txt").exists());
    assert!(!workspace_dir.join("json-setup.txt").exists());
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

#[test]
fn create_workspace_from_repo_cleans_up_after_setup_failure_and_keeps_logs() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = CreateTestHarness::new();

    harness.commit_repo_files(&[
        (
            "conductor.json",
            r#"{"scripts":{"setup":"$CONDUCTOR_ROOT_PATH/conductor-setup.sh"}}"#,
        ),
        (
            "conductor-setup.sh",
            "#!/bin/sh\nset -e\necho 'failing setup'\nexit 7\n",
        ),
    ]);

    let error = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap_err();

    assert!(error.to_string().contains("Setup script failed"));
    assert!(!harness.workspace_dir("acamar").exists());

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

    let log_root = crate::data_dir::logs_dir().unwrap().join("workspaces");
    let mut log_files = fs::read_dir(&log_root)
        .unwrap()
        .flat_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    log_files.sort();

    assert!(!log_files.is_empty());
    let setup_log = log_files[0].join("setup.log");
    assert!(setup_log.is_file());
    let setup_log_contents = fs::read_to_string(setup_log).unwrap();
    assert!(setup_log_contents.contains("failing setup"));
}
