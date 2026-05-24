//! Tool catalog the planner exposes to GPT-5-mini.
//!
//! `say` + `final` are built into `run_turn`. This module owns the
//! Helmor "real-work" tools — a filtered subset of
//! `commands::voice_agent::ToolKind::ALL`. The few exclusions are
//! tools whose semantics only make sense on the Reception (rt) side:
//!
//!   * `wait_for_user` — pure rt VAD signal; Worker has nothing to do.
//!   * `ask_planner`   — Reception's delegate hook; Worker IS the planner.
//!   * `describe_local_tools` — meta-help for Reception's tool catalog.
//!
//! `end_session` and `capture_screen` USED to be Reception-only but
//! were moved here in Phase 2.1: Reception is now strictly a relay,
//! so any decision-making (including "should we end?" and "should we
//! look at the screen?") lives in the Worker. They have special-case
//! plumbing in `run_turn` to surface their side effects as
//! `PlannerEvent::EndSession` / `PlannerEvent::CaptureImage` so the
//! frontend dispatcher can drive the actual WebRTC / image side-channel.

use std::future::Future;
use std::pin::Pin;

use serde_json::{json, Value};

use crate::commands::voice_agent::{dispatch_tool_kind, ToolKind, VoiceToolEnvelope};
use crate::voice_planner::openai::ToolDecl;
use crate::workspace::scripts::ScriptProcessManager;

/// Strategy object the planner agent loop uses to execute a Helmor
/// tool call. Abstracted so the production code (Tauri + AppHandle)
/// and the standalone `planner_probe` binary (no Tauri runtime) can
/// share `run_turn` without dragging the full Tauri Wry runtime into
/// the probe build.
pub trait PlannerTools: Send + Sync {
    fn dispatch(
        &self,
        kind: ToolKind,
        args: Value,
    ) -> Pin<Box<dyn Future<Output = VoiceToolEnvelope> + Send + '_>>;
}

/// Production dispatcher — wraps an `AppHandle` + `ScriptProcessManager`
/// and forwards through `voice_agent::dispatch_tool_kind`.
pub struct TauriPlannerTools {
    pub app: tauri::AppHandle,
    pub scripts_manager: ScriptProcessManager,
}

impl PlannerTools for TauriPlannerTools {
    fn dispatch(
        &self,
        kind: ToolKind,
        args: Value,
    ) -> Pin<Box<dyn Future<Output = VoiceToolEnvelope> + Send + '_>> {
        let app = self.app.clone();
        let scripts_manager = self.scripts_manager.clone();
        Box::pin(async move { dispatch_tool_kind(app, scripts_manager, kind, args).await })
    }
}

/// Probe / test dispatcher — always returns an error envelope so the
/// planner sees "tool unavailable" and falls back to `final`. Useful
/// for verifying the system prompt without a live Tauri app.
pub struct StubPlannerTools;

impl PlannerTools for StubPlannerTools {
    fn dispatch(
        &self,
        _kind: ToolKind,
        _args: Value,
    ) -> Pin<Box<dyn Future<Output = VoiceToolEnvelope> + Send + '_>> {
        // Domain-shaped error message so the probe exercises the same
        // failure path the real dispatcher would produce. The earlier
        // "tool execution not available" message leaked the word "tool"
        // into the model's recovery final — the prompt's forbidden
        // vocabulary tells the planner never to read that aloud, but
        // the model still parroted the literal error text.
        Box::pin(async move {
            VoiceToolEnvelope {
                ok: false,
                data: Value::Null,
                error: Some(
                    "Helmor data is offline right now — try again in a moment.".to_string(),
                ),
                invalidates: Vec::new(),
                navigate_to_workspace_id: None,
                dispatch_workspace_action: None,
                image: None,
            }
        })
    }
}

/// Whether `kind` is something a text-only planner can usefully invoke.
/// Returns `false` for rt-only tools. The filtering is centralised so
/// adding a new `ToolKind` variant requires a single decision here:
/// "is this for rt or for planner?".
pub(super) fn is_planner_tool(kind: ToolKind) -> bool {
    !matches!(
        kind,
        ToolKind::WaitForUser | ToolKind::AskPlanner | ToolKind::DescribeLocalTools
    )
}

/// All `ToolKind` variants the planner is allowed to call. Phase 1
/// shipped with this empty; Phase 2 turns it on.
pub(super) fn planner_tool_kinds() -> Vec<ToolKind> {
    ToolKind::ALL
        .iter()
        .copied()
        .filter(|k| is_planner_tool(*k))
        .collect()
}

/// Build the OpenAI Responses API `tools` array for the planner.
/// Includes the built-in `say` + `final` (which `run_turn` declares
/// separately is NOT done here — caller composes the two lists). This
/// only emits Helmor tool declarations.
pub(super) fn planner_helmor_tool_decls() -> Vec<ToolDecl> {
    planner_tool_kinds()
        .into_iter()
        .map(|kind| {
            let meta = kind.metadata();
            ToolDecl {
                kind: "function",
                name: meta.name,
                description: planner_description(kind),
                parameters: compact_planner_parameters(meta.parameters),
            }
        })
        .collect()
}

/// Per-tool short description aimed at the planner. Reuses the same
/// realtime-style summaries the rt voice agent had — they're already
/// tuned for "concise voice-context" wording, which is the right
/// register for the planner too.
fn planner_description(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::SearchMcpTools => {
            "Find tools (GitHub / Linear / Sentry / any MCP source) by intent. Returns ranked paths + descriptions. Call BEFORE call_mcp_tool when the user mentions external systems."
        }
        ToolKind::DescribeMcpTool => {
            "Get the input schema for a searched MCP tool path before calling it. Use after a search_mcp_tools result, or after a call_mcp_tool missing-parameter error."
        }
        ToolKind::CallMcpTool => {
            "Invoke an MCP tool by dot-path (from search_mcp_tools) with JSON arguments. May return status='paused' when user approval is needed."
        }
        ToolKind::ApproveMcpCall => {
            "Resume a paused MCP execution with action=accept|decline|cancel after the user has explicitly confirmed in conversation."
        }
        ToolKind::ListWorkspaces => {
            "List workspaces; optional status / repo / archive / session-status filters."
        }
        ToolKind::ShowWorkspace => "Show one workspace's status and details.",
        ToolKind::CreateWorkspace => "Create an empty workspace in a repo.",
        ToolKind::CreateWorkspaceAndSend => {
            "Create a workspace in one repo and send the user's request to its agent in one step."
        }
        ToolKind::CreateWorkspaceVariants => {
            "Create multiple same-repo workspaces, one explicit prompt per variant — useful for parallel approaches."
        }
        ToolKind::SetWorkspaceStatus => {
            "Set workspace kanban status (in-progress / done / review / backlog / canceled). Confirm before `canceled`."
        }
        ToolKind::ArchiveWorkspace => "Archive a workspace; reversible, no confirmation.",
        ToolKind::PermanentlyDeleteWorkspace => {
            "Permanently delete a workspace. NOT REVERSIBLE — requires explicit user confirmation in this turn."
        }
        ToolKind::RunWorkspaceAction => {
            "Run a ship action: commit_and_push, create_pr, merge_pr, pull_latest, fix_errors, resolve_conflicts."
        }
        ToolKind::RunWorkspaceScript => "Run a workspace setup or run script.",
        ToolKind::ListSessions => "List sessions for a workspace, newest first.",
        ToolKind::SearchSessions => "Search session titles and chat history by keyword.",
        ToolKind::GetSessionMessages => {
            "Fetch a window of messages from a session — useful for summarising what happened."
        }
        ToolKind::StopSession => "Stop / cancel a running agent session.",
        ToolKind::SendPrompt => {
            "Send a prompt to a workspace agent; optionally attach screenshots."
        }
        ToolKind::ListRepos => "List registered repos; use before repo-dependent actions if unsure.",
        ToolKind::SelectWorkspace => "Switch Helmor UI to a workspace without modifying data.",
        ToolKind::EndSession => "End the voice conversation. Use AFTER speaking a short goodbye via `final` when the user said bye / 拜拜 / 算了.",
        ToolKind::CaptureScreen => "Capture the focused window (default) or full screen. The image is forwarded to the voice channel so Reception can reference it on the next turn; you receive a brief text description in the tool output.",
        // Reception-only; exhaustive match protects against silently
        // dropping a future variant. These should never reach Worker.
        ToolKind::WaitForUser | ToolKind::AskPlanner | ToolKind::DescribeLocalTools => {
            "Reception-only tool — should never reach Worker"
        }
    }
}

/// Drop deep `description` strings from the JSON Schema before sending
/// to OpenAI. The planner gets the tool's purpose from the top-level
/// `description` field; per-param prose just inflates the request
/// without helping the model pick arguments. Same compaction rt uses.
fn compact_planner_parameters(parameters: Value) -> Value {
    let mut compact = parameters;
    strip_descriptions(&mut compact);
    compact
}

fn strip_descriptions(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("description");
            for child in map.values_mut() {
                strip_descriptions(child);
            }
        }
        Value::Array(items) => {
            for child in items {
                strip_descriptions(child);
            }
        }
        _ => {}
    }
}

/// Built-in say/final/show_status tool decls — always emitted, regardless
/// of the Helmor tool subset. Kept here so the planner's full tool
/// array is assembled in one place.
pub(super) fn builtin_say_final_decls() -> Vec<ToolDecl> {
    vec![
        ToolDecl {
            kind: "function",
            name: "say",
            description: "Emit one short interim spoken update. OPTIONAL, used 0-1 times per turn. NEVER the final answer. Follow cadence rules in the system prompt.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" }
                },
                "required": ["text"]
            }),
        },
        ToolDecl {
            kind: "function",
            name: "final",
            description: "Emit your final answer for this turn. MANDATORY: every turn ends with exactly one final, called LAST.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" }
                },
                "required": ["text"]
            }),
        },
        ToolDecl {
            kind: "function",
            name: "show_status",
            description: "Update the user's voice-bar status text. Display-only — NEVER voiced. Use to narrate what you're currently doing during multi-step work (e.g. \"查 GitHub PR\", \"对比 3 个 workspace\"). Call freely; no cadence limit. Keep text short (a verb phrase, <= 12 chars in Chinese).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" }
                },
                "required": ["text"]
            }),
        },
    ]
}
