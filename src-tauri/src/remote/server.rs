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
    AgentAbortMethod, AgentAbortParams, AgentAbortResult, AgentAttachMethod, AgentAttachParams,
    AgentAttachResult, AgentListMethod, AgentListParams, AgentListResult, AgentSendMethod,
    AgentSendParams, AgentSendResult, InitializeMethod, InitializeParams, InitializeResult, Method,
    PingMethod, PingParams, PingResult, RpcMethod, TerminalAttachMethod, TerminalAttachParams,
    TerminalAttachResult, TerminalCloseMethod, TerminalCloseParams, TerminalCloseResult,
    TerminalListMethod, TerminalListParams, TerminalListResult, TerminalOpenMethod,
    TerminalOpenParams, TerminalOpenResult, TerminalResizeMethod, TerminalResizeParams,
    TerminalResizeResult, TerminalWriteMethod, TerminalWriteParams, TerminalWriteResult,
    WorkspaceBranchInfoMethod, WorkspaceBranchInfoParams, WorkspaceBranchInfoResult,
    WorkspaceChangesMethod, WorkspaceChangesParams, WorkspaceChangesResult,
    WorkspaceFileTreeMethod, WorkspaceFileTreeParams, WorkspaceFileTreeResult,
    WorkspaceMutateFileMethod, WorkspaceMutateFileParams, WorkspaceMutateFileResult,
    WorkspaceReadFileAtRefMethod, WorkspaceReadFileAtRefParams, WorkspaceReadFileAtRefResult,
    WorkspaceReadFileMethod, WorkspaceReadFileParams, WorkspaceStatFileMethod,
    WorkspaceStatFileParams, WorkspaceStatusMethod, WorkspaceStatusParams, WorkspaceStatusResult,
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
    /// Live PTY-backed terminal sessions on this server. Keyed by
    /// client-chosen `terminal_id`. Shared via `Arc` so the
    /// per-session reader threads can keep emitting events even if
    /// the dispatcher's lifetime overlaps with concurrent calls.
    terminal_state: Arc<super::terminal::RemoteTerminalState>,
    /// Live agent (sidecar) bridge. Shared across connections in
    /// daemon mode so the sidecar process outlives any one client —
    /// phase 23d builds the full reattach story on top of this
    /// shared registry. In single-connection mode (used by tests
    /// and the legacy proxy entry point) the state is per-context.
    agent_state: Arc<super::agent::RemoteAgentState>,
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
            terminal_state: Arc::new(super::terminal::RemoteTerminalState::new()),
            agent_state: Arc::new(super::agent::RemoteAgentState::disabled(
                "agent runtime not configured for this context",
            )),
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
            terminal_state: Arc::new(super::terminal::RemoteTerminalState::new()),
            agent_state: Arc::new(super::agent::RemoteAgentState::disabled(
                "agent runtime not configured for this context",
            )),
        }
    }

    /// Builder-style: attach a notifier to an existing context.
    /// Used by the binary to wire its `StdoutNotifier` in *after*
    /// constructing the context with the real runtime.
    pub fn set_notifier(&mut self, notifier: Arc<dyn Notifier>) {
        self.notifier = notifier;
    }

    /// Builder-style: swap in a shared `RemoteTerminalState`. The
    /// daemon uses this so every accepted connection shares one
    /// PTY registry — otherwise each new SSH session would see a
    /// fresh empty `terminal.list`, defeating the whole reattach
    /// story.
    pub fn set_terminal_state(
        &mut self,
        terminal_state: Arc<super::terminal::RemoteTerminalState>,
    ) {
        self.terminal_state = terminal_state;
    }

    /// Builder-style: swap in a shared `RemoteAgentState`. The
    /// daemon uses this so every accepted connection routes to the
    /// same sidecar bridge — agent.list across reconnect sees the
    /// same active sessions instead of starting fresh.
    pub fn set_agent_state(&mut self, agent_state: Arc<super::agent::RemoteAgentState>) {
        self.agent_state = agent_state;
    }

    /// Handler entry point for emitting notifications. Public so
    /// handlers in this module (and tests) can reach the notifier
    /// without crawling private fields.
    pub fn notifier(&self) -> &Arc<dyn Notifier> {
        &self.notifier
    }

    /// Per-context PTY state. Tests reach in to assert "session
    /// closed" / "still running"; the dispatcher handlers use it to
    /// open / write / resize / close.
    pub fn terminal_state(&self) -> &Arc<super::terminal::RemoteTerminalState> {
        &self.terminal_state
    }

    /// Per-context agent bridge. Handlers reach this to forward
    /// `agent.send` / `agent.abort` / `agent.list` / `agent.attach`
    /// into the sidecar bridge. `Arc` shared across connections in
    /// daemon mode so the sidecar process is not torn down on each
    /// reconnect.
    pub fn agent_state(&self) -> &Arc<super::agent::RemoteAgentState> {
        &self.agent_state
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
        Method::WorkspaceBranchInfo => {
            handle::<WorkspaceBranchInfoMethod, _>(req.params, |params| {
                handle_workspace_branch_info(ctx, params)
            })
        }
        Method::TerminalOpen => {
            handle::<TerminalOpenMethod, _>(req.params, |params| handle_terminal_open(ctx, params))
        }
        Method::TerminalWrite => handle::<TerminalWriteMethod, _>(req.params, |params| {
            handle_terminal_write(ctx, params)
        }),
        Method::TerminalResize => handle::<TerminalResizeMethod, _>(req.params, |params| {
            handle_terminal_resize(ctx, params)
        }),
        Method::TerminalClose => handle::<TerminalCloseMethod, _>(req.params, |params| {
            handle_terminal_close(ctx, params)
        }),
        Method::TerminalList => {
            handle::<TerminalListMethod, _>(req.params, |params| handle_terminal_list(ctx, params))
        }
        Method::TerminalAttach => handle::<TerminalAttachMethod, _>(req.params, |params| {
            handle_terminal_attach(ctx, params)
        }),
        Method::WorkspaceFileTree => handle::<WorkspaceFileTreeMethod, _>(req.params, |params| {
            handle_workspace_file_tree(ctx, params)
        }),
        Method::WorkspaceChanges => handle::<WorkspaceChangesMethod, _>(req.params, |params| {
            handle_workspace_changes(ctx, params)
        }),
        Method::WorkspaceReadFile => handle::<WorkspaceReadFileMethod, _>(req.params, |params| {
            handle_workspace_read_file(ctx, params)
        }),
        Method::WorkspaceReadFileAtRef => {
            handle::<WorkspaceReadFileAtRefMethod, _>(req.params, |params| {
                handle_workspace_read_file_at_ref(ctx, params)
            })
        }
        Method::WorkspaceStatFile => handle::<WorkspaceStatFileMethod, _>(req.params, |params| {
            handle_workspace_stat_file(ctx, params)
        }),
        Method::WorkspaceMutateFile => {
            handle::<WorkspaceMutateFileMethod, _>(req.params, |params| {
                handle_workspace_mutate_file(ctx, params)
            })
        }
        Method::AgentSend => {
            handle::<AgentSendMethod, _>(req.params, |params| handle_agent_send(ctx, params))
        }
        Method::AgentAbort => {
            handle::<AgentAbortMethod, _>(req.params, |params| handle_agent_abort(ctx, params))
        }
        Method::AgentList => {
            handle::<AgentListMethod, _>(req.params, |params| handle_agent_list(ctx, params))
        }
        Method::AgentAttach => {
            handle::<AgentAttachMethod, _>(req.params, |params| handle_agent_attach(ctx, params))
        }
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

fn handle_workspace_branch_info(
    ctx: &ServerContext,
    params: WorkspaceBranchInfoParams,
) -> Result<WorkspaceBranchInfoResult, JsonRpcError> {
    let workspace_dir = PathBuf::from(&params.workspace_dir);
    ctx.runtime
        .workspace_branch_info(&workspace_dir)
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("workspace.branchInfo failed: {err:#}"),
            )
        })
}

fn handle_terminal_open(
    ctx: &ServerContext,
    params: TerminalOpenParams,
) -> Result<TerminalOpenResult, JsonRpcError> {
    ctx.terminal_state()
        .open(params, Arc::clone(ctx.notifier()))
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("terminal.open failed: {err:#}"),
            )
        })
}

fn handle_terminal_write(
    ctx: &ServerContext,
    params: TerminalWriteParams,
) -> Result<TerminalWriteResult, JsonRpcError> {
    ctx.terminal_state().write(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("terminal.write failed: {err:#}"),
        )
    })
}

fn handle_terminal_resize(
    ctx: &ServerContext,
    params: TerminalResizeParams,
) -> Result<TerminalResizeResult, JsonRpcError> {
    ctx.terminal_state().resize(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("terminal.resize failed: {err:#}"),
        )
    })
}

fn handle_terminal_close(
    ctx: &ServerContext,
    params: TerminalCloseParams,
) -> Result<TerminalCloseResult, JsonRpcError> {
    ctx.terminal_state().close(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("terminal.close failed: {err:#}"),
        )
    })
}

fn handle_terminal_list(
    ctx: &ServerContext,
    _params: TerminalListParams,
) -> Result<TerminalListResult, JsonRpcError> {
    // `list` is infallible — it just snapshots in-memory state.
    Ok(ctx.terminal_state().list())
}

fn handle_terminal_attach(
    ctx: &ServerContext,
    params: TerminalAttachParams,
) -> Result<TerminalAttachResult, JsonRpcError> {
    ctx.terminal_state()
        .attach(params, Arc::clone(ctx.notifier()))
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("terminal.attach failed: {err:#}"),
            )
        })
}

// ── workspace inspector ops (phase 20a — pure delegation) ───────────
//
// Each handler just forwards to `ctx.runtime.workspace_*`. The default
// trait impl bails until phase 20b backs `LocalRuntime` with real
// reads / writes — at which point the same handler keeps working
// without changes here.

fn handle_workspace_file_tree(
    ctx: &ServerContext,
    params: WorkspaceFileTreeParams,
) -> Result<WorkspaceFileTreeResult, JsonRpcError> {
    ctx.runtime.workspace_file_tree(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.fileTree failed: {err:#}"),
        )
    })
}

fn handle_workspace_changes(
    ctx: &ServerContext,
    params: WorkspaceChangesParams,
) -> Result<WorkspaceChangesResult, JsonRpcError> {
    ctx.runtime.workspace_changes(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.changes failed: {err:#}"),
        )
    })
}

fn handle_workspace_read_file(
    ctx: &ServerContext,
    params: WorkspaceReadFileParams,
) -> Result<crate::workspace::files::EditorFileReadResponse, JsonRpcError> {
    ctx.runtime.workspace_read_file(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.readFile failed: {err:#}"),
        )
    })
}

fn handle_workspace_read_file_at_ref(
    ctx: &ServerContext,
    params: WorkspaceReadFileAtRefParams,
) -> Result<WorkspaceReadFileAtRefResult, JsonRpcError> {
    ctx.runtime
        .workspace_read_file_at_ref(params)
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("workspace.readFileAtRef failed: {err:#}"),
            )
        })
}

fn handle_workspace_stat_file(
    ctx: &ServerContext,
    params: WorkspaceStatFileParams,
) -> Result<crate::workspace::files::EditorFileStatResponse, JsonRpcError> {
    ctx.runtime.workspace_stat_file(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.statFile failed: {err:#}"),
        )
    })
}

fn handle_workspace_mutate_file(
    ctx: &ServerContext,
    params: WorkspaceMutateFileParams,
) -> Result<WorkspaceMutateFileResult, JsonRpcError> {
    ctx.runtime.workspace_mutate_file(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.mutateFile failed: {err:#}"),
        )
    })
}

// Phase 23b: agent handlers route directly to `ctx.agent_state()`
// (the sidecar bridge), not through `ctx.runtime`. The runtime
// trait's agent_* methods stay as the desktop-side delegation
// surface — `RemoteSshRuntime` calls into them, and the wire lands
// here. Mirrors the pattern terminal handlers use: state holding
// owned subprocesses lives on the context, not the runtime.

fn handle_agent_send(
    ctx: &ServerContext,
    params: AgentSendParams,
) -> Result<AgentSendResult, JsonRpcError> {
    ctx.agent_state()
        .send(params, Arc::clone(ctx.notifier()))
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("agent.send failed: {err:#}"),
            )
        })
}

fn handle_agent_abort(
    ctx: &ServerContext,
    params: AgentAbortParams,
) -> Result<AgentAbortResult, JsonRpcError> {
    ctx.agent_state().abort(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("agent.abort failed: {err:#}"),
        )
    })
}

fn handle_agent_list(
    ctx: &ServerContext,
    _params: AgentListParams,
) -> Result<AgentListResult, JsonRpcError> {
    // `list` is infallible — it just snapshots in-memory state.
    Ok(ctx.agent_state().list())
}

fn handle_agent_attach(
    ctx: &ServerContext,
    params: AgentAttachParams,
) -> Result<AgentAttachResult, JsonRpcError> {
    ctx.agent_state()
        .attach(params, Arc::clone(ctx.notifier()))
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("agent.attach failed: {err:#}"),
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

        fn workspace_branch_info(
            &self,
            workspace_dir: &std::path::Path,
        ) -> anyhow::Result<WorkspaceBranchInfoResult> {
            // Same echo trick — proves the dispatcher decoded the
            // params and plumbed them through the trait.
            Ok(WorkspaceBranchInfoResult {
                current_branch: workspace_dir.display().to_string(),
                head_commit: "stub-head".into(),
                upstream_ref: Some("origin/stub".into()),
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
            fn workspace_branch_info(
                &self,
                _: &std::path::Path,
            ) -> anyhow::Result<WorkspaceBranchInfoResult> {
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

    // ── workspace inspector dispatch (phase 20a) ──────────────────
    //
    // The trait defaults bail with "not yet implemented" — we verify
    // the dispatcher decodes params, hits the right trait method, and
    // surfaces the bail as `HANDLER_FAILED`. When phase 20b backs
    // `LocalRuntime` with real impls, the *dispatch* tests still hold;
    // only the underlying behaviour changes.

    fn run_after_initialize(ctx: &ServerContext, req: JsonRpcRequest) -> JsonRpcResponse {
        dispatch_request(
            ctx,
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
        dispatch_request(ctx, req).expect("dispatcher should produce a response")
    }

    fn default_bail_ctx() -> ServerContext {
        // `StubRuntime` overrides workspace_status / branch_info, but
        // intentionally does NOT override the new inspector methods —
        // so we exercise the default trait bail through real dispatch.
        ServerContext::with_runtime("0.22.1", "test-host", Arc::new(StubRuntime))
    }

    fn assert_bail_with_method_prefix(resp: &JsonRpcResponse, method: &str) {
        let err = resp
            .error
            .as_ref()
            .unwrap_or_else(|| panic!("expected error response for `{method}`, got: {resp:?}"));
        assert_eq!(err.code, error_codes::HANDLER_FAILED);
        let expected_prefix = format!("{method} failed:");
        assert!(
            err.message.starts_with(&expected_prefix),
            "error message should be prefixed with `{expected_prefix}`, got: {}",
            err.message
        );
        assert!(
            err.message.contains("not yet implemented"),
            "default bail should reach the wire verbatim, got: {}",
            err.message
        );
    }

    #[test]
    fn workspace_file_tree_default_bail_surfaces_as_handler_failed() {
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(
            &ctx,
            request(
                "workspace.fileTree",
                json!({ "workspaceDir": "/tmp/example" }),
                2,
            ),
        );
        assert_bail_with_method_prefix(&resp, "workspace.fileTree");
    }

    #[test]
    fn workspace_changes_default_bail_surfaces_as_handler_failed() {
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(
            &ctx,
            request(
                "workspace.changes",
                json!({
                    "workspaceDir": "/tmp/example",
                    "includeContent": true,
                }),
                2,
            ),
        );
        assert_bail_with_method_prefix(&resp, "workspace.changes");
    }

    #[test]
    fn workspace_read_file_default_bail_surfaces_as_handler_failed() {
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(
            &ctx,
            request(
                "workspace.readFile",
                json!({
                    "workspaceDir": "/tmp/example",
                    "relativePath": "src/main.rs",
                }),
                2,
            ),
        );
        assert_bail_with_method_prefix(&resp, "workspace.readFile");
    }

    #[test]
    fn workspace_read_file_at_ref_default_bail_surfaces_as_handler_failed() {
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(
            &ctx,
            request(
                "workspace.readFileAtRef",
                json!({
                    "workspaceDir": "/tmp/example",
                    "relativePath": "src/main.rs",
                    "gitRef": "HEAD",
                }),
                2,
            ),
        );
        assert_bail_with_method_prefix(&resp, "workspace.readFileAtRef");
    }

    #[test]
    fn workspace_stat_file_default_bail_surfaces_as_handler_failed() {
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(
            &ctx,
            request(
                "workspace.statFile",
                json!({
                    "workspaceDir": "/tmp/example",
                    "relativePath": "Cargo.toml",
                }),
                2,
            ),
        );
        assert_bail_with_method_prefix(&resp, "workspace.statFile");
    }

    #[test]
    fn workspace_mutate_file_default_bail_surfaces_as_handler_failed() {
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(
            &ctx,
            request(
                "workspace.mutateFile",
                json!({
                    "workspaceDir": "/tmp/example",
                    "relativePath": "Cargo.toml",
                    "action": { "type": "write", "content": "[package]\nname = \"x\"\n" },
                }),
                2,
            ),
        );
        assert_bail_with_method_prefix(&resp, "workspace.mutateFile");
    }

    // ── agent.* default surfaces (phase 23b) ─────────────────────
    //
    // The ServerContext built by `with_runtime` carries a disabled
    // `RemoteAgentState` so unit tests don't accidentally spawn a
    // sidecar. Mutating methods surface the explicit
    // "agent runtime not configured" reason; the infallible
    // `agent.list` returns an empty list, and `agent.attach`
    // reports `found=false` (the same shape as attaching to a
    // missing live session). Tests that drive a real sidecar live
    // in `remote::agent::tests`.

    fn assert_agent_disabled(resp: &JsonRpcResponse, method: &str) {
        let err = resp
            .error
            .as_ref()
            .unwrap_or_else(|| panic!("expected error response for `{method}`, got: {resp:?}"));
        assert_eq!(err.code, error_codes::HANDLER_FAILED);
        let expected_prefix = format!("{method} failed:");
        assert!(
            err.message.starts_with(&expected_prefix),
            "error message should be prefixed with `{expected_prefix}`, got: {}",
            err.message
        );
        assert!(
            err.message.contains("agent runtime is not available"),
            "disabled-state bail should surface the legible reason: {}",
            err.message
        );
    }

    #[test]
    fn agent_send_with_disabled_state_surfaces_legible_error() {
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(
            &ctx,
            request(
                "agent.send",
                json!({
                    "requestId": "req-1",
                    "method": "sendMessage",
                    "params": { "model": "claude-sonnet-4-6", "prompt": "hi" },
                }),
                2,
            ),
        );
        assert_agent_disabled(&resp, "agent.send");
    }

    #[test]
    fn agent_abort_with_disabled_state_surfaces_legible_error() {
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(
            &ctx,
            request("agent.abort", json!({ "requestId": "req-1" }), 2),
        );
        assert_agent_disabled(&resp, "agent.abort");
    }

    #[test]
    fn agent_list_with_disabled_state_returns_empty_listing() {
        // `list` is infallible — it snapshots the sessions map.
        // A disabled state has no sessions; wire result is
        // `{ sessions: [] }`.
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(&ctx, request("agent.list", json!({}), 2));
        let result = resp.result.expect("ok response");
        let sessions = result["sessions"].as_array().expect("sessions array");
        assert!(
            sessions.is_empty(),
            "disabled state must report no sessions"
        );
    }

    #[test]
    fn agent_attach_with_disabled_state_reports_not_found() {
        // Attaching against a disabled state finds no matching
        // session and returns `found=false` rather than erroring —
        // same contract as attaching to a missing live session.
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(
            &ctx,
            request("agent.attach", json!({ "requestId": "req-1" }), 2),
        );
        let result = resp.result.expect("ok response");
        assert_eq!(result["found"], false);
    }

    #[test]
    fn agent_methods_reject_pre_initialize_requests() {
        // The initialization gate must cover the new entry points
        // too — agent.send before initialize should fail at the gate,
        // not at the runtime bail.
        let ctx = ServerContext::with_runtime("0.22.1", "test-host", Arc::new(StubRuntime));
        let resp = dispatch_request(
            &ctx,
            request(
                "agent.send",
                json!({
                    "requestId": "req-1",
                    "method": "sendMessage",
                    "params": {},
                }),
                1,
            ),
        )
        .unwrap();
        let err = resp.error.expect("error response");
        assert_eq!(err.code, error_codes::NOT_INITIALIZED);
    }

    #[test]
    fn agent_send_rejects_malformed_params() {
        // `params` is `serde_json::Value` (opaque) but `request_id` +
        // `method` are required strings. Missing them is INVALID_PARAMS,
        // not HANDLER_FAILED.
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(
            &ctx,
            request(
                "agent.send",
                json!({ "params": { "model": "x" } }), // missing requestId + method
                2,
            ),
        );
        let err = resp.error.expect("error response");
        assert_eq!(err.code, error_codes::INVALID_PARAMS);
        assert!(
            err.message.contains("`agent.send`"),
            "error should name the method: {err:?}"
        );
    }

    #[test]
    fn workspace_inspector_methods_reject_pre_initialize_requests() {
        // Spot-check the gate works for the new methods too — pick
        // one representative call. The branchInfo / status tests
        // already cover the gate path generically; here we just make
        // sure the new entry points didn't accidentally bypass it.
        let ctx = ServerContext::with_runtime("0.22.1", "test-host", Arc::new(StubRuntime));
        let resp = dispatch_request(
            &ctx,
            request(
                "workspace.readFile",
                json!({
                    "workspaceDir": "/tmp/example",
                    "relativePath": "src/main.rs",
                }),
                1,
            ),
        )
        .unwrap();
        let err = resp.error.expect("error response");
        assert_eq!(err.code, error_codes::NOT_INITIALIZED);
    }

    #[test]
    fn workspace_inspector_methods_reject_malformed_params() {
        // `workspace.mutateFile` has the richest param shape — an
        // internally-tagged enum buried inside the object. Pick a
        // garbled action to prove the dispatcher's `INVALID_PARAMS`
        // path covers it.
        let ctx = default_bail_ctx();
        let resp = run_after_initialize(
            &ctx,
            request(
                "workspace.mutateFile",
                json!({
                    "workspaceDir": "/tmp/example",
                    "relativePath": "Cargo.toml",
                    "action": { "type": "explode" },
                }),
                2,
            ),
        );
        let err = resp.error.expect("error response");
        assert_eq!(err.code, error_codes::INVALID_PARAMS);
        assert!(
            err.message.contains("`workspace.mutateFile`"),
            "error should name the method: {err:?}"
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
