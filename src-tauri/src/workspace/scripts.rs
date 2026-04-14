use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::io::FromRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

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

#[derive(Clone, Default)]
pub struct ScriptProcessManager {
    processes: Arc<Mutex<HashMap<ProcessKey, Child>>>,
}

/// Kill a child and its entire process group (child is session leader via setsid).
fn kill_process_group(child: &Child) {
    let pid = child.id() as libc::pid_t;
    unsafe {
        libc::killpg(pid, libc::SIGTERM);
        // Also signal the leader directly as a fallback.
        libc::kill(pid, libc::SIGTERM);
    }
    std::thread::sleep(std::time::Duration::from_millis(100));
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
        libc::kill(pid, libc::SIGKILL);
    }
}

impl ScriptProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, key: ProcessKey, child: Child) {
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(old) = map.remove(&key) {
            kill_process_group(&old);
        }
        map.insert(key, child);
    }

    pub fn kill(&self, key: &ProcessKey) -> bool {
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(child) = map.remove(key) {
            kill_process_group(&child);
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
    let reader = std::thread::Builder::new()
        .name("script-pty".into())
        .spawn(move || {
            let mut master = unsafe { std::fs::File::from_raw_fd(master_fd) };
            let mut buf = [0u8; 4096];
            loop {
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

    if let Some(h) = reader {
        let _ = h.join();
    }

    let exit_code = {
        let mut map = manager.processes.lock().expect("process map poisoned");
        if let Some(mut child) = map.remove(&key) {
            child.wait().ok().and_then(|s| s.code())
        } else {
            None
        }
    };

    let _ = channel.send(ScriptEvent::Exited { code: exit_code });
    Ok(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use std::sync::mpsc;

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

        // Reap the zombie so kill(pid, 0) reflects the true state.
        unsafe { libc::waitpid(pid1 as libc::pid_t, std::ptr::null_mut(), 0) };
        let status = unsafe { libc::kill(pid1 as libc::pid_t, 0) };
        assert_eq!(status, -1, "old process should be dead");

        mgr.kill(&key);
    }

    // ── kill_process_group kills children ──────────────────────────────────

    #[test]
    fn kill_process_group_terminates_child_tree() {
        // Spawn a shell that starts a background sleep, then waits.
        let mut child = StdCommand::new("/bin/sh")
            .args(["-c", "/bin/sleep 120 & wait"])
            .spawn()
            .unwrap();
        let pid = child.id();

        // Let the child start.
        std::thread::sleep(std::time::Duration::from_millis(100));

        kill_process_group(&child);

        // The shell should exit.
        let status = child.wait().unwrap();
        assert!(!status.success());

        // After a brief wait, the PID should be gone.
        std::thread::sleep(std::time::Duration::from_millis(50));
        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) };
        assert_eq!(alive, -1, "process should be dead after kill_process_group");
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
