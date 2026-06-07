//! Interactive script / terminal execution on a cross-platform pseudo-terminal.
//!
//! Helmor runs the embedded Terminal tab and interactive run-actions on a PTY
//! so programs that probe `isatty` (vim, htop, progress bars, colored output)
//! behave exactly as they would in a real terminal. The PTY layer is provided
//! by [`portable_pty`], which maps to `openpty(3)` on Unix and the ConPTY API
//! on Windows, so the same code path drives both platforms.
//!
//! Process teardown goes through [`crate::platform::process`]: on Unix the child
//! leads its own session/process-group (portable-pty calls `setsid`), so signals
//! reach the whole tree; on Windows `taskkill /T` walks the tree. PIDs are also
//! persisted to the runtime registry for crash-recovery, which is why the whole
//! module is PID-based rather than holding OS-specific handles.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScriptEvent {
    Started {
        pid: u32,
        command: String,
    },
    Stdout {
        data: String,
    },
    Stderr {
        data: String,
    },
    /// Emitted at the moment a configured `stop.command` starts running.
    /// Frontends flip the run-action card to a "Stopping…" affordance so
    /// the Stop button becomes "Force Stop" (which short-circuits the
    /// cleanup and goes straight to a forced kill on re-click).
    /// Only emitted when a stop command is actually configured.
    Stopping,
    Exited {
        code: Option<i32>,
    },
    Error {
        message: String,
    },
}

/// Key = (repo_id, script_type, workspace_id)
type ProcessKey = (String, String, Option<String>);

const PROCESS_TERM_TIMEOUT: Duration = Duration::from_millis(200);
const PROCESS_KILL_TIMEOUT: Duration = Duration::from_millis(500);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);
const STOP_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Shared writer into a PTY master (user typing, paste, Ctrl+C, initial command).
type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;
/// Shared PTY master, kept alive so `resize` can reach it for the child's lifetime.
type PtyMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;

/// Graceful-stop bundle: the user-provided cleanup command + everything
/// `graceful_kill` needs to spawn it (same env, same cwd, output piped
/// back into the run-action's terminal channel). Built by callers that
/// resolve a `RunAction.stop` block; kept in `ProcessHandle` so the Stop
/// path can reach it without an extra DB lookup.
#[derive(Clone)]
pub struct ScriptStop {
    pub command: String,
    pub event_tx: Channel<ScriptEvent>,
    pub ctx: ScriptContext,
    pub working_dir: String,
}

/// Metadata we track per live script so Stop, stdin, and resize can reach it
/// without owning the child. The owner of the child is `run_script`, which
/// blocks on `child.wait()` *without holding any lock* — that's the whole
/// point of this split. `kill()` only signals; reaping stays with `run_script`.
#[derive(Clone)]
struct ProcessHandle {
    pid: u32,
    /// Shared with `run_script`'s local handle; set by `kill()` or by a
    /// concurrent `register()` that replaces us. `run_script` reads this
    /// after wait() to decide whether to report a real exit code or None.
    killed: Arc<AtomicBool>,
    /// Writable side of the PTY master. Keeping this alive is what makes Ctrl+C
    /// and typing work — without it the PTY master would close right after the
    /// initial command.
    stdin: PtyWriter,
    /// The PTY master, retained so `resize` can deliver new dimensions to the
    /// child (SIGWINCH on Unix, ConPTY resize on Windows).
    master: PtyMaster,
    /// Per-action graceful-stop config. `None` keeps today's behavior:
    /// terminate → 200ms → kill with no detour through stop.command.
    stop: Option<Arc<ScriptStop>>,
    /// CAS'd to `true` the first time `graceful_kill` runs for this handle. A
    /// second Stop click while stop.command is still in flight CAS'es back true
    /// → graceful_kill skips the wait and force-kills the main process
    /// immediately (frontend renders this as "Force Stop").
    stopping: Arc<AtomicBool>,
    /// PID of the in-flight stop.command tree. Set by the first `graceful_kill`
    /// thread once it has spawned the cleanup process, cleared when that process
    /// exits. The Force Stop path (and the rerun / kill_others / kill_all paths)
    /// read this under lock and force-kill the tree so the cleanup process
    /// doesn't outlive the user's intent.
    stop_pid: Arc<Mutex<Option<u32>>>,
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
    /// can find it. If a handle for this key already exists (user clicked Run
    /// again while the previous run was alive), we mark the old one as killed
    /// and signal it — its own `run_script` will reap.
    fn register(
        &self,
        key: ProcessKey,
        pid: u32,
        stdin: PtyWriter,
        master: PtyMaster,
        stop: Option<ScriptStop>,
    ) -> Arc<AtomicBool> {
        let killed = Arc::new(AtomicBool::new(false));
        let handle = ProcessHandle {
            pid,
            killed: killed.clone(),
            stdin,
            master,
            stop: stop.map(Arc::new),
            stopping: Arc::new(AtomicBool::new(false)),
            stop_pid: Arc::new(Mutex::new(None)),
        };
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(old) = map.insert(key, handle) {
            old.killed.store(true, Ordering::Release);
            kill_in_flight_stop_command(&old.stop_pid);
            escalating_kill(old.pid);
        }
        killed
    }

    /// Remove our handle from the map once `child.wait()` has returned.
    /// No-op if we were already replaced by a rerun.
    fn unregister(&self, key: &ProcessKey, pid: u32) {
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
            kill_in_flight_stop_command(&h.stop_pid);
            escalating_kill(h.pid);
        }
        count
    }

    /// Signal every live script and terminal handle the manager currently
    /// owns. Used by the graceful-quit path so Run-tab scripts and
    /// embedded-terminal PTY sessions don't outlive Helmor as orphan
    /// process trees. Returns the number of handles that were signaled.
    ///
    /// Mirrors `kill_others_in_repo`'s lock discipline: snapshot the
    /// handles under the map lock, drop the lock, then signal each. Holding
    /// the lock across the signal would block `run_script`'s post-wait
    /// `unregister` (which takes the same lock) and deadlock the quit path.
    ///
    /// Does **not** reap — each `run_script` thread still owns its own
    /// `child.wait()`.
    pub fn kill_all(&self) -> usize {
        let victims: Vec<ProcessHandle> = {
            let map = self.processes.lock().expect("process map poisoned");
            map.values().cloned().collect()
        };
        let count = victims.len();
        for h in victims {
            h.killed.store(true, Ordering::Release);
            kill_in_flight_stop_command(&h.stop_pid);
            escalating_kill(h.pid);
        }
        count
    }

    /// Terminate the process tree gracefully, escalating to a force kill after
    /// `PROCESS_TERM_TIMEOUT`. Returns true if there was a live handle to signal.
    ///
    /// When the handle carries a `stop.command`, that runs first (output piped
    /// into the same script channel) and the terminate/kill only runs after it
    /// exits. A second `kill()` call while stop.command is still in flight
    /// short-circuits straight to a force kill — the frontend's "Force Stop"
    /// button uses this. The stop.command branch runs on a background thread so
    /// the Tauri IPC call returns immediately; the `killed` flag is flipped
    /// synchronously so racing readers still report a clean kill exit code.
    ///
    /// When the handle has **no** stop.command configured, this stays on the
    /// caller's thread. Does **not** reap — `run_script`'s `child.wait()` still
    /// owns that.
    pub fn kill(&self, key: &ProcessKey) -> bool {
        let handle = {
            let map = self.processes.lock().expect("process map poisoned");
            map.get(key).cloned()
        };
        match handle {
            Some(h) => {
                h.killed.store(true, Ordering::Release);
                if h.stop.is_none() && !h.stopping.load(Ordering::Acquire) {
                    escalating_kill(h.pid);
                } else {
                    std::thread::spawn(move || graceful_kill(h));
                }
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

        let mut writer = stdin.lock().expect("stdin mutex poisoned");
        writer.write_all(data).context("PTY master write failed")?;
        writer.flush().context("PTY master flush failed")?;
        Ok(true)
    }

    /// Tell the PTY about a new terminal size. The kernel (Unix) or ConPTY
    /// (Windows) re-flows the foreground program (vim/htop/less) to match.
    pub fn resize(&self, key: &ProcessKey, cols: u16, rows: u16) -> Result<bool> {
        let master = {
            let map = self.processes.lock().expect("process map poisoned");
            map.get(key).map(|h| h.master.clone())
        };
        let Some(master) = master else {
            return Ok(false);
        };
        let master = master.lock().expect("master mutex poisoned");
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("PTY resize failed")?;
        Ok(true)
    }
}

/// Terminate a process tree, escalating from a cooperative stop to a force kill.
/// Polls liveness via [`crate::platform::process::pid_alive`] to detect when the
/// leader has been reaped by `run_script`'s `child.wait()` on another thread.
fn escalating_kill(pid: u32) {
    if pid == 0 {
        return;
    }
    crate::platform::process::terminate_tree(pid);
    if wait_pid_gone(pid, PROCESS_TERM_TIMEOUT) {
        return;
    }
    crate::platform::process::kill_tree(pid);
    let _ = wait_pid_gone(pid, PROCESS_KILL_TIMEOUT);
}

fn wait_pid_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !crate::platform::process::pid_alive(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

/// Force-kill any `stop.command` cleanup tree currently published in `pid_slot`.
/// Used by `register()` collision, `kill_others_in_repo`, and `kill_all` — they
/// bypass running a *new* `stop.command` but must not leak one already in flight
/// from a prior Stop click. No-op when no cleanup is running.
fn kill_in_flight_stop_command(pid_slot: &Mutex<Option<u32>>) {
    let stop_pid = *pid_slot.lock().expect("stop_pid mutex poisoned");
    if let Some(pid) = stop_pid {
        crate::platform::process::kill_tree(pid);
    }
}

/// Outcome of running a configured `stop.command`.
enum StopOutcome {
    CleanExit,
    NonZeroExit(Option<i32>),
    SpawnFailed(String),
}

/// Build the platform shell command that runs an arbitrary `command` string:
/// `/bin/sh -c` on Unix, PowerShell `-Command` on Windows.
fn shell_command_for(command: &str) -> Command {
    #[cfg(unix)]
    {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(command);
        cmd
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new(powershell_path());
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ]);
        cmd
    }
}

/// Spawn `command` as a new process group, stream its stdout/stderr into the
/// supplied `event_tx`, and block until it exits. There is no timeout — the user
/// controls escalation via the "Force Stop" re-click, which force-kills the
/// cleanup tree through `pid_slot` and short-circuits the wait.
fn run_stop_command(
    command: &str,
    working_dir: &str,
    ctx: &ScriptContext,
    event_tx: &Channel<ScriptEvent>,
    pid_slot: &Mutex<Option<u32>>,
) -> StopOutcome {
    let mut cmd = shell_command_for(command);
    cmd.current_dir(working_dir)
        .env("TERM", "xterm-256color")
        .env("FORCE_COLOR", "1")
        .env("CLICOLOR_FORCE", "1")
        .env("HELMOR_ROOT_PATH", &ctx.root_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(wp) = &ctx.workspace_path {
        cmd.env("HELMOR_WORKSPACE_PATH", wp);
    }
    if let Some(wn) = &ctx.workspace_name {
        cmd.env("HELMOR_WORKSPACE_NAME", wn);
    }
    if let Some(db) = &ctx.default_branch {
        cmd.env("HELMOR_DEFAULT_BRANCH", db);
    }
    if let (Some(base), Some(count)) = (ctx.port_base, ctx.port_count) {
        cmd.env("HELMOR_PORT", base.to_string());
        cmd.env("HELMOR_PORT_COUNT", count.to_string());
    }

    // Own process group (Unix) so a concurrent Force Stop can kill the whole
    // cleanup tree; on Windows taskkill /T handles the tree by PID.
    crate::platform::process::configure_new_group(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return StopOutcome::SpawnFailed(format!("{e}")),
    };
    let pid = child.id();

    // Publish pid so a concurrent Force Stop can kill the cleanup tree. Always
    // cleared before return.
    *pid_slot.lock().expect("stop_pid mutex poisoned") = Some(pid);

    fn pipe_to_channel<R: Read + Send + 'static>(
        name: &'static str,
        mut reader: R,
        tx: Channel<ScriptEvent>,
        wrap: fn(String) -> ScriptEvent,
    ) -> Option<std::thread::JoinHandle<()>> {
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = tx.send(wrap(data));
                }
            })
            .ok()
    }
    let stdout_thread = child.stdout.take().and_then(|s| {
        pipe_to_channel("stop-cmd-stdout", s, event_tx.clone(), |data| {
            ScriptEvent::Stdout { data }
        })
    });
    let stderr_thread = child.stderr.take().and_then(|s| {
        pipe_to_channel("stop-cmd-stderr", s, event_tx.clone(), |data| {
            ScriptEvent::Stderr { data }
        })
    });

    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    break StopOutcome::CleanExit;
                }
                break StopOutcome::NonZeroExit(status.code());
            }
            Ok(None) => {
                std::thread::sleep(STOP_COMMAND_POLL_INTERVAL);
            }
            Err(e) => {
                crate::platform::process::kill_tree(pid);
                let _ = child.wait();
                break StopOutcome::SpawnFailed(format!("try_wait failed: {e}"));
            }
        }
    };

    if let Some(h) = stdout_thread {
        let _ = h.join();
    }
    if let Some(h) = stderr_thread {
        let _ = h.join();
    }

    *pid_slot.lock().expect("stop_pid mutex poisoned") = None;

    outcome
}

/// Graceful Stop sequence for one process handle (see `kill`).
fn graceful_kill(handle: ProcessHandle) {
    // Race guard: if `stopping` was already true this is a re-click
    // ("Force Stop"). Kill the in-flight cleanup tree, then escalating_kill the
    // main process. Both threads converge safely.
    if handle.stopping.swap(true, Ordering::AcqRel) {
        kill_in_flight_stop_command(&handle.stop_pid);
        escalating_kill(handle.pid);
        return;
    }

    if let Some(stop) = handle.stop.as_deref() {
        let _ = stop.event_tx.send(ScriptEvent::Stopping);
        let _ = stop.event_tx.send(ScriptEvent::Stdout {
            data: format!(
                "\r\n\x1b[2m[Helmor] Running stop.command: {}\x1b[0m\r\n",
                stop.command
            ),
        });
        let started = Instant::now();
        let outcome = run_stop_command(
            &stop.command,
            &stop.working_dir,
            &stop.ctx,
            &stop.event_tx,
            &handle.stop_pid,
        );
        let elapsed_ms = started.elapsed().as_millis();
        let footer = match outcome {
            StopOutcome::CleanExit => format!(
                "\r\n\x1b[2m[Helmor] stop.command exited cleanly in {elapsed_ms}ms\x1b[0m\r\n"
            ),
            StopOutcome::NonZeroExit(code) => format!(
                "\r\n\x1b[33m[Helmor] stop.command exited with code {} after {elapsed_ms}ms\x1b[0m\r\n",
                code.map(|c| c.to_string()).unwrap_or_else(|| "?".to_string())
            ),
            StopOutcome::SpawnFailed(err) => format!(
                "\r\n\x1b[33m[Helmor] stop.command failed to spawn ({err}) — proceeding with force-kill\x1b[0m\r\n"
            ),
        };
        let _ = stop.event_tx.send(ScriptEvent::Stdout { data: footer });
    }

    escalating_kill(handle.pid);
}

/// Workspace context passed to scripts as environment variables.
#[derive(Clone, Default)]
pub struct ScriptContext {
    pub root_path: String,
    pub workspace_path: Option<String>,
    pub workspace_name: Option<String>,
    pub default_branch: Option<String>,
    /// First port in the workspace's deterministic port block.
    /// Surfaces to scripts as `HELMOR_PORT`. `None` for non-workspace
    /// runs (onboarding auth terminals, etc.).
    pub port_base: Option<u16>,
    /// Size of the port block starting at `port_base`. Surfaces to
    /// scripts as `HELMOR_PORT_COUNT`. Always paired with `port_base`.
    pub port_count: Option<u16>,
}

/// Escape a string for safe embedding inside single quotes (POSIX shells).
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn fish_shell_escape(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\")
            .replace('$', "\\$")
            .replace('"', "\\\"")
    )
}

fn wrapped_script_for_shell(shell_path: &str, script: &str) -> String {
    let shell_name = std::path::Path::new(shell_path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|n| n.trim_end_matches(".exe"));

    match shell_name {
        Some("fish") => format!(
            "eval {}; set __helmor_ec $status; printf '\\r\\n\\033[2m[Completed with exit code %d]\\033[0m\\r\\n' $__helmor_ec; exit $__helmor_ec\n",
            fish_shell_escape(script),
        ),
        Some("powershell") | Some("pwsh") => format!(
            // Run the user's command, then capture the exit code. $LASTEXITCODE
            // is set by native executables; for pure-PowerShell statements it
            // stays null, so fall back to 0 on success ($?), 1 otherwise.
            "{script}\r\n$__helmor_ec = if ($null -ne $LASTEXITCODE) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}; Write-Host (\"`r`n{esc}[2m[Completed with exit code {{0}}]{esc}[0m`r`n\" -f $__helmor_ec); exit $__helmor_ec\r\n",
            script = script,
            esc = "$([char]27)"
        ),
        _ => format!(
            "eval {}; __helmor_ec=$?; printf '\\r\\n\\033[2m[Completed with exit code %d]\\033[0m\\r\\n' $__helmor_ec; exit $__helmor_ec\n",
            shell_escape(script),
        ),
    }
}

/// Locate PowerShell on Windows: prefer PowerShell 7 (`pwsh`), fall back to the
/// in-box Windows PowerShell.
#[cfg(windows)]
fn powershell_path() -> String {
    if which_in_path("pwsh.exe") {
        "pwsh.exe".to_string()
    } else {
        "powershell.exe".to_string()
    }
}

#[cfg(windows)]
fn which_in_path(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(exe).is_file()))
        .unwrap_or(false)
}

/// The platform default interactive shell and its arguments.
/// Unix: the user's `$SHELL` as an interactive login shell.
/// Windows: PowerShell (no logo/profile banner; reads commands from the PTY).
fn default_shell() -> (String, Vec<String>) {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        (shell, vec!["-i".to_string(), "-l".to_string()])
    }
    #[cfg(windows)]
    {
        (powershell_path(), vec!["-NoLogo".to_string()])
    }
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
    stop: Option<ScriptStop>,
) -> Result<Option<i32>> {
    let (shell, args) = default_shell();
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
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
        &args_ref,
        None,
        stop,
    )
}

/// Spawn a blank interactive login shell on a PTY without feeding any script.
///
/// Used by the Inspector Terminal tab and by onboarding embedded auth terminals
/// (`gh auth login`, `claude /login`, …). In both cases the PTY persists across
/// multiple `write_stdin` calls.
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
    let (shell, args) = default_shell();
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
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
        &args_ref,
        boot_input,
        None,
    )
}

/// Internal implementation of [`run_script`] that takes the shell path and
/// args explicitly. Exposed within the crate so tests can substitute a lean
/// shell for the user's (potentially slow) interactive `$SHELL`.
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
    stop: Option<ScriptStop>,
) -> Result<Option<i32>> {
    if let Some(s) = script {
        if s.trim().is_empty() {
            bail!("Script is empty");
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("Failed to allocate PTY")?;

    let mut builder = CommandBuilder::new(shell_path);
    for arg in shell_args {
        builder.arg(arg);
    }
    builder.cwd(working_dir);
    builder.env("TERM", "xterm-256color");
    builder.env("FORCE_COLOR", "1");
    builder.env("CLICOLOR_FORCE", "1");
    // Prevent history pollution from the interactive shell (Unix shells only).
    #[cfg(unix)]
    {
        builder.env("HISTFILE", "/dev/null");
        builder.env("SAVEHIST", "0");
        builder.env("HISTSIZE", "0");
    }
    builder.env("HELMOR_ROOT_PATH", &context.root_path);
    if let Some(wp) = &context.workspace_path {
        builder.env("HELMOR_WORKSPACE_PATH", wp);
    }
    if let Some(wn) = &context.workspace_name {
        builder.env("HELMOR_WORKSPACE_NAME", wn);
    }
    if let Some(db) = &context.default_branch {
        builder.env("HELMOR_DEFAULT_BRANCH", db);
    }
    if let (Some(base), Some(count)) = (context.port_base, context.port_count) {
        builder.env("HELMOR_PORT", base.to_string());
        builder.env("HELMOR_PORT_COUNT", count.to_string());
    }

    let mut child = pair
        .slave
        .spawn_command(builder)
        .with_context(|| format!("Failed to spawn {shell_path}"))?;

    // Reader + writer come from the master before we move it into the handle.
    let mut reader = pair
        .master
        .try_clone_reader()
        .context("Failed to clone PTY reader")?;
    let writer = pair
        .master
        .take_writer()
        .context("Failed to take PTY writer")?;
    // Drop the slave so the master sees EOF once the child exits.
    drop(pair.slave);

    let stdin: PtyWriter = Arc::new(Mutex::new(writer));
    let master: PtyMaster = Arc::new(Mutex::new(pair.master));

    let pid = child.process_id().unwrap_or(0);

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
    let killed = manager.register(key.clone(), pid, stdin.clone(), master.clone(), stop);

    // Persist a registry row so the next launch's crash-recovery sweep can
    // classify this PID if the app dies before `record_ended` runs. Best-effort.
    let registry_id = match super::runtime_registry::record_started(
        repo_id,
        workspace_id,
        script_type,
        pid as i32,
        // No process-group id concept on Windows; on Unix the PTY child is its
        // own session/group leader so pgid == pid. Store pid for both.
        pid as i32,
    ) {
        Ok(id) => Some(id),
        Err(error) => {
            tracing::warn!(
                pid,
                %error,
                "runtime registry: failed to record process start; crash recovery will miss this row"
            );
            None
        }
    };

    // Single reader on the PTY master — stdout+stderr are merged by the PTY.
    // The blocking read returns 0/Err when the child exits and the master sees
    // EOF, which ends the thread without any polling.
    let ch = channel.clone();
    let reader_thread = std::thread::Builder::new()
        .name("script-pty".into())
        .spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let _ = ch.send(ScriptEvent::Stdout { data });
                    }
                    Err(_) => break,
                }
            }
        })
        .ok();

    // Feed the wrapped command (or boot input) to the shell via the PTY master.
    if let Some(script) = script {
        let wrapped = wrapped_script_for_shell(shell_path, script);
        let mut file = stdin.lock().expect("stdin mutex poisoned");
        if let Err(e) = file.write_all(wrapped.as_bytes()) {
            tracing::warn!(error = %e, "initial PTY write failed");
        }
        let _ = file.flush();
    } else if let Some(input) = boot_input {
        let mut file = stdin.lock().expect("stdin mutex poisoned");
        if let Err(e) = file.write_all(input.as_bytes()) {
            tracing::warn!(error = %e, "boot_input PTY write failed");
        }
        let _ = file.flush();
    }

    // Wait for the child WITHOUT holding any lock — Stop / write_stdin / resize
    // can all grab the manager's lock at any time because we're not holding it.
    let status = child.wait().ok();

    manager.unregister(&key, pid);

    if let Some(id) = registry_id.as_deref() {
        if let Err(error) = super::runtime_registry::record_ended(id) {
            tracing::warn!(
                pid,
                registry_id = id,
                %error,
                "runtime registry: failed to mark process ended; will be cleaned up on next startup sweep"
            );
        }
    }

    // The reader thread ends when the PTY master hits EOF (child exit). Joining
    // guarantees all output is flushed before we emit Exited. Dropping the
    // writer/master after this releases the PTY.
    if let Some(h) = reader_thread {
        let _ = h.join();
    }

    let exit_code = if killed.load(Ordering::Acquire) {
        None
    } else {
        status.map(|s| s.exit_code() as i32)
    };

    let _ = channel.send(ScriptEvent::Exited { code: exit_code });
    Ok(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── shell_escape (cross-platform string logic) ─────────────────────────

    #[test]
    fn shell_escape_plain() {
        assert_eq!(shell_escape("echo hello"), "'echo hello'");
    }

    #[test]
    fn shell_escape_single_quotes() {
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
    }

    #[test]
    fn fish_shell_escape_handles_fish_expansion_chars() {
        assert_eq!(
            fish_shell_escape("printf \"%s\" '$value' \\ done"),
            "\"printf \\\"%s\\\" '\\$value' \\\\ done\"",
        );
    }

    #[test]
    fn wrapped_script_uses_fish_status_for_fish_shell() {
        assert_eq!(
            wrapped_script_for_shell("/opt/homebrew/bin/fish", "echo \"it's\""),
            "eval \"echo \\\"it's\\\"\"; set __helmor_ec $status; printf '\\r\\n\\033[2m[Completed with exit code %d]\\033[0m\\r\\n' $__helmor_ec; exit $__helmor_ec\n",
        );
    }

    #[test]
    fn wrapped_script_uses_powershell_form_for_pwsh() {
        let w = wrapped_script_for_shell("C:/Program Files/PowerShell/7/pwsh.exe", "echo hi");
        assert!(w.starts_with("echo hi"));
        assert!(w.contains("$LASTEXITCODE"));
        assert!(w.contains("exit $__helmor_ec"));
    }

    // ── unknown-key operations are silent no-ops ───────────────────────────

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

    #[test]
    fn run_script_rejects_empty() {
        let mgr = ScriptProcessManager::new();
        let ctx = ScriptContext::default();
        let result = run_script(
            &mgr,
            "r",
            "s",
            None,
            "  ",
            &std::env::temp_dir().display().to_string(),
            &ctx,
            make_channel(),
            None,
        );
        assert!(result.is_err());
    }

    fn make_channel() -> Channel<ScriptEvent> {
        let (tx, _rx) = std::sync::mpsc::channel::<()>();
        Channel::<ScriptEvent>::new(move |_| {
            let _ = tx.send(());
            Ok(())
        })
    }

    // ── cross-platform manager logic (PTY-backed long-running child) ────────

    /// Spawn a long-running child on a real PTY and register it. Returns the
    /// child (caller reaps), its pid, and the killed flag. Cross-platform: a
    /// shell that sleeps keeps the PTY child alive on both Unix and Windows.
    fn spawn_and_register(
        mgr: &ScriptProcessManager,
        key: ProcessKey,
    ) -> (
        Box<dyn portable_pty::Child + Send + Sync>,
        u32,
        Arc<AtomicBool>,
    ) {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        #[cfg(unix)]
        let mut builder = {
            let mut b = CommandBuilder::new("/bin/sh");
            b.arg("-c");
            b.arg("sleep 60");
            b
        };
        #[cfg(windows)]
        let mut builder = {
            let mut b = CommandBuilder::new(powershell_path());
            b.arg("-NoLogo");
            b.arg("-NoProfile");
            b.arg("-Command");
            b.arg("Start-Sleep -Seconds 60");
            b
        };
        builder.cwd(std::env::temp_dir().display().to_string());

        let child = pair.slave.spawn_command(builder).expect("spawn sleeper");
        let writer = pair.master.take_writer().expect("writer");
        drop(pair.slave);
        let pid = child.process_id().expect("pid");
        let stdin: PtyWriter = Arc::new(Mutex::new(writer));
        let master: PtyMaster = Arc::new(Mutex::new(pair.master));
        let killed = mgr.register(key, pid, stdin, master, None);
        (child, pid, killed)
    }

    #[test]
    fn register_with_different_keys_are_independent() {
        let mgr = ScriptProcessManager::new();
        let key_a: ProcessKey = ("repo".into(), "setup".into(), Some("ws-a".into()));
        let key_b: ProcessKey = ("repo".into(), "setup".into(), Some("ws-b".into()));

        let (mut child_a, _, _) = spawn_and_register(&mgr, key_a.clone());
        let (mut child_b, pid_b, _) = spawn_and_register(&mgr, key_b.clone());

        assert!(mgr.kill(&key_a));
        let _ = child_a.wait();

        let still_registered = {
            let map = mgr.processes.lock().unwrap();
            map.contains_key(&key_b)
        };
        assert!(still_registered);
        assert!(
            crate::platform::process::pid_alive(pid_b),
            "ws-b should still be alive"
        );

        mgr.kill(&key_b);
        let _ = child_b.wait();
    }

    #[test]
    fn register_same_key_signals_previous() {
        let mgr = ScriptProcessManager::new();
        let key: ProcessKey = ("repo".into(), "setup".into(), Some("ws".into()));

        let (mut child1, pid1, killed1) = spawn_and_register(&mgr, key.clone());
        let (mut child2, pid2, _) = spawn_and_register(&mgr, key.clone());

        let _ = child1.wait();
        assert!(
            killed1.load(Ordering::Acquire),
            "killed flag set on replaced handle"
        );

        let map = mgr.processes.lock().unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map[&key].pid, pid2);
        assert_ne!(pid1, pid2);
        drop(map);

        mgr.kill(&key);
        let _ = child2.wait();
    }

    #[test]
    fn kill_others_in_repo_signals_matching_only() {
        let mgr = ScriptProcessManager::new();
        let a_keep: ProcessKey = ("A".into(), "run".into(), Some("ws-keep".into()));
        let a_other: ProcessKey = ("A".into(), "run".into(), Some("ws-other".into()));
        let a_setup: ProcessKey = ("A".into(), "setup".into(), Some("ws-keep".into()));
        let b_run: ProcessKey = ("B".into(), "run".into(), Some("ws-keep".into()));

        let (mut keep, _, keep_k) = spawn_and_register(&mgr, a_keep.clone());
        let (mut other, _, other_k) = spawn_and_register(&mgr, a_other.clone());
        let (mut setup, _, setup_k) = spawn_and_register(&mgr, a_setup.clone());
        let (mut brun, _, brun_k) = spawn_and_register(&mgr, b_run.clone());

        let signaled = mgr.kill_others_in_repo("A", "run", Some("ws-keep"));
        assert_eq!(signaled, 1);
        let _ = other.wait();
        assert!(other_k.load(Ordering::Acquire));
        assert!(!keep_k.load(Ordering::Acquire));
        assert!(!setup_k.load(Ordering::Acquire));
        assert!(!brun_k.load(Ordering::Acquire));

        mgr.kill(&a_keep);
        mgr.kill(&a_setup);
        mgr.kill(&b_run);
        let _ = keep.wait();
        let _ = setup.wait();
        let _ = brun.wait();
    }

    #[test]
    fn kill_others_in_repo_with_no_matches_is_noop() {
        let mgr = ScriptProcessManager::new();
        assert_eq!(mgr.kill_others_in_repo("nope", "run", None), 0);
    }

    #[test]
    fn kill_all_signals_every_registered_handle() {
        let mgr = ScriptProcessManager::new();
        let a_run: ProcessKey = ("A".into(), "run".into(), Some("ws-1".into()));
        let b_term: ProcessKey = ("B".into(), "terminal:abc".into(), Some("ws-other".into()));
        let auth: ProcessKey = ("__auth__".into(), "agent-login:claude".into(), None);

        let (mut c1, _, k1) = spawn_and_register(&mgr, a_run.clone());
        let (mut c2, _, k2) = spawn_and_register(&mgr, b_term.clone());
        let (mut c3, _, k3) = spawn_and_register(&mgr, auth.clone());

        assert_eq!(mgr.kill_all(), 3);
        let _ = c1.wait();
        let _ = c2.wait();
        let _ = c3.wait();
        assert!(k1.load(Ordering::Acquire));
        assert!(k2.load(Ordering::Acquire));
        assert!(k3.load(Ordering::Acquire));
    }

    #[test]
    fn kill_all_with_empty_manager_is_zero() {
        let mgr = ScriptProcessManager::new();
        assert_eq!(mgr.kill_all(), 0);
    }
}

// Unix-shell-specific integration tests. These assert exact POSIX-shell
// behaviour (`/bin/sh`, `/bin/sleep`, `/bin/stty`, `printf`, `${VAR+set}`,
// fish) and the no-deadlock lock discipline, so they only run on Unix. The
// cross-platform manager logic above covers register/kill/resize on Windows.
#[cfg(all(test, unix))]
mod unix_integration_tests {
    use super::*;
    use std::sync::mpsc;

    fn make_channel() -> Channel<ScriptEvent> {
        let (tx, _rx) = mpsc::channel::<()>();
        Channel::<ScriptEvent>::new(move |_| {
            let _ = tx.send(());
            Ok(())
        })
    }

    fn run_simple_with_shell(script: &str, shell_path: &str, shell_args: &[&str]) -> Option<i32> {
        let mgr = ScriptProcessManager::new();
        let dir = std::env::temp_dir();
        let ctx = ScriptContext {
            root_path: dir.display().to_string(),
            ..Default::default()
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
            shell_path,
            shell_args,
            None,
            None,
        )
        .unwrap()
    }

    fn run_simple(script: &str) -> Option<i32> {
        run_simple_with_shell(script, "/bin/sh", &[])
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
    fn kill_terminates_running_script_quickly() {
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            ..Default::default()
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

        assert!(mgr.kill(&key), "kill should find the handle");
        let result = handle.join().unwrap();
        assert!(start.elapsed() < Duration::from_secs(5));
        assert_eq!(result.unwrap(), None, "killed scripts report None exit");
        assert!(!mgr.processes.lock().unwrap().contains_key(&key));
    }

    #[test]
    fn write_stdin_delivers_bytes_to_running_script() {
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            ..Default::default()
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
                Some("/bin/sleep 0.3; read x; printf 'GOT:%s\\n' \"$x\""),
                &tempdir,
                &ctx,
                ch,
                "/bin/sh",
                &[],
                None,
                None,
            )
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if mgr.processes.lock().unwrap().contains_key(&key) {
                break;
            }
            assert!(Instant::now() < deadline, "never registered");
            std::thread::sleep(Duration::from_millis(10));
        }

        std::thread::sleep(Duration::from_millis(500));
        assert!(mgr.write_stdin(&key, b"hello\n").unwrap());

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut combined = String::new();
        while Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                combined.push_str(&chunk);
                if combined.contains("GOT:hello") {
                    break;
                }
            }
        }

        let _ = handle.join();
        assert!(
            combined.contains("GOT:hello"),
            "expected echoed input; got: {combined:?}"
        );
    }

    #[test]
    fn resize_updates_pty_winsize() {
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            ..Default::default()
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
                Some("/bin/sleep 0.5; /bin/stty size"),
                &tempdir,
                &ctx,
                ch,
                "/bin/sh",
                &[],
                None,
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
}
