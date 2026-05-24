//! Shared priming-injection helper. Called from the agent send path
//! (`agents::send_agent_message_stream`) so all three providers
//! (claude / codex / cursor) inject the same way without each implementing
//! their own variant.
//!
//! Lifecycle:
//!   1. AI-triage creates a workspace whose first `session_messages` row is
//!      an assistant message with `is_ai_priming = 1`.
//!   2. User opens the workspace, sees the plan, types a message, sends.
//!   3. This helper looks up `(workspaces.kind, ai_priming_consumed)`. If
//!      it's an unconsumed AI-triage workspace, it loads the priming text
//!      and returns the wrapped prefix that gets prepended on the wire.
//!   4. `mark_consumed` flips the flag so the next send is normal.

use anyhow::{Context, Result};

use crate::models::db;

/// XML-tagged wrap so any LLM understands "here's earlier context, now the
/// user's request". Used for Claude / Codex / Cursor uniformly.
pub fn wrap_priming(priming_text: &str) -> String {
    format!(
        "<discovered-context>\n{}\n</discovered-context>\n\nThe user has reviewed the above context and now requests:",
        priming_text.trim()
    )
}

/// Returns Some(wrapped prefix) when the helmor_session belongs to an
/// unconsumed AI-triage workspace. Returns Ok(None) otherwise (manual
/// workspace, already consumed, or any inconsistency that should be
/// treated as "no injection").
pub fn load_priming_prefix_for_session(helmor_session_id: &str) -> Result<Option<String>> {
    let connection = db::read_conn()?;
    // Step 1: workspace metadata.
    let workspace_row = connection
        .query_row(
            "SELECT w.id, w.kind, w.ai_priming_consumed
             FROM sessions s
             JOIN workspaces w ON w.id = s.workspace_id
             WHERE s.id = ?1",
            [helmor_session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .ok();
    let Some((_workspace_id, kind, consumed)) = workspace_row else {
        return Ok(None);
    };
    if kind != "ai_triage" || consumed != 0 {
        return Ok(None);
    }
    // Step 2: priming message body.
    let raw_content: Option<String> = connection
        .query_row(
            "SELECT content FROM session_messages
             WHERE session_id = ?1 AND is_ai_priming = 1
             ORDER BY created_at ASC LIMIT 1",
            [helmor_session_id],
            |row| row.get(0),
        )
        .ok();
    let Some(raw) = raw_content else {
        return Ok(None);
    };
    let plan_text = extract_plan_text(&raw).unwrap_or(raw);
    if plan_text.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(wrap_priming(&plan_text)))
}

/// Look at the stored assistant JSON; pull out the first text block.
/// Falls back to None when the shape doesn't match the canonical
/// `{ type: "assistant", message: { content: [...] } }` form so the caller
/// can decide to pass through the raw stored string.
pub fn extract_plan_text(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let blocks = value.get("message")?.get("content")?.as_array()?;
    let mut out = String::new();
    for block in blocks {
        if block.get("type").and_then(|v| v.as_str()) == Some("text") {
            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push_str("\n\n");
                }
                out.push_str(text);
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Flip `workspaces.ai_priming_consumed = 1` for whatever workspace this
/// session belongs to. Idempotent — already-consumed rows just no-op.
pub fn mark_consumed_for_session(helmor_session_id: &str) -> Result<()> {
    let connection = db::write_conn()?;
    connection
        .execute(
            "UPDATE workspaces SET ai_priming_consumed = 1
             WHERE id = (SELECT workspace_id FROM sessions WHERE id = ?1)
               AND ai_priming_consumed = 0",
            [helmor_session_id],
        )
        .context("mark ai_priming_consumed")?;
    Ok(())
}

/// Compose with any existing prompt_prefix (user "preferences" prefix).
/// Priming goes first (it's the discovery context), then the user-set
/// preferences, then the wire wrapper adds the user's actual prompt.
pub fn combine_prefixes(priming: Option<String>, existing: Option<String>) -> Option<String> {
    match (priming, existing) {
        (None, None) => None,
        (Some(p), None) => Some(p),
        (None, Some(e)) => Some(e),
        (Some(p), Some(e)) => Some(format!("{p}\n\n{e}")),
    }
}
