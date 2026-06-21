use super::support::*;

#[test]
fn workspace_record_marks_unread_when_session_has_unread_even_if_workspace_flag_is_clear() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();
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
    assert_eq!(record.unread_session_count, 1);
}

#[test]
fn archived_workspace_summary_reports_unread_state() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = RestoreTestHarness::new();
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
    assert_eq!(summary.unread_session_count, 1);
}

#[test]
fn mark_session_read_clears_session_and_workspace_unread() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();
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
fn mark_session_unread_bumps_only_the_session() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();
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

    sessions::mark_session_unread(&harness.session_id).unwrap();

    let (session_unread, workspace_unread): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT unread_count FROM sessions WHERE id = ?1), (SELECT unread FROM workspaces WHERE id = ?2)",
            (&harness.session_id, &harness.workspace_id),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    // Session unread is an independent signal — bumping the session must not
    // touch the workspace flag. `has_unread` picks up the session via the
    // derived OR.
    assert_eq!(session_unread, 1);
    assert_eq!(workspace_unread, 0);

    // Idempotent — second call must not drift the counter.
    sessions::mark_session_unread(&harness.session_id).unwrap();
    let session_unread_again: i64 = connection
        .query_row(
            "SELECT unread_count FROM sessions WHERE id = ?1",
            [&harness.session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(session_unread_again, 1);
}

#[test]
fn mark_workspace_unread_sets_workspace_flag_directly() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();
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

    let (session_unread, workspace_unread): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT unread_count FROM sessions WHERE id = ?1), (SELECT unread FROM workspaces WHERE id = ?2)",
            (&harness.session_id, &harness.workspace_id),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    // Workspace flag is now independent: setting it must not touch sessions.
    assert_eq!(session_unread, 0);
    assert_eq!(workspace_unread, 1);
}

#[test]
fn mark_workspace_read_clears_workspace_flag_and_all_session_unread() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

    connection
        .execute(
            "UPDATE sessions SET unread_count = 2 WHERE id = ?1",
            [&harness.session_id],
        )
        .unwrap();
    connection
        .execute(
            r#"
            INSERT INTO sessions (
              id, workspace_id, title, agent_type, status, model, permission_mode,
              unread_count, fast_mode
            ) VALUES ('session-read-all-2', ?1, 'Second session', 'claude', 'idle', 'opus', 'default', 1, 0)
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

    let (workspace_unread, unread_sessions): (i64, i64) = connection
        .query_row(
            r#"
            SELECT
              (SELECT unread FROM workspaces WHERE id = ?1),
              (SELECT COUNT(*) FROM sessions WHERE workspace_id = ?1 AND COALESCE(unread_count, 0) > 0)
            "#,
            [&harness.workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    assert_eq!(workspace_unread, 0);
    assert_eq!(unread_sessions, 0);
}

#[test]
fn mark_session_read_preserves_workspace_unread_while_other_sessions_stay_unread() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

    // Two sessions, both unread; workspace flag also set independently.
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
              unread_count, fast_mode
            ) VALUES ('session-archive-2', ?1, 'Second session', 'claude', 'idle', 'opus', 'default', 2, 0)
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

    // Clear the first session only.
    sessions::mark_session_read(&harness.session_id).unwrap();

    let (first_unread, second_unread, workspace_unread): (i64, i64, i64) = connection
        .query_row(
            "SELECT \
                (SELECT unread_count FROM sessions WHERE id = ?1), \
                (SELECT unread_count FROM sessions WHERE id = 'session-archive-2'), \
                (SELECT unread FROM workspaces WHERE id = ?2)",
            (&harness.session_id, &harness.workspace_id),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();

    assert_eq!(first_unread, 0);
    assert_eq!(second_unread, 2);
    // Workspace flag must stay because the second session still has unread.
    assert_eq!(workspace_unread, 1);
}

#[test]
fn hide_session_clears_its_unread_and_drops_workspace_flag() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

    // Only session in the workspace has unread; workspace flag is derived on.
    connection
        .execute(
            "UPDATE sessions SET unread_count = 3 WHERE id = ?1",
            [&harness.session_id],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE workspaces SET unread = 1 WHERE id = ?1",
            [&harness.workspace_id],
        )
        .unwrap();

    sessions::hide_session(&harness.session_id).unwrap();

    let (session_unread, workspace_unread): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT unread_count FROM sessions WHERE id = ?1), (SELECT unread FROM workspaces WHERE id = ?2)",
            (&harness.session_id, &harness.workspace_id),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    // Hidden session's unread must be wiped (the user can't reach it).
    assert_eq!(session_unread, 0);
    // And the workspace flag should drop because nothing is unread any more.
    assert_eq!(workspace_unread, 0);
}

#[test]
fn per_member_unread_is_independent_and_timestamp_driven() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

    // A message older than any read cursor exists in the harness session.
    connection
        .execute(
            "INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at) \
             VALUES ('msg-pm-1', ?1, 'user', '{}', '2020-01-01 00:00:00', '2020-01-01 00:00:00')",
            [&harness.session_id],
        )
        .unwrap();

    let ws = harness.workspace_id.clone();
    let unread_for = |member: &str| {
        crate::models::workspaces::load_member_unread_counts(member)
            .unwrap()
            .get(&ws)
            .copied()
            .unwrap_or(0)
    };

    // Nobody has read yet → both members see the session as unread.
    assert!(unread_for("member-1") >= 1);
    assert!(unread_for("member-2") >= 1);

    // member-1 opens the session → their cursor advances past the message.
    sessions::mark_session_read_for_member(&harness.session_id, "member-1").unwrap();

    // Per-member: member-1 is caught up, member-2 is still behind.
    assert_eq!(unread_for("member-1"), 0, "member-1 caught up");
    assert!(unread_for("member-2") >= 1, "member-2 still behind");

    // A NEW message (after member-1's cursor) flips member-1 back to unread —
    // the timestamp model needs no explicit unread write.
    connection
        .execute(
            "INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at) \
             VALUES ('msg-pm-2', ?1, 'user', '{}', '2099-01-01 00:00:00', '2099-01-01 00:00:00')",
            [&harness.session_id],
        )
        .unwrap();
    assert!(
        unread_for("member-1") >= 1,
        "a newer message re-marks member-1 unread"
    );
}
