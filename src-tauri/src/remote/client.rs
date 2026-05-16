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

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use anyhow::{anyhow, bail, Context, Result};

use super::codec::{read_frame, write_frame, FrameError};
use super::methods::{
    InitializeMethod, InitializeParams, InitializeResult, PingMethod, PingParams, RpcMethod,
    WorkspaceStatusMethod, WorkspaceStatusParams, WorkspaceStatusResult,
};
use super::protocol::{
    error_codes, JsonRpcError, JsonRpcId, JsonRpcRequest, JsonRpcResponse, PROTOCOL_VERSION,
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

/// JSON-RPC client over a single framed pipe. The pipe handles are
/// boxed as trait objects so the same struct fronts an SSH child,
/// a loopback helmor-server, or an in-memory test pipe with no
/// generics leaking out into the trait impl.
pub struct RpcClient {
    inner: Mutex<RpcInner>,
    next_id: AtomicU64,
    /// Cached server-side handshake reply. Read by `RemoteSshRuntime`
    /// when surfacing `runtime_health`; never modified after connect.
    server_info: InitializeResult,
}

impl std::fmt::Debug for RpcClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The I/O handles are trait objects, so we surface what's
        // actually useful for diagnostic logs: the cached handshake
        // info and the next request id.
        f.debug_struct("RpcClient")
            .field("server_info", &self.server_info)
            .field("next_id", &self.next_id.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

struct RpcInner {
    reader: Box<dyn BufRead + Send>,
    writer: Box<dyn Write + Send>,
    /// Held so `Drop` reaps the child when the client goes away.
    /// `None` for test pipes that don't spawn a process.
    child: Option<Child>,
}

impl Drop for RpcInner {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Best-effort: kill + reap. We don't try a graceful close
            // — the protocol has no "bye" message yet, and the server
            // hits clean EOF on its read loop when our stdin drops.
            let _ = child.kill();
            let _ = child.wait();
        }
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

    /// Wire a pre-built pipe pair into a client. The test-only entry
    /// point: callers supply paired in-memory streams that loop back
    /// to a dispatcher thread, so we exercise the framing + handshake
    /// without touching the OS process table.
    pub fn connect_with_pipe(
        reader: Box<dyn BufRead + Send>,
        writer: Box<dyn Write + Send>,
        child: Option<Child>,
        peer_label: String,
    ) -> Result<Self> {
        let mut inner = RpcInner {
            reader,
            writer,
            child,
        };
        // Handshake runs *before* the struct exists so we don't have
        // to juggle a placeholder `server_info`. Uses id=1; the
        // first user-issued call therefore starts at id=2.
        let server_info = run_handshake(&mut inner, &peer_label)?;
        Ok(Self {
            inner: Mutex::new(inner),
            next_id: AtomicU64::new(2),
            server_info,
        })
    }

    /// Issue a typed JSON-RPC request and decode the response into
    /// the method's `Result` type. Errors fall into three buckets:
    ///
    /// - Transport (frame read/write, EOF) → `anyhow` with the
    ///   transport-error message.
    /// - JSON-RPC error response → `anyhow` containing the server's
    ///   message and a human-readable code label so the UI can
    ///   string-match if it has to.
    /// - Deserialise failure on the response body → `anyhow` naming
    ///   the method.
    pub fn call<M: RpcMethod>(&self, params: M::Params) -> Result<M::Result> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req_id = JsonRpcId::Num(id);
        let params_value = serde_json::to_value(&params)
            .with_context(|| format!("failed to serialise params for `{}`", M::NAME))?;
        let request = JsonRpcRequest::new(M::NAME, params_value, req_id.clone());

        let response = {
            let mut inner = self.inner.lock().expect("rpc client mutex poisoned");
            send_then_recv(&mut inner, &request, M::NAME)?
        };

        decode_response::<M>(response, &req_id)
    }

    /// Server's initialize reply, cached at connect-time. Used by
    /// the trait impl to fill `runtime_health` without a round-trip.
    pub fn server_info(&self) -> &InitializeResult {
        &self.server_info
    }
}

fn run_handshake(inner: &mut RpcInner, peer_label: &str) -> Result<InitializeResult> {
    let params = InitializeParams {
        protocol_version: PROTOCOL_VERSION.to_string(),
        client_name: "helmor-desktop".to_string(),
        client_version: Some(env!("CARGO_PKG_VERSION").to_string()),
    };
    let params_value =
        serde_json::to_value(&params).context("failed to serialise initialize params")?;
    let req_id = JsonRpcId::Num(1);
    let request = JsonRpcRequest::new(InitializeMethod::NAME, params_value, req_id.clone());
    let response = send_then_recv(inner, &request, InitializeMethod::NAME)
        .with_context(|| format!("initialize handshake with {peer_label} failed"))?;
    decode_response::<InitializeMethod>(response, &req_id)
        .with_context(|| format!("initialize handshake with {peer_label} failed"))
}

fn send_then_recv(
    inner: &mut RpcInner,
    request: &JsonRpcRequest,
    method_name: &str,
) -> Result<JsonRpcResponse> {
    write_frame(&mut inner.writer, request).map_err(|err| match err {
        FrameError::Io(io) => anyhow!("failed to send `{method_name}` request: {io}"),
        other => anyhow!("failed to send `{method_name}` request: {other}"),
    })?;
    read_frame::<_, JsonRpcResponse>(&mut inner.reader).map_err(|err| match err {
        FrameError::Eof => anyhow!(
            "remote runner closed the connection while waiting for `{method_name}` response"
        ),
        other => anyhow!("failed to read `{method_name}` response: {other}"),
    })
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
            msg.contains("closed the connection") || msg.contains("eof"),
            "should describe the EOF clearly: {msg}"
        );
    }
}
