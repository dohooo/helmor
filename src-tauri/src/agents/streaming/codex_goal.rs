//! Persist `codexGoalUpdated` sidecar events into the session row and
//! broadcast a `CodexGoalChanged` UI mutation. Frontend reads the meta
//! through React Query — the channel only carries the invalidation cue.

use rusqlite::params;
use serde_json::{json, Value};
use tauri::AppHandle;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum CodexGoalWriteOutcome {
    /// Malformed event (missing/empty sessionId).
    Skipped,
    /// Event valid, DB row updated. `inserted_message` flips on only
    /// when the transition actually produced a new chat-history system
    /// message — used by the broadcaster to skip a wasteful
    /// `SessionMessagesAppended` invalidation on idempotent writes
    /// (e.g. the codex push that arrives right after a local mutation
    /// already wrote the same payload).
    Wrote {
        session_id: String,
        inserted_message: bool,
    },
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

    // Read previous meta to detect transitions worth narrating in the
    // chat as a system message ("Goal paused", "Goal resumed", etc.).
    let previous_meta: Option<String> = conn
        .query_row(
            "SELECT codex_goal_meta FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    let transition_label = goal_transition_label(previous_meta.as_deref(), value);

    let affected = conn.execute(
        "UPDATE sessions SET codex_goal_meta = ?1 WHERE id = ?2",
        params![value, session_id],
    )?;
    if affected == 0 {
        return Ok(CodexGoalWriteOutcome::UnknownSession(
            session_id.to_string(),
        ));
    }
    let inserted_message = if let Some(label) = transition_label {
        // Best-effort: a failed system-message insert shouldn't fail the
        // whole write — banner still reflects the new state via the
        // codex_goal_meta column itself.
        insert_goal_system_message(conn, session_id, label).is_ok()
    } else {
        false
    };
    Ok(CodexGoalWriteOutcome::Wrote {
        session_id: session_id.to_string(),
        inserted_message,
    })
}

/// Compare the old and new `codex_goal_meta` values and return a
/// human-readable label when the transition is worth narrating in chat.
/// `None` when no message should be inserted (e.g. unchanged status,
/// background token-usage updates that don't move status).
///
/// Labels intentionally don't include the objective — the user's
/// `/goal X` prompt already produced a chat bubble carrying that text,
/// and repeating it on the system row would just be visual noise.
pub(super) fn goal_transition_label(
    previous_meta: Option<&str>,
    new_meta: Option<&str>,
) -> Option<&'static str> {
    let prev = previous_meta.and_then(parse_goal_status);
    let curr = new_meta.and_then(parse_goal_status);

    if prev == curr {
        return None;
    }
    match (prev, curr) {
        (None, None) => None,
        // Brand-new goal — `Goal set` regardless of starting status.
        (None, Some(_)) => Some("Goal set"),
        // Cleared.
        (Some(_), None) => Some("Goal cleared"),
        // Status flips while goal exists.
        (Some(_), Some(GoalStatus::Paused)) => Some("Goal paused"),
        (Some(_), Some(GoalStatus::Active)) => Some("Goal resumed"),
        (Some(_), Some(GoalStatus::BudgetLimited)) => Some("Goal reached token budget"),
        (Some(_), Some(GoalStatus::Complete)) => Some("Goal complete"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GoalStatus {
    Active,
    Paused,
    BudgetLimited,
    Complete,
}

fn parse_goal_status(meta: &str) -> Option<GoalStatus> {
    let v: Value = serde_json::from_str(meta).ok()?;
    let s = v.get("status").and_then(Value::as_str)?;
    match s {
        "active" => Some(GoalStatus::Active),
        "paused" => Some(GoalStatus::Paused),
        "budgetLimited" => Some(GoalStatus::BudgetLimited),
        "complete" => Some(GoalStatus::Complete),
        _ => None,
    }
}

fn insert_goal_system_message(
    conn: &rusqlite::Connection,
    session_id: &str,
    label: &str,
) -> std::result::Result<(), rusqlite::Error> {
    let msg_id = uuid::Uuid::new_v4().to_string();
    let content = json!({ "type": "goal_status", "text": label }).to_string();
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        "#,
        params![msg_id, session_id, "system", content, now],
    )?;
    Ok(())
}

/// Apply a banner-button-driven goal mutation directly to the local DB
/// without waiting for codex's `thread/goal/updated` notification to
/// round-trip back through the stale per-stream notification handler.
///
/// Holds the writer connection for the whole read-modify-write window,
/// so a concurrent codex push can't interleave between us reading the
/// previous payload and writing the mutated one — which used to drop
/// fields like `tokensUsed` that codex had updated in between.
///
/// Idempotent with whatever codex eventually pushes — both writes go
/// through `write_codex_goal_meta`, so the second one (whichever it is)
/// just observes "no transition" and skips the system message.
pub fn apply_local_mutation(app: &AppHandle, session_id: &str, action: &str) {
    let conn = match crate::models::db::write_conn() {
        Ok(conn) => conn,
        Err(err) => {
            tracing::warn!(session_id = %session_id, action = %action, error = %err, "apply_local_mutation: write_conn failed");
            return;
        }
    };
    let prev_meta: Option<String> = match conn.query_row(
        "SELECT codex_goal_meta FROM sessions WHERE id = ?1",
        [session_id],
        |row| row.get(0),
    ) {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(err) => {
            tracing::warn!(session_id = %session_id, action = %action, error = %err, "apply_local_mutation: read prev failed");
            return;
        }
    };

    let new_meta = match project_action_on_prev(prev_meta.as_deref(), action) {
        Ok(meta) => meta,
        Err(err) => {
            tracing::warn!(session_id = %session_id, action = %action, error = %err, "apply_local_mutation: skipped");
            return;
        }
    };
    let raw = serde_json::json!({
        "sessionId": session_id,
        "goal": new_meta,
    });
    let outcome = match write_codex_goal_meta(&conn, &raw) {
        Ok(outcome) => outcome,
        Err(err) => {
            tracing::warn!("Failed to persist codex_goal_meta: {err}");
            return;
        }
    };
    // Release the writer before fanning out invalidations — broadcasting
    // doesn't need the lock and any followers waiting on it shouldn't be
    // blocked behind a UI mutation publish.
    drop(conn);
    broadcast_codex_goal_outcome(app, outcome);
}

/// Project a banner-button action onto the previously-stored meta and
/// return the new payload (or `None` for `clear`). Returns `Err` when
/// the action can't be applied (e.g. pause without an existing goal).
fn project_action_on_prev(
    prev_meta: Option<&str>,
    action: &str,
) -> std::result::Result<Option<String>, String> {
    if action == "clear" {
        return Ok(None);
    }
    if action != "pause" {
        return Err(format!("invalid action {action}"));
    }
    let prev = prev_meta.ok_or_else(|| "no goal to mutate".to_string())?;
    let mut value: Value = serde_json::from_str(prev).map_err(|e| e.to_string())?;
    if let Some(obj) = value.as_object_mut() {
        obj.insert("status".to_string(), Value::String("paused".to_string()));
    } else {
        return Err("codex_goal_meta is not an object".to_string());
    }
    Ok(Some(value.to_string()))
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
    broadcast_codex_goal_outcome(app, outcome);
}

fn broadcast_codex_goal_outcome(app: &AppHandle, outcome: CodexGoalWriteOutcome) {
    let (session_id, inserted_message) = match outcome {
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
        CodexGoalWriteOutcome::Wrote {
            session_id,
            inserted_message,
        } => (session_id, inserted_message),
    };
    crate::ui_sync::publish(
        app,
        crate::ui_sync::UiMutationEvent::CodexGoalChanged {
            session_id: session_id.clone(),
        },
    );
    // Only broadcast SessionMessagesAppended when we actually inserted a
    // chat-history message. A re-write that flips no fields (e.g. the
    // codex notification arriving after a local mutation already wrote
    // the same payload) must not invalidate the chat — that triggers a
    // refetch which fights with in-flight streaming and shows up as a
    // visible flicker / "interrupted output".
    if inserted_message {
        crate::ui_sync::publish(
            app,
            crate::ui_sync::UiMutationEvent::SessionMessagesAppended { session_id },
        );
    }
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
        // First write of an active goal counts as a transition → message inserted.
        assert_eq!(
            outcome,
            CodexGoalWriteOutcome::Wrote {
                session_id: "s1".to_string(),
                inserted_message: true,
            }
        );
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
        // {} -> null isn't a goal-status transition we narrate.
        assert_eq!(
            outcome,
            CodexGoalWriteOutcome::Wrote {
                session_id: "s1".to_string(),
                inserted_message: false,
            }
        );
        assert_eq!(read_meta(&conn, "s1"), None);
    }

    #[test]
    fn idempotent_rewrite_does_not_insert_message() {
        // Simulates the codex notification arriving after a local mutation
        // already wrote the same payload — must NOT fire a second
        // SessionMessagesAppended invalidation.
        let conn = open_test_db_with_session("s1");
        let active_meta = r#"{"objective":"x","status":"active","tokensUsed":0,"timeUsedSeconds":0,"createdAt":0,"updatedAt":0,"threadId":"t","tokenBudget":null}"#;
        conn.execute(
            "UPDATE sessions SET codex_goal_meta = ?1 WHERE id = 's1'",
            [active_meta],
        )
        .unwrap();
        let raw = serde_json::json!({ "sessionId": "s1", "goal": active_meta });
        let outcome = write_codex_goal_meta(&conn, &raw).unwrap();
        assert_eq!(
            outcome,
            CodexGoalWriteOutcome::Wrote {
                session_id: "s1".to_string(),
                inserted_message: false,
            }
        );
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

    fn meta(status: &str, objective: &str) -> String {
        format!(
            r#"{{"status":"{status}","objective":"{objective}","tokensUsed":0,"timeUsedSeconds":0,"createdAt":0,"updatedAt":0,"threadId":"t","tokenBudget":null}}"#
        )
    }

    #[test]
    fn transition_label_first_set_does_not_include_objective() {
        // The user's `/goal X` prompt already produces a chat bubble with
        // the objective text — repeating it on the system row would just
        // be noise. So the label is the same regardless of objective.
        let label = goal_transition_label(None, Some(meta("active", "fix the bug").as_str()));
        assert_eq!(label, Some("Goal set"));
    }

    #[test]
    fn transition_label_pause() {
        let label = goal_transition_label(
            Some(meta("active", "x").as_str()),
            Some(meta("paused", "x").as_str()),
        );
        assert_eq!(label, Some("Goal paused"));
    }

    #[test]
    fn transition_label_resume() {
        let label = goal_transition_label(
            Some(meta("paused", "x").as_str()),
            Some(meta("active", "x").as_str()),
        );
        assert_eq!(label, Some("Goal resumed"));
    }

    #[test]
    fn transition_label_cleared() {
        let label = goal_transition_label(Some(meta("active", "x").as_str()), None);
        assert_eq!(label, Some("Goal cleared"));
    }

    #[test]
    fn transition_label_no_change() {
        let label = goal_transition_label(
            Some(meta("active", "x").as_str()),
            Some(meta("active", "x").as_str()),
        );
        assert_eq!(label, None);
    }

    #[test]
    fn transition_label_token_only_update_no_message() {
        // tokensUsed bumps every turn — must not spam system messages.
        let prev = r#"{"status":"active","objective":"x","tokensUsed":100,"timeUsedSeconds":0,"createdAt":0,"updatedAt":0,"threadId":"t","tokenBudget":null}"#;
        let next = r#"{"status":"active","objective":"x","tokensUsed":250,"timeUsedSeconds":0,"createdAt":0,"updatedAt":0,"threadId":"t","tokenBudget":null}"#;
        let label = goal_transition_label(Some(prev), Some(next));
        assert_eq!(label, None);
    }

    #[test]
    fn transition_label_budget_limited() {
        let label = goal_transition_label(
            Some(meta("active", "x").as_str()),
            Some(meta("budgetLimited", "x").as_str()),
        );
        assert_eq!(label, Some("Goal reached token budget"));
    }

    #[test]
    fn transition_label_complete() {
        let label = goal_transition_label(
            Some(meta("active", "x").as_str()),
            Some(meta("complete", "x").as_str()),
        );
        assert_eq!(label, Some("Goal complete"));
    }

    // `project_action_on_prev` is a pure function — no DB. Tests drive
    // it directly without a session row.
    #[test]
    fn project_action_pause_flips_status_to_paused() {
        let prev = meta("active", "obj");
        let new_meta = project_action_on_prev(Some(prev.as_str()), "pause")
            .unwrap()
            .unwrap();
        assert!(new_meta.contains("\"status\":\"paused\""));
        assert!(new_meta.contains("\"objective\":\"obj\""));
    }

    #[test]
    fn project_action_clear_returns_none() {
        let prev = meta("active", "obj");
        let new_meta = project_action_on_prev(Some(prev.as_str()), "clear").unwrap();
        assert_eq!(new_meta, None);
    }

    #[test]
    fn project_action_pause_without_existing_goal_errors() {
        assert!(project_action_on_prev(None, "pause").is_err());
    }

    #[test]
    fn project_action_clear_without_existing_goal_is_idempotent() {
        // Clear is tolerant — clearing nothing is a no-op (returns None).
        assert_eq!(project_action_on_prev(None, "clear").unwrap(), None);
    }

    #[test]
    fn project_action_invalid_returns_err() {
        let prev = meta("active", "obj");
        assert!(project_action_on_prev(Some(prev.as_str()), "resume").is_err());
        assert!(project_action_on_prev(Some(prev.as_str()), "garbage").is_err());
    }
}
