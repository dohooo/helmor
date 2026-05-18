//! Claude OAuth rate-limit fetcher (macOS only — non-macOS targets
//! short-circuit and never produce usage data).
//!
//! ```text
//! fetch_claude_rate_limits   <- public entrypoint
//!   obtain_credentials       <- cache + keychain + refresh orchestration
//!     cache::*               <- in-memory token cache
//!     keychain::*            <- /usr/bin/security fork + framework probe
//!     refresh::*             <- delegated refresh via `claude auth status`
//!     credentials::*         <- types + parsing + ranking
//!     user_agent::*          <- claude-code/<version> for the HTTP UA
//!     process::*             <- generic spawn-with-timeout helper
//! ```
//!
//! Refresh is **delegated only**: when the access token expires we run
//! `claude auth status --json` and let Claude CLI refresh its own
//! credentials in its own keychain item. We never call Anthropic's
//! refresh endpoint ourselves — that would risk invalidating Claude
//! CLI's refresh_token under rotation. If the delegated path fails we
//! surface the error; missing one usage-stat tick is acceptable,
//! corrupting Claude CLI's auth state is not.

mod cache;
mod credentials;
mod keychain;
mod process;
mod refresh;
mod user_agent;

use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;
use std::time::Duration;

use cache::CREDENTIALS_CACHE;
use credentials::{now_ms, ClaudeOAuthCredentials};
use keychain::load_best_credentials;
use refresh::run_claude_auth_status;
use user_agent::claude_code_user_agent;

const CLAUDE_OAUTH_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";

/// Pull the raw `oauth/usage` response body straight from Anthropic.
///
/// The body is stored verbatim in `settings.app.claude_rate_limits` and
/// parsed on the frontend — no shape-mapping happens in Rust on purpose,
/// so changes to Anthropic's (undocumented) field set don't require a DB
/// migration.
pub fn fetch_claude_rate_limits() -> Result<String> {
    let credentials = obtain_credentials()?;

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("Failed to build Claude usage client")?;

    let response = client
        .get(CLAUDE_OAUTH_USAGE_URL)
        .bearer_auth(&credentials.access_token)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("anthropic-beta", CLAUDE_OAUTH_BETA)
        .header("User-Agent", claude_code_user_agent())
        .send()
        .context("Claude usage request failed")?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        // Cached token was rejected. Drop the cache so the next call
        // re-reads the keychain (or refreshes) instead of looping on
        // the dead token.
        CREDENTIALS_CACHE.invalidate();
    }
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(anyhow!(
            "Claude usage request failed with HTTP {status}: {body}"
        ));
    }
    response.text().context("Failed to read Claude usage body")
}

/// Returns valid credentials, preferring the in-memory cache.
///
/// Refresh strategy when the keychain copy is stale: **delegated only**.
/// We always go through `claude auth status` so Claude CLI is the one
/// that talks to Anthropic's refresh endpoint and writes the new
/// credentials back to its own keychain item. We never refresh
/// directly — that would risk rotating Claude CLI's refresh_token out
/// from under it (Anthropic uses rotation per OAuth best practice),
/// forcing the user to re-login in their terminal. If the delegated
/// path fails for any reason, we surface the error rather than fall
/// back; "no usage data this tick" is fine, "Claude CLI is now broken"
/// is not.
fn obtain_credentials() -> Result<ClaudeOAuthCredentials> {
    let now = now_ms();
    if let Some(cached) = CREDENTIALS_CACHE.get(now) {
        tracing::debug!("Claude OAuth cache hit");
        return Ok(cached);
    }

    let credentials = load_best_credentials()?;
    let credentials = if credentials.is_expired(now) {
        refresh_and_reload_keychain()?
    } else {
        credentials
    };
    if !credentials.has_required_scope() {
        return Err(anyhow!("Claude OAuth token missing user:profile scope"));
    }
    CREDENTIALS_CACHE.store(&credentials);
    Ok(credentials)
}

/// Delegate refresh to Claude CLI (which owns the keychain ACL and
/// writes the new tokens back to its own item), then re-read the
/// keychain to pick them up. Errors out cleanly if anything goes
/// wrong — we deliberately do not fall back to direct refresh.
fn refresh_and_reload_keychain() -> Result<ClaudeOAuthCredentials> {
    run_claude_auth_status()
        .context("Claude OAuth token expired and `claude auth status` could not refresh it")?;
    // Claude CLI just wrote new credentials to the keychain. Re-read
    // silently — `/usr/bin/security` is fast (~ms) and the user's
    // "Always Allow" grant covers it.
    let refreshed =
        load_best_credentials().context("Failed to re-read keychain after delegated refresh")?;
    if refreshed.is_expired(now_ms()) {
        return Err(anyhow!(
            "`claude auth status` ran but keychain still holds an expired token"
        ));
    }
    if !refreshed.has_required_scope() {
        return Err(anyhow!(
            "Refreshed Claude OAuth token missing user:profile scope"
        ));
    }
    tracing::info!("Claude OAuth refreshed via delegated `claude auth status`");
    Ok(refreshed)
}
