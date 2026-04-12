use anyhow::{Context, Result};
use rusqlite::{params, Connection};

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
