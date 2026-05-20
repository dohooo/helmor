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
#[cfg(test)]
use clap::CommandFactory;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

use tauri::Manager;

#[cfg(test)]
use crate::cli::Cli;
use crate::executor_studio::{client::ResumeAction, ManagedExecutor};
use crate::models;
use crate::pipeline::types::{HistoricalRecord, MessageRole};
use crate::service;
use crate::workspace::scripts::ScriptProcessManager;
use crate::workspace::status::WorkspaceStatus;
use crate::workspace::workspaces;

use super::common::{run_blocking, CmdResult};
use super::screen_capture::{self, CaptureMode};

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
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    // ─── Executor-routed meta tools ─────────────────────────────────
    // External systems (GitHub, Sentry, Linear, ...) go through
    // Executor's QuickJS sandbox via `POST /api/executions`.
    SearchMcpTools,
    DescribeMcpTool,
    CallMcpTool,
    ApproveMcpCall,
    // ─── Front-end-only short-circuit signals ────────────────────────
    // These never round-trip to Rust — `tool-dispatcher.ts` matches the
    // name and handles the UX (stay silent / tear down voice mode). The
    // `run()` arms below still ack with `{ok: true}` as a safety net.
    WaitForUser,
    EndSession,
    // ─── Helmor native typed tools ──────────────────────────────────
    // Internal app/workspace operations run directly in-process. Do not
    // route these through Executor; the typed Rust handlers below call
    // the same service/model code as the rest of Helmor.
    DescribeLocalTools,
    ListWorkspaces,
    ShowWorkspace,
    CreateWorkspace,
    CreateWorkspaceAndSend,
    CreateWorkspaceVariants,
    SetWorkspaceStatus,
    ArchiveWorkspace,
    PermanentlyDeleteWorkspace,
    RunWorkspaceAction,
    RunWorkspaceScript,
    ListSessions,
    SearchSessions,
    GetSessionMessages,
    StopSession,
    SendPrompt,
    ListRepos,
    SelectWorkspace,
    CaptureScreen,
}

/// Tool declaration metadata. The JSON Schema in `parameters` is the
/// contract with the model; `cli_path` lets us fetch the matching
/// clap `--help` to feed back into the description so the spoken-side
/// docs and `helmor <cmd> --help` never drift.
pub struct ToolMetadata {
    pub name: &'static str,
    pub parameters: Value,
    #[allow(dead_code)]
    pub cli_path: Option<&'static [&'static str]>,
    pub invalidates: &'static [MutationKind],
    /// Voice-context preamble prepended to the clap help body.
    #[allow(dead_code)]
    pub use_when: &'static str,
}

/// Result of one handler invocation, before envelope wrapping. Handlers
/// usually only set `data`; the optional fields below pick up sensible
/// `None` defaults via the `Default` impl so the struct literal stays
/// compact (`VoiceToolResult { data: ..., ..Default::default() }`).
#[derive(Default)]
struct VoiceToolResult {
    /// JSON returned to the model as the `function_call_output` body.
    data: Value,
    /// When set, the frontend dispatcher fires `handleSelectWorkspace`
    /// with this UUID so the UI follows the agent's action.
    navigate_to_workspace_id: Option<String>,
    /// When set, the frontend dispatcher routes through
    /// `handleInspectorCommitAction` to run the action via the same code
    /// path the GUI button uses.
    dispatch_workspace_action: Option<DispatchWorkspaceAction>,
    /// When set, the frontend dispatcher pushes the image as an
    /// `input_image` user item into the Realtime conversation *between*
    /// the `function_call_output` and the follow-up `response.create`.
    /// This is how `capture_screen` returns its screenshot — the
    /// `function_call_output` itself is a Realtime API string-only
    /// channel, so the binary payload rides the envelope.
    image: Option<VoiceToolImage>,
}

/// Image payload emitted by `capture_screen`. Mirrors the frontend
/// `VoiceToolImage` in `src/lib/api.ts` exactly.
///
/// We pass a fully-formed `data:image/jpeg;base64,…` URL rather than
/// a Files API `file_id` because `gpt-realtime-2` rejects
/// `input_image` items without `image_url`, even when `file_id` is
/// set — verified against the live API. The encoder in
/// `screen_capture::capture` aggressively downsamples + JPEG-q60s the
/// frame so the resulting base64 string stays under the WebRTC
/// dataChannel's SCTP message size limit (~16–256 KB depending on
/// platform; see github.com/openai/openai-agents-js/issues/501).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceToolImage {
    /// `data:image/jpeg;base64,…` ready for the Realtime API
    /// `input_image.image_url` field.
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    /// Short caption to send alongside the image as an `input_text`
    /// content part — gives the model a one-line steer ("here's the
    /// focused window") instead of having to infer intent from the
    /// image alone.
    pub caption: String,
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
    /// Set by `run_workspace_action` for the four agent-dispatched action
    /// kinds (`commit_and_push` / `create_pr` / `fix_errors` /
    /// `resolve_conflicts`) so the frontend dispatcher can route the
    /// action through the same `handleInspectorCommitAction` path that
    /// the GUI buttons use — keeping the canned prompts +
    /// post-stream verifiers + auto-close behavior identical between
    /// voice and click flows.
    pub dispatch_workspace_action: Option<DispatchWorkspaceAction>,
    /// Set by `capture_screen` to deliver the captured PNG to the
    /// frontend dispatcher, which then injects it as an `input_image`
    /// user item into the Realtime conversation between the
    /// `function_call_output` and the next `response.create`. The
    /// `function_call_output.output` field is string-only on the
    /// Realtime API side, so binary screenshots ride the envelope
    /// rather than the tool output.
    pub image: Option<VoiceToolImage>,
}

/// Frontend-side dispatch hint emitted by `run_workspace_action`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchWorkspaceAction {
    pub workspace_id: String,
    /// Storage-format action name (matches `ActionKind` storage strings,
    /// e.g. `"commit-and-push"`). Frontend maps this to the corresponding
    /// `handleInspectorCommitAction` call.
    pub action_kind: String,
}

/// Per-invocation context injected by `run_voice_tool` so handlers that
/// need Tauri state (notably `run_workspace_script`, which kicks off a
/// PTY-backed shell run via the shared `ScriptProcessManager`) can reach
/// it without every handler having to take parameters they don't use.
pub struct VoiceToolContext {
    pub app: tauri::AppHandle,
    pub scripts_manager: ScriptProcessManager,
}

impl ToolKind {
    /// Every variant, in OpenAI-payload presentation order. Kept as a
    /// `const` so iteration in `build_tools_array` and the unit tests
    /// is allocation-free.
    ///
    /// The voice agent sees both:
    ///   * Executor meta tools for external MCP sources.
    ///   * Helmor native typed tools for in-process app/workspace work.
    ///
    pub const ALL: &'static [ToolKind] = &[
        Self::SearchMcpTools,
        Self::DescribeMcpTool,
        Self::CallMcpTool,
        Self::ApproveMcpCall,
        Self::WaitForUser,
        Self::EndSession,
        Self::DescribeLocalTools,
        Self::ListWorkspaces,
        Self::ShowWorkspace,
        Self::CreateWorkspace,
        Self::CreateWorkspaceAndSend,
        Self::CreateWorkspaceVariants,
        Self::SetWorkspaceStatus,
        Self::ArchiveWorkspace,
        Self::PermanentlyDeleteWorkspace,
        Self::RunWorkspaceAction,
        Self::RunWorkspaceScript,
        Self::ListSessions,
        Self::SearchSessions,
        Self::GetSessionMessages,
        Self::StopSession,
        Self::SendPrompt,
        Self::ListRepos,
        Self::SelectWorkspace,
        Self::CaptureScreen,
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
            Self::SearchMcpTools => ToolMetadata {
                name: "search_mcp_tools",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Natural-language description of what you want to do in an external system. Use narrow queries."
                        },
                        "namespace": {
                            "type": "string",
                            "description": "Optional external source filter to scope the search (e.g. 'github', 'sentry', 'linear')."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "How many matches to return (default 5, max 12).",
                            "minimum": 1,
                            "maximum": 12
                        }
                    },
                    "required": ["query"]
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "USE WHEN: the user mentions any external system (GitHub, Linear, \
                           Stripe, ...). For Helmor local workspaces / sessions / repos, \
                           use native tools instead. Always call this BEFORE call_mcp_tool — it \
                           returns ranked tool paths (e.g. `github.issues.list`) you then \
                           hand to call_mcp_tool. Prefer specific queries and limit 3-5 to keep results small. Returns \
                           { status, structured: { result: { items: [{path, name, description, \
                           score}, ...] } } }. If items is empty, retry once unfiltered if a \
                           namespace was used; otherwise the source may not be configured.",
            },
            Self::DescribeMcpTool => ToolMetadata {
                name: "describe_mcp_tool",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "tool_path": {
                            "type": "string",
                            "description": "Dot-separated tool path from search_mcp_tools, e.g. 'githubcopilot_mcp.list_pull_requests'."
                        }
                    },
                    "required": ["tool_path"]
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "USE WHEN: you have a tool_path from search_mcp_tools but do not \
                           know its exact required arguments, or call_mcp_tool returned a \
                           missing-parameter/schema error. Returns Executor's compact \
                           argument schema for that tool; then retry call_mcp_tool with \
                           matching JSON arguments. For GitHub repo tools, combine this \
                           with Helmor repo data by parsing owner/repo from SSH remotes \
                           like `git@github.com:owner/repo.git` or HTTPS remotes like \
                           `https://github.com/owner/repo.git`.",
            },
            Self::CallMcpTool => ToolMetadata {
                name: "call_mcp_tool",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "tool_path": {
                            "type": "string",
                            "description": "Dot-separated tool path from search_mcp_tools, e.g. 'github.issues.list'."
                        },
                        "arguments": {
                            "type": "object",
                            "description": "Required. Arguments matching the tool's input schema from describe_mcp_tool. Do not call external tools with empty {} arguments."
                        }
                    },
                    "required": ["tool_path", "arguments"]
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "USE WHEN: you have a tool_path from a recent search_mcp_tools call \
                           and arguments matching describe_mcp_tool's inputTypeScript. \
                           Never omit arguments; search_mcp_tools only finds paths and \
                           does not provide the input contract. Returns the raw ExecuteResponse: \
                           { status: 'completed' | 'paused', text, structured, isError? }. \
                           - If status is 'completed', read the `text` or `structured` field \
                             back to the user concisely; if `isError` is true, explain the \
                             error in plain words. \
                           - If status is 'paused', `structured.executionId` + \
                             `structured.interaction.message` are present — user approval is \
                             needed. Tell the user EXACTLY what you're about to do in one \
                             short sentence, wait for an explicit yes / no, then call \
                             approve_mcp_call with the executionId and matching action.",
            },
            Self::ApproveMcpCall => ToolMetadata {
                name: "approve_mcp_call",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "execution_id": {
                            "type": "string",
                            "description": "executionId from a paused call_mcp_tool response."
                        },
                        "action": {
                            "type": "string",
                            "enum": ["accept", "decline", "cancel"],
                            "description": "'accept' = proceed, 'decline' = user said no, 'cancel' = abort."
                        },
                        "content": {
                            "type": "object",
                            "description": "Optional form payload — fill from `interaction.requestedSchema` when the elicitation kind is 'form'."
                        }
                    },
                    "required": ["execution_id", "action"]
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "USE WHEN: the previous call_mcp_tool returned status='paused'. The \
                           user must have explicitly confirmed in this turn (a verbal 'yes' / \
                           'go ahead' / 'do it' for accept, 'no' / 'don't' for decline). NEVER \
                           call this without an explicit human confirmation in the immediately \
                           preceding turn. Returns the resumed result in the same shape as \
                           call_mcp_tool — can pause again on multi-step elicitations.",
            },
            Self::DescribeLocalTools => ToolMetadata {
                name: "describe_local_tools",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "tools": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    },
                    "required": []
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "Get compact argument and behavior help for Helmor local tools. \
                           Use only when local tool choice/arguments are unclear, or after \
                           a local tool failed. Pass up to three tool names.",
            },
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
                        },
                        "session_status": {
                            "type": "string",
                            "enum": ["working", "idle", "streaming", "aborted"],
                            "description": "Optional filter by active session state. \
                                            `working` matches streaming/pending/running sessions."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum rows to return. Default 20, max 50."
                        }
                    },
                    "required": []
                }),
                cli_path: Some(&["workspace", "list"]),
                invalidates: &[],
                use_when: "USE WHEN: user asks 'show/list/what workspaces do I have'. \
                           For 'what is working/running now', pass session_status='working'. \
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
            Self::CreateWorkspaceAndSend => ToolMetadata {
                name: "create_workspace_and_send",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "repo": {
                            "type": "string",
                            "description": "Single repo name or UUID. Must already be \
                                            registered (call list_repos if unsure)."
                        },
                        "prompt": {
                            "type": "string",
                            "description": "Verbatim what the user wants the agent to do. \
                                            When attaching screenshots, also include each \
                                            path as `@<absolute-path>` in this text — that's \
                                            Helmor's in-composer image marker and the \
                                            workspace agent reads it as 'image goes here'."
                        },
                        "plan_mode": {
                            "type": "boolean",
                            "description": "Toggle agent plan mode for the seeded turn. \
                                            Default false."
                        },
                        "effort_level": {
                            "type": "string",
                            "enum": ["low", "medium", "high", "xhigh", "max"],
                            "description": "Optional reasoning effort for this new session. \
                                            Pick by task difficulty: low=small/simple, \
                                            medium=normal, high=multi-file/debugging/tests. \
                                            Use xhigh/max only when the user explicitly asks \
                                            for maximum effort or the task is unusually deep. \
                                            Omit to use the user's default effort setting."
                        },
                        "image_paths": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Absolute paths returned by prior `capture_screen` \
                                            calls (their `imagePath` field). The workspace \
                                            agent reads these as real image attachments. \
                                            Mirror the same paths in `prompt` as \
                                            `@<absolute-path>` markers — both are needed: \
                                            the marker positions the image in the message, \
                                            the array attaches the bytes."
                        }
                    },
                    "required": ["repo", "prompt"]
                }),
                cli_path: None,
                invalidates: &[MutationKind::Workspaces, MutationKind::Sessions],
                use_when: "USE WHEN: user describes work in ONE repo + ONE prompt ('in \
                           helmor, fix the login bug', 'in kale, add dark mode'). Prefer \
                           this over `create_workspace` + `send_prompt` — single round-trip \
                           instead of two. For 'same repo, multiple variants/versions/方案' \
                           use `create_workspace_variants` instead. For cross-repo work, \
                           call this tool serially (twice) — no array shape. After success, \
                           the UI auto-navigates to the new workspace. Model comes from the \
                           user's default model setting; choose effort_level only by task \
                           difficulty. Reply shape: \
                           verb-first, name the repo, no opener. \
                           EN samples: 'created in kale, sent.' / 'done.' \
                           中文 samples: 'kale 建好发了。' / '建好了。' \
                           Preamble (1-2s): EN 'one sec.' / 中 '稍等'.",
            },
            Self::CreateWorkspaceVariants => ToolMetadata {
                name: "create_workspace_variants",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "repo": {
                            "type": "string",
                            "description": "Repo name or UUID. Same repo is used for every \
                                            variant — they differ only in the prompt."
                        },
                        "prompts": {
                            "type": "array",
                            "minItems": 2,
                            "items": { "type": "string" },
                            "description": "One prompt per workspace. **Each entry MUST \
                                            explicitly describe how it differs from the \
                                            others** ('move it 2 pixels down', 'move it 4 \
                                            pixels down', 'move it 6 pixels down') — do NOT \
                                            send meta-prompts like 'create three variants', \
                                            the agents see each prompt in isolation and \
                                            won't know about siblings. When attaching \
                                            screenshots, include `@<absolute-path>` markers \
                                            in every prompt that should see the image."
                        },
                        "plan_mode": {
                            "type": "boolean",
                            "description": "Toggle agent plan mode for every variant. \
                                            Default false."
                        },
                        "effort_level": {
                            "type": "string",
                            "enum": ["low", "medium", "high", "xhigh", "max"],
                            "description": "Optional reasoning effort for every variant. \
                                            Pick by task difficulty; omit to use the user's \
                                            default effort setting."
                        },
                        "image_paths": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Absolute paths from prior `capture_screen` \
                                            calls. The SAME images attach to every variant — \
                                            the typical scenario is 'try three things to \
                                            this same screenshot'. Mirror as \
                                            `@<absolute-path>` markers in each prompt."
                        }
                    },
                    "required": ["repo", "prompts"]
                }),
                cli_path: None,
                invalidates: &[MutationKind::Workspaces, MutationKind::Sessions],
                use_when: "USE WHEN: user asks for N variants / versions / 方案 / 对比 / \
                           A/B in the SAME repo ('create three workspaces, move it 2/4/6 \
                           pixels', 'try three different fixes', '三个方案'). Each prompt \
                           runs in its own worktree so the user can compare results. The \
                           prompts array length is the number of workspaces. Best-effort: \
                           one variant failing doesn't block the others. After success, UI \
                           navigates to the LAST created workspace. Model comes from the \
                           user's default model setting; choose effort_level only by task \
                           difficulty. \
                           Reply shape: verb-first count, no opener. \
                           EN sample: 'three variants kicked off.' \
                           中文 sample: '三个方案都跑起来了。' \
                           Preamble (~1s per variant): EN 'one sec.' / 中 '稍等'.",
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
            Self::ArchiveWorkspace => ToolMetadata {
                name: "archive_workspace",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "workspace": {
                            "type": "string",
                            "description": "Workspace UUID or `repo/dir` shorthand."
                        }
                    },
                    "required": ["workspace"]
                }),
                cli_path: None,
                invalidates: &[MutationKind::Workspaces],
                use_when: "USE WHEN: user wants to wrap up a workspace they're done with — \
                           'archive the X workspace', 'put X away', 'clean up the done one'. \
                           Reversible (the workspace can be restored from the archive view) \
                           so DON'T ask for confirmation. Prefer this over \
                           `permanently_delete_workspace` whenever the user just says \
                           'remove' / 'get rid of' — only delete when they explicitly say \
                           'delete' / 'permanently' / 'erase'. Reply shape: verb-first, \
                           name the workspace, nothing else. \
                           EN samples: 'archived kale/login-fix.' / 'archived.' \
                           中文 samples: 'kale/login-fix 归档了。' / '归档了。' \
                           No preamble; returns in milliseconds.",
            },
            Self::PermanentlyDeleteWorkspace => ToolMetadata {
                name: "permanently_delete_workspace",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "workspace": {
                            "type": "string",
                            "description": "Workspace UUID or `repo/dir` shorthand."
                        },
                        "confirmed": {
                            "type": "boolean",
                            "description": "Must be true. The handler rejects the call \
                                            otherwise — proof the user explicitly confirmed \
                                            a destructive, irreversible delete."
                        }
                    },
                    "required": ["workspace", "confirmed"]
                }),
                cli_path: None,
                invalidates: &[MutationKind::Workspaces, MutationKind::Sessions],
                use_when: "USE WHEN: user EXPLICITLY says 'delete' / 'permanently remove' / \
                           '彻底删除' for a workspace. This is destructive and unrecoverable \
                           — the worktree is removed from disk, sessions are dropped, branch \
                           may be left dangling. ALWAYS confirm verbally first: ask 'delete \
                           X for good?' / '彻底删掉 X 吗?' and only call this tool with \
                           `confirmed: true` after the user explicitly agrees. If they just \
                           said 'remove' / 'get rid of' without 'delete'/'permanent', \
                           prefer `archive_workspace` and confirm that interpretation. \
                           Reply shape after success: verb-first, terse. \
                           EN: 'deleted.' / 中: '删了。'",
            },
            Self::RunWorkspaceAction => ToolMetadata {
                name: "run_workspace_action",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "workspace": {
                            "type": "string",
                            "description": "Workspace UUID or `repo/dir` shorthand."
                        },
                        "action": {
                            "type": "string",
                            "enum": [
                                "commit_and_push",
                                "create_pr",
                                "fix_errors",
                                "resolve_conflicts",
                                "merge_pr",
                                "pull_latest"
                            ],
                            "description": "Which ship-flow action to run. `commit_and_push`, \
                                            `create_pr`, `fix_errors`, `resolve_conflicts` \
                                            spawn an agent session (you don't see results — \
                                            the user does, in the inspector). `merge_pr` and \
                                            `pull_latest` are direct git/forge calls."
                        }
                    },
                    "required": ["workspace", "action"]
                }),
                cli_path: None,
                invalidates: &[MutationKind::Workspaces, MutationKind::Sessions],
                use_when: "USE WHEN: user asks for a ship-flow action on a workspace — \
                           'commit and push X', 'open a PR', 'merge the PR', 'pull latest', \
                           'fix the CI errors', 'resolve conflicts'. \
                           Mapping cheat sheet (note: voice tool args use snake_case action \
                           names; the GUI sometimes spells them with dashes — same things): \
                           commit/push → commit_and_push;  open/create PR/MR → create_pr; \
                           merge the PR/MR → merge_pr;  pull/sync/update from main → \
                           pull_latest;  fix errors/CI/lint → fix_errors;  resolve conflicts \
                           → resolve_conflicts.  Voice does NOT expose 'open PR in browser', \
                           'push' (alone), or 'review' — those are GUI-only today. \
                           Reply shape after dispatch: verb-first, terse. The four \
                           agent-dispatched actions run async (you don't wait for them); \
                           merge_pr / pull_latest return immediately with a result. \
                           EN samples: 'committing and pushing.' / 'pulled.' / 'merged.' \
                           中文 samples: 'commit 并推送中。' / '拉好了。' / 'merge 了。' \
                           Preamble (instant for direct ones, ~1s for agent ones): rarely \
                           needed.",
            },
            Self::RunWorkspaceScript => ToolMetadata {
                name: "run_workspace_script",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "workspace": {
                            "type": "string",
                            "description": "Workspace UUID or `repo/dir` shorthand."
                        },
                        "script": {
                            "type": "string",
                            "enum": ["setup", "run"],
                            "description": "Which repo-level script to run. `setup` is the \
                                            one that bootstraps deps; `run` is the dev / \
                                            serve script. Only fires if the repo has that \
                                            script configured in its settings."
                        }
                    },
                    "required": ["workspace", "script"]
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "USE WHEN: user wants to (re)run a repo's setup or dev script on a \
                           workspace — 'run setup in X', 'kick off the dev server', '跑一下 \
                           setup'. Fire-and-forget: the script runs in the background in \
                           Helmor's inspector — you don't see output and shouldn't try to \
                           narrate it. If the repo has no script of that kind configured, \
                           the tool returns an error you should relay verbatim ('no run \
                           script configured for kale'). \
                           Reply shape after dispatch: verb-first, terse. \
                           EN samples: 'running setup.' / 'kicked off the dev server.' \
                           中文 samples: 'setup 开跑了。' / 'run 跑起来了。' \
                           Preamble: not needed; dispatch is sub-100ms.",
            },
            Self::ListSessions => ToolMetadata {
                name: "list_sessions",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "workspace": {
                            "type": "string",
                            "description": "Workspace UUID or `repo/dir`."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum sessions to return. Default 10, max 20."
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
            Self::SearchSessions => ToolMetadata {
                name: "search_sessions",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Keyword or phrase to search in session titles and \
                                            stored chat history. Optional when filtering by \
                                            status."
                        },
                        "repo": {
                            "type": "string",
                            "description": "Optional repo name or UUID filter."
                        },
                        "status": {
                            "type": "string",
                            "enum": ["working", "idle", "streaming", "aborted"],
                            "description": "Optional session status filter. `working` matches \
                                            streaming/pending/running sessions."
                        },
                        "include_archived": {
                            "type": "boolean",
                            "description": "Include archived workspaces. Default false."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum sessions to return. Default 8, max 20."
                        }
                    },
                    "required": []
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "USE WHEN: user asks to find a session/conversation/chat by keyword, \
                           asks 'where did we discuss X', or gives a remembered phrase/title \
                           without a workspace. Also supports status-only queries like \
                           status='working'. Returns sessionId + workspace ref + status + \
                           compact snippet. After locating a likely match, use \
                           get_session_messages if the user wants details, or select_workspace \
                           to open it. Reply with the best 1-3 matches in the user's language.",
            },
            Self::GetSessionMessages => ToolMetadata {
                name: "get_session_messages",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "session": {
                            "type": "string",
                            "description": "Session UUID — must come from a prior \
                                            list_sessions call. Never invent one or ask the \
                                            user to recite it."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "How many messages to return (1-20). Default 5."
                        },
                        "position": {
                            "type": "string",
                            "enum": ["tail", "head"],
                            "description": "Which message window to read. `tail` is latest \
                                            activity; `head` includes the first user prompt."
                        },
                        "body_limit": {
                            "type": "integer",
                            "description": "Per-message body cap in chars (1-4000). Default \
                                            800 — enough to summarize one turn. Each message \
                                            carries `bodyHasMore` so you know if it was \
                                            truncated."
                        },
                        "body_position": {
                            "type": "string",
                            "enum": ["start", "end"],
                            "description": "Which side of each long message body to return. \
                                            Use `end` when the user asks for the last line or \
                                            final sentence."
                        }
                    },
                    "required": ["session"]
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "USE WHEN: user asks 'what did the agent say in that session', \
                           'show me the last turn', 'what was the first prompt', or 'what was \
                           the final sentence'. Use position='head' for first prompt and \
                           body_position='end' for final sentence. Returns N messages in \
                           chronological order. Each message has \
                           role / createdAt / a flattened text `body` + bodyOffset / \
                           bodyLength / bodyTotal / bodyHasMore. Don't read raw markdown or \
                           tool-call JSON aloud — summarize in the user's language. \
                           `windowHasMore: true` means more messages exist beyond this \
                           window. Preamble (DB read ~50ms): usually \
                           none needed.",
            },
            Self::StopSession => ToolMetadata {
                name: "stop_session",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "session": {
                            "type": "string",
                            "description": "Optional Helmor session UUID to stop. Use IDs from \
                                            list_sessions/search_sessions."
                        },
                        "workspace": {
                            "type": "string",
                            "description": "Optional workspace UUID or `repo-name/dir-name`. \
                                            Stops active streams in that workspace."
                        }
                    },
                    "required": []
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "USE WHEN: user says stop/cancel/interrupt/打断/停止 a running agent \
                           session. Prefer passing session when known; pass workspace for \
                           'stop that workspace'. If neither is provided and exactly one \
                           agent is running, this stops it. If multiple are running, it returns \
                           candidates so you can ask one short clarification.",
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
                            "description": "The instruction to send to the agent. When \
                                            attaching screenshots, include each path as \
                                            `@<absolute-path>` in this text — that's \
                                            Helmor's composer image marker."
                        },
                        "plan_mode": {
                            "type": "boolean",
                            "description": "Run agent in plan mode (no edits). Default false."
                        },
                        "effort_level": {
                            "type": "string",
                            "enum": ["low", "medium", "high", "xhigh", "max"],
                            "description": "Optional reasoning effort for this turn. Pick by \
                                            difficulty: low=small/simple, medium=normal, \
                                            high=multi-file/debugging/tests; xhigh/max only \
                                            for explicitly requested maximum effort. Omit to \
                                            preserve the session/default effort."
                        },
                        "image_paths": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Absolute paths returned by prior `capture_screen` \
                                            calls (`imagePath` field). The workspace agent \
                                            reads these as image attachments. Mirror the \
                                            same paths in `prompt` as `@<absolute-path>` \
                                            markers — both are needed: marker positions, \
                                            array attaches bytes."
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
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "description": "Maximum repos to return. Default 20, max 50."
                        }
                    },
                    "required": []
                }),
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
            Self::CaptureScreen => ToolMetadata {
                name: "capture_screen",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "mode": {
                            "type": "string",
                            "enum": ["window", "screen"],
                            "description": "`window` (default) captures only the user's \
                                            currently focused window — best for reading \
                                            a Slack/email/issue/PR the user is looking \
                                            at. `screen` captures the entire primary \
                                            monitor — use only when the user explicitly \
                                            says 'the whole screen', '整个屏幕', \
                                            'desktop', or when one window clearly \
                                            isn't enough."
                        }
                    },
                    "required": []
                }),
                cli_path: None,
                invalidates: &[],
                use_when: "USE WHEN: the user refers to something visible on their screen \
                           that you cannot otherwise see — 'fix the bug Michael mentioned', \
                           '帮我看一下屏幕上这条', 'read this error', 'what does this PR \
                           say', 'just look at it', 'this one' with no prior context. The \
                           captured image is delivered to you on your *next* turn as a \
                           user message; reason about it then and decide whether to act \
                           (create_workspace_and_send / send_prompt / list_repos) or to \
                           voice-check first. \
                           DO NOT use to satisfy curiosity (no 'let me take a look' \
                           preamble) or to confirm something the user already verbally \
                           described in full. Privacy matters: prefer `window` over \
                           `screen` unless the user explicitly asks for the whole \
                           desktop. \
                           ONE CAPTURE PER REQUEST. Do not call `capture_screen` again \
                           unless the user explicitly asks you to look again ('看一下新的', \
                           'screenshot again') — the first capture's content is in your \
                           context already, re-read it from there. \
                           🚨 AFTER capture_screen returns, if you decide to act \
                           (create workspace, send prompt, run action), you MUST invoke \
                           the action tool — not just speak its success-shape reply. \
                           Speaking 'dosu 建好发了。' / 'started in dosu.' WITHOUT first \
                           emitting the matching function_call is a hallucination that \
                           leaves the UI empty. Sequence: capture_screen → reason → \
                           action function_call → wait for tool result → SPEAK. \
                           On permission denial the tool returns ok:false with a human \
                           cause — read it verbatim, do NOT retry. The user must grant \
                           macOS Screen Recording permission and restart Helmor; you \
                           cannot do either for them. \
                           Reply shape: short preamble ('one sec.' / '稍等,我看下。'), \
                           then on the NEXT turn after the image lands, action function_call \
                           first, then announce. Never narrate what you see line-by-line; \
                           act on it or ask one short clarifying question.",
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

    fn run(self, args: Value, ctx: &VoiceToolContext) -> Result<VoiceToolResult> {
        match self {
            // Meta tools are async (they hit Executor's HTTP API) and are
            // dispatched in `run_voice_tool` *before* the sync handler
            // path. If we land here it means the dispatcher missed —
            // surface an explicit error rather than silently acking.
            Self::SearchMcpTools
            | Self::DescribeMcpTool
            | Self::CallMcpTool
            | Self::ApproveMcpCall => {
                anyhow::bail!(
                    "internal: meta tool routed through sync handler (expected async path)"
                )
            }
            Self::DescribeLocalTools => describe_local_tools(args),
            Self::ListWorkspaces => list_workspaces(args, ctx),
            Self::ShowWorkspace => show_workspace(args, ctx),
            Self::CreateWorkspace => create_workspace(args),
            Self::CreateWorkspaceAndSend => create_workspace_and_send(args, ctx),
            Self::CreateWorkspaceVariants => create_workspace_variants(args, ctx),
            Self::SetWorkspaceStatus => set_workspace_status(args),
            Self::ArchiveWorkspace => archive_workspace(args),
            Self::PermanentlyDeleteWorkspace => permanently_delete_workspace(args),
            Self::RunWorkspaceAction => run_workspace_action(args),
            Self::RunWorkspaceScript => run_workspace_script(args, ctx),
            Self::ListSessions => list_sessions(args, ctx),
            Self::SearchSessions => search_sessions(args, ctx),
            Self::GetSessionMessages => get_session_messages(args),
            Self::StopSession => stop_session(args, ctx),
            Self::SendPrompt => send_prompt(args, ctx),
            Self::ListRepos => list_repos(args),
            Self::SelectWorkspace => select_workspace(args),
            Self::CaptureScreen => capture_screen(args),
            // Both `wait_for_user` and `end_session` are dispatcher-side
            // signals — they're short-circuited in the frontend before
            // hitting IPC. If a code path ever lands here we still want
            // a clean ack so the model's output channel doesn't stall.
            Self::WaitForUser | Self::EndSession => Ok(VoiceToolResult {
                data: json!({ "ok": true }),
                ..Default::default()
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

const DEFAULT_LIST_LIMIT: usize = 20;
const MAX_LIST_LIMIT: usize = 50;
const VOICE_EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

fn bounded_limit(args: &Value, default: usize, max: usize) -> usize {
    args.get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, max))
        .unwrap_or(default)
}

fn parse_effort_level_arg(args: &Value, tool: &str) -> Result<Option<String>> {
    let Some(raw) = args.get("effort_level").and_then(Value::as_str) else {
        return Ok(None);
    };
    let effort = raw.trim().to_ascii_lowercase();
    if effort.is_empty() {
        return Ok(None);
    }
    if !VOICE_EFFORT_LEVELS.contains(&effort.as_str()) {
        anyhow::bail!("{tool}: unknown effort_level `{raw}`");
    }
    Ok(Some(effort))
}

fn load_non_empty_setting(key: &str) -> Option<String> {
    crate::models::settings::load_setting_value(key)
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn default_voice_effort_level() -> Option<String> {
    load_non_empty_setting("app.default_effort").or_else(|| Some("high".to_string()))
}

fn default_voice_model_id() -> String {
    load_non_empty_setting("app.default_model_id").unwrap_or_else(|| "default".to_string())
}

fn session_effort_level(session_id: &str) -> Result<Option<String>> {
    let conn = models::db::read_conn()?;
    let effort: Option<String> = conn
        .query_row(
            "SELECT effort_level FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .with_context(|| format!("Failed to read effort_level for session {session_id}"))?;
    Ok(effort
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_owned();
    }
    if max <= 3 {
        return ".".repeat(max);
    }
    let mut out = value.chars().take(max - 3).collect::<String>();
    out.push_str("...");
    out
}

fn workspace_status_matches(status: &WorkspaceStatus, wanted: &str) -> bool {
    status.group_id().eq_ignore_ascii_case(wanted) || status.as_str().eq_ignore_ascii_case(wanted)
}

fn is_session_working(status: Option<&str>) -> bool {
    matches!(
        status.map(|s| s.to_ascii_lowercase()).as_deref(),
        Some("streaming" | "streaming_input" | "running" | "pending")
    )
}

fn session_status_matches(status: Option<&str>, wanted: &str) -> bool {
    if wanted.eq_ignore_ascii_case("working") {
        return is_session_working(status);
    }
    status
        .map(|status| status.eq_ignore_ascii_case(wanted))
        .unwrap_or(false)
}

fn message_role_from_db(role: &str) -> MessageRole {
    match role {
        "assistant" => MessageRole::Assistant,
        "system" => MessageRole::System,
        "error" => MessageRole::Error,
        _ => MessageRole::User,
    }
}

fn active_stream_session_ids(ctx: &VoiceToolContext) -> HashSet<String> {
    use tauri::Manager;

    ctx.app
        .state::<crate::agents::streaming::ActiveStreams>()
        .snapshot_for_ui()
        .into_iter()
        .map(|stream| stream.session_id)
        .collect()
}

fn effective_session_status(status: Option<&str>, is_active_stream: bool) -> &str {
    if is_active_stream {
        "streaming"
    } else {
        status.unwrap_or("idle")
    }
}

fn effective_session_status_matches(
    status: Option<&str>,
    is_active_stream: bool,
    wanted: &str,
) -> bool {
    if wanted.eq_ignore_ascii_case("working") {
        return is_active_stream || is_session_working(status);
    }
    if is_active_stream && wanted.eq_ignore_ascii_case("streaming") {
        return true;
    }
    session_status_matches(status, wanted)
}

fn describe_local_tools(args: Value) -> Result<VoiceToolResult> {
    const MAX_DETAILED_TOOLS: usize = 3;

    let requested = args
        .get("tools")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .take(MAX_DETAILED_TOOLS)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if requested.is_empty() {
        return Ok(VoiceToolResult {
            data: json!({
                "readContext": [
                    "list_repos",
                    "list_workspaces",
                    "show_workspace",
                    "list_sessions",
                    "search_sessions",
                    "get_session_messages"
                ],
                "actions": [
                    "create_workspace",
                    "create_workspace_and_send",
                    "create_workspace_variants",
                    "send_prompt",
                    "set_workspace_status",
                    "archive_workspace",
                    "permanently_delete_workspace",
                    "run_workspace_action",
                    "run_workspace_script",
                    "stop_session",
                    "select_workspace",
                    "capture_screen"
                ],
                "helpers": ["describe_local_tools", "wait_for_user", "end_session"],
                "note": "Pass tools:[name] for compact help on up to three local tools."
            }),
            ..Default::default()
        });
    }

    let mut tools = Vec::new();
    let mut unknown = Vec::new();
    for name in requested {
        let Some(kind) = ToolKind::from_name(name) else {
            unknown.push(name.to_string());
            continue;
        };
        if !is_local_tool(kind) {
            unknown.push(name.to_string());
            continue;
        }
        tools.push(compact_local_tool_help(kind));
    }

    Ok(VoiceToolResult {
        data: json!({ "tools": tools, "unknown": unknown }),
        ..Default::default()
    })
}

fn is_local_tool(kind: ToolKind) -> bool {
    !matches!(
        kind,
        ToolKind::SearchMcpTools
            | ToolKind::DescribeMcpTool
            | ToolKind::CallMcpTool
            | ToolKind::ApproveMcpCall
    )
}

fn compact_local_tool_help(kind: ToolKind) -> Value {
    let meta = kind.metadata();
    json!({
        "name": meta.name,
        "summary": realtime_description(kind),
        "required": schema_required_args(&meta.parameters),
        "optional": schema_optional_args(&meta.parameters),
        "confirm": local_confirmation_policy(kind),
        "result": local_result_effect(kind),
    })
}

fn schema_required_args(parameters: &Value) -> Vec<String> {
    parameters
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn schema_optional_args(parameters: &Value) -> Vec<String> {
    let required = schema_required_args(parameters);
    let Some(properties) = parameters.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    properties
        .keys()
        .filter(|key| !required.iter().any(|name| name == *key))
        .cloned()
        .collect()
}

fn local_confirmation_policy(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::PermanentlyDeleteWorkspace => "required",
        ToolKind::SetWorkspaceStatus => "required when setting status to canceled",
        ToolKind::RunWorkspaceAction => "required for external/destructive actions",
        ToolKind::StopSession => "required unless the user clearly asked to stop it",
        ToolKind::ArchiveWorkspace => "not required",
        ToolKind::SearchMcpTools
        | ToolKind::DescribeMcpTool
        | ToolKind::CallMcpTool
        | ToolKind::ApproveMcpCall => "not local",
        _ => "not required",
    }
}

fn local_result_effect(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::CreateWorkspace => "creates a workspace and navigates Helmor to it",
        ToolKind::CreateWorkspaceAndSend => {
            "creates a workspace, sends the prompt to its agent, and navigates Helmor to it"
        }
        ToolKind::CreateWorkspaceVariants => {
            "creates multiple workspaces, sends one prompt per variant, and navigates Helmor to the first"
        }
        ToolKind::SendPrompt => "sends a prompt to a workspace agent and navigates Helmor to it",
        ToolKind::SetWorkspaceStatus => "updates workspace status",
        ToolKind::ArchiveWorkspace => "archives a workspace",
        ToolKind::PermanentlyDeleteWorkspace => "permanently deletes a workspace",
        ToolKind::RunWorkspaceAction => "runs or dispatches a workspace action",
        ToolKind::RunWorkspaceScript => "starts a configured workspace script",
        ToolKind::StopSession => "stops a running session",
        ToolKind::SelectWorkspace => "switches the visible Helmor workspace",
        ToolKind::CaptureScreen => "captures the focused window or screen and returns an image reference",
        ToolKind::WaitForUser => "stays silent",
        ToolKind::EndSession => "ends voice mode after a short goodbye",
        ToolKind::DescribeLocalTools => "returns compact help for local tools",
        _ => "returns data for the requested local query",
    }
}

fn list_workspaces(args: Value, ctx: &VoiceToolContext) -> Result<VoiceToolResult> {
    let limit = bounded_limit(&args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    let archived = args
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if archived {
        let rows = workspaces::list_archived_workspaces()?;
        let total = rows.len();
        let rows = rows
            .into_iter()
            .take(limit)
            .map(|row| serde_json::to_value(row).map(compact_workspace_like_value))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        return Ok(VoiceToolResult {
            data: json!({
                "workspaces": rows,
                "total": total,
                "returned": rows.len(),
                "hasMore": total > rows.len(),
            }),
            ..Default::default()
        });
    }

    let status = args.get("status").and_then(Value::as_str);
    let repo = args.get("repo").and_then(Value::as_str);
    let session_status = args.get("session_status").and_then(Value::as_str);

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

    let active_session_ids = active_stream_session_ids(ctx);
    let records = models::workspaces::load_workspace_records()?;
    let mut rows: Vec<Value> = Vec::new();
    let mut total = 0usize;
    for record in records {
        if matches!(
            record.state,
            crate::workspace_state::WorkspaceState::Archived
        ) {
            continue;
        }
        if let Some(wanted) = status {
            if !workspace_status_matches(&record.status, wanted) {
                continue;
            }
        }
        if let Some(name) = &repo_name_filter {
            if record.repo_name.to_lowercase() != *name {
                continue;
            }
        }
        if let Some(wanted) = session_status {
            let active_session_streaming = record
                .active_session_id
                .as_ref()
                .map(|id| active_session_ids.contains(id))
                .unwrap_or(false);
            if !effective_session_status_matches(
                record.active_session_status.as_deref(),
                active_session_streaming,
                wanted,
            ) {
                continue;
            }
        }

        total += 1;
        if rows.len() >= limit {
            continue;
        }
        let active_session_streaming = record
            .active_session_id
            .as_ref()
            .map(|id| active_session_ids.contains(id))
            .unwrap_or(false);
        let active_session_status = effective_session_status(
            record.active_session_status.as_deref(),
            active_session_streaming,
        );
        rows.push(json!({
            "id": record.id,
            "repo": record.repo_name,
            "directory": record.directory_name,
            "title": record.primary_session_title
                .clone()
                .or_else(|| record.active_session_title.clone())
                .unwrap_or_else(|| record.directory_name.clone()),
            "status": record.status.group_id(),
            "state": record.state,
            "branch": record.branch,
            "pinned": record.pinned_at.is_some(),
            "activeSessionId": record.active_session_id,
            "activeSessionTitle": record.active_session_title,
            "activeSessionStatus": active_session_status,
            "primarySessionId": record.primary_session_id,
            "primarySessionTitle": record.primary_session_title,
            "isWorking": active_session_streaming
                || is_session_working(record.active_session_status.as_deref()),
            "sessionCount": record.session_count,
            "messageCount": record.message_count,
        }));
    }
    Ok(VoiceToolResult {
        data: json!({
            "workspaces": rows,
            "total": total,
            "returned": rows.len(),
            "hasMore": total > rows.len(),
        }),
        ..Default::default()
    })
}

fn show_workspace(args: Value, ctx: &VoiceToolContext) -> Result<VoiceToolResult> {
    let reference = args
        .get("ref")
        .and_then(Value::as_str)
        .context("show_workspace: missing required `ref` argument")?;
    let id = service::resolve_workspace_ref(reference)?;
    let detail = service::get_workspace(&id)?;
    let active_session_ids = active_stream_session_ids(ctx);
    let active_session_streaming = detail
        .active_session_id
        .as_ref()
        .map(|id| active_session_ids.contains(id))
        .unwrap_or(false);
    let active_session_status = effective_session_status(
        detail.active_session_status.as_deref(),
        active_session_streaming,
    );
    Ok(VoiceToolResult {
        data: json!({
            "id": detail.id,
            "title": detail.title,
            "repo": detail.repo_name,
            "repoId": detail.repo_id,
            "directory": detail.directory_name,
            "status": detail.status,
            "state": detail.state,
            "mode": detail.mode,
            "branch": detail.branch,
            "targetBranch": detail.intended_target_branch,
            "activeSessionId": detail.active_session_id,
            "activeSessionTitle": detail.active_session_title,
            "activeSessionStatus": active_session_status,
            "isWorking": active_session_streaming
                || is_session_working(detail.active_session_status.as_deref()),
            "sessionCount": detail.session_count,
            "messageCount": detail.message_count,
            "prTitle": detail.pr_title,
            "prUrl": detail.pr_url,
            "forgeProvider": detail.forge_provider,
        }),
        ..Default::default()
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
        ..Default::default()
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
        ..Default::default()
    })
}

fn list_sessions(args: Value, ctx: &VoiceToolContext) -> Result<VoiceToolResult> {
    const DEFAULT_SESSION_LIMIT: usize = 10;
    const MAX_SESSION_LIMIT: usize = 20;

    let reference = args
        .get("workspace")
        .and_then(Value::as_str)
        .context("list_sessions: missing required `workspace` argument")?;
    let limit = bounded_limit(&args, DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT);
    let workspace_id = service::resolve_workspace_ref(reference)?;
    let active_session_ids = active_stream_session_ids(ctx);
    let sessions = models::sessions::list_workspace_sessions(&workspace_id)?;
    let total = sessions.len();
    let start = total.saturating_sub(limit);
    let rows = sessions
        .into_iter()
        .skip(start)
        .map(|session| {
            let is_active_stream = active_session_ids.contains(&session.id);
            let status = effective_session_status(Some(session.status.as_str()), is_active_stream);
            json!({
                "id": session.id,
                "workspaceId": session.workspace_id,
                "title": session.title,
                "status": status,
                "storedStatus": session.status,
                "isWorking": is_active_stream || is_session_working(Some(status)),
                "model": session.model,
                "agentType": session.agent_type,
                "permissionMode": session.permission_mode,
                "unreadCount": session.unread_count,
                "actionKind": session.action_kind,
                "active": session.active,
                "updatedAt": session.updated_at,
                "lastUserMessageAt": session.last_user_message_at,
            })
        })
        .collect::<Vec<_>>();
    Ok(VoiceToolResult {
        data: json!({
            "sessions": rows,
            "total": total,
            "returned": rows.len(),
            "hasMore": total > rows.len(),
        }),
        ..Default::default()
    })
}

fn search_sessions(args: Value, ctx: &VoiceToolContext) -> Result<VoiceToolResult> {
    const DEFAULT_LIMIT: usize = 8;
    const MAX_LIMIT: usize = 20;
    const SNIPPET_LIMIT: usize = 280;

    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let limit = bounded_limit(&args, DEFAULT_LIMIT, MAX_LIMIT);
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
        anyhow::bail!("search_sessions: provide `query` or `status`");
    }
    let like = query.map(|query| format!("%{}%", query.to_ascii_lowercase()));
    let active_session_ids = active_stream_session_ids(ctx);
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
          r.name AS repo_name,
          (
            SELECT sm.id
            FROM session_messages sm
            WHERE sm.session_id = s.id
              AND ?1 IS NOT NULL
              AND lower(sm.content) LIKE ?1
            ORDER BY sm.sent_at DESC, sm.rowid DESC
            LIMIT 1
          ) AS match_message_id,
          (
            SELECT sm.role
            FROM session_messages sm
            WHERE sm.session_id = s.id
              AND ?1 IS NOT NULL
              AND lower(sm.content) LIKE ?1
            ORDER BY sm.sent_at DESC, sm.rowid DESC
            LIMIT 1
          ) AS match_role,
          (
            SELECT sm.content
            FROM session_messages sm
            WHERE sm.session_id = s.id
              AND ?1 IS NOT NULL
              AND lower(sm.content) LIKE ?1
            ORDER BY sm.sent_at DESC, sm.rowid DESC
            LIMIT 1
          ) AS match_content,
          (
            SELECT sm.created_at
            FROM session_messages sm
            WHERE sm.session_id = s.id
              AND ?1 IS NOT NULL
              AND lower(sm.content) LIKE ?1
            ORDER BY sm.sent_at DESC, sm.rowid DESC
            LIMIT 1
          ) AS match_created_at
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
            let match_record = match (
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<String>>(16)?,
                row.get::<_, Option<String>>(17)?,
                row.get::<_, Option<String>>(18)?,
            ) {
                (Some(id), Some(role), Some(content), Some(created_at)) => Some(HistoricalRecord {
                    id,
                    role: message_role_from_db(&role),
                    parsed_content: serde_json::from_str::<Value>(&content).ok(),
                    content,
                    created_at,
                }),
                _ => None,
            };
            let snippet = match_record.as_ref().map(|record| {
                let summary = summarize_historical_record(record);
                truncate_chars(&summary, SNIPPET_LIMIT)
            });
            let is_active_stream = active_session_ids.contains(&session_id);
            let effective_status =
                effective_session_status(Some(&session_status), is_active_stream).to_string();
            Ok(json!({
                "sessionId": session_id,
                "workspaceId": workspace_id,
                "workspaceRef": format!("{}/{}", row.get::<_, String>(14)?, directory),
                "workspaceDirectory": directory,
                "workspaceState": row.get::<_, String>(12)?,
                "workspaceStatus": row.get::<_, String>(13)?,
                "repo": row.get::<_, String>(14)?,
                "title": title,
                "sessionStatus": effective_status,
                "storedSessionStatus": session_status,
                "isWorking": is_active_stream || is_session_working(Some(&session_status)),
                "active": active_session_id.as_deref() == Some(session_id.as_str()),
                "agentType": row.get::<_, Option<String>>(3)?,
                "model": row.get::<_, Option<String>>(5)?,
                "permissionMode": row.get::<_, String>(6)?,
                "updatedAt": row.get::<_, String>(7)?,
                "lastUserMessageAt": row.get::<_, Option<String>>(8)?,
                "actionKind": row.get::<_, Option<String>>(9)?,
                "matchMessageId": match_record.as_ref().map(|record| record.id.clone()),
                "snippet": snippet,
            }))
        },
    )?;
    let mut sessions: Vec<Value> = Vec::new();
    let mut total = 0usize;
    for row in rows {
        let row = row?;
        if let Some(wanted) = status_filter.as_deref() {
            let is_active_stream = row
                .get("sessionId")
                .and_then(Value::as_str)
                .map(|id| active_session_ids.contains(id))
                .unwrap_or(false);
            if !effective_session_status_matches(
                row.get("storedSessionStatus").and_then(Value::as_str),
                is_active_stream,
                wanted,
            ) {
                continue;
            }
        }
        total += 1;
        if sessions.len() < limit {
            sessions.push(row);
        }
    }
    let returned = sessions.len();

    Ok(VoiceToolResult {
        data: json!({
            "sessions": sessions,
            "returned": returned,
            "total": total,
            "hasMore": total > returned,
        }),
        ..Default::default()
    })
}

fn get_session_messages(args: Value) -> Result<VoiceToolResult> {
    /// Window size — how many trailing messages we return per call.
    const DEFAULT_LIMIT: usize = 5;
    const MAX_LIMIT: usize = 20;
    /// Per-message body cap. A single assistant turn (reasoning + tool
    /// calls + result blocks) can be 10-50 KB raw; without this cap the
    /// realtime context would fill up after one fetch.
    const DEFAULT_BODY_LIMIT: usize = 800;
    const MAX_BODY_LIMIT: usize = 4000;

    let session_id = args.get("session").and_then(Value::as_str).context(
        "get_session_messages: missing required `session` argument \
             (UUID from list_sessions)",
    )?;
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

    let (records, total_messages) = list_session_records_for_voice(session_id, limit, position)?;
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

    Ok(VoiceToolResult {
        data: json!({
            "messages": messages,
            "windowSize": records.len(),
            "windowPosition": position,
            "windowHasMore": has_more,
            "totalMessages": total_messages,
        }),
        ..Default::default()
    })
}

fn stop_session(args: Value, ctx: &VoiceToolContext) -> Result<VoiceToolResult> {
    use tauri::Manager;

    let session_ref = args.get("session").and_then(Value::as_str);
    let workspace_ref = args.get("workspace").and_then(Value::as_str);
    let active_streams = ctx
        .app
        .state::<crate::agents::streaming::ActiveStreams>()
        .snapshot_for_ui();

    let mut candidates = match (session_ref, workspace_ref) {
        (Some(session_id), _) => active_streams
            .into_iter()
            .filter(|stream| stream.session_id == session_id)
            .collect::<Vec<_>>(),
        (None, Some(workspace_ref)) => {
            let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
            active_streams
                .into_iter()
                .filter(|stream| stream.workspace_id.as_deref() == Some(workspace_id.as_str()))
                .collect::<Vec<_>>()
        }
        (None, None) => active_streams,
    };

    if candidates.is_empty() {
        return Ok(VoiceToolResult {
            data: json!({
                "stopped": false,
                "reason": "no_active_stream",
            }),
            ..Default::default()
        });
    }

    if session_ref.is_none() && workspace_ref.is_none() && candidates.len() > 1 {
        return Ok(VoiceToolResult {
            data: json!({
                "stopped": false,
                "reason": "multiple_active_streams",
                "candidates": candidates
                    .iter()
                    .map(|stream| json!({
                        "sessionId": stream.session_id,
                        "workspaceId": stream.workspace_id,
                        "provider": stream.provider,
                    }))
                    .collect::<Vec<_>>(),
            }),
            ..Default::default()
        });
    }

    candidates.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    let sidecar = ctx.app.state::<crate::sidecar::ManagedSidecar>();
    let mut stopped = Vec::new();
    for stream in candidates {
        let stop_req = crate::sidecar::SidecarRequest {
            id: uuid::Uuid::new_v4().to_string(),
            method: "stopSession".to_string(),
            params: json!({
                "sessionId": stream.session_id,
                "provider": stream.provider,
            }),
        };
        sidecar
            .send(&stop_req)
            .map_err(|err| anyhow::anyhow!("Failed to stop session: {err}"))?;
        stopped.push(json!({
            "sessionId": stream.session_id,
            "workspaceId": stream.workspace_id,
            "provider": stream.provider,
        }));
    }

    Ok(VoiceToolResult {
        data: json!({
            "stopped": true,
            "sessions": stopped,
        }),
        ..Default::default()
    })
}

fn list_session_records_for_voice(
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

/// Flatten a stored `session_messages.content` JSON record into a
/// human-readable string. The realtime agent should never see raw
/// polymorphic message JSON — it tends to read tool-call arguments
/// aloud or quote markdown verbatim. By collapsing each variant to a
/// plain sentence (or a `[tag]` marker for synthetic events) the agent
/// gets a sane summary surface to speak over.
///
/// Top-level `type` discriminator mirrors the storage contract:
/// `user_prompt` / `user` / `assistant` / `system` / `error` / `result`
/// / `item.completed` (Codex) / `turn.completed`. Unknown types fall
/// back to a `[type-tag]` placeholder so the message still shows up in
/// the timeline rather than vanishing.
fn summarize_historical_record(record: &HistoricalRecord) -> String {
    let Some(parsed) = &record.parsed_content else {
        // Legacy / corrupted row. Fall back to the raw string so the
        // agent at least sees *something* it can describe.
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

/// Join the `message.content` block array of an assistant row into a
/// single string. Text/thinking blocks contribute their text verbatim;
/// tool_use blocks collapse to `[used tool: <name>]` (arguments stay
/// out — the agent doesn't need to recite shell commands aloud).
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

fn send_prompt(args: Value, ctx: &VoiceToolContext) -> Result<VoiceToolResult> {
    let workspace_ref = args
        .get("workspace")
        .and_then(Value::as_str)
        .context("send_prompt: missing required `workspace` argument")?;
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
    let effort_level = parse_effort_level_arg(&args, "send_prompt")?;
    let image_paths = parse_image_paths_arg(&args);

    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let (workspace_id, session_id) = voice_dispatch_to_agent(
        ctx,
        &workspace_id,
        session_id,
        prompt,
        plan_mode,
        effort_level,
        image_paths,
    )?;
    Ok(VoiceToolResult {
        data: json!({
            "workspaceId": workspace_id,
            "sessionId": session_id,
            "persisted": true,
        }),
        navigate_to_workspace_id: Some(workspace_id),
        ..Default::default()
    })
}

/// Parse the `image_paths: string[]` arg used by `send_prompt`,
/// `create_workspace_and_send`, and `create_workspace_variants`. The
/// model gets these paths from a prior `capture_screen` call's
/// `imagePath` field — they're absolute paths into the OS temp dir.
/// Non-string entries and empty strings are filtered out (we'd rather
/// silently ignore a malformed entry than fail the whole send over
/// one bad item — voice flows are high-stakes, partial image attach
/// is better than nothing).
fn parse_image_paths_arg(args: &Value) -> Vec<String> {
    let Some(arr) = args.get("image_paths").and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

/// Single-write dispatcher shared by every voice tool that sends a
/// prompt to a workspace agent (`send_prompt`,
/// `create_workspace_and_send`, `create_workspace_variants`).
///
/// Drops the legacy `service::send_message` app-running fan-out — which
/// would double-write the `user_prompt` row by combining its own insert
/// with the GUI composer's auto-submit — and instead routes through
/// `agents::send_agent_message_internal`, the same code path the GUI
/// composer uses. The `user_prompt` row lands exactly once.
///
/// Returns `(workspace_id, session_id)` so the caller can shape the
/// envelope and surface the resolved session id back to the model.
fn voice_dispatch_to_agent(
    ctx: &VoiceToolContext,
    workspace_id: &str,
    session_id: Option<String>,
    prompt: String,
    plan_mode: bool,
    effort_level: Option<String>,
    image_paths: Vec<String>,
) -> Result<(String, String)> {
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::Manager;

    let permission_mode = plan_mode.then(|| "plan".to_string());

    // Resolve session — reuse the workspace's active session, or create
    // one if it has none yet. Mirrors `service::send_message`'s
    // session resolution (line 146-164) so the voice path picks the
    // same session the GUI would for the same workspace.
    let detail = service::get_workspace(workspace_id)?;
    let session_id = match session_id {
        Some(sid) => sid,
        None => match detail.active_session_id.clone() {
            Some(sid) => sid,
            None => {
                crate::models::sessions::create_session(
                    workspace_id,
                    None,
                    permission_mode.as_deref(),
                    crate::models::sessions::CreateSessionOverrides::default(),
                )?
                .session_id
            }
        },
    };

    // Resolve model — prefer the session's stored model so a previously
    // pinned model isn't silently swapped to "default" by a voice send.
    // Same fallback chain `service::send_message` uses (line 168-178).
    let (session_model, session_provider) =
        crate::models::sessions::get_session_model_and_provider(&session_id)
            .unwrap_or((None, None));
    let model_id = session_model.unwrap_or_else(default_voice_model_id);
    let provider_hint = session_provider.as_deref();
    let model = crate::agents::resolve_model(&model_id, provider_hint);
    let effort_level = match effort_level {
        Some(value) => Some(value),
        None => session_effort_level(&session_id)?.or_else(default_voice_effort_level),
    };
    crate::models::sessions::update_session_settings(
        &session_id,
        Some(model.id.as_str()),
        effort_level.as_deref(),
        permission_mode.as_deref(),
        None,
    )?;
    crate::ui_sync::publish(
        &ctx.app,
        crate::ui_sync::UiMutationEvent::SessionListChanged {
            workspace_id: workspace_id.to_string(),
        },
    );

    let cwd = detail
        .root_path
        .clone()
        .context("voice_dispatch_to_agent: workspace has no root_path")?;

    // Filter out empty / blank paths the model might emit. We never
    // want an empty string to reach `AgentSendRequest.images` — the
    // SDK would happily try to read `""` and surface a confusing
    // "file not found" later in the stream.
    let images: Vec<String> = image_paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    let images = if images.is_empty() {
        None
    } else {
        Some(images)
    };

    let request = crate::agents::AgentSendRequest {
        provider: model.provider.to_string(),
        model_id: model.id.to_string(),
        prompt,
        prompt_prefix: None,
        // `session_id` here is the agent-provider-side id (claude /
        // codex SDK session). Leave None — the backend will start a
        // fresh provider session or resume one based on the row state.
        session_id: None,
        helmor_session_id: Some(session_id.clone()),
        working_directory: Some(cwd),
        effort_level,
        permission_mode,
        fast_mode: None,
        user_message_id: None,
        files: None,
        images,
        broadcast_stream_events: true,
    };

    // Voice agent doesn't consume PTY events — same fire-and-forget
    // pattern as `run_workspace_script`. The user sees output in the
    // workspace inspector instead.
    let on_event: Channel<crate::agents::AgentStreamEvent> =
        Channel::new(|_: InvokeResponseBody| Ok(()));

    let sidecar_state = ctx.app.state::<crate::sidecar::ManagedSidecar>();
    let active_streams_state = ctx.app.state::<crate::agents::streaming::ActiveStreams>();
    crate::agents::send_agent_message_internal(
        ctx.app.clone(),
        sidecar_state.inner(),
        active_streams_state.inner(),
        request,
        on_event,
    )
    .map_err(|err| anyhow::anyhow!("{err:?}"))?;

    Ok((workspace_id.to_string(), session_id))
}

/// Voice-shorthand for `create_workspace` immediately followed by
/// sending the user's prompt to the new workspace's agent. 99% of "new
/// task" voice intents take this shape ("in helmor, fix the login
/// bug"), so collapsing the two calls into one halves the round-trip
/// and one of the agent's reasoning steps.
///
/// **Single repo + single prompt only.** For "same repo, N variants
/// each with its own prompt" use `create_workspace_variants`. For
/// cross-repo batches (rare in practice) the model can serialize two
/// calls to this tool.
fn create_workspace_and_send(args: Value, ctx: &VoiceToolContext) -> Result<VoiceToolResult> {
    let repo_ref = args
        .get("repo")
        .and_then(Value::as_str)
        .context("create_workspace_and_send: missing required `repo` argument")?;
    let prompt = args
        .get("prompt")
        .and_then(Value::as_str)
        .context("create_workspace_and_send: missing required `prompt` argument")?
        .to_string();
    let plan_mode = args
        .get("plan_mode")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let effort_level = parse_effort_level_arg(&args, "create_workspace_and_send")?
        .or_else(default_voice_effort_level);
    let image_paths = parse_image_paths_arg(&args);

    let repo_id = service::resolve_repo_ref(repo_ref)?;
    let response = service::create_workspace_from_repo_impl(&repo_id)?;
    let workspace_id = response.created_workspace_id.clone();
    crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceListChanged).ok();
    crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceChanged {
        workspace_id: workspace_id.clone(),
    })
    .ok();

    let (workspace_id, session_id) = voice_dispatch_to_agent(
        ctx,
        &workspace_id,
        None,
        prompt,
        plan_mode,
        effort_level,
        image_paths,
    )?;

    Ok(VoiceToolResult {
        data: json!({
            "workspaceId": workspace_id,
            "sessionId": session_id,
            "repo": repo_ref,
        }),
        navigate_to_workspace_id: Some(workspace_id),
        ..Default::default()
    })
}

/// Voice-side "create N variants of the same change" tool. Same repo,
/// N workspaces, each with its own prompt. The motivating scenario is
/// "create three workspaces for the traffic-light tweak: 2 / 4 / 6
/// pixels" — three distinct prompts on the same code, each running in
/// its own worktree so the user can compare results side by side.
///
/// Best-effort: one workspace failing (e.g. branch-name collision)
/// doesn't abort the rest. The response carries `created` and
/// `errors` arrays so the agent can speak the partial result.
fn create_workspace_variants(args: Value, ctx: &VoiceToolContext) -> Result<VoiceToolResult> {
    let repo_ref = args
        .get("repo")
        .and_then(Value::as_str)
        .context("create_workspace_variants: missing required `repo` argument")?;
    let prompts_value = args
        .get("prompts")
        .context("create_workspace_variants: missing required `prompts` argument")?;
    let prompts: Vec<String> = prompts_value
        .as_array()
        .context("create_workspace_variants: `prompts` must be an array of strings")?
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect();
    if prompts.len() < 2 {
        anyhow::bail!(
            "create_workspace_variants: `prompts` must contain at least 2 non-empty strings \
             (got {}); use create_workspace_and_send for a single-variant case",
            prompts.len(),
        );
    }
    let plan_mode = args
        .get("plan_mode")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let effort_level = parse_effort_level_arg(&args, "create_workspace_variants")?
        .or_else(default_voice_effort_level);
    // The same image attaches to every variant — voice scenario is "try
    // 3 different things to this same screen", so the picture is shared
    // context across the workspaces. (If we ever need per-variant
    // images we'd promote `image_paths` to an array of arrays parallel
    // to `prompts`, but that's premature today.)
    let image_paths = parse_image_paths_arg(&args);

    // Resolve the repo once up front — same repo for every variant, so
    // a typo fails the whole call cleanly before we create any
    // workspaces.
    let repo_id = service::resolve_repo_ref(repo_ref)?;

    let mut created: Vec<Value> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();
    let mut last_workspace_id: Option<String> = None;

    for prompt in &prompts {
        let result = (|| -> Result<(String, String)> {
            let response = service::create_workspace_from_repo_impl(&repo_id)?;
            let workspace_id = response.created_workspace_id.clone();
            crate::ui_sync::notify_running_app(
                crate::ui_sync::UiMutationEvent::WorkspaceListChanged,
            )
            .ok();
            crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceChanged {
                workspace_id: workspace_id.clone(),
            })
            .ok();
            let (workspace_id, session_id) = voice_dispatch_to_agent(
                ctx,
                &workspace_id,
                None,
                prompt.clone(),
                plan_mode,
                effort_level.clone(),
                image_paths.clone(),
            )?;
            Ok((workspace_id, session_id))
        })();

        match result {
            Ok((workspace_id, session_id)) => {
                last_workspace_id = Some(workspace_id.clone());
                created.push(json!({
                    "workspaceId": workspace_id,
                    "sessionId": session_id,
                    "promptPreview": truncate_chars(prompt, 120),
                }));
            }
            Err(err) => {
                errors.push(json!({
                    "promptPreview": truncate_chars(prompt, 120),
                    "error": format!("{err:#}"),
                }));
            }
        }
    }

    if created.is_empty() {
        anyhow::bail!(
            "create_workspace_variants: all {} variants failed; see envelope detail for per-variant errors",
            errors.len(),
        );
    }

    Ok(VoiceToolResult {
        data: json!({
            "repo": repo_ref,
            "created": created,
            "errors": errors,
        }),
        navigate_to_workspace_id: last_workspace_id,
        ..Default::default()
    })
}

fn archive_workspace(args: Value) -> Result<VoiceToolResult> {
    let reference = args
        .get("workspace")
        .and_then(Value::as_str)
        .context("archive_workspace: missing required `workspace` argument")?;
    let workspace_id = service::resolve_workspace_ref(reference)?;
    crate::workspace::lifecycle::archive_workspace_impl(&workspace_id)?;
    crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceListChanged).ok();
    crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceChanged {
        workspace_id: workspace_id.clone(),
    })
    .ok();
    Ok(VoiceToolResult {
        data: json!({ "ok": true, "workspaceId": workspace_id }),
        ..Default::default()
    })
}

fn permanently_delete_workspace(args: Value) -> Result<VoiceToolResult> {
    // Explicit boolean — missing or non-true blocks the delete. This is
    // the agent-facing analog of the GUI's "Are you sure?" modal: a
    // hard precondition the model has to satisfy by gathering verbal
    // confirmation first.
    let confirmed = args
        .get("confirmed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !confirmed {
        anyhow::bail!(
            "permanently_delete_workspace: requires `confirmed: true` — confirm with the \
             user verbally first, then call again with confirmed=true",
        );
    }
    let reference = args
        .get("workspace")
        .and_then(Value::as_str)
        .context("permanently_delete_workspace: missing required `workspace` argument")?;
    let workspace_id = service::resolve_workspace_ref(reference)?;
    crate::workspace::workspaces::permanently_delete_workspace(&workspace_id)?;
    crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceListChanged).ok();
    Ok(VoiceToolResult {
        data: json!({ "ok": true, "workspaceId": workspace_id }),
        ..Default::default()
    })
}

/// Voice-side dispatcher for ship-flow actions. Two execution lanes:
///
/// * **Agent-dispatched** (`commit_and_push` / `create_pr` / `fix_errors`
///   / `resolve_conflicts`): emits `dispatch_workspace_action` on the
///   envelope so the frontend dispatcher reuses
///   `handleInspectorCommitAction` — the same path GUI buttons use.
///   This keeps the canned prompts in `buildCommitButtonPrompt` and
///   the post-stream verifier / auto-close behavior identical between
///   voice and click.
/// * **Direct** (`merge_pr` / `pull_latest`): executes the existing
///   internal function inline and returns its result. No agent
///   session is created.
fn run_workspace_action(args: Value) -> Result<VoiceToolResult> {
    let reference = args
        .get("workspace")
        .and_then(Value::as_str)
        .context("run_workspace_action: missing required `workspace` argument")?;
    let action_str = args
        .get("action")
        .and_then(Value::as_str)
        .context("run_workspace_action: missing required `action` argument")?;
    let workspace_id = service::resolve_workspace_ref(reference)?;

    match action_str {
        // Agent-dispatched: hand off to the frontend so the canned
        // prompt + verifier wiring stays in one place (the GUI button
        // handlers). Voice handler just signals which action.
        "commit_and_push" | "create_pr" | "fix_errors" | "resolve_conflicts" => {
            let action_kind = match action_str {
                "commit_and_push" => "commit-and-push",
                "create_pr" => "create-pr",
                "fix_errors" => "fix",
                "resolve_conflicts" => "resolve-conflicts",
                _ => unreachable!(),
            };
            Ok(VoiceToolResult {
                data: json!({
                    "ok": true,
                    "action": action_str,
                    "dispatched": true,
                    "workspaceId": workspace_id,
                }),
                navigate_to_workspace_id: Some(workspace_id.clone()),
                dispatch_workspace_action: Some(DispatchWorkspaceAction {
                    workspace_id,
                    action_kind: action_kind.to_string(),
                }),
                image: None,
            })
        }
        // Direct: run inline. Both return their underlying result JSON
        // so the model can phrase outcomes naturally.
        "merge_pr" => {
            let info = crate::forge::merge_workspace_change_request(&workspace_id)?;
            crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceChanged {
                workspace_id: workspace_id.clone(),
            })
            .ok();
            Ok(VoiceToolResult {
                data: json!({
                    "ok": true,
                    "action": "merge_pr",
                    "workspaceId": workspace_id,
                    "result": info,
                }),
                ..Default::default()
            })
        }
        "pull_latest" => {
            let result =
                crate::workspace::workspaces::sync_workspace_with_target_branch(&workspace_id)?;
            crate::ui_sync::notify_running_app(crate::ui_sync::UiMutationEvent::WorkspaceChanged {
                workspace_id: workspace_id.clone(),
            })
            .ok();
            Ok(VoiceToolResult {
                data: json!({
                    "ok": true,
                    "action": "pull_latest",
                    "workspaceId": workspace_id,
                    "result": result,
                }),
                ..Default::default()
            })
        }
        other => anyhow::bail!(
            "run_workspace_action: unknown action `{other}` — valid: commit_and_push, \
             create_pr, fix_errors, resolve_conflicts, merge_pr, pull_latest"
        ),
    }
}

/// Fire-and-forget repo-level script runner. Mirrors
/// `commands::script_commands::execute_repo_script` — the voice-side
/// difference is that we drop the PTY event stream (the agent doesn't
/// narrate output) and surface a fast "started/not configured" verdict
/// to the model. The user sees the live PTY stream in the inspector.
fn run_workspace_script(args: Value, ctx: &VoiceToolContext) -> Result<VoiceToolResult> {
    use tauri::ipc::{Channel, InvokeResponseBody};

    let reference = args
        .get("workspace")
        .and_then(Value::as_str)
        .context("run_workspace_script: missing required `workspace` argument")?;
    let script_type = args
        .get("script")
        .and_then(Value::as_str)
        .context("run_workspace_script: missing required `script` argument")?;
    if !matches!(script_type, "setup" | "run") {
        anyhow::bail!("run_workspace_script: unknown script `{script_type}` — valid: setup, run",);
    }

    let workspace_id = service::resolve_workspace_ref(reference)?;
    let workspace = crate::models::workspaces::load_workspace_record_by_id(&workspace_id)?
        .with_context(|| format!("run_workspace_script: workspace `{reference}` not found"))?;
    let repo_id = workspace.repo_id.clone();

    let repo = crate::repos::load_repository_by_id(&repo_id)?
        .with_context(|| format!("run_workspace_script: repo `{repo_id}` not found"))?;
    let scripts = crate::repos::load_repo_scripts(&repo_id, Some(&workspace_id))?;
    let script = match script_type {
        "setup" => scripts.setup_script.clone(),
        "run" => scripts.run_script.clone(),
        _ => unreachable!(),
    };
    let Some(script) = script.filter(|s| !s.trim().is_empty()) else {
        anyhow::bail!(
            "run_workspace_script: no {script_type} script configured for repo `{}`",
            repo.name,
        );
    };

    // Non-concurrent run mode: stop the previous run-script in this repo
    // before kicking off a new one. Mirrors the GUI Tauri command.
    if script_type == "run" && scripts.run_script_mode == "non-concurrent" {
        ctx.scripts_manager
            .kill_others_in_repo(&repo_id, "run", Some(&workspace_id));
    }

    let workspace_root = crate::workspace::helpers::workspace_path(&workspace).ok();
    let working_dir = workspace_root
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| repo.root_path.clone());
    let context = crate::workspace::scripts::ScriptContext {
        root_path: repo.root_path.clone(),
        workspace_path: Some(working_dir.clone()),
        workspace_name: Some(workspace.directory_name.clone()),
        default_branch: repo.default_branch.clone(),
    };

    // PTY events go nowhere — `Channel::new(|_| Ok(()))` is the
    // documented no-op handler. The user watches output in the
    // inspector via the GUI's own channel.
    let channel: Channel<crate::workspace::scripts::ScriptEvent> =
        Channel::new(|_: InvokeResponseBody| Ok(()));

    let mgr = ctx.scripts_manager.clone();
    let app = ctx.app.clone();
    let script_type_owned = script_type.to_string();
    let workspace_id_owned = workspace_id.clone();
    let repo_id_owned = repo_id.clone();
    let working_dir_owned = working_dir.clone();
    let context_owned = context;
    let script_owned = script;

    tauri::async_runtime::spawn_blocking(move || {
        match crate::workspace::scripts::run_script(
            &mgr,
            &repo_id_owned,
            &script_type_owned,
            Some(&workspace_id_owned),
            &script_owned,
            &working_dir_owned,
            &context_owned,
            channel,
        ) {
            // Mirror execute_repo_script: a successful setup finalizes
            // the workspace's `setup_completed_at` marker + nudges the
            // git watcher so the inspector's Setup tab updates.
            Ok(Some(0)) if script_type_owned == "setup" => {
                if let Ok(ts) = crate::models::db::current_timestamp() {
                    let _ =
                        crate::models::workspaces::mark_setup_completed(&workspace_id_owned, &ts);
                }
                crate::git::watcher::notify_workspace_changed(&app);
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(
                    repo_id = %repo_id_owned,
                    script_type = %script_type_owned,
                    workspace_id = %workspace_id_owned,
                    error = %format!("{err:#}"),
                    "Voice-triggered script run failed"
                );
            }
        }
    });

    Ok(VoiceToolResult {
        data: json!({
            "ok": true,
            "started": true,
            "workspaceId": workspace_id,
            "script": script_type,
        }),
        ..Default::default()
    })
}

fn list_repos(args: Value) -> Result<VoiceToolResult> {
    let limit = bounded_limit(&args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    let repos = models::repos::list_repositories()?;
    let total = repos.len();
    let rows = repos
        .into_iter()
        .take(limit)
        .map(|repo| {
            json!({
                "id": repo.id,
                "name": repo.name,
                "defaultBranch": repo.default_branch,
                "remote": repo.remote,
                "forgeProvider": repo.forge_provider,
                "forgeLogin": repo.forge_login,
            })
        })
        .collect::<Vec<_>>();
    Ok(VoiceToolResult {
        data: json!({
            "repos": rows,
            "total": total,
            "returned": rows.len(),
            "hasMore": total > rows.len(),
        }),
        ..Default::default()
    })
}

fn compact_workspace_like_value(mut value: Value) -> Value {
    let Some(obj) = value.as_object_mut() else {
        return value;
    };

    let take = |obj: &mut serde_json::Map<String, Value>, keys: &[&str]| {
        keys.iter()
            .filter_map(|key| obj.remove(*key).map(|value| ((*key).to_string(), value)))
            .collect::<serde_json::Map<String, Value>>()
    };

    Value::Object(take(
        obj,
        &[
            "id",
            "title",
            "repo",
            "repoName",
            "repo_name",
            "directory",
            "directoryName",
            "directory_name",
            "status",
            "state",
            "branch",
            "activeSessionId",
            "active_session_id",
            "sessionCount",
            "session_count",
            "messageCount",
            "message_count",
        ],
    ))
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
        ..Default::default()
    })
}

/// Capture the user's screen (focused window by default, full primary
/// monitor on request), JPEG-encode + base64 the result, and hand the
/// data URL to the frontend dispatcher, which injects it as an
/// `input_image` user item into the live Realtime conversation. The
/// captured frame is *not* embedded in the `function_call_output` body
/// (Realtime API rejects non-string output); the model sees the image
/// on its next turn instead.
///
/// **Why base64 inline and not Files API `file_id`**: we tried Files
/// API first — `gpt-realtime-2` rejects `input_image` items that omit
/// `image_url`, even when `file_id` is set, with
/// `Missing required parameter: 'item.content[*].image_url'`. The
/// only path that gets past validation is a `data:` (or HTTPS) URL
/// inlined into `image_url`. So `screen_capture::capture` aggressively
/// downsamples (1280px long edge) and JPEG-q60s the frame to keep the
/// resulting base64 below the WebRTC dataChannel's ~16–256 KB SCTP
/// message size ceiling.
///
/// On macOS this checks `CGPreflightScreenCaptureAccess` first. If
/// permission is missing we kick off the system prompt + open the
/// Settings deep-link as side effects, then return a structured error
/// string that the model reads verbatim. The user must grant +
/// restart Helmor before a retry will succeed — `preflight` caches
/// its result for the process lifetime, so any in-process retry is
/// guaranteed to keep returning denied.
fn capture_screen(args: Value) -> Result<VoiceToolResult> {
    let mode = CaptureMode::parse(args.get("mode").and_then(Value::as_str));
    tracing::info!(
        target: "helmor_lib::commands::screen_capture",
        requested_mode = mode.as_str(),
        "capture_screen handler entered"
    );

    if !screen_capture::is_granted() {
        // Explicit warn so the JSONL log clearly shows "this is the
        // permission path", separate from the generic
        // `run_voice_tool` failure log that the anyhow bail below
        // would otherwise be the only signal for. preflight caches
        // its result for the process lifetime, so an in-process retry
        // is guaranteed to keep hitting this branch — the user must
        // grant + restart.
        tracing::warn!(
            requested_mode = mode.as_str(),
            "capture_screen: macOS Screen Recording permission denied; \
             firing system prompt + opening Settings deep-link",
        );
        // Fire the OS prompt (no-op if already shown) and bring the user
        // straight to the right Settings pane. Both are best-effort —
        // the error message we return is what the model actually reads.
        screen_capture::request();
        if let Err(e) = screen_capture::open_settings() {
            tracing::warn!(error = %format!("{e:#}"), "open_settings failed");
        }
        anyhow::bail!(
            "Screen recording permission missing. I just opened System Settings — \
             enable Helmor under Privacy & Security → Screen Recording, then quit \
             and reopen Helmor."
        );
    }

    let result = screen_capture::capture(mode)?;
    let caption = match result.mode_used.as_str() {
        "window" => "Here is the user's currently focused window.".to_string(),
        _ => "Here is the user's screen.".to_string(),
    };
    // `imagePath` lets the model forward the screenshot to a workspace
    // agent (claude / codex) by passing it back via
    // `send_prompt` / `create_workspace_and_send` /
    // `create_workspace_variants`'s `image_paths` argument. When the
    // disk write failed (rare — e.g. temp dir full) `path` is `None`
    // and we omit the key so the model doesn't try to forward a bogus
    // path; it still has the in-realtime `image` envelope and can
    // describe what it saw.
    let mut data = json!({
        "ok": true,
        "mode_used": result.mode_used,
        "width": result.width,
        "height": result.height,
        "encoded_bytes": result.encoded_bytes,
        "note": "screenshot attached on the next user turn",
    });
    if let Some(path) = result.path.as_ref() {
        if let Some(obj) = data.as_object_mut() {
            obj.insert("imagePath".into(), json!(path));
        }
    }
    Ok(VoiceToolResult {
        // Tiny envelope for the function_call_output — the image rides
        // on the side-channel `image` field, picked up by the frontend
        // dispatcher and injected as a separate `input_image` user item.
        data,
        image: Some(VoiceToolImage {
            data_url: result.data_url,
            width: result.width,
            height: result.height,
            caption,
        }),
        ..Default::default()
    })
}

// ---------------------------------------------------------------------------
// Description rendering. The Realtime session gets compact tool
// summaries; compact local help is available on demand via
// `describe_local_tools`. This keeps the static session prefix small
// enough that one short utterance does not burn a large chunk of TPM.
// ---------------------------------------------------------------------------

#[cfg(test)]
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

fn realtime_description(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::SearchMcpTools => {
            "Find tools (GitHub / Linear / Helmor commands / any MCP source) by intent. Call this BEFORE call_mcp_tool. Returns ranked paths + descriptions."
        }
        ToolKind::DescribeMcpTool => {
            "Get the input schema for a searched MCP tool path before calling it, especially after missing-parameter errors."
        }
        ToolKind::CallMcpTool => {
            "Invoke a tool by its dot-path (from search_mcp_tools) with JSON arguments. May return status='paused' when user approval is needed."
        }
        ToolKind::ApproveMcpCall => {
            "Resume a paused execution with action=accept|decline|cancel after the user explicitly confirmed."
        }
        ToolKind::DescribeLocalTools => {
            "Get compact help for Helmor local tool names when arguments or tool choice are unclear."
        }
        ToolKind::ListWorkspaces => {
            "List workspaces; optional status/repo/archive/session-status filters."
        }
        ToolKind::ShowWorkspace => "Show one workspace's status and details.",
        ToolKind::CreateWorkspace => "Create an empty workspace in a repo.",
        ToolKind::CreateWorkspaceAndSend => {
            "Create a workspace in one repo and send the user's request to its agent."
        }
        ToolKind::CreateWorkspaceVariants => {
            "Create multiple same-repo workspaces, one explicit prompt per variant."
        }
        ToolKind::SetWorkspaceStatus => "Set workspace status; confirm before canceled.",
        ToolKind::ArchiveWorkspace => "Archive a workspace; reversible, no confirmation.",
        ToolKind::PermanentlyDeleteWorkspace => {
            "Permanently delete a workspace; requires prior user confirmation."
        }
        ToolKind::RunWorkspaceAction => {
            "Run ship actions: commit_and_push, create_pr, merge_pr, pull_latest, fix_errors, resolve_conflicts."
        }
        ToolKind::RunWorkspaceScript => "Run a workspace setup or run script.",
        ToolKind::ListSessions => "List sessions for a workspace.",
        ToolKind::SearchSessions => "Search session titles and chat history by keyword.",
        ToolKind::GetSessionMessages => "Fetch recent messages from a session for summary.",
        ToolKind::StopSession => "Stop/cancel a running agent session.",
        ToolKind::SendPrompt => "Send a prompt to a workspace agent; optionally attach screenshots.",
        ToolKind::ListRepos => "List registered repos; use before repo-dependent actions if unsure.",
        ToolKind::SelectWorkspace => "Switch Helmor UI to a workspace without modifying data.",
        ToolKind::CaptureScreen => "Capture focused window by default; use screen only when asked.",
        ToolKind::WaitForUser => "Stay silent for background audio or non-addressed speech.",
        ToolKind::EndSession => "End voice mode after speaking a short goodbye.",
    }
}

fn compact_parameters(parameters: &Value) -> Value {
    let mut compact = parameters.clone();
    strip_schema_descriptions(&mut compact);
    compact
}

fn strip_schema_descriptions(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("description");
            for child in map.values_mut() {
                strip_schema_descriptions(child);
            }
        }
        Value::Array(items) => {
            for child in items {
                strip_schema_descriptions(child);
            }
        }
        _ => {}
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
                "description": realtime_description(*kind),
                "parameters": compact_parameters(&meta.parameters),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Meta-tool handlers (async — talk to Executor's HTTP API)
// ---------------------------------------------------------------------------

/// Build the JS snippet that runs inside Executor's QuickJS sandbox to
/// call a tool by dot-path. The path and arguments come from the LLM, so
/// we JSON-serialize both into the source: the sandbox sees them as
/// values (string + object), never as parsed code — no code injection
/// is possible even if the model emits adversarial characters.
fn build_call_mcp_code(tool_path: &str, arguments: &Value) -> Result<String> {
    let path_json = serde_json::to_string(tool_path).context("encode tool_path")?;
    let args_json = serde_json::to_string(arguments).context("encode arguments")?;
    // The reduce step is the canonical idiom for "follow a dot-path on
    // an object". Deep-proxy supports arbitrary string keys, so
    // "github-mcp.list-issues" works the same way as "github.issues.list".
    Ok(format!(
        "const path = {path_json}; \
         const args = {args_json}; \
         const fn = path.split('.').reduce((o, k) => o[k], tools); \
         return await fn(args);"
    ))
}

/// Build the JS snippet that runs `tools.search(...)` inside the sandbox.
fn build_search_mcp_code(query: &str, namespace: Option<&str>, limit: u64) -> String {
    let mut search_args = serde_json::json!({ "query": query, "limit": limit });
    if let Some(ns) = namespace {
        search_args["namespace"] = serde_json::Value::String(ns.to_string());
    }
    format!("return await tools.search({});", search_args)
}

/// Build the JS snippet that asks Executor for a real tool's compact
/// argument schema.
fn build_describe_mcp_code(tool_path: &str) -> Result<String> {
    let path_json = serde_json::to_string(tool_path).context("encode tool_path")?;
    Ok(format!(
        "return await tools.describe.tool({{ path: {path_json} }});"
    ))
}

fn ok_envelope(data: Value) -> VoiceToolEnvelope {
    VoiceToolEnvelope {
        ok: true,
        data,
        error: None,
        invalidates: Vec::new(),
        navigate_to_workspace_id: None,
        dispatch_workspace_action: None,
        image: None,
    }
}

fn err_envelope(message: String) -> VoiceToolEnvelope {
    VoiceToolEnvelope {
        ok: false,
        data: Value::Null,
        error: Some(message),
        invalidates: Vec::new(),
        navigate_to_workspace_id: None,
        dispatch_workspace_action: None,
        image: None,
    }
}

async fn run_search_mcp_tools(app: &tauri::AppHandle, args: Value) -> VoiceToolEnvelope {
    let Some(query) = args.get("query").and_then(Value::as_str) else {
        return err_envelope("search_mcp_tools requires `query` (string)".into());
    };
    let namespace = args
        .get("namespace")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .clamp(1, 12);

    let Some(client) = app.state::<ManagedExecutor>().client() else {
        return err_envelope("Executor is not running. Try Settings → MCP → Restart.".into());
    };
    let code = build_search_mcp_code(query, namespace, limit);
    match client.execute(&code).await {
        Ok(value) => ok_envelope(value),
        Err(e) => err_envelope(format!("{e:#}")),
    }
}

async fn run_describe_mcp_tool(app: &tauri::AppHandle, args: Value) -> VoiceToolEnvelope {
    let Some(tool_path) = args.get("tool_path").and_then(Value::as_str) else {
        return err_envelope("describe_mcp_tool requires `tool_path` (string)".into());
    };

    let helmor_fallback = local_helmor_tool_description(tool_path);
    let Some(client) = app.state::<ManagedExecutor>().client() else {
        return match helmor_fallback {
            Some(value) => ok_envelope(compact_describe_mcp_result(serde_json::json!({
                "isError": false,
                "status": "completed",
                "structured": { "result": value, "status": "completed" },
                "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
            }))),
            None => err_envelope("Executor is not running. Try Settings → MCP → Restart.".into()),
        };
    };
    let code = match build_describe_mcp_code(tool_path) {
        Ok(c) => c,
        Err(e) => return err_envelope(format!("encode describe_mcp_tool code: {e:#}")),
    };
    match client.execute(&code).await {
        Ok(value) => {
            if describe_result_has_schema(&value) {
                ok_envelope(compact_describe_mcp_result(value))
            } else if let Some(fallback) = helmor_fallback {
                ok_envelope(compact_describe_mcp_result(merge_describe_fallback(
                    value, fallback,
                )))
            } else {
                ok_envelope(value)
            }
        }
        Err(e) => err_envelope(format!("{e:#}")),
    }
}

async fn run_call_mcp_tool(app: &tauri::AppHandle, args: Value) -> VoiceToolEnvelope {
    let Some(tool_path) = args.get("tool_path").and_then(Value::as_str) else {
        return err_envelope("call_mcp_tool requires `tool_path` (string)".into());
    };
    let arguments = match call_mcp_arguments_arg(&args) {
        Ok(arguments) => arguments,
        Err(message) => return err_envelope(message),
    };
    if let Some(message) = external_empty_arguments_message(tool_path, arguments) {
        return ok_envelope(mcp_tool_argument_error_payload(message));
    }
    if let Some(message) = local_helmor_missing_required_args(tool_path, arguments) {
        return ok_envelope(mcp_tool_argument_error_payload(message));
    }

    let Some(client) = app.state::<ManagedExecutor>().client() else {
        return err_envelope("Executor is not running. Try Settings → MCP → Restart.".into());
    };
    let code = match build_call_mcp_code(tool_path, arguments) {
        Ok(c) => c,
        Err(e) => return err_envelope(format!("encode call_mcp_tool code: {e:#}")),
    };
    match client.execute(&code).await {
        Ok(value) => ok_envelope(value),
        Err(e) => err_envelope(format!("{e:#}")),
    }
}

fn call_mcp_arguments_arg(args: &Value) -> std::result::Result<&Value, String> {
    let Some(arguments) = args.get("arguments") else {
        return Err(
            "call_mcp_tool requires `arguments` (object). Call describe_mcp_tool for the tool_path, read inputTypeScript, then retry with matching arguments."
                .to_string(),
        );
    };
    if !arguments.is_object() {
        return Err(format!(
            "call_mcp_tool `arguments` must be an object, got {}",
            arguments
        ));
    }
    Ok(arguments)
}

fn external_empty_arguments_message(tool_path: &str, arguments: &Value) -> Option<String> {
    if local_helmor_tool_name(tool_path).is_some() {
        return None;
    }
    let is_empty = arguments.as_object().is_some_and(serde_json::Map::is_empty);
    if !is_empty {
        return None;
    }
    Some(format!(
        "External tool `{tool_path}` was called with empty arguments. search_mcp_tools only returns candidate paths, not input parameters. Call describe_mcp_tool with this tool_path, read inputTypeScript, then retry call_mcp_tool with matching arguments."
    ))
}

fn mcp_tool_argument_error_payload(message: String) -> Value {
    serde_json::json!({
        "isError": true,
        "status": "completed",
        "structured": {
            "result": {
                "content": [{ "type": "text", "text": message }],
                "isError": true
            },
            "status": "completed"
        },
        "text": message
    })
}

fn local_helmor_tool_name(tool_path: &str) -> Option<&str> {
    tool_path.strip_prefix("helmor.")
}

fn local_helmor_tool_description(tool_path: &str) -> Option<Value> {
    let tool_name = local_helmor_tool_name(tool_path)?;
    crate::mcp::tool_catalog()
        .into_iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some(tool_name))
        .map(|tool| {
            let input_schema = tool.get("inputSchema").cloned().unwrap_or_else(
                || serde_json::json!({ "type": "object", "properties": {}, "required": [] }),
            );
            serde_json::json!({
                "path": tool_path,
                "name": tool_name,
                "description": tool.get("description").cloned().unwrap_or(Value::Null),
                "inputSchema": input_schema,
            })
        })
}

fn describe_result_has_schema(value: &Value) -> bool {
    value
        .pointer("/structured/result/inputTypeScript")
        .is_some_and(|schema| schema.as_str().is_some_and(|text| !text.trim().is_empty()))
        || value.pointer("/structured/result/inputSchema").is_some()
        || value.pointer("/inputTypeScript").is_some()
        || value.pointer("/inputSchema").is_some()
}

fn compact_describe_mcp_result(mut value: Value) -> Value {
    let compact = if let Some(result) = value.pointer("/structured/result") {
        compact_describe_result_object(result)
    } else {
        compact_describe_result_object(&value)
    };

    if value.pointer("/structured/result").is_some() {
        value["structured"]["result"] = compact.clone();
        value["structured"]["status"] = Value::String("completed".to_string());
        value["structured"]["logs"] = value
            .pointer("/structured/logs")
            .cloned()
            .unwrap_or_else(|| json!([]));
        value["text"] = Value::String(
            serde_json::to_string_pretty(&compact).unwrap_or_else(|_| compact.to_string()),
        );
        value
    } else {
        json!({
            "isError": false,
            "status": "completed",
            "structured": {
                "logs": [],
                "result": compact,
                "status": "completed",
            },
            "text": serde_json::to_string_pretty(&compact).unwrap_or_else(|_| compact.to_string()),
        })
    }
}

fn compact_describe_result_object(result: &Value) -> Value {
    let path = result.get("path").and_then(Value::as_str);
    let name = result.get("name").and_then(Value::as_str);
    let description = result
        .get("description")
        .and_then(Value::as_str)
        .map(|text| truncate_chars(text.trim(), 600))
        .filter(|text| !text.is_empty());
    let params = describe_parameter_list(result);
    let mut compact = serde_json::Map::new();

    if let Some(path) = path {
        compact.insert("path".to_string(), Value::String(path.to_string()));
    }
    if let Some(name) = name {
        compact.insert("name".to_string(), Value::String(name.to_string()));
    }
    if let Some(description) = description {
        compact.insert("description".to_string(), Value::String(description));
    }
    compact.insert(
        "input".to_string(),
        json!({
            "parameters": params,
        }),
    );
    if let Some(input_type_script) = result.get("inputTypeScript").and_then(Value::as_str) {
        compact.insert(
            "inputTypeScript".to_string(),
            Value::String(truncate_chars(
                compact_input_type_script(input_type_script).trim(),
                1200,
            )),
        );
    }
    Value::Object(compact)
}

fn describe_parameter_list(result: &Value) -> Vec<Value> {
    if let Some(input_schema) = result.get("inputSchema") {
        let schema_params = parameters_from_input_schema(input_schema);
        if !schema_params.is_empty() {
            return schema_params;
        }
    }
    result
        .get("inputTypeScript")
        .and_then(Value::as_str)
        .map(parameters_from_input_type_script)
        .unwrap_or_default()
}

fn parameters_from_input_schema(input_schema: &Value) -> Vec<Value> {
    let Some(properties) = input_schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    let required = input_schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();

    properties
        .iter()
        .map(|(name, schema)| {
            let type_name = schema_type_name(schema);
            let description = schema
                .get("description")
                .and_then(Value::as_str)
                .map(|text| truncate_chars(text.trim(), 240))
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| {
                    if required.contains(name.as_str()) {
                        "Required parameter.".to_string()
                    } else {
                        "Optional parameter.".to_string()
                    }
                });
            json!({
                "name": name,
                "required": required.contains(name.as_str()),
                "type": type_name,
                "description": description,
            })
        })
        .collect()
}

fn schema_type_name(schema: &Value) -> String {
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        let rendered = values
            .iter()
            .filter_map(|value| match value {
                Value::String(text) => Some(format!("{text:?}")),
                Value::Number(number) => Some(number.to_string()),
                Value::Bool(value) => Some(value.to_string()),
                _ => None,
            })
            .take(8)
            .collect::<Vec<_>>();
        if !rendered.is_empty() {
            return rendered.join(" | ");
        }
    }
    match schema.get("type") {
        Some(Value::String(text)) => text.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" | "),
        _ => "unknown".to_string(),
    }
}

fn compact_input_type_script(input_type_script: &str) -> String {
    parameters_from_input_type_script(input_type_script)
        .into_iter()
        .filter_map(|param| {
            let name = param.get("name")?.as_str()?;
            let optional = if param
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                ""
            } else {
                "?"
            };
            let type_name = param.get("type")?.as_str()?;
            Some(format!("{name}{optional}: {type_name}"))
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn parameters_from_input_type_script(input_type_script: &str) -> Vec<Value> {
    let shape = input_type_script.trim();
    let body = shape
        .strip_prefix('{')
        .and_then(|text| text.strip_suffix('}'))
        .unwrap_or(shape)
        .trim();

    split_top_level_fields(body)
        .into_iter()
        .filter_map(|field| {
            let (name_part, type_part) = split_top_level_once(field, ':')?;
            let name_part = name_part.trim().trim_matches('"').trim_matches('\'');
            if name_part.is_empty() {
                return None;
            }
            let (name, required) = if let Some(name) = name_part.strip_suffix('?') {
                (name.trim(), false)
            } else {
                (name_part, true)
            };
            let type_name = truncate_chars(type_part.trim(), 240);
            Some(json!({
                "name": name,
                "required": required,
                "type": type_name,
                "description": if required { "Required parameter." } else { "Optional parameter." },
            }))
        })
        .collect()
}

fn split_top_level_fields(input: &str) -> Vec<&str> {
    split_top_level(input, ';')
        .into_iter()
        .flat_map(|field| split_top_level(field, ','))
        .map(str::trim)
        .filter(|field| !field.is_empty())
        .collect()
}

fn split_top_level(input: &str, separator: char) -> Vec<&str> {
    let mut fields = Vec::new();
    let mut start = 0;
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for (idx, ch) in input.char_indices() {
        if let Some(quote_ch) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote_ch {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' | '`' => quote = Some(ch),
            '{' | '(' | '[' => depth += 1,
            '}' | ')' | ']' => depth -= 1,
            _ if ch == separator && depth == 0 => {
                fields.push(&input[start..idx]);
                start = idx + ch.len_utf8();
            }
            _ => {}
        }
    }
    fields.push(&input[start..]);
    fields
}

fn split_top_level_once(input: &str, separator: char) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for (idx, ch) in input.char_indices() {
        if let Some(quote_ch) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote_ch {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' | '`' => quote = Some(ch),
            '{' | '(' | '[' => depth += 1,
            '}' | ')' | ']' => depth -= 1,
            _ if ch == separator && depth == 0 => {
                return Some((&input[..idx], &input[idx + ch.len_utf8()..]));
            }
            _ => {}
        }
    }
    None
}

fn merge_describe_fallback(mut value: Value, fallback: Value) -> Value {
    if let Some(result) = value
        .pointer_mut("/structured/result")
        .and_then(Value::as_object_mut)
    {
        if let Some(description) = fallback.get("description") {
            result
                .entry("description".to_string())
                .or_insert_with(|| description.clone());
        }
        if let Some(input_schema) = fallback.get("inputSchema") {
            result.insert("inputSchema".to_string(), input_schema.clone());
        }
    } else {
        value["structured"] = serde_json::json!({
            "logs": [],
            "result": fallback,
            "status": "completed"
        });
    }
    let text = serde_json::to_string_pretty(&value["structured"]["result"])
        .unwrap_or_else(|_| value["structured"]["result"].to_string());
    value["text"] = Value::String(text);
    value
}

fn local_helmor_missing_required_args(tool_path: &str, arguments: &Value) -> Option<String> {
    let description = local_helmor_tool_description(tool_path)?;
    let required = description
        .pointer("/inputSchema/required")
        .and_then(Value::as_array)?;
    let args = arguments.as_object()?;
    let missing: Vec<&str> = required
        .iter()
        .filter_map(Value::as_str)
        .filter(|name| !args.contains_key(*name))
        .collect();
    if missing.is_empty() {
        return None;
    }
    Some(format!(
        "{} requires arguments: {}",
        tool_path,
        missing.join(", ")
    ))
}

async fn run_approve_mcp_call(app: &tauri::AppHandle, args: Value) -> VoiceToolEnvelope {
    let Some(execution_id) = args.get("execution_id").and_then(Value::as_str) else {
        return err_envelope("approve_mcp_call requires `execution_id` (string)".into());
    };
    let Some(action_raw) = args.get("action").and_then(Value::as_str) else {
        return err_envelope(
            "approve_mcp_call requires `action` ('accept'|'decline'|'cancel')".into(),
        );
    };
    let Some(action) = ResumeAction::parse(action_raw) else {
        return err_envelope(format!(
            "approve_mcp_call `action` must be accept|decline|cancel, got '{action_raw}'"
        ));
    };
    let content = args.get("content");

    let Some(client) = app.state::<ManagedExecutor>().client() else {
        return err_envelope("Executor is not running. Try Settings → MCP → Restart.".into());
    };
    match client.resume(execution_id, action, content).await {
        Ok(value) => ok_envelope(value),
        Err(e) => err_envelope(format!("{e:#}")),
    }
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn run_voice_tool(
    app: tauri::AppHandle,
    scripts_manager: tauri::State<'_, ScriptProcessManager>,
    tool: String,
    args: Value,
) -> CmdResult<VoiceToolEnvelope> {
    let invocation_start = std::time::Instant::now();
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
            dispatch_workspace_action: None,
            image: None,
        });
    };

    // Meta tools dispatch on the async path — they await ExecutorClient
    // HTTP calls directly. The sync `run_blocking` branch below is the
    // legacy path for typed handlers, which is currently dormant (all 23
    // typed variants are absent from `ToolKind::ALL`).
    let envelope_opt = match kind {
        ToolKind::SearchMcpTools => Some(run_search_mcp_tools(&app, args.clone()).await),
        ToolKind::DescribeMcpTool => Some(run_describe_mcp_tool(&app, args.clone()).await),
        ToolKind::CallMcpTool => Some(run_call_mcp_tool(&app, args.clone()).await),
        ToolKind::ApproveMcpCall => Some(run_approve_mcp_call(&app, args.clone()).await),
        _ => None,
    };
    if let Some(envelope) = envelope_opt {
        // Show what the model will actually see as the function_call_output.
        // Truncated so big tool results (e.g. GitHub list_issues) don't
        // flood the log; 1000 chars is enough to read the key fields.
        let data_preview = match serde_json::to_string(&envelope.data) {
            Ok(s) if s.len() > 1000 => format!("{}… ({} bytes total)", &s[..1000], s.len()),
            Ok(s) => s,
            Err(_) => "<unserializable>".to_string(),
        };
        tracing::info!(
            tool = kind.metadata().name,
            elapsed_ms = invocation_start.elapsed().as_millis() as u64,
            ok = envelope.ok,
            error = ?envelope.error,
            data_preview = %data_preview,
            "voice agent meta-tool completed"
        );
        return Ok(envelope);
    }

    let invalidates = kind.metadata().invalidates.to_vec();
    // Snapshot `scripts_manager` out of the borrowed `State` so the
    // blocking closure below owns its data and the `'_` lifetime
    // doesn't leak across the `spawn_blocking` boundary.
    // `ScriptProcessManager` is `Clone` over an inner `Arc<Mutex<…>>`
    // so this is a cheap handle copy, not a deep clone of process state.
    let ctx = VoiceToolContext {
        app,
        scripts_manager: scripts_manager.inner().clone(),
    };
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
        match kind.run(args, &ctx) {
            Ok(result) => {
                // Image gets its own one-line summary. Logs the base64
                // length so operators can grep for "did we just blow
                // the dataChannel size ceiling?" — anything past ~200
                // KB is the danger zone. Doesn't dump the data URL
                // itself (kilobytes of opaque base64).
                let image_meta = result.image.as_ref().map(|img| {
                    format!(
                        "{}x{} ({}B data_url)",
                        img.width,
                        img.height,
                        img.data_url.len()
                    )
                });
                tracing::info!(
                    tool = name,
                    elapsed_ms = invocation_start.elapsed().as_millis() as u64,
                    navigate = ?result.navigate_to_workspace_id,
                    dispatch = ?result.dispatch_workspace_action,
                    image = ?image_meta,
                    "voice agent in-process tool completed"
                );
                Ok(VoiceToolEnvelope {
                    ok: true,
                    data: result.data,
                    error: None,
                    invalidates,
                    navigate_to_workspace_id: result.navigate_to_workspace_id,
                    dispatch_workspace_action: result.dispatch_workspace_action,
                    image: result.image,
                })
            }
            Err(err) => {
                let message = format!("{err:#}");
                tracing::warn!(
                    tool = name,
                    elapsed_ms = invocation_start.elapsed().as_millis() as u64,
                    %message,
                    "voice agent in-process tool failed"
                );
                Ok(VoiceToolEnvelope {
                    ok: false,
                    data: Value::Null,
                    error: Some(message),
                    invalidates: Vec::new(),
                    navigate_to_workspace_id: None,
                    dispatch_workspace_action: None,
                    image: None,
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
    /// on-demand `describe_local_tools` help surface — this test catches
    /// that at build time.
    #[test]
    fn every_tool_with_cli_path_resolves() {
        for kind in ToolKind::ALL {
            let meta = kind.metadata();
            let Some(path) = meta.cli_path else { continue };
            let rendered = subcommand_help(path);
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
        // The frontend's `ToolName` union in `tool-dispatcher.ts` MUST
        // mirror this set exactly — any drift will be caught here.
        let mut names: Vec<&'static str> =
            ToolKind::ALL.iter().map(|k| k.metadata().name).collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "approve_mcp_call",
                "archive_workspace",
                "call_mcp_tool",
                "capture_screen",
                "create_workspace",
                "create_workspace_and_send",
                "create_workspace_variants",
                "describe_local_tools",
                "describe_mcp_tool",
                "end_session",
                "get_session_messages",
                "list_repos",
                "list_sessions",
                "list_workspaces",
                "permanently_delete_workspace",
                "run_workspace_action",
                "run_workspace_script",
                "search_mcp_tools",
                "search_sessions",
                "select_workspace",
                "send_prompt",
                "set_workspace_status",
                "show_workspace",
                "stop_session",
                "wait_for_user",
            ]
        );
    }

    #[test]
    fn call_mcp_tool_schema_requires_arguments() {
        let metadata = ToolKind::CallMcpTool.metadata();
        let required = metadata
            .parameters
            .get("required")
            .and_then(Value::as_array)
            .expect("call_mcp_tool has required array")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert!(required.contains(&"tool_path"));
        assert!(required.contains(&"arguments"));
    }

    #[test]
    fn call_mcp_tool_rejects_missing_arguments_before_executor() {
        let err = call_mcp_arguments_arg(&json!({
            "tool_path": "github_v3_rest_api.search.issuesAndPullRequests"
        }))
        .unwrap_err();
        assert!(err.contains("requires `arguments`"));
        assert!(err.contains("describe_mcp_tool"));
    }

    #[test]
    fn external_empty_arguments_points_model_to_describe() {
        let message = external_empty_arguments_message(
            "github_v3_rest_api.search.issuesAndPullRequests",
            &json!({}),
        )
        .expect("external empty args should be blocked");
        assert!(message.contains("empty arguments"));
        assert!(message.contains("describe_mcp_tool"));
        assert!(message.contains("inputTypeScript"));
    }

    #[test]
    fn local_helmor_empty_arguments_are_not_blocked_by_external_guard() {
        assert!(external_empty_arguments_message("helmor.helmor_data_info", &json!({})).is_none());
    }

    #[test]
    fn compact_describe_mcp_result_strips_type_definitions_and_summarizes_params() {
        let raw = json!({
            "isError": false,
            "status": "completed",
            "structured": {
                "logs": [],
                "status": "completed",
                "result": {
                    "path": "github_v3_rest_api.search.issuesAndPullRequests",
                    "name": "search.issuesAndPullRequests",
                    "description": "Searches issues and pull requests across GitHub repositories.",
                    "inputTypeScript": "{ q: string; sort?: \"comments\" | \"created\" | \"updated\"; per_page?: number; page?: number }",
                    "outputTypeScript": "{ total_count: number; items: issue[] }",
                    "typeScriptDefinitions": {
                        "issue": "x".repeat(80_000)
                    }
                }
            },
            "text": "large raw output"
        });

        let compact = compact_describe_mcp_result(raw);
        let serialized = serde_json::to_string(&compact).unwrap();
        assert!(!serialized.contains("typeScriptDefinitions"));
        assert!(!serialized.contains("outputTypeScript"));
        assert!(serialized.len() < 3_000, "{serialized}");

        let params = compact
            .pointer("/structured/result/input/parameters")
            .and_then(Value::as_array)
            .expect("compact parameters");
        assert_eq!(params[0]["name"], "q");
        assert_eq!(params[0]["required"], true);
        assert_eq!(params[0]["type"], "string");
        assert_eq!(params[1]["name"], "sort");
        assert_eq!(params[1]["required"], false);
        assert_eq!(
            params[1]["type"],
            "\"comments\" | \"created\" | \"updated\""
        );
    }

    #[test]
    fn compact_describe_mcp_result_uses_input_schema_descriptions() {
        let raw = json!({
            "path": "helmor.select_workspace",
            "name": "select_workspace",
            "description": "Select a workspace.",
            "inputSchema": {
                "type": "object",
                "required": ["workspace_id"],
                "properties": {
                    "workspace_id": {
                        "type": "string",
                        "description": "Workspace id to select."
                    },
                    "open": {
                        "type": "boolean",
                        "description": "Open the workspace after selecting."
                    }
                }
            }
        });

        let compact = compact_describe_mcp_result(raw);
        let params = compact
            .pointer("/structured/result/input/parameters")
            .and_then(Value::as_array)
            .expect("compact parameters");
        assert_eq!(params[0]["name"], "open");
        assert_eq!(params[0]["required"], false);
        assert_eq!(
            params[0]["description"],
            "Open the workspace after selecting."
        );
        assert_eq!(params[1]["name"], "workspace_id");
        assert_eq!(params[1]["required"], true);
        assert_eq!(params[1]["description"], "Workspace id to select.");
    }

    /// `tool_path` from the model can contain arbitrary characters.
    /// Verify the code generator JSON-encodes the path so the sandbox
    /// only sees a string literal — never code.
    #[test]
    fn call_mcp_code_template_is_injection_safe() {
        let hostile_path = "github'); throw new Error('pwned"; // contains ', ), ;
        let hostile_args = json!({"key": "value with \"quote\" and ');"});
        let code = build_call_mcp_code(hostile_path, &hostile_args).unwrap();
        // Path is wrapped in JSON-encoded string literal — the raw
        // single quote / paren / semicolon become escape sequences
        // inside the literal, never break out of it.
        assert!(
            code.contains("const path = \"github'); throw new Error('pwned\""),
            "path must be JSON-encoded as a string literal: {code}"
        );
        // The hostile sequence does NOT appear at top level (not split
        // outside the string literal) — we test by confirming there's
        // exactly one occurrence of the substring and that it's after
        // the `const path = ` JSON token.
        let throw_idx = code
            .find("throw new Error")
            .expect("substring present once");
        let path_marker = code.find("const path = ").unwrap();
        assert!(
            throw_idx > path_marker,
            "throw occurs inside the JSON string literal, not as standalone code"
        );
        // args object should be JSON-encoded as well
        assert!(
            code.contains("\"key\""),
            "args must be JSON-encoded: {code}"
        );
    }

    #[test]
    fn call_mcp_code_template_basic_shape() {
        let code = build_call_mcp_code("github.issues.list", &json!({"owner": "vercel"})).unwrap();
        assert!(code.contains("\"github.issues.list\""));
        assert!(code.contains("\"owner\":\"vercel\""));
        assert!(code.contains(".reduce((o, k) => o[k], tools)"));
        assert!(code.contains("return await fn(args);"));
    }

    #[test]
    fn search_mcp_code_template_with_namespace() {
        let code = build_search_mcp_code("list issues", Some("github"), 5);
        assert!(code.contains("\"query\":\"list issues\""));
        assert!(code.contains("\"namespace\":\"github\""));
        assert!(code.contains("\"limit\":5"));
    }

    #[test]
    fn search_mcp_code_template_no_namespace() {
        let code = build_search_mcp_code("workspaces", None, 12);
        assert!(code.contains("\"query\":\"workspaces\""));
        assert!(!code.contains("\"namespace\""));
        assert!(code.contains("\"limit\":12"));
    }
}
