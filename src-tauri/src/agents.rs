use crate::conductor::{mark_session_read_in_transaction, resolve_fixture_db_path};
use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Streaming event types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AgentStreamEvent {
    Line { line: String },
    Done {
        provider: String,
        model_id: String,
        resolved_model: String,
        session_id: Option<String>,
        working_directory: String,
        persisted_to_fixture: bool,
    },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamStartResponse {
    pub stream_id: String,
}

pub struct RunningAgentProcesses {
    pub map: Mutex<HashMap<String, u32>>,
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
    pub conductor_session_id: Option<String>,
    pub working_directory: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendResponse {
    pub provider: String,
    pub model_id: String,
    pub resolved_model: String,
    pub session_id: Option<String>,
    pub assistant_text: String,
    pub thinking_text: Option<String>,
    pub working_directory: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub persisted_to_fixture: bool,
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
pub async fn send_agent_message(request: AgentSendRequest) -> Result<AgentSendResponse, String> {
    tauri::async_runtime::spawn_blocking(move || send_agent_message_blocking(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn send_agent_message_stream(
    app: AppHandle,
    state: tauri::State<'_, RunningAgentProcesses>,
    request: AgentSendRequest,
) -> Result<AgentStreamStartResponse, String> {
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Prompt cannot be empty.".to_string());
    }

    let model = find_model_definition(&request.model_id)
        .ok_or_else(|| format!("Unknown model id: {}", request.model_id))?;

    if request.provider != model.provider {
        return Err(format!(
            "Model {} does not belong to provider {}.",
            request.model_id, request.provider
        ));
    }

    let working_directory = resolve_working_directory(request.working_directory.as_deref())?;
    let mut command = build_cli_command(model, &prompt, request.session_id.as_deref(), &working_directory)?;

    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stream_id = Uuid::new_v4().to_string();

    // Store PID for potential cancellation
    if let Ok(mut map) = state.map.lock() {
        map.insert(stream_id.clone(), child.id());
    }

    let event_name = format!("agent-stream:{stream_id}");
    let cleanup_id = stream_id.clone();
    let provider = model.provider.to_string();
    let model_id = model.id.to_string();
    let cli_model = model.cli_model.to_string();
    let conductor_session_id = request.conductor_session_id.clone();
    let fallback_session_id = request.session_id.clone();
    let working_dir_str = working_directory.display().to_string();
    let model_copy = *model;

    tauri::async_runtime::spawn_blocking(move || {
        let reader = BufReader::new(stdout);
        let mut all_lines = Vec::new();

        for line_result in reader.lines() {
            match line_result {
                Ok(line) => {
                    let trimmed = line.trim().to_string();
                    if !trimmed.is_empty() {
                        let _ = app.emit(&event_name, AgentStreamEvent::Line { line: trimmed.clone() });
                        all_lines.push(trimmed);
                    }
                }
                Err(e) => {
                    let _ = app.emit(&event_name, AgentStreamEvent::Error { message: e.to_string() });
                    return;
                }
            }
        }

        // Wait for process to exit
        let status = child.wait();
        let (exit_ok, exit_code) = match &status {
            Ok(s) => (s.success(), s.code()),
            Err(_) => (false, None),
        };

        if !exit_ok {
            let stderr_text = child.stderr.take().map(|mut se| {
                let mut buf = String::new();
                let _ = std::io::Read::read_to_string(&mut se, &mut buf);
                buf
            }).unwrap_or_default();
            let _ = app.emit(&event_name, AgentStreamEvent::Error {
                message: format_process_failure(if provider == "claude" { "Claude" } else { "Codex" }, stderr_text.as_bytes(), exit_code),
            });
            return;
        }

        // Parse and persist using existing logic
        let full_stdout = all_lines.join("\n");
        let parse_result = if provider == "claude" {
            parse_claude_output(&full_stdout, fallback_session_id.as_deref(), &cli_model)
        } else {
            parse_codex_output(&full_stdout, fallback_session_id.as_deref(), &cli_model)
        };

        match parse_result {
            Ok(output) => {
                let mut persisted = false;
                if let Some(csid) = non_empty(conductor_session_id.as_deref()) {
                    if persist_exchange_to_fixture(
                        csid,
                        &prompt,
                        &model_copy,
                        &output.resolved_model,
                        &output.assistant_text,
                        output.thinking_text.as_deref(),
                        output.session_id.as_deref(),
                        &output.usage,
                        &output.turns,
                        output.result_json.as_deref(),
                    ).is_ok() {
                        persisted = true;
                    }
                }

                let _ = app.emit(&event_name, AgentStreamEvent::Done {
                    provider,
                    model_id,
                    resolved_model: output.resolved_model,
                    session_id: output.session_id,
                    working_directory: working_dir_str,
                    persisted_to_fixture: persisted,
                });
            }
            Err(e) => {
                let _ = app.emit(&event_name, AgentStreamEvent::Error { message: e });
            }
        }

        // Cleanup PID
        {
            let processes: tauri::State<'_, RunningAgentProcesses> = app.state();
            let mut map = processes.map.lock().unwrap_or_else(|e| e.into_inner());
            map.remove(&cleanup_id);
            drop(map);
        }
    });

    Ok(AgentStreamStartResponse { stream_id })
}

fn send_agent_message_blocking(request: AgentSendRequest) -> Result<AgentSendResponse, String> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("Prompt cannot be empty.".to_string());
    }

    let model = find_model_definition(&request.model_id)
        .ok_or_else(|| format!("Unknown model id: {}", request.model_id))?;

    if request.provider != model.provider {
        return Err(format!(
            "Model {} does not belong to provider {}.",
            request.model_id, request.provider
        ));
    }

    let working_directory = resolve_working_directory(request.working_directory.as_deref())?;

    let output = match model.provider {
        "claude" => send_with_claude(model, prompt, request.session_id.as_deref(), &working_directory)?,
        "codex" => send_with_codex(model, prompt, request.session_id.as_deref(), &working_directory)?,
        provider => return Err(format!("Unsupported provider: {provider}")),
    };
    let persisted_to_fixture = if let Some(conductor_session_id) =
        non_empty(request.conductor_session_id.as_deref())
    {
        persist_exchange_to_fixture(
            conductor_session_id,
            prompt,
            model,
            &output.resolved_model,
            &output.assistant_text,
            output.thinking_text.as_deref(),
            output.session_id.as_deref(),
            &output.usage,
            &output.turns,
            output.result_json.as_deref(),
        )?;
        true
    } else {
        false
    };

    Ok(AgentSendResponse {
        provider: model.provider.to_string(),
        model_id: model.id.to_string(),
        resolved_model: output.resolved_model,
        session_id: output.session_id,
        assistant_text: output.assistant_text,
        thinking_text: output.thinking_text,
        working_directory: working_directory.display().to_string(),
        input_tokens: output.usage.input_tokens,
        output_tokens: output.usage.output_tokens,
        persisted_to_fixture,
    })
}

fn build_cli_command(
    model: &AgentModelDefinition,
    prompt: &str,
    session_id: Option<&str>,
    working_directory: &Path,
) -> Result<Command, String> {
    let binary = resolve_binary_path(model.provider)?;
    let mut command = Command::new(binary);

    if model.provider == "claude" {
        command
            .current_dir(working_directory)
            .arg("-p")
            .arg("--verbose")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            .arg("--model")
            .arg(model.cli_model);

        if let Some(existing_session_id) = non_empty(session_id) {
            command.arg("--resume").arg(existing_session_id);
        }

        command.arg(prompt);
    } else {
        // codex
        command.current_dir(working_directory);

        if let Some(existing_session_id) = non_empty(session_id) {
            command
                .arg("exec")
                .arg("resume")
                .arg("--json")
                .arg("--skip-git-repo-check")
                .arg("-m")
                .arg(model.cli_model)
                .arg(existing_session_id)
                .arg(prompt);
        } else {
            command
                .arg("exec")
                .arg("--json")
                .arg("--skip-git-repo-check")
                .arg("-m")
                .arg(model.cli_model)
                .arg(prompt);
        }
    }

    Ok(command)
}

fn send_with_claude(
    model: &AgentModelDefinition,
    prompt: &str,
    session_id: Option<&str>,
    working_directory: &Path,
) -> Result<ParsedAgentOutput, String> {
    let binary = resolve_binary_path("claude")?;
    let mut command = Command::new(binary);
    command
        .current_dir(working_directory)
        .arg("-p")
        .arg("--verbose")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--model")
        .arg(model.cli_model);

    if let Some(existing_session_id) = non_empty(session_id) {
        command.arg("--resume").arg(existing_session_id);
    }

    command.arg(prompt);

    let output = command.output().map_err(|error| error.to_string())?;

    if !output.status.success() {
        return Err(format_process_failure("Claude", &output.stderr, output.status.code()));
    }

    parse_claude_output(
        &String::from_utf8_lossy(&output.stdout),
        session_id,
        model.cli_model,
    )
}

fn send_with_codex(
    model: &AgentModelDefinition,
    prompt: &str,
    session_id: Option<&str>,
    working_directory: &Path,
) -> Result<ParsedAgentOutput, String> {
    let binary = resolve_binary_path("codex")?;
    let mut command = Command::new(binary);
    command.current_dir(working_directory);

    if let Some(existing_session_id) = non_empty(session_id) {
        command
            .arg("exec")
            .arg("resume")
            .arg("--json")
            .arg("--skip-git-repo-check")
            .arg("-m")
            .arg(model.cli_model)
            .arg(existing_session_id)
            .arg(prompt);
    } else {
        command
            .arg("exec")
            .arg("--json")
            .arg("--skip-git-repo-check")
            .arg("-m")
            .arg(model.cli_model)
            .arg(prompt);
    }

    let output = command.output().map_err(|error| error.to_string())?;

    if !output.status.success() {
        return Err(format_process_failure("Codex", &output.stderr, output.status.code()));
    }

    parse_codex_output(
        &String::from_utf8_lossy(&output.stdout),
        session_id,
        model.cli_model,
    )
}

fn parse_claude_output(
    stdout: &str,
    fallback_session_id: Option<&str>,
    fallback_model: &str,
) -> Result<ParsedAgentOutput, String> {
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
                msg["content"] = Value::Array(blocks.drain(..).collect());
            }
            turns.push(CollectedTurn {
                role: "assistant".to_string(),
                content_json: tmpl.to_string(),
            });
        }
        *cur_id = None;
    };

    for line in stdout.lines().map(str::trim).filter(|line| !line.is_empty()) {
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
                let delta = value
                    .get("event")
                    .and_then(|event| event.get("delta"));

                if let Some(delta_text) = delta
                    .and_then(|d| d.get("text"))
                    .and_then(Value::as_str)
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
        return Err("Claude returned no assistant text.".to_string());
    }

    let thinking_text = thinking_text.trim().to_string();
    let thinking_text = if thinking_text.is_empty() { None } else { Some(thinking_text) };

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
) -> Result<ParsedAgentOutput, String> {
    let mut session_id = fallback_session_id.map(str::to_string);
    let mut assistant_chunks = Vec::new();
    let mut usage = AgentUsage {
        input_tokens: None,
        output_tokens: None,
    };

    for line in stdout.lines().map(str::trim).filter(|line| !line.is_empty()) {
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
        return Err("Codex returned no assistant text.".to_string());
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

fn resolve_working_directory(provided: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = non_empty(provided) {
        let directory = PathBuf::from(path);
        if directory.is_dir() {
            return Ok(directory);
        }
    }

    env::current_dir().map_err(|error| error.to_string())
}

fn persist_exchange_to_fixture(
    conductor_session_id: &str,
    prompt: &str,
    model: &AgentModelDefinition,
    resolved_model: &str,
    assistant_text: &str,
    _thinking_text: Option<&str>,
    provider_session_id: Option<&str>,
    usage: &AgentUsage,
    turns: &[CollectedTurn],
    raw_result_json: Option<&str>,
) -> Result<(), String> {
    let connection = open_fixture_write_connection()?;
    let now = current_timestamp_string()?;
    let turn_id = Uuid::new_v4().to_string();
    let user_message_id = Uuid::new_v4().to_string();
    let result_message_id = Uuid::new_v4().to_string();
    let assistant_sdk_message_id = format!("helmor-assistant-{}", Uuid::new_v4());

    let result_payload = raw_result_json
        .map(str::to_string)
        .unwrap_or_else(|| {
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

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;

    // 1. Insert the original user prompt.
    transaction
        .execute(
            r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at,
              full_message, model, last_assistant_message_id, turn_id,
              is_resumable_message
            ) VALUES (?1, ?2, 'user', ?3, ?4, ?4, ?3, ?5, ?6, ?7, 0)
            "#,
            params![
                user_message_id,
                conductor_session_id,
                prompt,
                now,
                model.id,
                assistant_sdk_message_id,
                turn_id
            ],
        )
        .map_err(|error| error.to_string())?;

    // 2. Insert all intermediate turns (assistant tool calls, user tool results, etc.).
    if !turns.is_empty() {
        for collected_turn in turns {
            let msg_id = Uuid::new_v4().to_string();
            transaction
                .execute(
                    r#"
                    INSERT INTO session_messages (
                      id, session_id, role, content, created_at, sent_at,
                      full_message, model, turn_id, is_resumable_message
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?4, ?6, ?7, 0)
                    "#,
                    params![
                        msg_id,
                        conductor_session_id,
                        collected_turn.role,
                        collected_turn.content_json,
                        now,
                        resolved_model,
                        turn_id
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    // 3. Insert result summary.
    transaction
        .execute(
            r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at,
              full_message, model, sdk_message_id, turn_id,
              is_resumable_message
            ) VALUES (?1, ?2, 'assistant', ?3, ?4, ?4, ?3, ?5, ?6, ?7, 0)
            "#,
            params![
                result_message_id,
                conductor_session_id,
                result_payload,
                now,
                resolved_model,
                assistant_sdk_message_id,
                turn_id
            ],
        )
        .map_err(|error| error.to_string())?;

    // 4. Update session and workspace metadata.
    transaction
        .execute(
            r#"
            UPDATE sessions
            SET
              status = 'idle',
              model = ?2,
              last_user_message_at = ?3,
              claude_session_id = CASE
                WHEN ?4 = 'claude' AND ?5 IS NOT NULL THEN ?5
                ELSE claude_session_id
              END
            WHERE id = ?1
            "#,
            params![
                conductor_session_id,
                model.id,
                now,
                model.provider,
                provider_session_id
            ],
        )
        .map_err(|error| error.to_string())?;

    transaction
        .execute(
            r#"
            UPDATE workspaces
            SET
              active_session_id = ?2
            WHERE id = (SELECT workspace_id FROM sessions WHERE id = ?1)
            "#,
            params![conductor_session_id, conductor_session_id],
        )
        .map_err(|error| error.to_string())?;

    mark_session_read_in_transaction(&transaction, conductor_session_id)?;

    transaction.commit().map_err(|error| error.to_string())
}

fn open_fixture_write_connection() -> Result<Connection, String> {
    let db_path = resolve_fixture_db_path()?;
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;

    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|error| error.to_string())?;

    Ok(connection)
}

fn current_timestamp_string() -> Result<String, String> {
    let connection = Connection::open_in_memory().map_err(|error| error.to_string())?;
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())
}

fn resolve_binary_path(binary_name: &str) -> Result<PathBuf, String> {
    let env_key = match binary_name {
        "claude" => "HELMOR_CLAUDE_BIN",
        "codex" => "HELMOR_CODEX_BIN",
        _ => return Err(format!("Unsupported binary: {binary_name}")),
    };

    if let Some(explicit_path) = env::var_os(env_key)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Ok(explicit_path);
    }

    if let Some(path_candidate) = search_path(binary_name) {
        return Ok(path_candidate);
    }

    let home_dir = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| format!("Unable to resolve HOME while locating {binary_name}."))?;

    let fallback_candidates = match binary_name {
        "claude" => vec![home_dir.join(".local/bin/claude")],
        "codex" => vec![home_dir.join("Library/pnpm/codex")],
        _ => Vec::new(),
    };

    fallback_candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!(
                "Unable to locate {binary_name}. Set {env_key} or add it to PATH before sending."
            )
        })
}

fn search_path(binary_name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;

    env::split_paths(&paths)
        .map(|directory| directory.join(binary_name))
        .find(|candidate| candidate.is_file())
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

fn format_process_failure(name: &str, stderr: &[u8], exit_code: Option<i32>) -> String {
    let stderr_text = String::from_utf8_lossy(stderr).trim().to_string();

    if stderr_text.is_empty() {
        match exit_code {
            Some(code) => format!("{name} exited with status {code}."),
            None => format!("{name} exited unsuccessfully."),
        }
    } else {
        format!("{name} failed: {stderr_text}")
    }
}
