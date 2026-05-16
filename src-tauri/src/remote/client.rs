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
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};

use anyhow::{anyhow, bail, Context, Result};

use super::codec::{read_frame, write_frame, FrameError};
use super::methods::{
    InitializeMethod, InitializeParams, InitializeResult, PingMethod, PingParams, RpcMethod,
    WorkspaceStatusMethod, WorkspaceStatusParams, WorkspaceStatusResult,
};
use super::protocol::{
    error_codes, JsonRpcError, JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse,
    PROTOCOL_VERSION,
};
use super::runtime::{RemoteRuntime, RuntimeHealth, RuntimeKind};

/// Default arguments passed to `ssh` before the host. `BatchMode=yes`
/// makes the spawn fail fast instead of prompting for a password —
/// the desktop has no terminal attached to the child, so any prompt
/// would hang the call. Operators who want password auth can use
/// `ssh-agent` or a key file; the spike intentionally doesn't grow
/// an interactive-auth code path.
const DEFAULT_SSH_ARGS: &[&str] = &["-o", "BatchMode=yes"];

/// Extra args that enable ssh connection multiplexing. With these,
/// the *first* connect to a host pays the full handshake cost; every
/// subsequent connect (ping, reconnect, future per-method calls)
/// reuses the same TCP + auth channel. `ControlPersist=5m` keeps the
/// master alive across short app restarts so a relaunch doesn't burn
/// a fresh handshake.
///
/// The `ControlPath` template `%C` hashes user/host/port into the
/// socket name so concurrent helmor instances don't trip over each
/// other when connecting to different hosts. The directory is
/// resolved at call time via [`ssh_control_dir`] so tests can scope
/// it to a tempdir.
const SSH_MUX_ARGS: &[&str] = &["-o", "ControlMaster=auto", "-o", "ControlPersist=5m"];

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
}

impl ClientState {
    fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            closed: Mutex::new(None),
            next_sub_id: AtomicU64::new(1),
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

impl RpcClient {
    /// Connect to a `helmor-server` reachable over SSH. Spawns
    /// `ssh -o BatchMode=yes <host> <remote_binary>` and runs the
    /// initialize handshake before returning. `remote_binary` must
    /// already exist on the remote (the spike doesn't auto-install).
    pub fn connect_ssh(host: &str, remote_binary: &str) -> Result<Self> {
        let mut cmd = Command::new("ssh");
        for arg in DEFAULT_SSH_ARGS {
            cmd.arg(arg);
        }
        // Connection multiplexing — see comment on SSH_MUX_ARGS. The
        // ControlPath is computed at call time so a missing data dir
        // (test, container, weird sandbox) degrades to plain ssh
        // instead of dropping mux on the floor.
        if let Some(control_dir) = ssh_control_dir() {
            for arg in SSH_MUX_ARGS {
                cmd.arg(arg);
            }
            cmd.arg("-o")
                .arg(format!("ControlPath={}/%C", control_dir.display()));
        }
        cmd.arg(host).arg(remote_binary);
        Self::connect_command(cmd, format!("ssh://{host}"))
    }

    /// Spawn `cmd` with piped stdio, wrap it as the RPC pipe, and run
    /// the initialize handshake. Used by `connect_ssh` and by tests
    /// that want to spawn `helmor-server` directly without going
    /// through SSH.
    pub fn connect_command(mut cmd: Command, peer_label: String) -> Result<Self> {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Surface the server's stderr to ours so operator-facing
            // tracing isn't silently swallowed. A future slice can
            // capture this into a tracing channel keyed by peer.
            .stderr(Stdio::inherit());
        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn remote runner for {peer_label}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("child {peer_label} provided no stdin pipe"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("child {peer_label} provided no stdout pipe"))?;
        let reader: Box<dyn BufRead + Send> = Box::new(BufReader::new(stdout));
        let writer: Box<dyn Write + Send> = Box::new(stdin);
        Self::connect_with_pipe(reader, writer, Some(child), peer_label)
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
                        state.mark_closed(format!("reader error: {err}"));
                        return;
                    }
                };
                match msg {
                    JsonRpcMessage::Response(resp) => {
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
/// Resolve the directory ssh writes ControlPath sockets into. Returns
/// `None` if the data dir isn't reachable — we'd rather connect
/// without multiplexing than refuse to connect at all. The directory
/// is created lazily on first call; ssh tolerates a missing path until
/// the master needs to bind.
fn ssh_control_dir() -> Option<PathBuf> {
    let data_dir = crate::data_dir::data_dir().ok()?;
    let dir = data_dir.join("ssh-cm");
    // Best-effort mkdir. If creation fails (read-only mount, weird
    // permission setup), let ssh surface its own error when it tries
    // to write the socket.
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

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
        let client = RpcClient::connect_ssh(host, remote_binary)?;
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

    fn ping(&self) -> Result<()> {
        // Real round-trip so a dead pipe surfaces as Err. The server's
        // `ping` handler is cheap (just echoes back the counter + a
        // timestamp), so the registry poller can call this on a short
        // cadence without worry.
        self.client.call::<PingMethod>(PingParams::default())?;
        Ok(())
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
}
