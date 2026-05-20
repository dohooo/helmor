//! `helmor-server` — F1 upstream slice.
//!
//! Headless daemon binary for Helmor's remote-workspace feature
//! (issue #453). This first slice exposes only the protocol +
//! handshake + a couple of read-only methods so the wire shape can
//! be reviewed before larger surfaces (SSH transport, agent bridge,
//! workspace ops, terminals) layer on top in F2-F7.
//!
//! Two modes, picked by the first CLI flag:
//!
//! - `--serve-stdio` (default) — read framed JSON-RPC requests from
//!   stdin, write responses to stdout. Suitable for a local desktop
//!   spawning the binary directly (the local-loopback test path).
//! - `--version` / `-V` — print version + protocol, exit 0. Used by
//!   the auto-install probe a future PR will add.
//!
//! See `docs/remote-server-architecture.md` for the broader design;
//! this binary ships the foundation it builds on.

use std::io::{self, BufReader, Write};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use helmor_lib::remote::{
    self, dispatch_request, read_frame, write_frame, FrameError, JsonRpcRequest, JsonRpcResponse,
    ServerContext,
};

fn main() -> ExitCode {
    let mode = parse_mode();
    match mode {
        Mode::Version => {
            // CLI introspection. A future install-probe will run
            // `<bin> --version` to detect whether a compatible binary
            // is already deployed; this branch answers that probe
            // without booting the RPC loop.
            println!("helmor-server {}", env!("CARGO_PKG_VERSION"));
            println!("protocol {}", remote::PROTOCOL_VERSION);
            ExitCode::SUCCESS
        }
        Mode::ServeStdio => run_serve_stdio(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    ServeStdio,
    Version,
}

fn parse_mode() -> Mode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        return Mode::Version;
    }
    // Default keeps the binary usable in tests + the local-loopback
    // path without an explicit flag.
    Mode::ServeStdio
}

fn run_serve_stdio() -> ExitCode {
    init_stderr_logging();

    let server_version = env!("CARGO_PKG_VERSION").to_string();
    let hostname = read_hostname();
    let ctx = ServerContext::new(server_version, hostname);

    // One stdout writer behind a mutex so response frames can't
    // interleave with anything else we might write in future
    // phases (notifications etc.).
    let stdout_writer: Arc<Mutex<Box<dyn Write + Send>>> =
        Arc::new(Mutex::new(Box::new(io::stdout())));

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        protocol = remote::PROTOCOL_VERSION,
        "helmor-server: ready"
    );

    let stdin = io::stdin().lock();
    let mut reader = BufReader::new(stdin);

    loop {
        let req = match read_frame::<_, JsonRpcRequest>(&mut reader) {
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

        if let Some(response) = dispatch_request(&ctx, req) {
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
    write_frame(&mut *handle, response)
}

fn init_stderr_logging() {
    use tracing_subscriber::EnvFilter;
    // Defaults stay quiet; operators bump via `HELMOR_LOG=debug` so
    // the binary doesn't spam stderr in normal use.
    let filter = EnvFilter::try_from_env("HELMOR_LOG").unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(io::stderr)
        .try_init();
}

fn read_hostname() -> String {
    // `gethostname` would pull in another crate; `uname -n` (libc)
    // would too. The HOST env var covers the common case + the
    // unknown-host fallback keeps the binary usable in test rigs
    // that don't have a hostname set.
    std::env::var("HOST")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown-host".to_string())
}
