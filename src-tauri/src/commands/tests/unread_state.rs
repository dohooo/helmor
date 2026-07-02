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

/// WP4 / S5: per-member unread must exclude the member's OWN rows, but must NOT
/// exclude `author_id IS NULL` rows (agent/assistant/system output). The
/// author dimension is isolated from the timestamp dimension here (that one is
/// covered by `per_member_unread_is_independent_and_timestamp_driven`): most
/// assertions run with no read cursor (`COALESCE ''` ⇒ every row counts unless
/// excluded by author).
#[test]
fn per_member_unread_excludes_self_authored() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

    let ws = harness.workspace_id.clone();
    let unread_for = |member: &str| {
        crate::models::workspaces::load_member_unread_counts(member)
            .unwrap()
            .get(&ws)
            .copied()
            .unwrap_or(0)
    };

    // member-1's own room-chat message. It must never count as unread for its
    // author (S5), but a teammate still sees the session as unread.
    connection
        .execute(
            "INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, author_id) \
             VALUES ('msg-self-1', ?1, 'user', '{\"type\":\"room_chat\",\"text\":\"hi\"}', '2020-01-01 00:00:00', '2020-01-01 00:00:00', 'member-1')",
            [&harness.session_id],
        )
        .unwrap();
    assert_eq!(
        unread_for("member-1"),
        0,
        "a member's own message is excluded from their own unread (S5)"
    );
    assert!(
        unread_for("member-2") >= 1,
        "…but a teammate still sees that message as unread"
    );

    // Agent/assistant reply carries `author_id IS NULL`. It is "not mine" for
    // everyone and MUST still count — the NULL pitfall guard: `NULL <> 'member-1'`
    // is NULL(false) in SQL, so the predicate is `author_id IS NULL OR <>`.
    connection
        .execute(
            "INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at) \
             VALUES ('msg-agent-1', ?1, 'assistant', '{}', '2020-01-02 00:00:00', '2020-01-02 00:00:00')",
            [&harness.session_id],
        )
        .unwrap();
    assert!(
        unread_for("member-1") >= 1,
        "an agent reply (NULL author) lights the dot even for the sender"
    );
    assert!(
        unread_for("member-2") >= 1,
        "the NULL-author reply counts for the teammate too"
    );

    // member-1 catches up (cursor = now, past the 2020 rows): their own row was
    // never counted and the agent row is now below the cursor ⇒ back to 0.
    sessions::mark_session_read_for_member(&harness.session_id, "member-1").unwrap();
    assert_eq!(
        unread_for("member-1"),
        0,
        "member-1 caught up after reading"
    );

    // A NEW self message AFTER the cursor must not resurrect member-1's own dot —
    // author-exclusion is independent of the timestamp (the S5 core: self-send
    // never re-lights your own green dot, even post-read).
    connection
        .execute(
            "INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, author_id) \
             VALUES ('msg-self-2', ?1, 'user', '{\"type\":\"room_chat\",\"text\":\"again\"}', '2099-01-01 00:00:00', '2099-01-01 00:00:00', 'member-1')",
            [&harness.session_id],
        )
        .unwrap();
    assert_eq!(
        unread_for("member-1"),
        0,
        "a post-cursor self message is still excluded for its author (S5 core)"
    );
    assert!(
        unread_for("member-2") >= 1,
        "the teammate, who never read, still sees unread content"
    );
}
