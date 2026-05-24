//! Lifecycle manager for the [Executor](https://github.com/RhysSullivan/executor)
//! local daemon.
//!
//! Spawns `bunx executor@<PIN> web --port 0 --auth-password <uuid>` as a
//! Helmor-owned child process, parses the announced port from stdout, and
//! tears it down (SIGTERM → grace → SIGKILL) when Helmor exits.
//!
//! Lifecycle is bound to Helmor:
//! - Start: launched in `setup` hook after main window is built.
//! - Stop:  `request_quit` (Cmd+Q, close button, etc.) calls
//!   `ManagedExecutor::shutdown` before `app.exit(0)`.
//! - Drop:  process group SIGTERM is the last-resort safety net.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;

pub mod client;

pub use client::{ExecutorClient, McpSourceRow};

/// Pinned executor version. Bump when an upstream patch lands that we want.
/// Beta channel today — see https://github.com/RhysSullivan/executor/releases.
///
/// 1.4.30 → 1.4.33 versus 1.4.29:
/// - Source config no longer replays from / writes back to `executor.jsonc`;
///   live state lives in the shared Executor sqlite db (we don't touch
///   the jsonc, so this is transparent).
/// - MCP / OpenAPI / GraphQL tools return structured auth failures with
///   recovery guidance instead of opaque internal errors.
/// - OAuth popup completes more reliably; OAuth DCR data is reused across
///   retries / reconnects.
/// - MCP tool output schemas now mirror the full `CallToolResult` envelope
///   (`content`, `structuredContent`, `_meta`, `isError`) — additive on
///   the wire, our client only reads `isError`.
/// - No breaking changes declared by any of the four releases.
pub const EXECUTOR_PIN: &str = "1.4.33";

/// Cooperative shutdown timeout. Executor handles SIGTERM by closing
/// in-flight HTTP requests + flushing sqlite — usually well under 2s.
const SIGTERM_GRACE: Duration = Duration::from_secs(5);

/// How long to wait for the "Web: http://..." banner on stdout before
/// giving up. First-launch `bunx` may take 10s to download, so 30s.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorStatus {
    pub running: bool,
    pub base_url: Option<String>,
    pub error: Option<String>,
    pub version: String,
}

pub struct ManagedExecutor {
    inner: Mutex<State>,
}

enum State {
    NotStarted,
    Starting,
    Running(RunningProcess),
    Failed { error: String },
}

struct RunningProcess {
    child: Child,
    base_url: String,
    auth_password: String,
    /// Executor's runtime scope id (looked up via `GET /api/scope`
    /// immediately after the daemon's "ready" banner). NOT the literal
    /// string `"default"` — executor derives it from `EXECUTOR_SCOPE_DIR`
    /// as `executor-${sha256(dir).slice(0,8)}`.
    scope_id: String,
}

impl ManagedExecutor {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(State::NotStarted),
        }
    }

    /// Acquire the state mutex, recovering gracefully from a poisoned
    /// lock (i.e. another thread panicked while holding it). Without this
    /// recovery, a single panic anywhere in the executor pipeline taints
    /// the whole `ManagedExecutor` forever; the panel would then report
    /// "lock poisoned" instead of the real underlying error.
    fn lock_state(&self) -> MutexGuard<'_, State> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                tracing::warn!(
                    target: "executor::lifecycle",
                    "State mutex was poisoned — recovering"
                );
                poisoned.into_inner()
            }
        }
    }

    /// Start the executor process. Idempotent: returns Ok(()) if already
    /// running. Updates the state atomically; on failure stores the error
    /// so `status()` can surface it.
    pub fn start(&self, data_dir: &Path) -> Result<()> {
        let start_at = Instant::now();
        tracing::info!(
            target: "executor::lifecycle",
            data_dir = %data_dir.display(),
            version = EXECUTOR_PIN,
            "ManagedExecutor::start invoked"
        );

        {
            let guard = self.lock_state();
            if let State::Running(p) = &*guard {
                tracing::info!(
                    target: "executor::lifecycle",
                    base_url = %p.base_url,
                    pid = p.child.id(),
                    "Executor already running — start is a no-op"
                );
                return Ok(());
            }
            tracing::debug!(
                target: "executor::lifecycle",
                from_state = state_name(&guard),
                "Transitioning to Starting"
            );
        }

        // Set Starting state so concurrent calls don't double-spawn.
        {
            let mut guard = self.lock_state();
            *guard = State::Starting;
        }

        match spawn_executor(data_dir) {
            Ok(process) => {
                tracing::info!(
                    target: "executor::lifecycle",
                    base_url = %process.base_url,
                    pid = process.child.id(),
                    version = EXECUTOR_PIN,
                    elapsed_ms = start_at.elapsed().as_millis() as u64,
                    "Executor started — Running"
                );
                let mut guard = self.lock_state();
                *guard = State::Running(process);
                Ok(())
            }
            Err(err) => {
                let msg = format!("{err:#}");
                tracing::warn!(
                    target: "executor::lifecycle",
                    error = %msg,
                    elapsed_ms = start_at.elapsed().as_millis() as u64,
                    "Executor failed to start — Failed"
                );
                let mut guard = self.lock_state();
                *guard = State::Failed { error: msg.clone() };
                Err(err)
            }
        }
    }

    /// Restart: shutdown + start.
    pub fn restart(&self, data_dir: &Path) -> Result<()> {
        tracing::info!(
            target: "executor::lifecycle",
            data_dir = %data_dir.display(),
            "ManagedExecutor::restart invoked"
        );
        self.shutdown();
        self.start(data_dir)
    }

    pub fn status(&self) -> ExecutorStatus {
        let guard = self.lock_state();
        let version = EXECUTOR_PIN.to_string();
        match &*guard {
            State::Running(p) => ExecutorStatus {
                running: true,
                base_url: Some(p.base_url.clone()),
                error: None,
                version,
            },
            State::Failed { error } => ExecutorStatus {
                running: false,
                base_url: None,
                error: Some(error.clone()),
                version,
            },
            State::Starting => ExecutorStatus {
                running: false,
                base_url: None,
                error: Some("Starting…".into()),
                version,
            },
            State::NotStarted => ExecutorStatus {
                running: false,
                base_url: None,
                error: None,
                version,
            },
        }
    }

    /// Build an authenticated HTTP client. Returns None when executor isn't
    /// running. Commands that need to talk to the daemon should call this
    /// and map None → "executor not running" error.
    pub fn client(&self) -> Option<ExecutorClient> {
        let guard = self.lock_state();
        match &*guard {
            State::Running(p) => Some(ExecutorClient::new(
                p.base_url.clone(),
                p.auth_password.clone(),
                p.scope_id.clone(),
            )),
            _ => None,
        }
    }

    /// Snapshot of the live `(base_url, auth_password)` pair, or None if
    /// executor isn't running. Used by the Studio window opener to embed
    /// credentials in the URL userinfo (avoids a separate fetch+inject
    /// dance for the very first request).
    pub fn credentials(&self) -> Option<(String, String)> {
        let guard = self.lock_state();
        match &*guard {
            State::Running(p) => Some((p.base_url.clone(), p.auth_password.clone())),
            _ => None,
        }
    }

    /// Cooperative shutdown: SIGTERM → grace → SIGKILL. Safe to call when
    /// nothing is running.
    pub fn shutdown(&self) {
        let start_at = Instant::now();
        let mut guard = self.lock_state();
        let prev = state_name(&guard);
        let State::Running(mut process) = std::mem::replace(&mut *guard, State::NotStarted) else {
            tracing::debug!(
                target: "executor::lifecycle",
                state = prev,
                "shutdown() called but executor wasn't running — no-op"
            );
            return;
        };
        drop(guard);

        let pid = process.child.id();
        tracing::info!(
            target: "executor::lifecycle",
            pid,
            grace_ms = SIGTERM_GRACE.as_millis() as u64,
            "Stopping executor: sending SIGTERM to process group"
        );
        send_sigterm(&process.child);
        if wait_with_timeout(&mut process.child, SIGTERM_GRACE) {
            tracing::info!(
                target: "executor::lifecycle",
                pid,
                elapsed_ms = start_at.elapsed().as_millis() as u64,
                "Executor exited cleanly after SIGTERM — Stopped"
            );
        } else {
            tracing::warn!(
                target: "executor::lifecycle",
                pid,
                "SIGTERM grace expired — escalating to SIGKILL"
            );
            let _ = process.child.kill();
            let _ = process.child.wait();
            tracing::info!(
                target: "executor::lifecycle",
                pid,
                elapsed_ms = start_at.elapsed().as_millis() as u64,
                "Executor killed (SIGKILL) — Stopped"
            );
        }
    }
}

fn state_name(state: &State) -> &'static str {
    match state {
        State::NotStarted => "NotStarted",
        State::Starting => "Starting",
        State::Running(_) => "Running",
        State::Failed { .. } => "Failed",
    }
}

impl Default for ManagedExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Spawn implementation
// ---------------------------------------------------------------------------

fn spawn_executor(data_dir: &Path) -> Result<RunningProcess> {
    let spawn_start = Instant::now();
    tracing::debug!(
        target: "executor::spawn",
        path = %std::env::var("PATH").unwrap_or_default(),
        "Looking up `bunx` on PATH"
    );
    let bunx = locate_bunx()?;
    tracing::info!(
        target: "executor::spawn",
        bunx = %bunx.display(),
        "Located bunx"
    );

    let scope_dir = data_dir.join("executor");
    std::fs::create_dir_all(&scope_dir).with_context(|| {
        format!(
            "Failed to create executor data dir at {}",
            scope_dir.display()
        )
    })?;
    tracing::debug!(
        target: "executor::spawn",
        scope_dir = %scope_dir.display(),
        "Executor scope dir ready"
    );

    let auth_password = uuid::Uuid::new_v4().to_string();
    let pinned = format!("executor@{EXECUTOR_PIN}");

    let mut cmd = Command::new(&bunx);
    cmd.args([
        &pinned,
        "web",
        "--port",
        "0",
        "--hostname",
        "127.0.0.1",
        "--auth-password",
        &auth_password,
    ]);
    cmd.env("EXECUTOR_DATA_DIR", &scope_dir);
    cmd.env("EXECUTOR_SCOPE_DIR", &scope_dir);
    // bunx caches versions under ~/.bun/install/cache; respect user's HOME.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Put the executor in its own process group so SIGTERM reaches every
    // descendant (the Bun runner + the spawned `executor` itself).
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);

    tracing::info!(
        target: "executor::spawn",
        bunx = %bunx.display(),
        pinned = %pinned,
        scope_dir = %scope_dir.display(),
        auth_password_present = !auth_password.is_empty(),
        ready_timeout_s = READY_TIMEOUT.as_secs(),
        "Spawning executor child process"
    );

    let mut child = cmd
        .spawn()
        .with_context(|| format!("Failed to spawn `{} {pinned} web ...`", bunx.display()))?;
    let pid = child.id();
    tracing::info!(
        target: "executor::spawn",
        pid,
        "Executor child spawned — waiting for ready banner"
    );

    let stdout = child.stdout.take().context("missing executor stdout")?;
    let stderr = child.stderr.take().context("missing executor stderr")?;

    // Watch stderr in a background thread so we can surface meaningful errors.
    thread::Builder::new()
        .name("executor-stderr".into())
        .spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                // stderr is where bunx prints "installing executor@..." progress
                // and where executor prints structured errors. Promote to debug
                // so it's visible by default in dev (HELMOR_LOG=debug).
                tracing::debug!(target: "executor::child", source = "stderr", "{line}");
            }
            tracing::debug!(target: "executor::child", source = "stderr", "stderr pipe closed");
        })
        .ok();

    let base_url = match wait_for_ready(stdout, READY_TIMEOUT) {
        Ok(url) => {
            tracing::info!(
                target: "executor::spawn",
                pid,
                base_url = %url,
                elapsed_ms = spawn_start.elapsed().as_millis() as u64,
                "Executor ready banner observed"
            );
            url
        }
        Err(err) => {
            tracing::warn!(
                target: "executor::spawn",
                pid,
                elapsed_ms = spawn_start.elapsed().as_millis() as u64,
                error = %format!("{err:#}"),
                "Executor failed to reach ready state — killing child"
            );
            // Kill the half-started process so it doesn't linger.
            send_sigterm(&child);
            let _ = wait_with_timeout(&mut child, Duration::from_secs(2));
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
    };

    // Now that executor is listening, fetch its real scope id. This is
    // generated server-side from EXECUTOR_SCOPE_DIR (sha256 prefix) and is
    // NOT the literal string "default" — we have to discover it before
    // any subsequent POST that puts scope in the path or `targetScope`
    // body field. `spawn_executor` runs on the blocking pool, so we use
    // `block_on` to await the async HTTP call.
    let scope_id = match tauri::async_runtime::block_on(client::discover_scope_id(
        &base_url,
        &auth_password,
    )) {
        Ok(id) => id,
        Err(err) => {
            tracing::warn!(
                target: "executor::spawn",
                pid = child.id(),
                error = %format!("{err:#}"),
                "Executor scope discovery failed — killing child"
            );
            send_sigterm(&child);
            let _ = wait_with_timeout(&mut child, Duration::from_secs(2));
            let _ = child.kill();
            let _ = child.wait();
            return Err(err.context("discover executor scope id"));
        }
    };

    tracing::info!(
        target: "executor::spawn",
        pid = child.id(),
        base_url = %base_url,
        scope_id = %scope_id,
        "Executor ready + scope discovered"
    );

    Ok(RunningProcess {
        child,
        base_url,
        auth_password,
        scope_id,
    })
}

/// Block until we see `Web: http://localhost:<port>` (or equivalent banner)
/// on stdout, then keep draining stdout in a detached thread so the pipe
/// never blocks the child.
fn wait_for_ready(stdout: std::process::ChildStdout, timeout: Duration) -> Result<String> {
    let reader = BufReader::new(stdout);
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let (tx, rx) = std::sync::mpsc::channel::<String>();

    let lines_clone = Arc::clone(&lines);
    thread::Builder::new()
        .name("executor-stdout".into())
        .spawn(move || {
            for line in reader.lines().map_while(Result::ok) {
                tracing::debug!(target: "executor::child", source = "stdout", "{line}");
                {
                    let mut buf = lines_clone.lock().unwrap();
                    buf.push(line.clone());
                }
                // Best-effort signal; if main thread already moved on, this fails silently.
                let _ = tx.send(line);
            }
            tracing::debug!(target: "executor::child", source = "stdout", "stdout pipe closed");
        })?;

    let deadline = Instant::now() + timeout;
    let mut scanned = 0usize;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                scanned += 1;
                if let Some(url) = extract_base_url(&line) {
                    tracing::debug!(
                        target: "executor::spawn",
                        lines_scanned = scanned,
                        matched = %line,
                        parsed_base_url = %url,
                        "Banner line matched"
                    );
                    return Ok(url);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                let buf = lines.lock().unwrap();
                tracing::warn!(
                    target: "executor::spawn",
                    lines_scanned = scanned,
                    last_output = %buf.join("\n"),
                    "Executor stdout closed before ready banner"
                );
                bail!(
                    "executor stdout closed before ready banner.\nLast output:\n{}",
                    buf.join("\n")
                );
            }
        }
    }

    let buf = lines.lock().unwrap();
    tracing::warn!(
        target: "executor::spawn",
        timeout_s = timeout.as_secs(),
        lines_scanned = scanned,
        last_output = %buf.join("\n"),
        "Timed out waiting for executor ready banner"
    );
    bail!(
        "Timed out after {}s waiting for executor ready banner.\nLast output:\n{}",
        timeout.as_secs(),
        buf.join("\n")
    )
}

/// Extract a `http://host:port` URL from a banner line. Executor prints
/// `Web: http://localhost:<port>` on the daemon-started log; we accept any
/// occurrence of `http://127.0.0.1:` or `http://localhost:` followed by a
/// port to be future-proof against banner format changes.
fn extract_base_url(line: &str) -> Option<String> {
    const PREFIXES: &[&str] = &["http://127.0.0.1:", "http://localhost:"];
    for prefix in PREFIXES {
        if let Some(idx) = line.find(prefix) {
            let rest = &line[idx..];
            // Read until whitespace or end-of-string.
            let end = rest
                .find(|c: char| c.is_whitespace() || c == ',' || c == ')' || c == '\'')
                .unwrap_or(rest.len());
            let candidate = &rest[..end];
            // Validate it parses as URL and has a port.
            if let Ok(parsed) = url::Url::parse(candidate) {
                if parsed.port().is_some() {
                    // Normalise to 127.0.0.1 so localhost-vs-127 doesn't bite later.
                    let mut norm = parsed.clone();
                    let _ = norm.set_host(Some("127.0.0.1"));
                    return Some(norm.as_str().trim_end_matches('/').to_string());
                }
            }
        }
    }
    None
}

fn locate_bunx() -> Result<PathBuf> {
    // `which` semantics via PATH walk. Helmor already calls
    // `shell_env::inherit_login_shell_env()` so user's bun install (e.g.
    // ~/.bun/bin) is on PATH for GUI launches.
    let candidate = which("bunx").ok_or_else(|| {
        anyhow!("`bunx` not found on PATH. Install Bun from https://bun.sh and restart Helmor.")
    })?;
    Ok(candidate)
}

fn which(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            let candidate = dir.join(program);
            candidate.is_file().then_some(candidate)
        })
    })
}

fn send_sigterm(child: &Child) {
    // Negative PID targets the whole process group (set via
    // `process_group(0)` at spawn).
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGTERM);
    }
}

fn wait_with_timeout(child: &mut Child, timeout: Duration) -> bool {
    let start = Instant::now();
    let poll = Duration::from_millis(25);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return false,
        }
        if start.elapsed() >= timeout {
            return false;
        }
        thread::sleep(poll);
    }
}

impl Drop for RunningProcess {
    fn drop(&mut self) {
        // Last-resort: cooperative shutdown happens through
        // `ManagedExecutor::shutdown`. This branch only runs when Helmor
        // dies unexpectedly (panic in setup, crash, etc.).
        let pid = self.child.id();
        tracing::warn!(
            target: "executor::lifecycle",
            pid,
            "RunningProcess::drop reached (unexpected exit path) — emergency SIGTERM"
        );
        send_sigterm(&self.child);
        if !wait_with_timeout(&mut self.child, Duration::from_millis(500)) {
            tracing::warn!(
                target: "executor::lifecycle",
                pid,
                "Drop fallback: SIGTERM didn't catch in 500ms — sending SIGKILL"
            );
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_banner_url_from_executor_format() {
        let banner = "Web: http://localhost:4788  (logs: ...)";
        assert_eq!(
            extract_base_url(banner).as_deref(),
            Some("http://127.0.0.1:4788")
        );
    }

    #[test]
    fn extracts_banner_url_from_127_form() {
        let banner = "Listening on http://127.0.0.1:55123";
        assert_eq!(
            extract_base_url(banner).as_deref(),
            Some("http://127.0.0.1:55123")
        );
    }

    #[test]
    fn rejects_url_without_port() {
        assert_eq!(extract_base_url("see http://localhost/"), None);
    }

    #[test]
    fn rejects_unrelated_lines() {
        assert_eq!(extract_base_url("[bun] installing executor@1.4.29"), None);
    }
}
