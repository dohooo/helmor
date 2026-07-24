//! Cloud Run Identity — Claude subscription OAuth (PKCE) broker, local half.
//!
//! SECURITY-CRITICAL. Captures a user's Claude **subscription** long-lived OAuth
//! token (`sk-ant-oat01…`, an inference-only token valid ~1 year) by driving the
//! official Claude Code OAuth flow OURSELVES — PKCE authorize URL, a loopback
//! `/callback`, and a code→token exchange — then hands the token to the per-team
//! `ClaudeIdentity` Durable Object on the control-plane Worker (the single owner
//! of the secret at rest). This replaces the old `claude setup-token` PTY /
//! manual-paste flow with a deterministic, in-process flow that never shells out
//! to the CLI and never asks the user to copy/paste anything.
//!
//! ## Flow (single `authorize_cloud_claude_identity` command)
//!   1. Generate PKCE (`code_verifier`, `code_challenge = S256(verifier)`) and a
//!      CSRF `state`, all in `zeroize::Zeroizing`.
//!   2. Bind a loopback HTTP server on `127.0.0.1:{PORT}` (OS-assigned port) and
//!      build the authorize URL with `redirect_uri = http://localhost:{PORT}/callback`.
//!   3. Open the authorize URL in the user's browser via the opener plugin.
//!   4. Await the browser's `GET /callback?code=…&state=…`: validate `state` ==
//!      ours (else 400), 302-redirect the browser to the hosted success page,
//!      hand the `code` back to the command, and shut the loopback down.
//!   5. POST the `code` + `code_verifier` to the token endpoint and parse the
//!      `access_token` into `Zeroizing`.
//!   6. PUT `{ oauthToken }` to the Worker (`super::claude` owns the upload).
//!
//! ## Why raw hyper for the loopback (431 avoidance)
//! `localhost` cookies are scoped per-host, not per-port, so a machine running
//! several local dev servers accumulates enough cookies that the callback
//! request's headers exceed a default server's header limits and it returns
//! **HTTP 431** before the handler runs (the original setup-token failure mode).
//! `axum::serve` exposes NO connection-builder configuration, so we serve the
//! `/callback` on `hyper_util`'s `auto::Builder` directly with a generous
//! explicit `http1().max_headers(...)` + `max_buf_size(...)` so cookie-bloated
//! requests still parse.
//!
//! IRON RULES (identical to the Codex broker):
//!   * The `code_verifier`, `state`, authorization `code`, and `access_token`
//!     live in `Zeroizing` and are NEVER logged, NEVER returned across IPC,
//!     NEVER written to disk. Error messages carry non-sensitive text only.
//!   * The token NEVER leaves this process except in the single authenticated
//!     HTTPS `PUT /team/claude-identity` body.

use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rand::Rng as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use url::Url;
use zeroize::Zeroizing;

use super::claude::{upload_to_worker, CapturedToken};
use super::claude_identity_url;
use crate::commands::common::CmdResult;

/// Default OAuth client id for the Claude Code subscription flow. Verified
/// byte-identical against the decompiled `claude-code` binary. Overridable via
/// `CLAUDE_CODE_OAUTH_CLIENT_ID` to match the CLI's own override seam.
const DEFAULT_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/// OAuth scope minted: inference-only (no profile / account claim).
const OAUTH_SCOPE: &str = "user:inference";

/// Authorize endpoint (the consent page the user signs in on).
const AUTHORIZE_ENDPOINT: &str = "https://claude.com/cai/oauth/authorize";

/// Token endpoint (the code→token exchange POST target).
const TOKEN_ENDPOINT: &str = "https://platform.claude.com/v1/oauth/token";

/// Where we 302 the browser after a valid callback — the hosted success page the
/// CLI uses, so the user sees the familiar "you can close this tab" screen.
const SUCCESS_REDIRECT: &str = "https://platform.claude.com/oauth/code/success?app=claude-code";

/// `expires_in` we send in the exchange body (mirrors the CLI: request the
/// maximum ~1-year lifetime for the minted inference token).
const EXCHANGE_EXPIRES_IN: u64 = 31_536_000;

/// Hard cap on how long we wait for the browser to complete sign-in and hit our
/// loopback `/callback`. Generous for a human OAuth consent flow; bounds a
/// never-completed flow so it can't wedge forever.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(600);

/// Timeout for the deterministic code→token exchange POST.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);

/// Generous header limits for the loopback connection so cookie-bloated requests
/// parse instead of 431-ing. The default is 100 headers; localhost cookie bloat
/// (per-host, not per-port) can blow past both the header count and the read
/// buffer, so we raise both well above anything a browser will send.
const LOOPBACK_MAX_HEADERS: usize = 1000;
const LOOPBACK_MAX_BUF_BYTES: usize = 1024 * 1024;

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/// PKCE + CSRF parameters for one authorize attempt. `verifier` and `state` are
/// secrets held in `Zeroizing`; `challenge` is the public S256 hash of the
/// verifier (safe to put in the authorize URL).
struct Pkce {
    verifier: Zeroizing<String>,
    challenge: String,
    state: Zeroizing<String>,
}

/// 32 cryptographically-random bytes, base64url-no-pad encoded. Used for both
/// the PKCE `code_verifier` and the CSRF `state`.
fn random_b64url_32() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    // Scrub the raw entropy buffer; only the encoded string lives on.
    bytes.iter_mut().for_each(|b| *b = 0);
    encoded
}

/// Compute the PKCE S256 challenge: `base64url-no-pad(sha256(verifier))`.
fn code_challenge_s256(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

impl Pkce {
    /// Generate a fresh verifier + S256 challenge + CSRF state.
    fn generate() -> Self {
        let verifier = Zeroizing::new(random_b64url_32());
        let challenge = code_challenge_s256(&verifier);
        let state = Zeroizing::new(random_b64url_32());
        Self {
            verifier,
            challenge,
            state,
        }
    }
}

/// Resolve the OAuth client id: env override first, else the verified default.
fn client_id() -> String {
    std::env::var("CLAUDE_CODE_OAUTH_CLIENT_ID")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string())
}

/// The loopback redirect URI for the given port. CRITICAL: the host string is
/// the literal `localhost` (NOT `127.0.0.1`) and the EXACT SAME string must
/// appear in BOTH the authorize URL and the token-exchange body — Claude's OAuth
/// server compares them verbatim. We bind the socket to `127.0.0.1` separately.
fn redirect_uri(port: u16) -> String {
    format!("http://localhost:{port}/callback")
}

/// Build the authorize URL the user signs in on. The `code_challenge` is public;
/// the `state` is a CSRF nonce (not a bearer secret) but we still avoid logging
/// the full URL. `code=true` mirrors the CLI's authorize request.
fn build_authorize_url(pkce: &Pkce, client_id: &str, redirect_uri: &str) -> anyhow::Result<String> {
    let mut url = Url::parse(AUTHORIZE_ENDPOINT).context("invalid authorize endpoint")?;
    url.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", OAUTH_SCOPE)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &pkce.state);
    Ok(url.into())
}

// ---------------------------------------------------------------------------
// Loopback callback server
// ---------------------------------------------------------------------------

/// Bind a loopback TCP listener on an OS-assigned port of `127.0.0.1`. Returns
/// the listener and the chosen port (used to build the `redirect_uri`).
async fn bind_loopback() -> anyhow::Result<(tokio::net::TcpListener, u16)> {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .context("Failed to bind the OAuth loopback server")?;
    let port = listener
        .local_addr()
        .context("Failed to read the OAuth loopback port")?
        .port();
    Ok((listener, port))
}

/// Parse `code` + `state` out of a `/callback` request's query string. Returns
/// `None` for either field if absent.
fn parse_callback_query(uri: &hyper::Uri, port: u16) -> (Option<String>, Option<String>) {
    // Build an absolute URL so `url` can parse the query reliably regardless of
    // how the path/query arrive in the request line.
    let full = format!("http://localhost:{port}{uri}");
    let Ok(parsed) = Url::parse(&full) else {
        return (None, None);
    };
    let mut code = None;
    let mut state = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }
    (code, state)
}

/// 302-redirect the browser to the hosted success page.
fn redirect_response() -> Response<Full<Bytes>> {
    let mut resp = Response::new(Full::new(Bytes::new()));
    *resp.status_mut() = StatusCode::FOUND;
    resp.headers_mut().insert(
        hyper::header::LOCATION,
        hyper::header::HeaderValue::from_static(SUCCESS_REDIRECT),
    );
    resp
}

/// A plain-text error response for a bad/foreign callback (e.g. state mismatch).
/// The body is a generic, non-sensitive message.
fn error_response(status: StatusCode, message: &'static str) -> Response<Full<Bytes>> {
    let mut resp = Response::new(Full::new(Bytes::from_static(message.as_bytes())));
    *resp.status_mut() = status;
    resp
}

/// Outcome a single served connection wants to report back to the awaiting task.
enum CallbackOutcome {
    /// A valid `/callback` with a matching state — carries the captured code.
    Got(Zeroizing<String>),
    /// A `/callback` whose state did not match ours (CSRF / stale tab) — fatal.
    StateMismatch,
}

/// Pure decision for one callback request: maps `(path, code, state)` against the
/// expected CSRF state to an outcome to signal (if any) + the HTTP status to
/// return. Extracted so the CSRF / redirect / 404 branches are unit-testable
/// without constructing a live `Request<Incoming>`. Returns `(outcome, status)`:
/// `outcome` is `None` for a non-`/callback` request (no flow resolution).
fn decide_callback(
    path: &str,
    code: Option<String>,
    state: Option<&str>,
    expected_state: &str,
) -> (Option<CallbackOutcome>, StatusCode) {
    if path != "/callback" {
        return (None, StatusCode::NOT_FOUND);
    }
    // CSRF: the callback's state MUST equal the state we generated. A mismatch
    // (or absent state) means a stale/foreign tab hit our port — reject + fail.
    if state != Some(expected_state) {
        return (
            Some(CallbackOutcome::StateMismatch),
            StatusCode::BAD_REQUEST,
        );
    }
    match code.filter(|c| !c.is_empty()) {
        // State matched but no code — fail the flow (generic, non-sensitive msg).
        None => (
            Some(CallbackOutcome::StateMismatch),
            StatusCode::BAD_REQUEST,
        ),
        Some(code) => (
            Some(CallbackOutcome::Got(Zeroizing::new(code))),
            StatusCode::FOUND,
        ),
    }
}

/// Shared one-shot sender, behind a mutex so the first served callback wins and
/// later requests on a lingering connection can't double-send.
type OutcomeSender = Arc<Mutex<Option<oneshot::Sender<CallbackOutcome>>>>;

/// Handle one HTTP request to the loopback. Only `GET /callback` is meaningful;
/// anything else gets a 404 (and does not resolve the flow). On `/callback` we
/// validate `state` via [`decide_callback`], signal the outcome exactly once, and
/// redirect the browser (or return a non-sensitive error).
async fn handle_callback(
    req: Request<Incoming>,
    expected_state: Arc<Zeroizing<String>>,
    port: u16,
    tx: OutcomeSender,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let (code, state) = parse_callback_query(req.uri(), port);
    let (outcome, status) = decide_callback(
        req.uri().path(),
        code,
        state.as_deref(),
        expected_state.as_str(),
    );
    if let Some(outcome) = outcome {
        signal_once(&tx, outcome);
    }
    Ok(match status {
        StatusCode::FOUND => redirect_response(),
        StatusCode::NOT_FOUND => error_response(StatusCode::NOT_FOUND, "not found"),
        _ => error_response(
            StatusCode::BAD_REQUEST,
            "Authorization failed. Please retry sign-in.",
        ),
    })
}

/// Send the outcome through the one-shot at most once (first served callback
/// wins). Never logs the outcome (it may carry the code).
fn signal_once(tx: &OutcomeSender, outcome: CallbackOutcome) {
    if let Ok(mut guard) = tx.lock() {
        if let Some(sender) = guard.take() {
            let _ = sender.send(outcome);
        }
    }
}

/// Serve the loopback until a callback resolves the flow, the timeout elapses, or
/// the awaited signal arrives. Returns the captured authorization `code`.
///
/// Runs a manual accept loop on raw hyper (NOT `axum::serve`) so we can set a
/// generous `http1::Builder::max_headers(...)` — the 431-avoidance the whole
/// module hinges on. Each accepted connection is served on its own task; the
/// first to produce a valid `/callback` signals via the one-shot and we stop.
async fn await_callback(
    listener: tokio::net::TcpListener,
    expected_state: Zeroizing<String>,
    port: u16,
) -> anyhow::Result<Zeroizing<String>> {
    let (otx, orx) = oneshot::channel::<CallbackOutcome>();
    let tx: OutcomeSender = Arc::new(Mutex::new(Some(otx)));
    let expected_state = Arc::new(expected_state);

    // Accept loop: stop as soon as the one-shot is consumed (a callback landed)
    // or the deadline trips. `orx` is awaited concurrently with accepting.
    let accept = async {
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _peer)) => stream,
                // Transient accept errors: brief backoff, keep serving.
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            let io = TokioIo::new(stream);
            let tx = tx.clone();
            let expected_state = expected_state.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req| {
                    handle_callback(req, expected_state.clone(), port, tx.clone())
                });
                // Raw HTTP/1 hyper connection with a generous header budget — the
                // reason we are not on `axum::serve` (which exposes no builder
                // config). A browser OAuth callback is always h1, so `max_headers`
                // + `max_buf_size` here are exactly what defeats the 431.
                let mut builder = http1::Builder::new();
                builder
                    .max_headers(LOOPBACK_MAX_HEADERS)
                    .max_buf_size(LOOPBACK_MAX_BUF_BYTES);
                let _ = builder.serve_connection(io, service).await;
            });
        }
    };

    tokio::select! {
        biased;
        outcome = orx => {
            match outcome {
                Ok(CallbackOutcome::Got(code)) => Ok(code),
                Ok(CallbackOutcome::StateMismatch) => {
                    anyhow::bail!(
                        "Claude sign-in failed (state mismatch). Re-run authorization."
                    )
                }
                Err(_) => anyhow::bail!("Claude sign-in was interrupted. Re-run authorization."),
            }
        }
        () = tokio::time::sleep(CALLBACK_TIMEOUT) => {
            anyhow::bail!(
                "Claude sign-in timed out after {} seconds. Re-run authorization.",
                CALLBACK_TIMEOUT.as_secs()
            )
        }
        // The accept loop never completes; it is here only to drive connections
        // while we await the outcome. (Unreachable arm body.)
        () = accept => unreachable!("loopback accept loop exited unexpectedly"),
    }
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/// The exchange request body. `redirect_uri` MUST byte-match the authorize URL's
/// (same literal `localhost` host + port). Sent as JSON.
#[derive(serde::Serialize)]
struct ExchangeBody<'a> {
    grant_type: &'a str,
    code: &'a str,
    redirect_uri: &'a str,
    client_id: &'a str,
    code_verifier: &'a str,
    state: &'a str,
    expires_in: u64,
}

/// The subset of the token response we read: the long-lived inference token.
#[derive(Deserialize)]
struct ExchangeResponse {
    access_token: Option<String>,
}

/// POST the authorization `code` + PKCE `code_verifier` to the token endpoint and
/// return the minted `access_token` (`sk-ant-oat01…`) in `Zeroizing`.
///
/// Header is `Content-Type: application/json` ONLY (NO `anthropic-beta` on the
/// exchange). `token_endpoint` is injectable so tests never hit the live host.
/// Errors carry HTTP-status-only diagnostics — never the code or token bytes.
async fn exchange_code_for_token(
    token_endpoint: &str,
    code: &Zeroizing<String>,
    verifier: &Zeroizing<String>,
    state: &Zeroizing<String>,
    client_id: &str,
    redirect_uri: &str,
) -> anyhow::Result<CapturedToken> {
    let body = ExchangeBody {
        grant_type: "authorization_code",
        code: code.as_str(),
        redirect_uri,
        client_id,
        code_verifier: verifier.as_str(),
        state: state.as_str(),
        expires_in: EXCHANGE_EXPIRES_IN,
    };
    // Serialize into a zeroizing buffer — it carries the code + verifier.
    let body_json = Zeroizing::new(
        serde_json::to_string(&body).context("Failed to serialize the OAuth exchange body")?,
    );

    let client = reqwest::Client::builder()
        .timeout(EXCHANGE_TIMEOUT)
        .build()
        .context("Failed to build the OAuth HTTP client")?;

    let response = client
        .post(token_endpoint)
        .header("Content-Type", "application/json")
        .body(body_json.to_string())
        .send()
        .await
        .context("Failed to reach the Claude token endpoint")?;

    let status = response.status();
    if !status.is_success() {
        anyhow::bail!(
            "Claude rejected the OAuth code exchange (HTTP {})",
            status.as_u16()
        );
    }

    // Read the body into a zeroizing buffer (it contains the access token) before
    // parsing, so the raw JSON never lingers in a plain String.
    let raw = Zeroizing::new(
        response
            .text()
            .await
            .context("Failed to read the Claude token response")?,
    );
    let parsed: ExchangeResponse =
        serde_json::from_str(&raw).context("Claude returned an unexpected token response")?;
    let token = parsed
        .access_token
        .filter(|t| !t.is_empty())
        .context("Claude token response had no access_token")?;

    Ok(CapturedToken::new(Zeroizing::new(token)))
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/// Full authorize flow. Validates the Worker target first, runs PKCE, serves the
/// loopback, exchanges the code, and uploads the token. The blocking upload is
/// wrapped in `spawn_blocking` so it never stalls the async runtime.
async fn authorize(
    app: &tauri::AppHandle,
    worker_url: &str,
    team_token: &str,
) -> anyhow::Result<()> {
    // Validate the Worker target BEFORE opening a browser, so we don't pop a
    // sign-in only to discover team mode isn't configured.
    claude_identity_url(worker_url)?;

    let pkce = Pkce::generate();
    let client_id = client_id();

    let (listener, port) = bind_loopback().await?;
    let redirect_uri = redirect_uri(port);
    let authorize_url = build_authorize_url(&pkce, &client_id, &redirect_uri)?;

    // Open the authorize URL in the user's browser. The URL carries only the
    // public PKCE challenge + CSRF state (no secret), so it is safe to hand off.
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(authorize_url, None::<&str>)
            .context("Failed to open the Claude sign-in page in your browser")?;
    }

    // The CSRF state we hand the server must match what we put in the URL; clone
    // it out of the zeroizing buffer (the server holds its own copy).
    let expected_state = Zeroizing::new(pkce.state.to_string());
    let code = await_callback(listener, expected_state, port).await?;

    let token = exchange_code_for_token(
        TOKEN_ENDPOINT,
        &code,
        &pkce.verifier,
        &pkce.state,
        &client_id,
        &redirect_uri,
    )
    .await?;
    // The code is spent; drop it now (its zeroizing Drop scrubs the bytes).
    drop(code);

    // `upload_to_worker` is blocking reqwest; run it off the async runtime. Move
    // the (zeroizing) token + owned strings into the blocking closure.
    let worker_url = worker_url.to_string();
    let team_token = Zeroizing::new(team_token.to_string());
    tokio::task::spawn_blocking(move || {
        upload_to_worker(&worker_url, &team_token, &token)?;
        // token + team_token drop here → heap scrubbed.
        anyhow::Ok(())
    })
    .await
    .map_err(|e| anyhow::anyhow!("OAuth upload task failed: {e}"))??;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Authorize a Claude **subscription** identity for the team's cloud sandbox via
/// our own OAuth (PKCE) flow.
///
/// Opens the Claude sign-in page in the user's browser, captures the OAuth
/// callback on a loopback `/callback`, exchanges the code for a long-lived
/// inference token, and PUTs it to the team Worker (`PUT {worker_url}/team/claude-identity`,
/// body `{ oauthToken }`) authenticated with the team bearer. The token / code /
/// verifier / state are never returned to the caller, never logged, and never
/// written to disk; the loopback binds `127.0.0.1` and shuts down after the
/// callback.
///
/// `worker_url` + `team_token` come from the frontend's saved team config
/// (`getTeamConfig()` in `src/lib/team-mode.ts`) — the Rust backend can't read
/// the webview's `localStorage`, so the caller forwards them.
#[tauri::command]
pub async fn authorize_cloud_claude_identity(
    app: tauri::AppHandle,
    worker_url: String,
    team_token: String,
) -> CmdResult<()> {
    Ok(authorize(&app, &worker_url, &team_token).await?)
}

// ---------------------------------------------------------------------------
// Tests (pure helpers only — no browser, no network)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_base64url_no_pad_of_verifier() {
        let pkce = Pkce::generate();
        // The challenge must equal base64url-no-pad(sha256(verifier)).
        let expected = {
            let digest = Sha256::digest(pkce.verifier.as_bytes());
            URL_SAFE_NO_PAD.encode(digest)
        };
        assert_eq!(pkce.challenge, expected);
        // base64url-no-pad never contains '+', '/', or '=' padding.
        assert!(!pkce.challenge.contains('+'));
        assert!(!pkce.challenge.contains('/'));
        assert!(!pkce.challenge.contains('='));
        // A 32-byte SHA-256 digest encodes to 43 base64url chars (no pad).
        assert_eq!(pkce.challenge.len(), 43);
    }

    #[test]
    fn pkce_verifier_and_state_are_distinct_random_b64url() {
        let a = Pkce::generate();
        let b = Pkce::generate();
        // Distinct per generation (random).
        assert_ne!(a.verifier.as_str(), b.verifier.as_str());
        assert_ne!(a.state.as_str(), b.state.as_str());
        // Verifier and state are independent within one generation.
        assert_ne!(a.verifier.as_str(), a.state.as_str());
        // 32 bytes → 43 base64url-no-pad chars, URL-safe charset only.
        for s in [a.verifier.as_str(), a.state.as_str()] {
            assert_eq!(s.len(), 43);
            assert!(s
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
        }
    }

    #[test]
    fn known_vector_code_challenge_matches_rfc_example() {
        // RFC 7636 Appendix B worked example: a known verifier → known challenge.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(code_challenge_s256(verifier), expected);
    }

    #[test]
    fn redirect_uri_uses_literal_localhost_host() {
        // The redirect_uri host MUST be the literal "localhost" (not 127.0.0.1)
        // and identical between authorize + exchange.
        assert_eq!(redirect_uri(62189), "http://localhost:62189/callback");
        assert!(redirect_uri(1).starts_with("http://localhost:"));
        assert!(!redirect_uri(1).contains("127.0.0.1"));
    }

    #[test]
    fn authorize_url_carries_the_required_oauth_params() {
        let pkce = Pkce::generate();
        let redirect = redirect_uri(50505);
        let url_str = build_authorize_url(&pkce, "test-client-id", &redirect).unwrap();
        let parsed = Url::parse(&url_str).unwrap();

        // Correct endpoint.
        assert_eq!(parsed.scheme(), "https");
        assert_eq!(parsed.host_str(), Some("claude.com"));
        assert_eq!(parsed.path(), "/cai/oauth/authorize");

        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(
            q.get("client_id").map(String::as_str),
            Some("test-client-id")
        );
        assert_eq!(q.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(q.get("scope").map(String::as_str), Some("user:inference"));
        assert_eq!(
            q.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(q.get("code").map(String::as_str), Some("true"));
        // redirect_uri round-trips to the literal localhost callback.
        assert_eq!(
            q.get("redirect_uri").map(String::as_str),
            Some("http://localhost:50505/callback")
        );
        // The public challenge + CSRF state are present and match the PKCE.
        assert_eq!(
            q.get("code_challenge").map(String::as_str),
            Some(pkce.challenge.as_str())
        );
        assert_eq!(
            q.get("state").map(String::as_str),
            Some(pkce.state.as_str())
        );
    }

    #[test]
    fn client_id_defaults_to_verified_literal() {
        // With no env override, the verified default literal is used. (We don't
        // set the env var here to avoid cross-test interference; the default
        // branch is what production uses.)
        if std::env::var_os("CLAUDE_CODE_OAUTH_CLIENT_ID").is_none() {
            assert_eq!(client_id(), DEFAULT_CLIENT_ID);
        }
    }

    #[test]
    fn parse_callback_query_extracts_code_and_state() {
        let uri: hyper::Uri = "/callback?code=the-code&state=the-state".parse().unwrap();
        let (code, state) = parse_callback_query(&uri, 1234);
        assert_eq!(code.as_deref(), Some("the-code"));
        assert_eq!(state.as_deref(), Some("the-state"));

        // Missing fields degrade to None rather than panicking.
        let uri2: hyper::Uri = "/callback".parse().unwrap();
        let (code2, state2) = parse_callback_query(&uri2, 1234);
        assert!(code2.is_none());
        assert!(state2.is_none());
    }

    #[test]
    fn callback_with_wrong_state_is_rejected() {
        // CSRF guard: a callback whose state != ours must surface StateMismatch
        // (a 400), and must NEVER resolve as a captured code — even when a code
        // is present.
        let (outcome, status) = decide_callback(
            "/callback",
            Some("the-code".to_string()),
            Some("WRONG-state"),
            "RIGHT-state",
        );
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(matches!(outcome, Some(CallbackOutcome::StateMismatch)));
    }

    #[test]
    fn callback_with_matching_state_captures_code_and_redirects() {
        let (outcome, status) = decide_callback(
            "/callback",
            Some("the-code".to_string()),
            Some("RIGHT-state"),
            "RIGHT-state",
        );
        assert_eq!(status, StatusCode::FOUND);
        match outcome {
            Some(CallbackOutcome::Got(code)) => assert_eq!(code.as_str(), "the-code"),
            _ => panic!("expected a captured code"),
        }
    }

    #[test]
    fn callback_missing_state_or_code_or_path_fails_safely() {
        // Absent state → mismatch (400), even with a code present.
        let (o, s) = decide_callback("/callback", Some("c".to_string()), None, "expected");
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert!(matches!(o, Some(CallbackOutcome::StateMismatch)));

        // Matching state but empty/missing code → mismatch (400), no capture.
        let (o, s) = decide_callback("/callback", None, Some("expected"), "expected");
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert!(matches!(o, Some(CallbackOutcome::StateMismatch)));
        let (o, s) = decide_callback(
            "/callback",
            Some(String::new()),
            Some("expected"),
            "expected",
        );
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert!(matches!(o, Some(CallbackOutcome::StateMismatch)));

        // Non-/callback path → 404, no flow resolution.
        let (o, s) = decide_callback("/favicon.ico", None, None, "expected");
        assert_eq!(s, StatusCode::NOT_FOUND);
        assert!(o.is_none());
    }

    #[test]
    fn exchange_body_has_exact_wire_shape() {
        let body = ExchangeBody {
            grant_type: "authorization_code",
            code: "the-code",
            redirect_uri: "http://localhost:1/callback",
            client_id: "cid",
            code_verifier: "the-verifier",
            state: "the-state",
            expires_in: EXCHANGE_EXPIRES_IN,
        };
        let value: serde_json::Value = serde_json::to_value(&body).unwrap();
        assert_eq!(value["grant_type"], "authorization_code");
        assert_eq!(value["code"], "the-code");
        assert_eq!(value["redirect_uri"], "http://localhost:1/callback");
        assert_eq!(value["client_id"], "cid");
        assert_eq!(value["code_verifier"], "the-verifier");
        assert_eq!(value["state"], "the-state");
        assert_eq!(value["expires_in"], 31_536_000);
        // No refresh-token / access-token fields leak into the request body.
        assert!(value.get("refresh_token").is_none());
        assert!(value.get("access_token").is_none());
    }

    #[tokio::test]
    async fn exchange_parses_access_token_from_stub_endpoint() {
        // Spin a one-shot stub token endpoint so CI never hits platform.claude.com.
        let app = axum::Router::new().route(
            "/v1/oauth/token",
            axum::routing::post(|| async {
                axum::Json(serde_json::json!({
                    "access_token": "sk-ant-oat01-STUBTOKEN-1234567890",
                    "token_type": "Bearer",
                    "expires_in": 31_536_000
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let endpoint = format!("http://{addr}/v1/oauth/token");

        let token = exchange_code_for_token(
            &endpoint,
            &Zeroizing::new("code".to_string()),
            &Zeroizing::new("verifier".to_string()),
            &Zeroizing::new("state".to_string()),
            "cid",
            "http://localhost:1/callback",
        )
        .await
        .unwrap();
        assert_eq!(token.as_str(), "sk-ant-oat01-STUBTOKEN-1234567890");
    }

    #[tokio::test]
    async fn exchange_surfaces_http_error_without_secrets() {
        let app = axum::Router::new().route(
            "/v1/oauth/token",
            axum::routing::post(|| async {
                (axum::http::StatusCode::BAD_REQUEST, "invalid_grant")
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let endpoint = format!("http://{addr}/v1/oauth/token");

        let err = exchange_code_for_token(
            &endpoint,
            &Zeroizing::new("SECRET-CODE".to_string()),
            &Zeroizing::new("SECRET-VERIFIER".to_string()),
            &Zeroizing::new("state".to_string()),
            "cid",
            "http://localhost:1/callback",
        )
        .await
        .unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("400"));
        // The error must never echo the code or verifier.
        assert!(!msg.contains("SECRET-CODE"));
        assert!(!msg.contains("SECRET-VERIFIER"));
    }
}
