//! Server-side PTY-backed terminal sessions.
//!
//! Hosted by `helmor-server` (and by the loopback test that drives
//! it). Each session is keyed by a client-chosen `terminal_id` so
//! a single transport can multiplex multiple terminals — the
//! `terminal.event` notifications carry the id and the client
//! demuxes.
//!
//! Lifecycle:
//!
//! ```text
//!   client                       server
//!   ──────                       ──────
//!   terminal.open  ─────────►    spawn $SHELL on PTY, register
//!                                spawn reader thread + waiter
//!                  ◄────────     OpenResult { pid }
//!                  ◄────────     terminal.event Stdout (chunks)
//!   terminal.write ────────►     write to PTY master
//!                  ◄────────     terminal.event Stdout (echo + program output)
//!                                  ⋮
//!                  ◄────────     terminal.event Exited { code }
//!                                (when shell exits or close fires)
//! ```
//!
//! ## Why a parallel implementation
//!
//! The desktop's existing `workspace::scripts::run_terminal_session`
//! is tightly coupled to `tauri::ipc::Channel<ScriptEvent>` and the
//! `ScriptProcessManager`. Neither is reachable from the
//! `helmor-server` binary (no Tauri context). Rather than refactor
//! the desktop side, the server gets its own PTY plumbing keyed off
//! the JSON-RPC notification surface. The two implementations share
//! nothing at the type level — drift between them is contained by
//! the wire shapes in `methods.rs`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::json;

use super::methods::{
    TerminalAttachParams, TerminalAttachResult, TerminalCloseParams, TerminalCloseResult,
    TerminalEventKind, TerminalEventNotification, TerminalListEntry, TerminalListResult,
    TerminalOpenParams, TerminalOpenResult, TerminalResizeParams, TerminalResizeResult,
    TerminalWriteParams, TerminalWriteResult, TERMINAL_EVENT_METHOD,
};
use super::server::Notifier;

/// Default shell when the request doesn't override and `$SHELL`
/// isn't set on the server side. Same fallback the desktop's local
/// path uses.
const DEFAULT_SHELL: &str = "/bin/sh";

/// Sleep between non-blocking reads when the PTY has no data. Same
/// 25ms cadence the desktop's local PTY reader uses.
const PTY_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Per-write retry sleep + deadline. The PTY master is non-blocking,
/// so a busy slave produces `EAGAIN`; retry a few times before
/// surfacing the error to the client.
const PTY_WRITE_RETRY: Duration = Duration::from_millis(5);
const PTY_WRITE_DEADLINE: Duration = Duration::from_millis(500);

/// Cap on the per-terminal scrollback buffer. 256 KiB is enough for
/// most realistic "I quit Helmor for a minute, what happened?"
/// reattach sessions without holding an arbitrary heap budget for
/// long-running terminals. Older bytes drop off the front.
const SCROLLBACK_BYTES: usize = 256 * 1024;

/// Shared registry of live terminals on the server. Attached to
/// [`super::server::ServerContext`] so the dispatcher handlers can
/// reach it.
#[derive(Default)]
pub struct RemoteTerminalState {
    sessions: Mutex<HashMap<String, ActiveTerminal>>,
}

impl RemoteTerminalState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(
        &self,
        params: TerminalOpenParams,
        notifier: Arc<dyn Notifier>,
    ) -> Result<TerminalOpenResult> {
        if params.terminal_id.is_empty() {
            bail!("terminal_id must not be empty");
        }
        {
            let sessions = self.sessions.lock().expect("terminals mutex poisoned");
            if sessions.contains_key(&params.terminal_id) {
                bail!(
                    "terminal `{}` is already open; close it first to reopen",
                    params.terminal_id
                );
            }
        }
        let session = ActiveTerminal::spawn(params.clone(), notifier)?;
        let pid = session.pid;
        self.sessions
            .lock()
            .expect("terminals mutex poisoned")
            .insert(params.terminal_id, session);
        Ok(TerminalOpenResult { pid })
    }

    pub fn write(&self, params: TerminalWriteParams) -> Result<TerminalWriteResult> {
        let stdin = self.stdin_for(&params.terminal_id)?;
        let bytes = params.data.as_bytes();
        let written = blocking_write_with_retry(&stdin, bytes)?;
        Ok(TerminalWriteResult {
            bytes_written: written,
        })
    }

    pub fn resize(&self, params: TerminalResizeParams) -> Result<TerminalResizeResult> {
        // Lock the master and write the new size to the kernel,
        // then record the size on the session so `terminal.attach`
        // hands the new client the up-to-date dimensions.
        let sessions = self.sessions.lock().expect("terminals mutex poisoned");
        let session = sessions
            .get(&params.terminal_id)
            .ok_or_else(|| anyhow::anyhow!("terminal `{}` is not open", params.terminal_id))?;
        let file = session.stdin.lock().expect("stdin mutex poisoned");
        set_winsize(file.as_raw_fd(), params.cols, params.rows)?;
        *session.size.lock().expect("size mutex poisoned") = (params.cols, params.rows);
        Ok(TerminalResizeResult {})
    }

    /// Enumerate live sessions for the `terminal.list` handler.
    /// Stable order: most recently opened first.
    pub fn list(&self) -> TerminalListResult {
        let sessions = self.sessions.lock().expect("terminals mutex poisoned");
        let mut terminals: Vec<TerminalListEntry> = sessions
            .iter()
            .map(|(id, session)| {
                let (cols, rows) = *session.size.lock().expect("size mutex poisoned");
                TerminalListEntry {
                    terminal_id: id.clone(),
                    pid: session.pid,
                    workspace_dir: session.workspace_dir.clone(),
                    opened_at_ms: session.opened_at_ms,
                    cols,
                    rows,
                }
            })
            .collect();
        terminals.sort_by(|a, b| b.opened_at_ms.cmp(&a.opened_at_ms));
        TerminalListResult { terminals }
    }

    /// Swap in a new notifier for an existing terminal so subsequent
    /// stdout chunks flow to the attaching client. Returns the current
    /// scrollback as the initial chunk + the latest known PTY size.
    pub fn attach(
        &self,
        params: TerminalAttachParams,
        notifier: Arc<dyn Notifier>,
    ) -> Result<TerminalAttachResult> {
        let sessions = self.sessions.lock().expect("terminals mutex poisoned");
        let session = sessions
            .get(&params.terminal_id)
            .ok_or_else(|| anyhow::anyhow!("terminal `{}` is not open", params.terminal_id))?;
        let scrollback = session.sink.snapshot_scrollback();
        let (cols, rows) = *session.size.lock().expect("size mutex poisoned");
        session.sink.replace_notifier(notifier);
        Ok(TerminalAttachResult {
            scrollback,
            cols,
            rows,
        })
    }

    pub fn close(&self, params: TerminalCloseParams) -> Result<TerminalCloseResult> {
        // Take ownership out of the map so the Drop on the session
        // happens without us holding the lock — kill + reap can take
        // tens of milliseconds and would otherwise stall other
        // terminals.
        let session = {
            let mut sessions = self.sessions.lock().expect("terminals mutex poisoned");
            sessions.remove(&params.terminal_id)
        };
        if let Some(s) = session {
            s.shutdown();
        }
        // Idempotent: closing an unknown terminal is fine; the event
        // stream already ended.
        Ok(TerminalCloseResult {})
    }

    /// Internal: clone the stdin handle for a terminal so the
    /// write/resize paths can lock without holding the session map.
    fn stdin_for(&self, terminal_id: &str) -> Result<Arc<Mutex<std::fs::File>>> {
        let sessions = self.sessions.lock().expect("terminals mutex poisoned");
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| anyhow::anyhow!("terminal `{terminal_id}` is not open"))?;
        Ok(session.stdin.clone())
    }
}

/// Ring buffer over `Vec<u8>` capped at [`SCROLLBACK_BYTES`].
/// Tracks recent PTY output so a re-attaching client can paint the
/// recent history before live events resume. Append-only with a
/// front-trim when the cap would be exceeded.
struct ScrollbackBuffer {
    bytes: Vec<u8>,
}

impl ScrollbackBuffer {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn push(&mut self, chunk: &[u8]) {
        if chunk.len() >= SCROLLBACK_BYTES {
            // Pathological case: a single chunk bigger than the cap.
            // Keep only the tail.
            self.bytes.clear();
            let start = chunk.len() - SCROLLBACK_BYTES;
            self.bytes.extend_from_slice(&chunk[start..]);
            return;
        }
        let new_len = self.bytes.len() + chunk.len();
        if new_len > SCROLLBACK_BYTES {
            // Drop enough from the front to fit. `drain(..n)` shifts
            // the tail in place; the actual cost is once per overflow
            // append (terminal chunks are 4 KiB so amortised fine).
            let drop = new_len - SCROLLBACK_BYTES;
            self.bytes.drain(..drop);
        }
        self.bytes.extend_from_slice(chunk);
    }

    /// Snapshot the buffered bytes as a UTF-8 string (lossy on
    /// invalid sequences, matching the live stdout encoding).
    fn snapshot(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

/// Output sink shared by the reader + waiter threads. Carries both
/// the scrollback buffer (always written to) and the currently-active
/// notifier (replaceable via [`SessionSink::replace_notifier`]).
///
/// "Last attach wins": when a new client calls `terminal.attach`, it
/// swaps in its own notifier. Previous clients stop receiving live
/// stdout but keep whatever they already had. This avoids fan-out
/// machinery (multiple subscribers) at the cost of disallowing
/// simultaneous shadow attaches — fine for the spike's UX.
struct SessionSink {
    notifier: Mutex<Arc<dyn Notifier>>,
    scrollback: Mutex<ScrollbackBuffer>,
}

impl SessionSink {
    fn new(notifier: Arc<dyn Notifier>) -> Arc<Self> {
        Arc::new(Self {
            notifier: Mutex::new(notifier),
            scrollback: Mutex::new(ScrollbackBuffer::new()),
        })
    }

    fn current_notifier(&self) -> Arc<dyn Notifier> {
        self.notifier
            .lock()
            .expect("session notifier mutex poisoned")
            .clone()
    }

    fn replace_notifier(&self, next: Arc<dyn Notifier>) {
        *self
            .notifier
            .lock()
            .expect("session notifier mutex poisoned") = next;
    }

    fn append_stdout(&self, raw: &[u8]) {
        self.scrollback
            .lock()
            .expect("scrollback mutex poisoned")
            .push(raw);
    }

    fn snapshot_scrollback(&self) -> String {
        self.scrollback
            .lock()
            .expect("scrollback mutex poisoned")
            .snapshot()
    }
}

/// Per-session bookkeeping. The reader + waiter threads keep going
/// until the PTY hits EOF (slave closes) or the `stop_reader` flag
/// flips on `close()`. The reader thread owns the only
/// `File`-from-master-fd to keep the fd alive while we're reading.
struct ActiveTerminal {
    pid: u32,
    /// Where this terminal was opened. Surfaced via
    /// `terminal.list` so a reconnecting client can identify the
    /// session it cares about. Not authoritative for the running
    /// shell — `cd` inside the shell doesn't update this.
    workspace_dir: String,
    /// Unix epoch milliseconds at open time, for "most recent
    /// first" sorting in `terminal.list`.
    opened_at_ms: i64,
    /// Last-known PTY size, kept in sync with `terminal.resize` so
    /// `terminal.attach` can hint the new client.
    size: Mutex<(u16, u16)>,
    /// Writable side of the PTY master, duped at spawn time so the
    /// reader's `File::drop` doesn't close the fd we still need for
    /// writes.
    stdin: Arc<Mutex<std::fs::File>>,
    /// Shared sink: scrollback + the swappable live notifier.
    sink: Arc<SessionSink>,
    /// Reader thread signal — read loop polls this and breaks when
    /// set. The waiter thread also flips it when the child exits so
    /// the reader doesn't keep spinning post-mortem.
    stop_reader: Arc<AtomicBool>,
    /// Joined on `shutdown()`. Stored so Drop can join too if a
    /// session somehow ends up dropped without an explicit close.
    reader: Option<JoinHandle<()>>,
    /// Owns the `Child` — the waiter thread observes the exit,
    /// fires the Exited event through the notifier, and terminates.
    /// `shutdown()` triggers the exit by SIGTERM/SIGKILL on the pid
    /// rather than reaching for the child directly, so the waiter
    /// retains exclusive ownership of `Child::wait`.
    waiter: Option<JoinHandle<()>>,
    /// Stashed at spawn so `shutdown()` can send signals without
    /// touching the `Child` (which the waiter owns).
    pid_for_signal: libc::pid_t,
}

impl ActiveTerminal {
    /// Spawn the shell on a fresh PTY pair, wire up reader + waiter
    /// threads, and return the per-session bookkeeping. Notifications
    /// flow through `notifier`.
    fn spawn(params: TerminalOpenParams, notifier: Arc<dyn Notifier>) -> Result<Self> {
        let shell = params.shell.clone().unwrap_or_else(default_shell);
        let (master_fd, slave_fd) = open_pty(params.cols, params.rows)?;
        set_nonblocking(master_fd)?;

        // Dup master for stdin writing. Kept alive in the session so
        // writes outlive the reader's `File`.
        let stdin_fd = unsafe { libc::dup(master_fd) };
        if stdin_fd < 0 {
            let err = std::io::Error::last_os_error();
            unsafe {
                libc::close(master_fd);
                libc::close(slave_fd);
            }
            bail!("dup(master_fd) failed: {err}");
        }
        let stdin_file = unsafe { std::fs::File::from_raw_fd(stdin_fd) };
        let stdin = Arc::new(Mutex::new(stdin_file));

        // Dup slaves for stdin/stdout/stderr — Stdio::from_raw_fd
        // takes ownership, so each std handle gets its own dup of
        // the slave.
        let slave_in = unsafe { libc::dup(slave_fd) };
        let slave_out = unsafe { libc::dup(slave_fd) };
        let slave_err = unsafe { libc::dup(slave_fd) };
        if slave_in < 0 || slave_out < 0 || slave_err < 0 {
            let err = std::io::Error::last_os_error();
            unsafe {
                libc::close(master_fd);
                libc::close(slave_fd);
            }
            bail!("dup(slave_fd) failed: {err}");
        }

        let mut cmd = Command::new(&shell);
        cmd.arg("-i")
            .arg("-l")
            .current_dir(&params.workspace_dir)
            .env("TERM", "xterm-256color")
            .env("FORCE_COLOR", "1")
            .env("CLICOLOR_FORCE", "1")
            .env("HISTFILE", "/dev/null")
            .env("SAVEHIST", "0")
            .env("HISTSIZE", "0");
        let child = unsafe {
            cmd.stdin(Stdio::from_raw_fd(slave_in))
                .stdout(Stdio::from_raw_fd(slave_out))
                .stderr(Stdio::from_raw_fd(slave_err))
                .pre_exec(|| {
                    // New session so SIGINT from the controlling tty
                    // (which the server doesn't have) doesn't reach
                    // the child. setsid also makes us a process group
                    // leader so kill -pid sends to the whole tree.
                    if libc::setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                })
                .spawn()
                .with_context(|| format!("failed to spawn {shell}"))?
        };

        // Now that the child is spawned, the parent's copy of the
        // slave fd isn't needed any more. Without closing it the
        // master will never see EIO when the child exits because the
        // slave reference count stays > 0.
        unsafe {
            libc::close(slave_fd);
        }
        drop(cmd);

        let pid = child.id();
        let pid_for_signal = pid as libc::pid_t;

        let sink = SessionSink::new(notifier);
        let stop_reader = Arc::new(AtomicBool::new(false));
        let reader = spawn_reader(
            params.terminal_id.clone(),
            master_fd,
            stop_reader.clone(),
            Arc::clone(&sink),
        );
        let waiter = spawn_waiter(
            params.terminal_id.clone(),
            child,
            stop_reader.clone(),
            Arc::clone(&sink),
        );

        Ok(Self {
            pid,
            workspace_dir: params.workspace_dir.clone(),
            opened_at_ms: chrono::Utc::now().timestamp_millis(),
            size: Mutex::new((params.cols, params.rows)),
            stdin,
            sink,
            stop_reader,
            reader: Some(reader),
            waiter: Some(waiter),
            pid_for_signal,
        })
    }

    /// Stop the reader, kill the child (best-effort), and join both
    /// background threads. Called by `close()` and `Drop`.
    ///
    /// Signals SIGTERM, waits a short grace period, then SIGKILL if
    /// the child is still alive. The waiter thread observes the
    /// exit, emits the Exited event, and terminates — joining the
    /// waiter is what guarantees the event made it through before
    /// `shutdown()` returns.
    fn shutdown(mut self) {
        // Best-effort signal; the waiter does the actual reaping.
        // SIGTERM first so well-behaved shells exit cleanly, then
        // escalate to SIGKILL if the process group ignored it.
        unsafe {
            libc::kill(self.pid_for_signal, libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(200));
        unsafe {
            // SIGKILL on a process that's already exited returns
            // ESRCH; we don't care — the waiter has already cleaned
            // up.
            libc::kill(self.pid_for_signal, libc::SIGKILL);
        }
        // Flip the reader stop flag after the kill so the reader's
        // next poll sees both the closed PTY and the stop request.
        self.stop_reader.store(true, Ordering::Release);
        // Wait for the waiter so the Exited event lands before we
        // return. Then join the reader for the same reason.
        if let Some(w) = self.waiter.take() {
            let _ = w.join();
        }
        if let Some(r) = self.reader.take() {
            let _ = r.join();
        }
    }
}

impl Drop for ActiveTerminal {
    fn drop(&mut self) {
        // Defensive: if `shutdown()` wasn't called, the reader is
        // still running. Flip the stop flag and let the threads
        // detach — joining here would deadlock if we're being
        // dropped from the reader's own thread.
        self.stop_reader.store(true, Ordering::Release);
    }
}

fn spawn_reader(
    terminal_id: String,
    master_fd: RawFd,
    stop: Arc<AtomicBool>,
    sink: Arc<SessionSink>,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name(format!("remote-pty-{terminal_id}"))
        .spawn(move || {
            let mut master = unsafe { std::fs::File::from_raw_fd(master_fd) };
            let mut buf = [0u8; 4096];
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                match master.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Buffer the raw bytes first so reattaching
                        // clients see scrollback even if no notifier
                        // is currently subscribed. Then fire the live
                        // event through whichever notifier is bound
                        // right now.
                        sink.append_stdout(&buf[..n]);
                        let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let event = TerminalEventNotification {
                            terminal_id: terminal_id.clone(),
                            event: TerminalEventKind::Stdout { data },
                        };
                        sink.current_notifier()
                            .notify(TERMINAL_EVENT_METHOD, json!(event));
                    }
                    Err(e) => {
                        if e.kind() == std::io::ErrorKind::WouldBlock {
                            std::thread::sleep(PTY_POLL_INTERVAL);
                            continue;
                        }
                        // EIO is the expected "slave closed" signal —
                        // the waiter will publish the Exited event,
                        // so we just break.
                        if e.raw_os_error() != Some(libc::EIO) {
                            let event = TerminalEventNotification {
                                terminal_id: terminal_id.clone(),
                                event: TerminalEventKind::Error {
                                    message: format!("PTY read failed: {e}"),
                                },
                            };
                            sink.current_notifier()
                                .notify(TERMINAL_EVENT_METHOD, json!(event));
                        }
                        break;
                    }
                }
            }
        })
        .expect("failed to spawn PTY reader thread")
}

fn spawn_waiter(
    terminal_id: String,
    mut child: std::process::Child,
    stop: Arc<AtomicBool>,
    sink: Arc<SessionSink>,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name(format!("remote-pty-waiter-{terminal_id}"))
        .spawn(move || {
            // The waiter owns the Child exclusively. `shutdown()`
            // signals via libc::kill on the pid, so we never need a
            // shared `Option<Child>` — a single blocking `wait()`
            // sees the signal land and surfaces the exit code (None
            // when the process was killed before a clean exit).
            let status = child.wait();
            stop.store(true, Ordering::Release);
            let event = match status {
                Ok(status) => TerminalEventNotification {
                    terminal_id,
                    event: TerminalEventKind::Exited {
                        code: status.code(),
                    },
                },
                Err(e) => TerminalEventNotification {
                    terminal_id,
                    event: TerminalEventKind::Error {
                        message: format!("waitpid failed: {e}"),
                    },
                },
            };
            sink.current_notifier()
                .notify(TERMINAL_EVENT_METHOD, json!(event));
        })
        .expect("failed to spawn PTY waiter thread")
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| DEFAULT_SHELL.to_string())
}

/// Open a PTY pair sized to `cols × rows`. Duplicated from
/// `workspace::scripts::open_pty` so the server side doesn't depend
/// on the desktop's workspace module.
fn open_pty(cols: u16, rows: u16) -> Result<(libc::c_int, libc::c_int)> {
    let mut master: libc::c_int = 0;
    let mut slave: libc::c_int = 0;
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let ret = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &ws as *const libc::winsize as *mut libc::winsize,
        )
    };
    if ret != 0 {
        bail!("openpty failed: {}", std::io::Error::last_os_error());
    }
    Ok((master, slave))
}

fn set_nonblocking(fd: libc::c_int) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 {
        bail!("fcntl(F_GETFL) failed: {}", std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        bail!("fcntl(F_SETFL) failed: {}", std::io::Error::last_os_error());
    }
    Ok(())
}

fn set_winsize(fd: libc::c_int, cols: u16, rows: u16) -> Result<()> {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let ret = unsafe {
        libc::ioctl(
            fd,
            libc::TIOCSWINSZ as libc::c_ulong,
            &ws as *const libc::winsize,
        )
    };
    if ret != 0 {
        bail!("TIOCSWINSZ failed: {}", std::io::Error::last_os_error());
    }
    Ok(())
}

/// Retry a `write` on the (non-blocking) PTY master with a short
/// deadline. Mirrors `workspace::scripts::write_stdin`'s budget.
fn blocking_write_with_retry(stdin: &Arc<Mutex<std::fs::File>>, bytes: &[u8]) -> Result<usize> {
    let mut file = stdin.lock().expect("stdin mutex poisoned");
    let mut written = 0;
    let deadline = std::time::Instant::now() + PTY_WRITE_DEADLINE;
    while written < bytes.len() {
        match file.write(&bytes[written..]) {
            Ok(0) => bail!("PTY master accepted 0 bytes — slave closed"),
            Ok(n) => written += n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    bail!("PTY master stayed full past {PTY_WRITE_DEADLINE:?}");
                }
                std::thread::sleep(PTY_WRITE_RETRY);
            }
            Err(e) => return Err(e).context("PTY master write failed"),
        }
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Shared inbox alias — pinned so the test helper signatures
    /// don't trip the type-complexity lint on nested generics.
    type CapturedNotifications = Arc<StdMutex<Vec<(String, serde_json::Value)>>>;

    /// Capturing notifier: records every notify call into a buffer
    /// the test can drain + assert on.
    struct CapturingNotifier {
        inbox: CapturedNotifications,
    }

    impl CapturingNotifier {
        fn new() -> (Self, CapturedNotifications) {
            let inbox: CapturedNotifications = Arc::new(StdMutex::new(Vec::new()));
            (
                Self {
                    inbox: inbox.clone(),
                },
                inbox,
            )
        }
    }

    impl Notifier for CapturingNotifier {
        fn notify(&self, method: &str, params: serde_json::Value) {
            self.inbox
                .lock()
                .unwrap()
                .push((method.to_string(), params));
        }
    }

    /// Poll the inbox for an event whose `terminal.event` payload
    /// satisfies `pred`. Returns the matched payload on success or
    /// a panicking timeout — tests use this so an eventually-arrives
    /// event doesn't race the assert.
    fn wait_for_event(
        inbox: &CapturedNotifications,
        pred: impl Fn(&TerminalEventNotification) -> bool,
        timeout: Duration,
    ) -> TerminalEventNotification {
        let start = std::time::Instant::now();
        loop {
            {
                let guard = inbox.lock().unwrap();
                for (_method, payload) in guard.iter() {
                    if let Ok(event) =
                        serde_json::from_value::<TerminalEventNotification>(payload.clone())
                    {
                        if pred(&event) {
                            return event;
                        }
                    }
                }
            }
            if start.elapsed() >= timeout {
                let snapshot = inbox.lock().unwrap().clone();
                panic!(
                    "timed out waiting for terminal event after {timeout:?}; \
                     captured events so far: {snapshot:#?}"
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn open_then_close_emits_exited_event_with_kill_code_none() {
        let (notifier, inbox) = CapturingNotifier::new();
        let state = RemoteTerminalState::new();
        let result = state
            .open(
                TerminalOpenParams {
                    terminal_id: "t1".into(),
                    workspace_dir: "/tmp".into(),
                    shell: Some("/bin/sh".into()),
                    cols: 80,
                    rows: 24,
                },
                Arc::new(notifier),
            )
            .expect("open should succeed");
        assert!(result.pid > 0);

        // Close before doing anything else. The waiter should fire
        // an Exited event with `code: None` because the shell was
        // killed by SIGTERM/SIGKILL before exiting on its own.
        state
            .close(TerminalCloseParams {
                terminal_id: "t1".into(),
            })
            .expect("close should succeed");

        let event = wait_for_event(
            &inbox,
            |e| e.terminal_id == "t1" && matches!(&e.event, TerminalEventKind::Exited { .. }),
            Duration::from_secs(2),
        );
        match event.event {
            TerminalEventKind::Exited { code } => {
                // SIGTERM-killed: status.code() returns None on Unix.
                assert!(
                    code.is_none(),
                    "killed-shell exit should report code=None, got {code:?}"
                );
            }
            other => panic!("expected Exited, got {other:?}"),
        }
    }

    #[test]
    fn write_then_close_round_trips_through_stdout_event() {
        let (notifier, inbox) = CapturingNotifier::new();
        let state = RemoteTerminalState::new();
        state
            .open(
                TerminalOpenParams {
                    terminal_id: "t-echo".into(),
                    workspace_dir: "/tmp".into(),
                    shell: Some("/bin/sh".into()),
                    cols: 80,
                    rows: 24,
                },
                Arc::new(notifier),
            )
            .unwrap();

        // Wait for the initial shell prompt to land (proves the
        // reader is delivering bytes) before we feed anything in;
        // a too-eager write would race the shell's init and
        // sometimes get swallowed.
        wait_for_event(
            &inbox,
            |e| matches!(&e.event, TerminalEventKind::Stdout { .. }),
            Duration::from_secs(2),
        );

        let written = state
            .write(TerminalWriteParams {
                terminal_id: "t-echo".into(),
                data: "echo helmor-pty-marker\n".into(),
            })
            .expect("write should succeed");
        assert_eq!(written.bytes_written, "echo helmor-pty-marker\n".len());

        // The shell echoes the input + the program's stdout. Wait
        // until either chunk contains the marker.
        let event = wait_for_event(
            &inbox,
            |e| match &e.event {
                TerminalEventKind::Stdout { data } => data.contains("helmor-pty-marker"),
                _ => false,
            },
            Duration::from_secs(2),
        );
        assert_eq!(event.terminal_id, "t-echo");

        state
            .close(TerminalCloseParams {
                terminal_id: "t-echo".into(),
            })
            .unwrap();
    }

    #[test]
    fn open_rejects_duplicate_terminal_id() {
        let (notifier, _inbox) = CapturingNotifier::new();
        let notifier = Arc::new(notifier);
        let state = RemoteTerminalState::new();
        state
            .open(
                TerminalOpenParams {
                    terminal_id: "dup".into(),
                    workspace_dir: "/tmp".into(),
                    shell: Some("/bin/sh".into()),
                    cols: 80,
                    rows: 24,
                },
                notifier.clone(),
            )
            .unwrap();
        let err = state
            .open(
                TerminalOpenParams {
                    terminal_id: "dup".into(),
                    workspace_dir: "/tmp".into(),
                    shell: Some("/bin/sh".into()),
                    cols: 80,
                    rows: 24,
                },
                notifier,
            )
            .expect_err("duplicate id should error");
        assert!(format!("{err}").contains("already open"));
        state
            .close(TerminalCloseParams {
                terminal_id: "dup".into(),
            })
            .unwrap();
    }

    #[test]
    fn write_to_unknown_terminal_errors_clearly() {
        let state = RemoteTerminalState::new();
        let err = state
            .write(TerminalWriteParams {
                terminal_id: "ghost".into(),
                data: "anything".into(),
            })
            .expect_err("write to unknown terminal should error");
        assert!(format!("{err}").contains("not open"));
    }

    #[test]
    fn resize_an_open_terminal_does_not_error() {
        let (notifier, _inbox) = CapturingNotifier::new();
        let state = RemoteTerminalState::new();
        state
            .open(
                TerminalOpenParams {
                    terminal_id: "r1".into(),
                    workspace_dir: "/tmp".into(),
                    shell: Some("/bin/sh".into()),
                    cols: 80,
                    rows: 24,
                },
                Arc::new(notifier),
            )
            .unwrap();
        state
            .resize(TerminalResizeParams {
                terminal_id: "r1".into(),
                cols: 120,
                rows: 40,
            })
            .expect("resize should succeed");
        state
            .close(TerminalCloseParams {
                terminal_id: "r1".into(),
            })
            .unwrap();
    }

    #[test]
    fn close_unknown_terminal_is_a_noop() {
        let state = RemoteTerminalState::new();
        // No open call. Close should be idempotent, not bail.
        state
            .close(TerminalCloseParams {
                terminal_id: "never-opened".into(),
            })
            .expect("close on unknown should be ok");
    }

    #[test]
    fn open_with_empty_terminal_id_rejects() {
        let (notifier, _inbox) = CapturingNotifier::new();
        let state = RemoteTerminalState::new();
        let err = state
            .open(
                TerminalOpenParams {
                    terminal_id: "".into(),
                    workspace_dir: "/tmp".into(),
                    shell: Some("/bin/sh".into()),
                    cols: 80,
                    rows: 24,
                },
                Arc::new(notifier),
            )
            .expect_err("empty terminal id should reject");
        assert!(format!("{err}").contains("must not be empty"));
    }

    // ── terminal.list ─────────────────────────────────────────────

    #[test]
    fn list_reports_open_sessions_with_metadata_most_recent_first() {
        let (notifier, _inbox) = CapturingNotifier::new();
        let notifier = Arc::new(notifier);
        let state = RemoteTerminalState::new();

        state
            .open(
                TerminalOpenParams {
                    terminal_id: "older".into(),
                    workspace_dir: "/tmp".into(),
                    shell: Some("/bin/sh".into()),
                    cols: 100,
                    rows: 30,
                },
                notifier.clone(),
            )
            .unwrap();
        // Sleep so the second open is reliably later — opened_at_ms
        // is millisecond resolution, the back-to-back calls otherwise
        // can land in the same millisecond on fast machines.
        std::thread::sleep(Duration::from_millis(5));
        state
            .open(
                TerminalOpenParams {
                    terminal_id: "newer".into(),
                    workspace_dir: "/tmp".into(),
                    shell: Some("/bin/sh".into()),
                    cols: 120,
                    rows: 40,
                },
                notifier.clone(),
            )
            .unwrap();

        let result = state.list();
        assert_eq!(result.terminals.len(), 2);
        assert_eq!(result.terminals[0].terminal_id, "newer");
        assert_eq!(result.terminals[1].terminal_id, "older");
        // Per-row metadata is the snapshot the UI displays.
        assert_eq!(result.terminals[0].workspace_dir, "/tmp");
        assert_eq!(result.terminals[0].cols, 120);
        assert_eq!(result.terminals[0].rows, 40);
        assert!(result.terminals[0].opened_at_ms >= result.terminals[1].opened_at_ms);

        // Cleanup — the Drop impl detaches threads but doesn't kill;
        // closing explicitly returns the PTYs.
        state
            .close(TerminalCloseParams {
                terminal_id: "older".into(),
            })
            .unwrap();
        state
            .close(TerminalCloseParams {
                terminal_id: "newer".into(),
            })
            .unwrap();
    }

    #[test]
    fn list_on_an_empty_state_returns_empty_terminals_array() {
        let state = RemoteTerminalState::new();
        let result = state.list();
        assert!(result.terminals.is_empty());
    }

    // ── terminal.attach ───────────────────────────────────────────

    #[test]
    fn attach_to_a_running_terminal_swaps_notifier_and_returns_scrollback() {
        // Open with notifier A, write something so scrollback fills,
        // attach with notifier B, verify:
        //  1. attach result includes the captured scrollback
        //  2. subsequent stdout fires through B, not A.
        let (notifier_a, inbox_a) = CapturingNotifier::new();
        let state = RemoteTerminalState::new();
        state
            .open(
                TerminalOpenParams {
                    terminal_id: "swap".into(),
                    workspace_dir: "/tmp".into(),
                    shell: Some("/bin/sh".into()),
                    cols: 80,
                    rows: 24,
                },
                Arc::new(notifier_a),
            )
            .unwrap();

        // Wait for the initial prompt so we know at least one chunk
        // landed in scrollback before we attach.
        wait_for_event(
            &inbox_a,
            |e| matches!(&e.event, TerminalEventKind::Stdout { .. }),
            Duration::from_secs(2),
        );

        let initial_a_count = inbox_a.lock().unwrap().len();
        let (notifier_b, inbox_b) = CapturingNotifier::new();
        let result = state
            .attach(
                TerminalAttachParams {
                    terminal_id: "swap".into(),
                },
                Arc::new(notifier_b),
            )
            .expect("attach should succeed");
        assert!(
            !result.scrollback.is_empty(),
            "attach should hand back the captured scrollback"
        );
        assert_eq!(result.cols, 80);
        assert_eq!(result.rows, 24);

        // Drive new output so the next stdout chunk lands on B.
        state
            .write(TerminalWriteParams {
                terminal_id: "swap".into(),
                data: "echo helmor-attach-marker\n".into(),
            })
            .unwrap();
        wait_for_event(
            &inbox_b,
            |e| match &e.event {
                TerminalEventKind::Stdout { data } => data.contains("helmor-attach-marker"),
                _ => false,
            },
            Duration::from_secs(2),
        );

        // A should not have received the post-attach marker.
        let a_after = inbox_a.lock().unwrap();
        let a_saw_marker = a_after.iter().any(|(_, payload)| {
            payload
                .get("event")
                .and_then(|e| e.get("data"))
                .and_then(|d| d.as_str())
                .is_some_and(|s| s.contains("helmor-attach-marker"))
        });
        assert!(
            !a_saw_marker,
            "notifier A should not see events after attach swapped to B; \
             A's inbox grew from {initial_a_count} to {} entries",
            a_after.len()
        );

        drop(a_after);
        state
            .close(TerminalCloseParams {
                terminal_id: "swap".into(),
            })
            .unwrap();
    }

    #[test]
    fn attach_to_unknown_terminal_returns_a_clear_error() {
        let (notifier, _inbox) = CapturingNotifier::new();
        let state = RemoteTerminalState::new();
        let err = state
            .attach(
                TerminalAttachParams {
                    terminal_id: "ghost".into(),
                },
                Arc::new(notifier),
            )
            .expect_err("attach to unknown id should error");
        assert!(format!("{err}").contains("not open"));
    }

    // ── ScrollbackBuffer ──────────────────────────────────────────

    #[test]
    fn scrollback_buffer_trims_old_bytes_when_cap_exceeded() {
        let mut buf = ScrollbackBuffer::new();
        // Fill exactly to the cap.
        buf.push(&vec![b'A'; SCROLLBACK_BYTES]);
        assert_eq!(buf.bytes.len(), SCROLLBACK_BYTES);
        // One more byte triggers a 1-byte drain from the front.
        buf.push(b"Z");
        assert_eq!(buf.bytes.len(), SCROLLBACK_BYTES);
        // Last byte should be the newcomer.
        assert_eq!(*buf.bytes.last().unwrap(), b'Z');
    }

    #[test]
    fn scrollback_buffer_handles_a_single_chunk_larger_than_the_cap() {
        let mut buf = ScrollbackBuffer::new();
        let oversized = vec![b'X'; SCROLLBACK_BYTES + 1024];
        buf.push(&oversized);
        assert_eq!(buf.bytes.len(), SCROLLBACK_BYTES);
        // The tail of the oversized chunk is what's preserved.
        assert!(buf.bytes.iter().all(|&b| b == b'X'));
    }

    #[test]
    fn scrollback_snapshot_renders_lossy_utf8() {
        let mut buf = ScrollbackBuffer::new();
        // Invalid UTF-8 byte sequence sandwiched in valid text.
        buf.push(&[0x68, 0x69, 0xFF, 0x6F]); // "hi\xFFo"
        let snap = buf.snapshot();
        // Lossy conversion preserves length-shape but replaces the
        // bad byte with U+FFFD.
        assert!(snap.contains('\u{FFFD}'));
        assert!(snap.starts_with("hi"));
        assert!(snap.ends_with('o'));
    }
}
