use crate::models::sessions::mark_session_read_in_transaction;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::error::CommandError;

type CmdResult<T> = std::result::Result<T, CommandError>;

// ---------------------------------------------------------------------------
// Streaming event types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AgentStreamEvent {
    Line {
        line: String,
    },
    Done {
        provider: String,
        model_id: String,
        resolved_model: String,
        session_id: Option<String>,
        working_directory: String,
        persisted_to_fixture: bool,
    },
    Error {
        message: String,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
}

/// A single intermediate message collected from the CLI stream output.
#[derive(Debug, Clone)]
struct CollectedTurn {
    role: String,
    content_json: String,
}

/// Full parsed output from a CLI invocation.
#[derive(Debug)]
struct ParsedAgentOutput {
    assistant_text: String,
    thinking_text: Option<String>,
    session_id: Option<String>,
    resolved_model: String,
    usage: AgentUsage,
    turns: Vec<CollectedTurn>,
    result_json: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct AgentModelDefinition {
    id: &'static str,
    provider: &'static str,
    label: &'static str,
    cli_model: &'static str,
    badge: Option<&'static str>,
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
        id: "gpt-5.3-codex-spark",
        provider: "codex",
        label: "GPT-5.3-Codex-Spark",
        cli_model: "gpt-5.3-codex-spark",
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
) -> CmdResult<AgentStreamStartResponse> {
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

fn sidecar_debug_enabled() -> bool {
    std::env::var("HELMOR_SIDECAR_DEBUG")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn stream_via_sidecar(
    app: AppHandle,
    sidecar: &crate::sidecar::ManagedSidecar,
    stream_id: &str,
    model: &AgentModelDefinition,
    prompt: &str,
    request: &AgentSendRequest,
    working_directory: &Path,
) -> CmdResult<AgentStreamStartResponse> {
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

    // Resolve session ID for resume from DB if not provided by frontend
    let resume_session_id = request
        .session_id
        .clone()
        .or_else(|| {
            request.helmor_session_id.as_deref().and_then(|csid| {
                let conn = open_write_connection().ok()?;
                conn.query_row(
                    "SELECT provider_session_id FROM sessions WHERE id = ?1",
                    [csid],
                    |row| row.get::<_, Option<String>>(0),
                )
                .ok()
                .flatten()
            })
        });

    if debug {
        eprintln!(
            "[agents:debug] resume_session_id={:?} helmor_session_id={:?}",
            resume_session_id, request.helmor_session_id
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
        }),
    };

    // Subscribe to events for this request BEFORE sending (no race)
    let rx = sidecar.subscribe(&request_id);

    if let Err(e) = sidecar.send(&sidecar_req) {
        sidecar.unsubscribe(&request_id);
        return Err(anyhow::anyhow!("Sidecar send failed: {e}").into());
    }

    // Read events in background and forward to frontend
    let event_name = format!("agent-stream:{request_id}");
    let model_id = model.id.to_string();
    let provider = model.provider.to_string();
    let model_copy = *model;
    let prompt_copy = prompt.to_string();
    let working_dir_str = working_directory.display().to_string();
    let hsid_copy = helmor_session_id;
    let rid = request_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecar> = app.state();
        let mut resolved_session_id: Option<String> = None;
        let mut all_lines: Vec<String> = Vec::new();
        let debug = sidecar_debug_enabled();
        let mut event_count: u64 = 0;

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
                            "[agents:debug] [{rid}] End — {event_count} events, {} lines collected, session={:?}",
                            all_lines.len(),
                            resolved_session_id
                        );
                    }
                    // Persist the exchange to the DB
                    let mut persisted = false;
                    if let Some(ref hsid) = hsid_copy {
                        if !all_lines.is_empty() {
                            let full_stdout = all_lines.join("\n");
                            let parse_fn = if provider == "codex" {
                                parse_codex_output
                            } else {
                                parse_claude_output
                            };
                            if let Ok(output) = parse_fn(
                                &full_stdout,
                                resolved_session_id.as_deref(),
                                model_copy.cli_model,
                            ) {
                                if persist_exchange_to_fixture(
                                    hsid,
                                    &prompt_copy,
                                    &model_copy,
                                    &output.resolved_model,
                                    &output.assistant_text,
                                    output.thinking_text.as_deref(),
                                    output.session_id.as_deref(),
                                    &output.usage,
                                    &output.turns,
                                    output.result_json.as_deref(),
                                )
                                .is_ok()
                                {
                                    persisted = true;
                                }
                            }
                        }
                    }

                    let _ = app.emit(
                        &event_name,
                        AgentStreamEvent::Done {
                            provider: provider.clone(),
                            model_id: model_id.clone(),
                            resolved_model: model_copy.cli_model.to_string(),
                            session_id: resolved_session_id.clone(),
                            working_directory: working_dir_str.clone(),
                            persisted_to_fixture: persisted,
                        },
                    );
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
                    let _ = app.emit(
                        &event_name,
                        AgentStreamEvent::Error { message: msg },
                    );
                    break;
                }
                _ => {
                    // Forward raw SDK message preserving all fields (incl. type)
                    let line = serde_json::to_string(&event.raw).unwrap_or_default();
                    if !line.is_empty() && line != "{}" {
                        let _ = app.emit(
                            &event_name,
                            AgentStreamEvent::Line { line: line.clone() },
                        );
                        all_lines.push(line);
                    }
                }
            }
        }

        if debug {
            eprintln!("[agents:debug] [{rid}] Event loop exited after {event_count} events");
        }
        sidecar_state.unsubscribe(&rid);
    });

    Ok(AgentStreamStartResponse {
        stream_id: request_id,
    })
}



fn parse_claude_output(
    stdout: &str,
    fallback_session_id: Option<&str>,
    fallback_model: &str,
) -> Result<ParsedAgentOutput> {
    let mut assistant_text = String::new();
    let mut thinking_text = String::new();
    let mut saw_text_delta = false;
    let mut saw_thinking_delta = false;
    let mut session_id = fallback_session_id.map(str::to_string);
    let mut resolved_model = fallback_model.to_string();
    let mut usage = AgentUsage {
        input_tokens: None,
        output_tokens: None,
    };

    // Collect intermediate turns: merge partial assistant messages by message ID.
    let mut turns: Vec<CollectedTurn> = Vec::new();
    let mut cur_asst_id: Option<String> = None;
    let mut cur_asst_blocks: Vec<Value> = Vec::new();
    let mut cur_asst_template: Option<Value> = None;
    let mut result_json: Option<String> = None;

    let flush_assistant = |turns: &mut Vec<CollectedTurn>,
                           cur_id: &mut Option<String>,
                           blocks: &mut Vec<Value>,
                           template: &mut Option<Value>| {
        if blocks.is_empty() {
            return;
        }
        if let Some(mut tmpl) = template.take() {
            if let Some(msg) = tmpl.get_mut("message") {
                msg["content"] = Value::Array(std::mem::take(blocks));
            }
            turns.push(CollectedTurn {
                role: "assistant".to_string(),
                content_json: tmpl.to_string(),
            });
        }
        *cur_id = None;
    };

    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        if let Some(found_session_id) = value.get("session_id").and_then(Value::as_str) {
            session_id = Some(found_session_id.to_string());
        }

        if let Some(found_model) = extract_claude_model_name(&value) {
            resolved_model = found_model;
        }

        match value.get("type").and_then(Value::as_str) {
            Some("stream_event") => {
                let delta = value.get("event").and_then(|event| event.get("delta"));

                if let Some(delta_text) = delta.and_then(|d| d.get("text")).and_then(Value::as_str)
                {
                    assistant_text.push_str(delta_text);
                    saw_text_delta = true;
                }

                if let Some(delta_thinking) = delta
                    .and_then(|d| d.get("thinking"))
                    .and_then(Value::as_str)
                {
                    thinking_text.push_str(delta_thinking);
                    saw_thinking_delta = true;
                }
            }
            Some("assistant") => {
                // Extract text/thinking for the response.
                if !saw_text_delta {
                    if let Some(text) = extract_claude_assistant_text(&value) {
                        assistant_text.push_str(&text);
                    }
                }
                if !saw_thinking_delta {
                    if let Some(thinking) = extract_claude_thinking_text(&value) {
                        thinking_text.push_str(&thinking);
                    }
                }

                // Collect intermediate turn: merge partial messages by ID.
                let msg_id = value
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);

                if cur_asst_id.is_some() && cur_asst_id != msg_id {
                    flush_assistant(
                        &mut turns,
                        &mut cur_asst_id,
                        &mut cur_asst_blocks,
                        &mut cur_asst_template,
                    );
                }

                if cur_asst_id.is_none() {
                    cur_asst_id = msg_id;
                    cur_asst_template = Some(value.clone());
                }

                if let Some(blocks) = value
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                {
                    for block in blocks {
                        cur_asst_blocks.push(block.clone());
                    }
                }
            }
            Some("user") => {
                // Flush any pending assistant turn.
                flush_assistant(
                    &mut turns,
                    &mut cur_asst_id,
                    &mut cur_asst_blocks,
                    &mut cur_asst_template,
                );
                turns.push(CollectedTurn {
                    role: "user".to_string(),
                    content_json: value.to_string(),
                });
            }
            Some("result") => {
                if assistant_text.trim().is_empty() {
                    if let Some(text) = value.get("result").and_then(Value::as_str) {
                        assistant_text.push_str(text);
                    }
                }
                if let Some(parsed_usage) = value.get("usage") {
                    usage.input_tokens = parsed_usage.get("input_tokens").and_then(Value::as_i64);
                    usage.output_tokens = parsed_usage.get("output_tokens").and_then(Value::as_i64);
                }
                result_json = Some(value.to_string());
            }
            _ => {}
        }
    }

    // Flush final pending assistant turn.
    flush_assistant(
        &mut turns,
        &mut cur_asst_id,
        &mut cur_asst_blocks,
        &mut cur_asst_template,
    );

    let assistant_text = assistant_text.trim().to_string();
    if assistant_text.is_empty() {
        bail!("Claude returned no assistant text.");
    }

    let thinking_text = thinking_text.trim().to_string();
    let thinking_text = if thinking_text.is_empty() {
        None
    } else {
        Some(thinking_text)
    };

    Ok(ParsedAgentOutput {
        assistant_text,
        thinking_text,
        session_id,
        resolved_model,
        usage,
        turns,
        result_json,
    })
}

fn parse_codex_output(
    stdout: &str,
    fallback_session_id: Option<&str>,
    fallback_model: &str,
) -> Result<ParsedAgentOutput> {
    let mut session_id = fallback_session_id.map(str::to_string);
    let mut assistant_chunks = Vec::new();
    let mut usage = AgentUsage {
        input_tokens: None,
        output_tokens: None,
    };

    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        if let Some(thread_id) = value.get("thread_id").and_then(Value::as_str) {
            session_id = Some(thread_id.to_string());
        }

        match value.get("type").and_then(Value::as_str) {
            Some("item.completed") => {
                if let Some(item) = value.get("item") {
                    if item.get("type").and_then(Value::as_str) == Some("agent_message") {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            assistant_chunks.push(text.to_string());
                        }
                    }
                }
            }
            Some("thread.started") | Some("thread.resumed") => {
                if let Some(thread_id) = value.get("thread_id").and_then(Value::as_str) {
                    session_id = Some(thread_id.to_string());
                }
            }
            Some("turn.completed") => {
                if let Some(parsed_usage) = value.get("usage") {
                    usage.input_tokens = parsed_usage.get("input_tokens").and_then(Value::as_i64);
                    usage.output_tokens = parsed_usage.get("output_tokens").and_then(Value::as_i64);
                }
            }
            _ => {}
        }
    }

    let assistant_text = assistant_chunks.join("\n\n").trim().to_string();
    if assistant_text.is_empty() {
        bail!("Codex returned no assistant text.");
    }

    Ok(ParsedAgentOutput {
        assistant_text,
        thinking_text: None,
        session_id,
        resolved_model: fallback_model.to_string(),
        usage,
        turns: Vec::new(),
        result_json: None,
    })
}

fn extract_claude_model_name(value: &Value) -> Option<String> {
    if let Some(model) = value.get("model").and_then(Value::as_str) {
        return Some(model.to_string());
    }

    if let Some(model) = value
        .get("message")
        .and_then(|message| message.get("model"))
        .and_then(Value::as_str)
    {
        return Some(model.to_string());
    }

    if let Some(model) = value
        .get("model")
        .and_then(|model| model.get("display_name"))
        .and_then(Value::as_str)
    {
        return Some(model.to_string());
    }

    None
}

fn extract_claude_thinking_text(value: &Value) -> Option<String> {
    let content = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)?;

    let text = content
        .iter()
        .filter_map(|block| {
            let is_thinking = block.get("type").and_then(Value::as_str) == Some("thinking");
            if !is_thinking {
                return None;
            }

            block.get("thinking").and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    (!text.trim().is_empty()).then_some(text)
}

fn extract_claude_assistant_text(value: &Value) -> Option<String> {
    let content = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)?;

    let text = content
        .iter()
        .filter_map(|block| {
            let is_text = block.get("type").and_then(Value::as_str) == Some("text");
            if !is_text {
                return None;
            }

            block.get("text").and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    (!text.trim().is_empty()).then_some(text)
}

fn resolve_working_directory(provided: Option<&str>) -> Result<PathBuf> {
    if let Some(path) = non_empty(provided) {
        let directory = PathBuf::from(path);
        if directory.is_dir() {
            return Ok(directory);
        }
    }

    std::env::current_dir().context("Failed to resolve working directory")
}

#[allow(clippy::too_many_arguments)]
fn persist_exchange_to_fixture(
    helmor_session_id: &str,
    prompt: &str,
    model: &AgentModelDefinition,
    resolved_model: &str,
    assistant_text: &str,
    _thinking_text: Option<&str>,
    provider_session_id: Option<&str>,
    usage: &AgentUsage,
    turns: &[CollectedTurn],
    raw_result_json: Option<&str>,
) -> Result<()> {
    let connection = open_write_connection()?;
    let now = current_timestamp_string()?;
    let turn_id = Uuid::new_v4().to_string();
    let user_message_id = Uuid::new_v4().to_string();
    let result_message_id = Uuid::new_v4().to_string();
    let assistant_sdk_message_id = format!("helmor-assistant-{}", Uuid::new_v4());

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

    let transaction = connection.unchecked_transaction()?;

    // 1. Insert the original user prompt.
    transaction.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at,
              full_message, model, last_assistant_message_id, turn_id,
              is_resumable_message
            ) VALUES (?1, ?2, 'user', ?3, ?4, ?4, ?3, ?5, ?6, ?7, 0)
            "#,
        params![
            user_message_id,
            helmor_session_id,
            prompt,
            now,
            model.id,
            assistant_sdk_message_id,
            turn_id
        ],
    )?;

    // 2. Insert all intermediate turns (assistant tool calls, user tool results, etc.).
    if !turns.is_empty() {
        for collected_turn in turns {
            let msg_id = Uuid::new_v4().to_string();
            transaction.execute(
                r#"
                    INSERT INTO session_messages (
                      id, session_id, role, content, created_at, sent_at,
                      full_message, model, turn_id, is_resumable_message
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?4, ?6, ?7, 0)
                    "#,
                params![
                    msg_id,
                    helmor_session_id,
                    collected_turn.role,
                    collected_turn.content_json,
                    now,
                    resolved_model,
                    turn_id
                ],
            )?;
        }
    }

    // 3. Insert result summary.
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
            helmor_session_id,
            result_payload,
            now,
            resolved_model,
            assistant_sdk_message_id,
            turn_id
        ],
    )?;

    // 4. Update session and workspace metadata.
    transaction.execute(
        r#"
            UPDATE sessions
            SET
              status = 'idle',
              model = ?2,
              last_user_message_at = ?3,
              provider_session_id = CASE
                WHEN ?4 IS NOT NULL THEN ?4
                ELSE provider_session_id
              END
            WHERE id = ?1
            "#,
        params![
            helmor_session_id,
            model.id,
            now,
            provider_session_id
        ],
    )?;

    transaction.execute(
        r#"
            UPDATE workspaces
            SET
              active_session_id = ?2
            WHERE id = (SELECT workspace_id FROM sessions WHERE id = ?1)
            "#,
        params![helmor_session_id, helmor_session_id],
    )?;

    mark_session_read_in_transaction(&transaction, helmor_session_id)?;

    transaction
        .commit()
        .context("Failed to commit persist exchange transaction")
}

fn open_write_connection() -> Result<Connection> {
    crate::models::db::open_connection(true)
}

fn current_timestamp_string() -> Result<String> {
    let connection = Connection::open_in_memory()?;
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .context("Failed to resolve current timestamp")
}

fn find_model_definition(model_id: &str) -> Option<&'static AgentModelDefinition> {
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
}

