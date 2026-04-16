use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::io::FromRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
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

#[derive(Clone, Default)]
pub struct ScriptProcessManager {
    processes: Arc<Mutex<HashMap<ProcessKey, Child>>>,
}

/// Kill a child and its entire process group (child is session leader via setsid).
fn kill_process_group(child: &mut Child) {
    let pid = child.id() as libc::pid_t;
    let process_group = unsafe { libc::getpgid(pid) };
    let current_process_group = unsafe { libc::getpgrp() };
    let can_signal_group = process_group > 0 && process_group != current_process_group;

    unsafe {
        if can_signal_group {
            libc::killpg(process_group, libc::SIGTERM);
        }
        // Also signal the leader directly as a fallback.
        libc::kill(pid, libc::SIGTERM);
    }

    if wait_for_child_exit(child, PROCESS_TERM_TIMEOUT) {
        return;
    }

    unsafe {
        if can_signal_group {
            libc::killpg(process_group, libc::SIGKILL);
        }
        libc::kill(pid, libc::SIGKILL);
    }

    let _ = wait_for_child_exit(child, PROCESS_KILL_TIMEOUT);
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() >= deadline => return false,
            Ok(None) => std::thread::sleep(PTY_POLL_INTERVAL),
            Err(_) => return false,
        }
    }
}

impl ScriptProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, key: ProcessKey, child: Child) {
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(mut old) = map.remove(&key) {
            kill_process_group(&mut old);
        }
        map.insert(key, child);
    }

    pub fn kill(&self, key: &ProcessKey) -> bool {
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(mut child) = map.remove(key) {
            kill_process_group(&mut child);
            return true;
        }
        false
    }
}

/// Workspace context passed to scripts as environment variables.
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
    if script.trim().is_empty() {
        bail!("Script is empty");
    }

    let (master_fd, slave_fd) = open_pty()?;
    set_nonblocking(master_fd)?;

    // Dup master for writing before the reader thread takes ownership.
    let write_fd = unsafe { libc::dup(master_fd) };

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

    // Dup slave for the pre_exec closure (Stdio::from_raw_fd takes ownership).
    let slave_for_session = unsafe { libc::dup(slave_fd) };

    let mut cmd = Command::new(&shell);
    cmd.args(["-i", "-l"])
        .current_dir(working_dir)
        .env("TERM", "xterm-256color")
        .env("FORCE_COLOR", "1")
        .env("CLICOLOR_FORCE", "1")
        // Prevent history pollution from the interactive shell.
        .env("HISTFILE", "/dev/null")
        .env("SAVEHIST", "0")
        .env("HISTSIZE", "0")
        .env("HELMOR_ROOT_PATH", &context.root_path)
        .env("CONDUCTOR_ROOT_PATH", &context.root_path);

    if let Some(wp) = &context.workspace_path {
        cmd.env("HELMOR_WORKSPACE_PATH", wp);
        cmd.env("CONDUCTOR_WORKSPACE_PATH", wp);
    }
    if let Some(wn) = &context.workspace_name {
        cmd.env("HELMOR_WORKSPACE_NAME", wn);
        cmd.env("CONDUCTOR_WORKSPACE_NAME", wn);
    }
    if let Some(db) = &context.default_branch {
        cmd.env("HELMOR_DEFAULT_BRANCH", db);
        cmd.env("CONDUCTOR_DEFAULT_BRANCH", db);
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
    let child = unsafe {
        cmd.stdin(Stdio::from_raw_fd(slave_fd))
            .stdout(Stdio::from_raw_fd(libc::dup(slave_fd)))
            .stderr(Stdio::from_raw_fd(libc::dup(slave_fd)))
            .spawn()
            .with_context(|| format!("Failed to spawn {shell}"))?
    };

    // Drop cmd to close all parent copies of slave fds. Without this the
    // master never sees EIO because the slave reference count stays > 0.
    drop(cmd);

    let pid = child.id();
    let _ = channel.send(ScriptEvent::Started {
        pid,
        command: script.to_string(),
    });

    let key: ProcessKey = (
        repo_id.to_string(),
        script_type.to_string(),
        workspace_id.map(str::to_string),
    );
    manager.insert(key.clone(), child);

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
                        // EIO is expected when the child exits and slave closes.
                        if e.raw_os_error() != Some(libc::EIO) {
                            tracing::debug!(error = %e, "PTY read error");
                        }
                        if e.kind() == std::io::ErrorKind::WouldBlock {
                            std::thread::sleep(PTY_POLL_INTERVAL);
                            continue;
                        }
                        break;
                    }
                }
            }
        })
        .ok();

    // Feed the wrapped command to the shell's stdin via the PTY master.
    // The interactive shell will show its prompt, echo the command, execute
    // it, print a completion message, then exit.
    let wrapped = format!(
        "eval {}; __helmor_ec=$?; printf '\\r\\n\\033[2m[Setup completed with exit code %d]\\033[0m\\r\\n' $__helmor_ec; exit $__helmor_ec\n",
        shell_escape(script),
    );
    unsafe {
        let mut writer = std::fs::File::from_raw_fd(write_fd);
        let _ = writer.write_all(wrapped.as_bytes());
        // writer drops here, closing write_fd
    }

    let exit_code = {
        let mut map = manager.processes.lock().expect("process map poisoned");
        if let Some(mut child) = map.remove(&key) {
            child.wait().ok().and_then(|s| s.code())
        } else {
            None
        }
    };

    stop_reader.store(true, Ordering::Relaxed);
    if let Some(h) = reader {
        let _ = h.join();
    }

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

    // ── ProcessKey workspace isolation ─────────────────────────────────────

    #[test]
    fn insert_with_different_workspace_ids_are_independent() {
        let mgr = ScriptProcessManager::new();
        let child_a = StdCommand::new("/bin/sleep").arg("60").spawn().unwrap();
        let child_b = StdCommand::new("/bin/sleep").arg("60").spawn().unwrap();
        let pid_b = child_b.id();

        let key_a = ("repo".into(), "setup".into(), Some("ws-a".into()));
        let key_b = ("repo".into(), "setup".into(), Some("ws-b".into()));

        mgr.insert(key_a.clone(), child_a);
        mgr.insert(key_b, child_b);

        // Killing ws-a should NOT touch ws-b.
        assert!(mgr.kill(&key_a));

        let map = mgr.processes.lock().unwrap();
        let remaining = map.values().next().expect("ws-b should still be in map");
        assert_eq!(remaining.id(), pid_b);
        drop(map);

        // Cleanup.
        let key_b2 = ("repo".into(), "setup".into(), Some("ws-b".into()));
        mgr.kill(&key_b2);
    }

    #[test]
    fn insert_same_key_kills_previous() {
        let mgr = ScriptProcessManager::new();
        let child1 = StdCommand::new("/bin/sleep").arg("60").spawn().unwrap();
        let pid1 = child1.id();
        let child2 = StdCommand::new("/bin/sleep").arg("60").spawn().unwrap();
        let pid2 = child2.id();

        let key = ("repo".into(), "setup".into(), Some("ws-1".into()));
        mgr.insert(key.clone(), child1);
        mgr.insert(key.clone(), child2);

        // Only child2 should remain.
        let map = mgr.processes.lock().unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map[&key].id(), pid2);
        drop(map);

        let status = unsafe { libc::kill(pid1 as libc::pid_t, 0) };
        assert_eq!(status, -1, "old process should be dead");

        mgr.kill(&key);
    }

    // ── kill_process_group kills children ──────────────────────────────────

    #[test]
    fn kill_process_group_terminates_child_tree() {
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
        let pid = child.id();

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

        kill_process_group(&mut child);

        // The shell should exit.
        let status = child.try_wait().unwrap().expect("shell should be reaped");
        assert!(!status.success());

        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) };
        assert_eq!(alive, -1, "process should be dead after kill_process_group");
        let background_alive = unsafe { libc::kill(background_pid, 0) };
        assert_eq!(
            background_alive, -1,
            "background child should be dead after kill_process_group"
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
        run_script(
            &mgr,
            "test-repo",
            "setup",
            Some("ws-test"),
            script,
            dir.to_str().unwrap(),
            &ctx,
            make_channel(),
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
    fn run_script_returns_after_shell_exit_even_if_background_child_keeps_running() {
        let start = Instant::now();
        assert_eq!(run_simple("/bin/sleep 5 &"), Some(0));
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "run_script should not block on background children holding the PTY open"
        );
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
}
