//! Generic "spawn child, wait with timeout, kill on hang" helper.
//!
//! Used by the user-agent probe and by the delegated-refresh path. The
//! keychain `/usr/bin/security` reader has its own slightly heavier
//! variant in `keychain.rs` because it also `setpgid`'s the child and
//! kills the whole process group, which is overkill for the simpler
//! short-lived `claude` invocations handled here.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Run `cmd`, capture stdout, and return it as a `String` on success
/// (exit code 0). Returns `None` on any failure: spawn error, non-zero
/// exit, timeout, or read error.
pub(super) fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Option<String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                use std::io::Read;
                let mut buf = String::new();
                child.stdout.as_mut()?.read_to_string(&mut buf).ok()?;
                return Some(buf);
            }
            Ok(Some(_)) => return None,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

/// Like `run_with_timeout` but only cares about the exit status —
/// stdout/stderr are discarded. Used when we just want to know whether
/// a command succeeded (e.g. delegated `claude auth status`).
pub(super) fn wait_with_timeout(
    cmd: &mut Command,
    timeout: Duration,
) -> Option<std::process::ExitStatus> {
    let mut child = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_with_timeout_returns_stdout_on_success() {
        let mut cmd = Command::new("/bin/echo");
        cmd.arg("hello");
        let out = run_with_timeout(&mut cmd, Duration::from_secs(2)).expect("should succeed");
        assert_eq!(out.trim(), "hello");
    }

    #[test]
    fn run_with_timeout_returns_none_on_nonzero_exit() {
        let mut cmd = Command::new("/usr/bin/false");
        let out = run_with_timeout(&mut cmd, Duration::from_secs(2));
        assert!(out.is_none());
    }

    #[test]
    fn run_with_timeout_kills_long_running_process() {
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("5");
        let started = Instant::now();
        let out = run_with_timeout(&mut cmd, Duration::from_millis(200));
        assert!(out.is_none());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "should have killed sleep before its 5s ran out"
        );
    }

    #[test]
    fn wait_with_timeout_returns_status_on_success() {
        let mut cmd = Command::new("/bin/echo");
        cmd.arg("ok");
        let status = wait_with_timeout(&mut cmd, Duration::from_secs(2)).expect("should run");
        assert!(status.success());
    }

    #[test]
    fn wait_with_timeout_returns_status_on_nonzero_exit() {
        let mut cmd = Command::new("/usr/bin/false");
        let status = wait_with_timeout(&mut cmd, Duration::from_secs(2)).expect("should run");
        assert!(!status.success());
    }

    #[test]
    fn wait_with_timeout_returns_none_when_killed() {
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("5");
        let started = Instant::now();
        let status = wait_with_timeout(&mut cmd, Duration::from_millis(200));
        assert!(status.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
