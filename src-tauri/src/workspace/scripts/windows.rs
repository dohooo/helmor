use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{ChildStdin, Command, Stdio};
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

type ProcessKey = (String, String, Option<String>);

const PROCESS_TERM_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Clone)]
struct ProcessHandle {
    pid: u32,
    killed: Arc<AtomicBool>,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Clone, Default)]
pub struct ScriptProcessManager {
    processes: Arc<Mutex<HashMap<ProcessKey, ProcessHandle>>>,
}

impl ScriptProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn register(
        &self,
        key: ProcessKey,
        pid: u32,
        stdin: Arc<Mutex<ChildStdin>>,
    ) -> Arc<AtomicBool> {
        let killed = Arc::new(AtomicBool::new(false));
        let handle = ProcessHandle {
            pid,
            killed: killed.clone(),
            stdin,
        };
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(old) = map.insert(key, handle) {
            old.killed.store(true, Ordering::Release);
            kill_process_tree(old.pid);
        }
        killed
    }

    fn unregister(&self, key: &ProcessKey, pid: u32) {
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(h) = map.get(key) {
            if h.pid == pid {
                map.remove(key);
            }
        }
    }

    pub fn kill(&self, key: &ProcessKey) -> bool {
        let handle = {
            let map = self.processes.lock().expect("process map poisoned");
            map.get(key).cloned()
        };
        match handle {
            Some(h) => {
                h.killed.store(true, Ordering::Release);
                kill_process_tree(h.pid);
                true
            }
            None => false,
        }
    }

    pub fn write_stdin(&self, key: &ProcessKey, data: &[u8]) -> Result<bool> {
        let stdin = {
            let map = self.processes.lock().expect("process map poisoned");
            map.get(key).map(|h| h.stdin.clone())
        };
        let Some(stdin) = stdin else {
            return Ok(false);
        };

        let mut handle = stdin.lock().expect("stdin mutex poisoned");
        handle.write_all(data).context("process stdin write failed")?;
        handle.flush().context("process stdin flush failed")?;
        Ok(true)
    }

    pub fn resize(&self, key: &ProcessKey, _cols: u16, _rows: u16) -> Result<bool> {
        let map = self.processes.lock().expect("process map poisoned");
        Ok(map.contains_key(key))
    }
}

#[derive(Clone)]
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
    run_script_with_shell(
        manager,
        repo_id,
        script_type,
        workspace_id,
        Some(script),
        working_dir,
        context,
        channel,
        default_shell(),
        &default_shell_args(),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn run_terminal_session(
    manager: &ScriptProcessManager,
    repo_id: &str,
    script_type: &str,
    workspace_id: Option<&str>,
    working_dir: &str,
    context: &ScriptContext,
    channel: Channel<ScriptEvent>,
) -> Result<Option<i32>> {
    run_script_with_shell(
        manager,
        repo_id,
        script_type,
        workspace_id,
        None,
        working_dir,
        context,
        channel,
        default_shell(),
        &default_shell_args(),
    )
}

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
) -> Result<Option<i32>> {
    if let Some(s) = script {
        if s.trim().is_empty() {
            bail!("Script is empty");
        }
    }

    let mut cmd = Command::new(shell_path);
    cmd.args(shell_args)
        .current_dir(working_dir)
        .env("TERM", "xterm-256color")
        .env("FORCE_COLOR", "1")
        .env("CLICOLOR_FORCE", "1")
        .env("HELMOR_ROOT_PATH", &context.root_path)
        .stdin(Stdio::piped())
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
        .with_context(|| format!("Failed to spawn {shell_path}"))?;
    let pid = child.id();
    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .context("Failed to capture process stdin")?,
    ));

    let _ = channel.send(ScriptEvent::Started {
        pid,
        command: script
            .map(str::to_string)
            .unwrap_or_else(|| format!("{shell_path} {}", shell_args.join(" "))),
    });

    let key: ProcessKey = (
        repo_id.to_string(),
        script_type.to_string(),
        workspace_id.map(str::to_string),
    );
    let killed = manager.register(key.clone(), pid, stdin.clone());

    spawn_pipe_reader(child.stdout.take(), channel.clone(), false);
    spawn_pipe_reader(child.stderr.take(), channel.clone(), true);

    if let Some(script) = script {
        let mut handle = stdin.lock().expect("stdin mutex poisoned");
        handle
            .write_all(wrap_windows_script(script).as_bytes())
            .context("initial shell write failed")?;
        handle.flush().context("initial shell flush failed")?;
    }

    let status = child.wait().ok();
    manager.unregister(&key, pid);

    let exit_code = if killed.load(Ordering::Acquire) {
        None
    } else {
        status.and_then(|s| s.code())
    };

    let _ = channel.send(ScriptEvent::Exited { code: exit_code });
    Ok(exit_code)
}

fn default_shell() -> &'static str {
    "cmd.exe"
}

fn default_shell_args() -> [&'static str; 2] {
    ["/Q", "/K"]
}

fn wrap_windows_script(script: &str) -> String {
    format!(
        "{script}\r\nset __helmor_ec=%ERRORLEVEL%\r\necho.\r\necho [Completed with exit code %__helmor_ec%]\r\nexit /b %__helmor_ec%\r\n"
    )
}

fn spawn_pipe_reader<R>(pipe: Option<R>, channel: Channel<ScriptEvent>, stderr: bool)
where
    R: Read + Send + 'static,
{
    let Some(mut pipe) = pipe else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name(if stderr {
            "script-stderr".into()
        } else {
            "script-stdout".into()
        })
        .spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let event = if stderr {
                            ScriptEvent::Stderr { data }
                        } else {
                            ScriptEvent::Stdout { data }
                        };
                        let _ = channel.send(event);
                    }
                    Err(e) => {
                        tracing::debug!(error = %e, "process pipe read error");
                        break;
                    }
                }
            }
        });
}

fn kill_process_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    let deadline = Instant::now() + PROCESS_TERM_TIMEOUT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
}
