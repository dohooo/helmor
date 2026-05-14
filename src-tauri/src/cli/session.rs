//! `helmor session` — session CRUD and thread messages.

use anyhow::Result;
use rusqlite::params;
use serde_json::Value;

use crate::agents::ActionKind;
use crate::pipeline::MessagePipeline;
use crate::service;
use crate::sessions;
use crate::ui_sync::UiMutationEvent;

use super::args::{Cli, ReadState, SessionAction};
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
