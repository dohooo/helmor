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
// Debug logging — enabled via HELMOR_SIDECAR_DEBUG=1
// ---------------------------------------------------------------------------

fn debug_enabled() -> bool {
    std::env::var("HELMOR_SIDECAR_DEBUG")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

macro_rules! sidecar_debug {
    ($($arg:tt)*) => {
        if debug_enabled() {
            eprintln!("[sidecar:debug] {}", format!($($arg)*));
        }
    };
}

/// Truncate a UTF-8 string to roughly `max_bytes` for log previews
/// without slicing inside a multi-byte char. Walks character
/// boundaries via `char_indices` and stops just before exceeding the
/// budget. The reader thread used to do `&s[..s.len().min(N)]` which
/// panics on Chinese (or any multi-byte) text whose char boundary
/// straddles the cut point — that single panic killed the entire
/// reader thread mid-stream and froze the live render.
fn char_safe_prefix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = 0;
    for (idx, _) in s.char_indices() {
        if idx > max_bytes {
            break;
        }
        end = idx;
    }
    &s[..end]
}

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
        sidecar_debug!("Resolved sidecar path: {}", sidecar_path.display());

        let debug = debug_enabled();

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

        if debug {
            cmd.env("HELMOR_SIDECAR_DEBUG", "1");
        }

        sidecar_debug!(
            "Spawning: {}",
            if is_dev {
                format!("bun run {}", sidecar_path.display())
            } else {
                sidecar_path.display().to_string()
            }
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

        sidecar_debug!("Waiting for ready signal...");

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

        eprintln!("[sidecar] Started (pid={})", child.id());

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
        sidecar_debug!(
            "→ stdin [{}] {} ({}B)",
            request.id,
            request.method,
            json.len()
        );
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

    /// Force-kill (SIGKILL) the child. Last-resort cleanup; the cooperative
    /// shutdown ladder lives in `ManagedSidecar::shutdown`.
    fn kill(&mut self) {
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

    /// Send SIGTERM to the child. Unix only; on other platforms this is a
    /// no-op (the SIGKILL fallback in `kill()` still applies).
    #[cfg(unix)]
    fn send_sigterm(&self) {
        // SAFETY: `pid()` is the live child's PID owned by `self.child`.
        // `libc::kill` with SIGTERM cannot corrupt our address space; the
        // worst-case is the signal is delivered after the child already
        // exited, in which case we get ESRCH and ignore it.
        unsafe {
            libc::kill(self.pid() as libc::pid_t, libc::SIGTERM);
        }
    }

    #[cfg(not(unix))]
    fn send_sigterm(&self) {
        // No portable SIGTERM equivalent on Windows; fall through to kill().
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        self.kill();
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
            sidecar_debug!(
                "subscribe({}) — {} active listeners",
                request_id,
                map.len() + 1
            );
            map.insert(request_id.to_string(), tx);
        }
        rx
    }

    /// Unregister a listener (called automatically when the sender is dropped,
    /// but explicit cleanup avoids accumulating stale keys).
    pub fn unsubscribe(&self, request_id: &str) {
        if let Ok(mut map) = self.listeners.lock() {
            map.remove(request_id);
            sidecar_debug!(
                "unsubscribe({}) — {} active listeners",
                request_id,
                map.len()
            );
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
            sidecar_debug!("send() — sidecar needs (re)start");
            if let Some(mut old) = guard.take() {
                sidecar_debug!("send() — killing old sidecar process");
                old.kill();
            }
            let (process, reader) = SidecarProcess::start()?;
            *guard = Some(process);

            // Start the reader/dispatcher thread (always spawns fresh)
            self.start_reader_thread(reader);
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
                eprintln!("[sidecar] shutdown: lock poisoned, taking over: {e}");
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
                eprintln!(
                    "[sidecar] shutdown: cooperative request sent, waiting up to {}ms",
                    cooperative.as_millis()
                );
                if process.wait_with_timeout(cooperative) {
                    eprintln!("[sidecar] shutdown: exited cleanly via process.exit(0)");
                    *guard = None;
                    return;
                }
            }
            Err(e) => {
                eprintln!("[sidecar] shutdown: cooperative send failed: {e}");
            }
        }

        // Step 2: SIGTERM escalation.
        eprintln!("[sidecar] shutdown: cooperative timed out — sending SIGTERM");
        process.send_sigterm();
        if process.wait_with_timeout(escalation) {
            eprintln!("[sidecar] shutdown: exited after SIGTERM");
            *guard = None;
            return;
        }

        // Step 3: SIGKILL last resort.
        eprintln!("[sidecar] shutdown: SIGTERM ignored — sending SIGKILL");
        process.kill();
        *guard = None;
    }

    /// Spawn a background thread that reads all sidecar stdout and dispatches
    /// events to the correct per-request channel. On exit (EOF / error), the
    /// thread clears `reader_running` and drops all listener senders so that
    /// blocked `rx.iter()` calls in `stream_via_sidecar` unblock immediately.
    fn start_reader_thread(&self, reader: BufReader<std::process::ChildStdout>) {
        // Reset flag — previous reader (if any) already exited or we killed its process.
        if let Ok(mut running) = self.reader_running.lock() {
            *running = false;
        }

        let mut running = self.reader_running.lock().unwrap();
        if *running {
            return;
        }
        *running = true;
        drop(running);

        let listeners = Arc::clone(&self.listeners);
        let reader_flag = Arc::clone(&self.reader_running);
        let debug = debug_enabled();

        std::thread::Builder::new()
            .name("sidecar-reader".into())
            .spawn(move || {
                if debug { eprintln!("[sidecar:debug] Reader thread started"); }
                let mut reader = reader;
                let mut event_count: u64 = 0;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) => {
                            eprintln!("[sidecar] Process exited (EOF) — {event_count} events dispatched");
                            break;
                        }
                        Ok(_) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            let Ok(raw) = serde_json::from_str::<Value>(trimmed) else {
                                eprintln!(
                                    "[sidecar] Invalid JSON: {}",
                                    char_safe_prefix(trimmed, 200)
                                );
                                continue;
                            };
                            let event = SidecarEvent { raw };

                            if let Some(request_id) = event.id() {
                                let event_type = event.event_type().to_string();
                                let map = listeners.lock().unwrap_or_else(|e| e.into_inner());
                                if let Some(tx) = map.get(request_id) {
                                    if debug {
                                        let preview = char_safe_prefix(trimmed, 120);
                                        eprintln!("[sidecar:debug] ← stdout [{request_id}] type={event_type} ({preview}...)");
                                    }
                                    let _ = tx.send(event);
                                    event_count += 1;
                                } else if debug {
                                    eprintln!("[sidecar:debug] ← stdout [{request_id}] type={event_type} — NO LISTENER (dropped)");
                                }
                            } else if debug {
                                let preview = char_safe_prefix(trimmed, 80);
                                eprintln!("[sidecar:debug] ← stdout [no-id] {preview}");
                            }
                        }
                        Err(e) => {
                            eprintln!("[sidecar] Read error: {e}");
                            break;
                        }
                    }
                }

                // --- Cleanup on exit ---
                if debug { eprintln!("[sidecar:debug] Reader thread exiting — cleaning up"); }
                // 1. Clear reader_running so next send() spawns a fresh reader.
                if let Ok(mut flag) = reader_flag.lock() {
                    *flag = false;
                }
                // 2. Drop all listener senders so blocked rx.iter() calls return.
                if let Ok(mut map) = listeners.lock() {
                    let count = map.len();
                    map.clear();
                    if debug { eprintln!("[sidecar:debug] Cleared {count} listeners"); }
                }
            })
            .ok();
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
    //    (e.g. Helmor.app/Contents/MacOS/helmor-sidecar).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let binary = exe_dir.join("helmor-sidecar");
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

    /// Regression for the reader-thread panic at sidecar.rs:450 — slicing
    /// a UTF-8 string at a byte offset that lands inside a multi-byte
    /// Chinese character (e.g. '，', bytes 0..3) used to panic and kill
    /// the reader thread mid-stream, freezing the live render.
    #[test]
    fn char_safe_prefix_does_not_split_multibyte_chars() {
        // 13 bytes: "好" (3) + "的" (3) + "，" (3) + "abc" (3) = wait, 3+3+3+3 = 12
        let s = "好的，abc"; // 3+3+3+3 = 12 bytes
                             // max_bytes=4 falls inside "的" (bytes 3..6) — must back off to "好"
        let prefix = char_safe_prefix(s, 4);
        assert_eq!(prefix, "好");
        // max_bytes=7 falls inside "，" (bytes 6..9) — back off to "好的"
        let prefix = char_safe_prefix(s, 7);
        assert_eq!(prefix, "好的");
        // max_bytes >= len returns the whole string
        let prefix = char_safe_prefix(s, 100);
        assert_eq!(prefix, s);
    }

    #[test]
    fn char_safe_prefix_pure_ascii_acts_like_byte_slice() {
        let s = "hello world";
        assert_eq!(char_safe_prefix(s, 5), "hello");
        assert_eq!(char_safe_prefix(s, 11), "hello world");
        assert_eq!(char_safe_prefix(s, 100), "hello world");
    }

    /// The exact panic case from the user-reported crash: a long JSON
    /// string with the truncation point falling inside a Chinese
    /// punctuation char.
    #[test]
    fn char_safe_prefix_handles_real_panic_payload() {
        // Reconstruct a string where byte 120 lands inside '，'.
        // Pad ASCII to push the multi-byte char to bytes 118..121.
        let mut s = String::new();
        for _ in 0..118 {
            s.push('a');
        }
        s.push('，'); // bytes 118..121
        s.push('z');
        // The buggy code did `&s[..120]` and panicked. char_safe_prefix
        // must back off to byte 118 (just before '，').
        let prefix = char_safe_prefix(&s, 120);
        assert_eq!(prefix.len(), 118);
        assert!(prefix.ends_with('a'));
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
}
