//! Bounded subprocess execution for forge CLI integrations.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use super::bundled;

#[derive(Debug, Clone)]
pub(crate) struct CommandOutput {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) success: bool,
    pub(crate) status: Option<i32>,
}

const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn run_command<I, S>(program: &str, args: I) -> std::io::Result<CommandOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_command_with_timeout(program, args, DEFAULT_COMMAND_TIMEOUT)
}

/// Prefer the bundled binary over whatever is on PATH.
fn resolve_program(program: &str) -> PathBuf {
    bundled::bundled_path_for(program).unwrap_or_else(|| PathBuf::from(program))
}

pub(crate) fn run_command_with_timeout<I, S>(
    program: &str,
    args: I,
    timeout: Duration,
) -> std::io::Result<CommandOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_command_full::<_, _, &str, &str>(program, args, timeout, &[])
}

/// `run_command` with caller-supplied environment overrides. Each `(name,
/// value)` pair is applied on top of the inherited environment AFTER the
/// default `NO_COLOR=1` etc., so callers can set per-spawn `GH_TOKEN`
/// without leaking it back into the parent process.
pub(crate) fn run_command_with_env<I, S, K, V>(
    program: &str,
    args: I,
    env: &[(K, V)],
) -> std::io::Result<CommandOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
    K: AsRef<OsStr>,
    V: AsRef<OsStr>,
{
    run_command_full(program, args, DEFAULT_COMMAND_TIMEOUT, env)
}

fn run_command_full<I, S, K, V>(
    program: &str,
    args: I,
    timeout: Duration,
    env: &[(K, V)],
) -> std::io::Result<CommandOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
    K: AsRef<OsStr>,
    V: AsRef<OsStr>,
{
    let args: Vec<OsString> = args
        .into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .collect();
    let resolved = resolve_program(program);
    let mut command = Command::new(&resolved);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Force monochrome output so JSON parsing isn't broken by ANSI
        // colour codes when the user's environment sets CLICOLOR_FORCE=1
        // or similar.
        .env("NO_COLOR", "1")
        .env_remove("CLICOLOR_FORCE")
        .env_remove("FORCE_COLOR");
    for (name, value) in env {
        command.env(name, value);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let child = command.spawn()?;
    let child_pid = child.id();
    let (tx, rx) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let result = child.wait_with_output();
        let _ = tx.send(result);
    });

    let output = match rx.recv_timeout(timeout) {
        Ok(result) => {
            let _ = waiter.join();
            result?
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            kill_process(child_pid);
            let _ = waiter.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("`{program}` timed out after {timeout:?}"),
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = waiter.join();
            return Err(std::io::Error::other(format!(
                "`{program}` waiter thread exited unexpectedly"
            )));
        }
    };

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
        status: output.status.code(),
    })
}

#[cfg(unix)]
fn kill_process(child_pid: u32) {
    unsafe {
        libc::kill(-(child_pid as libc::pid_t), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process(child_pid: u32) {
    let pid = child_pid.to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .status();
}

pub(crate) fn command_detail(output: &CommandOutput) -> String {
    let stderr = output.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = output.stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    match output.status {
        Some(code) => format!("command exited with status {code}"),
        None => "command exited unsuccessfully".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn run_command_with_timeout_kills_stalled_command() {
        let started_at = std::time::Instant::now();
        let error =
            run_command_with_timeout("/bin/sh", ["-c", "sleep 2"], Duration::from_millis(100))
                .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started_at.elapsed() < Duration::from_secs(1));
    }
}
