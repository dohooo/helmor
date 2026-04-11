use super::support::*;

#[test]
fn workspace_record_marks_unread_when_session_has_unread_even_if_workspace_flag_is_clear() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(true);
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

    connection
        .execute(
            "UPDATE sessions SET unread_count = 1 WHERE id = ?1",
            [&harness.session_id],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE workspaces SET unread = 0 WHERE id = ?1",
            [&harness.workspace_id],
        )
        .unwrap();

    let record = crate::models::workspaces::load_workspace_record_by_id(&harness.workspace_id)
        .unwrap()
        .unwrap();

    assert!(record.has_unread);
    assert_eq!(record.workspace_unread, 0);
    assert_eq!(record.session_unread_total, 1);
    assert_eq!(record.unread_session_count, 1);
}

#[test]
fn archived_workspace_summary_reports_unread_state() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = RestoreTestHarness::new(true);
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

    connection
        .execute(
            "UPDATE sessions SET unread_count = 1 WHERE id = ?1",
            [&harness.session_id],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE workspaces SET unread = 0 WHERE id = ?1",
            [&harness.workspace_id],
        )
        .unwrap();

    let record = crate::models::workspaces::load_workspace_record_by_id(&harness.workspace_id)
        .unwrap()
        .unwrap();
    let summary = workspaces::record_to_summary(record);

    assert!(summary.has_unread);
    assert_eq!(summary.session_unread_total, 1);
    assert_eq!(summary.unread_session_count, 1);
}

#[test]
fn mark_session_read_clears_session_and_workspace_unread() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(true);
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

    connection
        .execute(
            "UPDATE sessions SET unread_count = 1 WHERE id = ?1",
            [&harness.session_id],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE workspaces SET unread = 1 WHERE id = ?1",
            [&harness.workspace_id],
        )
        .unwrap();

    sessions::mark_session_read(&harness.session_id).unwrap();

    let (session_unread, workspace_unread): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT unread_count FROM sessions WHERE id = ?1), (SELECT unread FROM workspaces WHERE id = ?2)",
            (&harness.session_id, &harness.workspace_id),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    assert_eq!(session_unread, 0);
    assert_eq!(workspace_unread, 0);
}

#[test]
fn mark_workspace_read_clears_all_workspace_sessions() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(true);
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

    connection
        .execute(
            "UPDATE sessions SET unread_count = 1 WHERE id = ?1",
            [&harness.session_id],
        )
        .unwrap();
    connection
        .execute(
            r#"
            INSERT INTO sessions (
              id, workspace_id, title, agent_type, status, model, permission_mode,
              provider_session_id, unread_count, context_token_count, context_used_percent,
              thinking_enabled, fast_mode, agent_personality,
              created_at, updated_at, last_user_message_at, resume_session_at,
              is_hidden, is_compacting
            ) VALUES ('session-archive-2', ?1, 'Second session', 'claude', 'idle', 'opus', 'default', NULL, 2, 0, NULL, 0, 0, 'none', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 0, 0)
            "#,
            [&harness.workspace_id],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE workspaces SET unread = 1 WHERE id = ?1",
            [&harness.workspace_id],
        )
        .unwrap();

    workspaces::mark_workspace_read(&harness.workspace_id).unwrap();

    let (session_unread_total, workspace_unread): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT COALESCE(SUM(unread_count), 0) FROM sessions WHERE workspace_id = ?1), (SELECT unread FROM workspaces WHERE id = ?1)",
            [&harness.workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    assert_eq!(session_unread_total, 0);
    assert_eq!(workspace_unread, 0);
}

#[test]
fn mark_workspace_unread_sets_workspace_flag_without_touching_sessions() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new(true);
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

    connection
        .execute(
            "UPDATE sessions SET unread_count = 0 WHERE id = ?1",
            [&harness.session_id],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE workspaces SET unread = 0 WHERE id = ?1",
            [&harness.workspace_id],
        )
        .unwrap();

    workspaces::mark_workspace_unread(&harness.workspace_id).unwrap();

    let (session_unread_total, workspace_unread): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT COALESCE(SUM(unread_count), 0) FROM sessions WHERE workspace_id = ?1), (SELECT unread FROM workspaces WHERE id = ?1)",
            [&harness.workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    assert_eq!(session_unread_total, 0);
    assert_eq!(workspace_unread, 1);
}
