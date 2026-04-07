use crate::models::sessions::mark_session_read_in_transaction;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, Manager};
use uuid::Uuid;

use crate::error::CommandError;

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
    Error {
        message: String,
        persisted: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamStartResponse {
    pub stream_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelOption {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub cli_model: String,
    pub badge: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelSection {
    pub id: String,
    pub label: String,
    pub options: Vec<AgentModelOption>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendRequest {
    pub provider: String,
    pub model_id: String,
    pub prompt: String,
    pub session_id: Option<String>,
    pub helmor_session_id: Option<String>,
    pub working_directory: Option<String>,
    pub effort_level: Option<String>,
    pub permission_mode: Option<String>,
    pub user_message_id: Option<String>,
}

// Re-export pipeline types used by persistence functions in this file.
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

#[derive(Debug, Clone, Copy)]
pub(crate) struct AgentModelDefinition {
    pub(crate) id: &'static str,
    pub(crate) provider: &'static str,
    pub(crate) label: &'static str,
    pub(crate) cli_model: &'static str,
    pub(crate) badge: Option<&'static str>,
}

const CLAUDE_MODEL_DEFINITIONS: &[AgentModelDefinition] = &[
    AgentModelDefinition {
        id: "opus-1m",
        provider: "claude",
        label: "Opus 4.6 1M",
        cli_model: "opus[1m]",
        badge: Some("NEW"),
    },
    AgentModelDefinition {
        id: "opus",
        provider: "claude",
        label: "Opus 4.6",
        cli_model: "opus",
        badge: None,
    },
    AgentModelDefinition {
        id: "sonnet",
        provider: "claude",
        label: "Sonnet 4.6",
        cli_model: "sonnet",
        badge: None,
    },
    AgentModelDefinition {
        id: "haiku",
        provider: "claude",
        label: "Haiku 4.5",
        cli_model: "haiku",
        badge: None,
    },
];

const CODEX_MODEL_DEFINITIONS: &[AgentModelDefinition] = &[
    AgentModelDefinition {
        id: "gpt-5.4",
        provider: "codex",
        label: "GPT-5.4",
        cli_model: "gpt-5.4",
        badge: Some("NEW"),
    },
    AgentModelDefinition {
        id: "gpt-5.4-mini",
        provider: "codex",
        label: "GPT-5.4-Mini",
        cli_model: "gpt-5.4-mini",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.3-codex",
        provider: "codex",
        label: "GPT-5.3-Codex",
        cli_model: "gpt-5.3-codex",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.2-codex",
        provider: "codex",
        label: "GPT-5.2-Codex",
        cli_model: "gpt-5.2-codex",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.2",
        provider: "codex",
        label: "GPT-5.2",
        cli_model: "gpt-5.2",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.1-codex-max",
        provider: "codex",
        label: "GPT-5.1-Codex-Max",
        cli_model: "gpt-5.1-codex-max",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.1-codex-mini",
        provider: "codex",
        label: "GPT-5.1-Codex-Mini",
        cli_model: "gpt-5.1-codex-mini",
        badge: None,
    },
];

#[tauri::command]
pub fn list_agent_model_sections() -> Vec<AgentModelSection> {
    vec![
        AgentModelSection {
            id: "claude".to_string(),
            label: "Claude Code".to_string(),
            options: CLAUDE_MODEL_DEFINITIONS
                .iter()
                .map(model_definition_to_option)
                .collect(),
        },
        AgentModelSection {
            id: "codex".to_string(),
            label: "Codex".to_string(),
            options: CODEX_MODEL_DEFINITIONS
                .iter()
                .map(model_definition_to_option)
                .collect(),
        },
    ]
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

    let working_directory = resolve_working_directory(request.working_directory.as_deref())?;
    let stream_id = Uuid::new_v4().to_string();

    // All providers go through the sidecar
    stream_via_sidecar(
        app,
        on_event,
        &sidecar,
        &stream_id,
        model,
        &prompt,
        &request,
        &working_directory,
    )
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

// ---------------------------------------------------------------------------
// Session auto-title generation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSessionTitleRequest {
    pub session_id: String,
    pub user_message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSessionTitleResponse {
    pub title: Option<String>,
    pub skipped: bool,
}

/// Generate a short title for a session based on the user's first message.
///
/// Checks if the session title is still "Untitled" — if it has already been
/// renamed, the call is a no-op (returns `skipped: true`).
///
/// Uses the sidecar's `generateTitle` method (Claude haiku) to produce
/// a concise title, then persists it to the database.
#[tauri::command]
pub async fn generate_session_title(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: GenerateSessionTitleRequest,
) -> CmdResult<GenerateSessionTitleResponse> {
    // 1. Check whether the session still needs a title
    {
        let connection =
            open_write_connection().map_err(|e| anyhow::anyhow!("Failed to open DB: {e}"))?;
        let current_title: String = connection
            .query_row(
                "SELECT title FROM sessions WHERE id = ?1",
                [&request.session_id],
                |row| row.get(0),
            )
            .map_err(|e| anyhow::anyhow!("Session not found: {e}"))?;

        if current_title != "Untitled" {
            return Ok(GenerateSessionTitleResponse {
                title: None,
                skipped: true,
            });
        }
    }

    // 2. Ask the sidecar to generate a title
    let request_id = Uuid::new_v4().to_string();
    let sidecar_req = crate::sidecar::SidecarRequest {
        id: request_id.clone(),
        method: "generateTitle".to_string(),
        params: serde_json::json!({
            "userMessage": request.user_message,
        }),
    };

    let rx = sidecar.subscribe(&request_id);

    if let Err(e) = sidecar.send(&sidecar_req) {
        sidecar.unsubscribe(&request_id);
        return Err(anyhow::anyhow!("Sidecar send failed: {e}").into());
    }

    // 3. Wait for the titleGenerated or error event (blocking thread)
    let session_id = request.session_id.clone();
    let result: (Option<String>, Option<String>) = tauri::async_runtime::spawn_blocking({
        let rid = request_id;
        move || {
            let sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecar> = app.state();
            let mut title: Option<String> = None;
            let mut branch_name: Option<String> = None;

            for event in rx.iter() {
                match event.event_type() {
                    "titleGenerated" => {
                        title = event
                            .raw
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .filter(|t| !t.is_empty());
                        branch_name = event
                            .raw
                            .get("branchName")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .filter(|b| !b.is_empty());
                        break;
                    }
                    "error" => {
                        let msg = event
                            .raw
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Unknown error");
                        eprintln!("[generate_session_title] Sidecar error: {msg}");
                        break;
                    }
                    _ => {
                        // Ignore intermediate events (e.g. streaming deltas)
                    }
                }
            }

            sidecar_state.unsubscribe(&rid);
            (title, branch_name)
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("Title generation task failed: {e}"))?;

    let (generated_title, generated_branch) = result;

    // 4. Persist title to DB
    if let Some(ref title) = generated_title {
        crate::models::sessions::rename_session(&session_id, title)
            .map_err(|e| anyhow::anyhow!("Failed to rename session: {e}"))?;
    }

    // 5. Rename git branch if a branch name was generated
    if let Some(ref branch_segment) = generated_branch {
        let connection =
            open_write_connection().map_err(|e| anyhow::anyhow!("Failed to open DB: {e}"))?;

        // Find the workspace for this session
        let ws_info: Option<(String, Option<String>, Option<String>)> = connection
            .query_row(
                r#"SELECT w.id, w.branch, r.root_path
                   FROM workspaces w
                   JOIN repos r ON r.id = w.repository_id
                   WHERE w.active_session_id = ?1 AND w.state = 'ready'"#,
                [&session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();

        if let Some((workspace_id, old_branch, root_path)) = ws_info {
            let branch_settings = crate::models::settings::load_branch_prefix_settings().unwrap_or(
                crate::models::settings::BranchPrefixSettings {
                    branch_prefix_type: None,
                    branch_prefix_custom: None,
                },
            );
            let new_branch =
                crate::models::helpers::branch_name_for_directory(branch_segment, &branch_settings);

            if old_branch.as_deref() != Some(new_branch.as_str()) {
                // Rename the actual git branch
                if let (Some(ref old_name), Some(ref repo_root)) = (&old_branch, &root_path) {
                    if std::path::Path::new(repo_root).is_dir() {
                        crate::models::git_ops::run_git(
                            ["-C", repo_root, "branch", "-m", old_name, &new_branch],
                            None,
                        )
                        .ok();
                    }
                }

                // Update branch in DB
                connection
                    .execute(
                        "UPDATE workspaces SET branch = ?1 WHERE id = ?2",
                        (&new_branch, &workspace_id),
                    )
                    .ok();
            }
        }
    }

    Ok(GenerateSessionTitleResponse {
        title: generated_title,
        skipped: false,
    })
}

fn sidecar_debug_enabled() -> bool {
    std::env::var("HELMOR_SIDECAR_DEBUG")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
fn stream_via_sidecar(
    app: AppHandle,
    on_event: Channel<AgentStreamEvent>,
    sidecar: &crate::sidecar::ManagedSidecar,
    stream_id: &str,
    model: &AgentModelDefinition,
    prompt: &str,
    request: &AgentSendRequest,
    working_directory: &Path,
) -> CmdResult<()> {
    let request_id = stream_id.to_string();
    let debug = sidecar_debug_enabled();

    if debug {
        eprintln!(
            "[agents:debug] stream_via_sidecar — provider={} model={} cwd={} prompt_len={}",
            model.provider,
            model.cli_model,
            working_directory.display(),
            prompt.len()
        );
    }

    // Resolve session ID for resume from DB if not provided by frontend.
    // Only resume if the stored session was created by the SAME provider —
    // Claude session IDs are incompatible with Codex thread IDs.
    let resume_session_id = request
        .session_id
        .clone()
        .or_else(|| {
            request.helmor_session_id.as_deref().and_then(|hsid| {
                let conn = open_write_connection().ok()?;
                let (stored_sid, stored_provider): (Option<String>, Option<String>) = conn
                    .query_row(
                        "SELECT provider_session_id, agent_type FROM sessions WHERE id = ?1",
                        [hsid],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .ok()?;

                let sid = stored_sid?;
                let stored_provider = stored_provider.unwrap_or_default();

                if stored_provider == model.provider {
                    Some(sid)
                } else {
                    if debug {
                        eprintln!(
                            "[agents:debug] Skipping resume — stored provider={stored_provider}, requested={}",
                            model.provider
                        );
                    }
                    None
                }
            })
        });

    if debug {
        eprintln!(
            "[agents:debug] resume_session_id={:?} helmor_session_id={:?} provider={}",
            resume_session_id, request.helmor_session_id, model.provider
        );
    }

    // Keep as Option — only persist if a real session exists
    let helmor_session_id = request.helmor_session_id.clone();

    // The sidecar needs a session ID for the SDK; use the real one or a temporary UUID
    let sidecar_session_id = helmor_session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    // Send request to sidecar
    let sidecar_req = crate::sidecar::SidecarRequest {
        id: request_id.clone(),
        method: "sendMessage".to_string(),
        params: serde_json::json!({
            "sessionId": sidecar_session_id,
            "prompt": prompt,
            "model": model.cli_model,
            "cwd": working_directory.display().to_string(),
            "resume": resume_session_id,
            "provider": model.provider,
            "effortLevel": request.effort_level,
            "permissionMode": request.permission_mode,
        }),
    };

    // Subscribe to events for this request BEFORE sending (no race)
    let rx = sidecar.subscribe(&request_id);

    if let Err(e) = sidecar.send(&sidecar_req) {
        sidecar.unsubscribe(&request_id);
        return Err(anyhow::anyhow!("Sidecar send failed: {e}").into());
    }

    // Read events in background and forward to frontend via Channel
    let model_id = model.id.to_string();
    let provider = model.provider.to_string();
    let model_copy = *model;
    let prompt_copy = prompt.to_string();
    let working_dir_str = working_directory.display().to_string();
    let hsid_copy = helmor_session_id;
    let effort_copy = request.effort_level.clone();
    let permission_mode_copy = request.permission_mode.clone();
    let user_message_id_copy = request.user_message_id.clone();
    let rid = request_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecar> = app.state();
        let mut resolved_session_id: Option<String> = None;
        // Pipeline: replaces StreamOutputAccumulator — produces ThreadMessageLike[]
        // directly, with hash-based change detection.
        let context_key = rid.clone();
        let pipeline_session_id = hsid_copy.clone().unwrap_or_else(|| context_key.clone());
        let mut pipeline = hsid_copy.as_ref().map(|_| {
            crate::pipeline::MessagePipeline::new(
                provider.as_str(),
                model_copy.cli_model,
                &context_key,
                &pipeline_session_id,
            )
        });
        let debug = sidecar_debug_enabled();
        let mut event_count: u64 = 0;

        // --- Incremental persistence setup ---
        let mut exchange_ctx: Option<ExchangeContext> = None;
        let mut persisted_turn_count: usize = 0;
        let db_conn = if hsid_copy.is_some() {
            open_write_connection().ok()
        } else {
            None
        };

        if let (Some(hsid), Some(conn)) = (&hsid_copy, &db_conn) {
            let ctx = ExchangeContext {
                helmor_session_id: hsid.clone(),
                turn_id: Uuid::new_v4().to_string(),
                model_id: model_copy.id.to_string(),
                model_provider: model_copy.provider.to_string(),
                assistant_sdk_message_id: format!("helmor-assistant-{}", Uuid::new_v4()),
                user_message_id: user_message_id_copy
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
            };

            match persist_user_message(conn, &ctx, &prompt_copy) {
                Ok(()) => {
                    if debug {
                        eprintln!("[agents:debug] [{rid}] User message persisted to DB");
                    }
                    exchange_ctx = Some(ctx);
                }
                Err(e) => {
                    eprintln!("[agents] Failed to persist user message: {e}");
                }
            }
        }

        if debug {
            eprintln!("[agents:debug] [{rid}] Waiting for sidecar events...");
        }

        // Receive events from our dedicated channel (dispatched by request ID)
        for event in rx.iter() {
            event_count += 1;

            // Capture session ID
            if let Some(sid) = event.session_id() {
                if debug && resolved_session_id.is_none() {
                    eprintln!("[agents:debug] [{rid}] Provider session resolved: {sid}");
                }
                resolved_session_id = Some(sid.to_string());
            }

            match event.event_type() {
                "end" => {
                    if debug {
                        eprintln!(
                            "[agents:debug] [{rid}] End — {event_count} events, session={:?}",
                            resolved_session_id
                        );
                    }

                    // Finalize persistence: flush remaining turns + result + metadata
                    let persisted = exchange_ctx.is_some();
                    let mut resolved_model = model_copy.cli_model.to_string();

                    if let Some(pl) = pipeline.take() {
                        // Persist any remaining turns via the pipeline's accumulator
                        if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
                            let model_str = pl.accumulator.resolved_model();
                            while persisted_turn_count < pl.accumulator.turns_len() {
                                match persist_turn_message(
                                    conn,
                                    ctx,
                                    pl.accumulator.turn_at(persisted_turn_count),
                                    model_str,
                                ) {
                                    Ok(_) => persisted_turn_count += 1,
                                    Err(e) => {
                                        eprintln!(
                                            "[agents] Failed to persist turn {persisted_turn_count}: {e}"
                                        );
                                        break;
                                    }
                                }
                            }
                        }

                        // Finalize the accumulator for persistence output
                        if let Ok(output) =
                            pl.accumulator.finish_output(resolved_session_id.as_deref())
                        {
                            resolved_model = output.resolved_model.clone();

                            if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
                                if let Err(e) = persist_result_and_finalize(
                                    conn,
                                    ctx,
                                    &output.resolved_model,
                                    &output.assistant_text,
                                    output.session_id.as_deref(),
                                    effort_copy.as_deref(),
                                    permission_mode_copy.as_deref(),
                                    &output.usage,
                                    output.result_json.as_deref(),
                                ) {
                                    eprintln!("[agents] Failed to finalize exchange: {e}");
                                }
                            }
                        }
                    }

                    let _ = on_event.send(AgentStreamEvent::Done {
                        provider: provider.clone(),
                        model_id: model_id.clone(),
                        resolved_model,
                        session_id: resolved_session_id.clone(),
                        working_directory: working_dir_str.clone(),
                        persisted,
                    });
                    break;
                }
                "error" => {
                    let msg = event
                        .raw
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown sidecar error")
                        .to_string();
                    if debug {
                        eprintln!("[agents:debug] [{rid}] Sidecar error: {msg}");
                    }
                    let _ = on_event.send(AgentStreamEvent::Error {
                        message: msg,
                        persisted: exchange_ctx.is_some(),
                    });
                    break;
                }
                _ => {
                    let line = serde_json::to_string(&event.raw).unwrap_or_default();
                    if !line.is_empty() && line != "{}" {
                        if let Some(pl) = pipeline.as_mut() {
                            let emit = pl.push_event(&event.raw, &line);

                            // Persist newly completed turns
                            if let (Some(ctx), Some(conn)) = (&exchange_ctx, &db_conn) {
                                let model_str = pl.accumulator.resolved_model().to_string();
                                while persisted_turn_count < pl.accumulator.turns_len() {
                                    match persist_turn_message(
                                        conn,
                                        ctx,
                                        pl.accumulator.turn_at(persisted_turn_count),
                                        &model_str,
                                    ) {
                                        Ok(_) => {
                                            persisted_turn_count += 1;
                                        }
                                        Err(e) => {
                                            eprintln!(
                                                "[agents] Failed to persist turn {persisted_turn_count}: {e}"
                                            );
                                            break;
                                        }
                                    }
                                }
                            }

                            // Emit based on pipeline output type
                            match emit {
                                crate::pipeline::PipelineEmit::Full(messages) => {
                                    let _ = on_event.send(AgentStreamEvent::Update { messages });
                                }
                                crate::pipeline::PipelineEmit::Partial(message) => {
                                    let _ = on_event
                                        .send(AgentStreamEvent::StreamingPartial { message });
                                }
                                crate::pipeline::PipelineEmit::None => {}
                            }
                        }
                    }
                }
            }
        }

        if debug {
            eprintln!("[agents:debug] [{rid}] Event loop exited after {event_count} events");
        }
        sidecar_state.unsubscribe(&rid);
    });

    Ok(())
}
// Test helpers using the new pipeline accumulator
#[cfg(test)]
fn parse_claude_output(
    stdout: &str,
    fallback_session_id: Option<&str>,
    fallback_model: &str,
) -> Result<crate::pipeline::types::ParsedAgentOutput> {
    let mut accumulator =
        crate::pipeline::accumulator::StreamAccumulator::new("claude", fallback_model);
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        accumulator.push_event(&value, line);
    }
    accumulator.finish_output(fallback_session_id)
}

#[cfg(test)]
fn parse_codex_output(
    stdout: &str,
    fallback_session_id: Option<&str>,
    fallback_model: &str,
) -> Result<crate::pipeline::types::ParsedAgentOutput> {
    let mut accumulator =
        crate::pipeline::accumulator::StreamAccumulator::new("codex", fallback_model);
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        accumulator.push_event(&value, line);
    }
    accumulator.finish_output(fallback_session_id)
}

pub(crate) fn resolve_working_directory(provided: Option<&str>) -> Result<PathBuf> {
    if let Some(path) = non_empty(provided) {
        let directory = PathBuf::from(path);
        if directory.is_dir() {
            return Ok(directory);
        }
    }

    std::env::current_dir().context("Failed to resolve working directory")
}

// ---------------------------------------------------------------------------
// Incremental persistence — each message is INSERT-ed as it arrives
// ---------------------------------------------------------------------------

/// Persist the user's prompt as the first message of the exchange.
/// Called once at stream start, before entering the event loop.
fn persist_user_message(conn: &Connection, ctx: &ExchangeContext, prompt: &str) -> Result<()> {
    let now = current_timestamp_string()?;
    let user_message_id = ctx.user_message_id.clone();

    conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at,
              full_message, model, last_assistant_message_id, turn_id,
              is_resumable_message
            ) VALUES (?1, ?2, 'user', ?3, ?4, ?4, ?3, ?5, ?6, ?7, 0)
            "#,
        params![
            user_message_id,
            ctx.helmor_session_id,
            prompt,
            now,
            ctx.model_id,
            ctx.assistant_sdk_message_id,
            ctx.turn_id
        ],
    )?;
    Ok(())
}

/// Persist a single intermediate turn (assistant message or user tool result).
/// Called each time the accumulator produces a complete turn during streaming.
/// Persist a single intermediate turn. Returns the DB message ID.
fn persist_turn_message(
    conn: &Connection,
    ctx: &ExchangeContext,
    turn: &CollectedTurn,
    resolved_model: &str,
) -> Result<String> {
    let now = current_timestamp_string()?;
    let msg_id = Uuid::new_v4().to_string();

    conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at,
              full_message, model, turn_id, is_resumable_message
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?4, ?6, ?7, 0)
            "#,
        params![
            msg_id,
            ctx.helmor_session_id,
            turn.role,
            turn.content_json,
            now,
            resolved_model,
            ctx.turn_id
        ],
    )?;
    Ok(msg_id)
}

/// Persist the result summary and finalize session/workspace metadata.
/// Called once on the "end" event after all turns have been persisted.
#[allow(clippy::too_many_arguments)]
fn persist_result_and_finalize(
    conn: &Connection,
    ctx: &ExchangeContext,
    resolved_model: &str,
    assistant_text: &str,
    provider_session_id: Option<&str>,
    effort_level: Option<&str>,
    permission_mode: Option<&str>,
    usage: &AgentUsage,
    raw_result_json: Option<&str>,
) -> Result<()> {
    let now = current_timestamp_string()?;
    let result_message_id = Uuid::new_v4().to_string();

    let result_payload = raw_result_json.map(str::to_string).unwrap_or_else(|| {
        serde_json::json!({
            "type": "result",
            "subtype": "success",
            "result": assistant_text,
            "session_id": provider_session_id,
            "usage": {
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
            }
        })
        .to_string()
    });

    let transaction = conn.unchecked_transaction()?;

    // Insert result summary.
    transaction.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at,
              full_message, model, sdk_message_id, turn_id,
              is_resumable_message
            ) VALUES (?1, ?2, 'assistant', ?3, ?4, ?4, ?3, ?5, ?6, ?7, 0)
            "#,
        params![
            result_message_id,
            ctx.helmor_session_id,
            result_payload,
            now,
            resolved_model,
            ctx.assistant_sdk_message_id,
            ctx.turn_id
        ],
    )?;

    // Update session and workspace metadata.
    transaction.execute(
        r#"
            UPDATE sessions
            SET
              status = 'idle',
              model = ?2,
              agent_type = ?3,
              last_user_message_at = ?4,
              provider_session_id = CASE
                WHEN ?5 IS NOT NULL THEN ?5
                ELSE provider_session_id
              END,
              effort_level = COALESCE(?6, effort_level),
              permission_mode = COALESCE(?7, permission_mode)
            WHERE id = ?1
            "#,
        params![
            ctx.helmor_session_id,
            ctx.model_id,
            ctx.model_provider,
            now,
            provider_session_id,
            effort_level,
            permission_mode
        ],
    )?;

    transaction.execute(
        r#"
            UPDATE workspaces
            SET
              active_session_id = ?2
            WHERE id = (SELECT workspace_id FROM sessions WHERE id = ?1)
            "#,
        params![ctx.helmor_session_id, ctx.helmor_session_id],
    )?;

    mark_session_read_in_transaction(&transaction, &ctx.helmor_session_id)?;

    transaction
        .commit()
        .context("Failed to commit result and finalize transaction")
}

fn open_write_connection() -> Result<Connection> {
    crate::models::db::open_connection(true)
}

fn current_timestamp_string() -> Result<String> {
    crate::models::db::current_timestamp()
}

pub(crate) fn find_model_definition(model_id: &str) -> Option<&'static AgentModelDefinition> {
    CLAUDE_MODEL_DEFINITIONS
        .iter()
        .chain(CODEX_MODEL_DEFINITIONS.iter())
        .find(|model| model.id == model_id)
}

fn model_definition_to_option(model: &AgentModelDefinition) -> AgentModelOption {
    AgentModelOption {
        id: model.id.to_string(),
        provider: model.provider.to_string(),
        label: model.label.to_string(),
        cli_model: model.cli_model.to_string(),
        badge: model.badge.map(str::to_string),
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|inner| !inner.trim().is_empty())
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

        let output = parse_claude_output(stdout, None, "opus").unwrap();
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

        let output = parse_claude_output(stdout, None, "opus").unwrap();
        assert_eq!(output.assistant_text, "Answer");
        assert_eq!(output.thinking_text.as_deref(), Some("Let me think..."));
    }

    #[test]
    fn parse_claude_output_uses_fallback_session_id() {
        let stdout = r#"
            {"type":"stream_event","event":{"delta":{"text":"Hi"}}}
            {"type":"result","result":"Hi","usage":{}}
        "#;

        let output = parse_claude_output(stdout, Some("fallback-id"), "opus").unwrap();
        assert_eq!(output.session_id.as_deref(), Some("fallback-id"));
    }

    #[test]
    fn parse_claude_output_fails_on_empty_text() {
        let stdout = r#"{"type":"result","result":"","usage":{}}"#;
        let result = parse_claude_output(stdout, None, "opus");
        assert!(result.is_err());
    }

    #[test]
    fn parse_claude_output_extracts_model_name() {
        let stdout = r#"
            {"type":"assistant","model":"claude-opus-4-20250514","message":{"content":[{"type":"text","text":"Hi"}]}}
            {"type":"result","result":"Hi","usage":{}}
        "#;

        let output = parse_claude_output(stdout, None, "opus").unwrap();
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

        let output = parse_codex_output(stdout, None, "gpt-5.4").unwrap();
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

        let output = parse_codex_output(stdout, None, "gpt-5.4").unwrap();
        assert_eq!(output.session_id.as_deref(), Some("thread-xyz"));
    }

    #[test]
    fn parse_codex_output_fails_on_empty() {
        let stdout = r#"{"type":"thread.started","thread_id":"t1"}"#;
        let result = parse_codex_output(stdout, None, "gpt-5.4");
        assert!(result.is_err());
    }

    #[test]
    fn parse_codex_output_joins_multiple_messages() {
        let stdout = r#"
            {"type":"item.completed","item":{"type":"agent_message","text":"Part 1"}}
            {"type":"item.completed","item":{"type":"agent_message","text":"Part 2"}}
            {"type":"turn.completed","usage":{}}
        "#;

        let output = parse_codex_output(stdout, None, "gpt-5.4").unwrap();
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

        let output = parse_codex_output(stdout, None, "gpt-5.4").unwrap();
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
        persist_user_message(&conn, &ctx, "Hello").unwrap();

        // 2. Persist result and finalize with effort + permission_mode
        persist_result_and_finalize(
            &conn,
            &ctx,
            "claude-opus-4-20250514",
            "Response text",
            Some("sdk-session-123"),
            Some("max"),
            Some("plan"),
            &AgentUsage {
                input_tokens: Some(100),
                output_tokens: Some(50),
            },
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
            turn_id: Uuid::new_v4().to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            assistant_sdk_message_id: format!("helmor-assistant-{}", Uuid::new_v4()),
            user_message_id: Uuid::new_v4().to_string(),
        };

        persist_user_message(&conn, &ctx, "Hi").unwrap();
        persist_result_and_finalize(
            &conn,
            &ctx,
            "opus",
            "Reply",
            None,
            None, // effort_level = None → should keep 'high'
            None, // permission_mode = None → should keep 'acceptEdits'
            &AgentUsage {
                input_tokens: None,
                output_tokens: None,
            },
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
            turn_id: Uuid::new_v4().to_string(),
            model_id: "opus-1m".to_string(),
            model_provider: "claude".to_string(),
            assistant_sdk_message_id: format!("helmor-assistant-{}", Uuid::new_v4()),
            user_message_id: Uuid::new_v4().to_string(),
        };

        // Persist user message
        persist_user_message(&conn, &ctx, "Do something").unwrap();

        // Persist two intermediate turns
        let turn1 = CollectedTurn {
            role: "assistant".to_string(),
            content_json:
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"I'll help"}]}}"#
                    .to_string(),
        };
        let turn2 = CollectedTurn {
            role: "user".to_string(),
            content_json:
                r#"{"type":"user","content":[{"type":"tool_result","tool_use_id":"t1"}]}"#
                    .to_string(),
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
        let all: Vec<_> = CLAUDE_MODEL_DEFINITIONS
            .iter()
            .chain(CODEX_MODEL_DEFINITIONS.iter())
            .collect();
        let mut ids: Vec<&str> = all.iter().map(|m| m.id).collect();
        let len_before = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), len_before, "Duplicate model IDs found");
    }
}
