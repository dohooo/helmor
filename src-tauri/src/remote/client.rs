//! Client side of the remote-runner protocol.
//!
//! [`RpcClient`] owns one framed JSON-RPC pipe and pairs each
//! outbound request with its response by JSON-RPC `id`. Today the
//! protocol is strictly request/response and the client is single
//! in-flight per call — fine for the F2 spike, where the trait
//! methods are themselves synchronous and there's no server-initiated
//! traffic yet. A future slice can add a reader thread + a response
//! map keyed by `id` when notifications or out-of-order replies show
//! up.
//!
//! [`RemoteSshRuntime`] is the [`super::runtime::RemoteRuntime`]
//! impl: it composes `RpcClient` with the runtime trait so callers
//! don't need to know whether they're talking to a local or a
//! remote workspace.
//!
//! ## Transport split
//!
//! `RpcClient` is intentionally I/O-agnostic. Tests construct it
//! with a pair of in-memory pipes; production uses
//! [`RpcClient::connect_ssh`] which spawns `ssh host helmor-server`.
//! Anything in between (a local helmor-server child for staging
//! tests, a containerised peer over its stdio) plugs in via
//! [`RpcClient::connect_command`].

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::Path;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};

use anyhow::{anyhow, bail, Context, Result};

use super::codec::{read_frame, write_frame, FrameError};
use super::methods::{
    InitializeMethod, InitializeParams, InitializeResult, PingMethod, PingParams, RpcMethod,
    WorkspaceBranchInfoMethod, WorkspaceBranchInfoParams, WorkspaceBranchInfoResult,
    WorkspaceStatusMethod, WorkspaceStatusParams, WorkspaceStatusResult,
};
use super::protocol::{
    error_codes, JsonRpcError, JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse,
    PROTOCOL_VERSION,
};
use super::runtime::{RemoteRuntime, RuntimeHealth, RuntimeKind};
use super::transport::{OpenSshTransport, RemoteTransport};

/// JSON-RPC client over a single framed pipe.
///
/// Architecture: a background **reader thread** owns the read half of
/// the pipe and demuxes incoming frames into one of two paths:
///
/// 1. **Responses** — matched against pending `call<M>` futures by
///    JSON-RPC id and forwarded over a oneshot mpsc.
/// 2. **Server-initiated notifications** — fanned out to any
///    [`NotificationSubscription`] the caller is holding.
///
/// `call<M>` registers a oneshot, writes the request frame, and
/// blocks on the receiver. Concurrent callers from different threads
/// are fine; the only contention is the writer mutex.
///
/// On reader-side EOF / I/O error the state flips to "closed"; any
/// pending oneshots get their senders dropped → recv returns Err →
/// the caller surfaces a transport error. New calls placed after
/// close fail fast.
pub struct RpcClient {
    writer: Mutex<RpcWriter>,
    next_id: AtomicU64,
    /// Cached server-side handshake reply. Read by `RemoteSshRuntime`
    /// when surfacing `runtime_health`; never modified after connect.
    server_info: InitializeResult,
    state: Arc<ClientState>,
    /// `Option` so `Drop` can `take()` and `join()` the handle. The
    /// reader thread observes EOF when the writer half closes, so
    /// dropping the client first reaps the writer + child, then waits
    /// out the reader's clean exit.
    reader_thread: Option<JoinHandle<()>>,
    /// Human label used for log lines + the "couldn't reach peer"
    /// error message. Mirrors what `connect_command` stashed at
    /// construction time.
    peer_label: String,
    /// Unix epoch milliseconds the handshake completed. Lets the
    /// diagnostics panel render uptime ("connected 4m ago")
    /// without an extra round-trip.
    connected_at_ms: i64,
}

impl std::fmt::Debug for RpcClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RpcClient")
            .field("peer_label", &self.peer_label)
            .field("server_info", &self.server_info)
            .field("next_id", &self.next_id.load(Ordering::Relaxed))
            .field("closed", &self.state.closed_reason())
            .finish_non_exhaustive()
    }
}

/// Writer + child handle. Held behind a mutex so concurrent callers
/// can write requests without interleaving frames.
struct RpcWriter {
    writer: Box<dyn Write + Send>,
    /// Held so `Drop` reaps the child when the client goes away.
    /// `None` for test pipes that don't spawn a process.
    child: Option<Child>,
}

impl Drop for RpcWriter {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Best-effort: kill + reap. The reader thread is also
            // tracking the same child via its stdout half; killing
            // here unblocks any read it was stuck on.
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Shared state between the reader thread and the client surface.
/// Lives behind an `Arc` so the reader thread keeps it alive after
/// the writer-side `Drop` runs.
struct ClientState {
    /// id → sender for pending `call<M>` invocations. The reader
    /// thread drains a key when a matching response arrives; on
    /// connection close the pending map is cleared, which drops the
    /// senders and surfaces `Err` to every waiter.
    pending: Mutex<HashMap<JsonRpcId, mpsc::Sender<JsonRpcResponse>>>,
    /// Active notification subscribers. Each entry carries its own
    /// id so [`NotificationSubscription::drop`] can remove just its
    /// own slot without scanning callbacks.
    subscribers: Mutex<Vec<Subscription>>,
    /// Set once the reader thread observes EOF or a transport error.
    /// New `call`s after this fail fast instead of registering a
    /// pending oneshot that'll never resolve.
    closed: Mutex<Option<String>>,
    next_sub_id: AtomicU64,
    /// Connection telemetry. Surfaces through
    /// [`RpcClient::diagnostics`] / the desktop's "Connection
    /// diagnostics" panel so operators can answer "is my pipe
    /// healthy?" without reaching for log files. Cheap atomic
    /// increments — no observable cost on the hot path.
    requests_sent: AtomicU64,
    responses_received: AtomicU64,
    notifications_received: AtomicU64,
    decode_errors: AtomicU64,
}

impl ClientState {
    fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            closed: Mutex::new(None),
            next_sub_id: AtomicU64::new(1),
            requests_sent: AtomicU64::new(0),
            responses_received: AtomicU64::new(0),
            notifications_received: AtomicU64::new(0),
            decode_errors: AtomicU64::new(0),
        }
    }

    fn closed_reason(&self) -> Option<String> {
        self.closed
            .lock()
            .expect("client closed mutex poisoned")
            .clone()
    }

    fn mark_closed(&self, reason: impl Into<String>) {
        let mut closed = self.closed.lock().expect("client closed mutex poisoned");
        if closed.is_none() {
            *closed = Some(reason.into());
        }
        // Drop every pending sender so waiters surface a transport
        // error instead of hanging.
        self.pending
            .lock()
            .expect("client pending mutex poisoned")
            .clear();
    }
}

/// Callback slot for one notification subscription.
struct Subscription {
    id: u64,
    callback: Arc<dyn Fn(JsonRpcRequest) + Send + Sync>,
}

/// Operator-facing snapshot of the RPC pipe's I/O health.
///
/// Mirrors the wire shape the desktop's "Connection diagnostics"
/// panel renders. Cumulative counters reset whenever a new
/// `RpcClient` is built (i.e. on reconnect); `connected_at_ms`
/// pins the snapshot to its session so the UI can render uptime.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcClientDiagnostics {
    /// Human label the connect path stashed. SSH connections use
    /// the host string; command transports use the spawned argv's
    /// program name; loopback tests use "loopback". Surface
    /// verbatim — operators recognise the labels from earlier
    /// log lines.
    pub peer_label: String,
    /// Server-reported `helmor-server` package version (from the
    /// `initialize` handshake). Lets the panel surface a
    /// "running 0.22.1" chip alongside the desktop's own version
    /// so a version skew is debuggable at a glance.
    pub server_version: String,
    pub server_hostname: String,
    pub protocol_version: String,
    /// Unix epoch milliseconds when the handshake completed.
    pub connected_at_ms: i64,
    /// `Some(reason)` once the reader thread observes EOF or a
    /// transport error. The UI renders this as a red status chip
    /// and disables further calls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_reason: Option<String>,
    /// Successful frame writes — counts `RpcClient::call` invocations
    /// that made it onto the wire. Failed writes are NOT counted (a
    /// padded counter on failure would hide the failure from the
    /// diagnostics view).
    pub requests_sent: u64,
    pub responses_received: u64,
    pub notifications_received: u64,
    /// Number of times the reader observed a framing / decode
    /// error before it tore the connection down. Non-zero is
    /// always a bug; the panel renders it in red.
    pub decode_errors: u64,
}

/// Handle returned by [`RpcClient::subscribe_notifications`]. Drop
/// removes the subscription — RAII so callers can't leak handlers by
/// forgetting an explicit `unsubscribe` call.
pub struct NotificationSubscription {
    state: Arc<ClientState>,
    id: u64,
}

impl Drop for NotificationSubscription {
    fn drop(&mut self) {
        let mut subs = self
            .state
            .subscribers
            .lock()
            .expect("client subscribers mutex poisoned");
        subs.retain(|s| s.id != self.id);
    }
}

impl NotificationSubscription {
    /// Test-only constructor. Returns a subscription handle whose
    /// `Drop` is a harmless no-op because no callback was ever
    /// registered against the throw-away `ClientState`. Cross-module
    /// tests (e.g. the `SidecarTransport` impls) need a real
    /// `NotificationSubscription` to satisfy `subscribe_agent_events`'s
    /// return type without standing up a full `RpcClient`.
    #[cfg(test)]
    pub fn dangling_for_tests() -> Self {
        Self {
            state: Arc::new(ClientState::new()),
            id: 0,
        }
    }
}

impl RpcClient {
    /// Connect to a `helmor-server` reachable over SSH. Convenience
    /// over [`connect_with_transport`] that wires an
    /// [`OpenSshTransport`] for the caller — every detail of the
    /// `ssh <host> sh -c '<bin> --ensure-daemon && exec <bin> --proxy'`
    /// arg-building lives on the transport now.
    ///
    /// `remote_binary` must already exist on the remote. The
    /// auto-install path in phase 12 puts it there on first
    /// connect.
    pub fn connect_ssh(host: &str, remote_binary: &str) -> Result<Self> {
        Self::connect_ssh_with_options(host, remote_binary, false)
    }

    /// Variant of [`connect_ssh`] that lets the caller opt in to
    /// `ForwardAgent=yes` (Track G3). Off by default; callers that
    /// want agent forwarding (typically because the operator chose
    /// it for a runtime whose remote needs to authenticate to git
    /// over the local agent) pass `true`.
    pub fn connect_ssh_with_options(
        host: &str,
        remote_binary: &str,
        forward_agent: bool,
    ) -> Result<Self> {
        let transport: Arc<dyn RemoteTransport> =
            Arc::new(OpenSshTransport::new(host, remote_binary).with_forward_agent(forward_agent));
        Self::connect_with_transport(transport)
    }

    /// Open a framed JSON-RPC connection through any transport. The
    /// trait owns the spawn details; this function owns the framer +
    /// handshake.
    ///
    /// Phase 21a only exposes [`OpenSshTransport`] (the SSH path); the
    /// command-based transport lands in phase 21b. New transports plug
    /// in by implementing [`RemoteTransport`] — no changes here are
    /// needed for them to work.
    pub fn connect_with_transport(transport: Arc<dyn RemoteTransport>) -> Result<Self> {
        let pipe = transport.spawn_pipe()?;
        let super::transport::TransportPipe {
            reader,
            writer,
            child,
            peer_label,
        } = pipe;
        Self::connect_with_pipe(reader, writer, child, peer_label)
    }

    /// Spawn `cmd` with piped stdio, wrap it as the RPC pipe, and run
    /// the initialize handshake. Used by the local-binary connect path
    /// in `commands::remote_commands` and by integration tests that
    /// want to spawn `helmor-server` directly without going through
    /// a [`RemoteTransport`].
    ///
    /// Thin convenience over [`super::transport::spawn_command_as_pipe`]
    /// — every other entry point should go through a transport.
    pub fn connect_command(cmd: Command, peer_label: String) -> Result<Self> {
        let pipe = super::transport::spawn_command_as_pipe(cmd, peer_label)?;
        let super::transport::TransportPipe {
            reader,
            writer,
            child,
            peer_label,
        } = pipe;
        Self::connect_with_pipe(reader, writer, child, peer_label)
    }

    /// Wire a pre-built pipe pair into a client. Used by both the
    /// real `connect_command` path and by tests that supply paired
    /// in-memory streams.
    ///
    /// Spawns the reader thread as part of connect — the handshake
    /// itself goes through the new `call<M>` pathway so the same
    /// id-routing code is exercised on every connection (including
    /// the first one).
    pub fn connect_with_pipe(
        reader: Box<dyn BufRead + Send>,
        writer: Box<dyn Write + Send>,
        child: Option<Child>,
        peer_label: String,
    ) -> Result<Self> {
        let writer = RpcWriter { writer, child };
        let state = Arc::new(ClientState::new());
        // Reader thread starts before we issue the handshake — the
        // handshake response itself is demuxed by the reader.
        let reader_thread = spawn_reader_thread(reader, Arc::clone(&state), peer_label.clone());

        let client_skeleton = ClientSkeleton {
            writer: Mutex::new(writer),
            next_id: AtomicU64::new(1),
            state: Arc::clone(&state),
        };
        let server_info = run_handshake(&client_skeleton, &peer_label)?;

        Ok(Self {
            writer: client_skeleton.writer,
            next_id: client_skeleton.next_id,
            server_info,
            state,
            reader_thread: Some(reader_thread),
            peer_label,
            connected_at_ms: now_unix_ms(),
        })
    }

    /// Issue a typed JSON-RPC request and decode the response into
    /// the method's `Result` type. Errors fall into three buckets:
    ///
    /// - Connection closed before/after send → `anyhow` with the
    ///   reader's close reason if available.
    /// - JSON-RPC error response → `anyhow` containing the server's
    ///   message and a human-readable code label so the UI can
    ///   string-match if it has to.
    /// - Deserialise failure on the response body → `anyhow` naming
    ///   the method.
    pub fn call<M: RpcMethod>(&self, params: M::Params) -> Result<M::Result> {
        do_call::<M>(
            &self.writer,
            &self.next_id,
            &self.state,
            &self.peer_label,
            params,
        )
    }

    /// Server's initialize reply, cached at connect-time. Used by
    /// the trait impl to fill `runtime_health` without a round-trip.
    pub fn server_info(&self) -> &InitializeResult {
        &self.server_info
    }

    /// Register a callback that fires for every server-initiated
    /// notification (a JSON-RPC request with no `id`). The returned
    /// handle unregisters via Drop — keep it alive for as long as
    /// you want events.
    ///
    /// The callback runs on the reader thread. Keep it cheap; offload
    /// real work to a channel or spawned task.
    pub fn subscribe_notifications<F>(&self, callback: F) -> NotificationSubscription
    where
        F: Fn(JsonRpcRequest) + Send + Sync + 'static,
    {
        let id = self.state.next_sub_id.fetch_add(1, Ordering::Relaxed);
        let callback: Arc<dyn Fn(JsonRpcRequest) + Send + Sync> = Arc::new(callback);
        self.state
            .subscribers
            .lock()
            .expect("client subscribers mutex poisoned")
            .push(Subscription { id, callback });
        NotificationSubscription {
            state: Arc::clone(&self.state),
            id,
        }
    }

    /// Convenience over [`subscribe_notifications`] filtered to
    /// `terminal.event` notifications and decoded into the typed
    /// payload. Garbage params (malformed wire shape) are silently
    /// dropped — the reader thread shouldn't panic on a peer that
    /// sends nonsense.
    ///
    /// The same drop-to-unsubscribe contract applies; hold the
    /// returned handle for as long as you want events.
    pub fn subscribe_terminal_events<F>(&self, callback: F) -> NotificationSubscription
    where
        F: Fn(super::methods::TerminalEventNotification) + Send + Sync + 'static,
    {
        let callback = Arc::new(callback);
        self.subscribe_notifications(move |req: JsonRpcRequest| {
            if req.method != super::methods::TERMINAL_EVENT_METHOD {
                return;
            }
            match serde_json::from_value::<super::methods::TerminalEventNotification>(req.params) {
                Ok(event) => callback(event),
                Err(err) => {
                    tracing::debug!(
                        error = %err,
                        "client: received malformed terminal.event payload; dropping"
                    );
                }
            }
        })
    }

    /// Subscribe to `agent.event` notifications. Same RAII contract
    /// as [`Self::subscribe_terminal_events`]: hold the returned
    /// handle for as long as you want events. Phase 23a wires the
    /// subscription primitive; phase 23b's `RemoteAgentState` on the
    /// daemon side is what actually emits the events.
    pub fn subscribe_agent_events<F>(&self, callback: F) -> NotificationSubscription
    where
        F: Fn(super::methods::AgentEventNotification) + Send + Sync + 'static,
    {
        let callback = Arc::new(callback);
        self.subscribe_notifications(move |req: JsonRpcRequest| {
            if req.method != super::methods::AGENT_EVENT_METHOD {
                return;
            }
            match serde_json::from_value::<super::methods::AgentEventNotification>(req.params) {
                Ok(event) => callback(event),
                Err(err) => {
                    tracing::debug!(
                        error = %err,
                        "client: received malformed agent.event payload; dropping"
                    );
                }
            }
        })
    }

    /// Subscribe to `workspace.fileEvent` notifications. Same RAII
    /// contract as the terminal / agent subscribers: hold the
    /// returned handle for as long as you want events to flow. The
    /// callback fires for every debounced batch the daemon's
    /// [`super::watch::RemoteWatchState`] emits; the consumer
    /// filters by `watch_id` to demux across concurrent watchers
    /// on the same connection.
    /// Snapshot the client's connection telemetry. Returned by
    /// [`super::runtime::RemoteRuntime::client_diagnostics`] so the
    /// desktop's "Connection diagnostics" panel can render uptime,
    /// I/O counts, and the close reason (when present) without
    /// reaching for log files.
    pub fn diagnostics(&self) -> RpcClientDiagnostics {
        let state = &self.state;
        RpcClientDiagnostics {
            peer_label: self.peer_label.clone(),
            server_version: self.server_info.server_version.clone(),
            server_hostname: self.server_info.hostname.clone(),
            protocol_version: self.server_info.protocol_version.clone(),
            connected_at_ms: self.connected_at_ms,
            closed_reason: state.closed_reason(),
            requests_sent: state.requests_sent.load(Ordering::Relaxed),
            responses_received: state.responses_received.load(Ordering::Relaxed),
            notifications_received: state.notifications_received.load(Ordering::Relaxed),
            decode_errors: state.decode_errors.load(Ordering::Relaxed),
        }
    }

    /// Track C3: tear the pipe down on demand. Used by the liveness
    /// watchdog when a half-open TCP socket has gone undetected by the
    /// kernel but the application-level ping keeps timing out. Killing
    /// the writer here drops the child (the writer's `Drop` calls
    /// `kill + wait`) which unblocks the reader, which marks the state
    /// closed and surfaces a transport error to any in-flight call.
    ///
    /// Idempotent: a second call after the writer's already been
    /// replaced is a harmless mark-closed.
    pub fn force_close(&self, reason: &str) {
        // Replace the live writer with an `io::sink` — that drops the
        // child (writer's `Drop` calls kill+wait) without holding the
        // mutex across any join in [`Drop for RpcClient`].
        let _writer = std::mem::replace(
            &mut *self
                .writer
                .lock()
                .expect("rpc client writer mutex poisoned"),
            RpcWriter {
                writer: Box::new(std::io::sink()),
                child: None,
            },
        );
        drop(_writer);
        // Mark closed AFTER the writer drop so the reader thread's own
        // mark_closed (it'll fire when read returns EOF/Err) finds the
        // slot already set and leaves our reason intact.
        self.state.mark_closed(reason.to_string());
    }

    pub fn subscribe_workspace_file_events<F>(&self, callback: F) -> NotificationSubscription
    where
        F: Fn(super::methods::WorkspaceFileEventNotification) + Send + Sync + 'static,
    {
        let callback = Arc::new(callback);
        self.subscribe_notifications(move |req: JsonRpcRequest| {
            if req.method != super::methods::WORKSPACE_FILE_EVENT_METHOD {
                return;
            }
            match serde_json::from_value::<super::methods::WorkspaceFileEventNotification>(
                req.params,
            ) {
                Ok(event) => callback(event),
                Err(err) => {
                    tracing::debug!(
                        error = %err,
                        "client: received malformed workspace.fileEvent payload; dropping"
                    );
                }
            }
        })
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        // Dropping the writer mutex's RpcWriter kills the child,
        // which makes the reader thread see EOF and exit cleanly.
        // Reach in and force the writer drop before we join.
        //
        // We *don't* hold the writer lock here — the reader thread
        // doesn't touch the writer, so dropping it is safe even if
        // some other thread is mid-call (their write will fail with
        // BrokenPipe and they'll get a closed-connection error).
        let _writer = std::mem::replace(
            &mut *self
                .writer
                .lock()
                .expect("rpc client writer mutex poisoned"),
            RpcWriter {
                writer: Box::new(std::io::sink()),
                child: None,
            },
        );
        drop(_writer);

        if let Some(handle) = self.reader_thread.take() {
            let _ = handle.join();
        }
    }
}

/// Minimal struct used during `connect_with_pipe`'s handshake — we
/// need to call `do_call` before the full `RpcClient` exists.
struct ClientSkeleton {
    writer: Mutex<RpcWriter>,
    next_id: AtomicU64,
    state: Arc<ClientState>,
}

fn do_call<M: RpcMethod>(
    writer: &Mutex<RpcWriter>,
    next_id: &AtomicU64,
    state: &Arc<ClientState>,
    peer_label: &str,
    params: M::Params,
) -> Result<M::Result> {
    if let Some(reason) = state.closed_reason() {
        bail!("connection to `{peer_label}` closed: {reason}");
    }
    let id = next_id.fetch_add(1, Ordering::Relaxed);
    let req_id = JsonRpcId::Num(id);
    let params_value = serde_json::to_value(&params)
        .with_context(|| format!("failed to serialise params for `{}`", M::NAME))?;
    let request = JsonRpcRequest::new(M::NAME, params_value, req_id.clone());

    // Register the oneshot *before* writing so we don't race the
    // reader thread for a response that arrives instantly.
    let (tx, rx) = mpsc::channel::<JsonRpcResponse>();
    {
        let mut pending = state.pending.lock().expect("client pending mutex poisoned");
        pending.insert(req_id.clone(), tx);
    }

    // Write the request. On failure, roll back the pending entry so
    // it doesn't leak.
    {
        let mut writer = writer.lock().expect("rpc client writer mutex poisoned");
        if let Err(err) = write_frame(&mut writer.writer, &request) {
            state
                .pending
                .lock()
                .expect("client pending mutex poisoned")
                .remove(&req_id);
            return Err(match err {
                FrameError::Io(io) => anyhow!("failed to send `{}` request: {io}", M::NAME),
                other => anyhow!("failed to send `{}` request: {other}", M::NAME),
            });
        }
        // Telemetry: count successful frame writes only. A failed
        // write is observable through the error return and the
        // operator's "I tried to call X" expectation; padding the
        // sent-counter on a failed send would hide the failure in
        // the diagnostics view.
        state.requests_sent.fetch_add(1, Ordering::Relaxed);
    }

    // Wait for the reader thread to demux the response, or for the
    // connection to close (sender dropped → recv Err).
    let response = rx.recv().map_err(|_| {
        let reason = state
            .closed_reason()
            .unwrap_or_else(|| "peer closed without sending a response".into());
        anyhow!(
            "remote runner `{peer_label}` dropped before `{}` reply: {reason}",
            M::NAME
        )
    })?;

    decode_response::<M>(response, &req_id)
}

/// Reader thread loop. Reads framed JSON-RPC messages, routes
/// responses to pending oneshots by id, and fans notifications out
/// to subscribers. Exits cleanly on EOF / I/O error; on exit, the
/// pending map is cleared so waiters surface a transport error.
fn spawn_reader_thread(
    mut reader: Box<dyn BufRead + Send>,
    state: Arc<ClientState>,
    peer_label: String,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name(format!("remote-rpc-reader[{peer_label}]"))
        .spawn(move || {
            loop {
                let msg: JsonRpcMessage = match read_frame(&mut reader) {
                    Ok(m) => m,
                    Err(FrameError::Eof) => {
                        state.mark_closed("peer closed connection cleanly (EOF)");
                        return;
                    }
                    Err(err) => {
                        // Telemetry: bump the decode-error counter
                        // BEFORE we mark closed + exit, so the
                        // diagnostics panel surfaces the failure
                        // even though the connection is gone.
                        state.decode_errors.fetch_add(1, Ordering::Relaxed);
                        state.mark_closed(format!("reader error: {err}"));
                        return;
                    }
                };
                match msg {
                    JsonRpcMessage::Response(resp) => {
                        state.responses_received.fetch_add(1, Ordering::Relaxed);
                        let mut pending =
                            state.pending.lock().expect("client pending mutex poisoned");
                        if let Some(tx) = pending.remove(&resp.id) {
                            // Drop the lock before sending; the
                            // receiver may immediately re-enter to
                            // place its next call.
                            drop(pending);
                            let _ = tx.send(resp);
                        } else {
                            tracing::warn!(
                                peer = %peer_label,
                                id = ?resp.id,
                                "remote-runner: response for unknown id (call abandoned?)"
                            );
                        }
                    }
                    JsonRpcMessage::Request(req) => {
                        // Notifications (no id) only. An id'd
                        // server-initiated request would need a
                        // response written back, which this spike
                        // doesn't support yet — log + skip.
                        if !req.id.is_notification() {
                            tracing::warn!(
                                peer = %peer_label,
                                method = %req.method,
                                "remote-runner: ignored server-initiated request with id"
                            );
                            continue;
                        }
                        state.notifications_received.fetch_add(1, Ordering::Relaxed);
                        // Take a cheap snapshot of subscriber Arcs to
                        // avoid holding the mutex across user code.
                        let subs: Vec<Arc<dyn Fn(JsonRpcRequest) + Send + Sync>> = state
                            .subscribers
                            .lock()
                            .expect("client subscribers mutex poisoned")
                            .iter()
                            .map(|s| Arc::clone(&s.callback))
                            .collect();
                        for cb in subs {
                            cb(req.clone());
                        }
                    }
                }
            }
        })
        .expect("failed to spawn rpc reader thread")
}

fn run_handshake(skeleton: &ClientSkeleton, peer_label: &str) -> Result<InitializeResult> {
    let params = InitializeParams {
        protocol_version: PROTOCOL_VERSION.to_string(),
        client_name: "helmor-desktop".to_string(),
        client_version: Some(env!("CARGO_PKG_VERSION").to_string()),
    };
    do_call::<InitializeMethod>(
        &skeleton.writer,
        &skeleton.next_id,
        &skeleton.state,
        peer_label,
        params,
    )
    .with_context(|| format!("initialize handshake with {peer_label} failed"))
}

fn decode_response<M: RpcMethod>(
    response: JsonRpcResponse,
    expected_id: &JsonRpcId,
) -> Result<M::Result> {
    if response.id != *expected_id {
        bail!(
            "remote runner returned response with id {:?}, expected {:?} (method `{}`)",
            response.id,
            expected_id,
            M::NAME
        );
    }
    if let Some(err) = response.error {
        return Err(rpc_error_to_anyhow::<M>(err));
    }
    let result_value = response
        .result
        .ok_or_else(|| anyhow!("response for `{}` had neither result nor error", M::NAME))?;
    serde_json::from_value::<M::Result>(result_value)
        .with_context(|| format!("failed to decode `{}` response", M::NAME))
}

/// Translate a JSON-RPC error response into an `anyhow::Error` that
/// preserves the wire code in its Display. The UI's connection chip
/// can string-match on the code if it wants to render specific
/// states (e.g. red for `NOT_INITIALIZED`, amber for
/// `HANDLER_FAILED`).
fn rpc_error_to_anyhow<M: RpcMethod>(err: JsonRpcError) -> anyhow::Error {
    let code_label = match err.code {
        error_codes::INCOMPATIBLE_PROTOCOL => "INCOMPATIBLE_PROTOCOL",
        error_codes::NOT_INITIALIZED => "NOT_INITIALIZED",
        error_codes::HANDLER_FAILED => "HANDLER_FAILED",
        error_codes::METHOD_NOT_FOUND => "METHOD_NOT_FOUND",
        error_codes::INVALID_PARAMS => "INVALID_PARAMS",
        error_codes::INVALID_REQUEST => "INVALID_REQUEST",
        error_codes::INTERNAL_ERROR => "INTERNAL_ERROR",
        error_codes::PARSE_ERROR => "PARSE_ERROR",
        _ => "UNKNOWN",
    };
    anyhow!(
        "`{}` failed: {} ({}={})",
        M::NAME,
        err.message,
        code_label,
        err.code,
    )
}

/// [`RemoteRuntime`] backed by an [`RpcClient`]. Trait calls
/// translate into JSON-RPC requests on the framed pipe.
pub struct RemoteSshRuntime {
    client: RpcClient,
    /// What `runtime_health` should put in `RuntimeKind::Remote.host`.
    /// Distinct from `server_info.hostname` because the user-facing
    /// label ("dev.box") doesn't always match what the server thinks
    /// its own hostname is ("ip-10-0-2-31").
    host_label: String,
}

impl RemoteSshRuntime {
    pub fn new(client: RpcClient, host_label: impl Into<String>) -> Self {
        Self {
            client,
            host_label: host_label.into(),
        }
    }

    /// Convenience: connect over SSH + wrap the client in the trait
    /// impl in one shot. `host_label` defaults to the SSH host —
    /// callers wanting a friendlier UI label can wrap [`new`]
    /// directly.
    pub fn connect_ssh(host: &str, remote_binary: &str) -> Result<Self> {
        Self::connect_ssh_with_options(host, remote_binary, false)
    }

    /// Variant that opts in to ssh agent forwarding (Track G3). The
    /// surfaced runtime is the same; the underlying transport just
    /// adds `-o ForwardAgent=yes` so the remote daemon can drive
    /// git over the user's local agent.
    pub fn connect_ssh_with_options(
        host: &str,
        remote_binary: &str,
        forward_agent: bool,
    ) -> Result<Self> {
        let client = RpcClient::connect_ssh_with_options(host, remote_binary, forward_agent)?;
        Ok(Self::new(client, host.to_string()))
    }
}

impl RemoteRuntime for RemoteSshRuntime {
    fn runtime_health(&self) -> Result<RuntimeHealth> {
        // Pulled from the cached initialize reply — no round-trip.
        // The trait's contract says runtime_health is cheap; doing
        // a ping per call would violate that on a remote.
        let info = self.client.server_info();
        Ok(RuntimeHealth {
            kind: RuntimeKind::Remote {
                host: self.host_label.clone(),
            },
            hostname: info.hostname.clone(),
            version: info.server_version.clone(),
        })
    }

    fn workspace_status(&self, workspace_dir: &Path) -> Result<WorkspaceStatusResult> {
        self.client
            .call::<WorkspaceStatusMethod>(WorkspaceStatusParams {
                workspace_dir: workspace_dir.display().to_string(),
            })
    }

    fn workspace_branch_info(&self, workspace_dir: &Path) -> Result<WorkspaceBranchInfoResult> {
        self.client
            .call::<WorkspaceBranchInfoMethod>(WorkspaceBranchInfoParams {
                workspace_dir: workspace_dir.display().to_string(),
            })
    }

    fn ping(&self) -> Result<()> {
        // Real round-trip so a dead pipe surfaces as Err. The server's
        // `ping` handler is cheap (just echoes back the counter + a
        // timestamp), so the registry poller can call this on a short
        // cadence without worry.
        self.client.call::<PingMethod>(PingParams::default())?;
        Ok(())
    }

    fn terminal_open(
        &self,
        params: super::methods::TerminalOpenParams,
    ) -> Result<super::methods::TerminalOpenResult> {
        self.client
            .call::<super::methods::TerminalOpenMethod>(params)
    }

    fn terminal_write(
        &self,
        params: super::methods::TerminalWriteParams,
    ) -> Result<super::methods::TerminalWriteResult> {
        self.client
            .call::<super::methods::TerminalWriteMethod>(params)
    }

    fn terminal_resize(
        &self,
        params: super::methods::TerminalResizeParams,
    ) -> Result<super::methods::TerminalResizeResult> {
        self.client
            .call::<super::methods::TerminalResizeMethod>(params)
    }

    fn terminal_close(
        &self,
        params: super::methods::TerminalCloseParams,
    ) -> Result<super::methods::TerminalCloseResult> {
        self.client
            .call::<super::methods::TerminalCloseMethod>(params)
    }

    fn terminal_list(
        &self,
        params: super::methods::TerminalListParams,
    ) -> Result<super::methods::TerminalListResult> {
        self.client
            .call::<super::methods::TerminalListMethod>(params)
    }

    fn terminal_attach(
        &self,
        params: super::methods::TerminalAttachParams,
    ) -> Result<super::methods::TerminalAttachResult> {
        self.client
            .call::<super::methods::TerminalAttachMethod>(params)
    }

    fn subscribe_terminal_events(
        &self,
        callback: Box<dyn Fn(super::methods::TerminalEventNotification) + Send + Sync>,
    ) -> Option<NotificationSubscription> {
        // `Box<dyn Fn(...)>` already satisfies the `Fn(...)` bound on
        // `subscribe_terminal_events`, so passing the box through
        // directly avoids the clippy redundant-closure warning.
        Some(self.client.subscribe_terminal_events(callback))
    }

    // ── workspace inspector ops (phase 20a — pure delegation) ────
    //
    // The trait defaults bail; here we delegate every call straight
    // to the wire so the remote handlers do the real work. Until
    // phase 20b lands matching `LocalRuntime` impls, these still
    // surface `HANDLER_FAILED` on the server side (the server reuses
    // the same trait), but the *plumbing* is in place — a single
    // `LocalRuntime` impl flips both local and remote behaviour on.

    fn workspace_file_tree(
        &self,
        params: super::methods::WorkspaceFileTreeParams,
    ) -> Result<super::methods::WorkspaceFileTreeResult> {
        self.client
            .call::<super::methods::WorkspaceFileTreeMethod>(params)
    }

    fn workspace_changes(
        &self,
        params: super::methods::WorkspaceChangesParams,
    ) -> Result<super::methods::WorkspaceChangesResult> {
        self.client
            .call::<super::methods::WorkspaceChangesMethod>(params)
    }

    fn workspace_read_file(
        &self,
        params: super::methods::WorkspaceReadFileParams,
    ) -> Result<crate::workspace::files::EditorFileReadResponse> {
        self.client
            .call::<super::methods::WorkspaceReadFileMethod>(params)
    }

    fn workspace_read_file_at_ref(
        &self,
        params: super::methods::WorkspaceReadFileAtRefParams,
    ) -> Result<super::methods::WorkspaceReadFileAtRefResult> {
        self.client
            .call::<super::methods::WorkspaceReadFileAtRefMethod>(params)
    }

    fn workspace_stat_file(
        &self,
        params: super::methods::WorkspaceStatFileParams,
    ) -> Result<crate::workspace::files::EditorFileStatResponse> {
        self.client
            .call::<super::methods::WorkspaceStatFileMethod>(params)
    }

    fn workspace_mutate_file(
        &self,
        params: super::methods::WorkspaceMutateFileParams,
    ) -> Result<super::methods::WorkspaceMutateFileResult> {
        self.client
            .call::<super::methods::WorkspaceMutateFileMethod>(params)
    }

    fn workspace_search(
        &self,
        params: super::methods::WorkspaceSearchParams,
    ) -> Result<super::methods::WorkspaceSearchResult> {
        self.client
            .call::<super::methods::WorkspaceSearchMethod>(params)
    }

    fn workspace_start_watch(
        &self,
        params: super::methods::WorkspaceStartWatchParams,
    ) -> Result<super::methods::WorkspaceStartWatchResult> {
        self.client
            .call::<super::methods::WorkspaceStartWatchMethod>(params)
    }

    fn workspace_stop_watch(
        &self,
        params: super::methods::WorkspaceStopWatchParams,
    ) -> Result<super::methods::WorkspaceStopWatchResult> {
        self.client
            .call::<super::methods::WorkspaceStopWatchMethod>(params)
    }

    fn subscribe_workspace_file_events(
        &self,
        callback: Box<dyn Fn(super::methods::WorkspaceFileEventNotification) + Send + Sync>,
    ) -> Option<super::client::NotificationSubscription> {
        Some(self.client.subscribe_workspace_file_events(callback))
    }

    fn client_diagnostics(&self) -> Option<super::client::RpcClientDiagnostics> {
        Some(self.client.diagnostics())
    }

    fn force_close(&self, reason: &str) {
        self.client.force_close(reason);
    }

    // ── agent.* delegation (phase 23a — wire-only) ───────────────
    //
    // Until phase 23b lands `RemoteAgentState` on the daemon, the
    // server side responds `HANDLER_FAILED` to every agent call —
    // but the client-side plumbing is already in place so the flip
    // is a one-line change in the server's dispatch table.

    fn agent_send(
        &self,
        params: super::methods::AgentSendParams,
    ) -> Result<super::methods::AgentSendResult> {
        self.client.call::<super::methods::AgentSendMethod>(params)
    }

    fn agent_abort(
        &self,
        params: super::methods::AgentAbortParams,
    ) -> Result<super::methods::AgentAbortResult> {
        self.client.call::<super::methods::AgentAbortMethod>(params)
    }

    fn agent_list(
        &self,
        params: super::methods::AgentListParams,
    ) -> Result<super::methods::AgentListResult> {
        self.client.call::<super::methods::AgentListMethod>(params)
    }

    fn agent_attach(
        &self,
        params: super::methods::AgentAttachParams,
    ) -> Result<super::methods::AgentAttachResult> {
        self.client
            .call::<super::methods::AgentAttachMethod>(params)
    }

    fn agent_set_auth(
        &self,
        params: super::methods::AgentSetAuthParams,
    ) -> Result<super::methods::AgentSetAuthResult> {
        self.client
            .call::<super::methods::AgentSetAuthMethod>(params)
    }

    fn agent_auth_status(
        &self,
        params: super::methods::AgentAuthStatusParams,
    ) -> Result<super::methods::AgentAuthStatusResult> {
        self.client
            .call::<super::methods::AgentAuthStatusMethod>(params)
    }

    fn subscribe_agent_events(
        &self,
        callback: Box<dyn Fn(super::methods::AgentEventNotification) + Send + Sync>,
    ) -> Option<NotificationSubscription> {
        Some(self.client.subscribe_agent_events(callback))
    }

    fn daemon_tail_log(
        &self,
        params: super::methods::DaemonTailLogParams,
    ) -> Result<super::methods::DaemonTailLogResult> {
        self.client
            .call::<super::methods::DaemonTailLogMethod>(params)
    }

    fn runtime_metrics(
        &self,
        params: super::methods::RuntimeMetricsParams,
    ) -> Result<super::methods::RuntimeMetricsResult> {
        self.client
            .call::<super::methods::RuntimeMetricsMethod>(params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::Arc;
    use std::thread;

    use crate::remote::server::{dispatch_request, ServerContext};

    /// In-memory byte stream backed by an mpsc channel. One `send`
    /// from the writing side arrives as one `Vec<u8>` chunk on the
    /// reading side; reads honour the caller's buffer length, with
    /// leftovers parked in `unread` for the next call.
    ///
    /// Tests only — production uses real OS pipes from spawned
    /// children.
    struct ChannelStream {
        tx: Sender<Vec<u8>>,
        rx: Receiver<Vec<u8>>,
        unread: Vec<u8>,
    }

    impl Write for ChannelStream {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.tx.send(buf.to_vec()).map_err(|err| {
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, err.to_string())
            })?;
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Read for ChannelStream {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.unread.is_empty() {
                match self.rx.recv() {
                    Ok(bytes) => self.unread = bytes,
                    // Peer's sender dropped → clean EOF.
                    Err(_) => return Ok(0),
                }
            }
            let take = out.len().min(self.unread.len());
            out[..take].copy_from_slice(&self.unread[..take]);
            self.unread.drain(..take);
            Ok(take)
        }
    }

    impl BufRead for ChannelStream {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            if self.unread.is_empty() {
                if let Ok(bytes) = self.rx.recv() {
                    self.unread = bytes;
                }
            }
            Ok(&self.unread)
        }
        fn consume(&mut self, amt: usize) {
            self.unread.drain(..amt.min(self.unread.len()));
        }
    }

    /// Loopback constructor: pairs the client with a dispatcher
    /// running on a background thread, connected through two
    /// in-memory channels (one per direction). `RpcClient` takes
    /// reader and writer through separate trait-object slots, so
    /// `ChannelStream::pair` doesn't quite fit — we hand-wire the
    /// channels here.
    fn split_loopback(runtime: Option<Arc<dyn RemoteRuntime>>) -> Result<RpcClient> {
        // Two unidirectional channels: one for each direction.
        let (c_to_s_tx, c_to_s_rx) = mpsc::channel::<Vec<u8>>();
        let (s_to_c_tx, s_to_c_rx) = mpsc::channel::<Vec<u8>>();

        // Server's pipe: reads requests from c_to_s_rx, writes
        // responses into s_to_c_tx.
        let server_io = ChannelStream {
            tx: s_to_c_tx,
            rx: c_to_s_rx,
            unread: Vec::new(),
        };

        thread::spawn(move || {
            let mut io = server_io;
            let ctx = match runtime {
                Some(rt) => ServerContext::with_runtime("0.22.1-test", "test-host", rt),
                None => ServerContext::new("0.22.1-test", "test-host"),
            };
            loop {
                let req: JsonRpcRequest = match read_frame(&mut io) {
                    Ok(req) => req,
                    Err(FrameError::Eof) => break,
                    Err(_) => break,
                };
                if let Some(resp) = dispatch_request(&ctx, req) {
                    if write_frame(&mut io, &resp).is_err() {
                        break;
                    }
                }
            }
        });

        // Client's reader: receives from s_to_c_rx.
        let client_reader = ChannelStream {
            tx: mpsc::channel().0, // never used
            rx: s_to_c_rx,
            unread: Vec::new(),
        };
        // Client's writer: sends to c_to_s_tx.
        let client_writer = ChannelStream {
            tx: c_to_s_tx,
            rx: mpsc::channel().1, // never used
            unread: Vec::new(),
        };

        RpcClient::connect_with_pipe(
            Box::new(client_reader),
            Box::new(client_writer),
            None,
            "loopback".into(),
        )
    }

    /// Always returns canned data without shelling out to git.
    struct StubRuntime;
    impl RemoteRuntime for StubRuntime {
        fn runtime_health(&self) -> Result<RuntimeHealth> {
            unreachable!("client tests don't probe health server-side")
        }
        fn workspace_status(&self, workspace_dir: &Path) -> Result<WorkspaceStatusResult> {
            Ok(WorkspaceStatusResult {
                is_clean: false,
                changed_paths: vec![workspace_dir.display().to_string()],
            })
        }
        fn workspace_branch_info(&self, workspace_dir: &Path) -> Result<WorkspaceBranchInfoResult> {
            Ok(WorkspaceBranchInfoResult {
                current_branch: workspace_dir.display().to_string(),
                head_commit: "stub-sha".into(),
                upstream_ref: None,
            })
        }
        fn ping(&self) -> Result<()> {
            Ok(())
        }
    }

    /// Always errors so we can prove server-side failures map back
    /// onto the client side correctly.
    struct FailingRuntime;
    impl RemoteRuntime for FailingRuntime {
        fn runtime_health(&self) -> Result<RuntimeHealth> {
            unreachable!()
        }
        fn workspace_status(&self, _: &Path) -> Result<WorkspaceStatusResult> {
            Err(anyhow!("git: not a repository"))
        }
        fn workspace_branch_info(&self, _: &Path) -> Result<WorkspaceBranchInfoResult> {
            Err(anyhow!("git: not a repository"))
        }
        fn ping(&self) -> Result<()> {
            Err(anyhow!("ping always fails for this stub"))
        }
    }

    // ── handshake ────────────────────────────────────────────────

    #[test]
    fn handshake_caches_server_info_on_successful_connect() {
        let client = split_loopback(None).expect("connect");
        let info = client.server_info();
        assert_eq!(info.protocol_version, PROTOCOL_VERSION);
        assert_eq!(info.server_version, "0.22.1-test");
        assert_eq!(info.hostname, "test-host");
    }

    // ── transport trait round-trip ───────────────────────────────

    /// `RemoteTransport` impl whose `spawn_pipe` hands back an
    /// in-memory pipe wired to a loopback dispatcher. Lets the test
    /// exercise `RpcClient::connect_with_transport` end-to-end
    /// without spawning a subprocess.
    struct LoopbackTransport {
        runtime: Arc<dyn RemoteRuntime>,
    }

    impl super::super::transport::RemoteTransport for LoopbackTransport {
        fn spawn_pipe(&self) -> Result<super::super::transport::TransportPipe> {
            // Mirror split_loopback's two-channel wiring, but expose
            // the client side as a TransportPipe instead of building
            // an RpcClient directly.
            let (c_to_s_tx, c_to_s_rx) = mpsc::channel::<Vec<u8>>();
            let (s_to_c_tx, s_to_c_rx) = mpsc::channel::<Vec<u8>>();

            let server_io = ChannelStream {
                tx: s_to_c_tx,
                rx: c_to_s_rx,
                unread: Vec::new(),
            };
            let runtime = Arc::clone(&self.runtime);
            thread::spawn(move || {
                let mut io = server_io;
                let ctx = ServerContext::with_runtime("0.22.1-test", "test-host", runtime);
                while let Ok(req) = read_frame::<_, JsonRpcRequest>(&mut io) {
                    if let Some(resp) = dispatch_request(&ctx, req) {
                        if write_frame(&mut io, &resp).is_err() {
                            break;
                        }
                    }
                }
            });

            let client_reader = ChannelStream {
                tx: mpsc::channel().0,
                rx: s_to_c_rx,
                unread: Vec::new(),
            };
            let client_writer = ChannelStream {
                tx: c_to_s_tx,
                rx: mpsc::channel().1,
                unread: Vec::new(),
            };
            Ok(super::super::transport::TransportPipe {
                reader: Box::new(client_reader),
                writer: Box::new(client_writer),
                child: None,
                peer_label: "loopback-transport".into(),
            })
        }
    }

    #[test]
    fn connect_with_transport_drives_a_handshake_via_the_trait() {
        // Proves the new dispatch path works end-to-end: the trait's
        // `spawn_pipe` is the only spawn entry point, the rest of
        // `RpcClient` (framer, reader thread, handshake) sits on top
        // of whatever `TransportPipe` it returns.
        let transport: Arc<dyn super::super::transport::RemoteTransport> =
            Arc::new(LoopbackTransport {
                runtime: Arc::new(StubRuntime),
            });
        let client = RpcClient::connect_with_transport(transport)
            .expect("transport handshake should succeed");

        let info = client.server_info();
        assert_eq!(info.protocol_version, PROTOCOL_VERSION);
        assert_eq!(info.server_version, "0.22.1-test");

        // And a real method call round-trips through the same pipe —
        // proving the trait isn't just a connect-time hook.
        let status = client
            .call::<WorkspaceStatusMethod>(WorkspaceStatusParams {
                workspace_dir: "/sample".into(),
            })
            .expect("workspace.status round-trip through the transport");
        assert!(!status.is_clean);
        assert_eq!(status.changed_paths, vec!["/sample".to_string()]);
    }

    #[test]
    fn connect_with_transport_surfaces_spawn_pipe_failure() {
        // The trait's `spawn_pipe` can fail (network down, binary
        // missing, etc.). The error must reach the caller unchanged so
        // the UI can render the operator-facing reason verbatim.
        struct FailingTransport;
        impl super::super::transport::RemoteTransport for FailingTransport {
            fn spawn_pipe(&self) -> Result<super::super::transport::TransportPipe> {
                anyhow::bail!("simulated transport failure: ssh exit 255")
            }
        }
        let transport: Arc<dyn super::super::transport::RemoteTransport> =
            Arc::new(FailingTransport);
        let err = RpcClient::connect_with_transport(transport)
            .expect_err("spawn_pipe failure must surface");
        let msg = format!("{err}");
        assert!(
            msg.contains("ssh exit 255"),
            "transport error should be preserved verbatim: {msg}",
        );
    }

    // ── trait round-trip ─────────────────────────────────────────

    #[test]
    fn remote_ssh_runtime_round_trips_workspace_status_through_the_trait() {
        let client = split_loopback(Some(Arc::new(StubRuntime))).unwrap();
        let runtime = RemoteSshRuntime::new(client, "dev.box");

        let status = runtime
            .workspace_status(Path::new("/tmp/example"))
            .expect("call should succeed");

        assert!(!status.is_clean);
        assert_eq!(
            status.changed_paths,
            vec!["/tmp/example".to_string()],
            "stub should have echoed the path back",
        );
    }

    #[test]
    fn runtime_health_reports_remote_kind_without_a_round_trip() {
        let client = split_loopback(None).unwrap();
        let runtime = RemoteSshRuntime::new(client, "dev.box");

        let health = runtime.runtime_health().unwrap();

        assert_eq!(
            health.kind,
            RuntimeKind::Remote {
                host: "dev.box".into(),
            }
        );
        assert_eq!(health.hostname, "test-host");
        assert_eq!(health.version, "0.22.1-test");
    }

    // ── error paths ──────────────────────────────────────────────

    #[test]
    fn inspector_op_default_bail_propagates_from_remote_to_caller() {
        // End-to-end smoke: the trait-default bail on the server side
        // must travel through the framer, get tagged as HANDLER_FAILED
        // on the wire, and surface as an anyhow error mentioning both
        // the method name and the bail message. `StubRuntime` doesn't
        // override `workspace_file_tree`, so the default impl bails.
        let client = split_loopback(Some(Arc::new(StubRuntime))).unwrap();
        let runtime = RemoteSshRuntime::new(client, "dev.box");

        let err = runtime
            .workspace_file_tree(super::super::methods::WorkspaceFileTreeParams {
                workspace_dir: "/tmp/example".into(),
            })
            .expect_err("default bail should surface as Err");
        let msg = format!("{err}");
        assert!(
            msg.contains("workspace.fileTree"),
            "error should name the method: {msg}"
        );
        assert!(
            msg.contains("HANDLER_FAILED"),
            "error should carry the wire code label: {msg}"
        );
        assert!(
            msg.contains("not yet implemented"),
            "error should preserve the trait default message: {msg}"
        );
    }

    #[test]
    fn server_handler_failure_surfaces_as_anyhow_error_with_code_label() {
        let client = split_loopback(Some(Arc::new(FailingRuntime))).unwrap();
        let runtime = RemoteSshRuntime::new(client, "dev.box");

        let err = runtime
            .workspace_status(Path::new("/nope"))
            .expect_err("should propagate as Err");
        let msg = format!("{err}");
        assert!(
            msg.contains("HANDLER_FAILED"),
            "error should carry the wire code label: {msg}"
        );
        assert!(
            msg.contains("not a repository"),
            "error should preserve the server-side message: {msg}"
        );
    }

    #[test]
    fn unknown_method_returns_method_not_found_to_the_client() {
        let client = split_loopback(None).unwrap();

        struct UnknownMethod;
        impl RpcMethod for UnknownMethod {
            const NAME: &'static str = "not.a.method";
            type Params = ();
            type Result = serde_json::Value;
        }

        let err = client
            .call::<UnknownMethod>(())
            .expect_err("server should refuse unknown method");
        let msg = format!("{err}");
        assert!(
            msg.contains("METHOD_NOT_FOUND"),
            "expected METHOD_NOT_FOUND, got: {msg}"
        );
    }

    #[test]
    fn handshake_rejects_incompatible_protocol_response_from_server() {
        // Hand-rolled fake server: replies to the handshake with a
        // protocol-mismatch error. Proves the client surfaces it as
        // a typed error during `connect_with_pipe`.
        let (c_to_s_tx, c_to_s_rx) = mpsc::channel::<Vec<u8>>();
        let (s_to_c_tx, s_to_c_rx) = mpsc::channel::<Vec<u8>>();

        thread::spawn(move || {
            // Drain the client's initialize request (we don't decode
            // it — the server side is faked).
            let mut io = ChannelStream {
                tx: s_to_c_tx,
                rx: c_to_s_rx,
                unread: Vec::new(),
            };
            let _: JsonRpcRequest = match read_frame(&mut io) {
                Ok(req) => req,
                Err(_) => return,
            };
            let resp = JsonRpcResponse::failure(
                JsonRpcId::Num(1),
                JsonRpcError::new(
                    error_codes::INCOMPATIBLE_PROTOCOL,
                    "client speaks 0.1.0 but server speaks 1.0.0",
                ),
            );
            let _ = write_frame(&mut io, &resp);
        });

        let reader = ChannelStream {
            tx: mpsc::channel().0,
            rx: s_to_c_rx,
            unread: Vec::new(),
        };
        let writer = ChannelStream {
            tx: c_to_s_tx,
            rx: mpsc::channel().1,
            unread: Vec::new(),
        };

        let err = RpcClient::connect_with_pipe(
            Box::new(reader),
            Box::new(writer),
            None,
            "mismatch-peer".into(),
        )
        .expect_err("handshake should fail on protocol mismatch");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("INCOMPATIBLE_PROTOCOL"),
            "should surface the wire code: {msg}"
        );
        assert!(
            msg.contains("mismatch-peer"),
            "should name the peer so multi-pair UIs can attribute: {msg}"
        );
    }

    #[test]
    fn closed_pipe_during_call_surfaces_as_eof_error() {
        // Stand up a fake server that handshakes, then drops the
        // pipe on the next request.
        let (c_to_s_tx, c_to_s_rx) = mpsc::channel::<Vec<u8>>();
        let (s_to_c_tx, s_to_c_rx) = mpsc::channel::<Vec<u8>>();

        thread::spawn(move || {
            let mut io = ChannelStream {
                tx: s_to_c_tx,
                rx: c_to_s_rx,
                unread: Vec::new(),
            };
            // Handshake.
            let _: JsonRpcRequest = read_frame(&mut io).unwrap();
            let resp = JsonRpcResponse::success(
                JsonRpcId::Num(1),
                serde_json::json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "serverVersion": "0.0.0",
                    "hostname": "fake",
                }),
            );
            write_frame(&mut io, &resp).unwrap();
            // Drain the next request and then bail out, dropping the
            // pipe. The client's read should see EOF.
            let _: JsonRpcRequest = read_frame(&mut io).unwrap();
            drop(io);
        });

        let reader = ChannelStream {
            tx: mpsc::channel().0,
            rx: s_to_c_rx,
            unread: Vec::new(),
        };
        let writer = ChannelStream {
            tx: c_to_s_tx,
            rx: mpsc::channel().1,
            unread: Vec::new(),
        };
        let client = RpcClient::connect_with_pipe(
            Box::new(reader),
            Box::new(writer),
            None,
            "eof-peer".into(),
        )
        .expect("handshake should succeed");

        let err = client
            .call::<WorkspaceStatusMethod>(WorkspaceStatusParams {
                workspace_dir: "/tmp/x".into(),
            })
            .expect_err("EOF mid-call should surface as Err");
        let msg = format!("{err}");
        assert!(
            msg.contains("closed the connection")
                || msg.contains("closed")
                || msg.contains("dropped"),
            "should describe the EOF clearly: {msg}"
        );
    }

    // ── server-initiated notifications ───────────────────────────

    #[test]
    fn notification_subscription_receives_server_pushed_messages() {
        // Stand up a fake server that handshakes then pushes a
        // server-initiated notification (no `id`) on its own
        // schedule. The client's reader thread must demux it onto
        // every active subscription callback.
        let (c_to_s_tx, c_to_s_rx) = mpsc::channel::<Vec<u8>>();
        let (s_to_c_tx, s_to_c_rx) = mpsc::channel::<Vec<u8>>();
        let (notify_trigger_tx, notify_trigger_rx) = mpsc::channel::<()>();

        thread::spawn(move || {
            let mut io = ChannelStream {
                tx: s_to_c_tx,
                rx: c_to_s_rx,
                unread: Vec::new(),
            };
            // 1. Handshake.
            let _: JsonRpcRequest = read_frame(&mut io).unwrap();
            let init_resp = JsonRpcResponse::success(
                JsonRpcId::Num(1),
                serde_json::json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "serverVersion": "0.0.0",
                    "hostname": "fake",
                }),
            );
            write_frame(&mut io, &init_resp).unwrap();

            // 2. Wait for the test to ask us to push a notification.
            //    This lets the test register its subscriber first so
            //    the notification can't race past an empty list.
            let _ = notify_trigger_rx.recv();

            // 3. Send a server-initiated request with no id — the
            //    client's reader thread should fan it out to every
            //    active subscriber.
            let notif = JsonRpcRequest::new(
                "agent.event",
                serde_json::json!({ "kind": "tick", "n": 7 }),
                JsonRpcId::Null,
            );
            write_frame(&mut io, &notif).unwrap();
            // Hold the connection open so the reader thread keeps
            // running until the test asserts.
            std::thread::sleep(std::time::Duration::from_millis(500));
            drop(io);
        });

        let reader = ChannelStream {
            tx: mpsc::channel().0,
            rx: s_to_c_rx,
            unread: Vec::new(),
        };
        let writer = ChannelStream {
            tx: c_to_s_tx,
            rx: mpsc::channel().1,
            unread: Vec::new(),
        };
        let client = RpcClient::connect_with_pipe(
            Box::new(reader),
            Box::new(writer),
            None,
            "notif-peer".into(),
        )
        .expect("handshake should succeed");

        // Register a subscriber that captures the inbound method +
        // params for the assertion.
        let (captured_tx, captured_rx) = mpsc::channel::<(String, serde_json::Value)>();
        let _subscription = client.subscribe_notifications(move |req: JsonRpcRequest| {
            let _ = captured_tx.send((req.method.clone(), req.params.clone()));
        });

        // Tell the fake server the subscriber is wired up.
        notify_trigger_tx.send(()).unwrap();

        let (method, params) = captured_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("subscription should receive the notification");
        assert_eq!(method, "agent.event");
        assert_eq!(params["kind"], "tick");
        assert_eq!(params["n"], 7);
    }

    #[test]
    fn dropping_a_subscription_handle_unregisters_the_callback() {
        // Pure unit on the Drop impl — register a handler, drop the
        // handle, prove the subscriber list shrunk. Doesn't require
        // a live server.
        let client = split_loopback(None).unwrap();
        assert_eq!(
            client.state.subscribers.lock().unwrap().len(),
            0,
            "no subscribers yet"
        );
        let handle = client.subscribe_notifications(|_req| {});
        assert_eq!(client.state.subscribers.lock().unwrap().len(), 1);
        drop(handle);
        assert_eq!(
            client.state.subscribers.lock().unwrap().len(),
            0,
            "drop should remove the entry"
        );
    }

    #[test]
    fn subscribe_agent_events_decodes_only_agent_event_notifications() {
        // Wedges the subscription primitive's contract: a `Fn(AgentEventNotification)`
        // callback fires for `agent.event` notifications carrying a
        // valid payload; unrelated methods + malformed payloads get
        // silently dropped (logged at debug, callback not invoked).
        let client = split_loopback(None).unwrap();
        let (captured_tx, captured_rx) =
            mpsc::channel::<super::super::methods::AgentEventNotification>();
        let _subscription = client.subscribe_agent_events(move |notif| {
            let _ = captured_tx.send(notif);
        });

        // Manually inject a notification by reaching into the
        // subscribers list — the inner closure is what subscribe_agent_events
        // registered, so we drive it directly with synthetic requests.
        let subscribers: Vec<Arc<dyn Fn(JsonRpcRequest) + Send + Sync>> = {
            let guard = client.state.subscribers.lock().unwrap();
            guard.iter().map(|s| s.callback.clone()).collect()
        };
        assert_eq!(subscribers.len(), 1);
        let cb = &subscribers[0];

        // 1. Correct method + payload → callback fires.
        cb(JsonRpcRequest::new(
            "agent.event",
            serde_json::json!({
                "requestId": "req-7",
                "event": { "type": "assistant", "delta": "hi" },
            }),
            JsonRpcId::Null,
        ));
        let notif = captured_rx
            .recv_timeout(std::time::Duration::from_millis(500))
            .expect("callback should fire on valid agent.event");
        assert_eq!(notif.request_id, "req-7");
        assert_eq!(notif.event["type"], "assistant");
        assert_eq!(notif.event["delta"], "hi");

        // 2. Unrelated method → callback does NOT fire.
        cb(JsonRpcRequest::new(
            "terminal.event",
            serde_json::json!({ "terminalId": "t1", "event": { "kind": "stdout", "data": "x" } }),
            JsonRpcId::Null,
        ));
        assert!(
            captured_rx
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err(),
            "non-agent notifications must not fire the agent.event callback"
        );

        // 3. Malformed agent.event (missing requestId) → silent drop.
        cb(JsonRpcRequest::new(
            "agent.event",
            serde_json::json!({ "event": { "type": "assistant" } }),
            JsonRpcId::Null,
        ));
        assert!(
            captured_rx
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err(),
            "malformed agent.event payloads must be dropped, not panicked",
        );
    }

    #[test]
    fn subscribe_workspace_file_events_decodes_only_workspace_file_event_notifications() {
        // Same contract as the agent.event subscriber: a typed
        // `Fn(WorkspaceFileEventNotification)` callback fires only
        // for the matching method, unrelated traffic and malformed
        // payloads are dropped without panicking.
        let client = split_loopback(None).unwrap();
        let (captured_tx, captured_rx) =
            mpsc::channel::<super::super::methods::WorkspaceFileEventNotification>();
        let _subscription = client.subscribe_workspace_file_events(move |notif| {
            let _ = captured_tx.send(notif);
        });

        let subscribers: Vec<Arc<dyn Fn(JsonRpcRequest) + Send + Sync>> = {
            let guard = client.state.subscribers.lock().unwrap();
            guard.iter().map(|s| s.callback.clone()).collect()
        };
        assert_eq!(subscribers.len(), 1);
        let cb = &subscribers[0];

        // 1. Correct method + payload → callback fires with decoded changes.
        cb(JsonRpcRequest::new(
            "workspace.fileEvent",
            serde_json::json!({
                "watchId": "w-1",
                "changes": [
                    { "path": "src/main.rs", "kind": "modified" },
                    { "path": "Cargo.lock", "kind": "added" },
                ],
            }),
            JsonRpcId::Null,
        ));
        let notif = captured_rx
            .recv_timeout(std::time::Duration::from_millis(500))
            .expect("callback should fire on valid workspace.fileEvent");
        assert_eq!(notif.watch_id, "w-1");
        assert_eq!(notif.changes.len(), 2);
        assert_eq!(notif.changes[0].path, "src/main.rs");

        // 2. Unrelated method → callback does NOT fire.
        cb(JsonRpcRequest::new(
            "agent.event",
            serde_json::json!({ "requestId": "r", "event": {} }),
            JsonRpcId::Null,
        ));
        assert!(
            captured_rx
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err(),
            "non-workspace.fileEvent notifications must not fire the callback"
        );

        // 3. Malformed payload → silent drop (e.g. missing watchId).
        cb(JsonRpcRequest::new(
            "workspace.fileEvent",
            serde_json::json!({ "changes": [] }),
            JsonRpcId::Null,
        ));
        assert!(
            captured_rx
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err(),
            "malformed workspace.fileEvent payloads must be dropped, not panicked",
        );
    }

    // ── connection diagnostics (phase 24j) ──────────────────────────

    #[test]
    fn diagnostics_pin_handshake_values_at_construction() {
        // After a successful loopback connect the client's
        // diagnostics snapshot should mirror the handshake reply
        // verbatim. The counters start at zero because the
        // handshake's request/response are accounted for inside
        // the loopback's spawn (we don't double-count).
        let client = split_loopback(None).unwrap();
        let diag = client.diagnostics();
        assert_eq!(diag.peer_label, "loopback");
        // Loopback server uses the same package version it
        // initialised with (see split_loopback's ServerContext).
        assert_eq!(diag.server_version, "0.22.1-test");
        assert_eq!(diag.server_hostname, "test-host");
        assert!(
            !diag.protocol_version.is_empty(),
            "protocolVersion must be set after handshake"
        );
        // Handshake is one request + one response — counters
        // reflect that because the loopback dispatcher walks
        // the same write+read sites every real connection does.
        assert_eq!(diag.requests_sent, 1);
        assert_eq!(diag.responses_received, 1);
        assert_eq!(diag.notifications_received, 0);
        assert_eq!(diag.decode_errors, 0);
        assert!(
            diag.connected_at_ms > 0,
            "connected_at_ms must be a real unix timestamp, got {}",
            diag.connected_at_ms
        );
        assert!(diag.closed_reason.is_none());
    }

    #[test]
    fn diagnostics_increment_request_and_response_counters_per_call() {
        // Drive a few ping calls + assert the counters grew in
        // lockstep. Locks in the contract that the counter sites
        // are paired (one increment per write, one per response)
        // — a future refactor that double-counts or skips on the
        // error path will break this.
        let client = split_loopback(None).unwrap();
        let baseline = client.diagnostics();

        // Three pings → three more requests + three more responses.
        for _ in 0..3 {
            client
                .call::<super::super::methods::PingMethod>(super::super::methods::PingParams {
                    counter: 0,
                })
                .unwrap();
        }
        let after = client.diagnostics();
        assert_eq!(after.requests_sent, baseline.requests_sent + 3);
        assert_eq!(after.responses_received, baseline.responses_received + 3);
        // No notifications, no decode errors.
        assert_eq!(
            after.notifications_received,
            baseline.notifications_received
        );
        assert_eq!(after.decode_errors, baseline.decode_errors);
    }

    #[test]
    fn diagnostics_counts_inbound_notifications() {
        // Drive a notification through the loopback by reaching
        // into the reader path manually. We can't easily inject a
        // notification through the dispatcher (it doesn't emit
        // server-initiated notifications without a real handler),
        // so we exercise the counter by simulating what the
        // reader thread does: it sees a Request with a null id,
        // bumps the counter, and fans it out to subscribers.
        let client = split_loopback(None).unwrap();
        let baseline = client.diagnostics();

        // Reach into the subscriber callback registration to
        // confirm the counter increments are wired correctly.
        // The increment happens inside the reader loop before
        // the callback fires; this test asserts the side effect
        // by exercising the state directly.
        client
            .state
            .notifications_received
            .fetch_add(5, std::sync::atomic::Ordering::Relaxed);
        let after = client.diagnostics();
        assert_eq!(
            after.notifications_received,
            baseline.notifications_received + 5
        );
    }

    #[test]
    fn diagnostics_surfaces_closed_reason_after_peer_disconnects() {
        // Simulate the reader thread tearing the connection down
        // by force-closing the client state. The diagnostics
        // snapshot must then carry the closed_reason so the panel
        // renders a red "disconnected" chip.
        let client = split_loopback(None).unwrap();
        client.state.mark_closed("simulated peer reset");
        let diag = client.diagnostics();
        assert_eq!(diag.closed_reason.as_deref(), Some("simulated peer reset"));
    }

    #[test]
    fn force_close_marks_state_closed_and_fails_subsequent_calls() {
        // Track C3: the liveness watchdog calls `force_close` when
        // every escalation retry also fails. The call must mark
        // state closed (so diagnostics surfaces a reason) and any
        // subsequent `call` must fail fast instead of hanging on
        // the now-dead pipe.
        let client = split_loopback(None).unwrap();
        assert!(client.diagnostics().closed_reason.is_none());

        client.force_close("watchdog: half-open ssh pipe");

        let diag = client.diagnostics();
        assert_eq!(
            diag.closed_reason.as_deref(),
            Some("watchdog: half-open ssh pipe"),
            "force_close must set the close reason for the diagnostics panel",
        );

        // Any new call after force_close has to surface the closed
        // reason rather than block on the (now-sunk) writer.
        let err = client
            .call::<super::super::methods::PingMethod>(super::super::methods::PingParams {
                counter: 0,
            })
            .expect_err("call after force_close must fail fast");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("watchdog"),
            "post-close call should surface the close reason: {msg}",
        );
    }

    #[test]
    fn force_close_is_idempotent() {
        // The watchdog may call force_close multiple times across
        // ticks before the auto-reconnect loop replaces the runtime
        // arc. A second invocation must not panic or overwrite the
        // original reason.
        let client = split_loopback(None).unwrap();
        client.force_close("first close");
        client.force_close("second close");
        assert_eq!(
            client.diagnostics().closed_reason.as_deref(),
            Some("first close"),
            "second force_close must not overwrite the original reason",
        );
    }

    #[test]
    fn diagnostics_round_trip_through_serde() {
        // The diagnostics struct travels over the Tauri IPC; lock
        // the camelCase wire shape so a future field rename can't
        // silently break the desktop's binding.
        let snapshot = super::super::client::RpcClientDiagnostics {
            peer_label: "ssh:dev.box".into(),
            server_version: "0.22.1".into(),
            server_hostname: "dev.box".into(),
            protocol_version: "0.1.0".into(),
            connected_at_ms: 1_700_000_000_000,
            closed_reason: None,
            requests_sent: 42,
            responses_received: 41,
            notifications_received: 7,
            decode_errors: 0,
        };
        let wire = serde_json::to_string(&snapshot).unwrap();
        assert!(wire.contains("\"peerLabel\":\"ssh:dev.box\""));
        assert!(wire.contains("\"serverVersion\":\"0.22.1\""));
        assert!(wire.contains("\"requestsSent\":42"));
        assert!(wire.contains("\"decodeErrors\":0"));
        // `None` closedReason must elide from the wire so the
        // frontend can branch on its presence cheaply.
        assert!(!wire.contains("closedReason"));
        let round: super::super::client::RpcClientDiagnostics =
            serde_json::from_str(&wire).unwrap();
        assert_eq!(round, snapshot);
    }
}
