//! Long-running daemon mode for `helmor-server`.
//!
//! The single-shot `--serve-stdio` mode (the binary's original
//! behavior) ties terminal lifetime to the SSH connection: the
//! moment `ssh host helmor-server` exits, every PTY dies with it.
//! That's incompatible with phase 19's reattach story.
//!
//! Daemon mode fixes that by:
//!
//! 1. `--daemon` — fork + setsid, bind a Unix socket at
//!    `$HOME/.helmor/server/sock`, redirect stdio to a log file,
//!    accept connections in a loop. Outlives any individual SSH
//!    session.
//! 2. `--ensure-daemon` — fast probe; if the socket isn't alive,
//!    fork a fresh daemon. Idempotent.
//! 3. `--proxy` — connect to the socket and bridge stdio↔socket
//!    so the desktop's existing framed JSON-RPC client can keep
//!    pretending it's talking to a one-shot binary. The actual
//!    work runs in the daemon.
//!
//! The desktop's connect command becomes
//! `ssh host sh -c '<bin> --ensure-daemon && exec <bin> --proxy'`.
//!
//! ## What's not in 19b
//!
//! - No auth on the socket. UNIX file perms (0600, the per-user
//!   home dir is already 700) gate it. Multi-user remotes get
//!   isolation through `$HOME` being per-user; cross-user attacks
//!   require root on the box, at which point there are bigger
//!   problems.
//! - No graceful shutdown. The daemon dies when the kernel kills
//!   it (SIGTERM/SIGHUP) and PTYs die with it. Phase 19c will
//!   persist the daemon's session list so a fresh daemon could
//!   in principle pick up where the old one left off, but
//!   re-spawning the actual shell processes isn't on the spike
//!   roadmap.

use std::io::{ErrorKind, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use super::codec::{read_frame, write_frame, FrameError};
use super::protocol::{JsonRpcRequest, JsonRpcResponse};
use super::server::{dispatch_request, ServerContext, StdoutNotifier};
use super::terminal::RemoteTerminalState;

/// Default socket directory. Per-user under `$HOME` — the standard
/// `XDG_RUNTIME_DIR` location is tmpfs-backed and goes away on
/// logout, which is exactly when we want the daemon (and its
/// terminals) to survive.
const DEFAULT_DAEMON_DIR: &str = ".helmor/server";
const SOCKET_FILE: &str = "sock";
const PID_FILE: &str = "daemon.pid";
const LOG_FILE: &str = "daemon.log";

/// How long `ensure_daemon` waits after forking before giving up
/// on the new daemon binding its socket. 3 seconds is comfortably
/// past the warm-spawn time (~100ms locally, ~500ms over SSH cold);
/// the failure surface is "we forked but the socket never showed
/// up", which is rare enough that a longer wait isn't valuable.
const ENSURE_DAEMON_TIMEOUT: Duration = Duration::from_secs(3);

/// Resolve the daemon directory: `$HOME/.helmor/server/`. Created on
/// demand. `$HOME` is the only env we look at — the SSH session
/// always has it set for the logged-in user.
pub fn default_daemon_dir() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME env var is not set")?;
    Ok(PathBuf::from(home).join(DEFAULT_DAEMON_DIR))
}

pub fn default_socket_path() -> Result<PathBuf> {
    Ok(default_daemon_dir()?.join(SOCKET_FILE))
}

pub fn default_pid_path() -> Result<PathBuf> {
    Ok(default_daemon_dir()?.join(PID_FILE))
}

pub fn default_log_path() -> Result<PathBuf> {
    Ok(default_daemon_dir()?.join(LOG_FILE))
}

/// `--ensure-daemon` mode entry point. Returns `Ok(())` once a
/// reachable daemon is listening on the socket (either the existing
/// one or a freshly-forked one). Errors are limited to filesystem
/// failures (can't create the dir, can't write the PID file); a
/// dead-but-stale socket file is reaped silently.
pub fn ensure_daemon(binary_path: &Path) -> Result<()> {
    let dir = default_daemon_dir()?;
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create daemon dir {}", dir.display()))?;

    let socket = default_socket_path()?;
    if probe_socket(&socket) {
        tracing::info!(
            socket = %socket.display(),
            "helmor-server: existing daemon is alive"
        );
        return Ok(());
    }

    // The socket file might exist but be dead (previous daemon
    // crashed without cleanup). Unlink it before forking so the
    // fresh daemon can re-bind.
    if socket.exists() {
        let _ = std::fs::remove_file(&socket);
    }

    fork_daemon(binary_path)?;

    // Wait briefly for the new daemon to bind. ssh-pass it the
    // success signal by polling the socket; the daemon's first
    // action after binding is to be accept-ready.
    let deadline = Instant::now() + ENSURE_DAEMON_TIMEOUT;
    while Instant::now() < deadline {
        if probe_socket(&socket) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    bail!(
        "daemon did not become reachable at {} within {ENSURE_DAEMON_TIMEOUT:?}",
        socket.display()
    );
}

/// Cheap "is anyone listening?" probe — open + close. Doesn't
/// speak the protocol; relies on the daemon's accept loop being
/// the only thing that should be binding this path.
fn probe_socket(socket: &Path) -> bool {
    match UnixStream::connect(socket) {
        Ok(stream) => {
            // Close immediately; the accept loop will discard the
            // connection on EOF without billing us a real session.
            drop(stream);
            true
        }
        Err(_) => false,
    }
}

/// Fork the daemon, return in the *parent* once the fork happened.
/// The child execs into `<binary> --daemon`. The fork is double so
/// the daemon isn't a session leader (matches the textbook
/// daemonize pattern).
fn fork_daemon(binary_path: &Path) -> Result<()> {
    use std::process::Stdio;
    // We can't `daemonize` in-process here because the current
    // process might be in the middle of `--ensure-daemon`, which
    // expects to return normally to the caller. So we exec a fresh
    // `<binary> --daemon` and the *new* process does the double-
    // fork.
    let child = std::process::Command::new(binary_path)
        .arg("--daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("fork daemon via {}", binary_path.display()))?;
    tracing::info!(pid = child.id(), "helmor-server: forked daemon");
    // The child detaches in `run_daemon` via setsid + double-fork.
    // We deliberately *don't* wait() — we don't want to block on
    // it. Letting the child become an orphan / be reaped by init
    // is fine for daemon spawning.
    std::mem::forget(child);
    Ok(())
}

/// `--daemon` mode entry point. Double-forks, binds the socket,
/// and accepts connections in a loop. Each accepted connection
/// gets its own thread + `ServerContext`, with the
/// [`RemoteTerminalState`] shared across them so PTYs live in the
/// daemon process rather than the per-connection scope.
pub fn run_daemon() -> Result<()> {
    // Daemonize: setsid + second fork. After this point the
    // process has no controlling terminal and isn't a session
    // leader, so a SIGHUP from a closing SSH connection won't
    // kill us.
    daemonize()?;

    // Now we're the long-lived daemon. Set up file paths +
    // redirect stdio to the log file.
    let dir = default_daemon_dir()?;
    std::fs::create_dir_all(&dir)?;

    let log_path = default_log_path()?;
    redirect_stdio_to_log(&log_path)?;
    init_daemon_logging();

    let pid_path = default_pid_path()?;
    if let Err(err) = write_pid_file(&pid_path) {
        tracing::warn!(error = %err, "daemon: failed to write pid file (continuing)");
    }

    // Track E4: stamp this startup into the crash-history file so the
    // `runtime.metrics` RPC can surface "daemon crashed N times in
    // 5 min" warnings on the desktop. Best-effort — a write failure
    // logs but doesn't block startup.
    super::server::crash_history::record_startup();

    let socket_path = default_socket_path()?;
    if socket_path.exists() {
        let _ = std::fs::remove_file(&socket_path);
    }
    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("bind unix socket at {}", socket_path.display()))?;
    apply_socket_perms(&socket_path)?;
    tracing::info!(
        socket = %socket_path.display(),
        pid = std::process::id(),
        "helmor-server: daemon listening"
    );

    // One terminal state shared across every accepted connection.
    // Cloning the Arc into each per-connection thread means the
    // PTYs outlive whichever connection happened to open them.
    let terminal_state: Arc<RemoteTerminalState> = Arc::new(RemoteTerminalState::new());
    // Phase 23b: ditto for the agent bridge — daemon-global so the
    // sidecar process + its active sessions outlive any single
    // client reconnect (phase 19a's reattach story applies here
    // too; 23d builds the agent-side equivalent).
    let agent_state: Arc<super::agent::RemoteAgentState> = Arc::new(build_agent_state());
    let server_version = env!("CARGO_PKG_VERSION").to_string();
    let hostname = super::host::read_hostname();

    accept_loop(
        listener,
        terminal_state,
        agent_state,
        server_version,
        hostname,
    );
    Ok(())
}

fn build_agent_state() -> super::agent::RemoteAgentState {
    // Same resolution + disabled fallback the stdio binary uses.
    // Kept inline so the daemon entry stays self-contained.
    match super::agent::BinaryAgentSpawner::resolve_from_env() {
        Some(path) => {
            tracing::info!(
                sidecar = %path.display(),
                "daemon: agent bridge configured"
            );
            super::agent::RemoteAgentState::new(Arc::new(super::agent::BinaryAgentSpawner::new(
                path,
            )))
        }
        None => {
            tracing::info!(
                "daemon: HELMOR_SIDECAR_PATH not set; agent.* surfaces will report disabled"
            );
            super::agent::RemoteAgentState::disabled(
                "HELMOR_SIDECAR_PATH must be set (and point to a readable file) on the remote",
            )
        }
    }
}

fn accept_loop(
    listener: UnixListener,
    terminal_state: Arc<RemoteTerminalState>,
    agent_state: Arc<super::agent::RemoteAgentState>,
    server_version: String,
    hostname: String,
) {
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let term_state = Arc::clone(&terminal_state);
                let agent_state = Arc::clone(&agent_state);
                let server_version = server_version.clone();
                let hostname = hostname.clone();
                std::thread::Builder::new()
                    .name("helmor-server-conn".into())
                    .spawn(move || {
                        if let Err(err) = handle_connection(
                            stream,
                            term_state,
                            agent_state,
                            server_version,
                            hostname,
                        ) {
                            tracing::warn!(
                                error = %format!("{err:#}"),
                                "daemon: per-connection handler exited with error"
                            );
                        }
                    })
                    .ok();
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "daemon: accept() failed; pausing 100ms"
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn handle_connection(
    stream: UnixStream,
    terminal_state: Arc<RemoteTerminalState>,
    agent_state: Arc<super::agent::RemoteAgentState>,
    server_version: String,
    hostname: String,
) -> Result<()> {
    let reader_stream = stream.try_clone().context("clone unix stream for reader")?;
    let writer_stream = stream;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(writer_stream)));
    let notifier = Arc::new(StdoutNotifier::new(Arc::clone(&writer)));

    // Build the per-connection context. Crucially, we override the
    // default `terminal_state` + `agent_state` so this thread shares
    // the daemon-global state — that's what makes terminals + agent
    // sessions survive any one client.
    let mut ctx = ServerContext::new(server_version, hostname);
    ctx.set_notifier(notifier);
    ctx.set_terminal_state(terminal_state);
    ctx.set_agent_state(agent_state);

    let mut reader = std::io::BufReader::new(reader_stream);
    loop {
        let req: JsonRpcRequest = match read_frame(&mut reader) {
            Ok(req) => req,
            Err(FrameError::Eof) => {
                tracing::debug!("daemon: client closed connection");
                return Ok(());
            }
            Err(err) => {
                tracing::warn!(error = %err, "daemon: frame read failed");
                return Ok(());
            }
        };
        if let Some(response) = dispatch_request(&ctx, req) {
            if let Err(err) = write_response(&writer, &response) {
                tracing::warn!(error = %err, "daemon: write failed");
                return Ok(());
            }
        }
    }
}

fn write_response(
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    response: &JsonRpcResponse,
) -> Result<(), FrameError> {
    let mut handle = writer.lock().expect("response writer mutex poisoned");
    write_frame(&mut *handle, response)?;
    handle.flush()?;
    Ok(())
}

/// `--proxy` mode entry point. Connects to the daemon's socket and
/// bridges stdio to it, so the desktop's `RpcClient` can still
/// talk to its peer over plain stdin/stdout.
///
/// Two-thread bridge: stdin→socket and socket→stdout. Each write
/// is explicitly flushed so the desktop's framed read sees bytes
/// as soon as the daemon emits them — `std::io::copy` doesn't
/// flush after each write and on a buffered stdout that means the
/// initialize handshake response can sit in the proxy's stdout
/// buffer forever, deadlocking the client.
pub fn run_proxy() -> Result<()> {
    use std::io::Read;
    let socket = default_socket_path()?;
    let stream = UnixStream::connect(&socket)
        .with_context(|| format!("connect to daemon socket at {}", socket.display()))?;
    let reader_stream = stream.try_clone().context("clone unix stream for reader")?;

    let stdin_to_socket = std::thread::Builder::new()
        .name("helmor-proxy-stdin".into())
        .spawn(move || -> std::io::Result<()> {
            let mut stdin = std::io::stdin().lock();
            let mut socket = stream;
            let mut buf = [0u8; 8192];
            loop {
                let n = stdin.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                socket.write_all(&buf[..n])?;
                socket.flush()?;
            }
            Ok(())
        })
        .context("spawn stdin→socket thread")?;
    let socket_to_stdout = std::thread::Builder::new()
        .name("helmor-proxy-stdout".into())
        .spawn(move || -> std::io::Result<()> {
            let mut socket = reader_stream;
            let mut stdout = std::io::stdout().lock();
            let mut buf = [0u8; 8192];
            loop {
                let n = socket.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                stdout.write_all(&buf[..n])?;
                // Critical: framed JSON-RPC sits dormant in stdout
                // buffer until \n hits a LineWriter boundary; the
                // headers carry \r\n but the response body is a
                // single JSON line with no internal newlines, so
                // without an explicit flush per chunk the client's
                // read deadlocks waiting for bytes already-written.
                stdout.flush()?;
            }
            Ok(())
        })
        .context("spawn socket→stdout thread")?;

    // Either direction completing is enough — once the desktop or
    // the daemon closes its half, we tear down.
    let _ = stdin_to_socket.join();
    let _ = socket_to_stdout.join();
    Ok(())
}

/// Standard double-fork daemonize. After this returns, the calling
/// process is the daemon: detached from the controlling tty, not a
/// session leader, parent already exited.
fn daemonize() -> Result<()> {
    // First fork. The parent exits so the shell returns control;
    // the child becomes the orphaned process that will be reparented
    // to init.
    match unsafe { libc::fork() } {
        -1 => bail!("first fork failed: {}", std::io::Error::last_os_error()),
        0 => {
            // Child — continue.
        }
        _ => {
            // Parent — exit immediately. Don't run Drop; the kernel
            // tears the process down.
            std::process::exit(0);
        }
    }

    // Become a new session leader so we're decoupled from the
    // controlling terminal.
    if unsafe { libc::setsid() } == -1 {
        bail!("setsid failed: {}", std::io::Error::last_os_error());
    }

    // Second fork to ensure we *aren't* a session leader (so we
    // can't accidentally acquire a controlling terminal later by
    // opening a tty).
    match unsafe { libc::fork() } {
        -1 => bail!("second fork failed: {}", std::io::Error::last_os_error()),
        0 => {
            // Daemon — continue.
        }
        _ => {
            std::process::exit(0);
        }
    }

    Ok(())
}

/// Open the log file in append mode and dup it over fd 1 + 2 so any
/// stray println / panic message lands there instead of vanishing.
/// stdin is redirected to /dev/null.
fn redirect_stdio_to_log(log_path: &Path) -> Result<()> {
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .with_context(|| format!("open daemon log at {}", log_path.display()))?;
    let log_fd = log.as_raw_fd();

    // Open /dev/null for stdin.
    let devnull = std::fs::OpenOptions::new()
        .read(true)
        .open("/dev/null")
        .context("open /dev/null")?;
    let devnull_fd = devnull.as_raw_fd();

    unsafe {
        if libc::dup2(devnull_fd, libc::STDIN_FILENO) < 0 {
            bail!("dup2 stdin: {}", std::io::Error::last_os_error());
        }
        if libc::dup2(log_fd, libc::STDOUT_FILENO) < 0 {
            bail!("dup2 stdout: {}", std::io::Error::last_os_error());
        }
        if libc::dup2(log_fd, libc::STDERR_FILENO) < 0 {
            bail!("dup2 stderr: {}", std::io::Error::last_os_error());
        }
    }
    // The original `log` + `devnull` File handles are still alive at
    // this point and would close the fds when dropped. Forget them
    // so the dup2'd fds keep working.
    std::mem::forget(log);
    std::mem::forget(devnull);
    Ok(())
}

fn init_daemon_logging() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_env("HELMOR_SERVER_LOG").unwrap_or_else(|_| "info".into());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .try_init();
}

fn write_pid_file(path: &Path) -> std::io::Result<()> {
    std::fs::write(path, std::process::id().to_string())
}

/// Tighten the socket to mode 0600. The home dir is already 700
/// per UNIX defaults, but it's cheap insurance against a permissive
/// umask on weird shells.
fn apply_socket_perms(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    std::fs::set_permissions(path, perms)
        .with_context(|| format!("chmod 0600 {}", path.display()))?;
    Ok(())
}

/// Helper used by tests + the integration shim that needs a `File`
/// wrapper around a UnixStream fd without juggling lifetimes.
#[allow(dead_code)]
pub(crate) fn unix_stream_into_file(stream: UnixStream) -> std::fs::File {
    // SAFETY: we're transferring exclusive ownership of the fd from
    // the UnixStream to the File. `into_raw_fd` prevents the
    // UnixStream's Drop from closing it.
    use std::os::fd::IntoRawFd;
    let fd = stream.into_raw_fd();
    unsafe { std::fs::File::from_raw_fd(fd) }
}

/// True iff the error is the "connection refused" / "no such file"
/// you'd get probing a dead or missing socket. Public so tests can
/// assert "the daemon really did go away".
#[allow(dead_code)]
pub fn is_socket_dead_error(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        ErrorKind::NotFound | ErrorKind::ConnectionRefused
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_paths_resolve_under_home() {
        // We can't assert the exact home dir (test runner varies) but
        // we can confirm the suffix path shape.
        let socket = default_socket_path().expect("HOME should be set in tests");
        assert!(
            socket.ends_with(".helmor/server/sock"),
            "socket path should end at .helmor/server/sock: {}",
            socket.display()
        );
        let pid = default_pid_path().unwrap();
        assert!(pid.ends_with(".helmor/server/daemon.pid"));
    }

    #[test]
    fn probe_socket_returns_false_for_missing_path() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nope.sock");
        assert!(!probe_socket(&path));
    }

    #[test]
    fn probe_socket_returns_true_when_a_listener_is_bound() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("live.sock");
        let _listener = UnixListener::bind(&path).unwrap();
        assert!(probe_socket(&path));
    }
}
