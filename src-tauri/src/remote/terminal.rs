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
    TerminalCloseParams, TerminalCloseResult, TerminalEventKind, TerminalEventNotification,
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
        let stdin = self.stdin_for(&params.terminal_id)?;
        let file = stdin.lock().expect("stdin mutex poisoned");
        set_winsize(file.as_raw_fd(), params.cols, params.rows)?;
        Ok(TerminalResizeResult {})
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

/// Per-session bookkeeping. The reader + waiter threads keep going
/// until the PTY hits EOF (slave closes) or the `stop_reader` flag
/// flips on `close()`. The reader thread owns the only
/// `File`-from-master-fd to keep the fd alive while we're reading.
struct ActiveTerminal {
    pid: u32,
    /// Writable side of the PTY master, duped at spawn time so the
    /// reader's `File::drop` doesn't close the fd we still need for
    /// writes.
    stdin: Arc<Mutex<std::fs::File>>,
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

        let stop_reader = Arc::new(AtomicBool::new(false));
        let reader = spawn_reader(
            params.terminal_id.clone(),
            master_fd,
            stop_reader.clone(),
            notifier.clone(),
        );
        let waiter = spawn_waiter(
            params.terminal_id.clone(),
            child,
            stop_reader.clone(),
            notifier,
        );

        Ok(Self {
            pid,
            stdin,
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
    notifier: Arc<dyn Notifier>,
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
                        let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let event = TerminalEventNotification {
                            terminal_id: terminal_id.clone(),
                            event: TerminalEventKind::Stdout { data },
                        };
                        notifier.notify(TERMINAL_EVENT_METHOD, json!(event));
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
                            notifier.notify(TERMINAL_EVENT_METHOD, json!(event));
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
    notifier: Arc<dyn Notifier>,
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
            notifier.notify(TERMINAL_EVENT_METHOD, json!(event));
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
}
