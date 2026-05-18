//! Coverage for `primary_session` / `last_user_message_at` in
//! `WORKSPACE_RECORD_SQL`. Exercises the selection rules driving the
//! sidebar hover card's title + live preview pick.

use super::support::*;

/// Insert an extra session row directly. Defaults match the production
/// schema's column nullability so each test can override only the
/// fields it cares about.
#[allow(clippy::too_many_arguments)]
fn insert_session(
    workspace_id: &str,
    session_id: &str,
    title: &str,
    is_hidden: bool,
    action_kind: Option<&str>,
    updated_at: &str,
    last_user_message_at: Option<&str>,
) {
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    connection
        .execute(
            r#"
            INSERT INTO sessions (
              id, workspace_id, title, status, permission_mode,
              unread_count, fast_mode, created_at, updated_at,
              last_user_message_at, is_hidden, action_kind
            ) VALUES (?1, ?2, ?3, 'idle', 'default', 0, 0, ?4, ?4, ?5, ?6, ?7)
            "#,
            rusqlite::params![
                session_id,
                workspace_id,
                title,
                updated_at,
                last_user_message_at,
                if is_hidden { 1 } else { 0 },
                action_kind,
            ],
        )
        .unwrap();
}

/// Append `count` synthetic messages to a session.
fn insert_messages(session_id: &str, count: usize) {
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    for i in 0..count {
        connection
            .execute(
                r#"
                INSERT INTO session_messages (
                  id, session_id, role, content, sent_at
                ) VALUES (?1, ?2, 'assistant', '{"type":"text"}', ?3)
                "#,
                rusqlite::params![
                    format!("{session_id}-msg-{i}"),
                    session_id,
                    format!("2025-01-01T00:00:{:02}Z", i % 60),
                ],
            )
            .unwrap();
    }
}

#[test]
fn primary_session_picks_session_with_most_messages() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();

    // Harness already created session-archive; give it 3 messages.
    insert_messages(&harness.session_id, 3);
    // Bigger session in same workspace.
    insert_session(
        &harness.workspace_id,
        "convo-big",
        "Real conversation",
        false,
        None,
        "2025-01-02T10:00:00Z",
        Some("2025-01-02T10:00:00Z"),
    );
    insert_messages("convo-big", 25);

    let record = crate::models::workspaces::load_workspace_record_by_id(&harness.workspace_id)
        .unwrap()
        .unwrap();

    assert_eq!(record.primary_session_id.as_deref(), Some("convo-big"));
    assert_eq!(
        record.primary_session_title.as_deref(),
        Some("Real conversation"),
    );
}

#[test]
fn primary_session_excludes_hidden_sessions_even_when_largest() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();
    insert_messages(&harness.session_id, 4);

    // Hidden session has way more messages but should be ignored.
    insert_session(
        &harness.workspace_id,
        "hidden-noise",
        "Internal trace",
        true,
        None,
        "2025-01-02T10:00:00Z",
        None,
    );
    insert_messages("hidden-noise", 99);

    let record = crate::models::workspaces::load_workspace_record_by_id(&harness.workspace_id)
        .unwrap()
        .unwrap();

    assert_eq!(
        record.primary_session_id.as_deref(),
        Some(&*harness.session_id)
    );
}

#[test]
fn primary_session_excludes_action_sessions_even_when_largest() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();
    insert_messages(&harness.session_id, 2);

    // Action-kind session piles up messages from the verifier prompts;
    // it should not masquerade as the workspace's main conversation.
    insert_session(
        &harness.workspace_id,
        "action-pr",
        "Create PR",
        false,
        Some("create-pr"),
        "2025-01-02T10:00:00Z",
        None,
    );
    insert_messages("action-pr", 50);

    let record = crate::models::workspaces::load_workspace_record_by_id(&harness.workspace_id)
        .unwrap()
        .unwrap();

    assert_eq!(
        record.primary_session_id.as_deref(),
        Some(&*harness.session_id)
    );
}

#[test]
fn primary_session_falls_back_to_most_recent_when_message_counts_tie() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();

    // Same message count (3) on the harness session and a peer; the
    // peer is *more recently updated* and should win on tie-break.
    // The "2099" timestamp is intentionally far in the future so it
    // sorts after the harness's `created_at`/`updated_at` (current `now()`)
    // regardless of when the test runs.
    insert_messages(&harness.session_id, 3);
    insert_session(
        &harness.workspace_id,
        "convo-newer",
        "Newer chat",
        false,
        None,
        "2099-01-01T00:00:00Z",
        Some("2099-01-01T00:00:00Z"),
    );
    insert_messages("convo-newer", 3);

    let record = crate::models::workspaces::load_workspace_record_by_id(&harness.workspace_id)
        .unwrap()
        .unwrap();

    assert_eq!(record.primary_session_id.as_deref(), Some("convo-newer"));
}

#[test]
fn primary_session_is_none_when_only_hidden_or_action_sessions_exist() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();

    // Mark the seeded session as hidden; only an action-kind session remains.
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    connection
        .execute(
            "UPDATE sessions SET is_hidden = 1 WHERE id = ?1",
            [&harness.session_id],
        )
        .unwrap();
    insert_session(
        &harness.workspace_id,
        "action-only",
        "Commit and push",
        false,
        Some("commit-and-push"),
        "2025-02-01T00:00:00Z",
        None,
    );

    let record = crate::models::workspaces::load_workspace_record_by_id(&harness.workspace_id)
        .unwrap()
        .unwrap();

    assert!(record.primary_session_id.is_none());
    assert!(record.primary_session_title.is_none());
}

#[test]
fn last_user_message_at_is_max_across_all_sessions_in_workspace() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();

    // Seed the harness session with an older user-message timestamp.
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    connection
        .execute(
            "UPDATE sessions SET last_user_message_at = ?2 WHERE id = ?1",
            (&harness.session_id, "2025-01-01T00:00:00Z"),
        )
        .unwrap();

    // A peer session (even hidden) with a much newer message — `MAX` over
    // all sessions, regardless of visibility, should expose this one.
    insert_session(
        &harness.workspace_id,
        "peer",
        "peer",
        true,
        None,
        "2025-06-15T12:00:00Z",
        Some("2025-06-15T12:00:00Z"),
    );

    let record = crate::models::workspaces::load_workspace_record_by_id(&harness.workspace_id)
        .unwrap()
        .unwrap();

    assert_eq!(
        record.last_user_message_at.as_deref(),
        Some("2025-06-15T12:00:00Z"),
    );
}

#[test]
fn workspace_message_count_sums_across_all_sessions() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = ArchiveTestHarness::new();

    insert_messages(&harness.session_id, 4);
    insert_session(
        &harness.workspace_id,
        "extra",
        "Extra",
        false,
        None,
        "2025-03-01T00:00:00Z",
        None,
    );
    insert_messages("extra", 7);

    let record = crate::models::workspaces::load_workspace_record_by_id(&harness.workspace_id)
        .unwrap()
        .unwrap();

    assert_eq!(record.message_count, 11);
    assert_eq!(record.session_count, 2);
}
