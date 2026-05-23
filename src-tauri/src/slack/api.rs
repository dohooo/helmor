//! Slack Web API client. Uses the captured browser session pair
//! (`xoxc-…` workspace token in the `token` form field, `xoxd-…` in a
//! single-letter `d` cookie) against the same `/api/<method>` endpoints
//! Slack's own web client hits.
//!
//! Why `wreq` (browser-emulating fork of `reqwest`) and not plain
//! `reqwest`: Slack's Cloudflare-fronted edge inspects the TLS
//! ClientHello on every request. Stock rustls produces a JA3 / JA4
//! fingerprint that no real browser sends, so Slack classifies the
//! connection as `unexpected_scraping` / `spoofed_user_agent` and
//! returns `invalid_auth` *before reading the token*. `wreq` with the
//! `Emulation::Chrome131` preset emits a real Chrome ClientHello + the
//! matching HTTP/2 SETTINGS frame, which gets us past the edge gate.
//! Confirmed by `korotovsky/slack-mcp-server#86` (Aug 2025) and the
//! `SLACK_MCP_CUSTOM_TLS=1` env var that production tools ship for
//! exactly this reason.
//!
//! Read-only: no `chat.postMessage`, no `reactions.add`. NEVER call
//! `users.list` (bulk user enumeration triggers Slack's AER and
//! permanently revokes the xoxc/xoxd pair — see same issue #86). Use
//! `users.info` lazily with the in-process TTL cache below.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use tokio::runtime::{Builder, Runtime};
use wreq::Client;
use wreq_util::Emulation;

use super::credentials::SlackCreds;

const SLACK_API_BASE: &str = "https://slack.com/api";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Real Chrome 131 UA — matches `Emulation::Chrome131`. Both
/// User-Agent and TLS fingerprint MUST advertise the same browser
/// version, otherwise Slack's edge flags the mismatch.
const CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/// Soft cap on per-user info caching. Channels with hundreds of distinct
/// authors are rare in a single inbox refresh; this stays small on
/// purpose because the cache is per-process and we don't want it
/// leaking memory across long sessions.
const USERS_INFO_TTL: Duration = Duration::from_secs(5 * 60);

/// Shared HTTP client. wreq's connection pool keeps Keep-Alive alive
/// across multiple endpoint calls in one inbox refresh.
fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .emulation(Emulation::Chrome131)
            .user_agent(CHROME_UA)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("Failed to build wreq client for Slack API")
    })
}

/// Dedicated tokio runtime for HTTP work. We can't use Tauri's main
/// runtime via `tauri::async_runtime::block_on` because all our
/// callers run inside `spawn_blocking`, and re-entering the parent
/// runtime from a blocking worker deadlocks (the worker holds the
/// blocking-pool slot the runtime would need to drive I/O). A
/// separate multi-thread runtime sidesteps that — block_on here only
/// blocks our worker thread, not the parent runtime.
fn http_runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("helmor-slack-http")
            .build()
            .expect("Failed to build tokio runtime for Slack HTTP")
    })
}

/// Lightweight in-process `users.info` cache keyed by `(team_id, user_id)`.
/// Cleared on app restart; nothing persists.
#[derive(Default)]
struct UserCache {
    entries: HashMap<(String, String), (Instant, UserInfo)>,
}

fn user_cache() -> &'static Mutex<UserCache> {
    static CACHE: OnceLock<Mutex<UserCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(UserCache::default()))
}

#[derive(Debug, Clone, Deserialize)]
pub struct UserInfo {
    /// `display_name` if set; otherwise `real_name`; otherwise the user
    /// id itself. Computed server-side here so the caller doesn't have
    /// to apply the fallback chain.
    pub display_name: String,
    pub avatar_url: Option<String>,
}

/// A raw error coming back from the Slack Web API. The `error` field is
/// Slack's documented short-code (e.g. `not_authed`, `invalid_auth`,
/// `ratelimited`); callers branch on it to decide whether to wipe the
/// stored token and prompt for re-login.
#[derive(Debug, Clone)]
pub struct SlackApiError {
    pub method: String,
    pub error: String,
}

impl std::fmt::Display for SlackApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Slack API error from {}: {}", self.method, self.error)
    }
}

impl std::error::Error for SlackApiError {}

impl SlackApiError {
    pub fn is_auth_failure(&self) -> bool {
        matches!(
            self.error.as_str(),
            "not_authed" | "invalid_auth" | "account_inactive" | "token_revoked"
        )
    }
}

/// Build the `Cookie` header. We send both `d` (the long-lived
/// session cookie) and `d-s` (a sibling cookie set by Slack's web
/// client; its value is unix-seconds-since-login minus 10. slackdump
/// always emits this, and Slack's edge expects both).
fn cookie_header(creds: &SlackCreds) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .saturating_sub(10);
    format!("d={}; d-s={now}", creds.xoxd)
}

/// Issue a POST against `slack.com/api/<method>` with the captured
/// `d`/`d-s` cookies, browser-shaped headers, and parse Slack's
/// `{ok: bool, …}` envelope.
///
/// Body shape is `application/x-www-form-urlencoded` (not multipart):
/// the real Slack web client uses urlencoded for /api/auth.test and
/// most read endpoints; multipart from a Chrome-fingerprinted TLS
/// connection is a bot tell because real browsers only switch to
/// multipart when actually uploading binary parts.
///
/// Synchronous wrapper around async wreq via
/// `tauri::async_runtime::block_on` so callers (currently all in
/// `run_blocking` contexts) don't have to refactor.
fn call(team_id: &str, creds: &SlackCreds, method: &str, params: &[(&str, &str)]) -> Result<Value> {
    let url = format!("{SLACK_API_BASE}/{method}");
    let mut form: Vec<(&str, &str)> = Vec::with_capacity(params.len() + 1);
    form.push(("token", creds.xoxc.as_str()));
    for (k, v) in params {
        form.push((k, v));
    }

    let cookie = cookie_header(creds);
    let client = client();

    let body: Value = http_runtime().block_on(async move {
        let response = client
            .post(&url)
            .header("Cookie", cookie)
            // Origin pins the request to Slack's own SPA; without it
            // we're flagged as cross-site. Referer mirrors that.
            .header("Origin", "https://app.slack.com")
            .header("Referer", "https://app.slack.com/")
            .header("Accept-Language", "en-US,en;q=0.9")
            .form(&form)
            .send()
            .await
            .with_context(|| format!("Failed to POST {method}"))?;

        if !response.status().is_success() {
            bail!(
                "Slack API {} returned HTTP {}",
                method,
                response.status().as_u16()
            );
        }

        let body: Value = response
            .json()
            .await
            .with_context(|| format!("Failed to decode JSON from {method}"))?;
        Ok::<Value, anyhow::Error>(body)
    })?;

    let ok = body.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !ok {
        let error = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        tracing::warn!(team = %team_id, method = %method, error = %error, "Slack API call failed");
        return Err(SlackApiError {
            method: method.to_string(),
            error,
        }
        .into());
    }

    Ok(body)
}

/// `auth.test` — validates the captured pair and tells us who we are.
#[derive(Debug, Clone, Deserialize)]
pub struct AuthTest {
    pub team_id: String,
    /// Team domain — `helmor` for `helmor.slack.com`. Stored so the
    /// detail view can build deep links.
    #[serde(default, rename = "team")]
    pub team_name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default, rename = "user_id")]
    pub my_user_id: String,
}

pub fn auth_test(creds: &SlackCreds) -> Result<AuthTest> {
    // team_id is unknown at this point so we pass an empty string for
    // logging only.
    let body = call("", creds, "auth.test", &[])?;
    let parsed: AuthTest =
        serde_json::from_value(body).context("Failed to decode auth.test response")?;
    if parsed.team_id.is_empty() {
        bail!("auth.test response missing team_id");
    }
    Ok(parsed)
}

/// `users.info` for a single user, with TTL'd in-process cache.
pub fn users_info(team_id: &str, creds: &SlackCreds, user_id: &str) -> Result<UserInfo> {
    let key = (team_id.to_string(), user_id.to_string());
    {
        let cache = user_cache().lock().expect("user cache mutex poisoned");
        if let Some((written, info)) = cache.entries.get(&key) {
            if written.elapsed() < USERS_INFO_TTL {
                return Ok(info.clone());
            }
        }
    }

    let body = call(team_id, creds, "users.info", &[("user", user_id)])?;
    let user = body
        .get("user")
        .ok_or_else(|| anyhow!("users.info response missing `user` field"))?;
    let profile = user.get("profile");
    let display = profile
        .and_then(|p| p.get("display_name"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            profile
                .and_then(|p| p.get("real_name"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .or_else(|| user.get("name").and_then(Value::as_str))
        .unwrap_or(user_id)
        .to_string();
    let avatar = profile
        .and_then(|p| p.get("image_72"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let info = UserInfo {
        display_name: display,
        avatar_url: avatar,
    };

    let mut cache = user_cache().lock().expect("user cache mutex poisoned");
    cache.entries.insert(key, (Instant::now(), info.clone()));
    Ok(info)
}

/// `users.conversations` — lists conversations (channels, DMs, MPIMs) the
/// authed user is a member of. We filter to `im` + `mpim` for the unread
/// DM feed.
#[derive(Debug, Clone, Deserialize)]
pub struct ConversationRow {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub is_im: bool,
    #[serde(default)]
    pub is_mpim: bool,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub unread_count_display: u32,
    #[serde(default)]
    pub last_read: Option<String>,
}

pub fn users_conversations_dms(team_id: &str, creds: &SlackCreds) -> Result<Vec<ConversationRow>> {
    let body = call(
        team_id,
        creds,
        "users.conversations",
        &[
            ("types", "im,mpim"),
            ("exclude_archived", "true"),
            ("limit", "100"),
        ],
    )?;
    let raw = body
        .get("channels")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let rows: Vec<ConversationRow> =
        serde_json::from_value(raw).context("Failed to decode users.conversations channels")?;
    Ok(rows)
}

/// One message from `conversations.history` / `conversations.replies` /
/// `search.messages`. The shape differs subtly between endpoints but the
/// fields we read overlap, so a permissive `serde(default)` parse covers
/// all three.
#[derive(Debug, Clone, Deserialize)]
pub struct RawMessage {
    #[serde(default)]
    pub ts: String,
    #[serde(default, rename = "user")]
    pub user_id: Option<String>,
    #[serde(default, rename = "username")]
    pub username_fallback: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub thread_ts: Option<String>,
    #[serde(default)]
    pub permalink: Option<String>,
    #[serde(default)]
    pub channel: Option<RawSearchChannel>,
    #[serde(default)]
    pub reactions: Vec<RawReaction>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawSearchChannel {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawReaction {
    pub name: String,
    pub count: u32,
}

/// `conversations.history` — the latest N messages in a channel (or DM).
/// Used for two things: (1) fetching the unread-DM snippets for the
/// Activity feed, (2) the detail view's "context around a single
/// message" mode.
pub fn conversations_history(
    team_id: &str,
    creds: &SlackCreds,
    channel: &str,
    oldest: Option<&str>,
    limit: u32,
) -> Result<Vec<RawMessage>> {
    let limit_string = limit.to_string();
    let mut params: Vec<(&str, &str)> =
        vec![("channel", channel), ("limit", limit_string.as_str())];
    if let Some(o) = oldest {
        params.push(("oldest", o));
    }
    let body = call(team_id, creds, "conversations.history", &params)?;
    let raw = body
        .get("messages")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    serde_json::from_value(raw).context("Failed to decode conversations.history messages")
}

/// `conversations.replies` — every message in a thread, including the
/// root. Used by the detail view when the inbox item has a `thread_ts`.
pub fn conversations_replies(
    team_id: &str,
    creds: &SlackCreds,
    channel: &str,
    thread_ts: &str,
) -> Result<Vec<RawMessage>> {
    let body = call(
        team_id,
        creds,
        "conversations.replies",
        &[("channel", channel), ("ts", thread_ts), ("limit", "200")],
    )?;
    let raw = body
        .get("messages")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    serde_json::from_value(raw).context("Failed to decode conversations.replies messages")
}

/// Sort modes accepted by `search.messages`. `Timestamp` is the
/// "Newest first" toggle most users want for an inbox-style list;
/// `Score` is Slack's relevance ranking and matches Slack's own
/// default search behavior.
#[derive(Debug, Clone, Copy)]
pub enum SearchSort {
    Timestamp,
    Score,
}

impl SearchSort {
    fn as_param(self) -> &'static str {
        match self {
            SearchSort::Timestamp => "timestamp",
            SearchSort::Score => "score",
        }
    }
}

/// `search.messages` — full-text-ish search for messages the user can
/// see. Used for both the `@me` mentions feed (timestamp sort) and the
/// interactive search box (caller-chosen sort). Cursor pagination is
/// page-number based for this endpoint.
pub fn search_messages(
    team_id: &str,
    creds: &SlackCreds,
    query: &str,
    page: u32,
    sort: SearchSort,
) -> Result<SearchMessagesPage> {
    let page_string = page.to_string();
    let body = call(
        team_id,
        creds,
        "search.messages",
        &[
            ("query", query),
            ("count", "30"),
            ("page", page_string.as_str()),
            ("sort", sort.as_param()),
            ("sort_dir", "desc"),
            // Slack's search index defaults to a per-user typo
            // tolerance ("did you mean"). For the interactive box we
            // want exactly what was typed, no auto-rewrite.
            ("highlight", "false"),
        ],
    )?;
    let messages = body
        .get("messages")
        .ok_or_else(|| anyhow!("search.messages response missing `messages` envelope"))?;
    let matches = messages
        .get("matches")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let matches: Vec<RawMessage> =
        serde_json::from_value(matches).context("Failed to decode search.messages matches")?;
    let paging = messages
        .get("paging")
        .and_then(|p| p.get("pages"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    Ok(SearchMessagesPage {
        matches,
        total_pages: paging,
    })
}

#[derive(Debug, Clone)]
pub struct SearchMessagesPage {
    pub matches: Vec<RawMessage>,
    pub total_pages: u32,
}

/// `conversations.info` — used to resolve a channel id to its `#name`
/// when we don't already know it (e.g. mentions returning channels not
/// in the DM list).
pub fn conversations_info(team_id: &str, creds: &SlackCreds, channel: &str) -> Result<String> {
    let body = call(
        team_id,
        creds,
        "conversations.info",
        &[("channel", channel)],
    )?;
    let name = body
        .get("channel")
        .and_then(|c| c.get("name"))
        .and_then(Value::as_str)
        .map(|s| format!("#{s}"))
        .unwrap_or_else(|| channel.to_string());
    Ok(name)
}

/// `chat.getPermalink` — stable web URL for a message. We use this as
/// the canonical `externalUrl` on every InboxItem.
pub fn chat_get_permalink(
    team_id: &str,
    creds: &SlackCreds,
    channel: &str,
    message_ts: &str,
) -> Result<Option<String>> {
    let body = call(
        team_id,
        creds,
        "chat.getPermalink",
        &[("channel", channel), ("message_ts", message_ts)],
    )?;
    Ok(body
        .get("permalink")
        .and_then(Value::as_str)
        .map(str::to_string))
}

/// Slack message ts (`"1700000000.123456"`) → ms since epoch.
pub fn ts_to_millis(ts: &str) -> i64 {
    let seconds = ts.split('.').next().unwrap_or("0");
    seconds.parse::<i64>().unwrap_or(0) * 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_to_millis_strips_fraction_and_multiplies() {
        assert_eq!(ts_to_millis("1700000000.123456"), 1_700_000_000_000);
        // No decimal portion is still valid.
        assert_eq!(ts_to_millis("1700000000"), 1_700_000_000_000);
    }

    #[test]
    fn ts_to_millis_returns_zero_for_garbage() {
        assert_eq!(ts_to_millis(""), 0);
        assert_eq!(ts_to_millis("not-a-number"), 0);
    }

    #[test]
    fn slack_api_error_classifies_auth_failures() {
        let auth = SlackApiError {
            method: "auth.test".into(),
            error: "invalid_auth".into(),
        };
        assert!(auth.is_auth_failure());

        let token_revoked = SlackApiError {
            method: "conversations.history".into(),
            error: "token_revoked".into(),
        };
        assert!(token_revoked.is_auth_failure());

        let rate_limited = SlackApiError {
            method: "conversations.history".into(),
            error: "ratelimited".into(),
        };
        // Rate-limit errors are recoverable, not auth failures — the UI
        // should retry, not wipe the keychain.
        assert!(!rate_limited.is_auth_failure());
    }
}
