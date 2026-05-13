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
use crate::forge::{
    accounts::forge_target_from, forge_backend_for, ForgeProvider, InboxItemDetail, InboxKind,
    InboxSource,
};
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
    ListContextItems,
    GetContextItemDetail,
    SelectWorkspace,
    WaitForUser,
    EndSession,
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
        Self::ListContextItems,
        Self::GetContextItemDetail,
        Self::SelectWorkspace,
        Self::WaitForUser,
        Self::EndSession,
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
                           Reply shape: comma-separated counts, no opener. Match the user's \
                           spoken language for the entire reply. \
                           EN sample: 'three in progress, two done, one in review.' \
                           中文 sample: '三个进行中,两个完成,一个待评审。' \
                           Preamble (only if noticeably slow): EN 'one sec.' / 中 '稍等'. \
                           NEVER 'ok,' / '嗯,' as a default opener.",
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
                           'how's X doing'. Reply shape: one short sentence with the most \
                           relevant facts (state, branch, status). Match the user's spoken \
                           language for the entire reply. \
                           EN sample: 'kale slash voice, in review, on the voice-mode branch.' \
                           中文 sample: 'kale 的 voice 工作区,待评审,在 voice-mode 分支上。' \
                           No 'ok,' / '嗯,' opener. Preamble (only if noticeably slow): \
                           EN 'one sec.' / 中 '稍等'.",
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
                           new workspace. Reply shape: verb-first, name the repo, nothing else. \
                           Match the user's spoken language for the entire reply. \
                           EN samples: 'created in kale.' / 'created.' \
                           中文 samples: 'kale 工作区建好了。' / '建好了。' \
                           Do NOT add 'the agent is now working' / 'agent 已经开始处理了' or \
                           'let me know if...' / '有需要再叫我' — the UI shows that itself. \
                           Preamble (creation takes ~1s, so a short one is fine): \
                           EN 'one sec.' / 中 '稍等'. NEVER 'ok, on it.' / '好的,我来弄' \
                           (bureaucratic).",
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
                           undone without recreating).** All other status changes: call \
                           immediately. Reply shape: verb-first, the new status, nothing else. \
                           Match the user's spoken language for the entire reply. \
                           EN samples: 'done.' / 'moved to review.' / 'back to in progress.' \
                           中文 samples: '标记完成。' / '移到待评审。' / '改回进行中。' \
                           No preamble; this returns in milliseconds.",
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
                           in X'. Reply shape: count + most recent title. Match the user's \
                           spoken language for the entire reply. \
                           EN sample: 'three sessions, latest is fix-readme-typo.' \
                           中文 sample: '三个会话,最近的是 fix-readme-typo。' \
                           Preamble (only if noticeably slow): EN 'one sec.' / 中 '稍等'.",
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
                           the UI auto-navigates to that workspace. Reply shape: one word. \
                           Match the user's spoken language for the entire reply. \
                           EN sample: 'sent.' \
                           中文 sample: '发了。' \
                           Do NOT add 'the agent is now working on it' / 'agent 已经开始处理了', \
                           'I'll let you know when it's done' / '完成后告诉你', or session IDs \
                           — the UI shows the streaming response itself. \
                           Preamble (sending is fast, ~50ms): usually skip. If you must, \
                           EN 'sending.' / 中 '在发了'. NEVER 'ok, sending now.' / \
                           '好的,现在发' (bureaucratic).",
            },
            Self::ListRepos => ToolMetadata {
                name: "list_repos",
                parameters: json!({ "type": "object", "properties": {}, "required": [] }),
                cli_path: Some(&["repo", "list"]),
                invalidates: &[],
                use_when: "USE WHEN: user asks 'what repos do I have', or before \
                           create_workspace to find the right repo. \
                           Reply shape: comma-separated names, no opener. Match the user's \
                           spoken language for the entire reply (the repo names stay as-is \
                           since they're proper nouns). \
                           EN sample: 'helmor, dosu, ts-to-zod.' \
                           中文 sample: 'helmor、dosu、ts-to-zod。' \
                           Preamble (only if noticeably slow): EN 'one sec.' / 中 '稍等'.",
            },
            Self::ListContextItems => ToolMetadata {
                name: "list_context_items",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "repo": {
                            "type": "string",
                            "description": "Repo name or UUID. Required. Use list_repos if \
                                            the user names a repo that doesn't match exactly."
                        },
                        "kind": {
                            "type": "string",
                            "enum": ["issues", "prs", "discussions"],
                            "description": "Which context kind to fetch. `prs` covers PRs \
                                            (GitHub) and MRs (GitLab). `discussions` is \
                                            GitHub-only. Default `issues`."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Max items 1-100. Default 10 — keep small so the \
                                            spoken reply stays manageable."
                        }
                    },
                    "required": ["repo"]
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "USE WHEN: user asks 'show/list issues|PRs|MRs in <repo>', \
                           'what's open in helmor', 'any open MRs in <repo>', 'read me the \
                           top issues for <repo>'. Returns the same items the Contexts \
                           sidebar shows — GitHub issues/PRs/discussions or GitLab \
                           issues/MRs depending on the repo's bound forge. Reply shape: \
                           count + first item title, ask before reading more. Match the \
                           user's spoken language. \
                           EN sample: 'three open issues, top one is login redirect bug.' \
                           中文 sample: '三个 open issue,最上面是登录跳转那个。' \
                           Preamble (network fetch, ~300-800ms): EN 'one sec.' / 中 '稍等'. \
                           Repo / issue titles stay in their original form (proper nouns).",
            },
            Self::GetContextItemDetail => ToolMetadata {
                name: "get_context_item_detail",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "repo": {
                            "type": "string",
                            "description": "Repo name or UUID — same shape as list_context_items."
                        },
                        "source": {
                            "type": "string",
                            "enum": ["issue", "pr", "discussion"],
                            "description": "Item kind. `pr` covers PRs (GitHub) and MRs \
                                            (GitLab); `discussion` is GitHub-only."
                        },
                        "external_id": {
                            "type": "string",
                            "description": "Item identifier from list_context_items' \
                                            `externalId` field. NEVER ask the user to read \
                                            this — pull it from a prior \
                                            list_context_items result."
                        },
                        "body_offset": {
                            "type": "integer",
                            "description": "Char index in the body to start reading. \
                                            Default 0. Use this to read the next chunk \
                                            when bodyHasMore is true on a previous call."
                        },
                        "body_limit": {
                            "type": "integer",
                            "description": "How many body chars to return (1-10000). \
                                            Default 4000 — covers the full body for the \
                                            vast majority of issues / PRs."
                        }
                    },
                    "required": ["repo", "source", "external_id"]
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "USE WHEN: user asks 'read that issue / PR', 'what does it say', \
                           'tell me more about the login one', 'summarize it'. Pre-req: \
                           a prior list_context_items call gave you the `externalId` — \
                           never invent IDs or ask the user to read them. Returns \
                           metadata (title / state / author / dates / url) plus a slice \
                           of `body` controlled by body_offset / body_limit. Defaults \
                           cover full body for ~95% of items; if `bodyHasMore` is true \
                           AND the user wants more, call again with \
                           `body_offset = previous bodyOffset + bodyLength`. \
                           Reply shape: spoken summary in the user's language, not raw \
                           markdown. Don't read URLs, code blocks, or dashes aloud — \
                           summarize. Preamble (network fetch ~500-1000ms): \
                           EN 'one sec.' / 中 '稍等'.",
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
                           currently selected. Reply shape: verb-first, one word. \
                           Match the user's spoken language for the entire reply. \
                           EN samples: 'switched.' / 'switched to kale.' \
                           中文 samples: '切过去了。' / '切到 kale 了。' \
                           Do not read the workspace id aloud. No preamble; this is fast.",
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
            Self::EndSession => ToolMetadata {
                name: "end_session",
                parameters: json!({ "type": "object", "properties": {}, "required": [] }),
                cli_path: None,
                invalidates: &[],
                use_when: "Close the voice-mode session yourself when the user signals they're \
                           done talking ('that's all', 'thanks bye', 'I'm done', '算了', \
                           '不用了', '没事了', '谢了拜拜'). The user should NOT have to press \
                           a shortcut to dismiss voice mode — if they verbally wrap up, you \
                           wrap up. ALWAYS speak your goodbye reply *first*, then call this \
                           tool — the dispatcher waits for the audio buffer to flush before \
                           tearing down the WebRTC session, so calling it mid-sentence would \
                           cut off the last word or two of your reply. Reply shape: one short \
                           sign-off matching the user's language, then call this tool. \
                           EN samples: 'see ya.' / 'bye.' \
                           中文 samples: '好的拜拜。' / '没事,回见。' \
                           Synthetic tool — no CLI command, no DB write; the dispatcher \
                           drives `voiceModeStore.setActive(false)`.",
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
            Self::ListContextItems => list_context_items(args),
            Self::GetContextItemDetail => get_context_item_detail(args),
            Self::SelectWorkspace => select_workspace(args),
            // Both `wait_for_user` and `end_session` are dispatcher-side
            // signals — they're short-circuited in the frontend before
            // hitting IPC. If a code path ever lands here we still want
            // a clean ack so the model's output channel doesn't stall.
            Self::WaitForUser | Self::EndSession => Ok(VoiceToolResult {
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

fn list_context_items(args: Value) -> Result<VoiceToolResult> {
    let repo_ref = args
        .get("repo")
        .and_then(Value::as_str)
        .context("list_context_items: missing required `repo` argument")?;
    let kind_str = args.get("kind").and_then(Value::as_str).unwrap_or("issues");
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n.clamp(1, 100) as usize)
        .unwrap_or(10);

    let kind = match kind_str.to_ascii_lowercase().as_str() {
        "issues" | "issue" => InboxKind::Issues,
        "prs" | "pr" | "pulls" | "pull" | "mrs" | "mr" => InboxKind::Prs,
        "discussions" | "discussion" => InboxKind::Discussions,
        other => anyhow::bail!("list_context_items: unknown kind `{other}`"),
    };

    // Resolve the repo → forge target (provider, host, owner, name).
    // We need the `remote_url` field which `RepositoryRecord` doesn't
    // carry — go through `list_repositories()` (the same loader the
    // sidebar uses) so we agree with the UI on what "this repo's forge"
    // means.
    let repo_id = service::resolve_repo_ref(repo_ref)?;
    let record = models::repos::list_repositories()?
        .into_iter()
        .find(|r| r.id == repo_id)
        .with_context(|| format!("list_context_items: repo `{repo_ref}` not found"))?;
    let target = forge_target_from(
        record.forge_provider.as_deref(),
        record.remote_url.as_deref(),
    )
    .with_context(|| {
        format!(
            "list_context_items: repo `{}` has no resolvable forge (provider/remote missing)",
            record.name
        )
    })?;

    // GitLab doesn't have Discussions — guard early so the model gets a
    // clear error instead of a `bail!` from the backend router.
    if matches!(kind, InboxKind::Discussions) && !matches!(target.provider, ForgeProvider::Github) {
        anyhow::bail!(
            "list_context_items: discussions are GitHub-only (repo `{}` is on {})",
            record.name,
            target.provider.as_storage_str(),
        );
    }

    let login = record
        .forge_login
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .with_context(|| {
            format!(
                "list_context_items: repo `{}` has no forge account bound — \
                 ask the user to connect from Settings → Repository",
                record.name
            )
        })?;

    let backend = forge_backend_for(target.provider).with_context(|| {
        format!(
            "list_context_items: no backend for provider {}",
            target.provider.as_storage_str(),
        )
    })?;

    let repo_filter = format!("{}/{}", target.owner, target.name);
    let host = Some(target.host.as_str());

    let page = match kind {
        InboxKind::Issues => {
            backend.list_inbox_issues(login, host, None, limit, Some(&repo_filter), None)?
        }
        InboxKind::Prs => {
            backend.list_inbox_prs(login, host, None, limit, Some(&repo_filter), None)?
        }
        InboxKind::Discussions => {
            backend.list_inbox_discussions(login, host, None, limit, Some(&repo_filter), None)?
        }
    };

    Ok(VoiceToolResult {
        data: serde_json::to_value(page)?,
        navigate_to_workspace_id: None,
    })
}

fn get_context_item_detail(args: Value) -> Result<VoiceToolResult> {
    /// Default body window — covers the full body for the vast majority
    /// of real-world issues / PRs (median is well under 500 chars).
    const DEFAULT_BODY_LIMIT: usize = 4000;
    /// Hard upper bound. Past this, we'd be dumping a small book into
    /// the realtime context for no spoken-output benefit; the agent
    /// should paginate via `body_offset` instead.
    const MAX_BODY_LIMIT: usize = 10_000;

    let repo_ref = args
        .get("repo")
        .and_then(Value::as_str)
        .context("get_context_item_detail: missing required `repo` argument")?;
    let source_str = args
        .get("source")
        .and_then(Value::as_str)
        .context("get_context_item_detail: missing required `source` argument")?;
    let external_id = args
        .get("external_id")
        .and_then(Value::as_str)
        .context("get_context_item_detail: missing required `external_id` argument")?;
    let body_offset = args
        .get("body_offset")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(0);
    let body_limit = args
        .get("body_limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, MAX_BODY_LIMIT))
        .unwrap_or(DEFAULT_BODY_LIMIT);

    // Same resolution path as list_context_items so a repo's forge target
    // is interpreted identically across both tools.
    let repo_id = service::resolve_repo_ref(repo_ref)?;
    let record = models::repos::list_repositories()?
        .into_iter()
        .find(|r| r.id == repo_id)
        .with_context(|| format!("get_context_item_detail: repo `{repo_ref}` not found"))?;
    let target = forge_target_from(
        record.forge_provider.as_deref(),
        record.remote_url.as_deref(),
    )
    .with_context(|| {
        format!(
            "get_context_item_detail: repo `{}` has no resolvable forge (provider/remote missing)",
            record.name
        )
    })?;

    let source = parse_inbox_source(source_str, target.provider)?;

    let login = record
        .forge_login
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .with_context(|| {
            format!(
                "get_context_item_detail: repo `{}` has no forge account bound — \
                 ask the user to connect from Settings → Repository",
                record.name
            )
        })?;

    let backend = forge_backend_for(target.provider).with_context(|| {
        format!(
            "get_context_item_detail: no backend for provider {}",
            target.provider.as_storage_str(),
        )
    })?;

    let detail = backend
        .get_inbox_item_detail(login, Some(target.host.as_str()), source, external_id)?
        .with_context(|| {
            format!(
                "get_context_item_detail: no {} item `{external_id}` in `{}/{}`",
                source_str, target.owner, target.name,
            )
        })?;

    let data = slice_detail_body(&detail, body_offset, body_limit)?;

    Ok(VoiceToolResult {
        data,
        navigate_to_workspace_id: None,
    })
}

/// Voice-friendly mapping from the agent's plain "issue" / "pr" /
/// "discussion" surface vocabulary onto the provider-specific
/// `InboxSource` enum. Both PR and MR map to `pr` so the agent doesn't
/// branch on forge in its own head.
fn parse_inbox_source(s: &str, provider: ForgeProvider) -> Result<InboxSource> {
    match (s.trim().to_ascii_lowercase().as_str(), provider) {
        ("issue" | "issues", ForgeProvider::Github) => Ok(InboxSource::GithubIssue),
        ("issue" | "issues", ForgeProvider::Gitlab) => Ok(InboxSource::GitlabIssue),
        ("pr" | "prs" | "pull" | "pulls", ForgeProvider::Github) => Ok(InboxSource::GithubPr),
        ("pr" | "prs" | "mr" | "mrs", ForgeProvider::Gitlab) => Ok(InboxSource::GitlabMr),
        ("discussion" | "discussions", ForgeProvider::Github) => Ok(InboxSource::GithubDiscussion),
        ("discussion" | "discussions", ForgeProvider::Gitlab) => {
            anyhow::bail!("get_context_item_detail: discussions are GitHub-only")
        }
        (other, _) => anyhow::bail!("get_context_item_detail: unknown source `{other}`"),
    }
}

/// Serialize an `InboxItemDetail` and replace its `body` field with a
/// char-bounded slice plus pagination metadata. Each detail variant
/// (`GithubIssueDetail`, `GitlabMergeRequestDetail`, …) carries a
/// `body: Option<String>` field, so we patch the JSON shape in one
/// place rather than matching every variant by hand.
///
/// `bodyOffset` / `bodyLength` / `bodyTotal` / `bodyHasMore` let the
/// agent decide whether to fetch a follow-up window — no truncation
/// "loses" the rest of the body, it's still reachable via a second
/// call with `body_offset = previous bodyOffset + bodyLength`.
fn slice_detail_body(detail: &InboxItemDetail, offset: usize, limit: usize) -> Result<Value> {
    let mut value = serde_json::to_value(detail)?;
    let data = value
        .get_mut("data")
        .and_then(Value::as_object_mut)
        .context("slice_detail_body: `data` object missing — InboxItemDetail shape changed?")?;

    let full_body = data
        .get("body")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default();
    let total = full_body.chars().count();
    let safe_offset = offset.min(total);
    let take = limit.min(total.saturating_sub(safe_offset));
    let slice: String = full_body.chars().skip(safe_offset).take(take).collect();
    let returned = slice.chars().count();

    data.insert("body".to_owned(), Value::String(slice));
    data.insert("bodyOffset".to_owned(), json!(safe_offset));
    data.insert("bodyLength".to_owned(), json!(returned));
    data.insert("bodyTotal".to_owned(), json!(total));
    data.insert(
        "bodyHasMore".to_owned(),
        Value::Bool(safe_offset + returned < total),
    );

    Ok(value)
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
                "end_session",
                "get_context_item_detail",
                "list_context_items",
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
