//! Tauri commands backing the voice-mode agent. The model invokes typed
//! function tools whose handlers shell out to the `helmor` CLI via
//! [`run_helmor_cli`]; the frontend tool-dispatcher receives the result
//! as JSON and forwards it back into the OpenAI Realtime session.
//!
//! Two execution modes:
//! - **sync** (default): wait for the child to exit, return the full
//!   stdout/stderr. Used by every read tool and quick writes.
//! - **detach**: spawn the child, read at most one line from stdout (or
//!   give up after [`DETACH_FIRST_LINE_TIMEOUT_SECS`]), return that line
//!   immediately, and keep the child running in the background. Used by
//!   `send_prompt` where the underlying `helmor send` streams agent
//!   output for tens of seconds — we want the voice tool to return as
//!   soon as the workspace/session metadata is on the wire.

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::Serialize;

use super::common::{run_blocking, CmdResult};

/// Wraps a CLI invocation result in a stable JSON envelope. Serialized
/// with camelCase to match the rest of Helmor's IPC surface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmorCliResult {
    /// `true` iff the child exited with status 0 (or detached mode
    /// succeeded in reading the first stdout line).
    pub ok: bool,
    /// Exit code if the child has terminated. `None` for detached mode
    /// while the child is still running.
    pub exit_code: Option<i32>,
    /// In sync mode: full stdout. In detach mode: first line only.
    pub stdout: String,
    /// In sync mode: full stderr. In detach mode: empty (drained in
    /// background).
    pub stderr: String,
    /// Set when the wrapper itself failed (e.g. timeout, spawn error)
    /// rather than the child exiting non-zero.
    pub error: Option<String>,
}

/// Pick the right CLI binary for the build mode. `helmor-dev` reads from
/// `~/helmor-dev/`, `helmor` from `~/helmor/`, so this also routes the
/// agent to the same data dir as the running app.
fn helmor_binary_name() -> &'static str {
    if cfg!(debug_assertions) {
        "helmor-dev"
    } else {
        "helmor"
    }
}

/// Sync-mode wall-clock cap. Most reads finish in <500 ms; writes (e.g.
/// `workspace new`) can take a couple seconds. 30 s is the safety net
/// for an unresponsive CLI.
const CLI_TIMEOUT_SECS: u64 = 30;

/// How long detached mode waits for the first line of stdout before
/// giving up and returning an empty payload. The child keeps running.
const DETACH_FIRST_LINE_TIMEOUT_SECS: u64 = 2;

#[tauri::command]
pub async fn run_helmor_cli(args: Vec<String>, detach: Option<bool>) -> CmdResult<HelmorCliResult> {
    let binary = helmor_binary_name();
    let detach = detach.unwrap_or(false);
    run_blocking(move || {
        if detach {
            run_detached(binary, args)
        } else {
            run_sync(binary, args)
        }
    })
    .await
}

fn run_sync(binary: &str, args: Vec<String>) -> anyhow::Result<HelmorCliResult> {
    // Spawn the child on a worker thread and poll for completion so the
    // outer call respects [`CLI_TIMEOUT_SECS`] without relying on tokio
    // timers. On timeout we leave the child to be reaped by the OS — we
    // don't kill it because the most likely cause of a slow CLI is a
    // genuine long-running operation rather than a hang.
    let mut cmd = Command::new(binary);
    cmd.args(&args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return Ok(HelmorCliResult {
                ok: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(format!("spawn {binary}: {err}")),
            });
        }
    };

    // Drain stdout/stderr off-thread so the kernel pipe buffers can't
    // fill and stall the child.
    let stdout_handle = child.stdout.take().map(|mut s| {
        thread::spawn(move || {
            let mut buf = String::new();
            let _ = s.read_to_string(&mut buf);
            buf
        })
    });
    let stderr_handle = child.stderr.take().map(|mut s| {
        thread::spawn(move || {
            let mut buf = String::new();
            let _ = s.read_to_string(&mut buf);
            buf
        })
    });

    // Poll for exit on a coarse cadence; cheap because most runs finish
    // in well under a second.
    let deadline = std::time::Instant::now() + Duration::from_secs(CLI_TIMEOUT_SECS);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    break None;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(err) => {
                return Ok(HelmorCliResult {
                    ok: false,
                    exit_code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                    error: Some(format!("wait {binary}: {err}")),
                });
            }
        }
    };

    let stdout = stdout_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let stderr = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();

    match status {
        Some(status) => Ok(HelmorCliResult {
            ok: status.success(),
            exit_code: status.code(),
            stdout,
            stderr,
            error: None,
        }),
        None => Ok(HelmorCliResult {
            ok: false,
            exit_code: None,
            stdout,
            stderr,
            error: Some(format!("{binary} timed out after {CLI_TIMEOUT_SECS}s")),
        }),
    }
}

fn run_detached(binary: &str, args: Vec<String>) -> anyhow::Result<HelmorCliResult> {
    let mut cmd = Command::new(binary);
    cmd.args(&args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return Ok(HelmorCliResult {
                ok: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(format!("spawn {binary}: {err}")),
            });
        }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            return Ok(HelmorCliResult {
                ok: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(format!("{binary}: stdout pipe missing")),
            });
        }
    };

    // Hand both reader and child to a detached worker thread so that
    // (a) stdout keeps being drained — otherwise the pipe fills and the
    // child blocks on its next write — and (b) the child lives past
    // this function's return. The channel fast-paths the first line
    // back before the drain loop swallows it.
    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut first_line = String::new();
        let mut sent = false;
        if reader.read_line(&mut first_line).is_ok() && !first_line.is_empty() {
            let _ = tx.send(first_line.trim_end_matches('\n').to_string());
            sent = true;
        }
        if !sent {
            // EOF without any line: wake the waiter with empty so it
            // doesn't sit on the timeout.
            let _ = tx.send(String::new());
        }
        // Drain remaining stdout — discarded, but reading keeps the
        // pipe healthy so the child doesn't block.
        let mut sink = Vec::with_capacity(4096);
        let _ = reader.read_to_end(&mut sink);
        let _ = child.wait();
    });

    let first_line = rx
        .recv_timeout(Duration::from_secs(DETACH_FIRST_LINE_TIMEOUT_SECS))
        .unwrap_or_default();

    Ok(HelmorCliResult {
        ok: true,
        exit_code: None,
        stdout: first_line,
        stderr: String::new(),
        error: None,
    })
}
