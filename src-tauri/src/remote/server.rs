//! Server-side request dispatcher.
//!
//! `dispatch_request` is the seam every RPC handler funnels through:
//! it owns the version-check gate, the params deserialisation, and
//! the result envelope. Handlers themselves stay tiny and pure
//! (`fn(ctx, params) -> Result<Result>`).
//!
//! The dispatcher does NOT own the read/write loop — that lives in
//! the `helmor-server` binary so the same dispatcher can drive a
//! loopback test or an in-process integration probe without spinning
//! up a real process.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use super::codec::write_frame;

use super::methods::{
    InitializeMethod, InitializeParams, InitializeResult, Method, PingMethod, PingParams,
    PingResult, RpcMethod, WorkspaceStatusMethod, WorkspaceStatusParams, WorkspaceStatusResult,
};
use super::protocol::{
    error_codes, JsonRpcError, JsonRpcId, JsonRpcRequest, JsonRpcResponse, PROTOCOL_VERSION,
};
use super::runtime::{LocalRuntime, RemoteRuntime};

/// Server-side push channel — the inverse of the client's
/// [`super::client::NotificationSubscription`]. Server handlers (or
/// any background task on the server) call `notify` to push a
/// JSON-RPC notification (request with no `id`) up the pipe.
///
/// The trait is `Send + Sync` so a handler can stash an
/// `Arc<dyn Notifier>` and emit notifications from a background
/// thread.
///
/// The spike's binary uses [`StdoutNotifier`] to write framed
/// notifications onto its stdout, sharing the lock with the
/// response writer. Tests use [`NoopNotifier`] (or capture into a
/// channel).
pub trait Notifier: Send + Sync {
    /// Push a notification with the given method name + params.
    /// Errors are logged inside the impl — the caller has no
    /// recovery path beyond "ignore" since notifications are
    /// fire-and-forget by definition.
    fn notify(&self, method: &str, params: Value);
}

/// Default no-op notifier. Used by [`ServerContext::new`] and by
/// loopback tests that don't care about server-pushed events.
pub struct NoopNotifier;

impl Notifier for NoopNotifier {
    fn notify(&self, _method: &str, _params: Value) {}
}

/// Notifier that writes framed JSON-RPC notifications to a shared
/// writer (typically the binary's stdout). The lock guarantees a
/// response frame and a notification frame can't interleave
/// mid-write.
///
/// `helmor-server`'s main loop owns one of these and passes a clone
/// to the `ServerContext`; future handlers that want to emit events
/// (agent stream, terminal output, file watcher) hold an
/// `Arc<dyn Notifier>` and call `notify` from their own threads.
pub struct StdoutNotifier {
    /// Mutex around the writer keeps notification frames atomic with
    /// respect to response frames. The binary's main loop *also*
    /// writes through a `Mutex<W>` on the same handle — design rule
    /// is "all writes to the pipe go through one mutex".
    writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
}

impl StdoutNotifier {
    pub fn new(writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>) -> Self {
        Self { writer }
    }
}

impl Notifier for StdoutNotifier {
    fn notify(&self, method: &str, params: Value) {
        // Notifications are JSON-RPC requests with no id. The framer
        // serialises them like any other request.
        let request = JsonRpcRequest::new(method, params, JsonRpcId::Null);
        let mut writer = match self.writer.lock() {
            Ok(w) => w,
            Err(err) => {
                tracing::error!(
                    error = %err,
                    "remote-runner: notifier writer mutex poisoned"
                );
                return;
            }
        };
        if let Err(err) = write_frame(&mut *writer, &request) {
            tracing::warn!(
                method = %method,
                error = %err,
                "remote-runner: failed to write notification frame"
            );
        }
    }
}

/// Per-connection state. Created when the binary boots, threaded
/// through every dispatch. Today it carries the post-`initialize`
/// gate flag and the server's startup metadata; later phases will
/// add the DB pool, the script-process manager, etc.
pub struct ServerContext {
    /// Set to `true` after a successful `initialize`. Every other
    /// method rejects with `NOT_INITIALIZED` until then so a
    /// confused client (or a probing port-scanner) can't poke at
    /// state without the handshake.
    initialized: Mutex<bool>,
    /// Server binary's package version. Set at startup from
    /// `env!("CARGO_PKG_VERSION")` so the dispatch handler doesn't
    /// re-read it per call.
    server_version: String,
    /// Hostname surfaced in `initialize` responses. `uname -n` on
    /// Unix; later phases can override for friendlier labels.
    hostname: String,
    /// Runtime the server delegates execution to. In the
    /// `helmor-server` binary this is a [`LocalRuntime`] — the
    /// server side of an SSH pair IS the local runtime on the
    /// remote host. Tests can swap in a stub to drive the
    /// dispatcher without shelling out to `git`.
    runtime: Arc<dyn RemoteRuntime>,
    /// Push channel for server-initiated notifications. Handlers
    /// reach this via [`ServerContext::notifier`] and call
    /// `notify(method, params)` to emit. Defaults to
    /// [`NoopNotifier`] so contexts built without a real writer
    /// silently drop notifications.
    notifier: Arc<dyn Notifier>,
}

impl ServerContext {
    pub fn new(server_version: impl Into<String>, hostname: impl Into<String>) -> Self {
        let hostname = hostname.into();
        let runtime: Arc<dyn RemoteRuntime> =
            Arc::new(LocalRuntime::with_hostname(hostname.clone()));
        Self {
            initialized: Mutex::new(false),
            server_version: server_version.into(),
            hostname,
            runtime,
            notifier: Arc::new(NoopNotifier),
        }
    }

    /// Construct with a caller-supplied runtime. Used by tests to
    /// inject a fake; production code goes through [`Self::new`].
    pub fn with_runtime(
        server_version: impl Into<String>,
        hostname: impl Into<String>,
        runtime: Arc<dyn RemoteRuntime>,
    ) -> Self {
        Self {
            initialized: Mutex::new(false),
            server_version: server_version.into(),
            hostname: hostname.into(),
            runtime,
            notifier: Arc::new(NoopNotifier),
        }
    }

    /// Builder-style: attach a notifier to an existing context.
    /// Used by the binary to wire its `StdoutNotifier` in *after*
    /// constructing the context with the real runtime.
    pub fn set_notifier(&mut self, notifier: Arc<dyn Notifier>) {
        self.notifier = notifier;
    }

    /// Handler entry point for emitting notifications. Public so
    /// handlers in this module (and tests) can reach the notifier
    /// without crawling private fields.
    pub fn notifier(&self) -> &Arc<dyn Notifier> {
        &self.notifier
    }

    fn is_initialized(&self) -> bool {
        *self.initialized.lock().expect("ctx mutex poisoned")
    }

    fn mark_initialized(&self) {
        *self.initialized.lock().expect("ctx mutex poisoned") = true;
    }
}

/// Decode a JSON-RPC request, dispatch to the matching handler, and
/// build the response envelope. Notifications (id absent) get `None`
/// back so the binary's write loop skips the response write.
pub fn dispatch_request(ctx: &ServerContext, req: JsonRpcRequest) -> Option<JsonRpcResponse> {
    let id = req.id.clone();
    let method: Method = match req.method.parse() {
        Ok(m) => m,
        Err(_) => {
            return wrap_error(
                &id,
                error_codes::METHOD_NOT_FOUND,
                format!("unknown method: {}", req.method),
            );
        }
    };

    // The handshake gate: every non-`initialize` method requires
    // initialization to have happened first.
    if method != Method::Initialize && !ctx.is_initialized() {
        return wrap_error(
            &id,
            error_codes::NOT_INITIALIZED,
            "client must call `initialize` before any other method",
        );
    }

    let outcome: Result<Value, JsonRpcError> = match method {
        Method::Initialize => {
            handle::<InitializeMethod, _>(req.params, |params| handle_initialize(ctx, params))
        }
        Method::Ping => handle::<PingMethod, _>(req.params, handle_ping),
        Method::WorkspaceStatus => handle::<WorkspaceStatusMethod, _>(req.params, |params| {
            handle_workspace_status(ctx, params)
        }),
    };

    let response = match outcome {
        Ok(result) => JsonRpcResponse::success(id.clone(), result),
        Err(err) => JsonRpcResponse::failure(id.clone(), err),
    };
    if id.is_notification() {
        // Per JSON-RPC: notifications never get a response, even on
        // error. We still run the handler for its side effects.
        None
    } else {
        Some(response)
    }
}

/// Adapt a strongly-typed handler `fn(params) -> Result<R, JsonRpcError>`
/// to the dynamic params/value pipeline the dispatcher operates on.
fn handle<M, F>(params: Value, handler: F) -> Result<Value, JsonRpcError>
where
    M: RpcMethod,
    F: FnOnce(M::Params) -> Result<M::Result, JsonRpcError>,
    M::Params: DeserializeOwned,
    M::Result: Serialize,
{
    let parsed: M::Params = if params.is_null() {
        // No params at all — try to decode an empty object so methods
        // with optional fields still work.
        serde_json::from_value(Value::Object(Default::default())).map_err(|err| {
            JsonRpcError::new(
                error_codes::INVALID_PARAMS,
                format!("missing params for method `{}`: {err}", M::NAME),
            )
        })?
    } else {
        serde_json::from_value(params).map_err(|err| {
            JsonRpcError::new(
                error_codes::INVALID_PARAMS,
                format!("invalid params for method `{}`: {err}", M::NAME),
            )
        })?
    };
    let result = handler(parsed)?;
    serde_json::to_value(&result).map_err(|err| {
        JsonRpcError::new(
            error_codes::INTERNAL_ERROR,
            format!("failed to serialise result for `{}`: {err}", M::NAME),
        )
    })
}

fn wrap_error(id: &JsonRpcId, code: i32, message: impl Into<String>) -> Option<JsonRpcResponse> {
    if id.is_notification() {
        // Errors on notifications are dropped silently — JSON-RPC
        // does not allow responding to a notification at all.
        return None;
    }
    Some(JsonRpcResponse::failure(
        id.clone(),
        JsonRpcError::new(code, message),
    ))
}

fn handle_initialize(
    ctx: &ServerContext,
    params: InitializeParams,
) -> Result<InitializeResult, JsonRpcError> {
    if !major_versions_match(&params.protocol_version, PROTOCOL_VERSION) {
        return Err(JsonRpcError::new(
            error_codes::INCOMPATIBLE_PROTOCOL,
            format!(
                "incompatible protocol: client speaks {} but server speaks {}",
                params.protocol_version, PROTOCOL_VERSION
            ),
        ));
    }
    tracing::info!(
        client_name = %params.client_name,
        client_version = ?params.client_version,
        protocol = %params.protocol_version,
        "remote: initialize handshake accepted"
    );
    ctx.mark_initialized();
    Ok(InitializeResult {
        protocol_version: PROTOCOL_VERSION.to_string(),
        server_version: ctx.server_version.clone(),
        hostname: ctx.hostname.clone(),
    })
}

fn handle_ping(params: PingParams) -> Result<PingResult, JsonRpcError> {
    use chrono::SecondsFormat;
    Ok(PingResult {
        counter: params.counter,
        server_time: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

fn handle_workspace_status(
    ctx: &ServerContext,
    params: WorkspaceStatusParams,
) -> Result<WorkspaceStatusResult, JsonRpcError> {
    let workspace_dir = PathBuf::from(&params.workspace_dir);
    ctx.runtime.workspace_status(&workspace_dir).map_err(|err| {
        // Funnel anyhow into HANDLER_FAILED so the client can
        // distinguish "your params were wrong" (INVALID_PARAMS)
        // from "git itself blew up" (HANDLER_FAILED).
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.status failed: {err:#}"),
        )
    })
}

/// Two semver strings are protocol-compatible iff their *major*
/// segments match. Anything below `1.0` is treated as a pre-release
/// where every published version is its own major (i.e. `0.1.x` is
/// incompatible with `0.2.x`).
fn major_versions_match(left: &str, right: &str) -> bool {
    fn major_pair(v: &str) -> Option<(&str, &str)> {
        let mut parts = v.splitn(3, '.');
        let major = parts.next()?;
        let minor = parts.next()?;
        Some((major, minor))
    }
    match (major_pair(left), major_pair(right)) {
        (Some((lm, ln)), Some((rm, rn))) => {
            if lm != rm {
                return false;
            }
            // Pre-1.0: minor is the effective compatibility line.
            if lm == "0" {
                return ln == rn;
            }
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn fresh_ctx() -> ServerContext {
        ServerContext::new("0.22.1", "test-host")
    }

    fn request(method: &str, params: Value, id: u64) -> JsonRpcRequest {
        JsonRpcRequest::new(method, params, JsonRpcId::Num(id))
    }

    // ── initialize ────────────────────────────────────────────────

    #[test]
    fn initialize_accepts_matching_version_and_unlocks_the_session() {
        let ctx = fresh_ctx();
        let resp = dispatch_request(
            &ctx,
            request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientName": "helmor-client",
                    "clientVersion": "0.22.1",
                }),
                1,
            ),
        )
        .expect("initialize must produce a response");
        let result = resp.result.expect("ok response");
        assert_eq!(result["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(result["hostname"], "test-host");
        assert!(ctx.is_initialized());
    }

    #[test]
    fn initialize_rejects_mismatched_major() {
        let ctx = fresh_ctx();
        let resp = dispatch_request(
            &ctx,
            request(
                "initialize",
                json!({
                    "protocolVersion": "1.0.0",
                    "clientName": "helmor-client",
                }),
                1,
            ),
        )
        .unwrap();
        let err = resp.error.expect("error response");
        assert_eq!(err.code, error_codes::INCOMPATIBLE_PROTOCOL);
        assert!(!ctx.is_initialized());
    }

    // ── ping ──────────────────────────────────────────────────────

    #[test]
    fn ping_before_initialize_returns_not_initialized() {
        let ctx = fresh_ctx();
        let resp = dispatch_request(&ctx, request("ping", json!({}), 1)).unwrap();
        let err = resp.error.expect("error response");
        assert_eq!(err.code, error_codes::NOT_INITIALIZED);
    }

    #[test]
    fn ping_after_initialize_echoes_counter_and_returns_server_time() {
        let ctx = fresh_ctx();
        dispatch_request(
            &ctx,
            request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientName": "helmor-client",
                }),
                1,
            ),
        );
        let resp = dispatch_request(&ctx, request("ping", json!({ "counter": 42 }), 2)).unwrap();
        let result = resp.result.expect("ok response");
        assert_eq!(result["counter"], 42);
        assert!(result["serverTime"].as_str().unwrap().contains('T'));
    }

    #[test]
    fn unknown_method_returns_method_not_found() {
        let ctx = fresh_ctx();
        let resp = dispatch_request(&ctx, request("not-a-method", json!({}), 1)).unwrap();
        let err = resp.error.expect("error response");
        assert_eq!(err.code, error_codes::METHOD_NOT_FOUND);
    }

    #[test]
    fn invalid_params_returns_invalid_params_error_with_method_context() {
        let ctx = fresh_ctx();
        // `protocolVersion` is required by `InitializeParams` — sending
        // an object missing the field should surface an INVALID_PARAMS
        // error mentioning the method name.
        let resp =
            dispatch_request(&ctx, request("initialize", json!({ "clientName": "x" }), 1)).unwrap();
        let err = resp.error.expect("error response");
        assert_eq!(err.code, error_codes::INVALID_PARAMS);
        assert!(
            err.message.contains("`initialize`"),
            "error should name the method: {err:?}"
        );
    }

    // ── workspace.status ──────────────────────────────────────────

    /// Stub runtime so dispatch tests don't need a real git repo on
    /// disk. Returns a fixed status keyed off the workspace path so
    /// the test can assert the params flowed through correctly.
    struct StubRuntime;

    impl RemoteRuntime for StubRuntime {
        fn runtime_health(&self) -> anyhow::Result<super::super::runtime::RuntimeHealth> {
            unreachable!("workspace.status dispatch tests should not probe health")
        }

        fn workspace_status(
            &self,
            workspace_dir: &std::path::Path,
        ) -> anyhow::Result<WorkspaceStatusResult> {
            // Echo the path back in `changed_paths` so the test can
            // prove the dispatcher decoded params + plumbed them to
            // the runtime.
            Ok(WorkspaceStatusResult {
                is_clean: false,
                changed_paths: vec![workspace_dir.display().to_string()],
            })
        }

        fn ping(&self) -> anyhow::Result<()> {
            unreachable!("workspace.status dispatch tests don't ping")
        }
    }

    fn initialized_ctx_with_stub() -> ServerContext {
        let ctx = ServerContext::with_runtime("0.22.1", "test-host", Arc::new(StubRuntime));
        // Drive a handshake so the gate opens, just like a real
        // client would do.
        dispatch_request(
            &ctx,
            request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientName": "helmor-client",
                }),
                1,
            ),
        )
        .expect("initialize response");
        ctx
    }

    #[test]
    fn workspace_status_dispatches_to_runtime_and_returns_camel_case_result() {
        let ctx = initialized_ctx_with_stub();
        let resp = dispatch_request(
            &ctx,
            request(
                "workspace.status",
                json!({ "workspaceDir": "/tmp/example" }),
                2,
            ),
        )
        .unwrap();
        let result = resp.result.expect("ok response");
        assert_eq!(result["isClean"], false);
        assert_eq!(
            result["changedPaths"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>()),
            Some(vec!["/tmp/example"]),
        );
    }

    #[test]
    fn workspace_status_before_initialize_returns_not_initialized() {
        // Fresh ctx — no handshake. Even with the stub runtime, the
        // gate must reject.
        let ctx = ServerContext::with_runtime("0.22.1", "test-host", Arc::new(StubRuntime));
        let resp = dispatch_request(
            &ctx,
            request(
                "workspace.status",
                json!({ "workspaceDir": "/tmp/example" }),
                1,
            ),
        )
        .unwrap();
        let err = resp.error.expect("error response");
        assert_eq!(err.code, error_codes::NOT_INITIALIZED);
    }

    #[test]
    fn workspace_status_with_missing_workspace_dir_returns_invalid_params() {
        let ctx = initialized_ctx_with_stub();
        let resp = dispatch_request(&ctx, request("workspace.status", json!({}), 2)).unwrap();
        let err = resp.error.expect("error response");
        assert_eq!(err.code, error_codes::INVALID_PARAMS);
        assert!(
            err.message.contains("`workspace.status`"),
            "error should name the method: {err:?}"
        );
    }

    #[test]
    fn workspace_status_runtime_failure_surfaces_as_handler_failed() {
        struct FailingRuntime;
        impl RemoteRuntime for FailingRuntime {
            fn runtime_health(&self) -> anyhow::Result<super::super::runtime::RuntimeHealth> {
                unreachable!()
            }
            fn workspace_status(
                &self,
                _: &std::path::Path,
            ) -> anyhow::Result<WorkspaceStatusResult> {
                Err(anyhow::anyhow!("git: not a repository"))
            }
            fn ping(&self) -> anyhow::Result<()> {
                unreachable!()
            }
        }
        let ctx = ServerContext::with_runtime("0.22.1", "test-host", Arc::new(FailingRuntime));
        // Handshake first.
        dispatch_request(
            &ctx,
            request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientName": "helmor-client",
                }),
                1,
            ),
        );
        let resp = dispatch_request(
            &ctx,
            request("workspace.status", json!({ "workspaceDir": "/nope" }), 2),
        )
        .unwrap();
        let err = resp.error.expect("error response");
        assert_eq!(err.code, error_codes::HANDLER_FAILED);
        assert!(
            err.message.contains("not a repository"),
            "error should preserve git's message: {err:?}"
        );
    }

    // ── notifications ─────────────────────────────────────────────

    #[test]
    fn notification_request_returns_no_response_even_on_error() {
        let ctx = fresh_ctx();
        // No id → notification. Even though the method is unknown,
        // the dispatcher must NOT produce a response envelope.
        let resp = dispatch_request(
            &ctx,
            JsonRpcRequest::new("not-a-method", json!({}), JsonRpcId::Null),
        );
        assert!(resp.is_none());
    }

    // ── major_versions_match ──────────────────────────────────────

    #[test]
    fn major_versions_match_treats_0x_minor_as_breaking() {
        assert!(major_versions_match("0.1.0", "0.1.5"));
        assert!(!major_versions_match("0.1.0", "0.2.0"));
        // 1.x+: minor is non-breaking.
        assert!(major_versions_match("1.2.0", "1.5.0"));
        assert!(!major_versions_match("1.0.0", "2.0.0"));
    }
}
