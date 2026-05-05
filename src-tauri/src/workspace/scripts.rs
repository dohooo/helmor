use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::io::FromRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScriptEvent {
    Started { pid: u32, command: String },
    Stdout { data: String },
    Stderr { data: String },
    Exited { code: Option<i32> },
    Error { message: String },
}

/// Key = (repo_id, script_type, workspace_id)
type ProcessKey = (String, String, Option<String>);

const PROCESS_TERM_TIMEOUT: Duration = Duration::from_millis(200);
const PROCESS_KILL_TIMEOUT: Duration = Duration::from_millis(500);
const PTY_POLL_INTERVAL: Duration = Duration::from_millis(25);
const PTY_WRITE_RETRY: Duration = Duration::from_millis(5);
const PTY_WRITE_DEADLINE: Duration = Duration::from_millis(500);

/// Metadata we track per live script so Stop, stdin, and resize can reach it
/// without owning the `Child`. The owner of the `Child` is `run_script`, which
/// blocks on `child.wait()` *without holding any lock* — that's the whole
/// point of this split. `kill()` only signals; reaping stays with `run_script`.
#[derive(Clone)]
struct ProcessHandle {
    pid: libc::pid_t,
    pgid: libc::pid_t,
    /// Shared with `run_script`'s local handle; set by `kill()` or by a
    /// concurrent `register()` that replaces us. `run_script` reads this
    /// after wait() to decide whether to report a real exit code or None.
    killed: Arc<AtomicBool>,
    /// Writable side of the PTY master. `Mutex` because `File::write` takes
    /// `&mut self`; actual contention is negligible (one writer per keypress
    /// burst). Keeping this alive is what makes Ctrl+C and typing work —
    /// without it, the PTY master would close right after the initial command.
    stdin: Arc<Mutex<std::fs::File>>,
}

#[derive(Clone, Default)]
pub struct ScriptProcessManager {
    processes: Arc<Mutex<HashMap<ProcessKey, ProcessHandle>>>,
}

impl ScriptProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Publish a newly-spawned process so `kill`, `write_stdin`, and `resize`
    /// can find it. If a handle for this key already exists (user clicked
    /// Run again while the previous run was alive), we mark the old one as
    /// killed and signal it — its own `run_script` will reap.
    fn register(
        &self,
        key: ProcessKey,
        pid: libc::pid_t,
        pgid: libc::pid_t,
        stdin: Arc<Mutex<std::fs::File>>,
    ) -> Arc<AtomicBool> {
        let killed = Arc::new(AtomicBool::new(false));
        let handle = ProcessHandle {
            pid,
            pgid,
            killed: killed.clone(),
            stdin,
        };
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(old) = map.insert(key, handle) {
            old.killed.store(true, Ordering::Release);
            escalating_kill(old.pid, old.pgid);
        }
        killed
    }

    /// Remove our handle from the map once `child.wait()` has returned.
    /// No-op if we were already replaced by a rerun.
    fn unregister(&self, key: &ProcessKey, pid: libc::pid_t) {
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(h) = map.get(key) {
            if h.pid == pid {
                map.remove(key);
            }
        }
    }

    /// Signal every live script that matches `repo_id` and `script_type`
    /// except the one whose workspace_id equals `keep_workspace_id`. Used
    /// by the non-concurrent run mode to make a fresh run stop any other
    /// run in the same repo before spawning. Returns the number of handles
    /// that were signaled.
    pub fn kill_others_in_repo(
        &self,
        repo_id: &str,
        script_type: &str,
        keep_workspace_id: Option<&str>,
    ) -> usize {
        let victims: Vec<ProcessHandle> = {
            let map = self.processes.lock().expect("process map poisoned");
            map.iter()
                .filter(|(k, _)| {
                    k.0 == repo_id && k.1 == script_type && k.2.as_deref() != keep_workspace_id
                })
                .map(|(_, h)| h.clone())
                .collect()
        };
        let count = victims.len();
        for h in victims {
            h.killed.store(true, Ordering::Release);
            escalating_kill(h.pid, h.pgid);
        }
        count
    }

    /// Signal the process group (and leader as a fallback) with SIGTERM,
    /// escalating to SIGKILL after `PROCESS_TERM_TIMEOUT`. Returns true if
    /// there was a live handle to signal.
    ///
    /// Does **not** reap — `run_script`'s `child.wait()` still owns that.
    pub fn kill(&self, key: &ProcessKey) -> bool {
        let handle = {
            let map = self.processes.lock().expect("process map poisoned");
            map.get(key).cloned()
        };
        match handle {
            Some(h) => {
                h.killed.store(true, Ordering::Release);
                escalating_kill(h.pid, h.pgid);
                true
            }
            None => false,
        }
    }

    /// Write bytes into the PTY master (user typing, paste, Ctrl+C).
    /// Returns `Ok(false)` if no live script matches the key — callers
    /// treat that as a silent no-op (the user typed into a dead terminal).
    pub fn write_stdin(&self, key: &ProcessKey, data: &[u8]) -> Result<bool> {
        let stdin = {
            let map = self.processes.lock().expect("process map poisoned");
            map.get(key).map(|h| h.stdin.clone())
        };
        let Some(stdin) = stdin else {
            return Ok(false);
        };

        let mut file = stdin.lock().expect("stdin mutex poisoned");
        let deadline = Instant::now() + PTY_WRITE_DEADLINE;
        let mut remaining = data;
        while !remaining.is_empty() {
            match file.write(remaining) {
                Ok(0) => bail!("PTY master write returned 0"),
                Ok(n) => remaining = &remaining[n..],
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        bail!("PTY master write timed out");
                    }
                    std::thread::sleep(PTY_WRITE_RETRY);
                }
                Err(e) => return Err(e).context("PTY master write failed"),
            }
        }
        Ok(true)
    }

    /// Tell the PTY about a new terminal size via `TIOCSWINSZ`. The kernel
    /// delivers SIGWINCH to the foreground process group, so vim/htop/less
    /// re-layout to match the UI.
    pub fn resize(&self, key: &ProcessKey, cols: u16, rows: u16) -> Result<bool> {
        let stdin = {
            let map = self.processes.lock().expect("process map poisoned");
            map.get(key).map(|h| h.stdin.clone())
        };
        let Some(stdin) = stdin else {
            return Ok(false);
        };
        let file = stdin.lock().expect("stdin mutex poisoned");
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let ret = unsafe {
            libc::ioctl(
                file.as_raw_fd(),
                libc::TIOCSWINSZ as libc::c_ulong,
                &ws as *const libc::winsize,
            )
        };
        if ret != 0 {
            bail!("TIOCSWINSZ failed: {}", std::io::Error::last_os_error());
        }
        Ok(true)
    }
}

/// Send SIGTERM (and SIGKILL after a short grace period) to a process group
/// and its leader. Polls `kill(pid, 0)` to detect when the process has been
/// reaped by its parent — which is `run_script`'s `child.wait()` running on
/// a separate thread. Zombies still report alive, so this effectively waits
/// for the reap, which happens microseconds after the child actually dies.
fn escalating_kill(pid: libc::pid_t, pgid: libc::pid_t) {
    let current_pgrp = unsafe { libc::getpgrp() };
    let can_signal_group = pgid > 0 && pgid != current_pgrp;

    unsafe {
        if can_signal_group {
            libc::killpg(pgid, libc::SIGTERM);
        }
        libc::kill(pid, libc::SIGTERM);
    }

    if wait_for_pid_gone(pid, PROCESS_TERM_TIMEOUT) {
        return;
    }

    unsafe {
        if can_signal_group {
            libc::killpg(pgid, libc::SIGKILL);
        }
        libc::kill(pid, libc::SIGKILL);
    }

    let _ = wait_for_pid_gone(pid, PROCESS_KILL_TIMEOUT);
}

/// Poll `kill(pid, 0)` until it returns ESRCH or the deadline passes.
/// ESRCH means the pid is gone AND has been reaped — zombies still return 0.
fn wait_for_pid_gone(pid: libc::pid_t, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let ret = unsafe { libc::kill(pid, 0) };
        if ret == -1 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ESRCH) {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(PTY_POLL_INTERVAL);
    }
}

/// Workspace context passed to scripts as environment variables.
#[derive(Clone)]
pub struct ScriptContext {
    pub root_path: String,
    pub workspace_path: Option<String>,
    pub workspace_name: Option<String>,
    pub default_branch: Option<String>,
}

/// Allocate a PTY pair via `openpty`. Returns (master_fd, slave_fd).
fn open_pty() -> Result<(libc::c_int, libc::c_int)> {
    let mut master: libc::c_int = 0;
    let mut slave: libc::c_int = 0;
    let ws = libc::winsize {
        ws_row: 30,
        ws_col: 120,
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

/// Escape a string for safe embedding inside single quotes.
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Spawn an interactive login shell on a PTY and feed it `script`.
///
/// After the initial command is sent, the PTY stays open so the user can
/// send additional input (arrow keys, Ctrl+C, responses to prompts) through
/// `ScriptProcessManager::write_stdin`. The wrapped command's final `exit`
/// is what ends the session on normal completion.
#[allow(clippy::too_many_arguments)]
pub fn run_script(
    manager: &ScriptProcessManager,
    repo_id: &str,
    script_type: &str,
    workspace_id: Option<&str>,
    script: &str,
    working_dir: &str,
    context: &ScriptContext,
    channel: Channel<ScriptEvent>,
) -> Result<Option<i32>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    run_script_with_shell(
        manager,
        repo_id,
        script_type,
        workspace_id,
        Some(script),
        working_dir,
        context,
        channel,
        &shell,
        &["-i", "-l"],
        None,
    )
}

/// Spawn a blank interactive login shell on a PTY without feeding any script.
///
/// Two callers today:
/// - The Inspector Terminal tab — user gets a `$SHELL` prompt at `working_dir`
///   and types commands directly; the PTY stays open until the user types
///   `exit` (or the caller invokes `kill` via `stop_terminal`).
/// - Onboarding embedded auth terminals (`gh auth login`, `glab auth login`,
///   `claude /login`, `codex login`) — the caller drives input programmatically
///   via `ScriptProcessManager::write_stdin`.
///
/// In both cases the PTY persists across multiple `write_stdin` calls.
#[allow(clippy::too_many_arguments)]
pub fn run_terminal_session(
    manager: &ScriptProcessManager,
    repo_id: &str,
    script_type: &str,
    workspace_id: Option<&str>,
    working_dir: &str,
    context: &ScriptContext,
    channel: Channel<ScriptEvent>,
    boot_input: Option<&str>,
) -> Result<Option<i32>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    run_script_with_shell(
        manager,
        repo_id,
        script_type,
        workspace_id,
        None,
        working_dir,
        context,
        channel,
        &shell,
        &["-i", "-l"],
        boot_input,
    )
}

/// Internal implementation of [`run_script`] that takes the shell path and
/// args explicitly. Exposed within the crate so tests can substitute a lean
/// `/bin/sh` for the user's (potentially slow) interactive `$SHELL`.
///
/// When `script` is `Some`, the shell is fed the wrapped command and exits
/// once the command completes. When `script` is `None`, the shell starts
/// blank — used by the Terminal tab (user types commands directly) and by
/// the onboarding embedded auth terminals (caller drives input via
/// `write_stdin` or via `boot_input`).
///
/// `boot_input` is written to the PTY master right after the shell is
/// spawned and registered. Use it to seed an interactive shell with an
/// initial command (e.g. `gh auth login\n`) without racing against
/// `write_stdin`'s "process not yet registered" polling.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_script_with_shell(
    manager: &ScriptProcessManager,
    repo_id: &str,
    script_type: &str,
    workspace_id: Option<&str>,
    script: Option<&str>,
    working_dir: &str,
    context: &ScriptContext,
    channel: Channel<ScriptEvent>,
    shell_path: &str,
    shell_args: &[&str],
    boot_input: Option<&str>,
) -> Result<Option<i32>> {
    if let Some(s) = script {
        if s.trim().is_empty() {
            bail!("Script is empty");
        }
    }

    let (master_fd, slave_fd) = open_pty()?;
    set_nonblocking(master_fd)?;

    // Dup master for stdin writing. Kept alive in `ProcessHandle` for the
    // lifetime of the child so `write_stdin` / `resize` can reach the PTY.
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

    // Dup slave for the pre_exec closure (Stdio::from_raw_fd takes ownership).
    let slave_for_session = unsafe { libc::dup(slave_fd) };

    let mut cmd = Command::new(shell_path);
    cmd.args(shell_args)
        .current_dir(working_dir)
        .env("TERM", "xterm-256color")
        .env("FORCE_COLOR", "1")
        .env("CLICOLOR_FORCE", "1")
        // Prevent history pollution from the interactive shell.
        .env("HISTFILE", "/dev/null")
        .env("SAVEHIST", "0")
        .env("HISTSIZE", "0")
        .env("HELMOR_ROOT_PATH", &context.root_path);

    if let Some(wp) = &context.workspace_path {
        cmd.env("HELMOR_WORKSPACE_PATH", wp);
    }
    if let Some(wn) = &context.workspace_name {
        cmd.env("HELMOR_WORKSPACE_NAME", wn);
    }
    if let Some(db) = &context.default_branch {
        cmd.env("HELMOR_DEFAULT_BRANCH", db);
    }

    // Set up the child's session and controlling terminal before exec.
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(slave_for_session, libc::TIOCSCTTY as libc::c_ulong, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(slave_for_session);
            Ok(())
        });
    }

    // Attach PTY slave as stdin/stdout/stderr.
    let mut child = unsafe {
        cmd.stdin(Stdio::from_raw_fd(slave_fd))
            .stdout(Stdio::from_raw_fd(libc::dup(slave_fd)))
            .stderr(Stdio::from_raw_fd(libc::dup(slave_fd)))
            .spawn()
            .with_context(|| format!("Failed to spawn {shell_path}"))?
    };

    // Drop cmd to close all parent copies of slave fds. Without this the
    // master never sees EIO because the slave reference count stays > 0.
    drop(cmd);

    let pid = child.id() as libc::pid_t;
    let pgid = unsafe { libc::getpgid(pid) };

    let _ = channel.send(ScriptEvent::Started {
        pid: pid as u32,
        command: script.map(str::to_string).unwrap_or_else(|| {
            // Terminal mode: no command was fed; report the shell invocation
            // so frontends can show a stable label in the Started event.
            format!("{shell_path} {}", shell_args.join(" "))
        }),
    });

    let key: ProcessKey = (
        repo_id.to_string(),
        script_type.to_string(),
        workspace_id.map(str::to_string),
    );
    let killed = manager.register(key.clone(), pid, pgid, stdin.clone());

    // Single reader on the PTY master — stdout+stderr are merged by the PTY.
    let ch = channel.clone();
    let stop_reader = Arc::new(AtomicBool::new(false));
    let stop_reader_in_thread = stop_reader.clone();
    let reader = std::thread::Builder::new()
        .name("script-pty".into())
        .spawn(move || {
            let mut master = unsafe { std::fs::File::from_raw_fd(master_fd) };
            let mut buf = [0u8; 4096];
            loop {
                if stop_reader_in_thread.load(Ordering::Relaxed) {
                    break;
                }

                match master.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let _ = ch.send(ScriptEvent::Stdout { data });
                    }
                    Err(e) => {
                        // master_fd is non-blocking, so an idle PTY (Terminal
                        // tab waiting for keystrokes) returns EAGAIN every
                        // poll. Sleep + continue without logging — otherwise
                        // the debug log floods at PTY_POLL_INTERVAL frequency.
                        if e.kind() == std::io::ErrorKind::WouldBlock {
                            std::thread::sleep(PTY_POLL_INTERVAL);
                            continue;
                        }
                        // EIO is expected when the child exits and slave closes.
                        if e.raw_os_error() != Some(libc::EIO) {
                            tracing::debug!(error = %e, "PTY read error");
                        }
                        break;
                    }
                }
            }
        })
        .ok();

    // Feed the wrapped command to the shell's stdin via the PTY master.
    // The interactive shell will show its prompt, echo the command, execute
    // it, print a completion message, then exit. The PTY stays open the
    // entire time so Ctrl+C / typing reaches whatever the shell is running.
    //
    // Skipped when `script == None` (Terminal tab / onboarding auth terminals):
    // the shell stays at its prompt and waits for input — the user typing
    // directly in the Terminal tab, or `boot_input` seeding it below.
    if let Some(script) = script {
        let wrapped = format!(
            "eval {}; __helmor_ec=$?; printf '\\r\\n\\033[2m[Completed with exit code %d]\\033[0m\\r\\n' $__helmor_ec; exit $__helmor_ec\n",
            shell_escape(script),
        );
        let mut file = stdin.lock().expect("stdin mutex poisoned");
        if let Err(e) = file.write_all(wrapped.as_bytes()) {
            tracing::warn!(error = %e, "initial PTY write failed");
        }
    } else if let Some(input) = boot_input {
        // Bytes go into the PTY master here — synchronously, while we
        // still own the only handle. The shell will read them once its
        // init completes. Doing this inline (instead of via a spawned
        // polling thread that calls `write_stdin`) means a
        // re-render-driven cleanup → respawn cycle on the frontend can't
        // race ahead and drop the bytes.
        let mut file = stdin.lock().expect("stdin mutex poisoned");
        if let Err(e) = file.write_all(input.as_bytes()) {
            tracing::warn!(error = %e, "boot_input PTY write failed");
        }
    }

    // Wait for the child WITHOUT holding any lock. This is the core of the
    // new design: Stop / write_stdin / resize can all grab the manager's
    // lock at any time because we're not holding it here.
    let status = child.wait().ok();

    manager.unregister(&key, pid);

    stop_reader.store(true, Ordering::Release);
    if let Some(h) = reader {
        let _ = h.join();
    }

    let exit_code = if killed.load(Ordering::Acquire) {
        None
    } else {
        status.and_then(|s| s.code())
    };

    let _ = channel.send(ScriptEvent::Exited { code: exit_code });
    Ok(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Command as StdCommand;
    use std::sync::mpsc;
    use tempfile::NamedTempFile;

    // ── shell_escape ───────────────────────────────────────────────────────

    #[test]
    fn shell_escape_plain() {
        assert_eq!(shell_escape("echo hello"), "'echo hello'");
    }

    #[test]
    fn shell_escape_single_quotes() {
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
    }

    // ── Test helpers ───────────────────────────────────────────────────────

    /// Spawn `/bin/sleep 60` in its own session so `killpg` works, and
    /// register it with the manager using a dummy stdin (`/dev/null`).
    /// Returns (child, pid, pgid) — caller must eventually reap the child.
    fn spawn_and_register(
        mgr: &ScriptProcessManager,
        key: ProcessKey,
    ) -> (
        std::process::Child,
        libc::pid_t,
        libc::pid_t,
        Arc<AtomicBool>,
    ) {
        let child = unsafe {
            StdCommand::new("/bin/sleep")
                .arg("60")
                .pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                })
                .spawn()
                .expect("spawn sleep")
        };
        let pid = child.id() as libc::pid_t;
        let pgid = unsafe { libc::getpgid(pid) };
        let stdin = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/null")
            .expect("open /dev/null");
        let stdin_arc = Arc::new(Mutex::new(stdin));
        let killed = mgr.register(key, pid, pgid, stdin_arc);
        (child, pid, pgid, killed)
    }

    // ── ProcessKey workspace isolation ─────────────────────────────────────

    #[test]
    fn register_with_different_workspace_ids_are_independent() {
        let mgr = ScriptProcessManager::new();
        let key_a: ProcessKey = ("repo".into(), "setup".into(), Some("ws-a".into()));
        let key_b: ProcessKey = ("repo".into(), "setup".into(), Some("ws-b".into()));

        let (mut child_a, _, _, _) = spawn_and_register(&mgr, key_a.clone());
        let (mut child_b, pid_b, _, _) = spawn_and_register(&mgr, key_b.clone());

        // Killing ws-a should NOT touch ws-b.
        assert!(mgr.kill(&key_a));
        let _ = child_a.wait();

        // ws-b is still registered and still alive.
        let still_registered = {
            let map = mgr.processes.lock().unwrap();
            map.contains_key(&key_b)
        };
        assert!(still_registered);
        assert_eq!(unsafe { libc::kill(pid_b, 0) }, 0, "ws-b should be alive");

        // Cleanup.
        mgr.kill(&key_b);
        let _ = child_b.wait();
    }

    #[test]
    fn register_same_key_signals_previous() {
        let mgr = ScriptProcessManager::new();
        let key: ProcessKey = ("repo".into(), "setup".into(), Some("ws".into()));

        let (mut child1, pid1, _, killed1) = spawn_and_register(&mgr, key.clone());
        let (mut child2, pid2, _, _) = spawn_and_register(&mgr, key.clone());

        // First child should have been signaled and its flag set.
        let status1 = child1.wait().expect("reap child1");
        assert!(!status1.success(), "child1 should have been terminated");
        assert!(killed1.load(Ordering::Acquire), "killed flag set");

        // Map now holds only child2.
        let map = mgr.processes.lock().unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map[&key].pid, pid2);
        assert_ne!(pid1, pid2);
        drop(map);

        // Cleanup.
        mgr.kill(&key);
        let _ = child2.wait();
    }

    // ── kill_others_in_repo (non-concurrent run mode) ──────────────────────

    #[test]
    fn kill_others_in_repo_signals_matching_run_scripts_only() {
        let mgr = ScriptProcessManager::new();
        // Three live "run" scripts in repo A, plus one "setup" in A and
        // one "run" in repo B. Non-concurrent kill should hit only the
        // two other "run" scripts in A.
        let a_run_keep: ProcessKey = ("A".into(), "run".into(), Some("ws-keep".into()));
        let a_run_other1: ProcessKey = ("A".into(), "run".into(), Some("ws-other-1".into()));
        let a_run_other2: ProcessKey = ("A".into(), "run".into(), Some("ws-other-2".into()));
        let a_setup: ProcessKey = ("A".into(), "setup".into(), Some("ws-keep".into()));
        let b_run: ProcessKey = ("B".into(), "run".into(), Some("ws-keep".into()));

        let (mut keep_child, _, _, keep_killed) = spawn_and_register(&mgr, a_run_keep.clone());
        let (mut other1_child, _, _, other1_killed) =
            spawn_and_register(&mgr, a_run_other1.clone());
        let (mut other2_child, _, _, other2_killed) =
            spawn_and_register(&mgr, a_run_other2.clone());
        let (mut setup_child, _, _, setup_killed) = spawn_and_register(&mgr, a_setup.clone());
        let (mut b_run_child, _, _, b_run_killed) = spawn_and_register(&mgr, b_run.clone());

        let signaled = mgr.kill_others_in_repo("A", "run", Some("ws-keep"));
        assert_eq!(signaled, 2);

        // Reap the two victims to release pid resources.
        let _ = other1_child.wait();
        let _ = other2_child.wait();
        assert!(other1_killed.load(Ordering::Acquire));
        assert!(other2_killed.load(Ordering::Acquire));

        // The kept run, the setup script, and the other repo's run are all
        // still untouched.
        assert!(!keep_killed.load(Ordering::Acquire));
        assert!(!setup_killed.load(Ordering::Acquire));
        assert!(!b_run_killed.load(Ordering::Acquire));

        mgr.kill(&a_run_keep);
        mgr.kill(&a_setup);
        mgr.kill(&b_run);
        let _ = keep_child.wait();
        let _ = setup_child.wait();
        let _ = b_run_child.wait();
    }

    #[test]
    fn kill_others_in_repo_with_no_matches_is_noop() {
        let mgr = ScriptProcessManager::new();
        assert_eq!(mgr.kill_others_in_repo("nope", "run", None), 0);
    }

    // ── escalating_kill kills the process group ────────────────────────────

    #[test]
    fn escalating_kill_terminates_child_tree() {
        let pid_file = NamedTempFile::new().unwrap();
        let pid_path = pid_file.path().display().to_string();

        // Spawn a shell that starts a background sleep, then waits.
        let mut child = unsafe {
            StdCommand::new("/bin/sh")
                .args([
                    "-c",
                    &format!("/bin/sleep 120 & echo $! > {pid_path}; wait"),
                ])
                .pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                })
                .spawn()
                .unwrap()
        };
        let pid = child.id() as libc::pid_t;
        let pgid = unsafe { libc::getpgid(pid) };

        let deadline = Instant::now() + Duration::from_secs(1);
        let background_pid = loop {
            if let Ok(contents) = std::fs::read_to_string(pid_file.path()) {
                if let Ok(pid) = contents.trim().parse::<libc::pid_t>() {
                    break pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "background child pid file was never written"
            );
            std::thread::sleep(Duration::from_millis(10));
        };

        // Kick off escalating_kill in a helper thread so the parent can
        // continue to reap in this thread (escalating_kill waits for the
        // reap to happen).
        let reaper = std::thread::spawn(move || child.wait().unwrap());
        escalating_kill(pid, pgid);

        let status = reaper.join().unwrap();
        assert!(!status.success());

        let alive = unsafe { libc::kill(pid, 0) };
        assert_eq!(alive, -1, "leader should be reaped");
        let background_alive = unsafe { libc::kill(background_pid, 0) };
        assert_eq!(
            background_alive, -1,
            "background child should be dead after escalating_kill"
        );
    }

    // ── kill() against a live run_script actually stops it ─────────────────

    #[test]
    fn kill_terminates_running_script_quickly() {
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
        };
        let key: ProcessKey = ("repo".into(), "run".into(), Some("ws".into()));

        let mgr_c = mgr.clone();
        let key_c = key.clone();
        let tempdir = std::env::temp_dir().display().to_string();
        let start = Instant::now();
        let handle = std::thread::spawn(move || {
            run_script_with_shell(
                &mgr_c,
                &key_c.0,
                &key_c.1,
                key_c.2.as_deref(),
                Some("sleep 60"),
                &tempdir,
                &ctx,
                make_channel(),
                "/bin/sh",
                &[],
                None,
            )
        });

        // Wait until run_script has registered (polling is fine here — the
        // test is checking Stop latency, not register latency).
        let register_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let exists = mgr.processes.lock().unwrap().contains_key(&key);
            if exists {
                break;
            }
            assert!(
                Instant::now() < register_deadline,
                "run_script never registered"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        assert!(mgr.kill(&key), "kill should find the handle");
        let result = handle.join().unwrap();
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "Stop took too long: {:?}",
            start.elapsed()
        );
        assert_eq!(result.unwrap(), None, "killed scripts report None exit");

        // Map should be empty after run_script cleans up.
        let map = mgr.processes.lock().unwrap();
        assert!(!map.contains_key(&key));
    }

    // ── write_stdin echo round-trip ────────────────────────────────────────

    #[test]
    fn write_stdin_delivers_bytes_to_running_script() {
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
        };
        let key: ProcessKey = ("repo".into(), "run".into(), Some("ws".into()));

        // Channel collecting stdout events.
        let (tx, rx) = mpsc::channel::<String>();
        let ch = Channel::<ScriptEvent>::new(move |msg| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = msg {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("stdout") {
                        if let Some(data) = v.get("data").and_then(|d| d.as_str()) {
                            let _ = tx.send(data.to_string());
                        }
                    }
                }
            }
            Ok(())
        });

        let mgr_c = mgr.clone();
        let key_c = key.clone();
        let tempdir = std::env::temp_dir().display().to_string();
        let handle = std::thread::spawn(move || {
            run_script_with_shell(
                &mgr_c,
                &key_c.0,
                &key_c.1,
                key_c.2.as_deref(),
                // Pause briefly so the test can write stdin while `read` is
                // actually blocking on it. Then echo what we got. Absolute
                // paths avoid depending on PATH (tests may run with a bare
                // env where /bin isn't in PATH).
                Some("/bin/sleep 0.3; read x; printf 'GOT:%s\\n' \"$x\""),
                &tempdir,
                &ctx,
                ch,
                "/bin/sh",
                &[],
                None,
            )
        });

        // Wait for register.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if mgr.processes.lock().unwrap().contains_key(&key) {
                break;
            }
            assert!(Instant::now() < deadline, "never registered");
            std::thread::sleep(Duration::from_millis(10));
        }

        // Let /bin/sh echo the wrapped command and reach `read`.
        std::thread::sleep(Duration::from_millis(500));
        assert!(mgr.write_stdin(&key, b"hello\n").unwrap());

        // Collect output until we see GOT:hello or time out.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut combined = String::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(chunk) => {
                    combined.push_str(&chunk);
                    if combined.contains("GOT:hello") {
                        break;
                    }
                }
                Err(_) => continue,
            }
        }

        // Let run_script finish.
        let _ = handle.join();
        assert!(
            combined.contains("GOT:hello"),
            "expected echoed input; got: {combined:?}"
        );
    }

    // ── resize updates the PTY winsize ─────────────────────────────────────

    #[test]
    fn resize_updates_pty_winsize() {
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
        };
        let key: ProcessKey = ("repo".into(), "run".into(), Some("ws".into()));

        let (tx, rx) = mpsc::channel::<String>();
        let ch = Channel::<ScriptEvent>::new(move |msg| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = msg {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("stdout") {
                        if let Some(data) = v.get("data").and_then(|d| d.as_str()) {
                            let _ = tx.send(data.to_string());
                        }
                    }
                }
            }
            Ok(())
        });

        let mgr_c = mgr.clone();
        let key_c = key.clone();
        let tempdir = std::env::temp_dir().display().to_string();
        let handle = std::thread::spawn(move || {
            run_script_with_shell(
                &mgr_c,
                &key_c.0,
                &key_c.1,
                key_c.2.as_deref(),
                // `stty size` reads the winsize directly from the
                // controlling tty (ioctl TIOCGWINSZ) and prints "rows cols".
                // The initial sleep lets the resize below happen while the
                // shell is waiting, so stty definitely sees the new size.
                // Absolute paths avoid PATH assumptions.
                Some("/bin/sleep 0.5; /bin/stty size"),
                &tempdir,
                &ctx,
                ch,
                "/bin/sh",
                &[],
                None,
            )
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if mgr.processes.lock().unwrap().contains_key(&key) {
                break;
            }
            assert!(Instant::now() < deadline, "run_script never registered");
            std::thread::sleep(Duration::from_millis(10));
        }

        assert!(mgr.resize(&key, 77, 33).unwrap());

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut combined = String::new();
        while Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                combined.push_str(&chunk);
                // `stty size` prints "<rows> <cols>" — 33 rows, 77 cols.
                if combined.contains("33 77") {
                    break;
                }
            }
        }
        let _ = handle.join();
        assert!(
            combined.contains("33 77"),
            "expected 33 77 from stty size; got: {combined:?}"
        );
    }

    // ── run_script end-to-end ──────────────────────────────────────────────

    fn make_channel() -> Channel<ScriptEvent> {
        let (tx, _rx) = mpsc::channel::<()>();
        Channel::<ScriptEvent>::new(move |_| {
            let _ = tx.send(());
            Ok(())
        })
    }

    fn run_simple(script: &str) -> Option<i32> {
        let mgr = ScriptProcessManager::new();
        let dir = std::env::temp_dir();
        let ctx = ScriptContext {
            root_path: dir.display().to_string(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
        };
        run_script_with_shell(
            &mgr,
            "test-repo",
            "setup",
            Some("ws-test"),
            Some(script),
            dir.to_str().unwrap(),
            &ctx,
            make_channel(),
            // /bin/sh avoids the user's interactive zsh startup cost that
            // makes tests flaky under `cargo test` parallelism.
            "/bin/sh",
            &[],
            None,
        )
        .unwrap()
    }

    #[test]
    fn run_script_true_exits_zero() {
        assert_eq!(run_simple("true"), Some(0));
    }

    #[test]
    fn run_script_failing_command_exits_nonzero() {
        assert_eq!(run_simple("exit 42"), Some(42));
    }

    #[test]
    fn run_script_rejects_empty() {
        let mgr = ScriptProcessManager::new();
        let ctx = ScriptContext {
            root_path: "/tmp".into(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
        };
        let result = run_script(&mgr, "r", "s", None, "  ", "/tmp", &ctx, make_channel());
        assert!(result.is_err());
    }

    // ── write_stdin/resize on unknown key silently succeed ─────────────────

    #[test]
    fn write_stdin_unknown_key_is_noop() {
        let mgr = ScriptProcessManager::new();
        let key: ProcessKey = ("nope".into(), "run".into(), None);
        assert!(!mgr.write_stdin(&key, b"x").unwrap());
    }

    #[test]
    fn resize_unknown_key_is_noop() {
        let mgr = ScriptProcessManager::new();
        let key: ProcessKey = ("nope".into(), "run".into(), None);
        assert!(!mgr.resize(&key, 80, 24).unwrap());
    }

    #[test]
    fn kill_unknown_key_returns_false() {
        let mgr = ScriptProcessManager::new();
        let key: ProcessKey = ("nope".into(), "run".into(), None);
        assert!(!mgr.kill(&key));
    }
}
