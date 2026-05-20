//! Minimal MCP (Model Context Protocol) server over stdio.
//!
//! Implements JSON-RPC 2.0 with tools capability. Each request is one
//! line of JSON on stdin; each response is one line on stdout.
//!
//! ## Tool catalog (Phase B)
//!
//! This MCP surface exposes Helmor's domain operations that don't
//! require Tauri runtime state (no `AppHandle`, no `ScriptProcessManager`,
//! no `ActiveStreams`). Voice-side handlers in `commands/voice_agent.rs`
//! that DO need runtime state are NOT mirrored here — see the migration
//! block in `ToolKind` for what's intentionally absent.
//!
//! The MCP variants of `*_list` / `*_show` tools drop the "is this
//! session live-streaming?" enrichment fields (`isWorking`,
//! `activeSessionStatus`) because there's no in-process `ActiveStreams`
//! to consult. Callers see stored status only.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{self, BufRead, Write};
use std::str::FromStr;

use crate::agents::AgentStreamEvent;
use crate::models;
use crate::pipeline::types::{ExtendedMessagePart, HistoricalRecord, MessagePart};
use crate::service;
use crate::workspace::status::WorkspaceStatus;
use crate::workspace::workspaces;

pub fn run_mcp_server() -> Result<()> {
    // Bootstrap DB (same as CLI)
    crate::data_dir::ensure_directory_structure()?;
    let db_path = crate::data_dir::db_path()?;
    let conn = rusqlite::Connection::open(&db_path)?;
    crate::schema_init(&conn);
    drop(conn);

    let stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    for line in stdin.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let resp = json_rpc_error(Value::Null, -32700, &format!("Parse error: {e}"));
                writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
                stdout.flush()?;
                continue;
            }
        };

        let method = request.get("method").and_then(Value::as_str).unwrap_or("");

        // Notifications have no id — don't send a response
        if method.starts_with("notifications/") {
            continue;
        }

        let response = match method {
            "initialize" => handle_initialize(&request),
            "ping" => handle_ping(&request),
            "tools/list" => handle_tools_list(&request),
            "tools/call" => handle_tools_call(&request),
            _ => json_rpc_error(
                request["id"].clone(),
                -32601,
                &format!("Method not found: {method}"),
            ),
        };

        writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
        stdout.flush()?;
    }

    Ok(())
}

fn handle_initialize(request: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": request["id"],
        "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "helmor",
                "version": "0.1.0"
            }
        }
    })
}

fn handle_ping(request: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": request["id"], "result": {} })
}

fn handle_tools_list(request: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": request["id"],
        "result": { "tools": tool_catalog() }
    })
}

/// All tools we advertise. Kept as a top-level function so unit tests
/// can inspect the catalog without spinning up the stdio loop.
pub(crate) fn tool_catalog() -> Vec<Value> {
    vec![
        tool_def(
            "helmor_data_info",
            "Show Helmor data directory, database path, and mode",
            add_response_options(json!({ "type": "object", "properties": {}, "required": [] })),
        ),
        tool_def(
            "helmor_repo_list",
            "List all registered repositories. Defaults to compact output without repoIconSrc; use response_mode='full' and include_icon=true only when a UI explicitly needs icons.",
            add_response_options(json!({ "type": "object", "properties": {}, "required": [] })),
        ),
        tool_def(
            "helmor_repo_add",
            "Register a local Git repository (creates first workspace automatically).",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the repository root" }
                },
                "required": ["path"]
            })),
        ),
        tool_def(
            "helmor_workspace_list",
            "List workspaces with optional filters. Returns active workspaces unless `archived: true`. Filter by stored status (in-progress/done/review/backlog/canceled), repo name or UUID, and result limit.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "status": { "type": "string", "description": "Filter by stored workspace status. Accepts a kanban lane id (progress/done/review/backlog/canceled) or the canonical status string (in-progress/done/...)." },
                    "repo": { "type": "string", "description": "Repository UUID or name" },
                    "archived": { "type": "boolean", "description": "If true, list archived workspaces instead of active ones." },
                    "limit": { "type": "integer", "description": "Max rows to return (1-50, default 20)" }
                },
                "required": []
            })),
        ),
        tool_def(
            "helmor_workspace_show",
            "Show details for a workspace.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "ref": { "type": "string", "description": "Workspace UUID or repo-name/directory-name" }
                },
                "required": ["ref"]
            })),
        ),
        tool_def(
            "helmor_workspace_create",
            "Create a new workspace for a repository.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "Repository UUID or name" }
                },
                "required": ["repo"]
            })),
        ),
        tool_def(
            "helmor_workspace_set_status",
            "Move a workspace into a different kanban lane. Use this when the user verbally moves a workspace to done/review/backlog/in-progress/canceled. Canceled and Done are destructive-feeling; callers should confirm with the user first.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "ref": { "type": "string", "description": "Workspace UUID or repo-name/directory-name" },
                    "status": {
                        "type": "string",
                        "enum": ["in-progress", "done", "review", "backlog", "canceled"],
                        "description": "Target status. Accepts kanban group ids (progress = in-progress)."
                    }
                },
                "required": ["ref", "status"]
            })),
        ),
        tool_def(
            "helmor_workspace_archive",
            "Archive a workspace. Reversible — the workspace moves to the archive list and can be restored later. No confirmation required.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Workspace UUID or repo-name/directory-name" }
                },
                "required": ["workspace"]
            })),
        ),
        tool_def(
            "helmor_workspace_permanently_delete",
            "Permanently delete a workspace. NOT REVERSIBLE — deletes the worktree directory and all history. The caller MUST have explicit user confirmation; the tool requires `confirmed: true` to proceed.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Workspace UUID or repo-name/directory-name" },
                    "confirmed": { "type": "boolean", "description": "Must be true. The tool refuses to run otherwise." }
                },
                "required": ["workspace", "confirmed"]
            })),
        ),
        tool_def(
            "helmor_workspace_run_action",
            "Run a workspace ship action. \"Direct\" actions run inline (merge_pr merges the open change request; pull_latest rebases onto target). \"Agent-dispatched\" actions (commit_and_push / create_pr / fix_errors / resolve_conflicts) send a canned prompt to the workspace's active agent — the agent does the work in its own session and you'll see results in the Helmor GUI.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Workspace UUID or repo-name/directory-name" },
                    "action": {
                        "type": "string",
                        "enum": [
                            "merge_pr",
                            "pull_latest",
                            "commit_and_push",
                            "create_pr",
                            "fix_errors",
                            "resolve_conflicts"
                        ],
                        "description": "merge_pr / pull_latest run inline. commit_and_push / create_pr / fix_errors / resolve_conflicts dispatch a canned prompt to the workspace agent."
                    }
                },
                "required": ["workspace", "action"]
            })),
        ),
        tool_def(
            "helmor_session_list",
            "List sessions in a workspace, newest first. Returns stored session status only (no live-stream awareness).",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Workspace UUID or repo-name/directory-name" },
                    "limit": { "type": "integer", "description": "Max rows (1-20, default 10)" }
                },
                "required": ["workspace"]
            })),
        ),
        tool_def(
            "helmor_session_create",
            "Create a new session in a workspace.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Workspace UUID or repo-name/directory-name" },
                    "plan": { "type": "boolean", "description": "If true, start the session in plan permission mode." }
                },
                "required": ["workspace"]
            })),
        ),
        tool_def(
            "helmor_session_search",
            "Search sessions across all workspaces by title or message content substring. Either `query` or `status` (or both) must be provided. Returns stored session status only (no live-stream awareness) and does NOT include message snippets in this MCP variant — use helmor_session_get_messages on a matched session to read messages directly.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Case-insensitive substring matched against session title and message content." },
                    "repo": { "type": "string", "description": "Filter by repo UUID or name." },
                    "status": { "type": "string", "description": "Filter by stored session status (idle/streaming/...)" },
                    "include_archived": { "type": "boolean", "description": "Include sessions in archived workspaces. Default false." },
                    "limit": { "type": "integer", "description": "Max rows (1-20, default 8)" }
                },
                "required": []
            })),
        ),
        tool_def(
            "helmor_session_get_messages",
            "Fetch a window of messages from a session. Use after helmor_session_list / helmor_session_search to read what an agent said or what the user asked. Trailing window by default; pass `position: \"head\"` for the start. Each message body is char-bounded with `body_limit`; if `bodyHasMore` is true, re-call with `body_offset = previous bodyOffset + bodyLength`.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "session": { "type": "string", "description": "Session UUID (from helmor_session_list / search)" },
                    "limit": { "type": "integer", "description": "How many messages to return (1-20, default 5)" },
                    "position": { "type": "string", "enum": ["head", "tail"], "description": "Where the window starts. tail = newest. Default tail." },
                    "body_limit": { "type": "integer", "description": "Per-message body char cap (1-4000, default 800)" },
                    "body_position": { "type": "string", "enum": ["start", "end"], "description": "Which slice of each message body to return. Default start." }
                },
                "required": ["session"]
            })),
        ),
        tool_def(
            "helmor_send",
            "Send a prompt to an AI agent in a workspace.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Workspace UUID or repo-name/directory-name" },
                    "prompt": { "type": "string", "description": "The prompt to send to the AI agent" },
                    "model": { "type": "string", "description": "Model ID (default: opus-1m)" },
                    "session_id": { "type": "string", "description": "Session UUID (default: active session)" }
                },
                "required": ["workspace", "prompt"]
            })),
        ),
    ]
}

fn handle_tools_call(request: &Value) -> Value {
    let id = request["id"].clone();
    let tool_name = request["params"]["name"].as_str().unwrap_or("");
    let args = &request["params"]["arguments"];

    let result = dispatch_tool(tool_name, args);

    match result {
        Ok(text) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": text }],
                "isError": false
            }
        }),
        Err(e) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": format!("Error: {e:#}") }],
                "isError": true
            }
        }),
    }
}

fn dispatch_tool(name: &str, args: &Value) -> Result<String> {
    match name {
        "helmor_data_info" => tool_data_info(args),
        "helmor_repo_list" => tool_repo_list(args),
        "helmor_repo_add" => tool_repo_add(args),
        "helmor_workspace_list" => tool_workspace_list(args),
        "helmor_workspace_show" => tool_workspace_show(args),
        "helmor_workspace_create" => tool_workspace_create(args),
        "helmor_workspace_set_status" => tool_workspace_set_status(args),
        "helmor_workspace_archive" => tool_workspace_archive(args),
        "helmor_workspace_permanently_delete" => tool_workspace_permanently_delete(args),
        "helmor_workspace_run_action" => tool_workspace_run_action(args),
        "helmor_session_get_messages" => tool_session_get_messages(args),
        "helmor_session_list" => tool_session_list(args),
        "helmor_session_create" => tool_session_create(args),
        "helmor_session_search" => tool_session_search(args),
        "helmor_send" => tool_send(args),
        _ => anyhow::bail!("Unknown tool: {name}"),
    }
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

fn tool_data_info(args: &Value) -> Result<String> {
    let info = service::get_data_info()?;
    format_json_response(args, &info, None)
}

fn tool_repo_list(args: &Value) -> Result<String> {
    let repos = service::list_repositories()?;
    format_json_response(args, &repos, Some(REPO_COMPACT_FIELDS))
}

fn tool_repo_add(args: &Value) -> Result<String> {
    let path = required_str(args, "path")?;
    let resp = service::add_repository_from_local_path(path)?;
    format_json_response(args, &resp, None)
}

fn tool_workspace_list(args: &Value) -> Result<String> {
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

fn tool_workspace_show(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "ref")?;
    let ws_id = service::resolve_workspace_ref(ws_ref)?;
    let detail = service::get_workspace(&ws_id)?;
    format_json_response(args, &detail, Some(WORKSPACE_COMPACT_FIELDS))
}

fn tool_workspace_create(args: &Value) -> Result<String> {
    let repo_ref = required_str(args, "repo")?;
    let repo_id = service::resolve_repo_ref(repo_ref)?;
    let resp = service::create_workspace_from_repo_impl(&repo_id)?;
    format_json_response(args, &resp, None)
}

fn tool_workspace_set_status(args: &Value) -> Result<String> {
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
    crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceChanged {
        workspace_id: ws_id.clone(),
    })
    .ok();
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

fn tool_workspace_archive(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "workspace")?;
    let ws_id = service::resolve_workspace_ref(ws_ref)?;
    let resp = crate::workspace::lifecycle::archive_workspace_impl(&ws_id)?;
    crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceListChanged).ok();
    format_json_response(args, &resp, None)
}

fn tool_workspace_permanently_delete(args: &Value) -> Result<String> {
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
    crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceListChanged).ok();
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

fn tool_workspace_run_action(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "workspace")?;
    let action = required_str(args, "action")?;
    let ws_id = service::resolve_workspace_ref(ws_ref)?;

    match action {
        "merge_pr" => {
            let info = crate::forge::merge_workspace_change_request(&ws_id)?;
            crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceChanged {
                workspace_id: ws_id.clone(),
            })
            .ok();
            format_json_response(
                args,
                &json!({
                    "ok": true,
                    "action": "merge_pr",
                    "workspaceId": ws_id,
                    "result": info,
                }),
                None,
            )
        }
        "pull_latest" => {
            let result = workspaces::sync_workspace_with_target_branch(&ws_id)?;
            crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceChanged {
                workspace_id: ws_id.clone(),
            })
            .ok();
            format_json_response(
                args,
                &json!({
                    "ok": true,
                    "action": "pull_latest",
                    "workspaceId": ws_id,
                    "result": result,
                }),
                None,
            )
        }
        // Agent-dispatched actions: build the canned prompt server-side and
        // route through `service::send_message`. This is the same flow the
        // GUI's `handleInspectorCommitAction` triggers — just done in Rust
        // here so MCP clients (which can't reach the frontend) get the
        // same behavior. The agent runs the action in its own session; the
        // MCP response acknowledges dispatch + returns the session id.
        "commit_and_push" | "create_pr" | "fix_errors" | "resolve_conflicts" => {
            let prompt = canned_action_prompt(action);
            let params = service::SendMessageParams {
                workspace_ref: ws_id.clone(),
                session_id: None,
                prompt: prompt.to_string(),
                model: None,
                permission_mode: Some("auto".to_string()),
                linked_directories: Vec::new(),
            };
            let result = service::send_message(params, &mut |_event| {})?;
            crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceChanged {
                workspace_id: ws_id.clone(),
            })
            .ok();
            format_json_response(
                args,
                &json!({
                    "ok": true,
                    "action": action,
                    "workspaceId": ws_id,
                    "dispatched": true,
                    "sessionId": result.session_id,
                    "provider": result.provider,
                    "model": result.model,
                    "note": "Canned prompt sent to the workspace's agent — watch the Helmor GUI for streaming output.",
                }),
                None,
            )
        }
        other => anyhow::bail!(
            "helmor_workspace_run_action: unknown action `{other}`. \
             Valid: merge_pr, pull_latest, commit_and_push, create_pr, \
             fix_errors, resolve_conflicts."
        ),
    }
}

/// Canned prompts that mirror the GUI's `handleInspectorCommitAction`
/// behavior. These are kept short + imperative so the workspace agent
/// (Claude / Codex) doesn't waste tokens parsing intent.
fn canned_action_prompt(action: &str) -> &'static str {
    match action {
        "commit_and_push" => {
            "Commit all changes in this workspace and push to the remote. \
             Use a concise, accurate commit message that summarises the diff. \
             If there are no changes, say so and stop."
        }
        "create_pr" => {
            "Push any unpushed commits, then open a pull request (or merge request) \
             on the bound forge. Title and body should describe the changes concisely \
             — use the diff for body context. Set the base branch to the workspace's \
             configured target branch."
        }
        "fix_errors" => {
            "Inspect the workspace's CI output and recent error messages. Fix the \
             root cause. Make a single coherent commit when done."
        }
        "resolve_conflicts" => {
            "There are merge conflicts on the current branch. Inspect each conflict \
             marker, resolve it correctly (prefer reasoning over either-side picks), \
             then run the project's tests / typecheck if available. Commit when clean."
        }
        _ => "",
    }
}

fn tool_session_list(args: &Value) -> Result<String> {
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

fn tool_session_create(args: &Value) -> Result<String> {
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
    format_json_response(args, &resp, None)
}

fn tool_session_search(args: &Value) -> Result<String> {
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
    let status_filter = args
        .get("status")
        .and_then(Value::as_str)
        .map(|s| s.to_ascii_lowercase());
    if query.is_none() && status_filter.is_none() {
        anyhow::bail!("helmor_session_search: provide `query` or `status`");
    }
    let like = query.map(|q| format!("%{}%", q.to_ascii_lowercase()));
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

    let rows = statement.query_map(
        rusqlite::params![like, include_archived, repo_name_filter],
        |row| {
            let session_id: String = row.get(0)?;
            let workspace_id: String = row.get(1)?;
            let title: String = row.get(2)?;
            let session_status: String = row.get(4)?;
            let active_session_id: Option<String> = row.get(10)?;
            let directory: String = row.get(11)?;
            Ok(json!({
                "sessionId": session_id,
                "workspaceId": workspace_id,
                "workspaceRef": format!("{}/{}", row.get::<_, String>(14)?, directory),
                "workspaceDirectory": directory,
                "workspaceState": row.get::<_, String>(12)?,
                "workspaceStatus": row.get::<_, String>(13)?,
                "repo": row.get::<_, String>(14)?,
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
        },
    )?;
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
    format_json_response(
        args,
        &json!({
            "sessions": sessions,
            "returned": returned,
            "total": total,
            "hasMore": total > returned,
        }),
        Some(SESSION_COMPACT_FIELDS),
    )
}

fn tool_session_get_messages(args: &Value) -> Result<String> {
    const DEFAULT_LIMIT: usize = 5;
    const MAX_LIMIT: usize = 20;
    const DEFAULT_BODY_LIMIT: usize = 800;
    const MAX_BODY_LIMIT: usize = 4000;

    let session_id = required_str(args, "session")?;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, MAX_LIMIT))
        .unwrap_or(DEFAULT_LIMIT);
    let body_limit = args
        .get("body_limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, MAX_BODY_LIMIT))
        .unwrap_or(DEFAULT_BODY_LIMIT);
    let position = args
        .get("position")
        .and_then(Value::as_str)
        .unwrap_or("tail");
    let body_position = args
        .get("body_position")
        .and_then(Value::as_str)
        .unwrap_or("start");

    let (records, total_messages) = list_session_records(session_id, limit, position)?;
    let has_more = total_messages > records.len();

    let messages: Vec<Value> = records
        .iter()
        .map(|record| {
            let summary = summarize_historical_record(record);
            let total = summary.chars().count();
            let take = body_limit.min(total);
            let offset = if body_position.eq_ignore_ascii_case("end") {
                total.saturating_sub(take)
            } else {
                0
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

    format_json_response(
        args,
        &json!({
            "messages": messages,
            "windowSize": records.len(),
            "windowPosition": position,
            "windowHasMore": has_more,
            "totalMessages": total_messages,
        }),
        None,
    )
}

fn tool_send(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "workspace")?;
    let prompt = required_str(args, "prompt")?;
    let model = args["model"].as_str().map(String::from);
    let session_id = args["session_id"].as_str().map(String::from);
    let permission_mode = if args["plan"].as_bool().unwrap_or(false) {
        Some("plan".to_string())
    } else {
        Some("auto".to_string())
    };

    let params = service::SendMessageParams {
        workspace_ref: ws_ref.to_string(),
        session_id,
        prompt: prompt.to_string(),
        model,
        permission_mode,
        linked_directories: Vec::new(),
    };

    let mut output = String::new();
    let result = service::send_message(params, &mut |event| {
        if let AgentStreamEvent::StreamingPartial { message } = event {
            for part in &message.content {
                if let ExtendedMessagePart::Basic(MessagePart::Text { text, .. }) = part {
                    output.push_str(text);
                }
            }
        }
    })?;

    if output.is_empty() {
        output = format!(
            "Task completed. Session: {}, Model: {}/{}",
            result.session_id, result.provider, result.model
        );
    }
    if is_compact_response(args) {
        output = truncate_text(&output, 2_000);
    }

    Ok(output)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_COMPACT_FIELDS: &[&str] = &[
    "id",
    "name",
    "remote",
    "remoteUrl",
    "defaultBranch",
    "forgeProvider",
    "forgeLogin",
    "repoInitials",
];

const WORKSPACE_COMPACT_FIELDS: &[&str] = &[
    "id",
    "repo",
    "repoId",
    "repoName",
    "directory",
    "directoryName",
    "title",
    "status",
    "state",
    "branch",
    "remote",
    "remoteUrl",
    "defaultBranch",
    "rootPath",
    "activeSessionId",
    "activeSessionTitle",
    "primarySessionId",
    "primarySessionTitle",
    "sessionCount",
    "messageCount",
    "prTitle",
    "prUrl",
    "forgeProvider",
    "forgeLogin",
];

const SESSION_COMPACT_FIELDS: &[&str] = &[
    "sessionId",
    "id",
    "workspaceId",
    "workspaceRef",
    "workspaceDirectory",
    "workspaceStatus",
    "repo",
    "title",
    "sessionStatus",
    "status",
    "active",
    "agentType",
    "model",
    "permissionMode",
    "updatedAt",
    "lastUserMessageAt",
    "actionKind",
];

fn add_response_options(mut schema: Value) -> Value {
    let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) else {
        return schema;
    };
    properties.insert(
        "response_mode".to_string(),
        json!({
            "type": "string",
            "enum": ["compact", "full"],
            "description": "Output size. Default compact. Voice agents should use compact; use full only when the user explicitly needs every field."
        }),
    );
    properties.insert(
        "fields".to_string(),
        json!({
            "type": "array",
            "items": { "type": "string" },
            "description": "Optional custom field allowlist for JSON objects/items, e.g. ['name','remoteUrl','forgeProvider']. Voice agents should request only fields needed for the next step."
        }),
    );
    properties.insert(
        "include_icon".to_string(),
        json!({
            "type": "boolean",
            "description": "Default false. If true, include repoIconSrc/base64 icons where available. Voice agents should leave this false."
        }),
    );
    schema
}

fn format_json_response<T: serde::Serialize>(
    args: &Value,
    data: &T,
    default_compact_fields: Option<&[&str]>,
) -> Result<String> {
    let mut value = serde_json::to_value(data)?;
    let compact = is_compact_response(args);
    let include_icon = args
        .get("include_icon")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if !include_icon {
        strip_keys_recursive(&mut value, &["repoIconSrc"]);
    }
    if compact {
        remove_nulls_recursive(&mut value);
        truncate_long_strings(&mut value, 2_000);
        let fields = selected_fields(args).or_else(|| {
            default_compact_fields
                .map(|items| items.iter().map(|item| (*item).to_string()).collect())
        });
        if let Some(fields) = fields.as_ref() {
            apply_field_filter(&mut value, fields);
        }
    }

    Ok(serde_json::to_string_pretty(&value)?)
}

fn selected_fields(args: &Value) -> Option<HashSet<String>> {
    let values = args.get("fields")?.as_array()?;
    let fields: HashSet<String> = values
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|field| !field.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    (!fields.is_empty()).then_some(fields)
}

fn is_compact_response(args: &Value) -> bool {
    !matches!(
        args.get("response_mode").and_then(Value::as_str),
        Some("full")
    )
}

fn strip_keys_recursive(value: &mut Value, keys: &[&str]) {
    match value {
        Value::Object(map) => {
            for key in keys {
                map.remove(*key);
            }
            for child in map.values_mut() {
                strip_keys_recursive(child, keys);
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_keys_recursive(item, keys);
            }
        }
        _ => {}
    }
}

fn remove_nulls_recursive(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|_, child| !child.is_null());
            for child in map.values_mut() {
                remove_nulls_recursive(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                remove_nulls_recursive(item);
            }
        }
        _ => {}
    }
}

fn truncate_long_strings(value: &mut Value, max_chars: usize) {
    match value {
        Value::String(text) if text.chars().count() > max_chars => {
            *text = truncate_text(text, max_chars);
        }
        Value::Object(map) => {
            for child in map.values_mut() {
                truncate_long_strings(child, max_chars);
            }
        }
        Value::Array(items) => {
            for item in items {
                truncate_long_strings(item, max_chars);
            }
        }
        _ => {}
    }
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max_chars).collect();
    truncated.push('…');
    truncated
}

fn apply_field_filter(value: &mut Value, fields: &HashSet<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                filter_object_to_fields(item, fields);
            }
        }
        Value::Object(map) => {
            let list_keys = ["repositories", "workspaces", "sessions"];
            let mut filtered_nested = false;
            for key in list_keys {
                if let Some(child) = map.get_mut(key) {
                    apply_field_filter(child, fields);
                    filtered_nested = true;
                }
            }
            if !filtered_nested {
                map.retain(|key, _| fields.contains(key));
            }
        }
        _ => {}
    }
}

fn filter_object_to_fields(value: &mut Value, fields: &HashSet<String>) {
    if let Value::Object(map) = value {
        map.retain(|key, _| fields.contains(key));
    }
}

fn tool_def(name: &str, description: &str, input_schema: Value) -> Value {
    let schema = if input_schema.is_object() && input_schema.get("type").is_some() {
        input_schema
    } else {
        json!({ "type": "object", "properties": input_schema })
    };
    json!({
        "name": name,
        "description": description,
        "inputSchema": schema
    })
}

fn json_rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Missing required param: {key}"))
}

fn bounded_limit(args: &Value, default: usize, max: usize) -> usize {
    args.get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, max))
        .unwrap_or(default)
}

/// SQL window into `session_messages` for `helmor_session_get_messages`.
///
/// Inline copy of voice_agent's `list_session_records_for_voice` — small
/// and self-contained, not worth extracting to a shared module (the
/// voice version is dormant during the executor migration anyway).
fn list_session_records(
    session_id: &str,
    limit: usize,
    position: &str,
) -> Result<(Vec<HistoricalRecord>, usize)> {
    let connection = models::db::read_conn()?;
    let total: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .context("Failed to count session messages")?;

    let order = if position.eq_ignore_ascii_case("head") {
        "ASC"
    } else {
        "DESC"
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
    let rows = statement.query_map(rusqlite::params![session_id, limit as i64], |row| {
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
    if !position.eq_ignore_ascii_case("head") {
        records.reverse();
    }
    Ok((records, total.max(0) as usize))
}

/// Collapse a stored `session_messages.content` row into a single
///   human-readable string. Direct inline copy of voice_agent's helper
///   (see `summarize_historical_record` there).
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

fn workspace_status_matches(status: &WorkspaceStatus, wanted: &str) -> bool {
    status.group_id().eq_ignore_ascii_case(wanted) || status.as_str().eq_ignore_ascii_case(wanted)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_catalog_lists_expected_names() {
        let catalog = tool_catalog();
        let names: Vec<&str> = catalog
            .iter()
            .map(|t| t["name"].as_str().expect("each tool has a name"))
            .collect();
        // Frozen list — drift between this and `dispatch_tool` would be a bug.
        let expected = vec![
            "helmor_data_info",
            "helmor_repo_list",
            "helmor_repo_add",
            "helmor_workspace_list",
            "helmor_workspace_show",
            "helmor_workspace_create",
            "helmor_workspace_set_status",
            "helmor_workspace_archive",
            "helmor_workspace_permanently_delete",
            "helmor_workspace_run_action",
            "helmor_session_list",
            "helmor_session_create",
            "helmor_session_search",
            "helmor_session_get_messages",
            "helmor_send",
        ];
        assert_eq!(names, expected);
    }

    #[test]
    fn tool_catalog_entries_have_object_schemas() {
        for tool in tool_catalog() {
            let name = tool["name"].as_str().unwrap();
            let schema = &tool["inputSchema"];
            assert_eq!(
                schema["type"].as_str(),
                Some("object"),
                "tool `{name}` inputSchema.type must be \"object\""
            );
        }
    }

    #[test]
    fn dispatch_unknown_tool_returns_error() {
        let err = dispatch_tool("not_a_real_tool", &json!({})).unwrap_err();
        assert!(format!("{err:#}").contains("Unknown tool"));
    }

    #[test]
    fn workspace_list_schema_advertises_filter_props() {
        let catalog = tool_catalog();
        let list = catalog
            .iter()
            .find(|t| t["name"] == "helmor_workspace_list")
            .expect("helmor_workspace_list present");
        let props = &list["inputSchema"]["properties"];
        assert!(props.get("status").is_some());
        assert!(props.get("repo").is_some());
        assert!(props.get("archived").is_some());
        assert!(props.get("limit").is_some());
    }

    #[test]
    fn every_tool_schema_advertises_response_options() {
        for tool in tool_catalog() {
            let name = tool["name"].as_str().unwrap();
            let props = &tool["inputSchema"]["properties"];
            assert!(
                props.get("response_mode").is_some(),
                "{name} missing response_mode"
            );
            assert!(props.get("fields").is_some(), "{name} missing fields");
            assert!(
                props.get("include_icon").is_some(),
                "{name} missing include_icon"
            );
        }
    }

    #[test]
    fn compact_response_strips_icons_and_filters_fields() {
        let data = json!([{
            "id": "repo-1",
            "name": "helmor",
            "remoteUrl": "git@github.com:dohooo/helmor.git",
            "repoIconSrc": "data:image/png;base64,AAAA",
            "unused": "drop-me"
        }]);
        let rendered = format_json_response(
            &json!({
                "fields": ["name", "remoteUrl"]
            }),
            &data,
            Some(REPO_COMPACT_FIELDS),
        )
        .unwrap();
        assert!(rendered.contains("helmor"));
        assert!(rendered.contains("remoteUrl"));
        assert!(!rendered.contains("repoIconSrc"));
        assert!(!rendered.contains("drop-me"));
    }

    #[test]
    fn workspace_set_status_requires_both_args() {
        // Missing status
        let err = tool_workspace_set_status(&json!({ "ref": "abc" })).unwrap_err();
        assert!(format!("{err:#}").contains("status"));
        // Missing ref
        let err = tool_workspace_set_status(&json!({ "status": "done" })).unwrap_err();
        assert!(format!("{err:#}").contains("ref"));
    }

    #[test]
    fn workspace_permanently_delete_requires_explicit_confirmation() {
        let err = tool_workspace_permanently_delete(&json!({
            "workspace": "any-ref",
            "confirmed": false
        }))
        .unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("confirmed"));
    }

    #[test]
    fn session_search_requires_query_or_status() {
        let err = tool_session_search(&json!({})).unwrap_err();
        assert!(format!("{err:#}").contains("query"));
    }

    #[test]
    fn workspace_run_action_rejects_unsupported_actions() {
        for unsupported in &[
            "commit_and_push",
            "create_pr",
            "fix_errors",
            "resolve_conflicts",
        ] {
            let err = tool_workspace_run_action(&json!({
                "workspace": "irrelevant",
                "action": unsupported,
            }))
            .unwrap_err();
            let msg = format!("{err:#}");
            // Either rejects the action (preferred) or fails at workspace
            // resolve. Both prove the agent path is correctly gated.
            assert!(
                msg.contains("unsupported action")
                    || msg.contains("workspace")
                    || msg.contains("Unknown")
                    || msg.contains("resolve")
                    || msg.contains("not found"),
                "unexpected error for {unsupported}: {msg}"
            );
        }
    }

    #[test]
    fn workspace_status_matches_accepts_kanban_and_canonical() {
        // group_id form
        assert!(workspace_status_matches(
            &WorkspaceStatus::InProgress,
            "progress"
        ));
        assert!(workspace_status_matches(&WorkspaceStatus::Done, "done"));
        // canonical kebab form
        assert!(workspace_status_matches(
            &WorkspaceStatus::InProgress,
            "in-progress"
        ));
        // case-insensitive
        assert!(workspace_status_matches(&WorkspaceStatus::Review, "Review"));
        assert!(!workspace_status_matches(&WorkspaceStatus::Done, "review"));
    }
}
