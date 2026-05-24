//! Thin HTTP client for the Executor daemon REST API.
//!
//! Executor exposes a typed Effect HttpApi at `/api/*`. Helmor only needs
//! a handful of endpoints (list / add / remove sources). All requests
//! authenticate as `executor:<password>` via HTTP Basic, where the password
//! is the random UUID we generated at spawn time.
//!
//! Uses the async `reqwest::Client`. `reqwest::blocking::Client` is NOT safe
//! here — it owns its own embedded tokio runtime, and dropping it from a
//! tokio worker thread (which is what `tauri::async_runtime::spawn_blocking`
//! puts us on) panics with "Cannot drop a runtime in a context where
//! blocking is not allowed". The async client routes through the parent
//! tokio runtime directly and has no such restriction.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::Engine;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// One-shot fetch of executor's current scope id via `GET /api/scope`.
///
/// Standalone (not a method on `ExecutorClient`) because `ExecutorClient`
/// needs the scope id at construction time — we'd have a chicken-and-egg
/// otherwise. `ManagedExecutor::start` calls this once after `ready`,
/// then constructs the long-lived `ExecutorClient` with the result.
pub async fn discover_scope_id(base_url: &str, auth_password: &str) -> Result<String> {
    let auth_token =
        base64::engine::general_purpose::STANDARD.encode(format!("executor:{auth_password}"));
    let auth_header = format!("Basic {auth_token}");
    let url = format!("{base_url}/api/scope");

    tracing::debug!(target: "executor::http", op = "discover_scope_id", url = %url, "→ GET");
    let start = Instant::now();
    let http = Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .expect("async reqwest client should build");
    let response = http
        .get(&url)
        .header("Authorization", &auth_header)
        .header("Accept", "application/json")
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    let status = response.status();
    let elapsed_ms = start.elapsed().as_millis() as u64;
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!(
            "executor discover_scope_id failed ({status}): {}",
            truncate(&body, 400)
        );
    }
    let value: Value = response
        .json()
        .await
        .context("decode executor /scope response")?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("/scope response missing `id` field"))?
        .to_string();
    tracing::info!(
        target: "executor::http",
        op = "discover_scope_id",
        elapsed_ms,
        scope_id = %id,
        "← discovered scope_id"
    );
    Ok(id)
}

pub struct ExecutorClient {
    base_url: String,
    auth_header: String,
    /// Executor's real scope id — looked up via `GET /api/scope` at
    /// daemon-start time. Executor generates it as
    /// `executor-${sha256(scope_dir).slice(0,8)}` per startup; it is
    /// **not** the literal string `"default"`. POSTs that put `"default"`
    /// in `targetScope` body field or `:scopeId` URL slot get a generic
    /// `500 InternalError` because the scope is unknown.
    scope_id: String,
    http: Client,
}

impl ExecutorClient {
    pub fn new(base_url: String, auth_password: String, scope_id: String) -> Self {
        let auth_token =
            base64::engine::general_purpose::STANDARD.encode(format!("executor:{auth_password}"));
        let auth_header = format!("Basic {auth_token}");
        let http = Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .expect("async reqwest client should build");
        Self {
            base_url,
            auth_header,
            scope_id,
            http,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn scope_id(&self) -> &str {
        &self.scope_id
    }

    /// Add a stdio MCP source. Used to inject the default `helmor-cli mcp`
    /// source on startup as well as user-added stdio sources.
    pub async fn add_stdio_source(&self, req: AddStdioSourceReq<'_>) -> Result<McpSourceRow> {
        let url = format!("{}/api/scopes/{}/mcp/sources", self.base_url, self.scope_id);
        tracing::info!(
            target: "executor::http",
            op = "add_stdio_source",
            name = req.name,
            command = req.command,
            args_count = req.args.len(),
            env_count = req.env.map(|m| m.len()).unwrap_or(0),
            namespace = ?req.namespace,
            "→ POST add stdio source"
        );
        let body = serde_json::json!({
            "transport": "stdio",
            "name": req.name,
            "command": req.command,
            "args": req.args,
            "env": req.env,
            "targetScope": self.scope_id,
            "namespace": req.namespace,
        });
        self.post("add_stdio_source", &url, &body).await
    }

    /// Add a remote (Streamable HTTP / SSE) MCP source. `headers` are
    /// forwarded verbatim; `auth_token` is rendered as
    /// `Authorization: Bearer <token>`.
    pub async fn add_remote_source(&self, req: AddRemoteSourceReq<'_>) -> Result<McpSourceRow> {
        let url = format!("{}/api/scopes/{}/mcp/sources", self.base_url, self.scope_id);

        // Compose headers map: explicit headers + optional Bearer token.
        let mut headers: HashMap<String, String> = req.headers.cloned().unwrap_or_default();
        let bearer_present = req.auth_token.is_some();
        if let Some(token) = req.auth_token {
            headers
                .entry("Authorization".to_string())
                .or_insert(format!("Bearer {token}"));
        }
        tracing::info!(
            target: "executor::http",
            op = "add_remote_source",
            name = req.name,
            endpoint = req.endpoint,
            bearer = bearer_present,
            header_count = headers.len(),
            namespace = ?req.namespace,
            "→ POST add remote source"
        );

        let body = serde_json::json!({
            "transport": "remote",
            "name": req.name,
            "endpoint": req.endpoint,
            "headers": headers,
            "targetScope": self.scope_id,
            "namespace": req.namespace,
        });
        self.post("add_remote_source", &url, &body).await
    }

    /// Trigger executor to re-discover an MCP source's tool catalog.
    ///
    /// `POST /api/scopes/<default>/sources/:id/refresh` — executor re-spawns
    /// the stdio child (or re-connects to the remote endpoint), calls
    /// `client.listTools()`, and **atomically replaces** the tool catalog
    /// in its sqlite. Idempotent. The HTTP response body shape is not
    /// documented as stable, so we return `()` on 2xx; callers that need
    /// the updated tool count should call `list_sources()` immediately
    /// after.
    ///
    /// Useful after a user manually updates an MCP source, so tool catalog
    /// changes show up without wiping `~/helmor-dev/executor/`.
    pub async fn refresh_source(&self, source_id: &str) -> Result<()> {
        let url = format!(
            "{}/api/scopes/{}/sources/{}/refresh",
            self.base_url, self.scope_id, source_id
        );
        tracing::info!(
            target: "executor::http",
            op = "refresh_source",
            source_id,
            "→ POST refresh source"
        );
        let start = Instant::now();
        let response = self
            .http
            .post(&url)
            .header("Authorization", &self.auth_header)
            .header("Accept", "application/json")
            // Empty body — executor's `refresh` endpoint takes no payload.
            .json(&serde_json::json!({}))
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        let status = response.status();
        let elapsed_ms = start.elapsed().as_millis() as u64;
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(
                target: "executor::http",
                op = "refresh_source",
                source_id,
                %status,
                elapsed_ms,
                body_preview = %truncate(&body, 400),
                "refresh_source failed"
            );
            anyhow::bail!("executor refresh_source failed ({status}): {body}");
        }
        // Drain body for connection reuse — we don't parse it.
        let _ = response.text().await;
        tracing::info!(
            target: "executor::http",
            op = "refresh_source",
            source_id,
            %status,
            elapsed_ms,
            "← refresh_source ok"
        );
        Ok(())
    }

    /// List MCP sources for the default scope.
    ///
    /// Executor's `/sources` endpoint does **not** return tool counts
    /// (schema: `{id, scopeId, name, kind, url, runtime, canRemove, ...}`).
    /// To fill `tool_count` we fan-out a `GET /sources/:id/tools` per
    /// source in parallel. With ~5 sources this adds ≤300ms over the base
    /// list call; with hundreds of sources we'd need pagination, but MVP
    /// is fine.
    pub async fn list_sources(&self) -> Result<Vec<McpSourceRow>> {
        let url = format!("{}/api/scopes/{}/sources", self.base_url, self.scope_id);
        tracing::debug!(target: "executor::http", op = "list_sources", url = %url, "→ GET");
        let start = Instant::now();
        let response = self
            .http
            .get(&url)
            .header("Authorization", &self.auth_header)
            .header("Accept", "application/json")
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        let status = response.status();
        let elapsed_ms = start.elapsed().as_millis() as u64;
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(
                target: "executor::http",
                op = "list_sources",
                %status,
                elapsed_ms,
                body_len = body.len(),
                body_preview = %truncate(&body, 400),
                "list_sources failed"
            );
            anyhow::bail!("executor list_sources failed ({status}): {body}");
        }
        let value: Value = response
            .json()
            .await
            .context("decode executor list response")?;
        let mut rows = decode_sources_list(&value)?;
        tracing::debug!(
            target: "executor::http",
            op = "list_sources",
            %status,
            elapsed_ms,
            count = rows.len(),
            "← list_sources base list ok — fanning out tool counts"
        );

        // Concurrent fetch of tool counts per source.
        let count_start = Instant::now();
        let mut handles: Vec<tauri::async_runtime::JoinHandle<u32>> =
            Vec::with_capacity(rows.len());
        for row in &rows {
            let http = self.http.clone();
            let auth = self.auth_header.clone();
            let tool_url = format!(
                "{}/api/scopes/{}/sources/{}/tools",
                self.base_url, self.scope_id, row.id
            );
            let source_id_for_log = row.id.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                match http
                    .get(&tool_url)
                    .header("Authorization", &auth)
                    .header("Accept", "application/json")
                    .send()
                    .await
                {
                    Ok(r) if r.status().is_success() => match r.json::<Value>().await {
                        Ok(v) => v.as_array().map(|a| a.len() as u32).unwrap_or(0),
                        Err(e) => {
                            tracing::debug!(
                                target: "executor::http",
                                op = "fetch_tool_count",
                                source_id = %source_id_for_log,
                                error = %e,
                                "decode tools list failed"
                            );
                            0
                        }
                    },
                    Ok(r) => {
                        tracing::debug!(
                            target: "executor::http",
                            op = "fetch_tool_count",
                            source_id = %source_id_for_log,
                            status = %r.status(),
                            "tools endpoint returned non-success"
                        );
                        0
                    }
                    Err(e) => {
                        tracing::debug!(
                            target: "executor::http",
                            op = "fetch_tool_count",
                            source_id = %source_id_for_log,
                            error = %e,
                            "tools endpoint request failed"
                        );
                        0
                    }
                }
            }));
        }
        for (idx, handle) in handles.into_iter().enumerate() {
            if let Ok(count) = handle.await {
                rows[idx].tool_count = count;
            }
        }
        tracing::info!(
            target: "executor::http",
            op = "list_sources",
            %status,
            elapsed_ms,
            tool_count_elapsed_ms = count_start.elapsed().as_millis() as u64,
            count = rows.len(),
            total_tools = rows.iter().map(|r| r.tool_count).sum::<u32>(),
            "← list_sources ok"
        );
        Ok(rows)
    }

    /// Run a TypeScript snippet inside the executor sandbox (QuickJS).
    /// This is the **only** way executor exposes tool invocation over HTTP —
    /// there is no per-tool `/invoke` endpoint. The caller composes a code
    /// string that uses the sandbox's `tools.*` deep-proxy + builtin
    /// `tools.search` / `tools.describe`, and gets back the full
    /// ExecuteResponse JSON as documented by executor:
    ///
    /// - completed: `{ status: "completed", text, structured, isError }`
    /// - paused:    `{ status: "paused",    text, structured: { executionId, interaction: {...} } }`
    ///
    /// We pass the raw `serde_json::Value` straight through to the
    /// caller — it's what an agent reads to decide whether to follow up
    /// with `approve_mcp_call`.
    pub async fn execute(&self, code: &str) -> Result<Value> {
        let url = format!("{}/api/executions", self.base_url);
        // Code is ~80-400 bytes for our generated meta-tool snippets;
        // bump preview to 800 so the full call site (path + args JSON)
        // is visible in logs even for large argument objects. Code never
        // contains user PII directly — only what the model emits.
        tracing::info!(
            target: "executor::http",
            op = "execute",
            code_len = code.len(),
            code_preview = %truncate(code, 800),
            "→ POST sandbox execute"
        );
        let start = Instant::now();
        let response = self
            .http
            .post(&url)
            .header("Authorization", &self.auth_header)
            .header("Accept", "application/json")
            .json(&serde_json::json!({ "code": code }))
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let elapsed_ms = start.elapsed().as_millis() as u64;
        if !status.is_success() {
            tracing::warn!(
                target: "executor::http",
                op = "execute",
                %status,
                elapsed_ms,
                resp_preview = %truncate(&text, 800),
                "execute failed"
            );
            anyhow::bail!("executor execute failed ({status}): {text}");
        }
        let value: Value =
            serde_json::from_str(&text).with_context(|| format!("decode POST {url} response"))?;
        let result_status = value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let is_error = value
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let result_preview = summarize_execute_result(&value);
        tracing::info!(
            target: "executor::http",
            op = "execute",
            %status,
            elapsed_ms,
            execute_status = result_status,
            is_error,
            result_preview = %result_preview,
            "← execute ok"
        );
        Ok(value)
    }

    /// Resume a paused execution (after the user approves / declines an
    /// elicitation). `action`:
    /// - `"accept"` — proceed; `content` (optional) carries form data
    /// - `"decline"` — user said no, but they're still around
    /// - `"cancel"` — abort the whole execution
    pub async fn resume(
        &self,
        execution_id: &str,
        action: ResumeAction,
        content: Option<&Value>,
    ) -> Result<Value> {
        let url = format!("{}/api/executions/{}/resume", self.base_url, execution_id);
        let action_str = action.as_str();
        tracing::info!(
            target: "executor::http",
            op = "resume",
            execution_id,
            action = action_str,
            content_present = content.is_some(),
            "→ POST resume execution"
        );
        let mut body = serde_json::json!({ "action": action_str });
        if let Some(content) = content {
            body["content"] = content.clone();
        }
        let start = Instant::now();
        let response = self
            .http
            .post(&url)
            .header("Authorization", &self.auth_header)
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let elapsed_ms = start.elapsed().as_millis() as u64;
        if !status.is_success() {
            tracing::warn!(
                target: "executor::http",
                op = "resume",
                execution_id,
                %status,
                elapsed_ms,
                resp_preview = %truncate(&text, 400),
                "resume failed"
            );
            anyhow::bail!("executor resume failed ({status}): {text}");
        }
        let value: Value =
            serde_json::from_str(&text).with_context(|| format!("decode POST {url} response"))?;
        let result_preview = summarize_execute_result(&value);
        tracing::info!(
            target: "executor::http",
            op = "resume",
            execution_id,
            %status,
            elapsed_ms,
            result_preview = %result_preview,
            "← resume ok"
        );
        Ok(value)
    }

    /// Remove a source by id.
    pub async fn remove_source(&self, source_id: &str) -> Result<()> {
        let url = format!(
            "{}/api/scopes/{}/sources/{}",
            self.base_url, self.scope_id, source_id
        );
        tracing::info!(
            target: "executor::http",
            op = "remove_source",
            source_id,
            "→ DELETE"
        );
        let start = Instant::now();
        let response = self
            .http
            .delete(&url)
            .header("Authorization", &self.auth_header)
            .send()
            .await
            .with_context(|| format!("DELETE {url}"))?;
        let status = response.status();
        let elapsed_ms = start.elapsed().as_millis() as u64;
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(
                target: "executor::http",
                op = "remove_source",
                source_id,
                %status,
                elapsed_ms,
                body_preview = %truncate(&body, 400),
                "remove_source failed"
            );
            anyhow::bail!("executor remove_source failed ({status}): {body}");
        }
        tracing::info!(
            target: "executor::http",
            op = "remove_source",
            source_id,
            %status,
            elapsed_ms,
            "← remove_source ok"
        );
        Ok(())
    }

    async fn post(&self, op: &'static str, url: &str, body: &Value) -> Result<McpSourceRow> {
        let body_bytes = serde_json::to_vec(body).unwrap_or_default();
        tracing::debug!(
            target: "executor::http",
            op,
            url = %url,
            body_bytes = body_bytes.len(),
            "→ POST"
        );
        let start = Instant::now();
        let response = self
            .http
            .post(url)
            .header("Authorization", &self.auth_header)
            .header("Accept", "application/json")
            .json(body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let elapsed_ms = start.elapsed().as_millis() as u64;
        if !status.is_success() {
            tracing::warn!(
                target: "executor::http",
                op,
                %status,
                elapsed_ms,
                resp_len = text.len(),
                resp_preview = %truncate(&text, 400),
                "POST failed"
            );
            anyhow::bail!("executor request failed ({status}): {text}");
        }
        let value: Value =
            serde_json::from_str(&text).with_context(|| format!("decode POST {url} response"))?;
        let row = decode_source_row(&value);
        tracing::info!(
            target: "executor::http",
            op,
            %status,
            elapsed_ms,
            source_id = %row.id,
            source_name = %row.name,
            transport = %row.transport,
            tool_count = row.tool_count,
            "← POST ok"
        );
        Ok(row)
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut out = s[..max].to_string();
        out.push('…');
        out
    }
}

/// Build a short human-readable summary of an ExecuteResponse for logs.
///
/// We want logs to show:
/// - For `tools.search` results: how many items + the top match paths
/// - For `tools.<x>.<y>(...)` calls: the resulting `text` field truncated
/// - For paused executions: the executionId + interaction kind
///
/// Falls back to a generic stringified-JSON preview for anything we
/// can't recognize. Keeps the log line scannable without dumping the
/// entire structured result (which can be hundreds of KB for big tool
/// outputs like `list_issues`).
fn summarize_execute_result(value: &Value) -> String {
    // paused executions
    if value.get("status").and_then(Value::as_str) == Some("paused") {
        let exec_id = value
            .pointer("/structured/executionId")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let kind = value
            .pointer("/structured/interaction/kind")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let msg = value
            .pointer("/structured/interaction/message")
            .and_then(Value::as_str)
            .unwrap_or("");
        return format!(
            "paused(executionId={exec_id}, kind={kind}, message={})",
            truncate(msg, 200)
        );
    }

    // search results (tools.search): structured.result.items[]
    if let Some(items) = value
        .pointer("/structured/result/items")
        .and_then(Value::as_array)
    {
        let mut top: Vec<String> = items
            .iter()
            .take(5)
            .filter_map(|it| {
                let path = it.get("path").and_then(Value::as_str)?;
                let score = it.get("score").and_then(Value::as_f64).unwrap_or(0.0);
                Some(format!("{path}({score:.2})"))
            })
            .collect();
        if items.len() > top.len() {
            top.push(format!("+{} more", items.len() - top.len()));
        }
        return format!("search items={}: [{}]", items.len(), top.join(", "));
    }

    // Tool invocation result: structured.result is the tool's return
    // value (could be anything — string, object, array). Show the
    // top-level shape and a text preview.
    if let Some(result) = value.pointer("/structured/result") {
        let kind = match result {
            Value::Null => "null".to_string(),
            Value::Bool(_) => "bool".to_string(),
            Value::Number(_) => "number".to_string(),
            Value::String(s) => format!("string({} chars)", s.len()),
            Value::Array(a) => format!("array({})", a.len()),
            Value::Object(o) => format!("object({} keys)", o.len()),
        };
        let serialized = serde_json::to_string(result).unwrap_or_default();
        return format!("result={kind}: {}", truncate(&serialized, 500));
    }

    // Tool error in completed mode
    if value
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        if let Some(text) = value.get("text").and_then(Value::as_str) {
            return format!("error: {}", truncate(text, 400));
        }
    }

    // Fallback to top-level text field
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return format!("text: {}", truncate(text, 400));
    }

    // Last resort: stringify the whole thing
    truncate(&value.to_string(), 400)
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Action for `POST /executions/:id/resume`. Mirrors executor's
/// `ResumeRequest.action` literal.
#[derive(Debug, Clone, Copy)]
pub enum ResumeAction {
    Accept,
    Decline,
    Cancel,
}

impl ResumeAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
        }
    }

    /// Parse from the LLM-supplied tool argument string. Accept the
    /// canonical names plus a couple of common natural-language variants
    /// the model might emit ("approve" ≈ accept, "deny" ≈ decline) so we
    /// don't fail the call on minor phrasing differences.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "accept" | "approve" | "yes" | "ok" => Some(Self::Accept),
            "decline" | "deny" | "no" | "reject" => Some(Self::Decline),
            "cancel" | "abort" => Some(Self::Cancel),
            _ => None,
        }
    }
}

pub struct AddStdioSourceReq<'a> {
    pub name: &'a str,
    pub command: &'a str,
    pub args: &'a [String],
    pub env: Option<&'a HashMap<String, String>>,
    pub namespace: Option<&'a str>,
}

pub struct AddRemoteSourceReq<'a> {
    pub name: &'a str,
    pub endpoint: &'a str,
    pub headers: Option<&'a HashMap<String, String>>,
    pub auth_token: Option<&'a str>,
    pub namespace: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSourceRow {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub namespace: Option<String>,
    pub tool_count: u32,
    pub status: String,
    pub is_default: bool,
}

/// Decode an executor `/sources` row.
///
/// The wire shape we read (see executor `SourceResponse`):
///   `{ id, scopeId?, name, kind, url?, runtime?, canRemove?, canRefresh?,
///      canEdit? }`
///
/// Notes:
/// - `transport` is mapped from `kind` (executor's identifier — `mcp`,
///   `openapi`, `executor` for built-in, etc.).
/// - `namespace` isn't in the list response; populated on POST (add).
/// - `tool_count` is filled in by `list_sources`'s fan-out, not here.
/// - `status` is synthesised: `ready` unless `runtime: true` (built-in).
fn decode_source_row(value: &Value) -> McpSourceRow {
    let obj = value.as_object();
    let read_str = |key: &str| -> String {
        obj.and_then(|m| m.get(key))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let read_opt_str = |key: &str| -> Option<String> {
        obj.and_then(|m| m.get(key))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    let id = read_str("id");
    let name = {
        let n = read_str("name");
        if n.is_empty() {
            read_str("displayName")
        } else {
            n
        }
    };
    let transport = read_str("kind");
    let namespace = read_opt_str("namespace").filter(|s| !s.is_empty());
    let runtime = obj
        .and_then(|m| m.get("runtime"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let status = if runtime { "built-in" } else { "ready" }.to_string();
    let is_default = runtime;

    McpSourceRow {
        id,
        name,
        transport,
        namespace,
        // Populated by `list_sources`. On POST responses this stays 0 — the
        // caller refetches the full list anyway and the fan-out fills it.
        tool_count: 0,
        status,
        is_default,
    }
}

fn decode_sources_list(value: &Value) -> Result<Vec<McpSourceRow>> {
    // Accept either a bare array or `{ items: [...] }` wrapper.
    let items: &Vec<Value> = if value.is_array() {
        value.as_array().unwrap()
    } else if let Some(items) = value.get("items").and_then(|v| v.as_array()) {
        items
    } else if let Some(items) = value.get("sources").and_then(|v| v.as_array()) {
        items
    } else {
        anyhow::bail!(
            "unexpected executor sources response shape: {}",
            serde_json::to_string(value).unwrap_or_default()
        );
    };
    Ok(items.iter().map(decode_source_row).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_array_payload_with_executor_schema() {
        // Mirrors the actual executor `/sources` response: { id, name, kind,
        // runtime? }. `tool_count` is filled in by `list_sources` later, so
        // decode_source_row leaves it at 0.
        let payload = json!([
            { "id": "s1", "name": "Helmor", "kind": "mcp", "runtime": false },
            { "id": "s2", "name": "Built-in", "kind": "executor", "runtime": true }
        ]);
        let rows = decode_sources_list(&payload).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "Helmor");
        assert_eq!(rows[0].transport, "mcp");
        assert_eq!(rows[0].status, "ready");
        assert!(!rows[0].is_default);
        assert_eq!(rows[1].transport, "executor");
        assert_eq!(rows[1].status, "built-in");
        assert!(rows[1].is_default);
        // tool_count starts at 0; list_sources fills it via /sources/:id/tools
        assert_eq!(rows[0].tool_count, 0);
    }

    #[test]
    fn decodes_items_wrapper() {
        let payload = json!({ "items": [{ "id": "x", "name": "X", "kind": "openapi" }] });
        let rows = decode_sources_list(&payload).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "x");
        assert_eq!(rows[0].transport, "openapi");
    }

    #[test]
    fn auth_header_is_basic_with_executor_user() {
        let client = ExecutorClient::new(
            "http://127.0.0.1:1234".into(),
            "secret".into(),
            "executor-test".into(),
        );
        // `executor:secret` → ZXhlY3V0b3I6c2VjcmV0
        assert_eq!(client.auth_header, "Basic ZXhlY3V0b3I6c2VjcmV0");
    }
}
