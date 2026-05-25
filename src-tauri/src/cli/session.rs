//! `helmor session` — session CRUD and thread messages.

use anyhow::{Context, Result};
use rusqlite::params;
use serde_json::{json, Value};

use crate::agents::ActionKind;
use crate::models;
use crate::pipeline::types::HistoricalRecord;
use crate::pipeline::MessagePipeline;
use crate::service;
use crate::sessions;
use crate::ui_sync::UiMutationEvent;

use super::args::{Cli, ReadState, SessionAction, SessionBodyPosition, SessionWindowPosition};
use super::output;
use super::refs;
use super::{notify_ui_event, notify_ui_events};

pub fn dispatch(action: &SessionAction, cli: &Cli) -> Result<()> {
    match action {
        SessionAction::List { workspace } => list(workspace, cli),
        SessionAction::Hidden { workspace } => list_hidden(workspace, cli),
        SessionAction::Show { workspace, session } => show(workspace, session, cli),
        SessionAction::New {
            workspace,
            plan,
            action_kind,
        } => new(workspace, *plan, action_kind.as_deref(), cli),
        SessionAction::Rename {
            workspace,
            session,
            title,
        } => rename(workspace, session, title, cli),
        SessionAction::Delete { workspace, session } => delete(workspace, session, cli),
        SessionAction::Hide { workspace, session } => hide(workspace, session, cli),
        SessionAction::Unhide { workspace, session } => unhide(workspace, session, cli),
        SessionAction::Mark {
            workspace,
            state,
            session,
        } => mark(workspace, *state, session, cli),
        SessionAction::UpdateSettings {
            workspace,
            session,
            model,
            effort,
            permission_mode,
        } => update_settings(
            workspace,
            session,
            model.as_deref(),
            effort.as_deref(),
            permission_mode.as_deref(),
            cli,
        ),
        SessionAction::Search {
            query,
            repo,
            status,
            include_archived,
            limit,
        } => search(
            query.as_deref(),
            repo.as_deref(),
            status.as_deref(),
            *include_archived,
            *limit,
            cli,
        ),
        SessionAction::GetMessages {
            session,
            limit,
            position,
            body_limit,
            body_position,
        } => get_messages(session, *limit, *position, *body_limit, *body_position, cli),
    }
}

fn list(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let sessions = service::list_workspace_sessions(&workspace_id)?;
    output::print(cli, &sessions, |items| {
        if items.is_empty() {
            "No sessions.".to_string()
        } else {
            items
                .iter()
                .map(|s| {
                    let active = if s.active { " *" } else { "" };
                    format!("{}\t{}\t{}{}", s.id, s.status, s.title, active)
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    })
}

fn list_hidden(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let hidden = sessions::list_hidden_sessions(&workspace_id)?;
    output::print(cli, &hidden, |items| {
        if items.is_empty() {
            "No hidden sessions.".to_string()
        } else {
            items
                .iter()
                .map(|s| format!("{}\t{}\t{}", s.id, s.status, s.title))
                .collect::<Vec<_>>()
                .join("\n")
        }
    })
}

fn show(workspace_ref: &str, session: &str, cli: &Cli) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let session_id = refs::resolve_session_ref(&workspace_id, session)?;
    let records = sessions::list_session_historical_records(&session_id)?;
    let thread = MessagePipeline::convert_historical(&records);
    output::print(cli, &thread, |messages| {
        if messages.is_empty() {
            "No messages.".to_string()
        } else {
            messages
                .iter()
                .map(|m| {
                    let role = format!("{:?}", m.role).to_lowercase();
                    let text = summarize_parts(&m.content);
                    format!("[{role}] {text}")
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        }
    })
}

/// Flatten message parts into a readable snippet — enough for a CLI view
/// without becoming a conversation renderer.
fn summarize_parts(parts: &[crate::pipeline::types::ExtendedMessagePart]) -> String {
    use crate::pipeline::types::{ExtendedMessagePart, MessagePart};
    let mut segments = Vec::new();
    for part in parts {
        match part {
            ExtendedMessagePart::Basic(MessagePart::Text { text, .. }) => {
                segments.push(text.clone());
            }
            ExtendedMessagePart::Basic(MessagePart::Reasoning { text, .. }) => {
                segments.push(format!("<thinking>{text}</thinking>"));
            }
            ExtendedMessagePart::Basic(MessagePart::ToolCall {
                tool_name,
                args_text,
                ..
            }) => {
                segments.push(format!("<tool:{tool_name}> {args_text}"));
            }
            ExtendedMessagePart::Basic(other) => {
                if let Ok(v) = serde_json::to_value(other) {
                    segments.push(compact_json(&v));
                }
            }
            ExtendedMessagePart::CollapsedGroup(group) => {
                if let Ok(v) = serde_json::to_value(group) {
                    segments.push(compact_json(&v));
                }
            }
        }
    }
    segments.join("\n")
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn new(workspace_ref: &str, plan: bool, action_kind: Option<&str>, cli: &Cli) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let kind = match action_kind {
        Some(raw) => Some(parse_action_kind(raw)?),
        None => None,
    };
    let permission_mode = if plan { Some("plan") } else { None };
    let response = sessions::create_session(
        &workspace_id,
        kind,
        permission_mode,
        crate::models::sessions::CreateSessionOverrides::default(),
    )?;
    notify_ui_event(UiMutationEvent::SessionListChanged {
        workspace_id: workspace_id.clone(),
    });
    output::print_id(cli, "sessionId", &response.session_id);
    Ok(())
}

fn parse_action_kind(raw: &str) -> Result<ActionKind> {
    let value = Value::String(raw.to_string());
    serde_json::from_value(value).map_err(|e| anyhow::anyhow!("Unknown action kind '{raw}': {e}"))
}

fn rename(workspace_ref: &str, session: &str, title: &str, cli: &Cli) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let session_id = refs::resolve_session_ref(&workspace_id, session)?;
    sessions::rename_session(&session_id, title)?;
    notify_ui_event(UiMutationEvent::SessionListChanged { workspace_id });
    output::print_ok(cli, &format!("Renamed {session_id} to {title}"));
    Ok(())
}

fn delete(workspace_ref: &str, session: &str, cli: &Cli) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let session_id = refs::resolve_session_ref(&workspace_id, session)?;
    sessions::delete_session(&session_id)?;
    notify_ui_event(UiMutationEvent::SessionListChanged { workspace_id });
    output::print_ok(cli, &format!("Deleted {session_id}"));
    Ok(())
}

fn hide(workspace_ref: &str, session: &str, cli: &Cli) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let session_id = refs::resolve_session_ref(&workspace_id, session)?;
    sessions::hide_session(&session_id)?;
    notify_ui_event(UiMutationEvent::SessionListChanged { workspace_id });
    output::print_ok(cli, &format!("Hid {session_id}"));
    Ok(())
}

fn unhide(workspace_ref: &str, session: &str, cli: &Cli) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let session_id = refs::resolve_session_ref(&workspace_id, session)?;
    sessions::unhide_session(&session_id)?;
    notify_ui_event(UiMutationEvent::SessionListChanged { workspace_id });
    output::print_ok(cli, &format!("Unhid {session_id}"));
    Ok(())
}

fn mark(workspace_ref: &str, state: ReadState, session: &str, cli: &Cli) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let session_id = refs::resolve_session_ref(&workspace_id, session)?;
    match state {
        ReadState::Read => sessions::mark_session_read(&session_id)?,
        ReadState::Unread => sessions::mark_session_unread(&session_id)?,
    };
    notify_ui_events([
        UiMutationEvent::SessionListChanged {
            workspace_id: workspace_id.clone(),
        },
        UiMutationEvent::WorkspaceChanged { workspace_id },
    ]);
    output::print_ok(cli, &format!("Marked {session_id} as {state:?}"));
    Ok(())
}

fn update_settings(
    workspace_ref: &str,
    session: &str,
    model: Option<&str>,
    effort: Option<&str>,
    permission_mode: Option<&str>,
    cli: &Cli,
) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let session_id = refs::resolve_session_ref(&workspace_id, session)?;
    let conn = crate::models::db::write_conn()?;
    conn.execute(
        r#"
        UPDATE sessions SET
          model = COALESCE(?2, model),
          effort_level = COALESCE(?3, effort_level),
          permission_mode = COALESCE(?4, permission_mode)
        WHERE id = ?1
        "#,
        params![session_id, model, effort, permission_mode],
    )?;
    notify_ui_event(UiMutationEvent::SessionListChanged { workspace_id });
    output::print_ok(cli, "Session settings updated");
    Ok(())
}

// ---------------------------------------------------------------------------
// Search / GetMessages — agent-facing read tools
//
// These mirror the MCP `helmor_session_search` / `_get_messages` tools so
// CLI clients (including any agent invoking `helmor-cli`) can use the same
// queries the MCP surface exposes. The MCP catalog is on its way out;
// implementations live here as the canonical home.
// ---------------------------------------------------------------------------

const SEARCH_LIMIT_MAX: u32 = 20;
const GET_MESSAGES_LIMIT_MAX: u32 = 20;
const BODY_LIMIT_MAX: u32 = 4000;

fn search(
    query: Option<&str>,
    repo_ref: Option<&str>,
    status: Option<&str>,
    include_archived: bool,
    limit: u32,
    cli: &Cli,
) -> Result<()> {
    let trimmed_query = query.map(str::trim).filter(|s| !s.is_empty());
    let status_filter = status.map(str::to_ascii_lowercase);
    if trimmed_query.is_none() && status_filter.is_none() {
        anyhow::bail!("session search: provide --query or --status (or both)");
    }
    let limit = limit.clamp(1, SEARCH_LIMIT_MAX) as usize;

    let repo_name_filter = match repo_ref {
        Some(reference) => {
            let repo_id = service::resolve_repo_ref(reference)?;
            models::repos::list_repositories()?
                .into_iter()
                .find(|r| r.id == repo_id)
                .map(|r| r.name.to_lowercase())
        }
        None => None,
    };
    let like = trimmed_query.map(|q| format!("%{}%", q.to_ascii_lowercase()));

    let conn = models::db::read_conn()?;
    let mut statement = conn.prepare(
        r#"
        SELECT
          s.id,
          s.workspace_id,
          s.title,
          s.agent_type,
          s.status,
          s.model,
          s.permission_mode,
          s.updated_at,
          s.last_user_message_at,
          s.action_kind,
          w.active_session_id,
          w.directory_name,
          w.state,
          COALESCE(w.status, 'in-progress') AS workspace_status,
          r.name AS repo_name
        FROM sessions s
        JOIN workspaces w ON w.id = s.workspace_id
        JOIN repos r ON r.id = w.repository_id
        WHERE COALESCE(s.is_hidden, 0) = 0
          AND (?2 OR w.state != 'archived')
          AND (?3 IS NULL OR lower(r.name) = ?3)
          AND (
            ?1 IS NULL
            OR lower(s.title) LIKE ?1
            OR EXISTS (
              SELECT 1
              FROM session_messages sm
              WHERE sm.session_id = s.id AND lower(sm.content) LIKE ?1
            )
          )
        ORDER BY
          CASE WHEN ?1 IS NOT NULL AND lower(s.title) LIKE ?1 THEN 0 ELSE 1 END,
          datetime(s.updated_at) DESC,
          s.id DESC
        "#,
    )?;

    let rows = statement.query_map(params![like, include_archived, repo_name_filter], |row| {
        let session_id: String = row.get(0)?;
        let workspace_id: String = row.get(1)?;
        let title: String = row.get(2)?;
        let session_status: String = row.get(4)?;
        let active_session_id: Option<String> = row.get(10)?;
        let directory: String = row.get(11)?;
        let repo_name: String = row.get(14)?;
        Ok(json!({
            "sessionId": session_id,
            "workspaceId": workspace_id,
            "workspaceRef": format!("{}/{}", repo_name, directory),
            "workspaceDirectory": directory,
            "workspaceState": row.get::<_, String>(12)?,
            "workspaceStatus": row.get::<_, String>(13)?,
            "repo": repo_name,
            "title": title,
            "sessionStatus": session_status,
            "active": active_session_id.as_deref() == Some(session_id.as_str()),
            "agentType": row.get::<_, Option<String>>(3)?,
            "model": row.get::<_, Option<String>>(5)?,
            "permissionMode": row.get::<_, String>(6)?,
            "updatedAt": row.get::<_, String>(7)?,
            "lastUserMessageAt": row.get::<_, Option<String>>(8)?,
            "actionKind": row.get::<_, Option<String>>(9)?,
        }))
    })?;

    let mut sessions: Vec<Value> = Vec::new();
    let mut total = 0usize;
    for row in rows {
        let row = row?;
        if let Some(wanted) = status_filter.as_deref() {
            let stored = row.get("sessionStatus").and_then(Value::as_str);
            if !stored
                .map(|s| s.eq_ignore_ascii_case(wanted))
                .unwrap_or(false)
            {
                continue;
            }
        }
        total += 1;
        if sessions.len() < limit {
            sessions.push(row);
        }
    }
    let returned = sessions.len();
    let envelope = json!({
        "sessions": sessions,
        "returned": returned,
        "total": total,
        "hasMore": total > returned,
    });
    output::print(cli, &envelope, |val| {
        let empty: Vec<Value> = Vec::new();
        let rows = val
            .get("sessions")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        if rows.is_empty() {
            "No matching sessions.".to_string()
        } else {
            rows.iter()
                .map(|r| {
                    let id = r.get("sessionId").and_then(Value::as_str).unwrap_or("?");
                    let ws_ref = r.get("workspaceRef").and_then(Value::as_str).unwrap_or("?");
                    let status = r
                        .get("sessionStatus")
                        .and_then(Value::as_str)
                        .unwrap_or("?");
                    let title = r
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("(no title)");
                    format!("{id}\t{ws_ref}\t{status}\t{title}")
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    })
}

fn get_messages(
    session_id: &str,
    limit: u32,
    position: SessionWindowPosition,
    body_limit: u32,
    body_position: SessionBodyPosition,
    cli: &Cli,
) -> Result<()> {
    let limit = limit.clamp(1, GET_MESSAGES_LIMIT_MAX) as usize;
    let body_limit = body_limit.clamp(1, BODY_LIMIT_MAX) as usize;

    let (records, total_messages) = list_session_records(session_id, limit, position)?;
    let messages: Vec<Value> = records
        .iter()
        .map(|record| {
            let summary = summarize_historical_record(record);
            let total = summary.chars().count();
            let take = body_limit.min(total);
            let offset = match body_position {
                SessionBodyPosition::End => total.saturating_sub(take),
                SessionBodyPosition::Start => 0,
            };
            let body: String = summary.chars().skip(offset).take(take).collect();
            let returned = body.chars().count();
            json!({
                "id": record.id,
                "role": record.role,
                "createdAt": record.created_at,
                "body": body,
                "bodyOffset": offset,
                "bodyLength": returned,
                "bodyTotal": total,
                "bodyHasMore": returned < total,
            })
        })
        .collect();

    let envelope = json!({
        "messages": messages,
        "windowSize": records.len(),
        "total": total_messages,
        "hasMore": total_messages > records.len(),
    });
    output::print(cli, &envelope, |val| {
        let empty: Vec<Value> = Vec::new();
        let msgs = val
            .get("messages")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        if msgs.is_empty() {
            "No messages.".to_string()
        } else {
            msgs.iter()
                .map(|m| {
                    let role = m.get("role").and_then(Value::as_str).unwrap_or("?");
                    let body = m.get("body").and_then(Value::as_str).unwrap_or("");
                    let has_more = m
                        .get("bodyHasMore")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let suffix = if has_more { "  …" } else { "" };
                    format!("[{role}]\n{body}{suffix}")
                })
                .collect::<Vec<_>>()
                .join("\n\n----\n\n")
        }
    })
}

/// SQL window into `session_messages`. Returns rows in chronological
/// order regardless of `position`; `position == Tail` selects the newest
/// `limit` rows.
fn list_session_records(
    session_id: &str,
    limit: usize,
    position: SessionWindowPosition,
) -> Result<(Vec<HistoricalRecord>, usize)> {
    let connection = models::db::read_conn()?;
    let total: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .context("Failed to count session messages")?;

    let order = match position {
        SessionWindowPosition::Head => "ASC",
        SessionWindowPosition::Tail => "DESC",
    };
    let mut statement = connection.prepare(&format!(
        r#"
        SELECT
          sm.id,
          sm.role,
          sm.content,
          sm.created_at
        FROM session_messages sm
        WHERE sm.session_id = ?1
        ORDER BY sm.sent_at {order}, sm.rowid {order}
        LIMIT ?2
        "#
    ))?;
    let rows = statement.query_map(params![session_id, limit as i64], |row| {
        let content: String = row.get(2)?;
        Ok(HistoricalRecord {
            id: row.get(0)?,
            role: row.get(1)?,
            parsed_content: serde_json::from_str::<Value>(&content).ok(),
            content,
            created_at: row.get(3)?,
        })
    })?;
    let mut records = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    if matches!(position, SessionWindowPosition::Tail) {
        records.reverse();
    }
    Ok((records, total.max(0) as usize))
}

/// Collapse a stored `session_messages.content` row into a single
/// human-readable string. Mirrors the formatter the MCP surface uses so
/// CLI + MCP output stay aligned during the MCP deprecation window.
fn summarize_historical_record(record: &HistoricalRecord) -> String {
    let Some(parsed) = &record.parsed_content else {
        return record.content.clone();
    };
    let Some(msg_type) = parsed.get("type").and_then(Value::as_str) else {
        return record.content.clone();
    };
    match msg_type {
        "user_prompt" | "user" => parsed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("(empty user message)")
            .to_string(),
        "assistant" => summarize_assistant_blocks(parsed),
        "system" => parsed
            .get("subtype")
            .and_then(Value::as_str)
            .map(|s| format!("[system: {s}]"))
            .unwrap_or_else(|| "[system event]".to_owned()),
        "error" => parsed
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| parsed.get("error").and_then(Value::as_str))
            .unwrap_or("[error]")
            .to_string(),
        "result" => parsed
            .get("result")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| "[result]".to_owned()),
        "item.completed" | "turn.completed" => format!("[{msg_type}]"),
        other => format!("[{other}]"),
    }
}

fn summarize_assistant_blocks(parsed: &Value) -> String {
    let Some(blocks) = parsed.pointer("/message/content").and_then(Value::as_array) else {
        return "[assistant: no content]".to_owned();
    };
    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                }
            }
            Some("thinking") => {
                if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                    parts.push(format!("[thinking] {text}"));
                }
            }
            Some("tool_use") => {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("?");
                parts.push(format!("[used tool: {name}]"));
            }
            Some(other) => parts.push(format!("[block: {other}]")),
            None => {}
        }
    }
    if parts.is_empty() {
        "[assistant: empty content]".to_owned()
    } else {
        parts.join("\n\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- summarize_historical_record -------------------------------
    //
    // These tests pin the output shape the CLI (and any agent consuming
    // CLI output) sees for each `session_messages.content.type` variant
    // we've shipped. Drift here would silently change the body strings
    // every `session get-messages` result reports — exactly the kind of
    // regression hard to spot via integration tests.

    use crate::pipeline::types::MessageRole;

    fn record(content: Value, role: MessageRole) -> HistoricalRecord {
        HistoricalRecord {
            id: "test-id".to_string(),
            role,
            // Persist the raw JSON string + the parsed Value so the
            // summarizer's fallback (raw content when parsing fails) is
            // exercisable via a separate constructor below.
            content: content.to_string(),
            parsed_content: Some(content),
            created_at: "2026-05-25T00:00:00Z".to_string(),
        }
    }

    fn record_with_raw_content(raw: &str, role: MessageRole) -> HistoricalRecord {
        HistoricalRecord {
            id: "test-id".to_string(),
            role,
            content: raw.to_string(),
            parsed_content: serde_json::from_str(raw).ok(),
            created_at: "2026-05-25T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn summarizes_user_prompt_to_text_field() {
        let r = record(
            json!({ "type": "user_prompt", "text": "hello world" }),
            MessageRole::User,
        );
        assert_eq!(summarize_historical_record(&r), "hello world");
    }

    #[test]
    fn summarizes_user_to_text_field() {
        // `type: "user"` is the second shape the sidecar emits (the SDK
        // calls it differently across providers). Same rendering.
        let r = record(
            json!({ "type": "user", "text": "from claude" }),
            MessageRole::User,
        );
        assert_eq!(summarize_historical_record(&r), "from claude");
    }

    #[test]
    fn summarizes_user_with_no_text_uses_placeholder() {
        let r = record(json!({ "type": "user_prompt" }), MessageRole::User);
        assert_eq!(summarize_historical_record(&r), "(empty user message)");
    }

    #[test]
    fn summarizes_system_event_with_subtype() {
        let r = record(
            json!({ "type": "system", "subtype": "init" }),
            MessageRole::System,
        );
        assert_eq!(summarize_historical_record(&r), "[system: init]");
    }

    #[test]
    fn summarizes_system_event_without_subtype_uses_placeholder() {
        let r = record(json!({ "type": "system" }), MessageRole::System);
        assert_eq!(summarize_historical_record(&r), "[system event]");
    }

    #[test]
    fn summarizes_error_with_message_field() {
        let r = record(
            json!({ "type": "error", "message": "boom" }),
            MessageRole::System,
        );
        assert_eq!(summarize_historical_record(&r), "boom");
    }

    #[test]
    fn summarizes_error_falls_back_to_error_field() {
        // Some providers emit `error` instead of `message`. Both must be
        // recognised — pin so a refactor doesn't accidentally drop one.
        let r = record(
            json!({ "type": "error", "error": "bad" }),
            MessageRole::System,
        );
        assert_eq!(summarize_historical_record(&r), "bad");
    }

    #[test]
    fn summarizes_error_with_no_text_uses_placeholder() {
        let r = record(json!({ "type": "error" }), MessageRole::System);
        assert_eq!(summarize_historical_record(&r), "[error]");
    }

    #[test]
    fn summarizes_result_with_string_field() {
        let r = record(
            json!({ "type": "result", "result": "ok" }),
            MessageRole::System,
        );
        assert_eq!(summarize_historical_record(&r), "ok");
    }

    #[test]
    fn summarizes_result_without_field_uses_placeholder() {
        let r = record(json!({ "type": "result" }), MessageRole::System);
        assert_eq!(summarize_historical_record(&r), "[result]");
    }

    #[test]
    fn summarizes_lifecycle_events_to_bracketed_type() {
        for (msg_type, expected) in [
            ("item.completed", "[item.completed]"),
            ("turn.completed", "[turn.completed]"),
        ] {
            let r = record(json!({ "type": msg_type }), MessageRole::System);
            assert_eq!(summarize_historical_record(&r), expected);
        }
    }

    #[test]
    fn summarizes_unknown_type_to_bracketed_label() {
        let r = record(json!({ "type": "some.future.event" }), MessageRole::System);
        assert_eq!(summarize_historical_record(&r), "[some.future.event]");
    }

    #[test]
    fn summarizes_unparseable_content_returns_raw() {
        // Non-JSON content — `parsed_content` is None, summarizer must
        // fall through to the raw bytes so the agent at least sees the
        // original DB row.
        let r = record_with_raw_content("not json at all", MessageRole::User);
        assert_eq!(summarize_historical_record(&r), "not json at all");
    }

    #[test]
    fn summarizes_parsed_without_type_returns_raw() {
        // Parses fine but has no "type" field — same fallback path.
        let r = record(json!({ "text": "lonely" }), MessageRole::User);
        // Whitespace/quoting comes from the raw JSON string round-trip.
        assert_eq!(summarize_historical_record(&r), "{\"text\":\"lonely\"}");
    }

    // ---- summarize_assistant_blocks --------------------------------
    //
    // Helmor stores assistant turns as a structured `message.content`
    // array of typed blocks. We need to flatten them for both human
    // CLI users AND for agents consuming `session get-messages` —
    // each block kind has a deliberate rendering.

    fn assistant_blocks(blocks: Value) -> Value {
        json!({ "message": { "content": blocks } })
    }

    #[test]
    fn assistant_text_blocks_flatten_to_their_text() {
        let parsed = assistant_blocks(json!([
            { "type": "text", "text": "first" },
            { "type": "text", "text": "second" },
        ]));
        assert_eq!(summarize_assistant_blocks(&parsed), "first\n\nsecond");
    }

    #[test]
    fn assistant_thinking_block_is_prefixed() {
        let parsed = assistant_blocks(json!([
            { "type": "thinking", "thinking": "let me work it out" },
        ]));
        assert_eq!(
            summarize_assistant_blocks(&parsed),
            "[thinking] let me work it out"
        );
    }

    #[test]
    fn assistant_tool_use_renders_name() {
        let parsed = assistant_blocks(json!([
            { "type": "tool_use", "name": "Read" },
        ]));
        assert_eq!(summarize_assistant_blocks(&parsed), "[used tool: Read]");
    }

    #[test]
    fn assistant_tool_use_without_name_uses_placeholder() {
        let parsed = assistant_blocks(json!([{ "type": "tool_use" }]));
        assert_eq!(summarize_assistant_blocks(&parsed), "[used tool: ?]");
    }

    #[test]
    fn assistant_unknown_block_kind_is_labeled() {
        let parsed = assistant_blocks(json!([
            { "type": "redacted_thinking", "data": "<sealed>" },
        ]));
        assert_eq!(
            summarize_assistant_blocks(&parsed),
            "[block: redacted_thinking]"
        );
    }

    #[test]
    fn assistant_mixed_blocks_join_with_blank_line() {
        let parsed = assistant_blocks(json!([
            { "type": "text", "text": "answer:" },
            { "type": "tool_use", "name": "Edit" },
        ]));
        assert_eq!(
            summarize_assistant_blocks(&parsed),
            "answer:\n\n[used tool: Edit]"
        );
    }

    #[test]
    fn assistant_empty_content_array_returns_placeholder() {
        let parsed = assistant_blocks(json!([]));
        assert_eq!(
            summarize_assistant_blocks(&parsed),
            "[assistant: empty content]"
        );
    }

    #[test]
    fn assistant_missing_content_path_returns_placeholder() {
        // `message.content` is missing entirely (or not an array).
        let parsed = json!({ "message": {} });
        assert_eq!(
            summarize_assistant_blocks(&parsed),
            "[assistant: no content]"
        );
    }

    // Sanity: the dispatcher in summarize_historical_record routes to the
    // assistant flattener when type == "assistant".
    #[test]
    fn summarize_historical_record_routes_assistant_to_block_flattener() {
        let r = record(
            json!({
                "type": "assistant",
                "message": { "content": [{ "type": "text", "text": "ack" }] },
            }),
            MessageRole::Assistant,
        );
        assert_eq!(summarize_historical_record(&r), "ack");
    }
}
