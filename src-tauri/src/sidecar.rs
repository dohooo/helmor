//! Manages the Bun sidecar process for agent SDK communication.
//!
//! The sidecar is a long-running Bun process that wraps the Claude Agent
//! SDK (and optionally Codex SDK). Communication happens via stdin/stdout
//! JSON Lines. Bun is required — there is no Node.js fallback.
//!
//! Events from the sidecar are dispatched to per-request channels so that
//! multiple concurrent streaming requests can coexist without interference.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use uuid::Uuid;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct SidecarRequest {
    pub id: String,
    pub method: String,
    pub params: Value,
}

/// A single event received from the sidecar.
///
/// We preserve the raw JSON `Value` intact so that forwarding to the frontend
/// never loses fields (e.g. `type`) that the streaming parser depends on.
#[derive(Debug, Clone)]
pub struct SidecarEvent {
    pub raw: Value,
}

impl SidecarEvent {
    pub fn id(&self) -> Option<&str> {
        self.raw.get("id")?.as_str()
    }

    pub fn event_type(&self) -> &str {
        self.raw
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    }

    pub fn session_id(&self) -> Option<&str> {
        self.raw.get("session_id")?.as_str()
    }
}

// ---------------------------------------------------------------------------
// Sidecar process (low-level)
// ---------------------------------------------------------------------------

struct SidecarProcess {
    child: Child,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
}

impl SidecarProcess {
    /// Start the sidecar process and wait for the "ready" signal.
    /// Returns the process and a BufReader for stdout (to be consumed by the reader thread).
    fn start() -> Result<(Self, BufReader<std::process::ChildStdout>)> {
        let sidecar_path = resolve_sidecar_path()?;
        tracing::debug!(path = %sidecar_path.display(), "Resolved sidecar path");

        // Development (.ts) → bun run index.ts
        // Production (compiled binary) → execute directly
        let is_dev = sidecar_path.extension().is_some_and(|ext| ext == "ts");

        let mut cmd = if is_dev {
            let mut c = Command::new("bun");
            c.arg("run").arg(&sidecar_path);
            c
        } else {
            Command::new(&sidecar_path)
        };

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        // Put the sidecar in its own process group so SIGTERM/SIGKILL
        // reaches all child processes (Claude CLI, Codex CLI) instead
        // of only hitting the Bun parent.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        // Pass log config to the sidecar process
        if let Ok(dir) = crate::data_dir::logs_dir() {
            cmd.env("HELMOR_LOG_DIR", dir);
        }
        if let Ok(level) = std::env::var("HELMOR_LOG") {
            cmd.env("HELMOR_LOG", level);
        } else if crate::data_dir::is_dev() {
            cmd.env("HELMOR_LOG", "debug");
        }

        tracing::debug!(
            cmd = if is_dev {
                format!("bun run {}", sidecar_path.display())
            } else {
                sidecar_path.display().to_string()
            },
            "Spawning sidecar"
        );

        let mut child = cmd.spawn().with_context(|| {
            if is_dev {
                "Failed to start sidecar — is Bun installed? (https://bun.sh)".to_string()
            } else {
                format!("Failed to start sidecar binary: {}", sidecar_path.display())
            }
        })?;

        let stdin = child
            .stdin
            .take()
            .context("Failed to capture sidecar stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("Failed to capture sidecar stdout")?;
        let mut reader = BufReader::new(stdout);

        tracing::debug!("Waiting for sidecar ready signal...");

        // Wait for "ready" signal
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .context("Failed to read sidecar ready signal")?;

        let ready: Value =
            serde_json::from_str(line.trim()).context("Invalid sidecar ready signal")?;
        if ready.get("type").and_then(Value::as_str) != Some("ready") {
            bail!("Unexpected sidecar startup message: {line}");
        }

        tracing::info!(pid = child.id(), "Sidecar started");

        let process = Self {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
        };
        Ok((process, reader))
    }

    fn send(&self, request: &SidecarRequest) -> Result<()> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| anyhow::anyhow!("Sidecar stdin lock poisoned"))?;

        let json = serde_json::to_string(request).context("Failed to serialize request")?;
        tracing::debug!(id = %request.id, method = %request.method, bytes = json.len(), "→ stdin");
        writeln!(stdin, "{json}").context("Failed to write to sidecar stdin")?;
        stdin.flush().context("Failed to flush sidecar stdin")?;

        Ok(())
    }

    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Force-kill (SIGKILL) the sidecar and its entire process group.
    /// Last-resort cleanup; the cooperative shutdown ladder lives in
    /// `ManagedSidecar::shutdown`.
    fn kill(&mut self) {
        // On Unix, kill the whole process group first so child CLIs
        // don't get reparented to launchd as orphans.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.pid() as libc::pid_t), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// Wait up to `timeout` for the child to exit on its own. Returns true
    /// if the child exited within the budget.
    fn wait_with_timeout(&mut self, timeout: Duration) -> bool {
        let start = Instant::now();
        let poll = Duration::from_millis(25);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) => {}
                Err(_) => return false,
            }
            if start.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(poll);
        }
    }

    /// Send SIGTERM to the sidecar's process group. Unix only; on other
    /// platforms this is a no-op (the SIGKILL fallback in `kill()` still
    /// applies). Targeting the group (negative PID) ensures child CLIs
    /// spawned by Bun also receive the signal.
    #[cfg(unix)]
    fn send_sigterm(&self) {
        // SAFETY: `pid()` is the live child's PID (== PGID since we set
        // process_group(0) at spawn). Negative PID targets the whole group.
        unsafe {
            libc::kill(-(self.pid() as libc::pid_t), libc::SIGTERM);
        }
    }

    #[cfg(not(unix))]
    fn send_sigterm(&self) {
        // No portable SIGTERM equivalent on Windows; fall through to kill().
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        // Prefer cooperative teardown: SIGTERM → short wait → SIGKILL.
        // The full shutdown ladder lives in ManagedSidecar::shutdown(); this
        // is the last-resort fallback for unexpected drops.
        self.send_sigterm();
        if !self.wait_with_timeout(Duration::from_millis(200)) {
            self.kill();
        }
    }
}

// ---------------------------------------------------------------------------
// Managed sidecar with event dispatcher
// ---------------------------------------------------------------------------

type Listeners = Arc<Mutex<HashMap<String, mpsc::Sender<SidecarEvent>>>>;

pub struct ManagedSidecar {
    process: Mutex<Option<SidecarProcess>>,
    listeners: Listeners,
    /// Shared flag so the reader thread can signal its own exit.
    reader_running: Arc<Mutex<bool>>,
}

impl Default for ManagedSidecar {
    fn default() -> Self {
        Self::new()
    }
}

impl ManagedSidecar {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            listeners: Arc::new(Mutex::new(HashMap::new())),
            reader_running: Arc::new(Mutex::new(false)),
        }
    }

    /// Register a listener for events matching `request_id`.
    /// Returns a `Receiver` that will receive dispatched events.
    pub fn subscribe(&self, request_id: &str) -> mpsc::Receiver<SidecarEvent> {
        let (tx, rx) = mpsc::channel();
        if let Ok(mut map) = self.listeners.lock() {
            tracing::debug!(request_id, listeners = map.len() + 1, "subscribe");
            map.insert(request_id.to_string(), tx);
        }
        rx
    }

    /// Unregister a listener (called automatically when the sender is dropped,
    /// but explicit cleanup avoids accumulating stale keys).
    pub fn unsubscribe(&self, request_id: &str) {
        if let Ok(mut map) = self.listeners.lock() {
            map.remove(request_id);
            tracing::debug!(request_id, listeners = map.len(), "unsubscribe");
        }
    }

    /// Ensure sidecar is running and send a request.
    pub fn send(&self, request: &SidecarRequest) -> Result<()> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| anyhow::anyhow!("Sidecar lock poisoned"))?;

        // Start or restart if needed
        let needs_restart = match guard.as_mut() {
            None => true,
            Some(p) => !p.is_alive(),
        };

        if needs_restart {
            tracing::debug!("Sidecar needs (re)start");
            if let Some(mut old) = guard.take() {
                tracing::debug!("Killing old sidecar process");
                old.kill();
            }
            let (process, reader) = SidecarProcess::start()?;
            *guard = Some(process);

            // Start the reader/dispatcher thread (always spawns fresh)
            if let Err(error) = self.start_reader_thread(reader) {
                tracing::error!(error = %error, "Failed to start sidecar reader thread");
                if let Some(mut process) = guard.take() {
                    process.kill();
                }
                return Err(error);
            }
        }

        guard.as_ref().unwrap().send(request)
    }

    /// Cooperative shutdown of the sidecar process. Three-step ladder:
    ///
    ///   1. Send a `shutdown` JSON-RPC request — the sidecar's handler closes
    ///      every active SDK Query (Claude `Query.close()`, Codex
    ///      `AbortController.abort()`) then `process.exit(0)`s itself.
    ///   2. If the child hasn't exited within `cooperative`, send SIGTERM.
    ///   3. If still alive after `escalation` more, SIGKILL via the existing
    ///      `kill()` path.
    ///
    /// Safe to call when the sidecar isn't running — it just no-ops. After
    /// this returns, the underlying process is guaranteed to be reaped.
    pub fn shutdown(&self, cooperative: Duration, escalation: Duration) {
        let mut guard = match self.process.lock() {
            Ok(g) => g,
            Err(e) => {
                tracing::error!("Sidecar shutdown: lock poisoned, taking over: {e}");
                e.into_inner()
            }
        };

        let Some(process) = guard.as_mut() else {
            return;
        };

        if !process.is_alive() {
            // Already gone — drop the slot so the next send() spawns fresh.
            *guard = None;
            return;
        }

        // Step 1: cooperative shutdown via RPC.
        let request = SidecarRequest {
            id: Uuid::new_v4().to_string(),
            method: "shutdown".to_string(),
            params: serde_json::json!({}),
        };
        match process.send(&request) {
            Ok(()) => {
                tracing::info!(
                    timeout_ms = cooperative.as_millis() as u64,
                    "Sidecar shutdown: cooperative request sent"
                );
                if process.wait_with_timeout(cooperative) {
                    tracing::info!("Sidecar shutdown: exited cleanly");
                    *guard = None;
                    return;
                }
            }
            Err(e) => {
                tracing::error!("Sidecar shutdown: cooperative send failed: {e}");
            }
        }

        // Step 2: SIGTERM escalation.
        tracing::info!("Sidecar shutdown: cooperative timed out — sending SIGTERM");
        process.send_sigterm();
        if process.wait_with_timeout(escalation) {
            tracing::info!("Sidecar shutdown: exited after SIGTERM");
            *guard = None;
            return;
        }

        // Step 3: SIGKILL last resort.
        tracing::info!("Sidecar shutdown: SIGTERM ignored — sending SIGKILL");
        process.kill();
        *guard = None;
    }

    /// Spawn a background thread that reads all sidecar stdout and dispatches
    /// events to the correct per-request channel. On exit (EOF / error), the
    /// thread clears `reader_running` and drops all listener senders so that
    /// blocked `rx.iter()` calls in `stream_via_sidecar` unblock immediately.
    fn start_reader_thread(&self, reader: BufReader<std::process::ChildStdout>) -> Result<()> {
        // Reset flag — previous reader (if any) already exited or we killed its process.
        if let Ok(mut running) = self.reader_running.lock() {
            *running = false;
        }

        let mut running = self.reader_running.lock().unwrap();
        if *running {
            return Ok(());
        }
        *running = true;
        drop(running);

        let listeners = Arc::clone(&self.listeners);
        let reader_flag = Arc::clone(&self.reader_running);
        let thread_reader_flag = Arc::clone(&reader_flag);

        std::thread::Builder::new()
            .name("sidecar-reader".into())
            .spawn(move || {
                tracing::debug!("Reader thread started");
                let mut reader = reader;
                let mut event_count: u64 = 0;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) => {
                            tracing::info!(event_count, "Sidecar process exited (EOF)");
                            break;
                        }
                        Ok(_) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            let Ok(raw) = serde_json::from_str::<Value>(trimmed) else {
                                tracing::error!(line = trimmed, "Invalid JSON from sidecar");
                                continue;
                            };
                            let event = SidecarEvent { raw };

                            if let Some(request_id) = event.id() {
                                let event_type = event.event_type().to_string();
                                let map = listeners.lock().unwrap_or_else(|e| e.into_inner());
                                if let Some(tx) = map.get(request_id) {
                                    tracing::debug!(request_id, event_type = %event_type, "← stdout");
                                    let _ = tx.send(event);
                                    event_count += 1;
                                } else {
                                    tracing::debug!(request_id, event_type = %event_type, "← stdout (no listener, dropped)");
                                }
                            } else {
                                // No-id event — broadcast to all active listeners
                                // (e.g. fatal uncaughtException / unhandledRejection).
                                tracing::debug!(raw = trimmed, "← stdout [no-id]");
                                if event.event_type() == "error" {
                                    let map = listeners.lock().unwrap_or_else(|e| e.into_inner());
                                    for (rid, tx) in map.iter() {
                                        let mut evt = event.clone();
                                        evt.raw.as_object_mut().unwrap().insert(
                                            "id".to_string(),
                                            Value::String(rid.clone()),
                                        );
                                        let _ = tx.send(evt);
                                    }
                                    event_count += 1;
                                }
                            }
                        }
                        Err(e) => {
                            tracing::error!("Sidecar read error: {e}");
                            break;
                        }
                    }
                }

                // --- Cleanup on exit ---
                tracing::debug!("Reader thread exiting — cleaning up");
                // 1. Clear reader_running so next send() spawns a fresh reader.
                if let Ok(mut flag) = thread_reader_flag.lock() {
                    *flag = false;
                }
                // 2. Send an error event to every active listener so in-flight
                //    streams surface the crash instead of silently dropping.
                // 3. Drop all listener senders so blocked rx.iter() calls return.
                if let Ok(mut map) = listeners.lock() {
                    let count = map.len();
                    if count > 0 {
                        tracing::info!(count, "Notifying active listeners of sidecar exit");
                        let crash_event = SidecarEvent {
                            raw: serde_json::json!({
                                "type": "error",
                                "message": "Agent process exited unexpectedly",
                                "internal": true,
                            }),
                        };
                        for (rid, tx) in map.iter() {
                            let mut evt = crash_event.clone();
                            evt.raw.as_object_mut().unwrap().insert("id".to_string(), Value::String(rid.clone()));
                            let _ = tx.send(evt);
                        }
                    }
                    map.clear();
                    tracing::debug!(count, "Cleared listeners");
                }
            })
            .map(|_| ())
            .map_err(|error| {
                if let Ok(mut flag) = reader_flag.lock() {
                    *flag = false;
                }
                anyhow::anyhow!("Failed to spawn sidecar reader thread: {error}")
            })
    }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

fn resolve_sidecar_path() -> Result<PathBuf> {
    // 1. Environment variable override
    if let Ok(path) = std::env::var("HELMOR_SIDECAR_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Ok(p);
        }
    }

    // 2. Development: sidecar/src/index.ts (Bun runs .ts directly)
    //    Tauri dev sets cwd to src-tauri/, so also check parent directory.
    if let Ok(cwd) = std::env::current_dir() {
        for base in [cwd.as_path(), cwd.parent().unwrap_or(cwd.as_path())] {
            let candidate = base.join("sidecar/src/index.ts");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    // 3. Production: compiled binary placed by Tauri externalBin.
    //    Tauri puts external binaries next to the main executable
    //    (e.g. Helmor.app/Contents/MacOS/helmor-sidecar on macOS,
    //     C:\Program Files\Helmor\helmor-sidecar.exe on Windows).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // Windows: Tauri CLI emits externalBins with the same .exe suffix
            // as the parent Helmor binary. On Unix, no extension.
            let binary_name = if cfg!(windows) {
                "helmor-sidecar.exe"
            } else {
                "helmor-sidecar"
            };
            let binary = exe_dir.join(binary_name);
            if binary.is_file() {
                return Ok(binary);
            }
        }
    }

    bail!("Sidecar not found. In dev, ensure sidecar/src/index.ts exists. Set HELMOR_SIDECAR_PATH to override.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_event_preserves_all_fields() {
        let raw = serde_json::json!({
            "id": "req-1",
            "type": "assistant",
            "session_id": "sess-abc",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "hello"}]},
        });
        let event = SidecarEvent { raw };
        assert_eq!(event.id(), Some("req-1"));
        assert_eq!(event.event_type(), "assistant");
        assert_eq!(event.session_id(), Some("sess-abc"));
        // Verify full JSON is preserved for forwarding
        let serialized = serde_json::to_string(&event.raw).unwrap();
        assert!(serialized.contains("\"type\":\"assistant\""));
        assert!(serialized.contains("\"message\""));
    }

    #[test]
    fn sidecar_event_handles_missing_fields() {
        let raw = serde_json::json!({"data": "something"});
        let event = SidecarEvent { raw };
        assert_eq!(event.id(), None);
        assert_eq!(event.event_type(), "unknown");
        assert_eq!(event.session_id(), None);
    }

    #[test]
    fn managed_sidecar_subscribe_unsubscribe() {
        let sidecar = ManagedSidecar::new();
        let rx = sidecar.subscribe("req-1");

        // Manually push an event through the listeners
        {
            let map = sidecar.listeners.lock().unwrap();
            let tx = map.get("req-1").unwrap();
            tx.send(SidecarEvent {
                raw: serde_json::json!({"type": "test"}),
            })
            .unwrap();
        }

        let event = rx.recv().unwrap();
        assert_eq!(event.event_type(), "test");

        sidecar.unsubscribe("req-1");
        let map = sidecar.listeners.lock().unwrap();
        assert!(!map.contains_key("req-1"));
    }

    #[test]
    fn reader_cleanup_unblocks_receivers() {
        let sidecar = ManagedSidecar::new();
        let rx = sidecar.subscribe("req-1");

        // Simulate reader exit: clear listeners (drops senders)
        {
            let mut map = sidecar.listeners.lock().unwrap();
            map.clear();
        }

        // rx.iter() should now terminate (sender dropped)
        let events: Vec<_> = rx.iter().collect();
        assert!(events.is_empty());
    }

    #[test]
    fn reader_running_flag_allows_restart() {
        let sidecar = ManagedSidecar::new();

        // Simulate: reader was running, then exited and cleared flag
        {
            let mut flag = sidecar.reader_running.lock().unwrap();
            *flag = true;
        }
        // Simulate reader exit cleanup
        {
            let mut flag = sidecar.reader_running.lock().unwrap();
            *flag = false;
        }

        // Now start_reader_thread should be willing to start again
        let flag = sidecar.reader_running.lock().unwrap();
        assert!(!*flag, "Flag should be cleared, allowing restart");
    }

    #[test]
    fn no_id_error_event_broadcasts_to_all_listeners() {
        let sidecar = ManagedSidecar::new();
        let rx1 = sidecar.subscribe("req-1");
        let rx2 = sidecar.subscribe("req-2");

        // Simulate a no-id error event being dispatched (same logic as
        // the reader thread's broadcast path).
        {
            let event = SidecarEvent {
                raw: serde_json::json!({
                    "type": "error",
                    "message": "Internal sidecar error",
                    "internal": true,
                }),
            };
            let map = sidecar.listeners.lock().unwrap();
            for (rid, tx) in map.iter() {
                let mut evt = event.clone();
                evt.raw
                    .as_object_mut()
                    .unwrap()
                    .insert("id".to_string(), Value::String(rid.clone()));
                let _ = tx.send(evt);
            }
        }

        // Both listeners should receive the error with their own id injected
        let e1 = rx1.recv().unwrap();
        assert_eq!(e1.id(), Some("req-1"));
        assert_eq!(e1.event_type(), "error");
        assert_eq!(e1.raw.get("internal").and_then(Value::as_bool), Some(true));

        let e2 = rx2.recv().unwrap();
        assert_eq!(e2.id(), Some("req-2"));
        assert_eq!(e2.event_type(), "error");
    }
}
