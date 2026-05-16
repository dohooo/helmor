//! `helmor-server` — the remote-workspace agent half of Helmor.
//!
//! Reads JSON-RPC requests from stdin (LSP-style framed), dispatches
//! them through [`helmor_lib::remote::dispatch_request`], and writes
//! responses back on stdout. Logs to stderr so the framed protocol
//! on stdout stays clean.
//!
//! Today the binary only answers `initialize` + `ping` so the
//! transport layer can be exercised end-to-end. Subsequent slices
//! add workspace / script / sidecar handlers behind the same
//! dispatcher.

use std::io::{self, BufReader, Write};
use std::process::ExitCode;

use helmor_lib::remote::{
    self, write_frame, FrameError, JsonRpcRequest, JsonRpcResponse, ServerContext,
};

fn main() -> ExitCode {
    // CLI-style introspection. The auto-install path on the desktop
    // side runs `ssh host helmor-server --version` to detect whether
    // a compatible binary is already deployed; this branch answers
    // that probe without booting the RPC loop. Print to stdout (not
    // stderr) so the probing client can capture it cleanly.
    if std::env::args().any(|arg| arg == "--version" || arg == "-V") {
        println!("helmor-server {}", env!("CARGO_PKG_VERSION"));
        println!("protocol {}", helmor_lib::remote::PROTOCOL_VERSION);
        return ExitCode::SUCCESS;
    }

    init_logging();

    let server_version = env!("CARGO_PKG_VERSION").to_string();
    let hostname = read_hostname();
    let ctx = ServerContext::new(server_version, hostname);

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        protocol = remote::PROTOCOL_VERSION,
        "helmor-server: ready"
    );

    let stdin = io::stdin().lock();
    let mut reader = BufReader::new(stdin);
    let stdout = io::stdout();

    loop {
        let req = match remote::read_frame::<_, JsonRpcRequest>(&mut reader) {
            Ok(req) => req,
            Err(FrameError::Eof) => {
                tracing::info!("helmor-server: peer closed cleanly, exiting");
                return ExitCode::SUCCESS;
            }
            Err(err) => {
                // Framing-level error → can't reliably respond, so
                // log and exit. The peer's next connection will
                // start fresh.
                tracing::error!(error = %err, "helmor-server: frame read failed; exiting");
                return ExitCode::FAILURE;
            }
        };

        if let Some(response) = remote::dispatch_request(&ctx, req) {
            if let Err(err) = write_response(&stdout, &response) {
                tracing::error!(error = %err, "helmor-server: write failed; exiting");
                return ExitCode::FAILURE;
            }
        }
    }
}

fn write_response(stdout: &io::Stdout, response: &JsonRpcResponse) -> Result<(), FrameError> {
    let mut handle = stdout.lock();
    write_frame(&mut handle, response)?;
    handle.flush()?;
    Ok(())
}

/// Best-effort hostname read. `uname -n` is the canonical Unix
/// answer; the result is purely informational (carried in
/// `initialize`'s response) so a fallback string is safer than
/// crashing the server.
fn read_hostname() -> String {
    if let Ok(host) = std::env::var("HOSTNAME") {
        if !host.is_empty() {
            return host;
        }
    }
    match std::process::Command::new("uname").arg("-n").output() {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => "unknown".to_string(),
    }
}

/// Logging goes to stderr so it doesn't interleave with the framed
/// JSON on stdout. JSON-formatted so the local app's log viewer can
/// pick it up via the SSH pipe later (the client side captures
/// stderr separately and emits it as a `Notice` to the UI).
fn init_logging() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_env("HELMOR_SERVER_LOG").unwrap_or_else(|_| "info".into());
    // Best-effort init — if a subscriber is already installed by the
    // host process (loopback tests run in-process), don't panic.
    let _ = tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(filter)
        .json()
        .try_init();
}
