//! Minimal streaming client for OpenAI's Responses API targeted at the
//! voice planner's needs.
//!
//! We deliberately do NOT depend on `async-openai` here. The Responses
//! API surface we exercise is tiny (one POST, SSE response with a
//! handful of event types we care about), and pulling in the full crate
//! would lock us to whichever Responses fields it knows about today.
//! reqwest + a small SSE line parser is ~150 lines and gives us a clear
//! diff if OpenAI ships a new field.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

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
    /// `response.created` — first event in any stream. Carries the
    /// server-side response id we'll need to send back in the next
    /// turn's `previous_response_id` for tool-result continuation.
    ResponseCreated { id: String },
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

/// Tool result we send back on a continuation POST so the planner can
/// keep going after we executed its function_call. The call_id MUST
/// match what was emitted in the prior turn's `FunctionCallStarted`.
#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub call_id: String,
    /// Output text. OpenAI expects a string — we serialise the
    /// `VoiceToolEnvelope.data` to JSON and put it here.
    pub output: String,
}

/// Stream a Responses turn with `tools` declared. The system + user
/// messages are passed in; we don't reconstruct conversation history
/// here — that's the planner's job.
///
/// Returns a receiver that yields parsed events until the stream ends
/// or `cancel` is fired. The HTTP request itself is racing the cancel
/// token: dropping the receiver after cancel propagates to the underlying
/// reqwest stream.
/// Initiate a planner turn or continue an agent loop. Pass
/// `previous_response_id` + `tool_outputs` together to continue a
/// prior turn (the system_prompt + user_text are then ignored —
/// OpenAI threads the conversation server-side). Pass them both as
/// `None` to start fresh from `user_text`.
#[allow(clippy::too_many_arguments)]
pub async fn stream_responses_turn(
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_text: &str,
    tools: Vec<ToolDecl>,
    previous_response_id: Option<&str>,
    tool_outputs: Vec<ToolOutput>,
    cancel: CancellationToken,
) -> Result<mpsc::Receiver<StreamEvent>> {
    // Two POST shapes:
    //   * Initial — system + user as input messages.
    //   * Continuation — previous_response_id + function_call_output
    //     items in input. OpenAI re-uses the cached conversation state
    //     server-side, so we don't re-send the prompt / tools either,
    //     but we DO re-send the tools list (the Responses API requires
    //     it on every call). The system prompt is implicit via
    //     previous_response_id.
    let input: Vec<Value> = if previous_response_id.is_some() {
        tool_outputs
            .iter()
            .map(|out| {
                json!({
                    "type": "function_call_output",
                    "call_id": out.call_id,
                    "output": out.output,
                })
            })
            .collect()
    } else {
        vec![
            json!({ "role": "system", "content": system_prompt }),
            json!({ "role": "user", "content": user_text }),
        ]
    };
    let mut body = json!({
        "model": model,
        "input": input,
        "tools": tools,
        "stream": true,
        // `medium` effort: gives `gpt-5.4-mini` enough reasoning depth
        // to pick the right tool from the planner's 21-strong catalog
        // (and to chain say → tool → final correctly), at the cost of
        // ~500–1000ms extra latency vs `minimal`. We accept the wait
        // — the alternative is the model picking wrong tools or
        // skipping `final`, which is a worse UX than a slightly later
        // first byte.
        "reasoning": { "effort": "medium" },
        // Cap output so the planner can't accidentally burn an entire
        // TPM bucket on one turn. say/final replies are tiny by design.
        "max_output_tokens": 1024,
        // Leave `parallel_tool_calls` + `tool_choice` at defaults.
        // We tolerate two model behaviours via the SSE parser:
        //   * model calls `final(text)` (preferred) — voiced directly.
        //   * model emits a plain text response — the parser hoists it
        //     into a synthetic Final event so the turn still completes.
        // `tool_choice: required` was tried and caused over-tooling:
        // `gpt-5-mini` started calling `list_repos`/`list_workspaces`
        // on trivial knowledge questions just to satisfy the constraint.
    });
    // Continuation: thread the prior server-side state by id rather
    // than resending the full conversation.
    if let Some(prev) = previous_response_id {
        body["previous_response_id"] = Value::String(prev.to_string());
    }

    let http = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .context("build planner HTTP client")?;

    let body_bytes = serde_json::to_vec(&body)
        .map(|b| b.len())
        .unwrap_or_default();
    let send_started = std::time::Instant::now();
    tracing::info!(
        target: "planner::http",
        model = %model,
        user_chars = user_text.chars().count(),
        tools_count = tools.len(),
        body_bytes,
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
    let send_elapsed_ms = send_started.elapsed().as_millis();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "planner stream open failed ({status}): {}",
            truncate(&body, 500)
        ));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    tracing::info!(
        target: "planner::http",
        status = %status.as_u16(),
        send_elapsed_ms = %send_elapsed_ms,
        content_type = %content_type,
        "← response headers received; entering SSE pump"
    );

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
    // Output-item-id → call_id. The Responses API tags a function_call
    // item with TWO ids: a stable `item.id` (e.g. `fc_…`) and the
    // tool-call `item.call_id` (e.g. `call_…`). Downstream events like
    // `response.function_call_arguments.done` only carry the FORMER on
    // current `gpt-5` snapshots, so we have to translate before
    // emitting to keep the consumer's lookup keyed by `call_id`.
    let mut item_to_call: HashMap<String, String> = HashMap::new();
    let stream_started = std::time::Instant::now();
    let mut first_byte_seen = false;
    let mut chunk_count: u32 = 0;
    let mut frame_count: u32 = 0;

    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => {
                tracing::info!(
                    target: "planner::http",
                    chunks = chunk_count,
                    frames = frame_count,
                    elapsed_ms = %stream_started.elapsed().as_millis(),
                    "cancel token fired — closing SSE stream"
                );
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
                tracing::debug!(
                    target: "planner::http",
                    chunks = chunk_count,
                    frames = frame_count,
                    elapsed_ms = %stream_started.elapsed().as_millis(),
                    "SSE stream closed by server"
                );
                return Ok(());
            }
            Err(_) => {
                return Err(anyhow!(
                    "SSE read stalled for {}s — closing",
                    READ_TIMEOUT.as_secs()
                ));
            }
        };

        chunk_count = chunk_count.saturating_add(1);
        if !first_byte_seen {
            first_byte_seen = true;
            tracing::info!(
                target: "planner::http",
                ttfb_ms = %stream_started.elapsed().as_millis(),
                first_chunk_bytes = chunk.len(),
                "first SSE chunk received"
            );
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // SSE frames are separated by blank lines. Drain complete frames
        // from the buffer; leave any partial trailer for the next chunk.
        while let Some(idx) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..idx + 2).collect();
            frame_count = frame_count.saturating_add(1);
            process_frame(&frame, &mut last_event, &mut item_to_call, &tx).await;
        }
    }
}

async fn process_frame(
    frame: &str,
    last_event: &mut Option<String>,
    item_to_call: &mut HashMap<String, String>,
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
        "response.created" => {
            // Carry the server response id out so the agent loop can
            // use it as `previous_response_id` on the continuation POST.
            // Without this, OpenAI starts a fresh turn each iteration
            // and loses the system prompt + tool history.
            if let Some(id) = value
                .get("response")
                .and_then(|r| r.get("id"))
                .and_then(Value::as_str)
            {
                let _ = tx
                    .send(StreamEvent::ResponseCreated { id: id.to_string() })
                    .await;
            }
        }
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
            // `item.id` is the *output item* identifier (e.g. `fc_…`).
            // Later `…arguments.done` events reference it as `item_id`
            // without echoing `call_id`, so we cache the mapping now to
            // translate on the way out.
            let item_id = item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if name.is_empty() || call_id.is_empty() {
                return;
            }
            if !item_id.is_empty() {
                item_to_call.insert(item_id, call_id.clone());
            }
            tracing::debug!(
                target: "planner::stream",
                name = %name,
                call_id = %call_id,
                "function_call output item registered"
            );
            let _ = tx
                .send(StreamEvent::FunctionCallStarted { name, call_id })
                .await;
        }
        "response.function_call_arguments.done" => {
            // Prefer an explicit `call_id` if the server starts sending
            // it again; otherwise resolve via the item-id mapping built
            // at `output_item.added` time. Falls through to the raw
            // `item_id` only as a last resort so a totally unmapped
            // event still produces a diagnostic in the consumer rather
            // than vanishing silently.
            let raw_call_id = value.get("call_id").and_then(Value::as_str);
            let raw_item_id = value.get("item_id").and_then(Value::as_str);
            let call_id = match (raw_call_id, raw_item_id) {
                (Some(cid), _) if !cid.is_empty() => cid.to_string(),
                (_, Some(item_id)) => item_to_call
                    .get(item_id)
                    .cloned()
                    .unwrap_or_else(|| item_id.to_string()),
                _ => String::new(),
            };
            let arguments = value
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if call_id.is_empty() {
                tracing::warn!(
                    target: "planner::stream",
                    "function_call_arguments.done without resolvable id — dropping"
                );
                return;
            }
            tracing::debug!(
                target: "planner::stream",
                call_id = %call_id,
                arg_chars = arguments.chars().count(),
                "function_call arguments resolved"
            );
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
        "response.output_text.done" => {
            // Tolerance path: `gpt-5-mini` with `minimal` reasoning
            // sometimes ignores the "wrap your answer in `final`" rule
            // and emits the answer as a plain text response. Voicing
            // nothing in that case leaves the user with the fallback
            // apology — which is a worse experience than just speaking
            // the text. We hoist the text into a synthetic Final by
            // emitting it as if it were a `final` function call.
            //
            // The consumer in `mod.rs` already has a `said_final` guard,
            // so if a real `final` also lands this is benign duplicate.
            if let Some(text) = value.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    tracing::info!(
                        target: "planner::stream",
                        text = %truncate(trimmed, 240),
                        "hoisting plain-text output into synthetic Final"
                    );
                    // Synthesize the same shape a real `final` call
                    // would produce so the downstream state machine
                    // doesn't need to special-case this.
                    let synthetic_call_id = format!("synth-final-{}", Uuid::new_v4());
                    let _ = tx
                        .send(StreamEvent::FunctionCallStarted {
                            name: "final".to_string(),
                            call_id: synthetic_call_id.clone(),
                        })
                        .await;
                    let args = serde_json::json!({ "text": trimmed }).to_string();
                    let _ = tx
                        .send(StreamEvent::FunctionCallArgs {
                            call_id: synthetic_call_id,
                            arguments: args,
                        })
                        .await;
                }
            }
        }
        other => {
            // Quiet trace for everything else (deltas, reasoning, etc.)
            // — useful when something new shows up in a server-side API
            // change. Logged at debug so it doesn't flood normal runs.
            tracing::debug!(
                target: "planner::stream",
                event_type = %other,
                "unhandled SSE event"
            );
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    let mut iter = s.chars();
    let head: String = iter.by_ref().take(max).collect();
    if iter.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn drain(rx: &mut mpsc::Receiver<StreamEvent>) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        let _ = rx;
        events
    }

    /// Reproduces the live `gpt-5` SSE pattern that broke Phase-1:
    /// `output_item.added` carries both `id` (item id, `fc_…`) and
    /// `call_id` (tool-call id, `call_…`), but `function_call_arguments.done`
    /// only carries `item_id`. The parser must translate the latter
    /// back to the former so the consumer's name lookup hits.
    #[tokio::test]
    async fn arguments_done_resolves_item_id_to_call_id() {
        let (tx, mut rx) = mpsc::channel::<StreamEvent>(8);
        let mut last_event: Option<String> = None;
        let mut item_to_call: HashMap<String, String> = HashMap::new();

        let added = "event: response.output_item.added\n\
                     data: {\"type\":\"response.output_item.added\",\
                     \"item\":{\"type\":\"function_call\",\
                     \"id\":\"fc_abc\",\"call_id\":\"call_xyz\",\
                     \"name\":\"say\"}}\n\n";
        process_frame(added, &mut last_event, &mut item_to_call, &tx).await;

        let done = "event: response.function_call_arguments.done\n\
                    data: {\"type\":\"response.function_call_arguments.done\",\
                    \"item_id\":\"fc_abc\",\
                    \"arguments\":\"{\\\"text\\\":\\\"hello\\\"}\"}\n\n";
        process_frame(done, &mut last_event, &mut item_to_call, &tx).await;

        let events = drain(&mut rx).await;
        assert_eq!(events.len(), 2, "expected start + args, got {events:?}");
        match &events[0] {
            StreamEvent::FunctionCallStarted { name, call_id } => {
                assert_eq!(name, "say");
                assert_eq!(call_id, "call_xyz");
            }
            other => panic!("expected FunctionCallStarted, got {other:?}"),
        }
        match &events[1] {
            StreamEvent::FunctionCallArgs { call_id, arguments } => {
                assert_eq!(
                    call_id, "call_xyz",
                    "arguments.done's item_id must translate back to the tool call_id"
                );
                assert_eq!(arguments, "{\"text\":\"hello\"}");
            }
            other => panic!("expected FunctionCallArgs, got {other:?}"),
        }
    }

    /// Forward-compatible: if a future API revision starts echoing
    /// `call_id` directly on `arguments.done`, we still honor it
    /// without needing the lookup table.
    #[tokio::test]
    async fn arguments_done_honors_explicit_call_id() {
        let (tx, mut rx) = mpsc::channel::<StreamEvent>(8);
        let mut last_event: Option<String> = None;
        let mut item_to_call: HashMap<String, String> = HashMap::new();

        let done = "event: response.function_call_arguments.done\n\
                    data: {\"type\":\"response.function_call_arguments.done\",\
                    \"call_id\":\"call_direct\",\
                    \"arguments\":\"{\\\"text\\\":\\\"hi\\\"}\"}\n\n";
        process_frame(done, &mut last_event, &mut item_to_call, &tx).await;

        let events = drain(&mut rx).await;
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::FunctionCallArgs { call_id, .. } => {
                assert_eq!(call_id, "call_direct");
            }
            other => panic!("expected FunctionCallArgs, got {other:?}"),
        }
    }
}
