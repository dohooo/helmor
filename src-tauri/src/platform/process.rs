//! Cross-platform child-process group management.
//!
//! Helmor spawns long-lived child trees (the Bun sidecar, which itself spawns
//! the Claude/Codex CLIs; `cloudflared`; `git`/`ssh`; user scripts) and must be
//! able to tear down the *whole tree*, not just the direct child. It also
//! persists child PIDs to SQLite and probes their liveness across app restarts
//! (see `workspace/runtime_registry.rs`), so the abstraction is intentionally
//! **PID-based** — there is no process-local handle to store.
//!
//! - **Unix:** the child leads a new process group (`setpgid` via
//!   `process_group(0)`); tree signals target the negative PGID (== child PID).
//! - **Windows:** there are no process groups in the POSIX sense, so tree-kill
//!   walks the parent/child tree with `taskkill /T`. This mirrors the
//!   already-present Windows path in `forge/command.rs`. Children are spawned
//!   with `CREATE_NO_WINDOW` so console CLIs don't flash a window.

use std::process::Command;

/// Configure `cmd` so the spawned child can later be torn down as a whole tree.
///
/// Call this on the `Command` *before* `spawn()`. On Unix it makes the child a
/// process-group leader. On Windows it suppresses console windows for child
/// CLIs (tree termination itself is handled by [`kill_tree`]/[`terminate_tree`]
/// via `taskkill /T`, which does not require a process group).
pub fn configure_new_group(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000): don't pop a console for child CLIs.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Request a graceful stop of the child and its entire tree.
///
/// Unix sends `SIGTERM` to the process group. Windows runs `taskkill /T`
/// (without `/F`), which posts `WM_CLOSE` to GUI children and lets the tree
/// shut down cooperatively; callers escalate to [`kill_tree`] after a grace
/// period if the process is still alive.
pub fn terminate_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = taskkill(pid, false);
    }
}

/// Force-kill the child and its entire tree.
///
/// Unix sends `SIGKILL` to the process group; Windows runs `taskkill /T /F`.
/// Safe to call on an already-dead tree — both platforms treat "no such
/// process" as success.
pub fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = taskkill(pid, true);
    }
}

/// True if `pid` refers to a live process.
///
/// Unix uses `kill(pid, 0)` (treating `EPERM` as "alive but not ours").
/// Windows opens the process with limited-query rights and checks that its
/// exit code is still `STILL_ACTIVE`.
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    unsafe {
        if libc::kill(pid as libc::pid_t, 0) == 0 {
            return true;
        }
        matches!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EPERM)
        )
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(handle) => {
                    let mut code = 0u32;
                    let ok = GetExitCodeProcess(handle, &mut code).is_ok();
                    let _ = CloseHandle(handle);
                    ok && code == STILL_ACTIVE.0 as u32
                }
                Err(_) => false,
            }
        }
    }
}

#[cfg(windows)]
fn taskkill(pid: u32, force: bool) -> std::io::Result<std::process::ExitStatus> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let pid = pid.to_string();
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", pid.as_str(), "/T"]);
    if force {
        cmd.arg("/F");
    }
    cmd.creation_flags(CREATE_NO_WINDOW).status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_is_alive() {
        assert!(pid_alive(std::process::id()));
    }

    #[test]
    fn pid_zero_is_not_alive() {
        assert!(!pid_alive(0));
    }

    #[test]
    fn implausible_pid_is_not_alive() {
        // No real user process will own this PID.
        assert!(!pid_alive(u32::MAX - 1));
    }
}
