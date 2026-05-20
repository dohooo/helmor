//! Tauri commands for the Settings → MCP panel and the Studio window.
//!
//! Thin wrappers over `executor_studio::ManagedExecutor` + its async HTTP
//! client. Spawn / shutdown of the executor child process are blocking
//! (they wait on stdout / process exit), so they go through
//! `run_blocking`. HTTP calls use the async `reqwest::Client` directly —
//! see the note in `executor_studio::client` for why blocking reqwest is
//! unsafe here.

use std::collections::HashMap;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::commands::common::{run_blocking, CmdResult};
use crate::data_dir;
use crate::executor_studio::{
    client::{AddRemoteSourceReq, AddStdioSourceReq},
    ExecutorStatus, ManagedExecutor, McpSourceRow,
};

/// Current state + error string, surfaced via 5s polling in the panel.
#[tauri::command]
pub async fn get_executor_status(state: State<'_, ManagedExecutor>) -> CmdResult<ExecutorStatus> {
    let status = state.status();
    tracing::debug!(
        target: "executor::ipc",
        op = "get_executor_status",
        running = status.running,
        base_url = ?status.base_url,
        error = ?status.error,
        version = %status.version,
        "IPC poll"
    );
    Ok(status)
}

/// Force a stop + start.
#[tauri::command]
pub async fn restart_executor(app: AppHandle) -> CmdResult<ExecutorStatus> {
    tracing::info!(target: "executor::ipc", op = "restart_executor", "IPC start");

    // 1. shutdown + start are sync (spawn child, wait on stdout). Offload
    //    to the blocking pool so we don't stall the tokio worker.
    let app_for_blocking = app.clone();
    run_blocking(move || {
        let state = app_for_blocking.state::<ManagedExecutor>();
        let data_dir = data_dir::data_dir()?;
        state.shutdown();
        state.start(&data_dir)
    })
    .await?;

    let status = app.state::<ManagedExecutor>().status();
    tracing::info!(
        target: "executor::ipc",
        op = "restart_executor",
        running = status.running,
        base_url = ?status.base_url,
        error = ?status.error,
        "IPC end"
    );
    Ok(status)
}

/// List MCP sources (default scope). Returns [] if executor isn't running
/// rather than erroring — UI shows it as "no sources yet".
#[tauri::command]
pub async fn list_mcp_sources(state: State<'_, ManagedExecutor>) -> CmdResult<Vec<McpSourceRow>> {
    let client = state.client();
    let has_client = client.is_some();
    tracing::debug!(
        target: "executor::ipc",
        op = "list_mcp_sources",
        executor_running = has_client,
        "IPC start"
    );
    match client {
        Some(c) => {
            let rows = c.list_sources().await?;
            tracing::info!(
                target: "executor::ipc",
                op = "list_mcp_sources",
                count = rows.len(),
                "IPC end"
            );
            Ok(rows)
        }
        None => {
            tracing::warn!(
                target: "executor::ipc",
                op = "list_mcp_sources",
                "executor not running — returning empty list"
            );
            Ok(Vec::new())
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMcpSourceArgs {
    pub name: String,
    pub transport: String, // "stdio" | "remote"
    pub namespace: Option<String>,

    // stdio
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,

    // remote
    pub endpoint: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub auth_token: Option<String>,
}

#[tauri::command]
pub async fn add_mcp_source(
    args: AddMcpSourceArgs,
    state: State<'_, ManagedExecutor>,
) -> CmdResult<McpSourceRow> {
    tracing::info!(
        target: "executor::ipc",
        op = "add_mcp_source",
        name = %args.name,
        transport = %args.transport,
        namespace = ?args.namespace,
        command = ?args.command,
        args_count = args.args.as_ref().map(|v| v.len()).unwrap_or(0),
        endpoint = ?args.endpoint,
        bearer_present = args.auth_token.is_some(),
        header_count = args.headers.as_ref().map(|m| m.len()).unwrap_or(0),
        "IPC start"
    );
    let client = match state.client() {
        Some(c) => c,
        None => {
            tracing::warn!(
                target: "executor::ipc",
                op = "add_mcp_source",
                "executor not running — refusing to add source"
            );
            return Err(anyhow::anyhow!(
                "Executor is not running. Restart it from Settings → MCP first."
            )
            .into());
        }
    };

    match args.transport.as_str() {
        "stdio" => {
            let command = args
                .command
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow::anyhow!("stdio source requires `command`"))?
                .to_string();
            let arg_list = args.args.unwrap_or_default();
            let env = args.env;
            let namespace = args.namespace;
            let name = args.name;
            Ok(client
                .add_stdio_source(AddStdioSourceReq {
                    name: &name,
                    command: &command,
                    args: &arg_list,
                    env: env.as_ref(),
                    namespace: namespace.as_deref(),
                })
                .await?)
        }
        "remote" => {
            let endpoint = args
                .endpoint
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow::anyhow!("remote source requires `endpoint`"))?
                .to_string();
            let headers = args.headers;
            let auth_token = args.auth_token;
            let namespace = args.namespace;
            let name = args.name;
            Ok(client
                .add_remote_source(AddRemoteSourceReq {
                    name: &name,
                    endpoint: &endpoint,
                    headers: headers.as_ref(),
                    auth_token: auth_token.as_deref().filter(|s| !s.is_empty()),
                    namespace: namespace.as_deref(),
                })
                .await?)
        }
        other => Err(anyhow::anyhow!(
            "unsupported transport {other:?}: expected `stdio` or `remote`"
        )
        .into()),
    }
}

#[tauri::command]
pub async fn remove_mcp_source(
    source_id: String,
    state: State<'_, ManagedExecutor>,
) -> CmdResult<()> {
    tracing::info!(
        target: "executor::ipc",
        op = "remove_mcp_source",
        source_id = %source_id,
        "IPC start"
    );
    let client = match state.client() {
        Some(c) => c,
        None => {
            tracing::warn!(
                target: "executor::ipc",
                op = "remove_mcp_source",
                source_id = %source_id,
                "executor not running — no-op remove"
            );
            return Ok(());
        }
    };
    client.remove_source(&source_id).await?;
    tracing::info!(
        target: "executor::ipc",
        op = "remove_mcp_source",
        source_id = %source_id,
        "IPC end"
    );
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenStudioResult {
    pub label: String,
}

fn mcp_studio_bridge_script(base_url: &str, auth_password: &str) -> String {
    let auth_token =
        base64::engine::general_purpose::STANDARD.encode(format!("executor:{auth_password}"));
    let base_url_json =
        serde_json::to_string(base_url.trim_end_matches('/')).expect("base_url serializes");
    let auth_header_json =
        serde_json::to_string(&format!("Basic {auth_token}")).expect("auth header serializes");

    r#"
(() => {
  const executorBaseUrl = __EXECUTOR_BASE_URL__;
  const executorAuthHeader = __EXECUTOR_AUTH_HEADER__;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : null;
    if (typeof path === "string" && path.startsWith("/api/oauth/await/")) {
      const headers = new Headers(init && init.headers ? init.headers : undefined);
      headers.set("Authorization", executorAuthHeader);
      return originalFetch(new URL(path, executorBaseUrl).toString(), {
        ...init,
        headers,
      });
    }
    return originalFetch(input, init);
  };

  const existing = window.executor && typeof window.executor === "object" ? window.executor : {};
  const bridge = Object.assign({}, existing, {
    openExternal(url) {
      const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (typeof invoke !== "function") {
        return Promise.reject(new Error("Tauri invoke bridge is unavailable"));
      }
      return invoke("open_mcp_oauth_external", { url });
    },
  });
  Object.defineProperty(window, "executor", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: bridge,
  });
})();
"#
    .replace("__EXECUTOR_BASE_URL__", &base_url_json)
    .replace("__EXECUTOR_AUTH_HEADER__", &auth_header_json)
}

#[tauri::command]
pub async fn open_mcp_oauth_external(app: AppHandle, url: String) -> CmdResult<()> {
    let parsed = url::Url::parse(&url).map_err(|e| anyhow::anyhow!("parse OAuth URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(anyhow::anyhow!("unsupported OAuth URL scheme {:?}", parsed.scheme()).into());
    }

    tracing::info!(
        target: "executor::ipc",
        op = "open_mcp_oauth_external",
        url = %parsed,
        "opening Executor Studio OAuth URL in system browser"
    );
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| anyhow::anyhow!("open OAuth URL in browser: {e}"))?;
    Ok(())
}

/// Open a dedicated WebviewWindow loading the executor Studio UI. URL
/// embeds the Basic-auth credentials (`http://executor:<pwd>@127.0.0.1:<port>`)
/// so WKWebView automatically attaches the `Authorization` header — no
/// preload script required. Idempotent: focuses the existing window if it
/// already exists.
#[tauri::command]
pub async fn open_mcp_studio_window(
    app: AppHandle,
    state: State<'_, ManagedExecutor>,
) -> CmdResult<OpenStudioResult> {
    tracing::info!(
        target: "executor::ipc",
        op = "open_mcp_studio_window",
        "IPC start"
    );
    let (base_url, auth_password) = state.credentials().ok_or_else(|| {
        tracing::warn!(
            target: "executor::ipc",
            op = "open_mcp_studio_window",
            "executor not running — refusing to open Studio"
        );
        anyhow::anyhow!("Executor is not running. Wait for it to start, or click Restart.")
    })?;
    tracing::debug!(
        target: "executor::ipc",
        op = "open_mcp_studio_window",
        base_url = %base_url,
        password_present = !auth_password.is_empty(),
        "step 1/4: credentials snapshot acquired"
    );

    if let Some(existing) = app.get_webview_window("mcp-studio") {
        tracing::info!(
            target: "executor::ipc",
            op = "open_mcp_studio_window",
            "Studio window already exists — focusing"
        );
        existing
            .set_focus()
            .map_err(|e| anyhow::anyhow!("focus existing studio window: {e}"))?;
        return Ok(OpenStudioResult {
            label: "mcp-studio".into(),
        });
    }

    let url = compose_studio_url(&base_url, &auth_password)?;
    tracing::debug!(
        target: "executor::ipc",
        op = "open_mcp_studio_window",
        "step 2/4: studio URL composed (credentials embedded in userinfo)"
    );
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|e| anyhow::anyhow!("parse studio URL {url}: {e}"))?;
    let bridge_script = mcp_studio_bridge_script(&base_url, &auth_password);

    // WebviewWindowBuilder::build MUST run on the main thread on macOS
    // (Cocoa NSWindow APIs are not thread-safe). When invoked from a
    // tokio worker thread (which is where async commands land), the call
    // silently hangs. We use a oneshot channel + `run_on_main_thread`
    // to dispatch the work and wait for the result with telemetry on each
    // step so a hang is immediately visible in the logs.
    tracing::debug!(
        target: "executor::ipc",
        op = "open_mcp_studio_window",
        "step 3/4: dispatching webview build to main thread"
    );

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        tracing::debug!(
            target: "executor::ipc",
            op = "open_mcp_studio_window",
            "main-thread: building webview"
        );
        let result = WebviewWindowBuilder::new(
            &app_for_main,
            "mcp-studio",
            tauri::WebviewUrl::External(parsed),
        )
        .initialization_script(bridge_script)
        .on_new_window({
            let app_for_popup = app_for_main.clone();
            move |url, features| {
                let scheme = url.scheme();
                if !matches!(scheme, "about" | "http" | "https") {
                    tracing::warn!(
                        target: "executor::ipc",
                        op = "open_mcp_studio_window",
                        popup_url = %url,
                        "denying unsupported Studio popup URL scheme"
                    );
                    return tauri::webview::NewWindowResponse::Deny;
                }

                let label = format!("mcp-oauth-popup-{}", uuid::Uuid::new_v4().simple());
                tracing::info!(
                    target: "executor::ipc",
                    op = "open_mcp_studio_window",
                    popup_label = %label,
                    popup_url = %url,
                    "creating Studio OAuth popup webview"
                );

                let builder = WebviewWindowBuilder::new(
                    &app_for_popup,
                    &label,
                    tauri::WebviewUrl::External("about:blank".parse().expect("valid about URL")),
                )
                .window_features(features)
                .title(url.as_str())
                .on_document_title_changed(|window, title| {
                    if let Err(e) = window.set_title(&title) {
                        tracing::debug!(
                            target: "executor::ipc",
                            op = "open_mcp_studio_window",
                            error = %e,
                            "failed to update Studio OAuth popup title"
                        );
                    }
                });

                match builder.build() {
                    Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                    Err(e) => {
                        tracing::warn!(
                            target: "executor::ipc",
                            op = "open_mcp_studio_window",
                            error = %e,
                            popup_url = %url,
                            "failed to create Studio OAuth popup webview"
                        );
                        tauri::webview::NewWindowResponse::Deny
                    }
                }
            }
        })
        .title("Helmor MCP Studio")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .visible(true)
        .build()
        .map(|_window| ())
        .map_err(|e| format!("{e}"));

        match &result {
            Ok(()) => tracing::info!(
                target: "executor::ipc",
                op = "open_mcp_studio_window",
                "main-thread: webview built"
            ),
            Err(e) => tracing::warn!(
                target: "executor::ipc",
                op = "open_mcp_studio_window",
                error = %e,
                "main-thread: webview build failed"
            ),
        }
        let _ = tx.send(result);
    })
    .map_err(|e| anyhow::anyhow!("schedule main-thread webview build: {e}"))?;

    let build_result = rx
        .recv_timeout(std::time::Duration::from_secs(15))
        .map_err(|e| {
            tracing::warn!(
                target: "executor::ipc",
                op = "open_mcp_studio_window",
                error = %e,
                "step 4/4: main-thread webview build did not respond within 15s"
            );
            anyhow::anyhow!("main-thread webview build timed out: {e}")
        })?;

    build_result.map_err(|e| anyhow::anyhow!("build studio window: {e}"))?;

    tracing::info!(
        target: "executor::ipc",
        op = "open_mcp_studio_window",
        label = "mcp-studio",
        "step 4/4: Studio window opened"
    );

    Ok(OpenStudioResult {
        label: "mcp-studio".into(),
    })
}

fn compose_studio_url(base_url: &str, password: &str) -> anyhow::Result<String> {
    let parsed = url::Url::parse(base_url)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("base url missing host"))?;
    let port = parsed
        .port()
        .ok_or_else(|| anyhow::anyhow!("base url missing port"))?;
    // Percent-encode the password (UUID v4 has no reserved chars, but be
    // defensive in case the source changes).
    let encoded_password = urlencode(password);
    Ok(format!("http://executor:{encoded_password}@{host}:{port}"))
}

fn urlencode(s: &str) -> String {
    // Minimal RFC 3986 userinfo encoder: percent-escape anything outside
    // the unreserved set. Pulling in `percent-encoding` for one site is
    // overkill; this is sufficient for the UUID v4 we currently use.
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(ch),
            _ => {
                let mut buf = [0u8; 4];
                let bytes = ch.encode_utf8(&mut buf).as_bytes();
                for b in bytes {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn studio_url_embeds_credentials() {
        let url = compose_studio_url("http://127.0.0.1:54321", "abc-123-uuid").unwrap();
        assert_eq!(url, "http://executor:abc-123-uuid@127.0.0.1:54321");
    }

    #[test]
    fn percent_encodes_unreserved_only() {
        assert_eq!(urlencode("abc-1.2_3~"), "abc-1.2_3~");
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("@/"), "%40%2F");
    }
}
