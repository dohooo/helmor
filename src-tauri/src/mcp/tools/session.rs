use anyhow::Result;
use serde_json::{json, Value};

use crate::models;
use crate::service;
use crate::ui_sync::UiMutationEvent;

use super::super::response::{format_json_response, SESSION_COMPACT_FIELDS};
use super::common::{bounded_limit, notify_ui_events, required_str};

pub(super) fn tool_session_list(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "workspace")?;
    let limit = bounded_limit(args, 10, 20);
    let ws_id = service::resolve_workspace_ref(ws_ref)?;
    let mut sessions = service::list_workspace_sessions(&ws_id)?;
    let total = sessions.len();
    sessions.truncate(limit);
    let returned = sessions.len();
    format_json_response(
        args,
        &json!({
            "sessions": sessions,
            "total": total,
            "returned": returned,
            "hasMore": total > returned,
        }),
        Some(SESSION_COMPACT_FIELDS),
    )
}

pub(super) fn tool_session_create(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "workspace")?;
    let permission_mode = args["plan"]
        .as_bool()
        .and_then(|enabled| enabled.then_some("plan"));
    let ws_id = service::resolve_workspace_ref(ws_ref)?;
    let resp = service::create_session(
        &ws_id,
        None,
        permission_mode,
        crate::models::sessions::CreateSessionOverrides::default(),
    )?;
    notify_ui_events([
        UiMutationEvent::SessionListChanged {
            workspace_id: ws_id.clone(),
        },
        UiMutationEvent::WorkspaceChanged {
            workspace_id: ws_id,
        },
    ]);
    format_json_response(args, &resp, None)
}

pub(super) fn tool_session_search(args: &Value) -> Result<String> {
    let limit = bounded_limit(args, 8, 20);
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let include_archived = args
        .get("include_archived")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let status = args
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if query.is_none() && status.is_none() {
        anyhow::bail!("helmor_session_search: provide `query` or `status`");
    }
    let repo_name_filter = match args.get("repo").and_then(Value::as_str) {
        Some(reference) => {
            let repo_id = service::resolve_repo_ref(reference)?;
            models::repos::list_repositories()?
                .into_iter()
                .find(|r| r.id == repo_id)
                .map(|r| r.name.to_lowercase())
        }
        None => None,
    };
    let envelope = models::session_inspection::search_sessions(
        models::session_inspection::SessionSearchOptions {
            query,
            repo_name_filter: repo_name_filter.as_deref(),
            status,
            include_archived,
            limit,
        },
    )?;
    format_json_response(args, &envelope, Some(SESSION_COMPACT_FIELDS))
}

pub(super) fn tool_session_get_messages(args: &Value) -> Result<String> {
    const DEFAULT_LIMIT: usize = 5;
    const DEFAULT_BODY_LIMIT: usize = 800;

    let session_id = required_str(args, "session")?;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, models::session_inspection::GET_MESSAGES_LIMIT_MAX))
        .unwrap_or(DEFAULT_LIMIT);
    let body_limit = args
        .get("body_limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, models::session_inspection::BODY_LIMIT_MAX))
        .unwrap_or(DEFAULT_BODY_LIMIT);
    let position = args
        .get("position")
        .and_then(Value::as_str)
        .unwrap_or("tail");
    let body_position = args
        .get("body_position")
        .and_then(Value::as_str)
        .unwrap_or("start");

    let envelope = models::session_inspection::get_session_messages(
        session_id,
        limit,
        models::session_inspection::SessionWindowPosition::from_mcp_value(position),
        body_limit,
        models::session_inspection::SessionBodyPosition::from_mcp_value(body_position),
    )?;
    format_json_response(args, &envelope, None)
}
