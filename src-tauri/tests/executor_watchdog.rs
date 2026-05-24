//! Integration tests for the `helmor-executor-watchdog` binary.
//!
//! The watchdog's contract has four critical paths; each gets a focused
//! test so a regression in any of them shows up with a precise failure
//! message instead of a vague "executor leaked again".
//!
//! 1. **Child-exit propagation.** When the watched child exits on its
//!    own, the watchdog exits with the same code.
//! 2. **Cooperative SIGTERM.** When the watchdog itself receives
//!    SIGTERM (the Helmor `request_quit` path), it forwards a TERM to
//!    its child's process group and exits 0 within the grace window.
//! 3. **Parent-death wakeup.** When the parent pid passed to the
//!    watchdog exits — even via SIGKILL — the kqueue `NOTE_EXIT`
//!    wakeup fires, the watchdog kills its child and exits 0.
//! 4. **Stale parent.** If the parent pid is already gone at
//!    registration time (race window), the watchdog treats that as
//!    parent-died and exits cleanly without orphaning the child.
//!
//! Each test also asserts that the watchdog reaped its child process —
//! we look up the grandchild pid by having the spawned shell `echo $$`
//! before `exec`-ing the long sleep, then poll `kill(pid, 0)` after
//! the watchdog exits to make sure the pid is gone (not just exited
//! but unreaped).

#![cfg(unix)]

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Cargo sets `CARGO_BIN_EXE_<bin-name>` to the absolute path of the
/// built binary when running its integration tests. Hyphens stay
/// hyphens here (not underscored), so the env var matches the
/// `[[bin]] name = "helmor-executor-watchdog"` entry.
fn watchdog_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_helmor-executor-watchdog"))
}

/// Spawn the watchdog with `parent_pid` and a single inline shell that:
///   1. prints its own pid to stdout (so the test learns the grandchild pid)
///   2. flushes stdout
///   3. `exec`-s the supplied command so the printed pid matches the
///      actual long-running grandchild we want to monitor.
///
/// Returns the watchdog handle and the grandchild pid.
fn spawn_watchdog_with_grandchild(parent_pid: u32, grandchild_cmd: &str) -> (Child, libc::pid_t) {
    let script = format!("echo $$; exec {grandchild_cmd}");
    let mut child = Command::new(watchdog_bin())
        .arg(parent_pid.to_string())
        .arg("--")
        .arg("/bin/sh")
        .arg("-c")
        .arg(&script)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn watchdog");

    let stdout = child.stdout.take().expect("watchdog stdout missing");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .expect("read grandchild pid line");
    let grandchild_pid: libc::pid_t = line.trim().parse().expect("grandchild pid integer");
    // Keep the reader alive by draining it on a thread, otherwise the
    // pipe would buffer-block once the shell process tried to write
    // additional output. Sleep is silent so this almost never matters,
    // but a stray newline shouldn't deadlock the test.
    std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = reader.read_to_end(&mut sink);
    });
    (child, grandchild_pid)
}

/// Poll `kill(pid, 0)` (signal 0 = "exists check") until the pid is
/// gone or the timeout elapses. Returns true if the pid disappeared.
fn wait_for_pid_gone(pid: libc::pid_t, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        // SAFETY: `kill` is async-signal-safe; signal 0 performs the
        // permission/existence check without delivering anything.
        let r = unsafe { libc::kill(pid, 0) };
        if r == -1 {
            let err = std::io::Error::last_os_error();
            // ESRCH = no such process. Everything else (EPERM, etc.)
            // is "still exists from kernel's POV" → keep waiting.
            if err.raw_os_error() == Some(libc::ESRCH) {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

/// Wait for `child` to exit within `timeout`. Returns the exit code or
/// `None` if it timed out.
fn wait_for_exit(child: &mut Child, timeout: Duration) -> Option<i32> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.code().unwrap_or(0)),
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
    None
}

#[test]
fn child_exit_propagates_status_zero() {
    let mut child = Command::new(watchdog_bin())
        .arg(std::process::id().to_string())
        .arg("--")
        .arg("/bin/sh")
        .arg("-c")
        .arg("exit 0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    let code = wait_for_exit(&mut child, Duration::from_secs(5));
    assert_eq!(code, Some(0), "watchdog should propagate child exit code");
}

#[test]
fn child_exit_propagates_nonzero_status() {
    let mut child = Command::new(watchdog_bin())
        .arg(std::process::id().to_string())
        .arg("--")
        .arg("/bin/sh")
        .arg("-c")
        .arg("exit 42")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    let code = wait_for_exit(&mut child, Duration::from_secs(5));
    assert_eq!(
        code,
        Some(42),
        "watchdog should propagate non-zero exit code"
    );
}

#[test]
fn missing_command_exits_with_usage() {
    let mut child = Command::new(watchdog_bin())
        .arg("12345")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    let code = wait_for_exit(&mut child, Duration::from_secs(5));
    assert_eq!(code, Some(2), "watchdog should reject missing command");
}

#[test]
fn invalid_parent_pid_exits_with_usage() {
    let mut child = Command::new(watchdog_bin())
        .arg("not-a-pid")
        .arg("--")
        .arg("/usr/bin/true")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    let code = wait_for_exit(&mut child, Duration::from_secs(5));
    assert_eq!(
        code,
        Some(2),
        "watchdog should reject non-numeric parent pid"
    );
}

#[test]
fn sigterm_to_watchdog_kills_grandchild_and_exits() {
    let (mut watchdog, grandchild_pid) =
        spawn_watchdog_with_grandchild(std::process::id(), "sleep 120");

    // Wait for the watchdog to actually register kqueue signal events.
    // The race window is tiny (single syscall) but real — without the
    // grace, a SIGTERM that lands BEFORE registration would be SIG_IGN'd
    // and silently dropped. 200ms covers cold-start + spawn fork on a
    // slow CI box.
    std::thread::sleep(Duration::from_millis(200));

    // SAFETY: signaling a known-alive child pid; SIGTERM is the
    // standard cooperative-shutdown signal.
    unsafe {
        libc::kill(watchdog.id() as libc::pid_t, libc::SIGTERM);
    }

    let code = wait_for_exit(&mut watchdog, Duration::from_secs(8));
    assert_eq!(code, Some(0), "watchdog should exit 0 on SIGTERM");
    assert!(
        wait_for_pid_gone(grandchild_pid, Duration::from_secs(2)),
        "grandchild pid {grandchild_pid} should be reaped after watchdog exits"
    );
}

#[test]
fn parent_death_kills_grandchild_and_exits() {
    // Use a throwaway `sleep` process as the "parent" — kqueue's
    // EVFILT_PROC works on any pid, not just the watcher's actual
    // parent, so this is enough to drive the NOTE_EXIT wakeup.
    let mut fake_parent = Command::new("/bin/sleep")
        .arg("120")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn fake parent");
    let fake_parent_pid = fake_parent.id();

    let (mut watchdog, grandchild_pid) =
        spawn_watchdog_with_grandchild(fake_parent_pid, "sleep 120");

    // Let watchdog finish its kqueue registration.
    std::thread::sleep(Duration::from_millis(200));

    // Hard-kill the fake parent (SIGKILL exercises the path we
    // actually care about — the cooperative SIGTERM path of Helmor
    // already calls `ManagedExecutor::shutdown`).
    unsafe {
        libc::kill(fake_parent_pid as libc::pid_t, libc::SIGKILL);
    }
    let _ = fake_parent.wait();

    let code = wait_for_exit(&mut watchdog, Duration::from_secs(8));
    assert_eq!(
        code,
        Some(0),
        "watchdog should exit 0 when its watched parent dies"
    );
    assert!(
        wait_for_pid_gone(grandchild_pid, Duration::from_secs(2)),
        "grandchild pid {grandchild_pid} should be reaped after parent died"
    );
}

#[test]
fn stale_parent_pid_exits_cleanly() {
    // Pick a pid we're confident never exists. Spawning a one-shot
    // process and immediately waiting on it gives us a "definitely
    // dead" pid that the kernel has already reaped — kqueue's
    // EVFILT_PROC ADD on that pid will return ESRCH, which the
    // watchdog treats as parent-already-died.
    let mut ephemeral = Command::new("/usr/bin/true")
        .spawn()
        .expect("spawn ephemeral");
    let stale_pid = ephemeral.id();
    let _ = ephemeral.wait();
    // Give the kernel a moment to fully release the pid table slot.
    std::thread::sleep(Duration::from_millis(50));

    let (mut watchdog, grandchild_pid) = spawn_watchdog_with_grandchild(stale_pid, "sleep 120");

    let code = wait_for_exit(&mut watchdog, Duration::from_secs(8));
    assert_eq!(
        code,
        Some(0),
        "watchdog should exit 0 when parent pid is already gone"
    );
    assert!(
        wait_for_pid_gone(grandchild_pid, Duration::from_secs(2)),
        "grandchild pid {grandchild_pid} should be reaped on stale-parent path"
    );
}
