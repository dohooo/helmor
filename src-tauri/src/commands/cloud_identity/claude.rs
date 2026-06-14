//! Cloud Run Identity — Claude subscription token broker (local half).
//!
//! SECURITY-CRITICAL. This module captures a user's Claude **subscription**
//! long-lived OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`, an `sk-ant-…`
//! inference-only token valid ~1 year) and hands it to the per-team
//! `ClaudeIdentity` Durable Object on the control-plane Worker, which is the
//! single owner of the token at rest. It is the structural twin of the Codex
//! broker (`super::codex`) with two deliberate differences:
//!
//!   1. **Capture mechanism.** Codex reads a throwaway `auth.json`; Claude has
//!      no such file. `claude setup-token` is an Ink **raw-mode TUI** that
//!      prints the token to the terminal ONLY and saves nothing to disk
//!      (verified against the bundled 2.1.173 binary: it contains
//!      `Raw mode is not supported on the current process.stdin, which Ink uses
//!      as input stream by default.`). Capturing it with `Stdio::piped()` would
//!      crash Ink (stdin is not a TTY) or scrape ANSI frames. So we allocate a
//!      **PTY** (`crate::platform::pty`, the same seam the embedded terminal
//!      uses), let the CLI's loopback callback complete the browser OAuth, drain
//!      the merged PTY output, ANSI-strip it, and extract the `sk-ant-…` token
//!      with a LOOSE match (Anthropic may rotate the `oat01` infix, so we never
//!      hard-gate on it — see the Claude-cloud-auth VERIFIED spec §1.2).
//!   2. **No `id_token` / `account_id`.** The token is `user:inference`-scoped
//!      and self-contained — there is no profile claim to surface. We upload one
//!      field, `{ oauthToken }`, and the panel status is `{ hasToken }` only.
//!
//! IRON RULES (identical to the Codex broker):
//!   * The token NEVER leaves this process except in the single authenticated
//!     HTTPS `PUT /team/claude-identity` body. It is NEVER logged, NEVER returned
//!     to the frontend, NEVER written to the user's real `~/.claude`, and NEVER
//!     persisted locally by Helmor. The raw PTY output (which contains the
//!     token) is NEVER logged and NEVER embedded in an error.
//!   * `claude setup-token` runs against a **throwaway** `CLAUDE_CONFIG_DIR`
//!     (mode `0700`), so the real local Claude login is untouched.
//!   * The throwaway dir is removed even on early-return / panic via an RAII
//!     drop guard (`tempfile::TempDir`).
//!   * `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the child
//!     env: both OUTRANK `CLAUDE_CODE_OAUTH_TOKEN` in non-interactive mode, so a
//!     stray one could silently authorize the wrong account (VERIFIED spec §1.4).
//!   * The in-memory token buffer is `Zeroizing` and scrubbed after upload.

use std::io::Read;
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::commands::common::{run_blocking, CmdResult};
use crate::platform::pty::{self, PollResult};
use crate::{platform, sidecar};

use super::{claude_identity_url, harden_dir_permissions, WORKER_TIMEOUT};

/// Hard cap on how long we wait for `claude setup-token` to print the token.
/// The user completes the OAuth consent in a browser the CLI opens; if they
/// abandon it we don't want a zombie child wedged forever. 10 minutes matches
/// the Codex broker's `LOGIN_TIMEOUT` and is generous for a human sign-in.
const SETUP_TOKEN_TIMEOUT: Duration = Duration::from_secs(600);

/// PTY read buffer. One drain per poll wake; sized to comfortably hold a full
/// Ink frame plus the token line in a single read.
const PTY_READ_BUF_BYTES: usize = 8192;

/// Poll cadence for the PTY reader. A short timeout lets us re-check the overall
/// deadline and the "token already captured" condition between reads without
/// busy-spinning. The kernel wakes us immediately when output is available.
const PTY_POLL_TIMEOUT_MS: i32 = 200;

// ---------------------------------------------------------------------------
// Captured token
// ---------------------------------------------------------------------------

/// The long-lived OAuth token lifted out of the PTY output, held in a
/// `zeroize::Zeroizing<String>` so its `Drop` scrubs the heap bytes.
struct CapturedToken {
    oauth_token: Zeroizing<String>,
}

/// REDACTING `Debug` so the token never reaches a `{:?}` sink. `Zeroizing`'s own
/// `Debug` forwards to the inner `String` (it prints the secret), so this
/// hand-written impl is load-bearing — it upholds the "never logged" invariant
/// even if a `CapturedToken` is accidentally debug-printed.
impl std::fmt::Debug for CapturedToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CapturedToken")
            .field("oauth_token", &"<redacted>")
            .finish()
    }
}

// ---------------------------------------------------------------------------
// ANSI strip + token extraction (pure — unit-tested without spawning the CLI)
// ---------------------------------------------------------------------------

/// Strip ANSI/VT control sequences from terminal output so the token line can be
/// matched cleanly. `claude setup-token` renders through Ink, which emits CSI
/// sequences (`ESC [ … final`), OSC sequences (`ESC ] … BEL|ST`), and other
/// `ESC <byte>` escapes around the text. We drop those and carriage returns,
/// keeping the printable payload. Deliberately small + dependency-free (the repo
/// has no `vte`/`strip-ansi` crate); it only needs to expose the `sk-ant-…`
/// token, not faithfully reconstruct the screen.
fn strip_ansi(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            // ESC. Determine the escape kind from the next byte.
            match bytes.get(i + 1) {
                Some(b'[') => {
                    // CSI: ESC [ params... final-byte (0x40..=0x7e).
                    i += 2;
                    while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                        i += 1;
                    }
                    i += 1; // consume the final byte (if present)
                }
                Some(b']') => {
                    // OSC: ESC ] ... terminated by BEL (0x07) or ST (ESC \).
                    i += 2;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                Some(_) => {
                    // Other two-byte escape (e.g. ESC M). Drop ESC + the byte.
                    i += 2;
                }
                None => {
                    // Trailing lone ESC.
                    i += 1;
                }
            }
            continue;
        }
        if b == b'\r' {
            // Carriage returns drive Ink's in-place redraws; dropping them keeps
            // the logical text intact for matching.
            i += 1;
            continue;
        }
        // Copy this byte through. `input` is valid UTF-8 and we only branch on
        // ASCII control bytes (all < 0x80), so multi-byte sequences pass intact.
        out.push(b as char);
        i += 1;
    }
    out
}

/// Extract the `sk-ant-…` OAuth token from ANSI-stripped terminal text.
///
/// LOOSE by design (VERIFIED spec §1.2): the prefix is `sk-ant-` and the body is
/// the token charset `[A-Za-z0-9_-]`. We do NOT require the `oat01` infix
/// (Anthropic may rotate the format). We require a reasonable minimum length so
/// a stray `sk-ant-` substring in prose can't match.
///
/// We return the LONGEST complete match — NOT the last (VERIFIED RISK-1). The
/// `setup-token` success screen prints the token TWICE: standalone, and again
/// inside `export CLAUDE_CODE_OAUTH_TOKEN=<token>`. Both runs are the same full
/// token, so length disambiguation is robust; but if a token ever word-wraps in
/// the PTY (mitigated by the wide spawn above) the last run would be a TRUNCATED
/// tail, whereas the longest run is still the intact token. Ties keep the first
/// seen (the standalone print) — order doesn't matter when lengths are equal.
fn extract_token(text: &str) -> Option<String> {
    const PREFIX: &str = "sk-ant-";
    const MIN_BODY_LEN: usize = 20;
    let is_token_byte = |c: u8| c.is_ascii_alphanumeric() || c == b'-' || c == b'_';

    let bytes = text.as_bytes();
    let mut best: Option<String> = None;
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find(PREFIX) {
        let start = search_from + rel;
        let body_start = start + PREFIX.len();
        let mut end = body_start;
        while end < bytes.len() && is_token_byte(bytes[end]) {
            end += 1;
        }
        if end - body_start >= MIN_BODY_LEN {
            let candidate = &text[start..end];
            // Keep the LONGEST candidate (a truncated wrap is shorter than the
            // intact token). `>` (not `>=`) keeps the first on a tie.
            if best.as_ref().is_none_or(|b| candidate.len() > b.len()) {
                best = Some(candidate.to_string());
            }
        }
        // Advance past this prefix occurrence to find any later occurrence.
        search_from = start + PREFIX.len();
    }
    best
}

/// Find a token that is COMPLETE in the buffer so far — i.e. its trailing edge
/// is a non-token byte (whitespace / control / EOL), proving the CLI finished
/// writing it. Used to stop reading early without risking a truncated capture
/// while the token line is still streaming in. Returns `None` if the only
/// `sk-ant-` run reaches the very end of the buffer (might still be growing).
fn extract_complete_token(text: &str) -> Option<String> {
    let token = extract_token(text)?;
    // If the buffer ends exactly with the token, more bytes may still arrive —
    // treat it as not-yet-complete and wait for a boundary (or child exit).
    if text.ends_with(&token) {
        return None;
    }
    Some(token)
}

// ---------------------------------------------------------------------------
// Upload body / response
// ---------------------------------------------------------------------------

/// Body of `PUT /team/claude-identity`. The dedicated Claude route
/// (`putClaudeIdentity`) reads exactly one field, `oauthToken` — there is NO
/// `provider` discriminant (the route, not the body, selects the
/// `ClaudeIdentity` DO). The key is camelCase to match the Worker handler.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadBody<'a> {
    oauth_token: &'a str,
}

/// What the Worker echoes from `putOAuthToken` — metadata only, NEVER the token.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResponse {
    #[serde(default)]
    changed: bool,
}

/// Outcome of a successful authorization. Carries **no** token material — only
/// the non-sensitive hygiene signal the panel renders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudClaudeAuthResult {
    /// `true` when the Worker reports a token already existed and was replaced
    /// (identity hygiene signal — not an error).
    pub changed: bool,
}

/// Build the JSON upload body string. Separated out so a unit test can assert
/// the exact wire shape (a single camelCase `oauthToken` key, the token present
/// and no snake_case leakage) without touching the network. The returned
/// `String` carries the token and is the caller's responsibility to drop.
fn build_upload_body_json(token: &CapturedToken) -> anyhow::Result<String> {
    let body = UploadBody {
        oauth_token: token.oauth_token.as_str(),
    };
    serde_json::to_string(&body).context("Failed to serialize cloud-identity upload body")
}

// ---------------------------------------------------------------------------
// claude binary resolution + setup-token capture
// ---------------------------------------------------------------------------

/// Resolve the `claude` binary to spawn. Prefers the binary bundled inside the
/// `.app` (release) so authorization works without `claude` on PATH; falls back
/// to a PATH lookup (dev builds + last resort). Mirrors `super::codex`'s
/// `resolve_codex_binary`.
fn resolve_claude_binary() -> std::path::PathBuf {
    sidecar::resolve_bundled_agent_paths()
        .claude_bin
        .unwrap_or_else(|| platform::executable::resolve_for_spawn("claude"))
}

/// Run `claude setup-token` against a PTY and capture the printed token.
///
/// `claude setup-token` opens the user's browser for OAuth consent; on a desktop
/// the CLI's loopback callback receives the authorization code automatically
/// (the manual code-paste path only triggers when the local callback server is
/// unreachable — WSL2 / SSH / containers — which is not our case), then it
/// prints the token to the terminal. Ink needs a raw-mode-capable TTY on stdin,
/// which the PTY slave provides; we never type into it.
///
/// We drain the merged PTY output until we see a COMPLETE `sk-ant-…` token, the
/// child exits, or we hit `SETUP_TOKEN_TIMEOUT`. The raw output is held only to
/// extract the token and is NEVER logged or surfaced in an error.
fn capture_setup_token(config_dir: &std::path::Path) -> anyhow::Result<CapturedToken> {
    let mut command = Command::new(resolve_claude_binary());
    platform::process::configure_background_cli(&mut command);
    command
        .arg("setup-token")
        // Throwaway, 0700 config dir — the whole point: do NOT touch the user's
        // real `~/.claude`. `CLAUDE_CONFIG_DIR` is the documented redirect for
        // both the config and any credential writes (verified in the 2.1.173
        // binary). We also point HOME at it so nothing leaks to the real home on
        // platforms that fall back to `$HOME/.claude`.
        .env("CLAUDE_CONFIG_DIR", config_dir)
        .env("HOME", config_dir)
        // Defensive: both of these OUTRANK CLAUDE_CODE_OAUTH_TOKEN in
        // non-interactive mode and could otherwise steer the flow onto the wrong
        // credential. `setup-token` itself is an OAuth flow, but we strip them so
        // a stray env can't interfere.
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        // Also clear any inherited OAuth token so the flow always mints a fresh
        // one rather than short-circuiting on an ambient value.
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN");

    // Allocate a PTY and spawn the CLI attached to it (stdin/stdout/stderr are
    // the PTY slave; stdin is a TTY so Ink's raw mode initializes). We force a
    // WIDE terminal (400 cols) so the ~100-char token line never word-wraps —
    // Ink hard-wraps to the terminal width, and a wrapped token would split
    // across lines and defeat the single-run `sk-ant-…` match (VERIFIED §1.2 +
    // RISK-1). The height is irrelevant (we never render the frames).
    let mut session = pty::spawn_with_size(command, Some((400, 50)))
        .context("Failed to launch `claude setup-token`. Is the Claude CLI installed?")?;

    // Snapshot the child's process-tree identity BEFORE the read loop so the
    // timeout path can terminate it even though `session` (and thus the pid /
    // pgid) is moved/dropped later. The PTY makes the child a process-group
    // leader (`pty::spawn_unix` → `setsid`), so the pgid covers any helper it
    // forks for the loopback OAuth callback.
    let tree = platform::process::ProcessTree::new(
        session.child.id() as platform::process::Pid,
        session.pgid,
    );

    // Accumulate ANSI-stripped output. Bounded implicitly by the token arriving
    // quickly after consent; we cap total time via the deadline below.
    let mut accumulated = String::new();
    let mut buf = [0u8; PTY_READ_BUF_BYTES];
    let start = Instant::now();
    let mut child_exited = false;

    'outer: loop {
        if start.elapsed() >= SETUP_TOKEN_TIMEOUT {
            // Terminate the child's whole process group FIRST. `session.child.wait()`
            // is a blocking `waitpid`; with the PTY master still open and the Ink
            // event loop running, the child never exits on its own, so an
            // unconditional wait here would hang FOREVER (the codex broker kills
            // before it waits — `super::codex::wait_with_timeout`). SIGKILL the
            // tree, then reap.
            platform::process::kill_tree(tree);
            let _ = session.child.wait();
            anyhow::bail!(
                "claude setup-token timed out after {} seconds — authorization not completed.",
                SETUP_TOKEN_TIMEOUT.as_secs()
            );
        }

        match session.reader.poll_readable(PTY_POLL_TIMEOUT_MS) {
            Ok(PollResult::TimedOut) => {
                // No new output this window. If the token is already complete in
                // what we have, stop; otherwise loop to re-check the deadline.
                if extract_complete_token(&accumulated).is_some() {
                    break;
                }
                continue;
            }
            Ok(PollResult::Interrupted) => continue,
            Ok(PollResult::Ready { hung_up }) => {
                // Drain everything available after the wake.
                loop {
                    match session.reader.read(&mut buf) {
                        Ok(0) => {
                            child_exited = true;
                            break;
                        }
                        Ok(n) => {
                            accumulated.push_str(&strip_ansi(&String::from_utf8_lossy(&buf[..n])));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(e) if pty::is_session_disconnect(&e) => {
                            child_exited = true;
                            break;
                        }
                        Err(_) => {
                            child_exited = true;
                            break;
                        }
                    }
                }
                // Once we have a token whose trailing edge is a boundary, the CLI
                // has finished writing it — stop early without waiting for exit.
                if extract_complete_token(&accumulated).is_some() {
                    break 'outer;
                }
                if hung_up || child_exited {
                    break 'outer;
                }
            }
            Err(_) => {
                // Master read/poll error (commonly the benign exit disconnect);
                // stop and try to extract from whatever we captured.
                break;
            }
        }
    }

    // Reap the child so we don't leak it. On the early-success path it may still
    // be alive (Ink stays mounted); we don't need its exit code — the token is
    // the only success signal — so a best-effort wait is enough. The PTY master
    // dropping with `session` closes the slave and lets the child exit.
    drop(session);

    // Try a complete token first (boundary-terminated), then fall back to any
    // match (covers the case where the child exited with the token as the final
    // bytes and no trailing newline).
    let token = extract_complete_token(&accumulated)
        .or_else(|| extract_token(&accumulated))
        .context(
            "claude setup-token finished but no token was found in its output. \
             Re-run authorization and complete the browser sign-in.",
        )?;
    // Scrub the accumulated buffer (it contains the token) before returning.
    let token = Zeroizing::new(token);
    accumulated.clear();
    accumulated.shrink_to_fit();

    Ok(CapturedToken { oauth_token: token })
}

// ---------------------------------------------------------------------------
// Worker round-trip
// ---------------------------------------------------------------------------

/// PUT the captured token to the Worker over the authenticated route. Returns
/// the Worker's `{changed}` echo. NEVER logs the body.
fn upload_to_worker(
    worker_base: &str,
    team_token: &str,
    token: &CapturedToken,
) -> anyhow::Result<UploadResponse> {
    let url = claude_identity_url(worker_base)?;
    let body = build_upload_body_json(token)?;

    let client = reqwest::blocking::Client::builder()
        .timeout(WORKER_TIMEOUT)
        .build()
        .context("Failed to build HTTP client")?;

    let mut request = client
        .put(&url)
        .header("Content-Type", "application/json")
        .body(body);
    if !team_token.is_empty() {
        request = request.bearer_auth(team_token);
    }

    let response = request
        .send()
        .context("Failed to reach the team Worker to store the cloud identity")?;

    let status = response.status();
    if !status.is_success() {
        anyhow::bail!(
            "Worker rejected the cloud identity (HTTP {})",
            status.as_u16()
        );
    }

    response
        .json::<UploadResponse>()
        .context("Worker returned an unexpected cloud-identity response")
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/// Full authorize flow (blocking): secure throwaway `CLAUDE_CONFIG_DIR` →
/// `claude setup-token` over a PTY → extract token → upload → scrub. The
/// `TempDir` guard wipes the directory on EVERY exit path (success, error,
/// panic-unwind) because it is dropped when this function's stack frame unwinds.
fn authorize_impl(worker_url: &str, team_token: &str) -> anyhow::Result<CloudClaudeAuthResult> {
    // Validate the Worker target BEFORE touching the user's account, so we don't
    // pop a browser login only to discover team mode isn't configured.
    claude_identity_url(worker_url)?;

    // 0700 throwaway config dir. `tempfile::TempDir`'s Drop removes it (and any
    // files the CLI wrote) even on early-return / panic.
    let temp_dir = tempfile::Builder::new()
        .prefix("helmor-cloud-claude-")
        .tempdir()
        .context("Failed to create a secure temporary CLAUDE_CONFIG_DIR")?;
    harden_dir_permissions(temp_dir.path())?;

    let token = capture_setup_token(temp_dir.path())?;

    let echo = upload_to_worker(worker_url, team_token, &token)?;

    // Token (the zeroizing buffer) drops at end of scope; make the scrub
    // explicit now that the upload succeeded.
    drop(token);

    // `temp_dir` drops here → directory wiped.
    Ok(CloudClaudeAuthResult {
        changed: echo.changed,
    })
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Authorize a Claude **subscription** identity for the team's cloud sandbox.
///
/// Runs `claude setup-token` locally against a throwaway 0700
/// `CLAUDE_CONFIG_DIR`, captures the printed long-lived `CLAUDE_CODE_OAUTH_TOKEN`
/// over a PTY (the command is an Ink raw-mode TUI that prints the token to the
/// terminal only), and PUTs it to the team Worker's dedicated Claude route
/// (`PUT {worker_url}/team/claude-identity`, body `{ oauthToken }`) authenticated
/// with the team bearer. The token is never returned to the caller, never
/// logged, never written to the user's real `~/.claude`, and is zeroized after
/// upload; the throwaway dir is wiped on every exit path.
///
/// `worker_url` + `team_token` come from the frontend's saved team config
/// (`getTeamConfig()` in `src/lib/team-mode.ts`) — the Rust backend can't read
/// the webview's `localStorage`, so the caller forwards them.
#[tauri::command]
pub async fn authorize_cloud_claude_identity(
    worker_url: String,
    team_token: String,
) -> CmdResult<CloudClaudeAuthResult> {
    run_blocking(move || authorize_impl(&worker_url, &team_token)).await
}

// NB: status is read directly from the Worker by the frontend
// (`team-api.getCloudClaudeIdentityStatus`); there is no Rust status command.

// ---------------------------------------------------------------------------
// Tests (pure helpers only — no claude setup-token, no network)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_csi_and_osc_keeps_text() {
        // CSI color codes + cursor move, an OSC title (BEL-terminated), and a CR.
        let raw = "\x1b[2m\x1b[38;5;240mhello\x1b[0m\r\n\x1b]0;title\x07world";
        assert_eq!(strip_ansi(raw), "hello\nworld");
    }

    #[test]
    fn strip_ansi_handles_st_terminated_osc_and_lone_esc() {
        let raw = "\x1b]8;;https://x\x1b\\link\x1bMtail";
        // OSC (ST-terminated) dropped, two-byte ESC M dropped, text kept.
        assert_eq!(strip_ansi(raw), "linktail");
    }

    #[test]
    fn extracts_token_from_success_screen() {
        // Mirror the real success-screen layout: explanatory copy, the token
        // STANDALONE, then the SAME token again inside the `export …=<token>`
        // line (the screen prints it twice). Wrapped in ANSI like Ink emits.
        let raw = "\x1b[1mYour OAuth token (valid for 1 year):\x1b[0m\r\n  \
                   sk-ant-oat01-AbC123_def-456Ghi789JkL\r\n\x1b[2m\
                   export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-AbC123_def-456Ghi789JkL\x1b[0m\r\n";
        let stripped = strip_ansi(raw);
        let token = extract_token(&stripped).unwrap();
        assert_eq!(token, "sk-ant-oat01-AbC123_def-456Ghi789JkL");
    }

    #[test]
    fn prefers_longest_match_over_a_truncated_wrap() {
        // Defense for RISK-1: if the LAST occurrence is a word-wrapped, truncated
        // tail (shorter), the longest (intact) run must still be the one returned
        // — the old "take the last match" logic would have returned the stub.
        let full = "sk-ant-oat01-AbC123_def-456Ghi789JkLmNoPqRsT";
        let stripped = strip_ansi(&format!(
            "token: {full} (copy it)\nexport CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-AbC123_def\n"
        ));
        assert_eq!(extract_token(&stripped).unwrap(), full);
    }

    #[test]
    fn extracts_token_without_oat01_infix() {
        // LOOSE match: a rotated prefix (no `oat01`) must still be captured.
        let stripped = strip_ansi("token: sk-ant-oat02-ZZZ_yyy-111222333444aaa stop");
        assert_eq!(
            extract_token(&stripped).unwrap(),
            "sk-ant-oat02-ZZZ_yyy-111222333444aaa"
        );
    }

    #[test]
    fn ignores_short_sk_ant_noise() {
        // A bare `sk-ant-` in prose (too short to be a token) must not match.
        assert!(extract_token("see sk-ant- docs for details").is_none());
        assert!(extract_token("sk-ant-short").is_none());
    }

    #[test]
    fn extract_complete_token_waits_for_boundary() {
        // Token at the very end of the buffer → might still be streaming.
        let partial = "  sk-ant-oat01-AbC123_def-456Ghi789JkL";
        assert!(extract_complete_token(partial).is_none());
        // Same token followed by a newline → complete.
        let complete = format!("{partial}\n");
        assert_eq!(
            extract_complete_token(&complete).unwrap(),
            "sk-ant-oat01-AbC123_def-456Ghi789JkL"
        );
    }

    #[test]
    fn upload_body_is_just_camel_case_oauth_token() {
        let token = CapturedToken {
            oauth_token: Zeroizing::new("sk-ant-oat01-secret123456789012345".to_string()),
        };
        let body = build_upload_body_json(&token).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["oauthToken"], "sk-ant-oat01-secret123456789012345");
        // The dedicated `/team/claude-identity` route reads ONLY `oauthToken`;
        // there must be NO `provider` discriminant (that targeted the wrong,
        // refreshToken/idToken-reading handler and 400'd — the route fix).
        assert!(value.get("provider").is_none());
        // No snake_case leakage.
        assert!(value.get("oauth_token").is_none());
        // No stray refresh/id/account material smuggled into the body.
        assert!(value.get("refreshToken").is_none());
        assert!(value.get("idToken").is_none());
        assert!(value.get("accountId").is_none());
        // Exactly one field on the wire.
        assert_eq!(value.as_object().unwrap().len(), 1);
    }

    #[test]
    fn captured_token_debug_never_leaks_secret() {
        let captured = CapturedToken {
            oauth_token: Zeroizing::new("sk-ant-oat01-SUPER-SECRET-1234567890".to_string()),
        };
        // The redacting Debug must NOT leak the secret (Zeroizing's own Debug
        // would print it — see the hand-written impl).
        assert!(!format!("{captured:?}").contains("SUPER-SECRET"));
        // And the deref the upload path relies on still works.
        assert_eq!(
            captured.oauth_token.as_str(),
            "sk-ant-oat01-SUPER-SECRET-1234567890"
        );
    }
}
