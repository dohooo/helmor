//! In-process tool execution for the voice agent.
//!
//! The voice agent runs inside the dev/release app process; there is no
//! reason for its function-call tools to spawn a `helmor` CLI
//! subprocess and re-init a separate `r2d2` write pool just to call
//! the same internal Rust functions the GUI already uses. This module
//! exposes a single Tauri command, [`run_voice_tool`], that the
//! frontend dispatcher invokes with `(tool_name, args)`; we dispatch
//! to the matching internal `service::*` / `workspace::*` / `models::*`
//! function and return a typed envelope.
//!
//! ## Adding a new tool
//!
//! 1. Add a variant to [`ToolKind`].
//! 2. Extend [`ToolKind::metadata`] with the new tool's name, JSON
//!    Schema parameters, optional clap subcommand path for `--help`
//!    description, cache-invalidation hints, and voice-context
//!    preamble.
//! 3. Extend [`ToolKind::run`] with a handler arm that calls the
//!    internal function and returns a [`VoiceToolResult`].
//!
//! All three matches are exhaustive — the compiler will refuse to
//! build if you forget step 2 or 3 after adding step 1.

use anyhow::{Context, Result};
use clap::CommandFactory;
use serde::Serialize;
use serde_json::{json, Value};

use crate::cli::Cli;
use crate::models;
use crate::service;
use crate::workspace::status::WorkspaceStatus;
use crate::workspace::workspaces;

use super::common::{run_blocking, CmdResult};

/// Coarse-grained kinds of state the voice agent can mutate. Mirrored
/// on the frontend (`tool-dispatcher.ts::AgentMutationKind`). camelCase
/// serialization keeps the wire form aligned with the rest of the
/// Helmor IPC surface.
///
/// `Repos` is intentionally absent until we ship a tool that mutates
/// the repository list (none of the current eight do). Re-add the
/// variant the same day you add an `add_repo` tool — the
/// `tool_name_set_matches_frontend_contract` test will remind you
/// after the diff lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MutationKind {
    Workspaces,
    Sessions,
}

/// One enum variant per voice tool. Exhaustive matches in [`metadata`]
/// and [`run`] enforce that every variant has both a declaration (for
/// the OpenAI session payload + frontend dispatch) and a handler (for
/// in-process execution).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    ListWorkspaces,
    ShowWorkspace,
    CreateWorkspace,
    SetWorkspaceStatus,
    ListSessions,
    SendPrompt,
    ListRepos,
    SelectWorkspace,
    WaitForUser,
}

/// Tool declaration metadata. The JSON Schema in `parameters` is the
/// contract with the model; `cli_path` lets us fetch the matching
/// clap `--help` to feed back into the description so the spoken-side
/// docs and `helmor <cmd> --help` never drift.
pub struct ToolMetadata {
    pub name: &'static str,
    pub parameters: Value,
    pub cli_path: Option<&'static [&'static str]>,
    pub invalidates: &'static [MutationKind],
    /// Voice-context preamble prepended to the clap help body.
    pub use_when: &'static str,
}

/// Result of one handler invocation, before envelope wrapping.
struct VoiceToolResult {
    /// JSON returned to the model as the `function_call_output` body.
    data: Value,
    /// When set, the frontend dispatcher fires `handleSelectWorkspace`
    /// with this UUID so the UI follows the agent's action.
    navigate_to_workspace_id: Option<String>,
}

/// Stable wire shape returned to the frontend dispatcher.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceToolEnvelope {
    pub ok: bool,
    pub data: Value,
    pub error: Option<String>,
    pub invalidates: Vec<MutationKind>,
    pub navigate_to_workspace_id: Option<String>,
}

impl ToolKind {
    /// Every variant, in OpenAI-payload presentation order. Kept as a
    /// `const` so iteration in `build_tools_array` and the unit tests
    /// is allocation-free.
    pub const ALL: &'static [ToolKind] = &[
        Self::ListWorkspaces,
        Self::ShowWorkspace,
        Self::CreateWorkspace,
        Self::SetWorkspaceStatus,
        Self::ListSessions,
        Self::SendPrompt,
        Self::ListRepos,
        Self::SelectWorkspace,
        Self::WaitForUser,
    ];

    /// Match a tool name (from the model's function-call event) to a
    /// kind. Returns `None` if the model hallucinates a tool name we
    /// don't expose.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|kind| kind.metadata().name == name)
    }

    pub fn metadata(self) -> ToolMetadata {
        match self {
            Self::ListWorkspaces => ToolMetadata {
                name: "list_workspaces",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "status": {
                            "type": "string",
                            "enum": ["done", "review", "progress", "backlog", "canceled"],
                            "description": "Optional filter by workspace status."
                        },
                        "repo": {
                            "type": "string",
                            "description": "Optional filter by repo name or UUID."
                        },
                        "archived": {
                            "type": "boolean",
                            "description": "Include archived workspaces. Default false."
                        }
                    },
                    "required": []
                }),
                cli_path: Some(&["workspace", "list"]),
                invalidates: &[],
                use_when: "USE WHEN: user asks 'show/list/what workspaces do I have'. \
                           Preamble samples (only if a noticeable delay seems likely): \
                           'let me check.' / 'one sec.' / 'hmm, looking now.'",
            },
            Self::ShowWorkspace => ToolMetadata {
                name: "show_workspace",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "ref": {
                            "type": "string",
                            "description": "Workspace UUID or `repo-name/dir-name` shorthand."
                        }
                    },
                    "required": ["ref"]
                }),
                cli_path: Some(&["workspace", "show"]),
                invalidates: &[],
                use_when: "USE WHEN: user asks 'what's the status of X', 'show me X', \
                           'how's X doing'. Preamble samples (only if it might be slow): \
                           'let me look.' / 'one sec.' / 'checking.'",
            },
            Self::CreateWorkspace => ToolMetadata {
                name: "create_workspace",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "repo": {
                            "type": "string",
                            "description": "Repo name or UUID. Must already be registered; \
                                            check list_repos first if unsure."
                        }
                    },
                    "required": ["repo"]
                }),
                cli_path: Some(&["workspace", "new"]),
                invalidates: &[MutationKind::Workspaces],
                use_when: "USE WHEN: user says 'create/new/start a workspace for repo X'. \
                           Call immediately — no confirmation needed (creation is reversible \
                           via delete). If the repo name is unclear, run list_repos first to \
                           find the right one. After success, the UI auto-navigates to the \
                           new workspace — report the repo name, not the new ID. \
                           Preamble samples (creation can take a moment): 'ok, on it.' / \
                           'sure, doing that now.' / 'one sec.'",
            },
            Self::SetWorkspaceStatus => ToolMetadata {
                name: "set_workspace_status",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "ref": {
                            "type": "string",
                            "description": "Workspace UUID or `repo/dir`."
                        },
                        "status": {
                            "type": "string",
                            "enum": ["done", "review", "progress", "backlog", "canceled"]
                        }
                    },
                    "required": ["ref", "status"]
                }),
                cli_path: Some(&["workspace", "set-status", "set"]),
                invalidates: &[MutationKind::Workspaces],
                use_when: "Mark a workspace done / review / progress / backlog / canceled. \
                           USE WHEN: user says 'mark X done', 'move X to review', etc. \
                           **CONFIRM ONLY when status='canceled' (destructive — cannot be \
                           undone without recreating).** For all other status changes, call \
                           immediately without confirmation. Status changes return fast — \
                           usually no preamble needed; just call and report briefly \
                           ('done.' / 'moved to review.').",
            },
            Self::ListSessions => ToolMetadata {
                name: "list_sessions",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "workspace": {
                            "type": "string",
                            "description": "Workspace UUID or `repo/dir`."
                        }
                    },
                    "required": ["workspace"]
                }),
                cli_path: Some(&["session", "list"]),
                invalidates: &[],
                use_when: "USE WHEN: user asks 'show sessions in X', 'what have we worked on \
                           in X'. Preamble samples (only if slow): 'let me check.' / 'one sec.'",
            },
            Self::SendPrompt => ToolMetadata {
                name: "send_prompt",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "workspace": {
                            "type": "string",
                            "description": "Workspace UUID or `repo/dir`."
                        },
                        "session": {
                            "type": "string",
                            "description": "Optional existing session UUID to append to. \
                                            Omit to start a fresh session."
                        },
                        "prompt": {
                            "type": "string",
                            "description": "The instruction to send to the agent."
                        },
                        "plan_mode": {
                            "type": "boolean",
                            "description": "Run agent in plan mode (no edits). Default false."
                        }
                    },
                    "required": ["workspace", "prompt"]
                }),
                cli_path: Some(&["send"]),
                invalidates: &[MutationKind::Sessions, MutationKind::Workspaces],
                use_when: "Send a prompt to the AI agent inside a workspace's session. \
                           USE WHEN: user says 'tell agent in X to do Y' or 'have agent fix \
                           the bug'. Call immediately — no confirmation needed. After success, \
                           the UI auto-navigates to that workspace; report 'sent' without \
                           reading the session ID. Preamble samples: 'sending.' / 'on it.' / \
                           'ok, sending now.'",
            },
            Self::ListRepos => ToolMetadata {
                name: "list_repos",
                parameters: json!({ "type": "object", "properties": {}, "required": [] }),
                cli_path: Some(&["repo", "list"]),
                invalidates: &[],
                use_when: "USE WHEN: user asks 'what repos do I have', or before \
                           create_workspace to find the right repo. \
                           Preamble samples (only if slow): 'let me check.' / 'one sec.'",
            },
            Self::SelectWorkspace => ToolMetadata {
                name: "select_workspace",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "ref": {
                            "type": "string",
                            "description": "Workspace UUID or `repo-name/dir-name` shorthand."
                        }
                    },
                    "required": ["ref"]
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "Switch the Helmor UI to a specific workspace so the user can see \
                           its session. USE WHEN: user says 'open <repo>/<dir>', 'switch to \
                           <repo>/<dir>', 'show me <repo>/<dir>'. Do NOT use to fetch workspace \
                           details — that's show_workspace. UI-only side effect (does not \
                           modify any data). `create_workspace` and `send_prompt` already \
                           auto-navigate after success — only call this tool when the user \
                           explicitly wants to view a *different* workspace from the one \
                           currently selected. Return is a tiny envelope; do not read the \
                           workspace id aloud. Preamble samples (only if slow): 'one sec.' / 'ok.'",
            },
            Self::WaitForUser => ToolMetadata {
                name: "wait_for_user",
                parameters: json!({ "type": "object", "properties": {}, "required": [] }),
                cli_path: None,
                invalidates: &[],
                use_when: "Call when the latest audio is silence, background noise, hold \
                           music, or a side conversation that doesn't need a response. \
                           Produces no audio output. Not a CLI command — this is a synthetic \
                           'stay silent' signal handled inside the voice tool dispatcher.",
            },
        }
    }

    fn run(self, args: Value) -> Result<VoiceToolResult> {
        match self {
            Self::ListWorkspaces => list_workspaces(args),
            Self::ShowWorkspace => show_workspace(args),
            Self::CreateWorkspace => create_workspace(args),
            Self::SetWorkspaceStatus => set_workspace_status(args),
            Self::ListSessions => list_sessions(args),
            Self::SendPrompt => send_prompt(args),
            Self::ListRepos => list_repos(args),
            Self::SelectWorkspace => select_workspace(args),
            // The dispatcher short-circuits wait_for_user before
            // hitting IPC; if we ever do get here, treat it as a
            // successful no-op so the model's output channel stays
            // clean.
            Self::WaitForUser => Ok(VoiceToolResult {
                data: json!({ "ok": true }),
                navigate_to_workspace_id: None,
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Handlers — one per tool. Each reads typed args out of the JSON value
// and calls the same internal function the matching CLI subcommand
// uses. Keep them small: argument parsing + a single internal call +
// shaping the JSON return. Anything more belongs in the underlying
// service / model function so both the CLI and the voice agent get
// the fix.
// ---------------------------------------------------------------------------

fn list_workspaces(args: Value) -> Result<VoiceToolResult> {
    let archived = args
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if archived {
        let rows = workspaces::list_archived_workspaces()?;
        return Ok(VoiceToolResult {
            data: serde_json::to_value(rows)?,
            navigate_to_workspace_id: None,
        });
    }

    let status = args.get("status").and_then(Value::as_str);
    let repo = args.get("repo").and_then(Value::as_str);

    // Resolve repo ref to a name we can filter on. We need a name (not
    // UUID) here because `WorkspaceSidebarRow.repo_name` is the field
    // available downstream — same logic as `cli/workspace.rs::list`.
    let repo_name_filter = match repo {
        Some(reference) => {
            let repo_id = service::resolve_repo_ref(reference)?;
            models::repos::list_repositories()?
                .into_iter()
                .find(|r| r.id == repo_id)
                .map(|r| r.name.to_lowercase())
        }
        None => None,
    };

    let groups = workspaces::list_workspace_groups()?;
    // Flatten to a single array — the model handles a flat list of
    // workspaces more naturally than the kanban-grouped sidebar shape.
    let mut rows: Vec<Value> = Vec::new();
    for group in &groups {
        if let Some(wanted) = status {
            if !group.id.eq_ignore_ascii_case(wanted) {
                continue;
            }
        }
        for r in &group.rows {
            if let Some(name) = &repo_name_filter {
                if r.repo_name.to_lowercase() != *name {
                    continue;
                }
            }
            rows.push(json!({
                "id": r.id,
                "repo": r.repo_name,
                "directory": r.directory_name,
                "title": r.title,
                "status": group.id,
                "branch": r.branch,
                "pinned": r.pinned_at.is_some(),
            }));
        }
    }
    Ok(VoiceToolResult {
        data: Value::Array(rows),
        navigate_to_workspace_id: None,
    })
}

fn show_workspace(args: Value) -> Result<VoiceToolResult> {
    let reference = args
        .get("ref")
        .and_then(Value::as_str)
        .context("show_workspace: missing required `ref` argument")?;
    let id = service::resolve_workspace_ref(reference)?;
    let detail = service::get_workspace(&id)?;
    Ok(VoiceToolResult {
        data: serde_json::to_value(detail)?,
        navigate_to_workspace_id: None,
    })
}

fn create_workspace(args: Value) -> Result<VoiceToolResult> {
    let reference = args
        .get("repo")
        .and_then(Value::as_str)
        .context("create_workspace: missing required `repo` argument")?;
    let repo_id = service::resolve_repo_ref(reference)?;
    let response = service::create_workspace_from_repo_impl(&repo_id)?;
    let navigate = response.selected_workspace_id.clone();
    crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceListChanged).ok();
    crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceChanged {
        workspace_id: response.created_workspace_id.clone(),
    })
    .ok();
    Ok(VoiceToolResult {
        data: serde_json::to_value(response)?,
        navigate_to_workspace_id: Some(navigate),
    })
}

fn set_workspace_status(args: Value) -> Result<VoiceToolResult> {
    let reference = args
        .get("ref")
        .and_then(Value::as_str)
        .context("set_workspace_status: missing required `ref` argument")?;
    let status_str = args
        .get("status")
        .and_then(Value::as_str)
        .context("set_workspace_status: missing required `status` argument")?;
    // The frontend args use the kanban-lane label ("progress"); the
    // internal enum is `InProgress`. Translate here so this handler
    // owns the wire-to-enum mapping in one place.
    let status = match status_str.to_ascii_lowercase().as_str() {
        "done" => WorkspaceStatus::Done,
        "review" => WorkspaceStatus::Review,
        "progress" | "in-progress" => WorkspaceStatus::InProgress,
        "backlog" => WorkspaceStatus::Backlog,
        "canceled" | "cancelled" => WorkspaceStatus::Canceled,
        other => anyhow::bail!("set_workspace_status: unknown status `{other}`"),
    };
    let id = service::resolve_workspace_ref(reference)?;
    workspaces::set_workspace_status(&id, status)?;
    crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceChanged {
        workspace_id: id.clone(),
    })
    .ok();
    Ok(VoiceToolResult {
        data: json!({ "ok": true, "id": id, "status": status_str }),
        navigate_to_workspace_id: None,
    })
}

fn list_sessions(args: Value) -> Result<VoiceToolResult> {
    let reference = args
        .get("workspace")
        .and_then(Value::as_str)
        .context("list_sessions: missing required `workspace` argument")?;
    let workspace_id = service::resolve_workspace_ref(reference)?;
    let sessions = models::sessions::list_workspace_sessions(&workspace_id)?;
    Ok(VoiceToolResult {
        data: serde_json::to_value(sessions)?,
        navigate_to_workspace_id: None,
    })
}

fn send_prompt(args: Value) -> Result<VoiceToolResult> {
    let workspace_ref = args
        .get("workspace")
        .and_then(Value::as_str)
        .context("send_prompt: missing required `workspace` argument")?
        .to_string();
    let prompt = args
        .get("prompt")
        .and_then(Value::as_str)
        .context("send_prompt: missing required `prompt` argument")?
        .to_string();
    let session_id = args
        .get("session")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let plan_mode = args
        .get("plan_mode")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let permission_mode = if plan_mode {
        Some("plan".to_string())
    } else {
        None
    };

    // We resolve the workspace ref ahead of the send so we can attach
    // the resolved UUID to the navigation hint. `service::send_message`
    // resolves the ref again internally — that's fine, it's cheap.
    let resolved_workspace_id = service::resolve_workspace_ref(&workspace_ref)?;

    let params = service::SendMessageParams {
        workspace_ref,
        session_id,
        prompt,
        model: None,
        permission_mode,
        linked_directories: Vec::new(),
    };
    // The voice agent doesn't consume the stream — delegation writes
    // the user message + pending CLI send row + notifies the running
    // app, then returns. No-op `on_event` keeps the API satisfied.
    let result = service::send_message(params, &mut |_event| {})?;
    Ok(VoiceToolResult {
        data: serde_json::to_value(result)?,
        navigate_to_workspace_id: Some(resolved_workspace_id),
    })
}

fn list_repos(_args: Value) -> Result<VoiceToolResult> {
    let repos = models::repos::list_repositories()?;
    Ok(VoiceToolResult {
        data: serde_json::to_value(repos)?,
        navigate_to_workspace_id: None,
    })
}

fn select_workspace(args: Value) -> Result<VoiceToolResult> {
    let reference = args
        .get("ref")
        .and_then(Value::as_str)
        .context("select_workspace: missing required `ref` argument")?;
    let id = service::resolve_workspace_ref(reference)?;
    Ok(VoiceToolResult {
        // Tiny envelope — the model shouldn't read details aloud.
        data: json!({ "ok": true, "navigated_to": id }),
        navigate_to_workspace_id: Some(id),
    })
}

// ---------------------------------------------------------------------------
// Description rendering — pulls each tool's clap `--help` body into
// the OpenAI tool description so the spoken-side documentation tracks
// `helmor <cmd> --help` automatically. Same shape `voice_tools.rs`
// used in the previous (subprocess) iteration; preserved here so the
// session payload doesn't change shape on the wire.
// ---------------------------------------------------------------------------

fn subcommand_help(path: &[&str]) -> String {
    let mut cmd = Cli::command();
    let mut walked: Vec<&str> = Vec::with_capacity(path.len());
    for segment in path {
        walked.push(segment);
        let next = cmd.find_subcommand(segment).cloned();
        cmd = match next {
            Some(sub) => sub,
            None => {
                return format!(
                    "[voice-tools: subcommand path `{}` not found while resolving `{}`]",
                    walked.join(" "),
                    path.join(" ")
                );
            }
        };
    }
    cmd.render_long_help().to_string()
}

fn format_description(meta: &ToolMetadata) -> String {
    match meta.cli_path {
        Some(path) => format!(
            "{use_when}\n\n--- helmor {cmd} --help ---\n{help}",
            use_when = meta.use_when,
            cmd = path.join(" "),
            help = subcommand_help(path).trim_end(),
        ),
        // Synthetic tools (no CLI equivalent) only carry the
        // voice-context preamble — there's no help body to fold in.
        None => meta.use_when.to_string(),
    }
}

/// Build the `tools` array for the OpenAI Realtime `session.update`
/// payload. Called from `settings_commands::create_openai_realtime_client_secret`.
pub fn build_tools_array() -> Vec<Value> {
    ToolKind::ALL
        .iter()
        .map(|kind| {
            let meta = kind.metadata();
            json!({
                "type": "function",
                "name": meta.name,
                "description": format_description(&meta),
                "parameters": meta.parameters,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn run_voice_tool(tool: String, args: Value) -> CmdResult<VoiceToolEnvelope> {
    // Log every invocation — voice tool calls are rare + high-signal,
    // so it's worth keeping the trail to correlate "the agent said X"
    // with "we ran this internal function with these args".
    tracing::info!(tool, ?args, "voice agent invoking in-process tool");

    let Some(kind) = ToolKind::from_name(&tool) else {
        tracing::warn!(tool, "voice agent: unknown tool name");
        return Ok(VoiceToolEnvelope {
            ok: false,
            data: Value::Null,
            error: Some(format!("unknown tool '{tool}'")),
            invalidates: Vec::new(),
            navigate_to_workspace_id: None,
        });
    };

    let invalidates = kind.metadata().invalidates.to_vec();
    // Wrap envelope construction inside the blocking closure so the
    // full `anyhow::Error` chain is available to format into
    // `envelope.error`. `run_blocking` returns `Result<T, CommandError>`
    // which intentionally hides the inner anyhow chain from generic
    // IPC sites — but the voice envelope carries `ok=false` itself, so
    // we promote handler errors to `Ok(envelope)` here. That also
    // means a failing tool never blows up the whole `response.done`
    // turn: the model receives the error in its `function_call_output`
    // and can phrase it for the user.
    run_blocking(move || {
        let name = kind.metadata().name;
        match kind.run(args) {
            Ok(result) => {
                tracing::info!(
                    tool = name,
                    navigate = ?result.navigate_to_workspace_id,
                    "voice agent in-process tool completed"
                );
                Ok(VoiceToolEnvelope {
                    ok: true,
                    data: result.data,
                    error: None,
                    invalidates,
                    navigate_to_workspace_id: result.navigate_to_workspace_id,
                })
            }
            Err(err) => {
                let message = format!("{err:#}");
                tracing::warn!(tool = name, %message, "voice agent in-process tool failed");
                Ok(VoiceToolEnvelope {
                    ok: false,
                    data: Value::Null,
                    error: Some(message),
                    invalidates: Vec::new(),
                    navigate_to_workspace_id: None,
                })
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every tool that claims a clap path must resolve to a real
    /// subcommand. A typo in `cli_path` would silently degrade the
    /// tool's description to a `[voice-tools: ... not found]` stub
    /// that the model would then read to the user — this test catches
    /// that at build time.
    #[test]
    fn every_tool_with_cli_path_resolves() {
        for kind in ToolKind::ALL {
            let meta = kind.metadata();
            let Some(path) = meta.cli_path else { continue };
            let rendered = format_description(&meta);
            assert!(
                !rendered.contains("[voice-tools:"),
                "tool `{}` references a missing clap path `{}`",
                meta.name,
                path.join(" "),
            );
        }
    }

    /// Round-trip every variant through its declared name to confirm
    /// `from_name` matches `metadata().name` for the full enum. Adding
    /// a variant but forgetting to wire it into `ALL` would slip past
    /// every other test.
    #[test]
    fn from_name_round_trips_every_variant() {
        for kind in ToolKind::ALL {
            let name = kind.metadata().name;
            assert_eq!(
                ToolKind::from_name(name),
                Some(*kind),
                "tool `{name}` failed to round-trip through from_name"
            );
        }
    }

    /// The frontend `tool-dispatcher.ts::ToolName` union must list
    /// exactly the same names this module exposes. We don't have a
    /// build-time cross-language assertion, but pinning the expected
    /// name set here flags renames before they hit the dispatcher.
    #[test]
    fn tool_name_set_matches_frontend_contract() {
        let mut names: Vec<&'static str> =
            ToolKind::ALL.iter().map(|k| k.metadata().name).collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "create_workspace",
                "list_repos",
                "list_sessions",
                "list_workspaces",
                "select_workspace",
                "send_prompt",
                "set_workspace_status",
                "show_workspace",
                "wait_for_user",
            ]
        );
    }
}
