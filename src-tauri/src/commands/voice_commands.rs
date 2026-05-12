//! Tauri commands backing the voice-mode agent. The model invokes typed
//! function tools whose handlers shell out to the `helmor` CLI via
//! [`run_helmor_cli`]; the frontend tool-dispatcher receives the result
//! as JSON and forwards it back into the OpenAI Realtime session.
//!
//! Every invocation is synchronous: spawn the child, drain stdout/stderr
//! off-thread, wait for exit (with a wall-clock cap), return the result.
//! An earlier `detach` mode that returned the first stdout line and let
//! the child keep running existed to "speed up" `helmor send` — but it
//! also unconditionally reported `ok: true`, silently swallowing every
//! CLI error (bad workspace ref, wrong argv shape, anything). Since
//! `helmor send` against a running desktop app already completes in
//! <100 ms via the delegation path in `service::send_message`, the
//! speed argument never held up. Sync mode with the existing 30 s cap
//! is more than enough — and it surfaces failures to the agent so it
//! can tell the user the truth instead of a polite lie.

use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use serde::Serialize;

use super::common::{run_blocking, CmdResult};

/// Wraps a CLI invocation result in a stable JSON envelope. Serialized
/// with camelCase to match the rest of Helmor's IPC surface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmorCliResult {
    /// `true` iff the child exited with status 0.
    pub ok: bool,
    /// Exit code if the child has terminated. `None` only when the
    /// wrapper itself failed (spawn / timeout).
    pub exit_code: Option<i32>,
    /// Full stdout.
    pub stdout: String,
    /// Full stderr.
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

/// Wall-clock cap on a single CLI invocation. Most reads finish in
/// <500 ms; writes (e.g. `workspace new`) can take a couple seconds.
/// 30 s is the safety net for an unresponsive CLI.
const CLI_TIMEOUT_SECS: u64 = 30;

#[tauri::command]
pub async fn run_helmor_cli(args: Vec<String>) -> CmdResult<HelmorCliResult> {
    let binary = helmor_binary_name();
    // Voice-mode invocations are rare and high-signal — log every one so
    // we can correlate "the agent said X" with what the CLI actually saw.
    tracing::info!(binary, ?args, "voice agent invoking helmor CLI");
    run_blocking(move || {
        let result = run_sync(binary, args.clone());
        if let Ok(ref res) = result {
            tracing::info!(
                ok = res.ok,
                exit_code = ?res.exit_code,
                stdout_len = res.stdout.len(),
                stderr_len = res.stderr.len(),
                error = ?res.error,
                stdout_preview = %res.stdout.chars().take(240).collect::<String>(),
                stderr_preview = %res.stderr.chars().take(240).collect::<String>(),
                ?args,
                "voice agent helmor CLI completed"
            );
        }
        result
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
