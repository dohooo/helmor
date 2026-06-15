//! Cloud Run Identity — Claude subscription token broker (upload half).
//!
//! SECURITY-CRITICAL. This module owns the Worker round-trip for the Claude
//! **subscription** long-lived OAuth token (`sk-ant-oat01…`, an inference-only
//! token valid ~1 year): it serializes `{ oauthToken }` and PUTs it to the
//! per-team `ClaudeIdentity` Durable Object on the control-plane Worker, the
//! single owner of the token at rest.
//!
//! The token is CAPTURED by [`super::claude_oauth`], which drives our own OAuth
//! (PKCE) flow — a loopback `/callback` + a code→token exchange — and hands the
//! resulting [`CapturedToken`] here for upload. (This replaced the old
//! `claude setup-token` PTY / manual-paste capture.)
//!
//! IRON RULES:
//!   * The token NEVER leaves this process except in the single authenticated
//!     HTTPS `PUT /team/claude-identity` body. It is NEVER logged, NEVER returned
//!     to the frontend, NEVER written to the user's real `~/.claude`, and NEVER
//!     persisted locally by Helmor.
//!   * The in-memory token buffer is `Zeroizing` and scrubbed after use.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::{claude_identity_url, WORKER_TIMEOUT};

// ---------------------------------------------------------------------------
// Captured token
// ---------------------------------------------------------------------------

/// The long-lived OAuth token captured by the OAuth flow, held in a
/// `zeroize::Zeroizing<String>` so its `Drop` scrubs the heap bytes. Constructed
/// by [`super::claude_oauth`] and consumed by [`upload_to_worker`].
pub(super) struct CapturedToken {
    oauth_token: Zeroizing<String>,
}

impl CapturedToken {
    /// Wrap an already-zeroizing token string.
    pub(super) fn new(oauth_token: Zeroizing<String>) -> Self {
        Self { oauth_token }
    }

    /// Borrow the token as `&str` (used by the upload-body builder).
    pub(super) fn as_str(&self) -> &str {
        self.oauth_token.as_str()
    }
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
    #[allow(dead_code)]
    changed: bool,
}

/// Build the JSON upload body string. Separated out so a unit test can assert
/// the exact wire shape (a single camelCase `oauthToken` key, the token present
/// and no snake_case leakage) without touching the network. The returned
/// `String` carries the token and is the caller's responsibility to drop.
fn build_upload_body_json(token: &CapturedToken) -> anyhow::Result<String> {
    let body = UploadBody {
        oauth_token: token.as_str(),
    };
    serde_json::to_string(&body).context("Failed to serialize cloud-identity upload body")
}

// ---------------------------------------------------------------------------
// Worker round-trip
// ---------------------------------------------------------------------------

/// PUT the captured token to the Worker over the authenticated route. NEVER logs
/// the body. Blocking reqwest — the async OAuth command wraps the call in
/// `spawn_blocking`.
pub(super) fn upload_to_worker(
    worker_base: &str,
    team_token: &str,
    token: &CapturedToken,
) -> anyhow::Result<()> {
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

    // Parse (and discard) the metadata echo to confirm the response shape.
    response
        .json::<UploadResponse>()
        .context("Worker returned an unexpected cloud-identity response")?;
    Ok(())
}

// NB: status is read directly from the Worker by the frontend
// (`team-api.getCloudClaudeIdentityStatus`); there is no Rust status command.

// ---------------------------------------------------------------------------
// Tests (pure helpers only — no network)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_body_is_just_camel_case_oauth_token() {
        let token = CapturedToken::new(Zeroizing::new(
            "sk-ant-oat01-secret123456789012345".to_string(),
        ));
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
        let captured = CapturedToken::new(Zeroizing::new(
            "sk-ant-oat01-SUPER-SECRET-1234567890".to_string(),
        ));
        // The redacting Debug must NOT leak the secret (Zeroizing's own Debug
        // would print it — see the hand-written impl).
        assert!(!format!("{captured:?}").contains("SUPER-SECRET"));
        // And the deref the upload path relies on still works.
        assert_eq!(captured.as_str(), "sk-ant-oat01-SUPER-SECRET-1234567890");
    }
}
