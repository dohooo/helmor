//! Process spawning, liveness, and process-tree teardown.

use std::process::Command;
use std::time::{Duration, Instant};

#[cfg(unix)]
pub type Pid = libc::pid_t;

#[cfg(not(unix))]
pub type Pid = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessTree {
    pub pid: Pid,
    pub pgid: Pid,
}

impl ProcessTree {
    pub fn new(pid: Pid, pgid: Pid) -> Self {
        Self { pid, pgid }
    }

    pub fn from_child_pid(pid: u32) -> Self {
        let pid = pid as Pid;
        Self::new(pid, pid)
    }
}

/// Configure a child as the root of a process tree.
pub fn configure_tree_root(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    configure_background_cli(cmd)
}

/// Configure a background CLI spawn so it cannot steal focus on platforms
/// where console children are visible by default.
pub fn configure_background_cli(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// [`configure_background_cli`] for `tokio::process::Command`.
pub fn configure_background_cli_tokio(
    cmd: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn terminate_tree(tree: ProcessTree) {
    #[cfg(unix)]
    unsafe {
        if can_signal_group(tree.pgid) {
            libc::killpg(tree.pgid, libc::SIGTERM);
        }
        if tree.pid > 0 {
            libc::kill(tree.pid, libc::SIGTERM);
        }
    }

    #[cfg(windows)]
    {
        let _ = taskkill(tree.pid, false);
    }
}

pub fn kill_tree(tree: ProcessTree) {
    #[cfg(unix)]
    unsafe {
        if can_signal_group(tree.pgid) {
            libc::killpg(tree.pgid, libc::SIGKILL);
        }
        if tree.pid > 0 {
            libc::kill(tree.pid, libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    {
        let _ = taskkill(tree.pid, true);
    }
}

pub fn pid_alive(pid: Pid) -> bool {
    if pid <= 0 as Pid {
        return false;
    }

    #[cfg(unix)]
    unsafe {
        if libc::kill(pid, 0) == 0 {
            return true;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => false,
            Some(libc::EPERM) => true,
            _ => true,
        }
    }

    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
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

    #[cfg(not(any(unix, windows)))]
    {
        // Other non-Unix targets keep the conservative stub.
        let _ = pid;
        false
    }
}

pub fn process_group_alive(pgid: Pid) -> bool {
    #[cfg(unix)]
    {
        if pgid <= 0 {
            return false;
        }
        let ret = unsafe { libc::killpg(pgid, 0) };
        if ret == 0 {
            return true;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => false,
            Some(libc::EPERM) => true,
            _ => true,
        }
    }

    #[cfg(not(unix))]
    {
        let _ = pgid;
        false
    }
}

pub fn tree_gone(tree: ProcessTree) -> bool {
    let pid_gone = !pid_alive(tree.pid);
    let group_gone = !can_signal_group(tree.pgid) || !process_group_alive(tree.pgid);
    pid_gone && group_gone
}

pub fn wait_for_tree_gone(tree: ProcessTree, timeout: Duration, poll: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if tree_gone(tree) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(poll);
    }
}

fn can_signal_group(pgid: Pid) -> bool {
    #[cfg(unix)]
    {
        pgid > 0 && pgid != unsafe { libc::getpgrp() }
    }

    #[cfg(not(unix))]
    {
        let _ = pgid;
        false
    }
}

#[cfg(windows)]
fn taskkill(pid: Pid, force: bool) -> std::io::Result<std::process::ExitStatus> {
    let pid = pid.to_string();
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", pid.as_str(), "/T"]);
    if force {
        cmd.arg("/F");
    }
    configure_background_cli(&mut cmd);
    cmd.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_alive_reports_current_process() {
        assert!(pid_alive(std::process::id() as Pid));
    }

    #[test]
    fn pid_alive_rejects_invalid_pids() {
        assert!(!pid_alive(0 as Pid));
        #[cfg(unix)]
        assert!(!pid_alive(-1));
    }

    #[cfg(unix)]
    #[test]
    fn kill_tree_reaches_background_children() {
        use std::io::Write;
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;

        let mut pid_file = tempfile::NamedTempFile::new().unwrap();
        let pid_path = pid_file.path().to_path_buf();
        writeln!(pid_file, "pending").unwrap();

        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(format!("sleep 30 & echo $! > {}; wait", pid_path.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = command.spawn().unwrap();
        let pid = child.id() as Pid;
        let pgid = unsafe { libc::getpgid(pid) };
        let tree = ProcessTree::new(pid, pgid);

        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if let Ok(contents) = std::fs::read_to_string(&pid_path) {
                if contents.trim().parse::<Pid>().is_ok() {
                    break;
                }
            }
            assert!(Instant::now() < deadline, "background pid was not written");
            std::thread::sleep(Duration::from_millis(10));
        }

        kill_tree(tree);
        let _ = child.wait();

        assert!(
            wait_for_tree_gone(tree, Duration::from_secs(2), Duration::from_millis(10)),
            "process tree should be gone"
        );
    }
}
