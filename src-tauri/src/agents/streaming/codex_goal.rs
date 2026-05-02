//! Persist `codexGoalUpdated` sidecar events into the session row and
//! broadcast a `CodexGoalChanged` UI mutation. Frontend reads the meta
//! through React Query — the channel only carries the invalidation cue.

use rusqlite::params;
use serde_json::Value;
use tauri::AppHandle;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum CodexGoalWriteOutcome {
    /// Malformed event (missing/empty sessionId).
    Skipped,
    /// Event valid, DB row updated. `Some(json)` = active goal,
    /// `None` = goal cleared.
    Wrote(String),
    /// Session row not found — likely a stale/post-delete event.
    UnknownSession(String),
}

pub(super) fn write_codex_goal_meta(
    conn: &rusqlite::Connection,
    raw: &Value,
) -> std::result::Result<CodexGoalWriteOutcome, rusqlite::Error> {
    let Some(session_id) = raw.get("sessionId").and_then(Value::as_str) else {
        return Ok(CodexGoalWriteOutcome::Skipped);
    };
    if session_id.is_empty() {
        return Ok(CodexGoalWriteOutcome::Skipped);
    }
    // `goal` is either a stringified ThreadGoal JSON or null/absent
    // (cleared). Anything else is malformed.
    let goal = raw.get("goal");
    let value: Option<&str> = match goal {
        Some(Value::String(s)) => Some(s.as_str()),
        Some(Value::Null) | None => None,
        _ => return Ok(CodexGoalWriteOutcome::Skipped),
    };
    let affected = conn.execute(
        "UPDATE sessions SET codex_goal_meta = ?1 WHERE id = ?2",
        params![value, session_id],
    )?;
    if affected == 0 {
        return Ok(CodexGoalWriteOutcome::UnknownSession(
            session_id.to_string(),
        ));
    }
    Ok(CodexGoalWriteOutcome::Wrote(session_id.to_string()))
}

pub(super) fn persist_codex_goal_event(app: &AppHandle, raw: &Value) {
    let outcome = match crate::models::db::write_conn() {
        Ok(conn) => match write_codex_goal_meta(&conn, raw) {
            Ok(outcome) => outcome,
            Err(err) => {
                tracing::warn!("Failed to persist codex_goal_meta: {err}");
                return;
            }
        },
        Err(err) => {
            tracing::warn!("codex_goal write_conn borrow failed: {err}");
            return;
        }
    };
    let session_id = match outcome {
        CodexGoalWriteOutcome::Skipped => {
            tracing::warn!("codexGoalUpdated event malformed (missing sessionId)");
            return;
        }
        CodexGoalWriteOutcome::UnknownSession(id) => {
            tracing::warn!(
                session_id = %id,
                "codexGoalUpdated for unknown session — likely a stale/post-delete event"
            );
            return;
        }
        CodexGoalWriteOutcome::Wrote(id) => id,
    };
    crate::ui_sync::publish(
        app,
        crate::ui_sync::UiMutationEvent::CodexGoalChanged { session_id },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db_with_session(session_id: &str) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status) VALUES (?1, 'w1', 'idle')",
            [session_id],
        )
        .unwrap();
        conn
    }

    fn read_meta(conn: &rusqlite::Connection, session_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT codex_goal_meta FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap()
    }

    #[test]
    fn writes_active_goal_json() {
        let conn = open_test_db_with_session("s1");
        let raw = serde_json::json!({
            "sessionId": "s1",
            "goal": r#"{"objective":"refactor","status":"active","tokensUsed":100}"#,
        });
        let outcome = write_codex_goal_meta(&conn, &raw).unwrap();
        assert_eq!(outcome, CodexGoalWriteOutcome::Wrote("s1".to_string()));
        assert!(read_meta(&conn, "s1").unwrap().contains("\"objective\""));
    }

    #[test]
    fn null_goal_clears_the_column() {
        let conn = open_test_db_with_session("s1");
        conn.execute(
            "UPDATE sessions SET codex_goal_meta = '{}' WHERE id = 's1'",
            [],
        )
        .unwrap();
        let raw = serde_json::json!({ "sessionId": "s1", "goal": null });
        let outcome = write_codex_goal_meta(&conn, &raw).unwrap();
        assert_eq!(outcome, CodexGoalWriteOutcome::Wrote("s1".to_string()));
        assert_eq!(read_meta(&conn, "s1"), None);
    }

    #[test]
    fn missing_session_id_skips() {
        let conn = open_test_db_with_session("s1");
        for raw in [
            serde_json::json!({}),
            serde_json::json!({ "sessionId": "" }),
            serde_json::json!({ "sessionId": null, "goal": "{}" }),
        ] {
            let outcome = write_codex_goal_meta(&conn, &raw).unwrap();
            assert_eq!(outcome, CodexGoalWriteOutcome::Skipped);
        }
    }

    #[test]
    fn unknown_session_does_not_write() {
        let conn = open_test_db_with_session("s1");
        let raw = serde_json::json!({ "sessionId": "ghost", "goal": "{}" });
        let outcome = write_codex_goal_meta(&conn, &raw).unwrap();
        assert_eq!(
            outcome,
            CodexGoalWriteOutcome::UnknownSession("ghost".to_string())
        );
        assert!(read_meta(&conn, "s1").is_none());
    }

    #[test]
    fn malformed_goal_field_skips() {
        let conn = open_test_db_with_session("s1");
        let raw = serde_json::json!({ "sessionId": "s1", "goal": 42 });
        let outcome = write_codex_goal_meta(&conn, &raw).unwrap();
        assert_eq!(outcome, CodexGoalWriteOutcome::Skipped);
    }
}
