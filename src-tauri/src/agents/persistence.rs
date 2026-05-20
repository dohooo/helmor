use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::pipeline::types::{AgentUsage, CollectedTurn, MessageRole};
use crate::sessions::mark_session_read_in_transaction;

use super::ExchangeContext;

/// Persist the user's prompt as the first message of the exchange.
/// Wraps as `{"type":"user_prompt","text":"...","files":[...],"images":[...]}`.
/// Empty arrays are omitted from the JSON.
pub(super) fn persist_user_message(
    conn: &Connection,
    ctx: &ExchangeContext,
    prompt: &str,
    files: &[String],
    images: &[String],
) -> Result<()> {
    let now = current_timestamp_string()?;
    let user_message_id = ctx.user_message_id.clone();
    let mut payload = serde_json::json!({
        "type": "user_prompt",
        "text": prompt,
    });
    if !files.is_empty() {
        payload["files"] = serde_json::Value::Array(
            files
                .iter()
                .map(|path| serde_json::Value::String(path.clone()))
                .collect(),
        );
    }
    if !images.is_empty() {
        payload["images"] = serde_json::Value::Array(
            images
                .iter()
                .map(|path| serde_json::Value::String(path.clone()))
                .collect(),
        );
    }
    let content = payload.to_string();

    conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
            "#,
        params![
            user_message_id,
            ctx.helmor_session_id,
            MessageRole::User,
            content,
            now
        ],
    )?;
    Ok(())
}

/// Persist a single intermediate turn (assistant message or user tool
/// result). Called each time the accumulator produces a complete turn
/// during streaming. Returns the DB message ID plus a flag indicating
/// whether the row was actually inserted (false on the
/// `ON CONFLICT(id) DO NOTHING` idempotent no-op path — load-bearing
/// for the reattach loop's UI-sync gate: a refetch fired on a no-op
/// re-write would fight in-flight streaming).
pub(super) fn persist_turn_message(
    conn: &Connection,
    ctx: &ExchangeContext,
    turn: &CollectedTurn,
    _resolved_model: &str,
    event_seq: Option<u64>,
) -> Result<(String, bool)> {
    let now = current_timestamp_string()?;
    // Use the pre-assigned ID from the turn so streaming and historical
    // message IDs are the same UUID.
    let msg_id = turn.id.clone();
    let content = crate::image_store::prepare_turn_content_for_persist(
        &ctx.helmor_session_id,
        &turn.content_json,
    )?;

    // ON CONFLICT(id) DO NOTHING makes the insert idempotent. The
    // regular send path can't double-write a turn (its
    // `persisted_turn_count` cursor monotonically advances), so this
    // never matters for it; the reattach path in `streaming::reattach`
    // re-pushes the daemon's full event log through a fresh accumulator,
    // which can resurface turns the original sender already persisted.
    // Letting the second insert be a no-op keeps DB content
    // deterministic without forcing each writer to coordinate.
    //
    // Phase 24q-2: `last_event_seq` stores the daemon-journal seq
    // of the event that produced this row. NULL on local-sidecar
    // and pre-24q-1 remote writes; the reattach call queries
    // `MAX(last_event_seq)` per session as its `since_seq` cursor.
    let rows_changed = conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at, last_event_seq
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
            ON CONFLICT(id) DO NOTHING
            "#,
        params![
            msg_id,
            ctx.helmor_session_id,
            turn.role,
            content,
            now,
            event_seq.map(|s| s as i64),
        ],
    )?;
    Ok((msg_id, rows_changed == 1))
}

pub(super) fn persist_error_message(
    conn: &Connection,
    ctx: &ExchangeContext,
    _resolved_model: &str,
    message: &str,
    event_seq: Option<u64>,
) -> Result<String> {
    let now = current_timestamp_string()?;
    let msg_id = uuid::Uuid::new_v4().to_string();
    let payload = json!({
        "type": "error",
        "message": message,
    })
    .to_string();

    conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at, last_event_seq
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
            "#,
        params![
            msg_id,
            ctx.helmor_session_id,
            MessageRole::Error,
            payload,
            now,
            event_seq.map(|s| s as i64),
        ],
    )?;

    Ok(msg_id)
}

/// Phase 24q-2: the desktop's high-water-mark across all rows for a
/// given session. Used by the remote-runner reattach call to compute
/// `since_seq` — events newer than this haven't been persisted
/// locally, so the daemon should replay them.
///
/// Returns `None` when:
/// - the session has no rows, or
/// - all rows have `last_event_seq = NULL` (legacy rows pre-24q-2,
///   or rows produced by the local-sidecar path which doesn't
///   participate in the daemon's journal).
///
/// In both `None` cases the caller passes `since_seq=None` (cold
/// attach), and the daemon flushes the full journal — the desktop's
/// `ON CONFLICT(id) DO NOTHING` and 24n persistence absorb the
/// replay without duplicating rows the local DB happens to already
/// have.
pub(crate) fn max_event_seq_for_session(
    conn: &Connection,
    helmor_session_id: &str,
) -> Result<Option<u64>> {
    // SELECT MAX(...) always returns one row (NULL when no rows
    // match or all values are NULL), so `query_row` is safe — no
    // QueryReturnedNoRows risk. Pass `Option<i64>` explicitly so
    // SQLite NULLs decode as None rather than producing an
    // InvalidColumnType error.
    let max: Option<i64> = conn.query_row(
        "SELECT MAX(last_event_seq) FROM session_messages WHERE session_id = ?1",
        [helmor_session_id],
        |row| row.get::<_, Option<i64>>(0),
    )?;
    Ok(max.and_then(|n| u64::try_from(n).ok()))
}

pub(super) fn persist_exit_plan_message(
    conn: &Connection,
    ctx: &ExchangeContext,
    _resolved_model: &str,
    tool_use_id: &str,
    tool_name: &str,
    tool_input: &Value,
) -> Result<(String, String)> {
    let now = current_timestamp_string()?;
    let msg_id = uuid::Uuid::new_v4().to_string();
    let mut payload = json!({
        "type": "exit_plan_mode",
        "toolUseId": tool_use_id,
        "toolName": tool_name,
    });

    if let Some(plan) = tool_input.get("plan").and_then(Value::as_str) {
        payload["plan"] = Value::String(plan.to_string());
    }
    if let Some(plan_file_path) = tool_input.get("planFilePath").and_then(Value::as_str) {
        payload["planFilePath"] = Value::String(plan_file_path.to_string());
    }
    if let Some(allowed_prompts) = tool_input
        .get("allowedPrompts")
        .filter(|value| value.is_array())
    {
        payload["allowedPrompts"] = allowed_prompts.clone();
    }

    conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
            "#,
        params![
            msg_id,
            ctx.helmor_session_id,
            MessageRole::Assistant,
            payload.to_string(),
            now
        ],
    )?;

    Ok((msg_id, now))
}

/// Persist the session result row and finalize session metadata. The
/// `preassigned_result_id` param, when present, is used as the DB row key
/// — pass the accumulator's `take_result_id()` so the live-rendered id
/// and the persisted id match.
#[allow(clippy::too_many_arguments)]
pub(super) fn persist_result_and_finalize(
    conn: &Connection,
    ctx: &ExchangeContext,
    _resolved_model: &str,
    assistant_text: &str,
    effort_level: Option<&str>,
    permission_mode: Option<&str>,
    usage: &AgentUsage,
    raw_result_json: Option<&str>,
    status: &str,
    preassigned_result_id: Option<String>,
) -> Result<String> {
    let now = current_timestamp_string()?;
    let result_message_id =
        preassigned_result_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let result_payload = raw_result_json.map(str::to_string).unwrap_or_else(|| {
        serde_json::json!({
            "type": "result",
            "subtype": if status == "aborted" { "aborted" } else { "success" },
            "result": assistant_text,
            "usage": {
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
            }
        })
        .to_string()
    });

    let transaction = conn.unchecked_transaction()?;

    transaction.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at
            ) VALUES (?1, ?2, 'assistant', ?3, ?4, ?4)
            "#,
        params![
            result_message_id,
            ctx.helmor_session_id,
            result_payload,
            now
        ],
    )?;

    finalize_session_metadata_in_transaction(
        &transaction,
        ctx,
        &now,
        status,
        effort_level,
        permission_mode,
    )?;

    transaction
        .commit()
        .context("Failed to commit result and finalize transaction")?;

    Ok(result_message_id)
}

pub(super) fn finalize_session_metadata(
    conn: &Connection,
    ctx: &ExchangeContext,
    status: &str,
    effort_level: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<()> {
    let now = current_timestamp_string()?;
    let transaction = conn.unchecked_transaction()?;
    finalize_session_metadata_in_transaction(
        &transaction,
        ctx,
        &now,
        status,
        effort_level,
        permission_mode,
    )?;
    transaction
        .commit()
        .context("Failed to commit finalize_session_metadata transaction")
}

fn finalize_session_metadata_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    ctx: &ExchangeContext,
    now: &str,
    status: &str,
    effort_level: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<()> {
    transaction.execute(
        r#"
            UPDATE sessions
            SET
              status = ?5,
              model = ?2,
              agent_type = ?3,
              last_user_message_at = ?4,
              effort_level = COALESCE(?6, effort_level),
              permission_mode = COALESCE(?7, permission_mode)
            WHERE id = ?1
            "#,
        params![
            ctx.helmor_session_id,
            ctx.model_id,
            ctx.model_provider,
            now,
            status,
            effort_level,
            permission_mode
        ],
    )?;

    transaction.execute(
        r#"
            UPDATE workspaces
            SET
              active_session_id = ?2
            WHERE id = (SELECT workspace_id FROM sessions WHERE id = ?1)
            "#,
        params![ctx.helmor_session_id, ctx.helmor_session_id],
    )?;

    mark_session_read_in_transaction(transaction, &ctx.helmor_session_id)?;
    Ok(())
}

fn current_timestamp_string() -> Result<String> {
    crate::models::db::current_timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_exchange_context() -> ExchangeContext {
        ExchangeContext {
            helmor_session_id: "session-1".to_string(),
            model_id: "gpt-5.4".to_string(),
            model_provider: "codex".to_string(),
            user_message_id: "user-1".to_string(),
        }
    }

    #[test]
    fn persist_error_message_stores_thread_error_payload() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE session_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT,
                content TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                sent_at TEXT,
                last_event_seq INTEGER
            );
            "#,
        )
        .unwrap();

        let ctx = test_exchange_context();
        let message_id =
            persist_error_message(&conn, &ctx, "gpt-5.4", "Reconnecting... 1/5", None).unwrap();

        let (role, content): (String, String) = conn
            .query_row(
                "SELECT role, content FROM session_messages WHERE id = ?1",
                [message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(role, "error");
        assert_eq!(
            serde_json::from_str::<Value>(&content).unwrap(),
            json!({
                "type": "error",
                "message": "Reconnecting... 1/5",
            })
        );
    }

    fn make_messages_table(conn: &Connection) {
        conn.execute_batch(
            r#"
            CREATE TABLE session_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT,
                content TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                sent_at TEXT,
                last_event_seq INTEGER
            );
            "#,
        )
        .unwrap();
    }

    #[test]
    fn persist_user_message_stores_user_prompt_payload() {
        let conn = Connection::open_in_memory().unwrap();
        make_messages_table(&conn);
        let ctx = test_exchange_context();
        persist_user_message(&conn, &ctx, "fix bug X", &[], &[]).unwrap();

        let (role, content, id): (String, String, String) = conn
            .query_row(
                "SELECT role, content, id FROM session_messages WHERE session_id = ?1",
                ["session-1"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(role, "user");
        assert_eq!(id, "user-1");
        let parsed: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["type"], "user_prompt");
        assert_eq!(parsed["text"], "fix bug X");
        // `files` array should be omitted when empty.
        assert!(parsed.get("files").is_none());
    }

    #[test]
    fn persist_user_message_includes_files_when_provided() {
        let conn = Connection::open_in_memory().unwrap();
        make_messages_table(&conn);
        let ctx = test_exchange_context();
        let files = vec!["a.rs".to_string(), "b.rs".to_string()];
        persist_user_message(&conn, &ctx, "refactor", &files, &[]).unwrap();

        let content: String = conn
            .query_row(
                "SELECT content FROM session_messages WHERE id = ?1",
                ["user-1"],
                |row| row.get(0),
            )
            .unwrap();
        let parsed: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            parsed["files"],
            json!(["a.rs".to_string(), "b.rs".to_string()])
        );
        assert!(parsed.get("images").is_none());
    }

    #[test]
    fn persist_user_message_includes_images_with_whitespace_in_paths() {
        let conn = Connection::open_in_memory().unwrap();
        make_messages_table(&conn);
        let ctx = test_exchange_context();
        let images = vec![
            "/Users/me/Library/Application Support/CleanShot/CleanShot 2026-04-29 at 08.24.35@2x.jpg".to_string(),
        ];
        persist_user_message(&conn, &ctx, "look at this", &[], &images).unwrap();

        let content: String = conn
            .query_row(
                "SELECT content FROM session_messages WHERE id = ?1",
                ["user-1"],
                |row| row.get(0),
            )
            .unwrap();
        let parsed: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["images"], json!(images));
        assert!(parsed.get("files").is_none());
    }

    #[test]
    fn persist_exit_plan_message_includes_provided_optional_fields() {
        let conn = Connection::open_in_memory().unwrap();
        make_messages_table(&conn);
        let ctx = test_exchange_context();

        let tool_input = json!({
            "plan": "1. step\n2. step",
            "planFilePath": "/tmp/plan.md",
            "allowedPrompts": ["yes", "go"],
        });
        let (msg_id, _now) = persist_exit_plan_message(
            &conn,
            &ctx,
            "gpt-5.4",
            "tu_123",
            "ExitPlanMode",
            &tool_input,
        )
        .unwrap();

        let (role, content): (String, String) = conn
            .query_row(
                "SELECT role, content FROM session_messages WHERE id = ?1",
                [&msg_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(role, "assistant");
        let parsed: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["type"], "exit_plan_mode");
        assert_eq!(parsed["toolUseId"], "tu_123");
        assert_eq!(parsed["toolName"], "ExitPlanMode");
        assert_eq!(parsed["plan"], "1. step\n2. step");
        assert_eq!(parsed["planFilePath"], "/tmp/plan.md");
        assert_eq!(parsed["allowedPrompts"], json!(["yes", "go"]));
    }

    #[test]
    fn persist_exit_plan_message_omits_unset_optional_fields() {
        let conn = Connection::open_in_memory().unwrap();
        make_messages_table(&conn);
        let ctx = test_exchange_context();

        // No plan, no path, no allowedPrompts.
        let tool_input = json!({});
        let (msg_id, _now) =
            persist_exit_plan_message(&conn, &ctx, "gpt-5.4", "tu_x", "ExitPlanMode", &tool_input)
                .unwrap();

        let content: String = conn
            .query_row(
                "SELECT content FROM session_messages WHERE id = ?1",
                [&msg_id],
                |row| row.get(0),
            )
            .unwrap();
        let parsed: Value = serde_json::from_str(&content).unwrap();
        assert!(parsed.get("plan").is_none());
        assert!(parsed.get("planFilePath").is_none());
        assert!(parsed.get("allowedPrompts").is_none());
    }

    #[test]
    fn persist_exit_plan_message_ignores_non_array_allowed_prompts() {
        let conn = Connection::open_in_memory().unwrap();
        make_messages_table(&conn);
        let ctx = test_exchange_context();

        let tool_input = json!({ "allowedPrompts": "not-an-array" });
        let (msg_id, _now) =
            persist_exit_plan_message(&conn, &ctx, "gpt-5.4", "tu_y", "ExitPlanMode", &tool_input)
                .unwrap();

        let content: String = conn
            .query_row(
                "SELECT content FROM session_messages WHERE id = ?1",
                [&msg_id],
                |row| row.get(0),
            )
            .unwrap();
        let parsed: Value = serde_json::from_str(&content).unwrap();
        assert!(parsed.get("allowedPrompts").is_none());
    }

    /// Reattach (phase 24n) re-pushes the daemon's full event log
    /// through a fresh accumulator, so turns the original sender
    /// already persisted re-surface to `persist_turn_message`. The
    /// `ON CONFLICT(id) DO NOTHING` clause lets the second insert be
    /// a no-op so the desktop never trips on a UNIQUE constraint.
    #[test]
    fn persist_turn_message_is_idempotent_on_repeat_id() {
        let conn = Connection::open_in_memory().unwrap();
        make_messages_table(&conn);
        let ctx = test_exchange_context();

        let turn = CollectedTurn {
            id: "msg-shared-1".into(),
            role: MessageRole::Assistant,
            content_json: json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "first" }],
                },
            })
            .to_string(),
        };

        let (first_id, first_inserted) =
            persist_turn_message(&conn, &ctx, &turn, "claude-opus-4", None).unwrap();
        assert_eq!(first_id, "msg-shared-1");
        assert!(first_inserted, "first call must report inserted=true");

        // A different `content_json` under the same id reaches us when
        // the daemon hands the same turn back through a reattach. The
        // second insert must not panic + must not overwrite the
        // original row (the desktop trusts the first writer). The
        // `inserted` flag must report `false` so reattach's UI sync
        // gate knows not to publish.
        let same_id_diff_content = CollectedTurn {
            id: "msg-shared-1".into(),
            role: MessageRole::Assistant,
            content_json: json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "second" }],
                },
            })
            .to_string(),
        };
        let (second_id, second_inserted) =
            persist_turn_message(&conn, &ctx, &same_id_diff_content, "claude-opus-4", None)
                .expect("second insert should succeed silently");
        assert_eq!(second_id, "msg-shared-1");
        assert!(
            !second_inserted,
            "second call must report inserted=false (ON CONFLICT DO NOTHING)",
        );

        // Only one row exists, and its content is the first write.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_messages WHERE id = ?1",
                ["msg-shared-1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let stored: String = conn
            .query_row(
                "SELECT content FROM session_messages WHERE id = ?1",
                ["msg-shared-1"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(stored.contains("first"));
        assert!(!stored.contains("second"));
    }

    fn insert_seq_row(conn: &Connection, id: &str, session_id: &str, seq: Option<i64>) {
        conn.execute(
            r#"
            INSERT INTO session_messages (id, session_id, role, content, last_event_seq)
            VALUES (?1, ?2, 'assistant', '{}', ?3)
            "#,
            params![id, session_id, seq],
        )
        .unwrap();
    }

    #[test]
    fn max_event_seq_for_session_returns_none_when_no_rows() {
        let conn = Connection::open_in_memory().unwrap();
        make_messages_table(&conn);
        let max = max_event_seq_for_session(&conn, "session-empty").unwrap();
        assert_eq!(max, None);
    }

    #[test]
    fn max_event_seq_for_session_returns_none_when_all_rows_null() {
        // Legacy rows (pre-24q-2) and local-only sessions both keep
        // `last_event_seq` NULL; the helper must collapse that into a
        // `None` result so the caller passes `since_seq=None`.
        let conn = Connection::open_in_memory().unwrap();
        make_messages_table(&conn);
        insert_seq_row(&conn, "row-a", "session-1", None);
        insert_seq_row(&conn, "row-b", "session-1", None);
        let max = max_event_seq_for_session(&conn, "session-1").unwrap();
        assert_eq!(max, None);
    }

    #[test]
    fn max_event_seq_for_session_picks_high_water_mark_per_session() {
        // Only rows matching the session_id contribute; NULLs are
        // skipped by MAX. The result is the highest non-NULL value
        // for that session.
        let conn = Connection::open_in_memory().unwrap();
        make_messages_table(&conn);
        insert_seq_row(&conn, "row-1", "session-1", Some(10));
        insert_seq_row(&conn, "row-2", "session-1", Some(42));
        insert_seq_row(&conn, "row-3", "session-1", None);
        // Sibling session — different high-water-mark; must not leak.
        insert_seq_row(&conn, "row-4", "session-2", Some(99));

        assert_eq!(
            max_event_seq_for_session(&conn, "session-1").unwrap(),
            Some(42)
        );
        assert_eq!(
            max_event_seq_for_session(&conn, "session-2").unwrap(),
            Some(99)
        );
        assert_eq!(
            max_event_seq_for_session(&conn, "session-other").unwrap(),
            None
        );
    }
}
