//! `helmor-server` — the remote-workspace agent half of Helmor.
//!
//! The binary has four entry points, picked by the first CLI flag:
//!
//! - `--serve-stdio` (default) — original behavior. Reads framed
//!   JSON-RPC requests from stdin, writes responses to stdout. One
//!   binary per SSH session, terminals die when the session ends.
//!   Kept for backward compat + tests.
//! - `--daemon` — double-forks, binds a Unix socket at
//!   `$HOME/.helmor/server/sock`, accepts connections in a loop.
//!   Terminals + agents live in *this* process; clients (proxy
//!   shims) come and go without disturbing them.
//! - `--ensure-daemon` — idempotent "is there a daemon? if not,
//!   fork one" probe. Exits 0 once a daemon is reachable. Cheap
//!   to call from a wrapper script on every connect.
//! - `--proxy` — connects to the daemon socket and bridges its
//!   stdin/stdout to that socket. Lets the desktop's `RpcClient`
//!   keep its "I'm talking over stdio" mental model while the
//!   actual work runs in the daemon.
//! - `--version` / `-V` — prints version + protocol, exits 0.
//!   Used by the auto-install probe.

use std::io::{self, BufReader, Write};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use helmor_lib::remote::{
    self, agent, daemon, host, write_frame, FrameError, JsonRpcRequest, JsonRpcResponse,
    ServerContext, StdoutNotifier,
};

/// Phase 23b: construct the `RemoteAgentState` the daemon will use
/// to bridge `agent.*` RPCs into a `helmor-sidecar` subprocess.
/// Resolves the sidecar binary from `HELMOR_SIDECAR_PATH`; when the
/// env var isn't set, returns a `disabled` state that surfaces a
/// legible reason on every `agent.send` rather than letting the
/// spawn fail with the cryptic `ENOENT`.
fn build_agent_state() -> agent::RemoteAgentState {
    let state = match agent::BinaryAgentSpawner::resolve_from_env() {
        Some(path) => {
            tracing::info!(
                sidecar = %path.display(),
                "helmor-server: agent bridge configured"
            );
            agent::RemoteAgentState::new(Arc::new(agent::BinaryAgentSpawner::new(path)))
        }
        None => {
            tracing::info!(
                "helmor-server: HELMOR_SIDECAR_PATH not set; agent.* surfaces will report disabled"
            );
            agent::RemoteAgentState::disabled(
                "HELMOR_SIDECAR_PATH must be set (and point to a readable file) on the remote",
            )
        }
    };
    // Phase 24t: wire the on-disk journal directory so sessions
    // survive daemon restarts. Best-effort — a missing $HOME (the
    // daemon's running on a host that doesn't surface one) leaves
    // durability disabled instead of refusing to start.
    match helmor_lib::remote::daemon::default_daemon_dir() {
        Ok(dir) => state.with_journal_dir(dir.join(agent::JOURNAL_SUBDIR)),
        Err(err) => {
            tracing::warn!(
                error = %format!("{err:#}"),
                "helmor-server: cannot resolve daemon dir; running without journal persistence",
            );
            state
        }
    }
}

fn main() -> ExitCode {
    let mode = parse_mode();
    match mode {
        Mode::Version => {
            // CLI introspection. The auto-install probe runs
            // `<bin> --version` to detect whether a compatible
            // binary is already deployed; this branch answers
            // that probe without booting the RPC loop. stdout
            // (not stderr) so the probing client can capture it.
            println!("helmor-server {}", env!("CARGO_PKG_VERSION"));
            println!("protocol {}", helmor_lib::remote::PROTOCOL_VERSION);
            ExitCode::SUCCESS
        }
        Mode::ServeStdio => run_serve_stdio(),
        Mode::Daemon => match daemon::run_daemon() {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("helmor-server --daemon failed: {err:#}");
                ExitCode::FAILURE
            }
        },
        Mode::EnsureDaemon => {
            let binary = match std::env::current_exe() {
                Ok(p) => p,
                Err(err) => {
                    eprintln!("helmor-server --ensure-daemon: can't resolve own path: {err}");
                    return ExitCode::FAILURE;
                }
            };
            match daemon::ensure_daemon(&binary) {
                Ok(()) => ExitCode::SUCCESS,
                Err(err) => {
                    eprintln!("helmor-server --ensure-daemon failed: {err:#}");
                    ExitCode::FAILURE
                }
            }
        }
        Mode::Proxy => match daemon::run_proxy() {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("helmor-server --proxy failed: {err:#}");
                ExitCode::FAILURE
            }
        },
    }
}

/// CLI modes. We don't bring in clap for this — three trivial
/// flags + a default is cheaper to hand-parse than wire up clap's
/// derive macros on a per-binary basis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    ServeStdio,
    Daemon,
    EnsureDaemon,
    Proxy,
    Version,
}

fn parse_mode() -> Mode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        return Mode::Version;
    }
    if args.iter().any(|a| a == "--daemon") {
        return Mode::Daemon;
    }
    if args.iter().any(|a| a == "--ensure-daemon") {
        return Mode::EnsureDaemon;
    }
    if args.iter().any(|a| a == "--proxy") {
        return Mode::Proxy;
    }
    // Default — both for backward compat and for tests that spawn
    // the binary directly. The auto-install path in phase 12 runs
    // it with no args expecting `--serve-stdio` behavior.
    Mode::ServeStdio
}

fn run_serve_stdio() -> ExitCode {
    init_stderr_logging();

    let server_version = env!("CARGO_PKG_VERSION").to_string();
    let hostname = host::read_hostname();

    // All writes to stdout — response frames AND notification
    // frames — funnel through one Mutex<Box<dyn Write>> so frames
    // can't interleave. The mutex is shared between the response
    // writer here and the `StdoutNotifier` stashed in the
    // ServerContext.
    let stdout_writer: Arc<Mutex<Box<dyn Write + Send>>> =
        Arc::new(Mutex::new(Box::new(io::stdout())));
    let notifier = Arc::new(StdoutNotifier::new(Arc::clone(&stdout_writer)));
    let mut ctx = ServerContext::new(server_version, hostname);
    ctx.set_notifier(notifier);
    // Phase 23b: wire the agent bridge so `agent.send` is functional
    // when the operator has placed `helmor-sidecar` and set
    // `HELMOR_SIDECAR_PATH`. Absent that, the bridge stays in its
    // disabled state and `agent.send` surfaces a legible "not
    // configured" error rather than the cryptic spawn failure.
    ctx.set_agent_state(Arc::new(build_agent_state()));

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        protocol = remote::PROTOCOL_VERSION,
        "helmor-server: ready"
    );

    let stdin = io::stdin().lock();
    let mut reader = BufReader::new(stdin);

    loop {
        let req = match remote::read_frame::<_, JsonRpcRequest>(&mut reader) {
            Ok(req) => req,
            Err(FrameError::Eof) => {
                tracing::info!("helmor-server: peer closed cleanly, exiting");
                return ExitCode::SUCCESS;
            }
            Err(err) => {
                tracing::error!(error = %err, "helmor-server: frame read failed; exiting");
                return ExitCode::FAILURE;
            }
        };

        if let Some(response) = remote::dispatch_request(&ctx, req) {
            if let Err(err) = write_response(&stdout_writer, &response) {
                tracing::error!(error = %err, "helmor-server: write failed; exiting");
                return ExitCode::FAILURE;
            }
        }
    }
}

fn write_response(
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    response: &JsonRpcResponse,
) -> Result<(), FrameError> {
    let mut handle = writer.lock().expect("stdout mutex poisoned");
    write_frame(&mut *handle, response)?;
    handle.flush()?;
    Ok(())
}

/// Logging for `--serve-stdio` goes to stderr so it doesn't
/// interleave with the framed JSON on stdout. JSON-formatted so
/// the local app's log viewer can pick it up via the SSH pipe
/// later (the client side captures stderr separately and emits
/// it as a `Notice` to the UI). Daemon-mode logging is set up
/// inside the daemon module after stdio's been redirected.
fn init_stderr_logging() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_env("HELMOR_SERVER_LOG").unwrap_or_else(|_| "info".into());
    let _ = tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(filter)
        .json()
        .try_init();
}
