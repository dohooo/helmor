use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, Manager};
use uuid::Uuid;

use crate::error::CommandError;

pub mod action_kind;
mod builtin_claude_providers;
mod catalog;
pub(crate) mod claude_project_files;
mod custom_providers;
mod persistence;
mod queries;
mod slash_commands;
pub(crate) mod streaming;
mod support;

pub use self::action_kind::ActionKind;
pub use self::catalog::{resolve_model, AgentModelOption, AgentModelSection, ResolvedModel};
pub use self::queries::{
    fetch_agent_model_sections, fetch_live_context_usage, GenerateSessionTitleRequest,
    GenerateSessionTitleResponse, GetLiveContextUsageRequest, ListSlashCommandsRequest,
    SlashCommandEntry, SlashCommandsResponse,
};
pub use self::slash_commands::SlashCommandCache;
pub use self::streaming::{
    abort_all_active_streams_blocking, bridge_aborted_event, bridge_done_event, bridge_error_event,
    bridge_permission_request_event, bridge_user_input_request_event, build_send_message_params,
    lookup_workspace_linked_directories, ActiveStreamSummary, ActiveStreams,
    BuildSendMessageParamsInput,
};

use self::persistence::{
    finalize_session_metadata, persist_error_message, persist_exit_plan_message,
    persist_result_and_finalize, persist_turn_message, persist_user_message,
};
use self::streaming::stream_via_sidecar;
use self::support::resolve_working_directory;

#[cfg(test)]
use self::support::{non_empty, parse_claude_output, parse_codex_output};

type CmdResult<T> = std::result::Result<T, CommandError>;

pub fn prewarm_slash_command_cache(app: &AppHandle) {
    queries::prewarm_slash_command_cache(app);
}

/// Tauri command — called from the frontend on workspace switch.
/// Kicks off a background refresh for the target workspace so the next
/// `/` press in the composer hits a warm cache.
#[tauri::command]
pub async fn prewarm_slash_commands_for_workspace(
    app: AppHandle,
    workspace_id: String,
) -> CmdResult<()> {
    queries::prewarm_slash_command_cache_for_workspace(&app, &workspace_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Streaming event types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AgentStreamEvent {
    /// Full snapshot — sent on finalization events (assistant, user, result).
    /// The frontend replaces its entire message array.
    Update {
        messages: Vec<crate::pipeline::types::ThreadMessageLike>,
    },
    /// Only the streaming partial changed — sent on stream deltas.
    /// The frontend replaces only the trailing streaming message.
    /// IPC payload: ~one message instead of the entire conversation.
    StreamingPartial {
        message: crate::pipeline::types::ThreadMessageLike,
    },
    Done {
        provider: String,
        model_id: String,
        resolved_model: String,
        session_id: Option<String>,
        working_directory: String,
        persisted: bool,
    },
    /// User-initiated termination (stop button or app shutdown). The UI
    /// treats this as a non-error state. Persisted state includes the
    /// flushed turns and sets `sessions.status = 'aborted'`.
    Aborted {
        provider: String,
        model_id: String,
        resolved_model: String,
        session_id: Option<String>,
        working_directory: String,
        persisted: bool,
        reason: String,
    },
    PermissionRequest {
        #[serde(rename = "permissionId")]
        permission_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "toolInput")]
        tool_input: Value,
        title: Option<String>,
        description: Option<String>,
    },
    /// Unified "agent needs user input" event. Sources:
    /// - Claude AskUserQuestion (sidecar `canUseTool`)
    /// - Claude MCP elicitation (sidecar `onElicitation`)
    /// - Codex `requestUserInput`
    ///
    /// `payload.kind` discriminates how the frontend should render:
    /// `ask-user-question` keeps AUQ's native question/option/preview/
    /// notes UI; `form` is a JSON-Schema-driven form (used for both MCP
    /// form elicitations and Codex's synthesized form); `url` is a
    /// URL-launcher card. The Rust side just forwards the payload — all
    /// schema normalization happens in the sidecar.
    UserInputRequest {
        provider: String,
        model_id: String,
        resolved_model: String,
        session_id: Option<String>,
        working_directory: String,
        permission_mode: Option<String>,
        #[serde(rename = "userInputId")]
        user_input_id: String,
        source: String,
        message: String,
        payload: Value,
    },
    /// A plan was captured from ExitPlanMode. The plan content is already
    /// in the thread messages as a PlanReview card; this event just tells
    /// the frontend to show the Implement / Request Changes buttons.
    PlanCaptured {},
    Error {
        message: String,
        persisted: bool,
        /// True when the error is an unexpected internal failure (e.g. sidecar
        /// crash). The frontend should show a generic message instead of details.
        internal: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamStartResponse {
    pub stream_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendRequest {
    pub provider: String,
    pub model_id: String,
    pub prompt: String,
    /// Hidden preamble prepended to `prompt` before sending to the agent
    /// (e.g. the user's "general preferences"). Persisted user-prompt
    /// content keeps `prompt` only — the prefix never enters the DB or
    /// the chat bubble. Empty/absent ⇒ no prefix.
    #[serde(default)]
    pub prompt_prefix: Option<String>,
    pub session_id: Option<String>,
    pub helmor_session_id: Option<String>,
    pub working_directory: Option<String>,
    pub effort_level: Option<String>,
    pub permission_mode: Option<String>,
    pub fast_mode: Option<bool>,
    pub user_message_id: Option<String>,
    /// Workspace-relative paths from the @-mention picker.
    #[serde(default)]
    pub files: Option<Vec<String>>,
    /// Image attachment paths from the composer (drag-and-drop or
    /// paste). Travels structurally so paths with whitespace
    /// round-trip without regex re-extraction.
    #[serde(default)]
    pub images: Option<Vec<String>>,
}

#[cfg(test)]
use crate::pipeline::types::{AgentUsage, CollectedTurn, MessageRole};

/// Context shared across incremental persistence calls within a single exchange.
pub(crate) struct ExchangeContext {
    pub(crate) helmor_session_id: String,
    pub(crate) model_id: String,
    pub(crate) model_provider: String,
    pub(crate) user_message_id: String,
}

#[tauri::command]
pub async fn list_agent_model_sections() -> CmdResult<Vec<AgentModelSection>> {
    Ok(queries::fetch_agent_model_sections())
}

#[tauri::command]
pub async fn list_cursor_models(
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    api_key: Option<String>,
) -> CmdResult<Vec<queries::CursorModelEntry>> {
    // Inline blocking — same pattern as `list_slash_commands`.
    queries::fetch_cursor_models(sidecar.inner(), api_key)
}

#[tauri::command]
pub async fn send_agent_message_stream(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: AgentSendRequest,
    on_event: Channel<AgentStreamEvent>,
) -> CmdResult<()> {
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(anyhow::anyhow!("Prompt cannot be empty.").into());
    }

    let model = resolve_model(&request.model_id, Some(request.provider.as_str()));

    if request.provider != model.provider {
        return Err(anyhow::anyhow!(
            "Model {} does not belong to provider {}.",
            request.model_id,
            request.provider
        )
        .into());
    }

    let working_directory = resolve_stream_working_directory(&request)?;
    let stream_id = Uuid::new_v4().to_string();
    let active_streams = app.state::<ActiveStreams>();

    stream_via_sidecar(
        app.clone(),
        on_event,
        &sidecar,
        &active_streams,
        &stream_id,
        &model,
        &prompt,
        &request,
        &working_directory,
    )
}

fn resolve_stream_working_directory(
    request: &AgentSendRequest,
) -> anyhow::Result<std::path::PathBuf> {
    resolve_working_directory(request.working_directory.as_deref())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStopRequest {
    pub session_id: String,
    pub provider: Option<String>,
}

/// Snapshot of currently in-flight agent streams for the UI. Source of
/// truth is `ActiveStreams`; the UI re-fetches this whenever a
/// `UiMutationEvent::ActiveStreamsChanged` arrives. The frontend uses
/// it to drive the abort button visibility and per-session busy badges
/// — replacing the prior hook-local `sessionRunStates` that drifted on
/// container unmount/remount.
#[tauri::command]
pub async fn list_active_streams(
    active_streams: tauri::State<'_, ActiveStreams>,
) -> CmdResult<Vec<ActiveStreamSummary>> {
    Ok(active_streams.snapshot_for_ui())
}

#[tauri::command]
pub async fn stop_agent_stream(
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: AgentStopRequest,
) -> CmdResult<()> {
    let stop_req = crate::sidecar::SidecarRequest {
        id: Uuid::new_v4().to_string(),
        method: "stopSession".to_string(),
        params: serde_json::json!({
            "sessionId": request.session_id,
            "provider": request.provider.unwrap_or_else(|| "claude".to_string()),
        }),
    };
    sidecar
        .send(&stop_req)
        .map_err(|e| anyhow::anyhow!("Failed to stop session: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerRequest {
    pub session_id: String,
    pub provider: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub files: Option<Vec<String>>,
    #[serde(default)]
    pub images: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerResponse {
    pub accepted: bool,
    pub reason: Option<String>,
}

/// Inject a user message into an in-flight turn (real mid-turn steer).
/// Thin wrapper around the sidecar's `steerSession` RPC — the sidecar
/// routes to provider-native APIs (`streamInput` for Claude, `turn/steer`
/// for Codex) and emits a `user_prompt` passthrough event into the active
/// stream ONLY after the provider has confirmed acceptance. That event
/// flows through the same accumulator + `persist_turn_message` path as
/// any other user turn, so there's no separate persistence path and no
/// chance of a ghost steer from an emit-before-ack race.
///
/// Returns `{ accepted: false }` when the turn already completed or the
/// provider rejected the input — the frontend uses that to roll back the
/// optimistic bubble and restore the composer draft. Does NOT write to
/// the database: persistence is owned entirely by the streaming pipeline.
#[tauri::command]
pub async fn steer_agent_stream(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: AgentSteerRequest,
) -> CmdResult<AgentSteerResponse> {
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(anyhow::anyhow!("Steer prompt cannot be empty.").into());
    }

    let active_streams = app.state::<ActiveStreams>();
    let handle = active_streams
        .lookup_by_sidecar_session_id(&request.session_id)
        .ok_or_else(|| anyhow::anyhow!("No active stream for session {}", request.session_id))?;

    let provider = request
        .provider
        .clone()
        .unwrap_or_else(|| handle.provider.clone());
    let request_id = Uuid::new_v4().to_string();
    let files = request.files.clone().unwrap_or_default();
    let images = request.images.clone().unwrap_or_default();

    let steer_req = crate::sidecar::SidecarRequest {
        id: request_id.clone(),
        method: "steerSession".to_string(),
        params: serde_json::json!({
            "sessionId": request.session_id,
            "provider": provider,
            "prompt": prompt,
            "files": files,
            "images": images,
        }),
    };

    let rx = sidecar.subscribe(&request_id);
    if let Err(error) = sidecar.send(&steer_req) {
        sidecar.unsubscribe(&request_id);
        return Err(anyhow::anyhow!("Sidecar send failed: {error}").into());
    }

    let rid_for_worker = request_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(anyhow::anyhow!("Steer timed out waiting for sidecar"));
            }
            match rx.recv_timeout(remaining) {
                Ok(event) => {
                    if event.event_type() == "steered" {
                        let accepted = event
                            .raw
                            .get("accepted")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let reason = event
                            .raw
                            .get("reason")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        return Ok((accepted, reason));
                    }
                    if event.event_type() == "error" {
                        let msg = event
                            .raw
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("sidecar error")
                            .to_string();
                        return Err(anyhow::anyhow!(msg));
                    }
                    // Other event types on this request id are noise —
                    // keep waiting for the terminal `steered` response.
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err(anyhow::anyhow!("Steer timed out waiting for sidecar"));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(anyhow::anyhow!("Sidecar disconnected before responding"));
                }
            }
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("Steer worker join failed: {e}"))?;

    sidecar.unsubscribe(&rid_for_worker);
    let (accepted, reason) = outcome?;
    Ok(AgentSteerResponse { accepted, reason })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponseRequest {
    pub permission_id: String,
    pub behavior: String,
    pub updated_permissions: Option<Vec<Value>>,
    pub message: Option<String>,
}

#[tauri::command]
pub async fn respond_to_permission_request(
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: PermissionResponseRequest,
) -> CmdResult<()> {
    tracing::info!(permission_id = %request.permission_id, behavior = %request.behavior, "Permission response");
    let mut params = serde_json::json!({
        "permissionId": request.permission_id,
        "behavior": request.behavior,
    });
    if let Some(perms) = &request.updated_permissions {
        params["updatedPermissions"] = serde_json::json!(perms);
    }
    if let Some(msg) = &request.message {
        params["message"] = serde_json::json!(msg);
    }
    let req = crate::sidecar::SidecarRequest {
        id: Uuid::new_v4().to_string(),
        method: "permissionResponse".to_string(),
        params,
    };
    sidecar
        .send(&req)
        .map_err(|e| anyhow::anyhow!("Failed to send permission response: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputResponseRequest {
    pub user_input_id: String,
    /// One of `"submit"`, `"decline"`, `"cancel"` — keeps the wire
    /// shape provider-neutral; each sidecar manager translates it
    /// into the SDK-specific resolution (AUQ allow/deny, MCP
    /// elicitation accept/decline/cancel, Codex answer payload).
    pub action: String,
    pub content: Option<Value>,
}

#[tauri::command]
pub async fn respond_to_user_input(
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: UserInputResponseRequest,
) -> CmdResult<()> {
    tracing::info!(
        user_input_id = %request.user_input_id,
        action = %request.action,
        "User-input response"
    );
    let req = crate::sidecar::SidecarRequest {
        id: Uuid::new_v4().to_string(),
        method: "userInputResponse".to_string(),
        params: serde_json::json!({
            "userInputId": request.user_input_id,
            "action": request.action,
            "content": request.content,
        }),
    };
    sidecar
        .send(&req)
        .map_err(|e| anyhow::anyhow!("Failed to send user-input response: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn generate_session_title(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: GenerateSessionTitleRequest,
) -> CmdResult<GenerateSessionTitleResponse> {
    queries::generate_session_title(app, sidecar, request).await
}

#[tauri::command]
pub async fn list_slash_commands(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    cache: tauri::State<'_, SlashCommandCache>,
    request: ListSlashCommandsRequest,
) -> CmdResult<SlashCommandsResponse> {
    queries::list_slash_commands(app, sidecar, cache, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // parse_claude_output
    // -----------------------------------------------------------------------

    #[test]
    fn parse_claude_output_extracts_text_from_stream_deltas() {
        let stdout = r#"
            {"type":"stream_event","event":{"delta":{"text":"Hello "}}}
            {"type":"stream_event","event":{"delta":{"text":"world"}}}
            {"type":"result","result":"Hello world","session_id":"sess-123","usage":{"input_tokens":10,"output_tokens":5}}
        "#;

        let output = parse_claude_output(stdout, None, "opus");
        assert_eq!(output.assistant_text, "Hello world");
        assert_eq!(output.session_id.as_deref(), Some("sess-123"));
        assert_eq!(output.usage.input_tokens, Some(10));
        assert_eq!(output.usage.output_tokens, Some(5));
    }

    #[test]
    fn parse_claude_output_extracts_thinking() {
        let stdout = r#"
            {"type":"stream_event","event":{"delta":{"thinking":"Let me think..."}}}
            {"type":"stream_event","event":{"delta":{"text":"Answer"}}}
            {"type":"result","result":"Answer","usage":{}}
        "#;

        let output = parse_claude_output(stdout, None, "opus");
        assert_eq!(output.assistant_text, "Answer");
        assert_eq!(output.thinking_text.as_deref(), Some("Let me think..."));
    }

    #[test]
    fn parse_claude_output_uses_fallback_session_id() {
        let stdout = r#"
            {"type":"stream_event","event":{"delta":{"text":"Hi"}}}
            {"type":"result","result":"Hi","usage":{}}
        "#;

        let output = parse_claude_output(stdout, Some("fallback-id"), "opus");
        assert_eq!(output.session_id.as_deref(), Some("fallback-id"));
    }

    #[test]
    fn parse_claude_output_returns_empty_text_on_no_assistant_content() {
        let stdout = r#"{"type":"result","result":"","usage":{}}"#;
        let output = parse_claude_output(stdout, None, "opus");
        assert!(output.assistant_text.is_empty());
        assert!(output.thinking_text.is_none());
    }

    #[test]
    fn parse_claude_output_extracts_model_name() {
        let stdout = r#"
            {"type":"assistant","model":"claude-opus-4-20250514","message":{"content":[{"type":"text","text":"Hi"}]}}
            {"type":"result","result":"Hi","usage":{}}
        "#;

        let output = parse_claude_output(stdout, None, "opus");
        assert_eq!(output.resolved_model, "claude-opus-4-20250514");
    }

    // -----------------------------------------------------------------------
    // parse_codex_output
    // -----------------------------------------------------------------------

    #[test]
    fn parse_codex_output_extracts_agent_message() {
        let stdout = r#"
            {"type":"thread/started","thread":{"id":"thread-abc"}}
            {"type":"item/completed","itemId":"i1","item":{"type":"agentMessage","id":"i1","text":"Hello from Codex"}}
            {"type":"turn/completed","turn":{"id":"t1","status":"completed"},"usage":{"input_tokens":100,"output_tokens":20}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4");
        assert_eq!(output.assistant_text, "Hello from Codex");
        assert_eq!(output.session_id.as_deref(), Some("thread-abc"));
        assert_eq!(output.usage.input_tokens, Some(100));
        assert_eq!(output.usage.output_tokens, Some(20));
    }

    #[test]
    fn parse_codex_output_uses_thread_started_for_resume() {
        let stdout = r#"
            {"type":"thread/started","thread":{"id":"thread-xyz"}}
            {"type":"item/completed","itemId":"i1","item":{"type":"agentMessage","id":"i1","text":"Resumed"}}
            {"type":"turn/completed","turn":{"id":"t1","status":"completed"},"usage":{}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4");
        assert_eq!(output.session_id.as_deref(), Some("thread-xyz"));
    }

    #[test]
    fn parse_codex_output_returns_empty_text_on_no_agent_message() {
        let stdout = r#"{"type":"thread/started","thread":{"id":"t1"}}"#;
        let output = parse_codex_output(stdout, None, "gpt-5.4");
        assert!(output.assistant_text.is_empty());
        assert_eq!(output.session_id.as_deref(), Some("t1"));
    }

    #[test]
    fn parse_codex_output_joins_multiple_messages() {
        let stdout = r#"
            {"type":"item/completed","itemId":"i1","item":{"type":"agentMessage","id":"i1","text":"Part 1"}}
            {"type":"item/completed","itemId":"i2","item":{"type":"agentMessage","id":"i2","text":"Part 2"}}
            {"type":"turn/completed","turn":{"id":"t1","status":"completed"},"usage":{}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4");
        assert!(output.assistant_text.contains("Part 1"));
        assert!(output.assistant_text.contains("Part 2"));
    }

    // -----------------------------------------------------------------------
    // non_empty helper
    // -----------------------------------------------------------------------

    #[test]
    fn non_empty_filters_correctly() {
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some("")), None);
        assert_eq!(non_empty(Some("  ")), None);
        assert_eq!(non_empty(Some("hello")), Some("hello"));
    }

    // -----------------------------------------------------------------------
    // parse_codex_output — persistence (turns + result_json)
    // -----------------------------------------------------------------------

    #[test]
    fn parse_codex_output_collects_text_and_result() {
        let stdout = r#"
            {"type":"thread/started","thread":{"id":"t1"}}
            {"type":"item/completed","itemId":"i1","item":{"type":"agentMessage","id":"i1","text":"Hello"}}
            {"type":"item/completed","itemId":"i2","item":{"type":"commandExecution","id":"i2","command":"ls"}}
            {"type":"item/completed","itemId":"i3","item":{"type":"agentMessage","id":"i3","text":"Done"}}
            {"type":"turn/completed","turn":{"id":"t1","status":"completed"},"usage":{"input_tokens":50,"output_tokens":10}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4");
        // Assistant text should combine all agent_message texts
        assert!(output.assistant_text.contains("Hello"));
        assert!(output.assistant_text.contains("Done"));
        // result_json should be the turn/completed line
        assert!(output.result_json.is_some());
        assert!(output.result_json.unwrap().contains("turn/completed"));
        // Usage should be captured
        assert_eq!(output.usage.input_tokens, Some(50));
        assert_eq!(output.usage.output_tokens, Some(10));
    }

    // -----------------------------------------------------------------------
    // resolve_model — provider inference
    // -----------------------------------------------------------------------

    #[test]
    fn resolve_model_infers_provider() {
        let claude = resolve_model("default", None);
        assert_eq!(claude.provider, "claude");
        assert_eq!(claude.cli_model, "default");

        let codex = resolve_model("gpt-5.4", None);
        assert_eq!(codex.provider, "codex");

        let unknown_claude = resolve_model("sonnet[1m]", None);
        assert_eq!(unknown_claude.provider, "claude");
    }

    // -----------------------------------------------------------------------
    // Incremental persistence — integration tests with real DB
    // -----------------------------------------------------------------------

    fn setup_test_db(dir: &std::path::Path) -> std::path::PathBuf {
        let db_path = dir.join("helmor.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO repos (id, name) VALUES ('r1', 'test-repo')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state) VALUES ('w1', 'r1', 'test', 'ready')",
            [],
        ).unwrap();
        drop(conn);
        crate::models::db::init_pools().expect("failed to init test DB pools");
        db_path
    }

    #[test]
    fn incremental_persist_writes_effort_and_permission_mode() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::data_dir::TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", dir.path());

        let db_path = setup_test_db(dir.path());
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title) VALUES ('s1', 'w1', 'idle', 'Test')",
            [],
        ).unwrap();

        let ctx = ExchangeContext {
            helmor_session_id: "s1".to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            user_message_id: Uuid::new_v4().to_string(),
        };

        // 1. Persist user message
        persist_user_message(&conn, &ctx, "Hello", &[], &[]).unwrap();

        persist_result_and_finalize(
            &conn,
            &ctx,
            "claude-opus-4-20250514",
            "Response text",
            Some("max"),
            Some("plan"),
            &AgentUsage {
                input_tokens: Some(100),
                output_tokens: Some(50),
            },
            None,
            "idle",
            None,
        )
        .unwrap();

        // Verify session metadata
        let (effort, perm, agent_type, model_id): (String, String, String, String) = conn
            .query_row(
                "SELECT effort_level, permission_mode, agent_type, model FROM sessions WHERE id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(effort, "max", "effort_level should be persisted");
        assert_eq!(perm, "plan", "permission_mode should be persisted");
        assert_eq!(
            agent_type, "claude",
            "agent_type should be set from model provider"
        );
        assert_eq!(model_id, "opus-1m", "model should be persisted");

        // Verify messages were created (user + result)
        let msg_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM session_messages WHERE session_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            msg_count >= 2,
            "Should have at least user + result messages, got {msg_count}"
        );

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn incremental_persist_preserves_existing_values_when_null() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::data_dir::TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", dir.path());

        let db_path = setup_test_db(dir.path());
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, effort_level, permission_mode) VALUES ('s1', 'w1', 'idle', 'high', 'acceptEdits')",
            [],
        ).unwrap();

        let ctx = ExchangeContext {
            helmor_session_id: "s1".to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            user_message_id: Uuid::new_v4().to_string(),
        };

        persist_user_message(&conn, &ctx, "Hi", &[], &[]).unwrap();
        persist_result_and_finalize(
            &conn,
            &ctx,
            "opus",
            "Reply",
            None, // effort_level = None → should keep 'high'
            None, // permission_mode = None → should keep 'acceptEdits'
            &AgentUsage {
                input_tokens: None,
                output_tokens: None,
            },
            None,
            "idle",
            None,
        )
        .unwrap();

        let (effort, perm): (String, String) = conn
            .query_row(
                "SELECT effort_level, permission_mode FROM sessions WHERE id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(
            effort, "high",
            "effort_level should be preserved when None passed"
        );
        assert_eq!(
            perm, "acceptEdits",
            "permission_mode should be preserved when None passed"
        );

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn incremental_persist_turn_messages() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::data_dir::TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", dir.path());

        let db_path = setup_test_db(dir.path());
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title) VALUES ('s1', 'w1', 'idle', 'Test')",
            [],
        ).unwrap();

        let ctx = ExchangeContext {
            helmor_session_id: "s1".to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            user_message_id: Uuid::new_v4().to_string(),
        };

        // Persist user message
        persist_user_message(&conn, &ctx, "Do something", &[], &[]).unwrap();

        // Persist two intermediate turns
        let turn1 = CollectedTurn {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::Assistant,
            content_json:
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"I'll help"}]}}"#
                    .to_string(),
        };
        let turn2 = CollectedTurn {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::User,
            content_json:
                r#"{"type":"user","content":[{"type":"tool_result","tool_use_id":"t1"}]}"#
                    .to_string(),
        };

        let _ = persist_turn_message(&conn, &ctx, &turn1, "opus").unwrap();
        let _ = persist_turn_message(&conn, &ctx, &turn2, "opus").unwrap();

        // Verify: 3 messages so far (user + 2 turns)
        let msg_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM session_messages WHERE session_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(msg_count, 3, "Should have user + 2 turn messages");

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    /// End-to-end: simulate the sidecar firing a `user_prompt` passthrough
    /// event (what `ClaudeSessionManager.steer()` / `CodexAppServerManager
    /// .steer()` emit after provider ack) into the accumulator, drain the
    /// turns the streaming loop would persist, and assert DB contains
    /// EXACTLY ONE row per logical user message (no double-persist, no
    /// orphan `type: user` row) AND that reload returns a single bubble
    /// per message with `files` + `steer` preserved.
    ///
    /// Explicitly exists to guard against the two bugs the code-review
    /// flagged: (a) accumulator producing a turn + `persist_steer_message`
    /// writing a second row, and (b) `type: user` wrapper drifting loose
    /// from the `type: user_prompt` shape on reload.
    #[test]
    fn steer_user_prompt_event_persists_once_and_reloads_at_correct_position() {
        use crate::pipeline::accumulator::StreamAccumulator;
        use crate::pipeline::types::MessageRole as PipelineRole;

        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::data_dir::TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", dir.path());

        let db_path = setup_test_db(dir.path());
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title) VALUES ('s1', 'w1', 'idle', 'Test')",
            [],
        )
        .unwrap();

        let ctx = ExchangeContext {
            helmor_session_id: "s1".to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            user_message_id: "user-initial".to_string(),
        };

        // 1. Initial prompt persisted via the normal path.
        persist_user_message(&conn, &ctx, "investigate the bug", &[], &[]).unwrap();

        // 2. Drive the accumulator the same way the streaming loop does:
        //    assistant deltas, steer event, more assistant deltas, result.
        let mut acc = StreamAccumulator::new("claude", "opus-1m");
        let asst_first = serde_json::json!({
            "type": "assistant",
            "message": {
                "id": "msg_a",
                "role": "assistant",
                "content": [{"type": "text", "text": "Checking files..."}]
            }
        });
        acc.push_event(&asst_first, &asst_first.to_string());

        let steer_event = serde_json::json!({
            "type": "user_prompt",
            "text": "focus on failing tests",
            "steer": true,
            "files": ["src/foo.ts"],
        });
        acc.push_event(&steer_event, &steer_event.to_string());

        let asst_second = serde_json::json!({
            "type": "assistant",
            "message": {
                "id": "msg_b",
                "role": "assistant",
                "content": [{"type": "text", "text": "Switching focus."}]
            }
        });
        acc.push_event(&asst_second, &asst_second.to_string());

        acc.flush_pending();

        // 3. Persist every turn the accumulator produced — this mirrors
        //    the `while persisted < turns_len { persist_turn_message(...) }`
        //    loop in `streaming.rs`.
        for i in 0..acc.turns_len() {
            persist_turn_message(&conn, &ctx, acc.turn_at(i), &ctx.model_id).unwrap();
        }

        // 4. Assert one-shot persistence: exactly one DB row per user
        //    message — the initial prompt + the steer. If the old
        //    `persist_steer_message` path ever returns, this goes to 3.
        let user_row_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM session_messages WHERE session_id = 's1' AND role = 'user'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            user_row_count, 2,
            "expected initial prompt + steer user rows, no duplicates"
        );

        // 5. Reload via the exact production path and verify rendering.
        let records = crate::models::sessions::list_session_historical_records("s1").unwrap();
        let messages = crate::pipeline::MessagePipeline::convert_historical(&records);

        // Message shape: [user: initial, assistant: first, user: steer, assistant: second]
        let user_msgs: Vec<&crate::pipeline::types::ThreadMessageLike> = messages
            .iter()
            .filter(|m| m.role == PipelineRole::User)
            .collect();
        assert_eq!(
            user_msgs.len(),
            2,
            "reload must show one bubble per user message, not two per steer"
        );

        // Sandwich order: initial user → assistant → steer user → assistant
        assert_eq!(messages[0].role, PipelineRole::User);
        assert_eq!(messages[1].role, PipelineRole::Assistant);
        assert_eq!(messages[2].role, PipelineRole::User);
        assert_eq!(messages[3].role, PipelineRole::Assistant);

        std::env::remove_var("HELMOR_DATA_DIR");
    }
}
