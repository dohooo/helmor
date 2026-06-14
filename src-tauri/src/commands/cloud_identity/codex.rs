//! Cloud Run Identity — Codex subscription token broker (Phase 1, local half).
//!
//! SECURITY-CRITICAL. This module captures a user's ChatGPT **subscription**
//! OAuth `refresh_token` (never an API key) and hands it to the per-team
//! `CodexIdentity` Durable Object on the control-plane Worker, which is the
//! single owner of the token at rest. See the Phase 1 broker design (§3.2,
//! §6.5, §9.E) for the full contract.
//!
//! IRON RULES enforced here:
//!   * The `refresh_token` NEVER leaves this process except in the single
//!     authenticated HTTPS `PUT /team/cloud-identity` body. It is NEVER logged,
//!     NEVER returned to the frontend, NEVER written to `~/.codex`, and NEVER
//!     persisted to local durable storage by Helmor.
//!   * `codex login` runs against a **throwaway** `CODEX_HOME` (mode `0700`),
//!     so the real local Codex login (`~/.codex`) is untouched — the cloud
//!     identity is a deliberately separate authorization.
//!   * The throwaway dir is removed even on early-return / panic via an RAII
//!     drop guard (`tempfile::TempDir`), NOT a happy-path delete.
//!   * The in-memory `refresh_token` buffer is zeroized after upload.
//!
//! The team Worker base URL + bearer live in the frontend's `localStorage`
//! (see `src/lib/team-mode.ts`); the Rust backend cannot read them, so the
//! caller passes `worker_url` + `team_token` in. The token only ever travels
//! frontend → Rust → Worker; the `refresh_token` never travels back.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::{platform, sidecar};

use super::{cloud_identity_url, harden_dir_permissions, WORKER_TIMEOUT};
use crate::commands::common::{run_blocking, CmdResult};

/// Hard cap on how long we wait for the interactive `codex login` to finish.
/// The user completes the OAuth flow in a browser the CLI opens; if they
/// abandon it we don't want a zombie child wedged forever. 10 minutes is
/// generous for a human sign-in.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

// ---------------------------------------------------------------------------
// Public command result shapes
// ---------------------------------------------------------------------------

/// Outcome of a successful authorization. Deliberately carries **no** token
/// material — only the non-sensitive identity facts the panel renders so the
/// user can confirm "this is the account I just authorized". `accountId` is
/// derived Worker-side from the `id_token` claim and echoed back by the DO.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudIdentityAuthResult {
    /// ChatGPT account id (from the `id_token` claim) the Worker bound the
    /// identity to. `None` if the Worker response omitted it.
    pub account_id: Option<String>,
    /// `true` when the Worker reports the bound account changed from a
    /// previously stored one (identity hygiene signal — not an error).
    pub changed: bool,
}

// ---------------------------------------------------------------------------
// codex auth.json parsing
// ---------------------------------------------------------------------------

/// The subset of `$CODEX_HOME/auth.json` the broker needs. `codex login`
/// writes the full `chatgpt`-mode shape; we only read the two token fields and
/// hand them to the Worker, which derives `account_id` from the `id_token`
/// claim itself (design §9.A). We do NOT read or forward the access token.
#[derive(Debug, Deserialize)]
struct CodexAuthJson {
    tokens: Option<CodexAuthTokens>,
}

#[derive(Debug, Deserialize)]
struct CodexAuthTokens {
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
}

/// Tokens lifted out of the throwaway auth.json. The `refresh_token` is held in
/// a `zeroize::Zeroizing<String>` — its `Drop` scrubs the heap bytes (defeating
/// the compiler-elision / reallocation hazards a hand-rolled `Drop` can't fully
/// cover); the `id_token` is a short-lived JWT (no long-term secret) but is
/// still never logged.
struct CapturedTokens {
    refresh_token: Zeroizing<String>,
    id_token: String,
}

/// REDACTING `Debug` so the `Ok` type satisfies the `T: Debug` bound that the
/// tests' `.unwrap_err()` requires — WITHOUT ever printing token bytes.
/// IMPORTANT: `Zeroizing<String>`'s own `Debug` forwards to the inner `String`
/// (it prints the secret), so this hand-written impl is load-bearing — it
/// ensures the `refresh_token` never reaches a `{:?}` sink. Both fields are
/// secret/short-lived material, so neither is ever formatted; this upholds the
/// "never logged" invariant even if a `CapturedTokens` is accidentally
/// debug-printed.
impl std::fmt::Debug for CapturedTokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CapturedTokens")
            .field("refresh_token", &"<redacted>")
            .field("id_token", &"<redacted>")
            .finish()
    }
}

/// Parse the throwaway `auth.json` contents into the two tokens we upload.
/// Pure (string in, tokens out) so it can be unit-tested without spawning
/// `codex login`. Fails loudly — but NEVER includes token bytes in the error —
/// when either field is missing or empty.
fn parse_codex_auth_json(contents: &str) -> anyhow::Result<CapturedTokens> {
    let parsed: CodexAuthJson = serde_json::from_str(contents)
        .context("codex login produced an auth.json we couldn't parse")?;
    let tokens = parsed
        .tokens
        .context("codex auth.json had no `tokens` object — not a ChatGPT login?")?;
    let refresh_token = tokens
        .refresh_token
        .filter(|t| !t.is_empty())
        .context("codex auth.json had no refresh_token — subscription login required")?;
    let id_token = tokens
        .id_token
        .filter(|t| !t.is_empty())
        .context("codex auth.json had no id_token — cannot derive cloud account identity")?;
    Ok(CapturedTokens {
        refresh_token: Zeroizing::new(refresh_token),
        id_token,
    })
}

// ---------------------------------------------------------------------------
// Upload body
// ---------------------------------------------------------------------------

/// Body of `PUT /team/cloud-identity`. Field names are camelCase to match the
/// Worker route + DO `putRefreshToken(refreshToken, idToken)` contract (§9.C).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadBody<'a> {
    refresh_token: &'a str,
    id_token: &'a str,
}

/// What the Worker echoes from `putRefreshToken` (§9.A: `{accountId, changed}`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResponse {
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    changed: bool,
}

/// Build the JSON upload body string from captured tokens. Separated out so a
/// unit test can assert the exact wire shape (camelCase keys, both fields
/// present) without touching the network. The returned `String` carries the
/// `refresh_token` and is the caller's responsibility to drop promptly.
fn build_upload_body_json(tokens: &CapturedTokens) -> anyhow::Result<String> {
    let body = UploadBody {
        refresh_token: tokens.refresh_token.as_str(),
        id_token: &tokens.id_token,
    };
    serde_json::to_string(&body).context("Failed to serialize cloud-identity upload body")
}

// ---------------------------------------------------------------------------
// codex binary resolution + login
// ---------------------------------------------------------------------------

/// Resolve the `codex` binary to spawn. Prefers the binary bundled inside the
/// `.app` (release) so authorization works without `codex` on PATH; falls back
/// to a PATH lookup (dev builds + last resort). Mirrors
/// `system_commands::resolve_agent_binary` for the `"codex"` arm — kept local
/// because that helper is private to its module.
fn resolve_codex_binary() -> std::path::PathBuf {
    sidecar::resolve_bundled_agent_paths()
        .codex_bin
        .unwrap_or_else(|| platform::executable::resolve_for_spawn("codex"))
}

/// Run `codex login` with `CODEX_HOME` pointed at the throwaway dir and wait
/// for it to finish. `codex login` is interactive: it opens the user's browser
/// for the OAuth consent and, on success, writes `$CODEX_HOME/auth.json`. We
/// inherit no controlling terminal (GUI app), which is fine — the browser
/// drives the flow; the child just blocks until the loopback callback lands.
///
/// We never capture or log the child's stdout/stderr token-side: stdout/stderr
/// are inherited (null on a bundled app is acceptable; the browser carries the
/// UX). Returns an error WITHOUT any token bytes on non-success.
fn run_codex_login(codex_home: &Path) -> anyhow::Result<()> {
    let mut command = Command::new(resolve_codex_binary());
    platform::process::configure_background_cli(&mut command);
    command
        .arg("login")
        // Throwaway, 0700 CODEX_HOME — the whole point: do NOT touch ~/.codex.
        .env("CODEX_HOME", codex_home)
        // Defensive: never let a stray API-key env short-circuit the
        // subscription OAuth flow we are explicitly exercising here.
        .env_remove("OPENAI_API_KEY")
        // Inherit stdout/stderr so codex's "open this URL" / progress lines reach
        // the app's console directly. We deliberately do NOT capture stderr:
        // codex's failure output can echo request/response detail, and embedding
        // it in our anyhow error would log it + surface it in a frontend toast.
        // The exit code alone is enough for a generic, non-token diagnostic.
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let child = command
        .spawn()
        .context("Failed to launch `codex login`. Is the Codex CLI installed?")?;

    let status = wait_with_timeout(child, LOGIN_TIMEOUT)?;

    if status.success() {
        return Ok(());
    }
    // codex exits non-zero when the user cancels/aborts the browser flow. Return
    // ONLY the exit code + a generic hint — NEVER any captured codex output (it
    // could contain token-adjacent material and is logged / shown in a toast).
    anyhow::bail!(
        "codex login did not complete (exit {}). Please re-run authorization.",
        status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string()),
    );
}

/// Wait for a child process up to `timeout`, killing it (and erroring) if it
/// overruns. `std::process` has no timed wait, so we poll with a short sleep —
/// the login is human-paced, so a 250 ms cadence is imperceptible and cheap.
/// Returns only the `ExitStatus`: stdio is inherited (never captured), so there
/// is no output to collect — and nothing token-adjacent to risk surfacing.
fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: Duration,
) -> anyhow::Result<std::process::ExitStatus> {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait().context("Failed to poll codex login")? {
            Some(status) => return Ok(status),
            None => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    anyhow::bail!(
                        "codex login timed out after {} seconds — authorization not completed.",
                        timeout.as_secs()
                    );
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Worker round-trips
// ---------------------------------------------------------------------------

/// PUT the captured tokens to the Worker over the authenticated route.
/// Returns the Worker's `{accountId, changed}` echo. NEVER logs the body.
fn upload_to_worker(
    worker_base: &str,
    team_token: &str,
    tokens: &CapturedTokens,
) -> anyhow::Result<UploadResponse> {
    let url = cloud_identity_url(worker_base)?;
    let body = build_upload_body_json(tokens)?;

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
        // Read the body for a status-code-only diagnostic; do NOT echo it
        // verbatim into a higher layer beyond a trimmed message (the body is
        // Worker-authored, not token material, but we stay conservative).
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

/// Full authorize flow (blocking): secure throwaway CODEX_HOME → codex login →
/// read tokens → upload → scrub. The `TempDir` guard wipes the directory on
/// EVERY exit path (success, error, panic-unwind) because it is dropped when
/// this function's stack frame unwinds.
fn authorize_impl(worker_url: &str, team_token: &str) -> anyhow::Result<CloudIdentityAuthResult> {
    // Validate the Worker target BEFORE touching the user's account, so we
    // don't pop a browser login only to discover team mode isn't configured.
    cloud_identity_url(worker_url)?;

    // 0700 throwaway CODEX_HOME. `tempfile::TempDir` is the RAII guard: its
    // Drop removes the directory and all contents (including the auth.json
    // codex writes) even on early-return / panic. On Unix the per-user temp
    // dir is already 0700; we additionally tighten the leaf to 0700 below.
    let temp_home = tempfile::Builder::new()
        .prefix("helmor-cloud-codex-")
        .tempdir()
        .context("Failed to create a secure temporary CODEX_HOME")?;
    harden_dir_permissions(temp_home.path())?;

    run_codex_login(temp_home.path())?;

    // Read the auth.json codex just wrote. Hold its contents only long enough
    // to lift the two tokens out, then let the String drop. We never log it.
    let auth_path = temp_home.path().join("auth.json");
    let raw = std::fs::read_to_string(&auth_path)
        .context("codex login finished but no auth.json was written")?;
    let tokens = parse_codex_auth_json(&raw)?;
    // `raw` (which still contains the RT) is dropped here; the only live copy
    // of the RT now lives inside the zeroizing buffer in `tokens`.
    drop(raw);

    let echo = upload_to_worker(worker_url, team_token, &tokens)?;

    // Tokens (incl. the zeroizing RT buffer) drop at end of scope; make the
    // scrub explicit and immediate now that the upload succeeded.
    drop(tokens);

    // `temp_home` drops here → directory wiped.
    Ok(CloudIdentityAuthResult {
        account_id: echo.account_id,
        changed: echo.changed,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Authorize a Codex **subscription** identity for the team's cloud sandbox.
///
/// Opens an interactive `codex login` against a throwaway `CODEX_HOME`, reads
/// the resulting `refresh_token` + `id_token` into memory, and PUTs them to the
/// team Worker (`PUT {worker_url}/team/cloud-identity`) authenticated with the
/// team bearer. The `refresh_token` is never returned to the caller, never
/// logged, never written to `~/.codex`, and is zeroized after upload; the
/// throwaway dir is wiped on every exit path.
///
/// `worker_url` + `team_token` come from the frontend's saved team config
/// (`getTeamConfig()` in `src/lib/team-mode.ts`) — the Rust backend can't read
/// the webview's `localStorage`, so the caller forwards them.
#[tauri::command]
pub async fn authorize_cloud_codex_identity(
    worker_url: String,
    team_token: String,
) -> CmdResult<CloudIdentityAuthResult> {
    run_blocking(move || authorize_impl(&worker_url, &team_token)).await
}

// NB: status is read directly from the Worker by the frontend
// (`team-api.getCloudCodexIdentityStatus`); there is no Rust status command.

// ---------------------------------------------------------------------------
// Tests (pure helpers only — no codex login, no network)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn auth_json(refresh: &str, id: &str) -> String {
        // Shape codex writes (chatgpt mode). Includes fields we intentionally
        // ignore (access_token, account_id, auth_mode) to prove we read only
        // the two we forward.
        serde_json::json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": id,
                "access_token": "eyJ.ACCESS.sig",
                "refresh_token": refresh,
                "account_id": "acc-from-codex"
            },
            "last_refresh": "2026-06-14T00:00:00Z"
        })
        .to_string()
    }

    #[test]
    fn parses_refresh_and_id_tokens() {
        let parsed = parse_codex_auth_json(&auth_json("rt-secret-123", "id-jwt-456")).unwrap();
        assert_eq!(parsed.refresh_token.as_str(), "rt-secret-123");
        assert_eq!(parsed.id_token, "id-jwt-456");
    }

    #[test]
    fn rejects_missing_tokens_object() {
        let err = parse_codex_auth_json(r#"{"auth_mode":"chatgpt"}"#).unwrap_err();
        assert!(format!("{err}").contains("tokens"));
    }

    #[test]
    fn rejects_empty_refresh_token() {
        let err = parse_codex_auth_json(&auth_json("", "id-jwt")).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("refresh_token"));
        // The (empty) secret must never be leaked, and no id token either.
        assert!(!msg.contains("id-jwt"));
    }

    #[test]
    fn rejects_missing_id_token() {
        let err = parse_codex_auth_json(&auth_json("rt", "")).unwrap_err();
        assert!(format!("{err}").contains("id_token"));
    }

    #[test]
    fn error_messages_never_contain_token_bytes() {
        // A malformed auth.json must not echo any of its bytes into the error.
        let raw = r#"{"tokens":{"refresh_token":"SUPER-SECRET-RT"}}"#;
        let err = parse_codex_auth_json(raw).unwrap_err();
        assert!(!format!("{err}").contains("SUPER-SECRET-RT"));
    }

    #[test]
    fn upload_body_uses_camel_case_and_both_fields() {
        let tokens = CapturedTokens {
            refresh_token: Zeroizing::new("rt-xyz".to_string()),
            id_token: "id-abc".to_string(),
        };
        let body = build_upload_body_json(&tokens).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["refreshToken"], "rt-xyz");
        assert_eq!(value["idToken"], "id-abc");
        // No snake_case leakage.
        assert!(value.get("refresh_token").is_none());
        assert!(value.get("id_token").is_none());
        // No stray access token / account id smuggled into the body.
        assert!(value.get("accessToken").is_none());
        assert!(value.get("accountId").is_none());
    }

    // NB: `cloud_identity_url` lives in the parent module now (shared with the
    // claude broker); its tests live there too.

    #[test]
    fn captured_refresh_token_is_zeroizing_and_derefs_to_secret() {
        // The RT lives in a `zeroize::Zeroizing<String>` whose `Drop` scrubs the
        // heap (the crate's job — verifying the post-free zero locally would be
        // UB, so we don't). What this module RELIES ON is the transparent deref
        // to the inner `&str` (used by `build_upload_body_json`); assert that.
        let secret: Zeroizing<String> = Zeroizing::new("rt-zz".to_string());
        assert_eq!(secret.as_str(), "rt-zz");
        let captured = CapturedTokens {
            refresh_token: secret,
            id_token: "id".to_string(),
        };
        assert_eq!(captured.refresh_token.as_str(), "rt-zz");
        // The redacting Debug must NOT leak the secret (Zeroizing's own Debug
        // would print it — see the hand-written impl).
        assert!(!format!("{captured:?}").contains("rt-zz"));
    }
}
