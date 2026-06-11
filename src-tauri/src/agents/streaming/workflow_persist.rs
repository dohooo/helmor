//! Persist Claude Code "Dynamic Workflow" `task_*` lifecycle events as
//! `system` session_message rows so a historical reload can rebuild the full
//! workflow tree (phases / agents / per-agent metrics).
//!
//! Without this, the `task_*` events are consumed live (folded into the
//! `WorkflowAccumulator` for the in-flight card) but never persisted — so on
//! reload the workflow renders as a bare shell (name "Workflow", no agents).
//! On replay, `convert_historical` re-runs the same accumulator over the
//! stored rows, so persisting the events is all that's needed to reconstruct
//! the run.
//!
//! To avoid bloating the DB with every progress delta, exactly three rows are
//! upserted per run (keyed by the originating `tool_use_id`):
//!   - `wf-start:{tool_use_id}`    — `task_started` (carries `workflow_name`)
//!   - `wf-progress:{tool_use_id}` — latest `task_progress` (the agent tree)
//!   - `wf-status:{tool_use_id}`   — terminal `task_updated` / `task_notification`
//!
//! Only events belonging to a `task_type = "local_workflow"` run are persisted
//! (tracked by `task_id` from `task_started`), so plain subagent task notices
//! are left untouched.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde_json::Value;

/// Per-stream tracker that classifies workflow `task_*` events and upserts the
/// minimal snapshot rows needed to reconstruct the run on historical reload.
#[derive(Default)]
pub(super) struct WorkflowPersistTracker {
    /// `task_id` -> `tool_use_id`, recorded from `task_started` — lets a later
    /// `task_updated` (which carries only `task_id`) resolve its run.
    tool_by_task: HashMap<String, String>,
    /// `tool_use_id`s known to belong to a local workflow.
    workflow_tools: HashSet<String>,
}

impl WorkflowPersistTracker {
    fn register(&mut self, task_id: Option<&str>, tool_use_id: &str) {
        self.workflow_tools.insert(tool_use_id.to_string());
        if let Some(tid) = task_id {
            self.tool_by_task
                .insert(tid.to_string(), tool_use_id.to_string());
        }
    }

    /// Inspect a raw stream event and, when it's a local-workflow `task_*`
    /// event, persist/upsert its snapshot row. Best-effort: a failed write is
    /// logged and skipped (a missing snapshot only degrades historical detail,
    /// it never breaks the live stream).
    pub(super) fn observe(&mut self, conn: &Connection, session_id: &str, raw: &Value) {
        if raw.get("type").and_then(Value::as_str) != Some("system") {
            return;
        }
        let subtype = raw.get("subtype").and_then(Value::as_str).unwrap_or("");
        let task_id = raw.get("task_id").and_then(Value::as_str);
        let tool_use_id = raw.get("tool_use_id").and_then(Value::as_str);

        let (prefix, key) = match subtype {
            "task_started" => {
                if raw.get("task_type").and_then(Value::as_str) != Some("local_workflow") {
                    return;
                }
                let Some(tu) = tool_use_id else {
                    return;
                };
                self.register(task_id, tu);
                ("wf-start", tu.to_string())
            }
            "task_progress" => {
                // The agent tree only rides on workflow progress events; plain
                // subagent progress has no `workflow_progress` array.
                if raw.get("workflow_progress").is_none() {
                    return;
                }
                let Some(tu) = tool_use_id else {
                    return;
                };
                // Defensive: anchor the run even if `task_started` was missed.
                self.register(task_id, tu);
                ("wf-progress", tu.to_string())
            }
            "task_updated" => {
                // Carries only `task_id`; resolve the run via the start map so
                // we never persist a non-workflow task's status row.
                let Some(tid) = task_id else {
                    return;
                };
                let Some(tu) = self.tool_by_task.get(tid).cloned() else {
                    return;
                };
                ("wf-status", tu)
            }
            "task_notification" => {
                let tu = tool_use_id
                    .filter(|t| self.workflow_tools.contains(*t))
                    .map(str::to_string)
                    .or_else(|| task_id.and_then(|t| self.tool_by_task.get(t).cloned()));
                let Some(tu) = tu else {
                    return;
                };
                ("wf-status", tu)
            }
            _ => return,
        };

        let row_id = format!("{prefix}:{key}");
        if let Err(err) = upsert_system_row(conn, &row_id, session_id, raw) {
            tracing::warn!(
                row_id = %row_id,
                error = %err,
                "workflow_persist: failed to upsert workflow snapshot row",
            );
        }
    }
}

/// Insert (or content-update) a `system` snapshot row. `ON CONFLICT` keeps the
/// original `created_at` so the start -> progress -> status ordering — which
/// `convert_historical` replays in `created_at` order — stays stable across
/// the repeated progress upserts.
fn upsert_system_row(
    conn: &Connection,
    id: &str,
    session_id: &str,
    raw: &Value,
) -> rusqlite::Result<()> {
    let content = raw.to_string();
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    conn.execute(
        r#"
            INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at)
            VALUES (?1, ?2, 'system', ?3, ?4, ?4)
            ON CONFLICT(id) DO UPDATE SET content = excluded.content
        "#,
        params![id, session_id, content, now],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::types::{ExtendedMessagePart, HistoricalRecord, MessagePart, MessageRole};
    use serde_json::json;

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

    fn rows(conn: &Connection, session_id: &str) -> Vec<(String, String)> {
        let mut stmt = conn
            .prepare("SELECT id, content FROM session_messages WHERE session_id = ?1 ORDER BY id")
            .unwrap();
        stmt.query_map([session_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn persists_only_local_workflow_events_as_three_rows() {
        let conn = test_conn();
        let mut t = WorkflowPersistTracker::default();
        let sid = "s1";

        // A plain (non-workflow) subagent task — must NOT be persisted.
        t.observe(
            &conn,
            sid,
            &json!({"type":"system","subtype":"task_started","task_id":"plain","tool_use_id":"tp","subagent_type":"reviewer"}),
        );
        t.observe(
            &conn,
            sid,
            &json!({"type":"system","subtype":"task_updated","task_id":"plain","patch":{"status":"completed"}}),
        );
        assert_eq!(
            rows(&conn, sid).len(),
            0,
            "plain subagent tasks must not persist"
        );

        // A local workflow run: started -> progress -> terminal.
        t.observe(
            &conn,
            sid,
            &json!({"type":"system","subtype":"task_started","task_id":"w1","tool_use_id":"tu1","task_type":"local_workflow","workflow_name":"demo"}),
        );
        t.observe(
            &conn,
            sid,
            &json!({"type":"system","subtype":"task_progress","task_id":"w1","tool_use_id":"tu1","workflow_progress":[
                {"type":"workflow_agent","index":1,"label":"a","state":"running"}
            ]}),
        );
        // A later progress delta upserts the same row (no new row).
        t.observe(
            &conn,
            sid,
            &json!({"type":"system","subtype":"task_progress","task_id":"w1","tool_use_id":"tu1","workflow_progress":[
                {"type":"workflow_agent","index":1,"label":"a","state":"done","resultPreview":"ok"}
            ]}),
        );
        t.observe(
            &conn,
            sid,
            &json!({"type":"system","subtype":"task_updated","task_id":"w1","patch":{"status":"completed"}}),
        );

        let ids: Vec<String> = rows(&conn, sid).into_iter().map(|(id, _)| id).collect();
        assert_eq!(
            ids,
            vec!["wf-progress:tu1", "wf-start:tu1", "wf-status:tu1"],
            "exactly three upserted snapshot rows, one per lifecycle stage",
        );
        // The progress row holds the LATEST delta (done + preview).
        let progress = rows(&conn, sid)
            .into_iter()
            .find(|(id, _)| id == "wf-progress:tu1")
            .unwrap()
            .1;
        assert!(progress.contains("\"state\":\"done\""));
        assert!(progress.contains("\"resultPreview\":\"ok\""));
    }

    #[test]
    fn persisted_rows_reconstruct_the_workflow_on_historical_reload() {
        let conn = test_conn();
        let sid = "s1";

        // The Workflow tool_use turn anchors the run (persisted by the normal
        // turn path); insert it first with the earliest timestamp.
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES (?1,?2,?3,?4,?5)",
            params![
                "turn1",
                sid,
                "assistant",
                json!({"type":"assistant","message":{"role":"assistant","content":[
                    {"type":"tool_use","id":"tu1","name":"Workflow","input":{}}
                ]}}).to_string(),
                "2026-01-01T00:00:01Z"
            ],
        )
        .unwrap();

        // The workflow lifecycle events arrive after the tool_use turn.
        let mut t = WorkflowPersistTracker::default();
        for ev in [
            json!({"type":"system","subtype":"task_started","task_id":"w1","tool_use_id":"tu1","task_type":"local_workflow","workflow_name":"investigate"}),
            json!({"type":"system","subtype":"task_progress","task_id":"w1","tool_use_id":"tu1","usage":{"total_tokens":500,"duration_ms":900},"workflow_progress":[
                {"type":"workflow_phase","index":1,"title":"Probe"},
                {"type":"workflow_agent","index":1,"label":"alpha","phaseIndex":1,"phaseTitle":"Probe","model":"claude-opus-4-8[1m]","state":"done","tokens":300,"toolCalls":2,"durationMs":640,"resultPreview":"found it"}
            ]}),
            json!({"type":"system","subtype":"task_updated","task_id":"w1","patch":{"status":"completed"}}),
        ] {
            t.observe(&conn, sid, &ev);
        }

        // Load the rows the way the historical path does, and run conversion.
        let mut stmt = conn
            .prepare("SELECT id, role, content, created_at FROM session_messages WHERE session_id = ?1 ORDER BY created_at, id")
            .unwrap();
        let records: Vec<HistoricalRecord> = stmt
            .query_map([sid], |r| {
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
            .collect();

        let thread = crate::pipeline::adapter::convert_historical(&records);
        let workflow = thread
            .iter()
            .flat_map(|m| m.content.iter())
            .find_map(|p| match p {
                ExtendedMessagePart::Basic(part @ MessagePart::Workflow { .. }) => Some(part),
                _ => None,
            })
            .expect("workflow part reconstructed from persisted rows");

        let MessagePart::Workflow {
            name,
            status,
            agents,
            ..
        } = workflow
        else {
            unreachable!()
        };
        assert_eq!(
            name, "investigate",
            "name comes from the persisted task_started"
        );
        assert_eq!(
            format!("{status:?}"),
            "Completed",
            "status comes from the persisted task_updated",
        );
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].label, "alpha");
        assert_eq!(agents[0].phase_title.as_deref(), Some("Probe"));
        assert_eq!(agents[0].model.as_deref(), Some("claude-opus-4-8[1m]"));
        assert_eq!(agents[0].tokens, Some(300));
        assert_eq!(agents[0].duration_ms, Some(640));
        assert_eq!(agents[0].result_preview.as_deref(), Some("found it"));
    }
}
