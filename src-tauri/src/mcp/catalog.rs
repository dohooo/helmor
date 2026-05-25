use serde_json::{json, Value};

/// All tools we advertise. Kept as a top-level function so unit tests
/// can inspect the catalog without spinning up the stdio loop.
pub(super) fn tool_catalog() -> Vec<Value> {
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
            "Register a local Git repository. New repositories do not create a workspace automatically; duplicate registrations may select an existing workspace.",
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
                    "status": { "type": "string", "description": "Filter by stored workspace status. Accepts a status group id (progress/done/review/backlog/canceled) or the canonical status string (in-progress/done/...)." },
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
            "Move a workspace into a different status group. Use this when the user verbally moves a workspace to done/review/backlog/in-progress/canceled. Canceled and Done are destructive-feeling; callers should confirm with the user first.",
            add_response_options(json!({
                "type": "object",
                "properties": {
                    "ref": { "type": "string", "description": "Workspace UUID or repo-name/directory-name" },
                    "status": {
                        "type": "string",
                        "enum": ["in-progress", "done", "review", "backlog", "canceled"],
                        "description": "Target status. Accepts status group ids (progress = in-progress)."
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
            "Run a workspace ship action. \"Direct\" actions run inline (merge_pr merges the open change request; pull_latest rebases onto target). \"Agent-dispatched\" actions (commit_and_push / create_pr / fix_errors / resolve_conflicts) create a dedicated action session with the same prompt/settings the GUI uses, then return once the prompt is queued.",
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
                        "description": "merge_pr / pull_latest run inline. commit_and_push / create_pr / fix_errors / resolve_conflicts create a dedicated action session and queue the action prompt."
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
            "Fetch a window of messages from a session. Use after helmor_session_list / helmor_session_search to read what an agent said or what the user asked. Trailing window by default; pass `position: \"head\"` for the start. Each message body is char-bounded with `body_limit`; use `body_position: \"start\"` or `\"end\"` to choose which side of long messages is returned.",
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

fn add_response_options(mut schema: Value) -> Value {
    let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) else {
        return schema;
    };
    properties.insert(
        "response_mode".to_string(),
        json!({
            "type": "string",
            "enum": ["compact", "full"],
            "description": "Output size. Default compact. Use full only when the caller explicitly needs every field."
        }),
    );
    properties.insert(
        "fields".to_string(),
        json!({
            "type": "array",
            "items": { "type": "string" },
            "description": "Optional custom field allowlist for JSON objects/items, e.g. ['name','remoteUrl','forgeProvider']. Callers should request only fields needed for the next step."
        }),
    );
    properties.insert(
        "include_icon".to_string(),
        json!({
            "type": "boolean",
            "description": "Default false. If true, include repoIconSrc/base64 icons where available."
        }),
    );
    schema
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
