//! Persist non-workflow background-task state as compact projection rows.
//!
//! The raw Claude `task_*` and `tool_progress` events are collected for live
//! rendering but are not normal persisted turns. Store one synthetic
//! `task_snapshot` system row per task so `convert_historical` can rebuild the
//! same final `TaskState` on reload without saving every progress delta.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::pipeline::types::TaskState;

pub(super) fn is_task_state_source_event(raw: &Value) -> bool {
    match raw.get("type").and_then(Value::as_str) {
        Some("system") => crate::pipeline::event_filter::is_claude_task_lifecycle(raw),
        Some("tool_progress") => raw.get("task_id").and_then(Value::as_str).is_some(),
        _ => false,
    }
}

pub(super) fn upsert_task_state_snapshots(
    conn: &Connection,
    session_id: &str,
    tasks: &[TaskState],
) {
    for task in tasks {
        if let Err(err) = upsert_task_state_snapshot(conn, session_id, task) {
            tracing::warn!(
                task_id = %task.id,
                error = %err,
                "task_state_persist: failed to upsert task snapshot row",
            );
        }
    }
}

fn upsert_task_state_snapshot(
    conn: &Connection,
    session_id: &str,
    task: &TaskState,
) -> rusqlite::Result<()> {
    let row_id = format!("task-state:{session_id}:{}", task.id);
    let content = json!({
        "type": "system",
        "subtype": "task_snapshot",
        "task_id": task.id,
        "tool_use_id": task.tool_use_id,
        "task_state": task,
    })
    .to_string();
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    conn.execute(
        r#"
            INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at)
            VALUES (?1, ?2, 'system', ?3, ?4, ?4)
            ON CONFLICT(id) DO UPDATE SET content = excluded.content
        "#,
        params![row_id, session_id, content, now],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::types::{
        ExtendedMessagePart, HistoricalRecord, MessagePart, MessageRole, ThreadMessageLike,
    };
    use crate::pipeline::MessagePipeline;
    use rusqlite::params;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE session_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                role TEXT,
                content TEXT,
                sent_at TEXT,
                is_ai_priming INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            "#,
        )
        .unwrap();
        conn
    }

    fn task_tool_event(tool_use_id: &str, description: &str) -> Value {
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": tool_use_id,
                    "name": "Task",
                    "input": {"description": description},
                }],
            },
        })
    }

    fn persist_new_turns(
        conn: &Connection,
        session_id: &str,
        pipeline: &MessagePipeline,
        persisted_turn_count: &mut usize,
    ) {
        while *persisted_turn_count < pipeline.accumulator.turns_len() {
            let turn = pipeline.accumulator.turn_at(*persisted_turn_count);
            let created_at = format!("2026-01-01T00:00:{:02}Z", *persisted_turn_count + 1);
            conn.execute(
                r#"
                    INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                "#,
                params![
                    &turn.id,
                    session_id,
                    turn.role,
                    &turn.content_json,
                    created_at,
                ],
            )
            .unwrap();
            *persisted_turn_count += 1;
        }
    }

    fn feed_events(conn: &Connection, session_id: &str, events: Vec<Value>) -> MessagePipeline {
        let mut pipeline =
            MessagePipeline::new("claude", "claude-test", "session:test", session_id);
        let mut persisted_turn_count = 0usize;

        for event in events {
            let raw = event.to_string();
            pipeline.push_event(&event, &raw);
            persist_new_turns(conn, session_id, &pipeline, &mut persisted_turn_count);
            if is_task_state_source_event(&event) {
                let tasks = pipeline.task_state_snapshot();
                upsert_task_state_snapshots(conn, session_id, &tasks);
            }
        }

        pipeline.accumulator.flush_pending();
        persist_new_turns(conn, session_id, &pipeline, &mut persisted_turn_count);
        pipeline
    }

    fn records(conn: &Connection, session_id: &str) -> Vec<HistoricalRecord> {
        let mut stmt = conn
            .prepare(
                "SELECT id, role, content, created_at FROM session_messages \
                 WHERE session_id = ?1 ORDER BY created_at, id",
            )
            .unwrap();
        stmt.query_map([session_id], |r| {
            let content: String = r.get(2)?;
            Ok(HistoricalRecord {
                id: r.get(0)?,
                role: r.get::<_, String>(1)?.parse::<MessageRole>().unwrap(),
                parsed_content: serde_json::from_str(&content).ok(),
                content,
                created_at: r.get(3)?,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    fn first_task_state(messages: &[ThreadMessageLike]) -> TaskState {
        messages
            .iter()
            .flat_map(|message| message.content.iter())
            .find_map(|part| match part {
                ExtendedMessagePart::Basic(MessagePart::ToolCall { task_state, .. }) => {
                    task_state.as_deref().cloned()
                }
                _ => None,
            })
            .expect("task state attached to task tool")
    }

    fn assert_reloaded_task_matches_live(
        conn: &Connection,
        session_id: &str,
        pipeline: &mut MessagePipeline,
    ) {
        let live = first_task_state(&pipeline.finish());
        let reloaded = first_task_state(&crate::pipeline::adapter::convert_historical(&records(
            conn, session_id,
        )));
        assert_eq!(
            serde_json::to_value(reloaded).unwrap(),
            serde_json::to_value(live).unwrap(),
        );
    }

    #[test]
    fn non_workflow_task_snapshot_round_trips_completed_state() {
        let conn = test_conn();
        let session_id = "s1";
        let mut pipeline = feed_events(
            &conn,
            session_id,
            vec![
                task_tool_event("toolu_task_1", "Review repository state"),
                json!({
                    "type": "system",
                    "subtype": "task_started",
                    "task_id": "task_1",
                    "tool_use_id": "toolu_task_1",
                    "task_type": "local_agent",
                    "subagent_type": "Explore",
                    "description": "Review repository state",
                }),
                json!({
                    "type": "tool_progress",
                    "task_id": "task_1",
                    "tool_use_id": "toolu_task_1",
                    "tool_name": "Read",
                }),
                json!({
                    "type": "system",
                    "subtype": "task_notification",
                    "task_id": "task_1",
                    "tool_use_id": "toolu_task_1",
                    "status": "completed",
                    "summary": "Repository review complete",
                    "usage": {"total_tokens": 180, "tool_uses": 3, "duration_ms": 4500},
                }),
            ],
        );

        assert_reloaded_task_matches_live(&conn, session_id, &mut pipeline);
    }

    #[test]
    fn non_workflow_task_snapshot_round_trips_killed_state() {
        let conn = test_conn();
        let session_id = "s1";
        let mut pipeline = feed_events(
            &conn,
            session_id,
            vec![
                task_tool_event("toolu_task_kill", "Long-running audit"),
                json!({
                    "type": "system",
                    "subtype": "task_started",
                    "task_id": "task_kill",
                    "tool_use_id": "toolu_task_kill",
                    "task_type": "local_agent",
                    "description": "Long-running audit",
                }),
                json!({
                    "type": "system",
                    "subtype": "task_updated",
                    "task_id": "task_kill",
                    "patch": {
                        "status": "killed",
                        "is_backgrounded": true,
                        "error": "terminated by user",
                        "end_time": 1780015779522_i64,
                    },
                }),
            ],
        );

        assert_reloaded_task_matches_live(&conn, session_id, &mut pipeline);
    }

    #[test]
    fn task_snapshot_with_reused_task_id_round_trips_per_session() {
        let conn = test_conn();
        let mut first_pipeline = feed_events(
            &conn,
            "s1",
            vec![
                task_tool_event("toolu_shared_1", "First session task"),
                json!({
                    "type": "system",
                    "subtype": "task_started",
                    "task_id": "shared_task",
                    "tool_use_id": "toolu_shared_1",
                    "task_type": "local_agent",
                    "description": "First session task",
                }),
                json!({
                    "type": "system",
                    "subtype": "task_notification",
                    "task_id": "shared_task",
                    "tool_use_id": "toolu_shared_1",
                    "status": "completed",
                    "summary": "First session complete",
                }),
            ],
        );
        let mut second_pipeline = feed_events(
            &conn,
            "s2",
            vec![
                task_tool_event("toolu_shared_2", "Second session task"),
                json!({
                    "type": "system",
                    "subtype": "task_started",
                    "task_id": "shared_task",
                    "tool_use_id": "toolu_shared_2",
                    "task_type": "local_agent",
                    "description": "Second session task",
                }),
                json!({
                    "type": "system",
                    "subtype": "task_updated",
                    "task_id": "shared_task",
                    "patch": {
                        "status": "killed",
                        "is_backgrounded": true,
                        "error": "terminated by user",
                    },
                }),
            ],
        );

        assert_reloaded_task_matches_live(&conn, "s1", &mut first_pipeline);
        assert_reloaded_task_matches_live(&conn, "s2", &mut second_pipeline);

        let snapshot_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_messages WHERE id IN (?1, ?2)",
                ["task-state:s1:shared_task", "task-state:s2:shared_task"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(snapshot_count, 2);
    }
}
