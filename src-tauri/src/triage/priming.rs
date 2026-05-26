//! Shared priming-injection helper for the agent send path.

use anyhow::{Context, Result};

use crate::models::db;

// XML-tagged so any LLM treats it as prior context.
pub fn wrap_priming(priming_text: &str) -> String {
    format!(
        "<discovered-context>\n{}\n</discovered-context>\n\nThe user has reviewed the above context and now requests:",
        priming_text.trim()
    )
}

// Returns Some(prefix) only for an unconsumed AI-triage workspace; Ok(None) otherwise.
pub fn load_priming_prefix_for_session(helmor_session_id: &str) -> Result<Option<String>> {
    let connection = db::read_conn()?;
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

// Concat text blocks from the stored `{ message: { content: [...] } }` JSON.
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

/// Flip `ai_priming_consumed = 1` AND graduate `kind` from `ai_triage`
/// to `manual`. The kind flip is what removes the workspace from the
/// sidebar's Triage bucket — once the user has sent the first message,
/// the workspace's lifecycle is indistinguishable from a manually-
/// created one. Returns `Ok(true)` when a row was actually updated
/// (caller publishes `WorkspaceListChanged` so the sidebar repaints).
/// Idempotent: already-consumed rows return Ok(false) with no writes.
pub fn mark_consumed_for_session(helmor_session_id: &str) -> Result<bool> {
    let connection = db::write_conn()?;
    let rows = connection
        .execute(
            "UPDATE workspaces
             SET ai_priming_consumed = 1,
                 kind = 'manual'
             WHERE id = (SELECT workspace_id FROM sessions WHERE id = ?1)
               AND ai_priming_consumed = 0",
            [helmor_session_id],
        )
        .context("mark ai_priming_consumed + graduate kind")?;
    Ok(rows > 0)
}

// Priming goes first (discovery context), then any user preferences prefix.
pub fn combine_prefixes(priming: Option<String>, existing: Option<String>) -> Option<String> {
    match (priming, existing) {
        (None, None) => None,
        (Some(p), None) => Some(p),
        (None, Some(e)) => Some(e),
        (Some(p), Some(e)) => Some(format!("{p}\n\n{e}")),
    }
}
