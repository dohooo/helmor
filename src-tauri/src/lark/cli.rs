//! Shared `lark-cli` shell-out helper.

use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::process::Command;
use tokio::time::timeout;

const BIN: &str = "lark-cli";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) async fn run(args: &[&str], label: &str) -> Result<Value> {
    run_in(args, None, label).await
}

pub(super) async fn run_in(
    args: &[&str],
    cwd: Option<&std::path::Path>,
    label: &str,
) -> Result<Value> {
    let mut cmd = Command::new(BIN);
    cmd.args(args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let child = cmd
        .spawn()
        .map_err(|e| anyhow!("spawn {BIN} failed: {e}"))?;
    let output = match timeout(DEFAULT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(anyhow!("{BIN} {label} I/O error: {e}")),
        Err(_) => return Err(anyhow!("{BIN} {label} timed out")),
    };
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout_tail = tail_lines(&stdout, 30);
        let stderr_tail = tail_lines(&stderr, 10);
        let mut msg = format!("{BIN} {label} failed (code {:?})", output.status.code());
        if !stdout_tail.is_empty() {
            msg.push_str("\nstdout:\n");
            msg.push_str(&stdout_tail);
        }
        if !stderr_tail.is_empty() {
            msg.push_str("\nstderr:\n");
            msg.push_str(&stderr_tail);
        }
        return Err(anyhow!(msg));
    }
    let s = String::from_utf8(output.stdout).map_err(|e| anyhow!("{BIN} {label} non-utf8: {e}"))?;
    if s.trim().is_empty() {
        return Ok(Value::Null);
    }
    match serde_json::from_str::<Value>(&s) {
        Ok(v) => Ok(v),
        Err(_) => Ok(serde_json::json!({ "raw": s })),
    }
}

fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.trim().split('\n').collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

pub async fn auth_status() -> Result<()> {
    run(&["auth", "status"], "auth status").await?;
    Ok(())
}
