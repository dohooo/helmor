use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::pipeline::types::{AgentUsage, CollectedTurn};
use crate::sessions::mark_session_read_in_transaction;

use super::ExchangeContext;

/// Persist the user's prompt as the first message of the exchange.
/// Wraps as `{"type":"user_prompt","text":"...","files":[...]}`.
pub(super) fn persist_user_message(
    conn: &Connection,
    ctx: &ExchangeContext,
    prompt: &str,
    files: &[String],
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
    let content = payload.to_string();

    conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at,
              model, last_assistant_message_id, turn_id,
              is_resumable_message
            ) VALUES (?1, ?2, 'user', ?3, ?4, ?4, ?5, ?6, ?7, 0)
            "#,
        params![
            user_message_id,
            ctx.helmor_session_id,
            content,
            now,
            ctx.model_id,
            ctx.assistant_sdk_message_id,
            ctx.turn_id
        ],
    )?;
    Ok(())
}

/// Persist a single intermediate turn (assistant message or user tool
/// result). Called each time the accumulator produces a complete turn
/// during streaming. Returns the DB message ID.
pub(super) fn persist_turn_message(
    conn: &Connection,
    ctx: &ExchangeContext,
    turn: &CollectedTurn,
    resolved_model: &str,
) -> Result<String> {
    let now = current_timestamp_string()?;
    // Use the pre-assigned ID from the turn so streaming and historical
    // message IDs are the same UUID.
    let msg_id = turn.id.clone();

    conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at,
              model, turn_id, is_resumable_message
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, 0)
            "#,
        params![
            msg_id,
            ctx.helmor_session_id,
            turn.role,
            turn.content_json,
            now,
            resolved_model,
            ctx.turn_id
        ],
    )?;
    Ok(msg_id)
}

pub(super) fn persist_error_message(
    conn: &Connection,
    ctx: &ExchangeContext,
    resolved_model: &str,
    message: &str,
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
              id, session_id, role, content, created_at, sent_at,
              model, turn_id, is_resumable_message
            ) VALUES (?1, ?2, 'error', ?3, ?4, ?4, ?5, ?6, 0)
            "#,
        params![
            msg_id,
            ctx.helmor_session_id,
            payload,
            now,
            resolved_model,
            ctx.turn_id
        ],
    )?;

    Ok(msg_id)
}

pub(super) fn persist_exit_plan_message(
    conn: &Connection,
    ctx: &ExchangeContext,
    resolved_model: &str,
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
              id, session_id, role, content, created_at, sent_at,
              model, turn_id, is_resumable_message
            ) VALUES (?1, ?2, 'assistant', ?3, ?4, ?4, ?5, ?6, 0)
            "#,
        params![
            msg_id,
            ctx.helmor_session_id,
            payload.to_string(),
            now,
            resolved_model,
            ctx.turn_id
        ],
    )?;

    Ok((msg_id, now))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn persist_result_and_finalize(
    conn: &Connection,
    ctx: &ExchangeContext,
    resolved_model: &str,
    assistant_text: &str,
    effort_level: Option<&str>,
    permission_mode: Option<&str>,
    usage: &AgentUsage,
    raw_result_json: Option<&str>,
    status: &str,
) -> Result<String> {
    let now = current_timestamp_string()?;
    let result_message_id = uuid::Uuid::new_v4().to_string();

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
              id, session_id, role, content, created_at, sent_at,
              model, sdk_message_id, turn_id,
              is_resumable_message
            ) VALUES (?1, ?2, 'assistant', ?3, ?4, ?4, ?5, ?6, ?7, 0)
            "#,
        params![
            result_message_id,
            ctx.helmor_session_id,
            result_payload,
            now,
            resolved_model,
            ctx.assistant_sdk_message_id,
            ctx.turn_id
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

pub(super) fn open_write_connection() -> Result<Connection> {
    crate::models::db::open_connection(true)
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
            turn_id: "turn-1".to_string(),
            model_id: "gpt-5.4".to_string(),
            model_provider: "codex".to_string(),
            assistant_sdk_message_id: "assistant-1".to_string(),
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
                cancelled_at TEXT,
                model TEXT,
                sdk_message_id TEXT,
                last_assistant_message_id TEXT,
                turn_id TEXT,
                is_resumable_message INTEGER
            );
            "#,
        )
        .unwrap();

        let ctx = test_exchange_context();
        let message_id =
            persist_error_message(&conn, &ctx, "gpt-5.4", "Reconnecting... 1/5").unwrap();

        let (role, content, model, turn_id): (String, String, String, String) = conn
            .query_row(
                "SELECT role, content, model, turn_id FROM session_messages WHERE id = ?1",
                [message_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(role, "error");
        assert_eq!(model, "gpt-5.4");
        assert_eq!(turn_id, "turn-1");
        assert_eq!(
            serde_json::from_str::<Value>(&content).unwrap(),
            json!({
                "type": "error",
                "message": "Reconnecting... 1/5",
            })
        );
    }
}
