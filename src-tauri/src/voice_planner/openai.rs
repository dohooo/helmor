//! Minimal streaming client for OpenAI's Responses API targeted at the
//! voice planner's needs.
//!
//! We deliberately do NOT depend on `async-openai` here. The Responses
//! API surface we exercise is tiny (one POST, SSE response with a
//! handful of event types we care about), and pulling in the full crate
//! would lock us to whichever Responses fields it knows about today.
//! reqwest + a small SSE line parser is ~150 lines and gives us a clear
//! diff if OpenAI ships a new field.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);
/// SSE lines are small; the upper bound keeps us safe against a stuck
/// server holding the connection open without sending events.
const READ_TIMEOUT: Duration = Duration::from_secs(120);

/// Function tool declaration sent to the Responses API.
#[derive(Debug, Clone, Serialize)]
pub struct ToolDecl {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

/// Single parsed event off the stream. We only narrow on the variants
/// the planner state machine reacts to; everything else is dropped at
/// parse time so the consumer doesn't need a giant exhaustive match.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// `response.output_item.added` for a function_call item. Carries
    /// `name` and `call_id` — arguments arrive later as deltas.
    FunctionCallStarted { name: String, call_id: String },
    /// `response.function_call_arguments.done` — canonical full JSON
    /// string of arguments. We prefer this over delta accumulation.
    FunctionCallArgs { call_id: String, arguments: String },
    /// `response.completed` — final usage block included when present.
    Completed { usage: Option<Value> },
    /// `response.failed` / `error` — surface the error message so the
    /// planner can decide what to tell the user.
    Failed { message: String },
}

/// Stream a Responses turn with `tools` declared. The system + user
/// messages are passed in; we don't reconstruct conversation history
/// here — that's the planner's job.
///
/// Returns a receiver that yields parsed events until the stream ends
/// or `cancel` is fired. The HTTP request itself is racing the cancel
/// token: dropping the receiver after cancel propagates to the underlying
/// reqwest stream.
pub async fn stream_responses_turn(
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_text: &str,
    tools: Vec<ToolDecl>,
    cancel: CancellationToken,
) -> Result<mpsc::Receiver<StreamEvent>> {
    let body = json!({
        "model": model,
        "input": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_text },
        ],
        "tools": tools,
        "stream": true,
        // We rely on the model to decide when to stop. `parallel_tool_calls`
        // is left at the default; Phase 1 expects say×N + final, all in one
        // response, sequential or parallel is fine.
    });

    let http = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .context("build planner HTTP client")?;

    tracing::info!(
        target: "planner::http",
        model = %model,
        user_chars = user_text.chars().count(),
        "→ POST /v1/responses (stream)"
    );

    let response = http
        .post(RESPONSES_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .json(&body)
        .send()
        .await
        .context("POST /v1/responses")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "planner stream open failed ({status}): {}",
            truncate(&body, 500)
        ));
    }

    let (tx, rx) = mpsc::channel(64);
    tokio::spawn(async move {
        if let Err(e) = drive_sse(response, tx.clone(), cancel).await {
            tracing::warn!(target: "planner::http", error = %format!("{e:#}"), "SSE pump terminated with error");
            let _ = tx
                .send(StreamEvent::Failed {
                    message: format!("{e:#}"),
                })
                .await;
        }
    });

    Ok(rx)
}

async fn drive_sse(
    response: reqwest::Response,
    tx: mpsc::Sender<StreamEvent>,
    cancel: CancellationToken,
) -> Result<()> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut last_event: Option<String> = None;

    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => {
                tracing::info!(target: "planner::http", "cancel token fired — closing SSE stream");
                return Ok(());
            }
            chunk = tokio::time::timeout(READ_TIMEOUT, stream.next()) => chunk,
        };

        let chunk = match next {
            Ok(Some(Ok(bytes))) => bytes,
            Ok(Some(Err(e))) => {
                return Err(anyhow!("SSE chunk read failed: {e:#}"));
            }
            Ok(None) => {
                // Stream ended.
                tracing::debug!(target: "planner::http", "SSE stream closed by server");
                return Ok(());
            }
            Err(_) => {
                return Err(anyhow!(
                    "SSE read stalled for {}s — closing",
                    READ_TIMEOUT.as_secs()
                ));
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // SSE frames are separated by blank lines. Drain complete frames
        // from the buffer; leave any partial trailer for the next chunk.
        while let Some(idx) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..idx + 2).collect();
            process_frame(&frame, &mut last_event, &tx).await;
        }
    }
}

async fn process_frame(
    frame: &str,
    last_event: &mut Option<String>,
    tx: &mpsc::Sender<StreamEvent>,
) {
    let mut data_lines: Vec<&str> = Vec::new();
    for line in frame.lines() {
        if let Some(rest) = line.strip_prefix("event:") {
            *last_event = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim_start());
        }
    }
    if data_lines.is_empty() {
        return;
    }
    let data = data_lines.join("\n");
    if data == "[DONE]" {
        return;
    }

    let value: Value = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!(
                target: "planner::http",
                error = %e,
                preview = %truncate(&data, 200),
                "skipping non-JSON SSE data line"
            );
            return;
        }
    };

    // Prefer the value's own `type` field — `event:` headers from OpenAI
    // already mirror it but we keep both as a belt-and-braces guard.
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| last_event.clone())
        .unwrap_or_default();

    match event_type.as_str() {
        "response.output_item.added" => {
            let item = match value.get("item") {
                Some(i) => i,
                None => return,
            };
            if item.get("type").and_then(Value::as_str) != Some("function_call") {
                return;
            }
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let call_id = item
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if name.is_empty() || call_id.is_empty() {
                return;
            }
            let _ = tx
                .send(StreamEvent::FunctionCallStarted { name, call_id })
                .await;
        }
        "response.function_call_arguments.done" => {
            let call_id = value
                .get("call_id")
                .or_else(|| value.get("item_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let arguments = value
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if call_id.is_empty() {
                return;
            }
            let _ = tx
                .send(StreamEvent::FunctionCallArgs { call_id, arguments })
                .await;
        }
        "response.completed" => {
            let usage = value.get("response").and_then(|r| r.get("usage")).cloned();
            let _ = tx.send(StreamEvent::Completed { usage }).await;
        }
        "response.failed" | "error" => {
            let message = value
                .get("response")
                .and_then(|r| r.get("error"))
                .or_else(|| value.get("error"))
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown planner error")
                .to_string();
            let _ = tx.send(StreamEvent::Failed { message }).await;
        }
        _ => {
            // Other event types: response.created, output_text.delta,
            // reasoning.delta, etc. We don't act on them in Phase 1.
        }
    }
}

#[derive(Debug, Deserialize)]
struct _Unused;

fn truncate(s: &str, max: usize) -> String {
    let mut iter = s.chars();
    let head: String = iter.by_ref().take(max).collect();
    if iter.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}
