//! Per-workspace credential storage backed by the OS keychain.
//!
//! On macOS we shell out to `/usr/bin/security` rather than going
//! through the `keyring` crate. The keyring crate's `set_password`
//! silently no-ops when called from a tokio worker thread (verified
//! end-to-end with tracing in helmor) — the macOS Security framework
//! requires a CFRunLoop on the calling thread, which spawn_blocking
//! workers don't have. The `security` CLI process gets its own
//! runloop and works reliably. Same trick `desktop_scrape.rs` uses
//! to read Slack's own Safe Storage key.
//!
//! One entry per Slack workspace, keyed by `team_id`. The token
//! (`xoxc-…`) and the `d` cookie value (`xoxd-…`) travel as a single
//! JSON blob so we never write half of a pair. The service identifier
//! groups every Helmor Slack credential under one umbrella in
//! Keychain Access so users can audit / revoke at a glance.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};

const KEYCHAIN_SERVICE: &str = "io.helmor.slack";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackCreds {
    /// `xoxc-…` workspace token captured from a `boot`/XHR request body.
    pub xoxc: String,
    /// Raw value of the `d` cookie (`xoxd-…`), URL-decoded. Sent as
    /// `Cookie: d=<xoxd>` in every Slack Web API call.
    pub xoxd: String,
}

pub fn store_credentials(team_id: &str, creds: &SlackCreds) -> Result<()> {
    let payload = serde_json::to_string(creds).context("Failed to serialize Slack credentials")?;
    // -U upserts (delete-then-add); -s service, -a account, -w
    // password. We pass the payload on stdin via -w because long
    // values trip command-line escaping.
    let status = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            team_id,
            "-w",
            &payload,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("Failed to spawn /usr/bin/security for team {team_id}"))?;
    if !status.status.success() {
        bail!(
            "`security add-generic-password` failed (exit={:?}): {}",
            status.status.code(),
            String::from_utf8_lossy(&status.stderr).trim()
        );
    }
    Ok(())
}

pub fn load_credentials(team_id: &str) -> Result<Option<SlackCreds>> {
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-w",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            team_id,
        ])
        .output()
        .with_context(|| format!("Failed to spawn /usr/bin/security for team {team_id}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "could not be found" -> entry doesn't exist, return None.
        if stderr.contains("could not be found") || stderr.contains("not be found") {
            return Ok(None);
        }
        bail!(
            "`security find-generic-password` failed (exit={:?}): {}",
            output.status.code(),
            stderr.trim()
        );
    }
    // -w prints the secret + a trailing newline. Strip the newline.
    let mut bytes = output.stdout;
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    let payload = String::from_utf8(bytes)
        .with_context(|| format!("Stored Slack credentials for {team_id} aren't UTF-8"))?;
    let creds: SlackCreds = serde_json::from_str(&payload)
        .with_context(|| format!("Stored Slack credentials for {team_id} are malformed JSON"))?;
    Ok(Some(creds))
}

pub fn clear_credentials(team_id: &str) -> Result<()> {
    let output = Command::new("/usr/bin/security")
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            team_id,
        ])
        .output()
        .with_context(|| format!("Failed to spawn /usr/bin/security for team {team_id}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("could not be found") || stderr.contains("not be found") {
            // Already gone — treat as success.
            return Ok(());
        }
        bail!(
            "`security delete-generic-password` failed (exit={:?}): {}",
            output.status.code(),
            stderr.trim()
        );
    }
    Ok(())
}
