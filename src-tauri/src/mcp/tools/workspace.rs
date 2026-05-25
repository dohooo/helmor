use std::str::FromStr;

use anyhow::Result;
use serde_json::{json, Value};

use crate::models;
use crate::service;
use crate::ui_sync::UiMutationEvent;
use crate::workspace::ship_actions::{run_workspace_ship_action, WorkspaceShipActionResult};
use crate::workspace::status::WorkspaceStatus;
use crate::workspace::workspaces;

use super::super::response::{format_json_response, WORKSPACE_COMPACT_FIELDS};
use super::common::{
    bounded_limit, notify_ui_events, parse_workspace_ship_action, required_str,
    workspace_status_matches,
};

pub(super) fn tool_workspace_list(args: &Value) -> Result<String> {
    let limit = bounded_limit(args, 20, 50);
    let archived = args
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if archived {
        let rows = workspaces::list_archived_workspaces()?;
        let total = rows.len();
        let trimmed: Vec<Value> = rows
            .into_iter()
            .take(limit)
            .map(|row| serde_json::to_value(row).unwrap_or(Value::Null))
            .collect();
        let returned = trimmed.len();
        return format_json_response(
            args,
            &json!({
                "workspaces": trimmed,
                "total": total,
                "returned": returned,
                "hasMore": total > returned,
            }),
            Some(WORKSPACE_COMPACT_FIELDS),
        );
    }

    let status_filter = args.get("status").and_then(Value::as_str);
    let repo_ref = args.get("repo").and_then(Value::as_str);

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

    let records = models::workspaces::load_workspace_records()?;
    let mut rows: Vec<Value> = Vec::new();
    let mut total = 0usize;
    for record in records {
        if matches!(
            record.state,
            crate::workspace::state::WorkspaceState::Archived
        ) {
            continue;
        }
        if let Some(wanted) = status_filter {
            if !workspace_status_matches(&record.status, wanted) {
                continue;
            }
        }
        if let Some(name) = &repo_name_filter {
            if record.repo_name.to_lowercase() != *name {
                continue;
            }
        }
        total += 1;
        if rows.len() >= limit {
            continue;
        }
        // MCP variant: drop active-stream enrichment fields. Stored
        // status only; no `isWorking`, no `activeSessionStatus`.
        rows.push(json!({
            "id": record.id,
            "repo": record.repo_name,
            "directory": record.directory_name,
            "title": record
                .primary_session_title
                .clone()
                .or_else(|| record.active_session_title.clone())
                .unwrap_or_else(|| record.directory_name.clone()),
            "status": record.status.group_id(),
            "state": record.state,
            "branch": record.branch,
            "pinned": record.pinned_at.is_some(),
            "activeSessionId": record.active_session_id,
            "activeSessionTitle": record.active_session_title,
            "primarySessionId": record.primary_session_id,
            "primarySessionTitle": record.primary_session_title,
            "storedActiveSessionStatus": record.active_session_status,
            "sessionCount": record.session_count,
            "messageCount": record.message_count,
        }));
    }
    let returned = rows.len();
    format_json_response(
        args,
        &json!({
            "workspaces": rows,
            "total": total,
            "returned": returned,
            "hasMore": total > returned,
        }),
        Some(WORKSPACE_COMPACT_FIELDS),
    )
}

pub(super) fn tool_workspace_show(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "ref")?;
    let ws_id = service::resolve_workspace_ref(ws_ref)?;
    let detail = service::get_workspace(&ws_id)?;
    format_json_response(args, &detail, Some(WORKSPACE_COMPACT_FIELDS))
}

pub(super) fn tool_workspace_create(args: &Value) -> Result<String> {
    let repo_ref = required_str(args, "repo")?;
    let repo_id = service::resolve_repo_ref(repo_ref)?;
    let resp = service::create_workspace_from_repo_impl(&repo_id)?;
    notify_ui_events([
        UiMutationEvent::WorkspaceListChanged,
        UiMutationEvent::WorkspaceChanged {
            workspace_id: resp.created_workspace_id.clone(),
        },
    ]);
    format_json_response(args, &resp, None)
}

pub(super) fn tool_workspace_set_status(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "ref")?;
    let status_raw = required_str(args, "status")?;
    // Accept both the kebab-case stored value AND the kanban group id —
    // "progress" maps to "in-progress" the same way the GUI does.
    let canonical = if status_raw.eq_ignore_ascii_case("progress") {
        "in-progress".to_string()
    } else {
        status_raw.to_ascii_lowercase()
    };
    let status = WorkspaceStatus::from_str(&canonical).map_err(|e| anyhow::anyhow!("{e}"))?;
    let ws_id = service::resolve_workspace_ref(ws_ref)?;
    workspaces::set_workspace_status(&ws_id, status)?;
    notify_ui_events([UiMutationEvent::WorkspaceChanged {
        workspace_id: ws_id.clone(),
    }]);
    format_json_response(
        args,
        &json!({
            "ok": true,
            "workspaceId": ws_id,
            "status": status.as_str(),
        }),
        None,
    )
}

pub(super) fn tool_workspace_archive(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "workspace")?;
    let ws_id = service::resolve_workspace_ref(ws_ref)?;
    let resp = crate::workspace::lifecycle::archive_workspace_impl(&ws_id)?;
    notify_ui_events([
        UiMutationEvent::WorkspaceListChanged,
        UiMutationEvent::WorkspaceChanged {
            workspace_id: ws_id,
        },
    ]);
    format_json_response(args, &resp, None)
}

pub(super) fn tool_workspace_permanently_delete(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "workspace")?;
    let confirmed = args
        .get("confirmed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !confirmed {
        anyhow::bail!(
            "helmor_workspace_permanently_delete: `confirmed` must be true. \
             This deletes the worktree and history; ask the user to confirm first."
        );
    }
    let ws_id = service::resolve_workspace_ref(ws_ref)?;
    workspaces::permanently_delete_workspace(&ws_id)?;
    notify_ui_events([
        UiMutationEvent::WorkspaceListChanged,
        UiMutationEvent::WorkspaceChanged {
            workspace_id: ws_id.clone(),
        },
    ]);
    format_json_response(
        args,
        &json!({
            "ok": true,
            "workspaceId": ws_id,
            "deleted": true,
        }),
        None,
    )
}

pub(super) fn tool_workspace_run_action(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "workspace")?;
    let action = parse_workspace_ship_action(required_str(args, "action")?)?;
    let result = run_workspace_ship_action(ws_ref, action)?;
    notify_ui_events(result.ui_events());

    match result {
        WorkspaceShipActionResult::Direct {
            action,
            workspace_id,
            result,
        } => format_json_response(
            args,
            &json!({
                "ok": true,
                "action": action.mcp_label(),
                "workspaceId": workspace_id,
                "result": result,
            }),
            None,
        ),
        WorkspaceShipActionResult::Dispatched {
            action,
            workspace_id,
            dispatch,
        } => format_json_response(
            args,
            &json!({
                "ok": true,
                "action": action.mcp_label(),
                "workspaceId": workspace_id,
                "dispatched": true,
                "sessionId": dispatch.session_id,
                "provider": dispatch.provider,
                "model": dispatch.model,
                "note": "Action prompt queued in a dedicated Helmor action session.",
            }),
            None,
        ),
    }
}
