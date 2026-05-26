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
pub const CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
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

/// `is_auth_failure` probe that ignores anything that isn't a Slack
/// API error. The IPC layer uses this to decide whether to clear the
/// keychain entry + emit `SlackTokenInvalidated`.
pub fn is_invalid_auth(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<SlackApiError>()
        .map(SlackApiError::is_auth_failure)
        .unwrap_or(false)
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
/// Synchronous wrapper around async wreq via the dedicated
/// `http_runtime()` above — see that function's doc for why we don't
/// reuse Tauri's runtime.
fn call(creds: &SlackCreds, method: &str, params: &[(&str, &str)]) -> Result<Value> {
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
        tracing::warn!(method = %method, error = %error, "Slack API call failed");
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
    let body = call(creds, "auth.test", &[])?;
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

    let body = call(creds, "users.info", &[("user", user_id)])?;
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

/// Resolve every `<@U…>` user-mention token in a Slack message body to
/// the labeled form `<@U…|display_name>` using the cached `users.info`
/// lookup. Idempotent — already-labeled mentions (`<@U…|name>`) and
/// non-mention tokens are passed through unchanged.
///
/// Why this lives in the backend: the only way to resolve a Slack user
/// id to a display name without nuking the workspace token is
/// `users.info` (bulk `users.list` triggers Slack's anti-enumeration
/// rule and revokes the xoxc/xoxd pair — see the module-level note).
/// Per-id lookups are TTL-cached in this process, so a refresh of an
/// active thread re-uses the 5 min cache hit instead of refetching
/// each author. Frontend then renders the labeled form via
/// `inlineMentionsForMarkdown` / `formatSlackTextPlain` which both
/// already understood `<@U…|name>`.
///
/// On failure (network blip, deactivated account, etc.) we keep the
/// raw `<@U…>` token rather than substituting a confusing fallback —
/// frontend will still render it as `@U…`, matching today's behavior.
pub fn resolve_mentions(team_id: &str, creds: &SlackCreds, text: &str) -> String {
    // Cheap precheck: skip the scan entirely when no mention syntax is
    // present. Most messages have no mentions so the inbox refresh
    // shouldn't pay the cost of walking each body line.
    if !text.contains("<@") {
        return text.to_string();
    }

    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start_rel) = rest.find("<@") {
        // Copy the segment before the token (UTF-8 safe — `find` returns
        // a valid byte boundary).
        out.push_str(&rest[..start_rel]);
        let after_marker = &rest[start_rel + 2..];
        if let Some(end_rel) = after_marker.find('>') {
            let inner = &after_marker[..end_rel];
            // Slack user ids: `U` or `W` then uppercase ASCII
            // alphanumerics. Already-labeled (`U…|name`) and non-user
            // tokens (e.g. broadcasts) pass through verbatim.
            let is_user_id = !inner.contains('|')
                && inner.starts_with(['U', 'W'])
                && inner
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
            if is_user_id {
                let resolved = users_info(team_id, creds, inner)
                    .map(|info| info.display_name)
                    .ok();
                if let Some(name) = resolved {
                    out.push_str("<@");
                    out.push_str(inner);
                    out.push('|');
                    out.push_str(&name);
                    out.push('>');
                    rest = &after_marker[end_rel + 1..];
                    continue;
                }
            }
            // Pass through the original token verbatim.
            out.push_str("<@");
            out.push_str(inner);
            out.push('>');
            rest = &after_marker[end_rel + 1..];
        } else {
            // No closing `>` — bail out and append the remainder as-is.
            out.push_str("<@");
            rest = after_marker;
            break;
        }
    }
    out.push_str(rest);
    out
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
    pub is_channel: bool,
    #[serde(default)]
    pub is_private: bool,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub unread_count_display: u32,
    #[serde(default)]
    pub last_read: Option<String>,
}

pub fn users_conversations_dms(creds: &SlackCreds) -> Result<Vec<ConversationRow>> {
    users_conversations(creds, "im,mpim", 100)
}

/// Generic `users.conversations` listing. `types` is a Slack-side
/// comma-separated whitelist (`im`, `mpim`, `public_channel`,
/// `private_channel`). Used by the triage fetcher to enumerate every
/// conversation the user is a member of for smart-discovery filtering.
pub fn users_conversations(
    creds: &SlackCreds,
    types: &str,
    limit: u32,
) -> Result<Vec<ConversationRow>> {
    let limit_str = limit.clamp(1, 1000).to_string();
    let body = call(
        creds,
        "users.conversations",
        &[
            ("types", types),
            ("exclude_archived", "true"),
            ("limit", &limit_str),
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
///
/// `text` is what Slack calls the "fallback" / legacy markdown body and
/// is OFTEN EMPTY for bot messages (GitHub, Linear, Datadog, …) — those
/// put their visible content in `attachments[]` instead. Newer Slack
/// clients also publish bodies via `blocks[]` (the Block Kit format).
/// Call [`extract_display_text`] to pull a usable preview from any of
/// the three.
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
    /// Block Kit blocks. Stored as raw `Value` because the schema is
    /// nested and we only walk a handful of paths.
    #[serde(default)]
    pub blocks: Vec<Value>,
    /// Legacy attachment array used by every Slack bot integration we
    /// care about (GitHub, Linear, …). Same reason for `Value` — too
    /// many optional shapes to model strictly.
    #[serde(default)]
    pub attachments: Vec<Value>,
    /// Files attached to a message (image / video / pdf / voice memo).
    /// File-share messages have no body text — Slack's own UI just
    /// shows the attached media preview. The thread-detail view embeds
    /// these directly via the `slack-file://` protocol; inbox snippets
    /// fall back to a `📎 N files` placeholder via `describe_files`.
    #[serde(default)]
    pub files: Vec<RawFile>,
    #[serde(default)]
    pub thread_ts: Option<String>,
    #[serde(default)]
    pub permalink: Option<String>,
    #[serde(default)]
    pub channel: Option<RawSearchChannel>,
    #[serde(default)]
    pub reactions: Vec<RawReaction>,
}

/// Recover the user-visible body of a Slack message, without
/// synthesising a file placeholder. Walks:
///
///   1. `text` if non-empty.
///   2. Block Kit `blocks[]` (rich-text composer output).
///   3. `attachments[]` (bot messages — GitHub, Linear, …).
///
/// Empty string when no textual body is recoverable — caller decides
/// whether to fall back to a file-placeholder string or to render an
/// inline file preview.
pub fn extract_message_body(raw: &RawMessage) -> String {
    let primary = raw.text.trim();
    if !primary.is_empty() {
        return raw.text.clone();
    }

    let from_blocks = walk_blocks_for_text(&raw.blocks);
    if !from_blocks.is_empty() {
        return from_blocks;
    }

    walk_attachments_for_text(&raw.attachments)
}

/// Best-effort "what should we put in a preview / detail body" for a
/// Slack message. Calls `extract_message_body` first, then synthesises
/// a file placeholder (`📎 N files`) when the message is purely a
/// file share. Used by the inbox list to summarise messages on a
/// single line.
pub fn extract_display_text(raw: &RawMessage) -> String {
    let body = extract_message_body(raw);
    if !body.is_empty() {
        return body;
    }

    let from_files = describe_files(&raw.files);
    if !from_files.is_empty() {
        return from_files;
    }

    // Empty body, no blocks/attachments/files we know how to render —
    // the caller picks a fallback (e.g. the channel-level summary).
    String::new()
}

/// One-line synthesized placeholder for file-share messages.
///   1 file  → "📎 Image"  /  "📎 Video"  /  "📎 PDF"  /  "📎 voice-memo.m4a"
///   2+ files → "📎 3 files"  (we don't enumerate beyond the count)
///
/// We prefer the file's MIME-typed name where it's recognisable
/// ("image", "video", "audio", "pdf"); fall back to the file's
/// `title`/`name` for everything else (Word docs, .gitignore, etc.).
fn describe_files(files: &[RawFile]) -> String {
    if files.is_empty() {
        return String::new();
    }
    if files.len() > 1 {
        return format!("📎 {} files", files.len());
    }
    let first = &files[0];
    if let Some(label) = file_kind_label(first) {
        return format!("📎 {label}");
    }
    let display = first
        .title
        .as_deref()
        .filter(|s| !s.is_empty())
        .or(first.name.as_deref())
        .filter(|s| !s.is_empty())
        .unwrap_or("Attachment");
    format!("📎 {display}")
}

fn file_kind_label(file: &RawFile) -> Option<&'static str> {
    match file.category() {
        FileCategory::Gif => Some("GIF"),
        FileCategory::Image => Some("Image"),
        FileCategory::Video => Some("Video"),
        FileCategory::Audio => Some("Voice clip"),
        FileCategory::Pdf => Some("PDF"),
        FileCategory::Other => None,
    }
}

/// Concatenate every plain-text leaf from a Block Kit block list. Slack
/// supports a small number of element types that carry user-visible
/// text; we cover the common cases and ignore the rest:
///
///   - `rich_text` block → `elements[].elements[].text`
///   - `section`   block → `text.text`
///   - `context`   block → `elements[].text`
///   - `header`    block → `text.text`
///
/// Newlines preserved between top-level blocks. Empty leaves filtered.
fn walk_blocks_for_text(blocks: &[Value]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "rich_text" => {
                // rich_text wraps a list of "sub-blocks" (rich_text_section,
                // rich_text_list, …) — each in turn has its own `elements`
                // of inline tokens. Walk both levels.
                if let Some(outer) = block.get("elements").and_then(Value::as_array) {
                    for sub in outer {
                        if let Some(inner) = sub.get("elements").and_then(Value::as_array) {
                            let chunk: String = inner
                                .iter()
                                .filter_map(rich_text_element_text)
                                .collect::<Vec<_>>()
                                .join("");
                            if !chunk.is_empty() {
                                parts.push(chunk);
                            }
                        }
                    }
                }
            }
            "section" | "header" => {
                if let Some(t) = block
                    .get("text")
                    .and_then(|t| t.get("text"))
                    .and_then(Value::as_str)
                {
                    let trimmed = t.trim();
                    if !trimmed.is_empty() {
                        parts.push(trimmed.to_string());
                    }
                }
            }
            "context" => {
                if let Some(elements) = block.get("elements").and_then(Value::as_array) {
                    let chunk: String = elements
                        .iter()
                        .filter_map(|e| e.get("text").and_then(Value::as_str))
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join(" ");
                    if !chunk.is_empty() {
                        parts.push(chunk);
                    }
                }
            }
            _ => {}
        }
    }
    parts.join("\n")
}

/// Inline rich-text element → text content. We round-trip user mentions
/// (`<@U123>`), channel mentions (`<#C123|name>`), broadcasts
/// (`<!channel>`), and links back into Slack mrkdwn so the frontend
/// parser can keep handling them uniformly. Pure-text elements pass
/// through verbatim.
fn rich_text_element_text(element: &Value) -> Option<String> {
    let kind = element.get("type").and_then(Value::as_str)?;
    match kind {
        "text" => element
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string),
        "user" => {
            let user_id = element.get("user_id").and_then(Value::as_str)?;
            Some(format!("<@{user_id}>"))
        }
        "channel" => {
            let channel_id = element.get("channel_id").and_then(Value::as_str)?;
            Some(format!("<#{channel_id}>"))
        }
        "broadcast" => {
            let range = element
                .get("range")
                .and_then(Value::as_str)
                .unwrap_or("channel");
            Some(format!("<!{range}>"))
        }
        "link" => {
            let url = element.get("url").and_then(Value::as_str)?;
            let label = element.get("text").and_then(Value::as_str).unwrap_or(url);
            if label == url {
                Some(format!("<{url}>"))
            } else {
                Some(format!("<{url}|{label}>"))
            }
        }
        "emoji" => element
            .get("name")
            .and_then(Value::as_str)
            .map(|name| format!(":{name}:")),
        _ => None,
    }
}

/// Bot-attachment text. Bots almost always set `fallback` to a single
/// human-readable line ("[dosu-ai/dosu] Pull request opened by …") —
/// that's our preferred preview. When fallback is absent we stitch
/// `pretext` + `title` + `text` from the first attachment, mirroring
/// what Slack desktop would show in the message column.
fn walk_attachments_for_text(attachments: &[Value]) -> String {
    for attachment in attachments {
        if let Some(fallback) = attachment.get("fallback").and_then(Value::as_str) {
            let trimmed = fallback.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        let parts: Vec<String> = ["pretext", "title", "text"]
            .iter()
            .filter_map(|k| attachment.get(*k).and_then(Value::as_str))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !parts.is_empty() {
            return parts.join("\n");
        }
    }
    String::new()
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

/// One file attachment as Slack reports it on a message. Mirrors only
/// the subset we render in the detail view — Slack returns ~30 more
/// fields per file (transcripts, conversion progress, sharing info)
/// that we ignore.
#[derive(Debug, Clone, Deserialize)]
pub struct RawFile {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub mimetype: Option<String>,
    #[serde(default)]
    pub permalink: Option<String>,
    #[serde(default)]
    pub original_w: Option<u32>,
    #[serde(default)]
    pub original_h: Option<u32>,
    /// Image thumbnails sized by long edge. We pick `thumb_720` for the
    /// detail preview and fall back through the others if that's
    /// missing (small avatars / animated gifs sometimes skip the
    /// larger sizes). We never need `thumb_64` / `thumb_80` (the chip
    /// renderer would rather have no preview than a postage stamp).
    #[serde(default)]
    pub thumb_160: Option<String>,
    #[serde(default)]
    pub thumb_360: Option<String>,
    #[serde(default)]
    pub thumb_480: Option<String>,
    #[serde(default)]
    pub thumb_720: Option<String>,
    #[serde(default)]
    pub thumb_800: Option<String>,
    #[serde(default)]
    pub thumb_960: Option<String>,
    #[serde(default)]
    pub thumb_1024: Option<String>,
    /// Video files include a static-frame preview here.
    #[serde(default)]
    pub thumb_video: Option<String>,
    /// Original-resolution download. Used when the user wants the full
    /// file (open externally); never embedded inline.
    #[serde(default)]
    pub url_private: Option<String>,
}

impl RawFile {
    /// Best preview URL ≤ ~720 px on the long edge. We bias toward
    /// `thumb_720` because Slack thread-detail panels are ~700 px wide;
    /// fall through smaller and then up so we always pick *something*
    /// when the file has thumbs at all. Animated GIFs return `None`
    /// from this — they should be served from `url_private` directly
    /// so the animation plays.
    pub fn preview_url(&self) -> Option<&str> {
        [
            self.thumb_720.as_deref(),
            self.thumb_800.as_deref(),
            self.thumb_960.as_deref(),
            self.thumb_480.as_deref(),
            self.thumb_360.as_deref(),
            self.thumb_1024.as_deref(),
            self.thumb_160.as_deref(),
        ]
        .into_iter()
        .flatten()
        .next()
    }

    /// Mimetype category (`image / video / audio / pdf / other`). Drives
    /// the frontend's choice of renderer.
    pub fn category(&self) -> FileCategory {
        let mime = self.mimetype.as_deref().unwrap_or("");
        if mime == "image/gif" {
            FileCategory::Gif
        } else if mime.starts_with("image/") {
            FileCategory::Image
        } else if mime.starts_with("video/") {
            FileCategory::Video
        } else if mime.starts_with("audio/") {
            FileCategory::Audio
        } else if mime == "application/pdf" {
            FileCategory::Pdf
        } else {
            FileCategory::Other
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileCategory {
    Image,
    Gif,
    Video,
    Audio,
    Pdf,
    Other,
}

/// `conversations.history` — the latest N messages in a channel (or DM).
/// Used for two things: (1) fetching the unread-DM snippets for the
/// Activity feed, (2) the detail view's "context around a single
/// message" mode.
pub fn conversations_history(
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
    let body = call(creds, "conversations.history", &params)?;
    let raw = body
        .get("messages")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    serde_json::from_value(raw).context("Failed to decode conversations.history messages")
}

/// `conversations.replies` — every message in a thread, including the
/// root. Used by the detail view when the inbox item has a `thread_ts`.
pub fn conversations_replies(
    creds: &SlackCreds,
    channel: &str,
    thread_ts: &str,
) -> Result<Vec<RawMessage>> {
    let body = call(
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
    creds: &SlackCreds,
    query: &str,
    page: u32,
    sort: SearchSort,
) -> Result<SearchMessagesPage> {
    let page_string = page.to_string();
    let body = call(
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
pub fn conversations_info(creds: &SlackCreds, channel: &str) -> Result<String> {
    let body = call(creds, "conversations.info", &[("channel", channel)])?;
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
    creds: &SlackCreds,
    channel: &str,
    message_ts: &str,
) -> Result<Option<String>> {
    let body = call(
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

/// Workspace-wide custom-emoji TTL. Custom emoji change rarely — most
/// workspaces touch them at most a few times a month — so a long TTL
/// keeps `emoji.list` from hitting Slack on every inbox refresh.
const EMOJI_LIST_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Default)]
struct EmojiCache {
    /// Keyed by team_id. The inner map is `name -> resolved image URL`.
    /// Aliases are followed once before insertion so the consumer never
    /// sees `"alias:other_name"` values.
    entries: HashMap<String, (Instant, HashMap<String, String>)>,
}

fn emoji_cache() -> &'static Mutex<EmojiCache> {
    static CACHE: OnceLock<Mutex<EmojiCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(EmojiCache::default()))
}

/// Resolve `alias:target` redirects against the raw `emoji.list` map.
/// Slack disallows alias chains at the API level — if a stray one shows
/// up the entry is dropped rather than risk a follow-loop. Aliases
/// pointing at unknown targets are also dropped.
fn resolve_emoji_aliases(raw: &HashMap<String, String>) -> HashMap<String, String> {
    raw.iter()
        .filter_map(|(name, value)| {
            if let Some(target) = value.strip_prefix("alias:") {
                raw.get(target)
                    .filter(|t| !t.starts_with("alias:"))
                    .map(|t| (name.clone(), t.clone()))
            } else {
                Some((name.clone(), value.clone()))
            }
        })
        .collect()
}

/// `emoji.list` — every custom emoji visible to this workspace, returned
/// as `name -> image_url`. The raw API yields a mix of direct image URLs
/// and `"alias:other_name"` redirects; we follow each alias once before
/// returning so the caller can do a straight lookup.
///
/// Cached per workspace with a 1h TTL. Custom emoji rarely change, and
/// when they do, a stale entry just means a new emoji renders as a raw
/// `:name:` pill until the next refresh — fine.
pub fn emoji_list(team_id: &str, creds: &SlackCreds) -> Result<HashMap<String, String>> {
    {
        let cache = emoji_cache().lock().expect("emoji cache mutex poisoned");
        if let Some((written, map)) = cache.entries.get(team_id) {
            if written.elapsed() < EMOJI_LIST_TTL {
                return Ok(map.clone());
            }
        }
    }

    let body = call(creds, "emoji.list", &[])?;
    let raw = body
        .get("emoji")
        .ok_or_else(|| anyhow!("emoji.list response missing `emoji` envelope"))?;
    let raw_map: HashMap<String, String> = raw
        .as_object()
        .map(|obj| {
            obj.iter()
                .filter_map(|(name, value)| value.as_str().map(|s| (name.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let resolved = resolve_emoji_aliases(&raw_map);

    let mut cache = emoji_cache().lock().expect("emoji cache mutex poisoned");
    cache
        .entries
        .insert(team_id.to_string(), (Instant::now(), resolved.clone()));
    Ok(resolved)
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

    fn raw_from_json(json: serde_json::Value) -> RawMessage {
        serde_json::from_value(json).expect("Failed to deserialize RawMessage in test")
    }

    #[test]
    fn extract_display_text_returns_text_when_present() {
        let raw = raw_from_json(serde_json::json!({
            "ts": "1700000000.000000",
            "text": "hello team",
        }));
        assert_eq!(extract_display_text(&raw), "hello team");
    }

    #[test]
    fn extract_display_text_falls_through_to_block_kit_rich_text() {
        // A user message that only has Block Kit content (text is empty).
        // Slack ships this shape for messages composed in the redesigned
        // mobile / web composer.
        let raw = raw_from_json(serde_json::json!({
            "ts": "1700000000.000000",
            "text": "",
            "blocks": [
                {
                    "type": "rich_text",
                    "elements": [
                        {
                            "type": "rich_text_section",
                            "elements": [
                                { "type": "text", "text": "still tilted " },
                                { "type": "emoji", "name": "joy" }
                            ]
                        }
                    ]
                }
            ],
        }));
        assert_eq!(extract_display_text(&raw), "still tilted :joy:");
    }

    #[test]
    fn extract_display_text_round_trips_user_mentions_inside_rich_text() {
        // Mentions land as their own element kind in Block Kit — we need
        // to re-encode them as Slack mrkdwn so the frontend parser still
        // sees `<@U123>` and can render the mention pill.
        let raw = raw_from_json(serde_json::json!({
            "text": "",
            "blocks": [
                {
                    "type": "rich_text",
                    "elements": [
                        {
                            "type": "rich_text_section",
                            "elements": [
                                { "type": "user", "user_id": "U123" },
                                { "type": "text", "text": " ping" },
                            ]
                        }
                    ]
                }
            ],
        }));
        assert_eq!(extract_display_text(&raw), "<@U123> ping");
    }

    #[test]
    fn extract_display_text_uses_attachment_fallback_for_bot_messages() {
        // Shape lifted from a real GitHub bot mention: text is empty,
        // body lives in `attachments[0].fallback`. The "@Mention in
        // #channel" line in the UI is the kind label; the third line
        // the user sees comes from this fallback.
        let raw = raw_from_json(serde_json::json!({
            "text": "",
            "attachments": [
                {
                    "color": "good",
                    "fallback": "[dosu-ai/dosu] Pull request opened by jamestalton",
                    "pretext": "ignored when fallback present",
                }
            ],
        }));
        assert_eq!(
            extract_display_text(&raw),
            "[dosu-ai/dosu] Pull request opened by jamestalton",
        );
    }

    #[test]
    fn extract_display_text_concatenates_attachment_fields_when_fallback_missing() {
        let raw = raw_from_json(serde_json::json!({
            "text": "",
            "attachments": [
                {
                    "pretext": "Heads up:",
                    "title": "Deployment failed",
                    "text": "See logs for details.",
                }
            ],
        }));
        assert_eq!(
            extract_display_text(&raw),
            "Heads up:\nDeployment failed\nSee logs for details.",
        );
    }

    #[test]
    fn extract_display_text_synthesizes_placeholder_for_image_file_share() {
        let raw = raw_from_json(serde_json::json!({
            "text": "",
            "files": [
                { "id": "F1", "mimetype": "image/png", "name": "screenshot.png", "title": "Screenshot" }
            ],
        }));
        assert_eq!(extract_display_text(&raw), "📎 Image");
    }

    #[test]
    fn extract_display_text_synthesizes_placeholder_for_video_file_share() {
        let raw = raw_from_json(serde_json::json!({
            "text": "",
            "files": [
                { "id": "F1", "mimetype": "video/mp4", "name": "clip.mp4" }
            ],
        }));
        assert_eq!(extract_display_text(&raw), "📎 Video");
    }

    #[test]
    fn extract_display_text_counts_multiple_files() {
        let raw = raw_from_json(serde_json::json!({
            "text": "",
            "files": [
                { "id": "F1", "mimetype": "image/png" },
                { "id": "F2", "mimetype": "image/png" },
                { "id": "F3", "mimetype": "image/jpeg" },
            ],
        }));
        assert_eq!(extract_display_text(&raw), "📎 3 files");
    }

    #[test]
    fn extract_display_text_falls_back_to_file_title_for_unknown_mimetypes() {
        // .gitignore / Word docs / unknown formats — preserve the
        // visible name rather than a generic placeholder.
        let raw = raw_from_json(serde_json::json!({
            "text": "",
            "files": [
                { "id": "F1", "mimetype": "application/vnd.openxmlformats", "name": "Q3-plan.docx", "title": "Q3 plan" }
            ],
        }));
        assert_eq!(extract_display_text(&raw), "📎 Q3 plan");
    }

    #[test]
    fn extract_display_text_returns_empty_when_message_carries_no_recoverable_signal() {
        // Truly bodyless message — caller decides to fall back to a UI
        // placeholder ("(empty message)") if it wants.
        let raw = raw_from_json(serde_json::json!({ "text": "" }));
        assert_eq!(extract_display_text(&raw), "");
    }

    #[test]
    fn emoji_alias_follows_one_hop_and_drops_dangling_targets() {
        let mut raw = HashMap::new();
        raw.insert("dosu-logo".to_string(), "https://cdn/dosu.png".to_string());
        raw.insert(
            "dosu".to_string(),
            "alias:dosu-logo".to_string(), // valid alias
        );
        raw.insert(
            "ghost-alias".to_string(),
            "alias:nonexistent".to_string(), // dangling alias — should drop
        );
        raw.insert(
            "loop-a".to_string(),
            "alias:loop-b".to_string(), // alias to another alias — should drop
        );
        raw.insert(
            "loop-b".to_string(),
            "alias:loop-a".to_string(), // same; also drops
        );
        let resolved = resolve_emoji_aliases(&raw);
        assert_eq!(
            resolved.get("dosu-logo"),
            Some(&"https://cdn/dosu.png".to_string()),
        );
        assert_eq!(
            resolved.get("dosu"),
            Some(&"https://cdn/dosu.png".to_string()),
            "alias should follow to its target URL",
        );
        assert!(
            !resolved.contains_key("ghost-alias"),
            "dangling alias must not appear in the resolved map",
        );
        assert!(
            !resolved.contains_key("loop-a") && !resolved.contains_key("loop-b"),
            "multi-hop alias chains must not appear in the resolved map",
        );
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
