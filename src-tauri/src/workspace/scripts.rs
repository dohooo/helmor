use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::platform::process::Pid;
use crate::platform::pty::PtyWriter;

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
    /// cleanup and goes straight to SIGKILL on re-click).
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
const PTY_POLL_INTERVAL: Duration = Duration::from_millis(25);
const PTY_WRITE_RETRY: Duration = Duration::from_millis(5);
const PTY_WRITE_DEADLINE: Duration = Duration::from_millis(500);
const STOP_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// PTY reader output coalescing: buffer bytes and emit one Stdout event per
/// flush window or byte threshold (whichever first) to cut per-event IPC cost
/// on high-throughput output.
const PTY_FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const PTY_FLUSH_BYTES: usize = 16 * 1024;
const PTY_READ_BUF_BYTES: usize = 16 * 1024;

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
/// without owning the `Child`. The owner of the `Child` is `run_script`, which
/// blocks on `child.wait()` *without holding any lock* — that's the whole
/// point of this split. `kill()` only signals; reaping stays with `run_script`.
#[derive(Clone)]
struct ProcessHandle {
    pid: Pid,
    pgid: Pid,
    /// Shared with `run_script`'s local handle; set by `kill()` or by a
    /// concurrent `register()` that replaces us. `run_script` reads this
    /// after wait() to decide whether to report a real exit code or None.
    killed: Arc<AtomicBool>,
    /// Writable side of the PTY master. `Mutex` because `File::write` takes
    /// `&mut self`; actual contention is negligible (one writer per keypress
    /// burst). Keeping this alive is what makes Ctrl+C and typing work —
    /// without it, the PTY master would close right after the initial command.
    stdin: Arc<Mutex<Box<dyn PtyWriter>>>,
    /// Per-action graceful-stop config. `None` keeps today's behavior:
    /// SIGTERM → 200ms → SIGKILL with no detour through stop.command.
    stop: Option<Arc<ScriptStop>>,
    /// CAS'd to `true` the first time `graceful_kill` runs for this
    /// handle. A second Stop click while stop.command is still in flight
    /// CAS'es back true → graceful_kill skips the wait and SIGKILLs the
    /// main process immediately (frontend renders this as "Force Stop").
    stopping: Arc<AtomicBool>,
    /// pgid of the in-flight stop.command. Set by the first
    /// `graceful_kill` thread once it has spawned the cleanup process,
    /// cleared when that process exits. The Force Stop path (and the
    /// rerun / kill_others / kill_all paths) read this under lock and
    /// `killpg(SIGKILL)` it so the cleanup process doesn't outlive the
    /// user's intent — otherwise restarting a workspace or quitting
    /// Helmor would leak the background sleep / docker compose down.
    stop_pgid: Arc<Mutex<Option<Pid>>>,
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
    ///
    /// The collision branch (and `kill_others_in_repo` / `kill_all` below)
    /// intentionally bypasses *running* `stop.command` — graceful cleanup
    /// is wired only for the explicit Stop button path. But any
    /// `stop.command` *already in flight* from a prior Stop click is
    /// SIGKILL'd here so it doesn't outlive the new operation; otherwise
    /// rerun / kill_others / kill_all would leak the background cleanup
    /// process.
    fn register(
        &self,
        key: ProcessKey,
        pid: Pid,
        pgid: Pid,
        stdin: Arc<Mutex<Box<dyn PtyWriter>>>,
        stop: Option<ScriptStop>,
    ) -> Arc<AtomicBool> {
        let killed = Arc::new(AtomicBool::new(false));
        let handle = ProcessHandle {
            pid,
            pgid,
            killed: killed.clone(),
            stdin,
            stop: stop.map(Arc::new),
            stopping: Arc::new(AtomicBool::new(false)),
            stop_pgid: Arc::new(Mutex::new(None)),
        };
        let mut map = self.processes.lock().expect("process map poisoned");
        if let Some(old) = map.insert(key, handle) {
            old.killed.store(true, Ordering::Release);
            kill_in_flight_stop_command(&old.stop_pgid);
            escalating_kill(old.pid, old.pgid);
        }
        killed
    }

    /// Remove our handle from the map once `child.wait()` has returned.
    /// No-op if we were already replaced by a rerun.
    fn unregister(&self, key: &ProcessKey, pid: Pid) {
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
            kill_in_flight_stop_command(&h.stop_pgid);
            escalating_kill(h.pid, h.pgid);
        }
        count
    }

    /// Signal every live script and terminal handle the manager currently
    /// owns. Used by the graceful-quit path so Run-tab scripts and
    /// embedded-terminal PTY sessions don't outlive Helmor as orphan
    /// process trees. Returns the number of handles that were signaled.
    ///
    /// Mirrors `kill_others_in_repo`'s lock discipline: snapshot the
    /// handles under the map lock, drop the lock, then call
    /// `escalating_kill` for each. Holding the lock across the signal
    /// would block `run_script`'s post-wait `unregister` (which takes
    /// the same lock) and deadlock the quit path.
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
            kill_in_flight_stop_command(&h.stop_pgid);
            escalating_kill(h.pid, h.pgid);
        }
        count
    }

    /// Signal the process group (and leader as a fallback) with SIGTERM,
    /// escalating to SIGKILL after `PROCESS_TERM_TIMEOUT`. Returns true if
    /// there was a live handle to signal.
    ///
    /// When the handle carries a `stop.command`, that runs first (output
    /// piped into the same script channel) and the SIGTERM/SIGKILL only
    /// runs after it exits. A second `kill()` call while stop.command is
    /// still in flight short-circuits straight to SIGKILL — the
    /// frontend's "Force Stop" button uses this. The stop.command branch
    /// runs on a background thread so the Tauri IPC call returns
    /// immediately; the `killed` flag is flipped synchronously so racing
    /// readers still report a clean kill exit code.
    ///
    /// When the handle has **no** stop.command configured, this stays on
    /// the caller's thread (matching the pre-feature behavior exactly)
    /// — avoiding an extra thread spawn per Stop click for the 95% of
    /// run actions that don't need a graceful cleanup. Does **not**
    /// reap — `run_script`'s `child.wait()` still owns that.
    pub fn kill(&self, key: &ProcessKey) -> bool {
        let handle = {
            let map = self.processes.lock().expect("process map poisoned");
            map.get(key).cloned()
        };
        match handle {
            Some(h) => {
                h.killed.store(true, Ordering::Release);
                // Fast path: no stop.command and not in the middle of one
                // → behave exactly as the pre-feature code did
                // (inline signal sequence, no background thread).
                if h.stop.is_none() && !h.stopping.load(Ordering::Acquire) {
                    escalating_kill(h.pid, h.pgid);
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
        file.resize(cols, rows)?;
        Ok(true)
    }
}

/// Send SIGTERM (and SIGKILL after a short grace period) to a process group
/// and its leader. Polls `kill(pid, 0)` to detect when the leader has been
/// reaped by its parent — which is `run_script`'s `child.wait()` running on
/// a separate thread. When the script owns a separate process group, also wait
/// for that group to disappear so a fast leader exit cannot leave descendants
/// running after Stop returns.
fn escalating_kill(pid: Pid, pgid: Pid) {
    let tree = crate::platform::process::ProcessTree::new(pid, pgid);
    crate::platform::process::terminate_tree(tree);

    if crate::platform::process::wait_for_tree_gone(tree, PROCESS_TERM_TIMEOUT, PTY_POLL_INTERVAL) {
        return;
    }

    crate::platform::process::kill_tree(tree);
    let _ =
        crate::platform::process::wait_for_tree_gone(tree, PROCESS_KILL_TIMEOUT, PTY_POLL_INTERVAL);
}

/// SIGKILL any `stop.command` cleanup tree currently published in
/// `pgid_slot`. Used by `register()` collision, `kill_others_in_repo`,
/// and `kill_all` — they bypass running a *new* `stop.command` but must
/// not leak one that's already in flight from a prior Stop click. No-op
/// when no cleanup is running. Mirrors the Force Stop short-circuit at
/// the top of `graceful_kill`.
fn kill_in_flight_stop_command(pgid_slot: &Mutex<Option<Pid>>) {
    let stop_pgid = *pgid_slot.lock().expect("stop_pgid mutex poisoned");
    if let Some(pgid) = stop_pgid.filter(|pgid| *pgid > 0) {
        crate::platform::process::kill_tree(crate::platform::process::ProcessTree::new(pgid, pgid));
    }
}

/// Outcome of running a configured `stop.command`. Each branch carries
/// enough info for `graceful_kill` to print a single human-readable
/// line into the run-action's terminal before signalling the main
/// process via `escalating_kill` (which happens unconditionally).
enum StopOutcome {
    CleanExit,
    NonZeroExit(Option<i32>),
    SpawnFailed(String),
}

/// Spawn `command` via `/bin/sh -c`, stream its stdout/stderr into the
/// supplied `event_tx`, and block until it exits. There is no timeout —
/// the user controls escalation via the "Force Stop" re-click, which
/// SIGKILL's the cleanup tree through `pgid_slot` and short-circuits
/// the wait.
///
/// The child is placed into its own process group via `setsid` so a
/// concurrent Force Stop (or rerun / kill_others / kill_all) that
/// reads `pgid_slot` can `killpg` the whole tree — a docker compose
/// down that itself shells out wouldn't otherwise be reachable.
/// Output is piped rather than PTY-allocated because cleanup commands
/// rarely benefit from a TTY and the simpler plumbing keeps the
/// failure surface small.
///
/// `pgid_slot` is published with the spawned child's process group id
/// once it's known, and cleared before this function returns.
fn run_stop_command(
    command: &str,
    working_dir: &str,
    ctx: &ScriptContext,
    event_tx: &Channel<ScriptEvent>,
    pgid_slot: &Mutex<Option<Pid>>,
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

    // Own process group (Unix) so a concurrent Force Stop can SIGKILL the whole
    // cleanup tree; on Windows `taskkill /T` reaches the tree by PID. The
    // OS-specific spawn flags live behind the `platform::process` seam.
    crate::platform::process::configure_tree_root(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return StopOutcome::SpawnFailed(format!("{e}")),
    };
    let pid = child.id() as Pid;
    // Process-group id of the cleanup tree's root. On Unix the child is its own
    // session leader (`configure_tree_root` → `setsid`), so pgid == pid; we read
    // it back to be robust. On Windows there is no pgid concept — `taskkill /T`
    // walks the tree by PID — so the pid is the tree-root key.
    #[cfg(unix)]
    let pgid = unsafe { libc::getpgid(pid) };
    #[cfg(windows)]
    let pgid = pid;

    // Publish the tree-root id so a concurrent Force Stop can kill the cleanup
    // tree. Always cleared before return (deferred via the `outcome` binding
    // below).
    *pgid_slot.lock().expect("stop_pgid mutex poisoned") = Some(pgid);

    // Pipe stdout / stderr through dedicated reader threads so the user
    // sees progress in the same xterm as the main run output. The
    // variant constructor tags bytes as Stdout / Stderr so terminal
    // styling (red for stderr) survives.
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
                // Don't leak the child + its reader threads on a
                // try_wait failure — SIGKILL the pgid (or pid as
                // fallback) and reap so the pipe ends close.
                crate::platform::process::kill_tree(crate::platform::process::ProcessTree::new(
                    pid, pgid,
                ));
                let _ = child.wait();
                break StopOutcome::SpawnFailed(format!("try_wait failed: {e}"));
            }
        }
    };

    // Drain the pipes so the user sees the last bytes before the kill
    // message — the threads exit naturally when read() returns 0 / Err.
    if let Some(h) = stdout_thread {
        let _ = h.join();
    }
    if let Some(h) = stderr_thread {
        let _ = h.join();
    }

    // Clear the published pgid before returning. Force Stop reading
    // after this point sees `None` and skips the SIGKILL — the cleanup
    // is already done so no signal is needed.
    *pgid_slot.lock().expect("stop_pgid mutex poisoned") = None;

    outcome
}

/// Graceful Stop sequence for one process handle:
///
///   1. First `kill()` flips `stopping`. If a stop.command is configured
///      we emit `Stopping`, run it (output piped into the script's
///      channel), then proceed to `escalating_kill` on the main pid.
///   2. A second `kill()` while we're still inside step 1 short-circuits:
///      it CAS'es `stopping` true a second time and jumps straight to
///      `escalating_kill`. The frontend renders this as "Force Stop".
///   3. With no stop.command configured the call is identical to the
///      pre-feature path — straight to `escalating_kill`.
fn graceful_kill(handle: ProcessHandle) {
    // Race guard: if `stopping` was already true this is a re-click
    // ("Force Stop"). Kill the in-flight cleanup tree so the first
    // graceful_kill thread isn't left waiting on an abandoned child,
    // then escalating_kill the main process. Both threads converge
    // safely — the first one's wait() returns and its own
    // escalating_kill sees the dead pid and no-ops.
    if handle.stopping.swap(true, Ordering::AcqRel) {
        kill_in_flight_stop_command(&handle.stop_pgid);
        escalating_kill(handle.pid, handle.pgid);
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
            &handle.stop_pgid,
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

    escalating_kill(handle.pid, handle.pgid);
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
    /// runs (onboarding auth terminals, etc.) where there is no
    /// workspace to anchor a stable range to.
    pub port_base: Option<u16>,
    /// Size of the port block starting at `port_base`. Surfaces to
    /// scripts as `HELMOR_PORT_COUNT`. Always paired with `port_base`.
    pub port_count: Option<u16>,
}

/// Escape a string for safe embedding inside single quotes.
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
///
/// `stop` carries the optional graceful-stop config attached to the
/// originating `RunAction`. Setup / archive scripts have no notion of
/// stop.command and should pass `None`.
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
        None,
        stop,
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
    initial_size: Option<(u16, u16)>,
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
        initial_size,
        None,
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
    initial_size: Option<(u16, u16)>,
    stop: Option<ScriptStop>,
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
        // Truecolor advertisement — without it chalk/supports-color caps at
        // 256 colors and CLIs quantize their palette (orange → pink).
        .env("COLORTERM", "truecolor")
        .env("FORCE_COLOR", "3")
        .env("CLICOLOR_FORCE", "1")
        .env("HELMOR_ROOT_PATH", &context.root_path);

    // Prevent history pollution from the interactive shell (Unix shells only;
    // these variables are POSIX-shell concepts and the value is a Unix path).
    #[cfg(unix)]
    {
        cmd.env("HISTFILE", "/dev/null")
            .env("SAVEHIST", "0")
            .env("HISTSIZE", "0");
    }

    if let Some(wp) = &context.workspace_path {
        cmd.env("HELMOR_WORKSPACE_PATH", wp);
    }
    if let Some(wn) = &context.workspace_name {
        cmd.env("HELMOR_WORKSPACE_NAME", wn);
    }
    if let Some(db) = &context.default_branch {
        cmd.env("HELMOR_DEFAULT_BRANCH", db);
    }
    // Per-workspace port range. Only emit both vars together so scripts
    // can rely on `HELMOR_PORT_COUNT` being present whenever `HELMOR_PORT`
    // is. Both are absent for non-workspace runs (onboarding terminals).
    if let (Some(base), Some(count)) = (context.port_base, context.port_count) {
        cmd.env("HELMOR_PORT", base.to_string());
        cmd.env("HELMOR_PORT_COUNT", count.to_string());
    }

    // Open a PTY, make the child a session + controlling-terminal leader, and
    // attach it. The OS-specific PTY mechanics live behind the
    // `platform::pty` seam; macOS/Unix is the reference, Windows fills ConPTY.
    let session = crate::platform::pty::spawn_with_size(cmd, initial_size)
        .with_context(|| format!("Failed to spawn {shell_path}"))?;
    // Writable PTY master, kept alive in `ProcessHandle` for the lifetime of
    // the child so `write_stdin` / `resize` can reach the PTY.
    let stdin = Arc::new(Mutex::new(session.writer));
    let reader_file = session.reader;
    let mut child = session.child;
    let pid = child.id() as Pid;
    let pgid = session.pgid;

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
    let killed = manager.register(key.clone(), pid, pgid, stdin.clone(), stop);

    // Persist a registry row so the next launch's crash-recovery
    // sweep can classify this PID if the app dies before
    // `record_ended` runs below. Best-effort — a registry write
    // failure must NOT block the actual script run, so we log and
    // continue. Returns `None` on failure; `record_ended` no-ops
    // when the id is missing.
    // The registry stores PIDs as i32 (Unix `pid_t`). On Unix `Pid` is already
    // i32; on Windows it is u32, so reinterpret the bits. Crash recovery only
    // compares this against live PIDs read back through the same path. The
    // cfg-gated rebinds keep the cast a no-op on Unix (no `unnecessary_cast`).
    #[cfg(unix)]
    let (pid_i32, pgid_i32): (i32, i32) = (pid, pgid);
    #[cfg(windows)]
    let (pid_i32, pgid_i32): (i32, i32) = (pid as i32, pgid as i32);
    let registry_id = match super::runtime_registry::record_started(
        repo_id,
        workspace_id,
        script_type,
        pid_i32,
        pgid_i32,
    ) {
        Ok(id) => Some(id),
        Err(error) => {
            tracing::warn!(
                pid,
                pgid,
                %error,
                "runtime registry: failed to record process start; crash recovery will miss this row"
            );
            None
        }
    };

    // Single reader on the PTY master — stdout+stderr are merged by the PTY.
    // Uses poll(2) so the kernel wakes the thread the instant data is
    // readable instead of the legacy 25ms `sleep` loop. The PTY master keeps
    // O_NONBLOCK so we can drain everything available after each wake without
    // re-entering poll for each chunk; write_stdin also benefits (PTY full
    // → WouldBlock instead of blocking the IPC thread).
    let ch = channel.clone();
    let stop_reader = Arc::new(AtomicBool::new(false));
    let stop_reader_in_thread = stop_reader.clone();
    let reader = std::thread::Builder::new()
        .name("script-pty".into())
        .spawn(move || {
            let mut master = reader_file;
            let mut buf = [0u8; PTY_READ_BUF_BYTES];
            // 100ms tick is just a stop-flag fallback — kill() also closes
            // the PTY which triggers EIO/POLLHUP and wakes us instantly.
            const POLL_TIMEOUT_MS: i32 = 100;

            // Coalesce output: buffer bytes and emit one Stdout event per flush
            // window instead of one per read, collapsing a chatty producer's
            // hundreds of tiny IPC sends into a few large ones.
            let mut pending: Vec<u8> = Vec::with_capacity(PTY_READ_BUF_BYTES);
            let mut last_flush = Instant::now();

            // Emit the valid UTF-8 prefix, keeping any trailing incomplete
            // multi-byte sequence buffered until its remaining bytes arrive.
            let flush_pending = |pending: &mut Vec<u8>, last_flush: &mut Instant| {
                if pending.is_empty() {
                    return;
                }
                let valid = match std::str::from_utf8(pending) {
                    Ok(_) => pending.len(),
                    Err(e) => e.valid_up_to(),
                };
                if valid == 0 {
                    // Incomplete leading sequence — wait for the rest. Guard
                    // against genuine garbage stalling the buffer by flushing
                    // lossily once it exceeds the max UTF-8 sequence length.
                    if pending.len() > 4 {
                        let data = String::from_utf8_lossy(pending).into_owned();
                        let _ = ch.send(ScriptEvent::Stdout { data });
                        pending.clear();
                        *last_flush = Instant::now();
                    }
                    return;
                }
                let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
                let _ = ch.send(ScriptEvent::Stdout { data });
                pending.drain(..valid);
                *last_flush = Instant::now();
            };
            loop {
                if stop_reader_in_thread.load(Ordering::Relaxed) {
                    break;
                }

                // While bytes are buffered, cap the wait at the time left in
                // the flush window — otherwise a lone small burst (a keystroke
                // echo, a spinner frame) sits unflushed for the full 100ms
                // idle tick and typing feels laggy.
                let timeout_ms: i32 = if pending.is_empty() {
                    POLL_TIMEOUT_MS
                } else {
                    let elapsed = last_flush.elapsed();
                    if elapsed >= PTY_FLUSH_INTERVAL {
                        // Past the window with bytes still buffered — only an
                        // unflushable incomplete UTF-8 tail does that (the loop
                        // tail flushes everything else). Wait for its rest at
                        // the idle tick instead of spinning at 0ms.
                        POLL_TIMEOUT_MS
                    } else {
                        (PTY_FLUSH_INTERVAL - elapsed).as_millis().max(1) as i32
                    }
                };

                // POLLHUP / POLLERR fire when the slave fd is closed (child
                // exited). We still try to read first so any pending bytes
                // ahead of the hangup are delivered.
                let hung_up = match master.poll_readable(timeout_ms) {
                    Ok(crate::platform::pty::PollResult::TimedOut) => {
                        // Idle wake — flush any buffered tail so a quiet PTY
                        // doesn't sit on coalesced bytes until the next read.
                        flush_pending(&mut pending, &mut last_flush);
                        continue;
                    }
                    Ok(crate::platform::pty::PollResult::Interrupted) => continue,
                    Ok(crate::platform::pty::PollResult::Ready { hung_up }) => hung_up,
                    Err(err) => {
                        tracing::debug!(error = %err, "PTY poll failed");
                        break;
                    }
                };

                // Drain everything available in this wake cycle.
                let mut should_exit = hung_up;
                loop {
                    match master.read(&mut buf) {
                        Ok(0) => {
                            should_exit = true;
                            break;
                        }
                        Ok(n) => {
                            pending.extend_from_slice(&buf[..n]);
                            // Bound buffer growth within one drain so a fast
                            // producer can't balloon memory before the timer.
                            if pending.len() >= PTY_FLUSH_BYTES {
                                flush_pending(&mut pending, &mut last_flush);
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            // Drained for now — back to poll().
                            break;
                        }
                        Err(e) => {
                            // EIO is expected when the child exits and slave closes.
                            if !crate::platform::pty::is_session_disconnect(&e) {
                                tracing::debug!(error = %e, "PTY read error");
                            }
                            should_exit = true;
                            break;
                        }
                    }
                }

                // Time-based flush once this wake cycle is drained.
                if last_flush.elapsed() >= PTY_FLUSH_INTERVAL {
                    flush_pending(&mut pending, &mut last_flush);
                }

                if should_exit {
                    break;
                }
            }

            // Final flush — emit remaining bytes (lossy for an incomplete
            // trailing sequence) so the tail isn't dropped on exit.
            if !pending.is_empty() {
                let data = String::from_utf8_lossy(&pending).into_owned();
                let _ = ch.send(ScriptEvent::Stdout { data });
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
        let wrapped = wrapped_script_for_shell(shell_path, script);
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

    // Mark the registry row ended once the child has been reaped.
    // Failure here logs and continues — the next launch's
    // classifier will probe the PID and stamp it as dead anyway.
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

// Unix-only test suite: these exercise the PTY/process-group lifecycle through
// libc primitives (`setsid`, `getpgid`, `kill`), `/bin/sh`, and the Unix PTY
// writer, so they only compile and run on Unix. The cross-platform pure-logic
// tests (shell escaping, wrapper selection, unknown-key no-ops) live in the
// `cross_platform_tests` module below and run on every target.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Command as StdCommand;
    use std::sync::mpsc;
    use tempfile::NamedTempFile;

    // Pure string-logic tests (shell_escape, fish/powershell wrapping) and the
    // unknown-key no-op tests live in `cross_platform_tests` below so they run
    // on every target; this module keeps only the Unix PTY/process-group tests.

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
        let stdin_arc: Arc<Mutex<Box<dyn crate::platform::pty::PtyWriter>>> = Arc::new(Mutex::new(
            Box::new(crate::platform::pty::UnixPtyWriter(stdin)),
        ));
        let killed = mgr.register(key, pid, pgid, stdin_arc, None);
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

    // ── kill_all (graceful-quit path) ──────────────────────────────────────

    #[test]
    fn kill_all_signals_every_registered_handle_across_repos_and_script_types() {
        let mgr = ScriptProcessManager::new();
        // Mixed registry: two scripts in one repo, one terminal in
        // another, and a forge-auth-style no-workspace entry. kill_all
        // must hit every single one.
        let a_run: ProcessKey = ("A".into(), "run".into(), Some("ws-1".into()));
        let a_setup: ProcessKey = ("A".into(), "setup".into(), Some("ws-1".into()));
        let b_terminal: ProcessKey = ("B".into(), "terminal:abc".into(), Some("ws-other".into()));
        let auth: ProcessKey = ("__auth__".into(), "agent-login:claude".into(), None);

        let (mut c1, _, _, k1) = spawn_and_register(&mgr, a_run.clone());
        let (mut c2, _, _, k2) = spawn_and_register(&mgr, a_setup.clone());
        let (mut c3, _, _, k3) = spawn_and_register(&mgr, b_terminal.clone());
        let (mut c4, _, _, k4) = spawn_and_register(&mgr, auth.clone());

        let signaled = mgr.kill_all();
        assert_eq!(signaled, 4);

        // Reap each child to release pid resources, then prove the
        // killed flag was flipped on every handle.
        let _ = c1.wait();
        let _ = c2.wait();
        let _ = c3.wait();
        let _ = c4.wait();
        assert!(k1.load(Ordering::Acquire));
        assert!(k2.load(Ordering::Acquire));
        assert!(k3.load(Ordering::Acquire));
        assert!(k4.load(Ordering::Acquire));
    }

    #[test]
    fn kill_all_with_empty_manager_is_zero() {
        let mgr = ScriptProcessManager::new();
        assert_eq!(mgr.kill_all(), 0);
    }

    /// Regression: `kill_all` must drop the process-map lock BEFORE
    /// signaling, otherwise the `run_script` thread's post-wait
    /// `unregister` — which takes the same lock — would deadlock the
    /// quit path. We exercise the exact ordering by spawning a real
    /// `run_script` that exits the moment it's signaled (so its reaper
    /// thread calls `unregister` while `kill_all` is still iterating
    /// over its victim list). The test would hang the suite if the
    /// lock were held; finishing under the timeout proves the
    /// invariant.
    #[test]
    fn kill_all_does_not_deadlock_against_concurrent_unregister() {
        let _env = crate::testkit::TestEnv::new("kill-all-does-not-deadlock-against-concu");
        let mgr = std::sync::Arc::new(ScriptProcessManager::new());
        let ctx = ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
            port_base: None,
            port_count: None,
        };
        let key: ProcessKey = ("repo".into(), "run".into(), Some("ws".into()));

        let mgr_c = mgr.clone();
        let key_c = key.clone();
        let tempdir = std::env::temp_dir().display().to_string();
        let mut runner = Some(std::thread::spawn(move || {
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
                None,
            )
        }));

        // Wait for run_script to register before we issue kill_all.
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if mgr.processes.lock().unwrap().contains_key(&key) {
                break;
            }
            if runner.as_ref().is_some_and(|runner| runner.is_finished()) {
                let result = runner.take().unwrap().join().unwrap();
                panic!("run_script exited before registration: {result:?}");
            }
            assert!(Instant::now() < deadline, "run_script never registered");
            std::thread::sleep(Duration::from_millis(10));
        }

        let start = Instant::now();
        assert_eq!(mgr.kill_all(), 1);
        // run_script's reaper must have unregistered + returned. If
        // kill_all held the map lock past the signal, the unregister
        // would have blocked and this join would hang.
        let _ = runner.unwrap().join().unwrap();
        // Real path is sub-second (PROCESS_TERM + PROCESS_KILL = 700ms
        // upper bound). 5s headroom for CI load; a real regression
        // (deadlock / missed signal) hangs indefinitely and still trips.
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "kill_all + reap took too long: {:?}",
            start.elapsed()
        );
        assert!(mgr.processes.lock().unwrap().is_empty());
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
        let _env = crate::testkit::TestEnv::new("kill-terminates-running-script-quickly");
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
            port_base: None,
            port_count: None,
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
        // 5s headroom for CI load; real path is sub-second.
        assert!(
            start.elapsed() < Duration::from_secs(5),
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
        let _env = crate::testkit::TestEnv::new("write-stdin-delivers-bytes-to-running-sc");
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
            port_base: None,
            port_count: None,
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
                None,
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
        let _env = crate::testkit::TestEnv::new("resize-updates-pty-winsize");
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
            port_base: None,
            port_count: None,
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

    // ── initial PTY size threads to the spawned shell ─────────────────────
    // The renderer's real cols/rows must reach the PTY at spawn time so an
    // inline TUI paints its first frame correctly (no fit/SIGWINCH ghosting).
    #[test]
    fn initial_size_sets_pty_winsize() {
        let _env = crate::testkit::TestEnv::new("initial-size-sets-pty-winsize");
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
            port_base: None,
            port_count: None,
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
                // No resize — `stty size` must report the spawn-time winsize.
                Some("/bin/stty size"),
                &tempdir,
                &ctx,
                ch,
                "/bin/sh",
                &[],
                None,
                Some((90, 40)),
                None,
            )
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut combined = String::new();
        while Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                combined.push_str(&chunk);
                // `stty size` prints "<rows> <cols>" — 40 rows, 90 cols.
                if combined.contains("40 90") {
                    break;
                }
            }
        }
        let _ = handle.join();
        assert!(
            combined.contains("40 90"),
            "expected 40 90 from stty size; got: {combined:?}"
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

    fn run_simple_with_shell(script: &str, shell_path: &str, shell_args: &[&str]) -> Option<i32> {
        let mgr = ScriptProcessManager::new();
        let dir = std::env::temp_dir();
        let ctx = ScriptContext {
            root_path: dir.display().to_string(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
            port_base: None,
            port_count: None,
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
            None,
        )
        .unwrap()
    }

    fn run_simple(script: &str) -> Option<i32> {
        // /bin/sh avoids the user's interactive zsh startup cost that
        // makes tests flaky under `cargo test` parallelism.
        run_simple_with_shell(script, "/bin/sh", &[])
    }

    #[test]
    fn run_script_true_exits_zero() {
        let _env = crate::testkit::TestEnv::new("run-script-true-exits-zero");
        assert_eq!(run_simple("true"), Some(0));
    }

    #[test]
    fn run_script_failing_command_exits_nonzero() {
        let _env = crate::testkit::TestEnv::new("run-script-failing-command-exits-nonzero");
        assert_eq!(run_simple("exit 42"), Some(42));
    }

    #[test]
    fn run_script_with_fish_shell_preserves_exit_status() {
        let Ok(output) = StdCommand::new("fish")
            .args(["-c", "command -s fish"])
            .output()
        else {
            return;
        };
        if !output.status.success() {
            return;
        }
        let fish_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if fish_path.is_empty() {
            return;
        }

        assert_eq!(
            run_simple_with_shell("printf '%s\\n' \"it's\"; exit 42", &fish_path, &[]),
            Some(42),
        );
    }

    /// End-to-end: a script with a populated `ScriptContext.port_base`
    /// sees `HELMOR_PORT` / `HELMOR_PORT_COUNT` in its env, and the
    /// existing env vars (HELMOR_ROOT_PATH, HELMOR_WORKSPACE_NAME, …)
    /// keep working alongside the new ones.
    #[test]
    fn script_env_includes_helmor_port_vars_when_range_present() {
        let _env = crate::testkit::TestEnv::new("script-env-includes-helmor-port-vars-whe");
        let mgr = ScriptProcessManager::new();
        let dir = std::env::temp_dir();
        let ctx = ScriptContext {
            root_path: dir.display().to_string(),
            workspace_path: Some(dir.display().to_string()),
            workspace_name: Some("ws-port".into()),
            default_branch: Some("main".into()),
            port_base: Some(55_100),
            port_count: Some(10),
        };

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

        let exit = run_script_with_shell(
            &mgr,
            "repo",
            "run",
            Some("ws-port"),
            // Sentinel-tag the output so we can spot the env values
            // amid the interactive-shell prompt / wrapper banner the
            // PTY also writes to stdout.
            Some(
                "printf 'PORT=%s|COUNT=%s|NAME=%s|ROOT=%s\\n' \
                  \"$HELMOR_PORT\" \"$HELMOR_PORT_COUNT\" \
                  \"$HELMOR_WORKSPACE_NAME\" \"$HELMOR_ROOT_PATH\"",
            ),
            dir.to_str().unwrap(),
            &ctx,
            ch,
            "/bin/sh",
            &[],
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(exit, Some(0));

        let mut combined = String::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(chunk) => {
                    combined.push_str(&chunk);
                    if combined.contains("PORT=55100|COUNT=10") {
                        break;
                    }
                }
                Err(_) => continue,
            }
        }
        assert!(
            combined.contains("PORT=55100|COUNT=10|NAME=ws-port"),
            "expected HELMOR_PORT/HELMOR_PORT_COUNT alongside legacy env; got: {combined:?}"
        );
        assert!(
            combined.contains(&format!("ROOT={}", dir.display())),
            "expected HELMOR_ROOT_PATH still injected; got: {combined:?}"
        );
    }

    /// When the workspace has no allocated range, the new env vars are
    /// absent (vs. set to empty strings) so scripts that fall back with
    /// `${HELMOR_PORT:-3000}` keep their default.
    #[test]
    fn script_env_omits_helmor_port_vars_when_range_missing() {
        let _env = crate::testkit::TestEnv::new("script-env-omits-helmor-port-vars-when-r");
        let mgr = ScriptProcessManager::new();
        let dir = std::env::temp_dir();
        let ctx = ScriptContext {
            root_path: dir.display().to_string(),
            workspace_path: Some(dir.display().to_string()),
            workspace_name: Some("ws-noport".into()),
            default_branch: Some("main".into()),
            port_base: None,
            port_count: None,
        };

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

        let exit = run_script_with_shell(
            &mgr,
            "repo",
            "run",
            Some("ws-noport"),
            // `${var+set}` expands to "set" if set (even when empty) and
            // to nothing otherwise. The sentinel intentionally puts the
            // expansion between two delimiters so we can tell "unset"
            // (PORT[]COUNT[]) apart from "set to empty" (PORT[set]COUNT[set])
            // even after the wrapper echoes the literal source line back.
            Some("printf 'PORT[%s]COUNT[%s]EOM\\n' \"${HELMOR_PORT+set}\" \"${HELMOR_PORT_COUNT+set}\""),
            dir.to_str().unwrap(),
            &ctx,
            ch,
            "/bin/sh",
            &[],
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(exit, Some(0));

        let mut combined = String::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(chunk) => {
                    combined.push_str(&chunk);
                    // `PORT[]COUNT[]` only materialises post-substitution
                    // — the source line carries `PORT[%s]COUNT[%s]`, so
                    // matching the substituted form lets us distinguish
                    // it from the wrapper's echo of the source line.
                    if combined.contains("PORT[]COUNT[]EOM") {
                        break;
                    }
                }
                Err(_) => continue,
            }
        }
        assert!(
            combined.contains("PORT[]COUNT[]EOM"),
            "expected HELMOR_PORT/HELMOR_PORT_COUNT to be unset; got: {combined:?}"
        );
    }

    // `run_script_rejects_empty` and the unknown-key no-op tests are
    // cross-platform and live in `cross_platform_tests` below.

    // ── graceful_kill (stop.command) ───────────────────────────────────────

    /// Build a Channel that forwards `(type, optional data)` of every
    /// ScriptEvent into a Receiver. Tests use this to wait for specific
    /// events (Stopping, Exited) and to assert that stop.command output
    /// landed in the same stream as the main run output.
    fn capture_events() -> (
        Channel<ScriptEvent>,
        mpsc::Receiver<(String, Option<String>)>,
    ) {
        let (tx, rx) = mpsc::channel::<(String, Option<String>)>();
        let ch = Channel::<ScriptEvent>::new(move |msg| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = msg {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
                    let ev_type = v
                        .get("type")
                        .and_then(|t| t.as_str())
                        .map(String::from)
                        .unwrap_or_default();
                    let data = v.get("data").and_then(|d| d.as_str()).map(String::from);
                    let _ = tx.send((ev_type, data));
                }
            }
            Ok(())
        });
        (ch, rx)
    }

    /// Block until either an event with `type == ev_type` arrives, or
    /// `timeout` elapses. Returns the data payload (if any).
    fn wait_for_event(
        rx: &mpsc::Receiver<(String, Option<String>)>,
        ev_type: &str,
        timeout: Duration,
    ) -> Option<Option<String>> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Ok((t, data)) = rx.recv_timeout(Duration::from_millis(100)) {
                if t == ev_type {
                    return Some(data);
                }
            }
        }
        None
    }

    fn empty_ctx() -> ScriptContext {
        ScriptContext {
            root_path: std::env::temp_dir().display().to_string(),
            workspace_path: None,
            workspace_name: None,
            default_branch: None,
            port_base: None,
            port_count: None,
        }
    }

    /// Stop.command exits cleanly → backend emits Stopping, streams the
    /// command's stdout into the same channel, and then SIGTERMs the run
    /// process. The run script reports None for its exit code because
    /// `killed` was flipped.
    ///
    /// Marked `#[ignore]` because each graceful_kill test spawns multiple
    /// subprocesses (run shell, stop.command, reader threads) and a full
    /// `cargo test --lib` already runs ~1100 tests in parallel. Adding
    /// this kind of fork/exec load to the default suite makes a couple of
    /// pre-existing PTY tests in this module flake under heavy macOS
    /// scheduling. Run explicitly with
    /// `cargo test --lib graceful_kill -- --ignored`, or include it in a
    /// focused `workspace::scripts` filter where the parallel load stays
    /// well under the flakiness threshold.
    #[test]
    #[ignore = "fork-heavy; run via `cargo test graceful_kill -- --ignored`"]
    fn graceful_kill_runs_stop_command_then_escalates() {
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = empty_ctx();
        let key: ProcessKey = ("repo".into(), "run".into(), Some("ws".into()));

        let (ch, rx) = capture_events();

        let stop = ScriptStop {
            command: "echo HELMOR_STOP_CALLED".to_string(),
            event_tx: ch.clone(),
            ctx: ctx.clone(),
            working_dir: std::env::temp_dir().display().to_string(),
        };

        let mgr_c = mgr.clone();
        let key_c = key.clone();
        let tempdir = std::env::temp_dir().display().to_string();
        let ctx_for_thread = ctx.clone();
        let handle = std::thread::spawn(move || {
            run_script_with_shell(
                &mgr_c,
                &key_c.0,
                &key_c.1,
                key_c.2.as_deref(),
                Some("sleep 60"),
                &tempdir,
                &ctx_for_thread,
                ch,
                "/bin/sh",
                &[],
                None,
                None,
                Some(stop),
            )
        });

        // Wait until run_script registers, then click Stop.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if mgr.processes.lock().unwrap().contains_key(&key) {
                break;
            }
            assert!(Instant::now() < deadline, "run_script never registered");
            std::thread::sleep(Duration::from_millis(10));
        }

        let start = Instant::now();
        assert!(mgr.kill(&key), "kill should find the live handle");

        // The Stopping event must arrive before the run process exits.
        assert!(
            wait_for_event(&rx, "stopping", Duration::from_secs(2)).is_some(),
            "Stopping event must fire when stop.command is configured"
        );

        // Wait for Exited.
        assert!(
            wait_for_event(&rx, "exited", Duration::from_secs(5)).is_some(),
            "run process should exit after stop.command + SIGTERM"
        );
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_secs(5),
            "graceful kill took too long: {elapsed:?}"
        );

        // The run_script thread returns once child.wait() completes —
        // killed flag was set, so exit code is None.
        let result = handle.join().unwrap();
        assert_eq!(
            result.unwrap(),
            None,
            "killed scripts should report None exit"
        );
    }

    /// Second `kill()` while stop.command is still running short-circuits
    /// straight to SIGKILL on the main process. The Force Stop button
    /// uses exactly this path. See the sibling test for why `#[ignore]`.
    #[test]
    #[ignore = "fork-heavy; run via `cargo test graceful_kill -- --ignored`"]
    fn graceful_kill_force_stop_on_second_click_short_circuits() {
        let mgr = Arc::new(ScriptProcessManager::new());
        let ctx = empty_ctx();
        let key: ProcessKey = ("repo".into(), "run".into(), Some("ws".into()));

        let (ch, rx) = capture_events();

        // Long-running stop.command — without the re-click escalation
        // this test would block until the sleep naturally finishes.
        let stop = ScriptStop {
            command: "/bin/sleep 30".to_string(),
            event_tx: ch.clone(),
            ctx: ctx.clone(),
            working_dir: std::env::temp_dir().display().to_string(),
        };

        let mgr_c = mgr.clone();
        let key_c = key.clone();
        let tempdir = std::env::temp_dir().display().to_string();
        let ctx_for_thread = ctx.clone();
        let handle = std::thread::spawn(move || {
            run_script_with_shell(
                &mgr_c,
                &key_c.0,
                &key_c.1,
                key_c.2.as_deref(),
                Some("sleep 60"),
                &tempdir,
                &ctx_for_thread,
                ch,
                "/bin/sh",
                &[],
                None,
                None,
                Some(stop),
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

        // First click — wait for Stopping to confirm we're inside the
        // graceful window before issuing the second click.
        assert!(mgr.kill(&key));
        assert!(
            wait_for_event(&rx, "stopping", Duration::from_secs(2)).is_some(),
            "Stopping must fire on first kill"
        );

        // Second click — short-circuit to SIGKILL.
        let start_force = Instant::now();
        assert!(mgr.kill(&key));
        assert!(
            wait_for_event(&rx, "exited", Duration::from_secs(5)).is_some(),
            "Force Stop should exit promptly, not wait 30s for stop.command"
        );
        let force_elapsed = start_force.elapsed();
        assert!(
            force_elapsed < Duration::from_secs(3),
            "Force Stop took too long: {force_elapsed:?}"
        );

        let _ = handle.join();
    }
}

/// Cross-platform pure-logic tests. These run on every target — they don't
/// spawn a PTY or touch any OS process primitives, so they validate the shell
/// escaping / wrapper selection and the manager's unknown-key no-op behavior
/// on both Unix and Windows.
#[cfg(test)]
mod cross_platform_tests {
    use super::*;
    use std::sync::mpsc;

    fn make_channel() -> Channel<ScriptEvent> {
        let (tx, _rx) = mpsc::channel::<()>();
        Channel::<ScriptEvent>::new(move |_| {
            let _ = tx.send(());
            Ok(())
        })
    }

    // ── shell_escape / wrapper selection (string logic) ────────────────────

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
        let dir = std::env::temp_dir().display().to_string();
        let result = run_script(&mgr, "r", "s", None, "  ", &dir, &ctx, make_channel(), None);
        assert!(result.is_err());
    }
}
