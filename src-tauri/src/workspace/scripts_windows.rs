//! Windows implementation of the workspace script runner.
//!
//! Phase 6 replaces the Phase 2 "not supported" stub with a real
//! implementation backed by `cmd.exe /C <script>` + piped stdio. This covers
//! the vast majority of user scripts (npm install, pip install, bun install,
//! cargo build, shell oneliners) without pulling in the complexity of a
//! full ConPTY port.
//!
//! Known limitations vs the Unix PTY implementation (documented for users):
//! - No terminal emulation (curses apps misbehave, ANSI color escape codes
//!   are forwarded as-is but the user's terminal interprets them).
//! - kill() terminates the `cmd.exe` process but descendant processes may
//!   leak on Windows without a Job Object. We set CREATE_NEW_PROCESS_GROUP
//!   on the child so Ctrl+Break CAN be sent, but the reliable descendant
//!   cleanup is documented follow-up work (add `windows-sys` + `AssignProcessToJobObject`).
//!
//! The public API mirrors the Unix module byte-for-byte: ScriptEvent,
//! ScriptContext, ScriptProcessManager, run_script. Callers are unchanged
//! between Unix and Windows.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
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

/// Key = (repo_id, script_type, workspace_id). Matches the Unix module alias.
type ProcessKey = (String, String, Option<String>);

/// https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags
/// CREATE_NEW_PROCESS_GROUP = 0x00000200.
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

const PROCESS_KILL_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone, Default)]
pub struct ScriptProcessManager {
    processes: Arc<Mutex<HashMap<ProcessKey, Child>>>,
}

impl ScriptProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, key: ProcessKey, child: Child) {
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(mut old) = map.remove(&key) {
            kill_child(&mut old);
        }
        map.insert(key, child);
    }

    pub fn kill(&self, key: &ProcessKey) -> bool {
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(mut child) = map.remove(key) {
            kill_child(&mut child);
            return true;
        }
        false
    }
}

/// Best-effort child termination. `Child::kill` on Windows terminates the
/// immediate process but child.exe's children may survive — this is a known
/// limitation documented at the module level.
fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let deadline = Instant::now() + PROCESS_KILL_TIMEOUT;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Workspace context passed to scripts as environment variables. API parity
/// with the Unix module.
pub struct ScriptContext {
    pub root_path: String,
    pub workspace_path: Option<String>,
    pub workspace_name: Option<String>,
    pub default_branch: Option<String>,
}

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

    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());

    let mut cmd = Command::new(&shell);
    cmd.args(["/C", script])
        .current_dir(working_dir)
        // New process group so the child does not share the parent's
        // Ctrl+C handling and we can terminate it without killing Helmor.
        .creation_flags(CREATE_NEW_PROCESS_GROUP)
        .env("HELMOR_ROOT_PATH", &context.root_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(wp) = &context.workspace_path {
        cmd.env("HELMOR_WORKSPACE_PATH", wp);
    }
    if let Some(wn) = &context.workspace_name {
        cmd.env("HELMOR_WORKSPACE_NAME", wn);
    }
    if let Some(db) = &context.default_branch {
        cmd.env("HELMOR_DEFAULT_BRANCH", db);
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("Failed to spawn {shell}"))?;

    let pid = child.id();
    let _ = channel.send(ScriptEvent::Started {
        pid,
        command: script.to_string(),
    });

    // Take stdout / stderr handles before inserting the child into the
    // manager — after insert we only own a reference.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let key: ProcessKey = (
        repo_id.to_string(),
        script_type.to_string(),
        workspace_id.map(str::to_string),
    );
    manager.insert(key.clone(), child);

    // Reader threads: forward stdout / stderr chunks as ScriptEvents. The
    // child is owned by the manager; we clone the channel for each reader
    // so they can each send events independently.
    let stdout_handle = stdout.map(|pipe| {
        let ch = channel.clone();
        std::thread::Builder::new()
            .name("script-cmd-stdout".into())
            .spawn(move || {
                let reader = BufReader::new(pipe);
                for line in reader.lines().map_while(Result::ok) {
                    let _ = ch.send(ScriptEvent::Stdout {
                        data: format!("{line}\n"),
                    });
                }
            })
            .ok()
    });
    let stderr_handle = stderr.map(|pipe| {
        let ch = channel.clone();
        std::thread::Builder::new()
            .name("script-cmd-stderr".into())
            .spawn(move || {
                let reader = BufReader::new(pipe);
                for line in reader.lines().map_while(Result::ok) {
                    let _ = ch.send(ScriptEvent::Stderr {
                        data: format!("{line}\n"),
                    });
                }
            })
            .ok()
    });

    // Wait for the child (under the map lock guard logic).
    let exit_code = {
        let mut map = manager.processes.lock().expect("process map poisoned");
        if let Some(mut child) = map.remove(&key) {
            drop(map); // release lock while waiting
            child.wait().ok().and_then(|s| s.code())
        } else {
            None
        }
    };

    if let Some(Some(h)) = stdout_handle {
        let _ = h.join();
    }
    if let Some(Some(h)) = stderr_handle {
        let _ = h.join();
    }

    let _ = channel.send(ScriptEvent::Exited { code: exit_code });
    Ok(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

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
        // `rem` is a no-op comment in cmd.exe.
        assert_eq!(run_simple("rem ok"), Some(0));
    }

    #[test]
    fn run_script_failing_command_exits_nonzero() {
        assert_eq!(run_simple("exit 42"), Some(42));
    }

    #[test]
    fn run_script_rejects_empty() {
        let mgr = ScriptProcessManager::new();
        let ctx = ScriptContext {
            root_path: "C:\\Temp".into(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
        };
        let result = run_script(&mgr, "r", "s", None, "  ", "C:\\Temp", &ctx, make_channel());
        assert!(result.is_err());
    }

    #[test]
    fn manager_kill_returns_false_when_key_absent() {
        let mgr = ScriptProcessManager::new();
        let key = ("repo".into(), "setup".into(), Some("ws".into()));
        assert!(!mgr.kill(&key));
    }

    #[test]
    fn script_event_serializes_camel_case() {
        let ev = ScriptEvent::Stdout {
            data: "line\n".into(),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "stdout");
        assert_eq!(v["data"], "line\n");
    }
}
