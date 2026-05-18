//! Delegated Claude OAuth refresh.
//!
//! When the access token in the keychain is expired we **never**
//! refresh it ourselves. Instead we spawn `claude auth status --json`
//! and let the Claude CLI process do the refresh:
//!
//! - Claude CLI owns the keychain ACL for `Claude Code-credentials`,
//!   so it can read and write that item without prompting.
//! - Claude CLI talks to Anthropic with its own refresh_token, then
//!   writes the new credentials back to the same keychain item.
//! - Helmor then re-reads the keychain via `/usr/bin/security` (fast,
//!   no UI) to pick up the fresh tokens.
//!
//! The point of this whole dance: Anthropic rotates `refresh_token`
//! values per OAuth best practice. If Helmor refreshed directly using
//! the refresh_token from Claude CLI's keychain, the server would
//! invalidate it and Claude CLI's next run would fail with "please
//! log in again". Routing the refresh through the CLI process keeps
//! Claude CLI's stored credential the authoritative one.
//!
//! Failure mode: if `claude auth status` is missing/slow/non-zero
//! we return an error and the caller surfaces it. We deliberately do
//! NOT fall back to direct refresh — losing one usage-stat tick is
//! fine; corrupting Claude CLI's auth state is not.

use std::process::Command;
use std::time::Duration;

use anyhow::{anyhow, Result};

use super::process::wait_with_timeout;

/// `claude auth status --json` is a non-interactive command that goes
/// through the same auth-init path as any other CLI invocation:
/// reads the keychain, refreshes if expired, writes back. 8s is
/// generous — local runs finish in ~200ms.
const DELEGATED_REFRESH_TIMEOUT: Duration = Duration::from_secs(8);

/// Spawn `claude auth status --json` and let the CLI process refresh
/// its own credentials. Returns Ok(()) on a clean exit, Err otherwise.
/// The caller is expected to re-read the keychain after a successful
/// return to pick up whatever the CLI wrote.
pub(super) fn run_claude_auth_status() -> Result<()> {
    // `--json` keeps stdout machine-shaped even though we discard it;
    // any future CLI version that adds an interactive confirmation in
    // the human-readable mode would still produce parseable JSON here.
    let mut cmd = Command::new("claude");
    cmd.args(["auth", "status", "--json"]);

    let status = wait_with_timeout(&mut cmd, DELEGATED_REFRESH_TIMEOUT)
        .ok_or_else(|| anyhow!("`claude auth status` timed out or failed to spawn"))?;

    if !status.success() {
        return Err(anyhow!(
            "`claude auth status` exited with non-zero status: {status:?}"
        ));
    }
    Ok(())
}
