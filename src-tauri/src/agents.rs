use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, Manager};
use uuid::Uuid;

use crate::error::CommandError;

mod catalog;
mod persistence;
mod queries;
mod streaming;
mod support;

pub use self::catalog::{
    find_model_definition, AgentModelDefinition, AgentModelOption, AgentModelSection,
};
pub use self::queries::{
    GenerateSessionTitleRequest, GenerateSessionTitleResponse, ListSlashCommandsRequest,
    SlashCommandEntry,
};
pub use self::streaming::{
    abort_all_active_streams_blocking, bridge_elicitation_request_event, ActiveStreams,
};

use self::persistence::{
    finalize_session_metadata, open_write_connection, persist_exit_plan_message,
    persist_result_and_finalize, persist_turn_message, persist_user_message,
};
use self::streaming::stream_via_sidecar;
use self::support::{resolve_resume_working_directory, resolve_working_directory};

#[cfg(test)]
use self::support::{non_empty, parse_claude_output, parse_codex_output};

type CmdResult<T> = std::result::Result<T, CommandError>;

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
    DeferredToolUse {
        provider: String,
        model_id: String,
        resolved_model: String,
        session_id: Option<String>,
        working_directory: String,
        permission_mode: Option<String>,
        #[serde(rename = "toolUseId")]
        tool_use_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "toolInput")]
        tool_input: Value,
    },
    ElicitationRequest {
        provider: String,
        model_id: String,
        resolved_model: String,
        session_id: Option<String>,
        working_directory: String,
        #[serde(rename = "elicitationId")]
        elicitation_id: Option<String>,
        #[serde(rename = "serverName")]
        server_name: String,
        message: String,
        mode: Option<String>,
        url: Option<String>,
        #[serde(rename = "requestedSchema")]
        requested_schema: Option<Value>,
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
    #[serde(default)]
    pub resume_only: bool,
    pub session_id: Option<String>,
    pub helmor_session_id: Option<String>,
    pub working_directory: Option<String>,
    pub effort_level: Option<String>,
    pub permission_mode: Option<String>,
    pub user_message_id: Option<String>,
    /// Workspace-relative paths from the @-mention picker.
    #[serde(default)]
    pub files: Option<Vec<String>>,
}

#[cfg(test)]
use crate::pipeline::types::{AgentUsage, CollectedTurn};

/// Context shared across incremental persistence calls within a single exchange.
struct ExchangeContext {
    helmor_session_id: String,
    turn_id: String,
    model_id: String,
    model_provider: String,
    assistant_sdk_message_id: String,
    user_message_id: String,
}

#[tauri::command]
pub fn list_agent_model_sections() -> Vec<AgentModelSection> {
    catalog::list_agent_model_sections()
}

#[tauri::command]
pub async fn send_agent_message_stream(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: AgentSendRequest,
    on_event: Channel<AgentStreamEvent>,
) -> CmdResult<()> {
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() && !request.resume_only {
        return Err(anyhow::anyhow!("Prompt cannot be empty.").into());
    }

    let model = find_model_definition(&request.model_id)
        .ok_or_else(|| anyhow::anyhow!("Unknown model id: {}", request.model_id))?;

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
        model,
        &prompt,
        &request,
        &working_directory,
    )
}

fn resolve_stream_working_directory(
    request: &AgentSendRequest,
) -> anyhow::Result<std::path::PathBuf> {
    if request.resume_only {
        if let Some(session_id) = request.helmor_session_id.as_deref() {
            if let Some(workspace_dir) = resolve_resume_working_directory(session_id)? {
                if !workspace_dir.is_dir() {
                    return Err(anyhow::anyhow!(
                        "Workspace directory not found for resumed session: {}",
                        workspace_dir.display()
                    ));
                }
                return Ok(workspace_dir);
            }
        }
    }

    resolve_working_directory(request.working_directory.as_deref())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStopRequest {
    pub session_id: String,
    pub provider: Option<String>,
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
pub struct DeferredToolResponseRequest {
    pub tool_use_id: String,
    pub behavior: String,
    pub reason: Option<String>,
    pub updated_input: Option<Value>,
}

#[tauri::command]
pub async fn respond_to_deferred_tool(
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: DeferredToolResponseRequest,
) -> CmdResult<()> {
    tracing::info!(
        tool_use_id = %request.tool_use_id,
        behavior = %request.behavior,
        "Deferred tool response"
    );
    let req = crate::sidecar::SidecarRequest {
        id: Uuid::new_v4().to_string(),
        method: "deferredToolResponse".to_string(),
        params: serde_json::json!({
            "toolUseId": request.tool_use_id,
            "behavior": request.behavior,
            "reason": request.reason,
            "updatedInput": request.updated_input,
        }),
    };
    sidecar
        .send(&req)
        .map_err(|e| anyhow::anyhow!("Failed to send deferred tool response: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElicitationResponseRequest {
    pub elicitation_id: String,
    pub action: String,
    pub content: Option<Value>,
}

fn build_elicitation_response_sidecar_request(
    request: &ElicitationResponseRequest,
) -> crate::sidecar::SidecarRequest {
    crate::sidecar::SidecarRequest {
        id: Uuid::new_v4().to_string(),
        method: "elicitationResponse".to_string(),
        params: serde_json::json!({
            "elicitationId": request.elicitation_id,
            "action": request.action,
            "content": request.content,
        }),
    }
}

#[tauri::command]
pub async fn respond_to_elicitation_request(
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: ElicitationResponseRequest,
) -> CmdResult<()> {
    let req = build_elicitation_response_sidecar_request(&request);
    sidecar
        .send(&req)
        .map_err(|e| anyhow::anyhow!("Failed to send elicitation response: {e}"))?;
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
    request: ListSlashCommandsRequest,
) -> CmdResult<Vec<SlashCommandEntry>> {
    queries::list_slash_commands(app, sidecar, request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use insta::assert_yaml_snapshot;

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
            {"type":"thread.started","thread_id":"thread-abc"}
            {"type":"item.completed","item":{"type":"agent_message","text":"Hello from Codex"}}
            {"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4");
        assert_eq!(output.assistant_text, "Hello from Codex");
        assert_eq!(output.session_id.as_deref(), Some("thread-abc"));
        assert_eq!(output.usage.input_tokens, Some(100));
        assert_eq!(output.usage.output_tokens, Some(20));
    }

    #[test]
    fn parse_codex_output_uses_thread_resumed() {
        let stdout = r#"
            {"type":"thread.resumed","thread_id":"thread-xyz"}
            {"type":"item.completed","item":{"type":"agent_message","text":"Resumed"}}
            {"type":"turn.completed","usage":{}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4");
        assert_eq!(output.session_id.as_deref(), Some("thread-xyz"));
    }

    #[test]
    fn parse_codex_output_returns_empty_text_on_no_agent_message() {
        let stdout = r#"{"type":"thread.started","thread_id":"t1"}"#;
        let output = parse_codex_output(stdout, None, "gpt-5.4");
        assert!(output.assistant_text.is_empty());
        assert_eq!(output.session_id.as_deref(), Some("t1"));
    }

    #[test]
    fn parse_codex_output_joins_multiple_messages() {
        let stdout = r#"
            {"type":"item.completed","item":{"type":"agent_message","text":"Part 1"}}
            {"type":"item.completed","item":{"type":"agent_message","text":"Part 2"}}
            {"type":"turn.completed","usage":{}}
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
            {"type":"thread.started","thread_id":"t1"}
            {"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}
            {"type":"item.completed","item":{"type":"command_execution","command":"ls"}}
            {"type":"item.completed","item":{"type":"agent_message","text":"Done"}}
            {"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":10}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4");
        // Assistant text should combine all agent_message texts
        assert!(output.assistant_text.contains("Hello"));
        assert!(output.assistant_text.contains("Done"));
        // result_json should be the turn.completed line
        assert!(output.result_json.is_some());
        assert!(output.result_json.unwrap().contains("turn.completed"));
        // Usage should be captured
        assert_eq!(output.usage.input_tokens, Some(50));
        assert_eq!(output.usage.output_tokens, Some(10));
    }

    // -----------------------------------------------------------------------
    // find_model_definition — provider lookup
    // -----------------------------------------------------------------------

    #[test]
    fn find_model_definition_resolves_providers() {
        let claude = find_model_definition("opus-1m").unwrap();
        assert_eq!(claude.provider, "claude");

        let codex = find_model_definition("gpt-5.4").unwrap();
        assert_eq!(codex.provider, "codex");

        assert!(find_model_definition("nonexistent").is_none());
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
            turn_id: Uuid::new_v4().to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            assistant_sdk_message_id: format!("helmor-assistant-{}", Uuid::new_v4()),
            user_message_id: Uuid::new_v4().to_string(),
        };

        // 1. Persist user message
        persist_user_message(&conn, &ctx, "Hello", &[]).unwrap();

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
    fn resume_stream_uses_session_workspace_directory() {
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

        let workspace_dir = crate::data_dir::workspace_dir("test-repo", "test").unwrap();
        std::fs::create_dir_all(&workspace_dir).unwrap();

        let provided_dir = dir.path().join("somewhere-else");
        std::fs::create_dir_all(&provided_dir).unwrap();

        let request = AgentSendRequest {
            provider: "claude".to_string(),
            model_id: "opus-1m".to_string(),
            prompt: String::new(),
            resume_only: true,
            session_id: Some("provider-session-1".to_string()),
            helmor_session_id: Some("s1".to_string()),
            working_directory: Some(provided_dir.display().to_string()),
            effort_level: None,
            permission_mode: Some("plan".to_string()),
            user_message_id: None,
            files: None,
        };

        let resolved = resolve_stream_working_directory(&request).unwrap();
        assert_eq!(resolved, workspace_dir);

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn resume_stream_errors_when_session_workspace_is_missing() {
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

        let request = AgentSendRequest {
            provider: "claude".to_string(),
            model_id: "opus-1m".to_string(),
            prompt: String::new(),
            resume_only: true,
            session_id: Some("provider-session-1".to_string()),
            helmor_session_id: Some("s1".to_string()),
            working_directory: None,
            effort_level: None,
            permission_mode: Some("plan".to_string()),
            user_message_id: None,
            files: None,
        };

        let error = resolve_stream_working_directory(&request).unwrap_err();
        assert!(error
            .to_string()
            .contains("Workspace directory not found for resumed session"),);

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
            turn_id: Uuid::new_v4().to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            assistant_sdk_message_id: format!("helmor-assistant-{}", Uuid::new_v4()),
            user_message_id: Uuid::new_v4().to_string(),
        };

        persist_user_message(&conn, &ctx, "Hi", &[]).unwrap();
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
            turn_id: Uuid::new_v4().to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            assistant_sdk_message_id: format!("helmor-assistant-{}", Uuid::new_v4()),
            user_message_id: Uuid::new_v4().to_string(),
        };

        // Persist user message
        persist_user_message(&conn, &ctx, "Do something", &[]).unwrap();

        // Persist two intermediate turns
        let turn1 = CollectedTurn {
            id: Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content_json:
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"I'll help"}]}}"#
                    .to_string(),
            collected_idx: None,
        };
        let turn2 = CollectedTurn {
            id: Uuid::new_v4().to_string(),
            role: "user".to_string(),
            content_json:
                r#"{"type":"user","content":[{"type":"tool_result","tool_use_id":"t1"}]}"#
                    .to_string(),
            collected_idx: None,
        };

        let _ = persist_turn_message(&conn, &ctx, &turn1, "opus").unwrap();
        let _ = persist_turn_message(&conn, &ctx, &turn2, "opus").unwrap();

        // Verify: 3 messages so far (user + 2 turns), all with same turn_id
        let msg_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM session_messages WHERE session_id = 's1' AND turn_id = ?1",
                [&ctx.turn_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(msg_count, 3, "Should have user + 2 turn messages");

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn model_definitions_have_unique_ids() {
        let sections = catalog::list_agent_model_sections();
        let mut ids: Vec<&str> = sections
            .iter()
            .flat_map(|section| section.options.iter().map(|model| model.id.as_str()))
            .collect();
        let len_before = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), len_before, "Duplicate model IDs found");
    }

    #[test]
    fn build_elicitation_response_sidecar_request_serializes_expected_payload() {
        let request = ElicitationResponseRequest {
            elicitation_id: "elicitation-1".to_string(),
            action: "accept".to_string(),
            content: Some(serde_json::json!({
                "name": "Helmor",
                "approved": true,
            })),
        };

        let sidecar_request = build_elicitation_response_sidecar_request(&request);
        assert_eq!(sidecar_request.method, "elicitationResponse");
        let mut serialized = serde_json::to_value(&sidecar_request).unwrap();
        serialized["id"] = serde_json::json!("<uuid>");
        assert_yaml_snapshot!(
            serialized,
            @r#"
id: "<uuid>"
method: elicitationResponse
params:
  action: accept
  content:
    approved: true
    name: Helmor
  elicitationId: elicitation-1
        "#
        );
    }
}
