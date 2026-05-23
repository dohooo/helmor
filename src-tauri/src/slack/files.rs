//! `slack-file://` custom URI protocol for inline image/video previews
//! in the thread detail view.
//!
//! Why a custom protocol: Slack file URLs (`https://files.slack.com/...`)
//! require the workspace cookie (`d=xoxd-…`) to access; the webview
//! cannot send that cookie on its own (different origin, cookies live
//! in Rust process state). We register `slack-file://` and proxy each
//! request through this module, attaching the captured creds, then
//! return the bytes to the webview as a normal HTTP response. Result:
//! `<img src="slack-file://files-tmb/T0…-F1…/image_360.png">` Just
//! Works™ from the frontend's perspective, while the auth lives in Rust.
//!
//! URI shape — the host + path of the `slack-file://` URI maps 1:1 to
//! the path of the original `https://files.slack.com/...` URL, so the
//! frontend doesn't have to know about base64 or query params:
//!
//!   slack-file://files-tmb/T056-F09.../image_360.png
//!   ↓
//!   https://files.slack.com/files-tmb/T056-F09.../image_360.png
//!
//! Team id is extracted from the URL path (Slack embeds it as the
//! first dash-prefixed segment after `files-tmb/` or `files-pri/`).
//!
//! Caching: write-through to `<data_dir>/cache/slack-files/<sha256>.<ext>`.
//! Slack file URLs are content-stable — they never change once uploaded —
//! so we cache aggressively. No LRU eviction in v1; cache is bounded
//! naturally by how many threads the user opens.

use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};
use wreq::Client;
use wreq_util::Emulation;

use crate::data_dir;

use super::api::CHROME_UA;
use super::credentials::{self, SlackCreds};

const SLACK_FILES_HOST: &str = "files.slack.com";

/// Bytes + content type we hand back to the webview. `content_type`
/// drives the `<img>` / `<video>` MIME negotiation in the frontend.
pub struct SlackFileBytes {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

/// Resolve a `slack-file://…` URI to bytes. Hits the local cache first,
/// otherwise downloads from Slack with the matching workspace cookie.
///
/// Errors are returned as-is — the protocol handler turns them into
/// `404 Not Found` responses so the `<img>` falls back to its `alt`.
///
/// Cache-write failures are NON-fatal: we still hand the bytes back to
/// the webview so the user sees the image; the next request will retry
/// the write. The stricter [`resolve_to_path`] variant treats a
/// missing cache file as an error because the spawned agent has no
/// other way to read the file.
pub fn resolve(uri: &str) -> Result<SlackFileBytes> {
    let slack_url = reconstruct_slack_url(uri)?;
    let extension = url_extension(&slack_url).unwrap_or("bin").to_string();
    let cache_path = cache_path_for(&slack_url, &extension)?;

    if let Ok(bytes) = fs::read(&cache_path) {
        return Ok(SlackFileBytes {
            bytes,
            content_type: ext_to_mime(&extension),
        });
    }

    let bytes = download_for_url(&slack_url)?;
    if let Err(write_err) = atomic_write(&cache_path, &bytes) {
        tracing::warn!(
            path = %cache_path.display(),
            error = %format!("{write_err:#}"),
            "Failed to cache slack-file payload",
        );
    }

    Ok(SlackFileBytes {
        bytes,
        content_type: ext_to_mime(&extension),
    })
}

/// Pre-warm the cache for a Slack file URL and return its on-disk path.
///
/// Used by the "add to context" path: the spawned coding agent (Claude
/// Code / Codex) runs as a separate process and cannot see the
/// `slack-file://` webview protocol, but it CAN read absolute file
/// paths via its `Read` tool. Pre-warming the cache and handing the
/// path to the agent's prompt is the only way to expose Slack-hosted
/// images to it.
///
/// Accepts either form of URL — `https://files.slack.com/…` or our
/// own `slack-file://…` rewrite — because callers like the prepare
/// command pull straight from `SlackFileRef.preview_url` which already
/// holds the rewritten form.
///
/// Unlike [`resolve`], cache-write failures are FATAL here — without a
/// readable on-disk path there's nothing useful to return to the
/// agent prompt builder.
pub fn resolve_to_path(url: &str) -> Result<PathBuf> {
    let slack_url = if url.starts_with("slack-file://") {
        reconstruct_slack_url(url)?
    } else {
        url.to_string()
    };
    let extension = url_extension(&slack_url).unwrap_or("bin").to_string();
    let cache_path = cache_path_for(&slack_url, &extension)?;

    if cache_path.is_file() {
        return Ok(cache_path);
    }

    let bytes = download_for_url(&slack_url)?;
    atomic_write(&cache_path, &bytes).context("Cache Slack file for agent prompt")?;
    Ok(cache_path)
}

/// Shared download path: looks up creds for the team_id embedded in
/// the URL, GETs the file with the workspace cookie, and returns the
/// raw bytes. Caching is the caller's responsibility — they decide
/// whether a write failure is fatal.
fn download_for_url(slack_url: &str) -> Result<Vec<u8>> {
    let team_id = extract_team_id(slack_url)
        .ok_or_else(|| anyhow!("slack-file URL has no recognisable team id: {slack_url}"))?;
    let creds = credentials::load_credentials(&team_id)?
        .ok_or_else(|| anyhow!("No Slack credentials for team {team_id}"))?;
    download_with_cookie(slack_url, &creds)
}

/// `slack-file://files-tmb/T056-F09.../image.png` → `https://files.slack.com/files-tmb/T056-F09.../image.png`.
fn reconstruct_slack_url(uri: &str) -> Result<String> {
    let after_scheme = uri
        .strip_prefix("slack-file://")
        .ok_or_else(|| anyhow!("URI is not a slack-file:// reference: {uri}"))?;
    // wry passes through the URI with no path-percent-encoding changes
    // for ASCII paths; `after_scheme` already has the host + path glued
    // together exactly the way we encoded it on the frontend.
    if after_scheme.is_empty() {
        bail!("slack-file URI has empty path");
    }
    let trimmed = after_scheme.trim_start_matches('/');
    Ok(format!("https://{SLACK_FILES_HOST}/{trimmed}"))
}

/// Pull the workspace team_id (`T056ULHJA2U`) out of a Slack file path.
/// Slack's CDN embeds it as the first dash-prefixed segment after the
/// kind directory:
///
///   /files-tmb/T056ULHJA2U-F09XCD9LJ5W/screenshot_720.png
///                ^^^^^^^^^^^
fn extract_team_id(url: &str) -> Option<String> {
    let segment = url.split('/').find(|s| {
        s.starts_with('T')
            && s.len() > 1
            && s.chars()
                .take_while(|c| *c != '-')
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    })?;
    let team = segment.split('-').next()?;
    if team.len() >= 9 && team.starts_with('T') {
        Some(team.to_string())
    } else {
        None
    }
}

fn url_extension(url: &str) -> Option<&str> {
    let last = url.rsplit('/').next()?;
    let stem_ext = last.rsplit_once('.')?.1;
    // Strip query string if extension is followed by `?…`.
    let cleaned = stem_ext.split(&['?', '#']).next().unwrap_or("");
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn cache_path_for(url: &str, extension: &str) -> Result<PathBuf> {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let digest = hex::encode(hasher.finalize());
    let dir = data_dir::cache_dir("slack-files")?;
    Ok(dir.join(format!("{digest}.{extension}")))
}

fn atomic_write(path: &PathBuf, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).context("create cache parent dir")?;
        }
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).context("write cache tmp")?;
    fs::rename(&tmp, path).context("rename cache tmp to final")?;
    Ok(())
}

fn download_with_cookie(url: &str, creds: &SlackCreds) -> Result<Vec<u8>> {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .saturating_sub(10);
    let cookie = format!("d={}; d-s={now}", creds.xoxd);
    let client = http_client();
    let bytes = http_runtime().block_on(async move {
        let response = client
            .get(url)
            .header("Cookie", cookie)
            .header("Origin", "https://app.slack.com")
            .header("Referer", "https://app.slack.com/")
            .send()
            .await
            .context("Failed to GET Slack file")?;
        if !response.status().is_success() {
            bail!("Slack file fetch returned {}", response.status());
        }
        let bytes = response
            .bytes()
            .await
            .context("Failed to read Slack file body")?;
        Ok::<Vec<u8>, anyhow::Error>(bytes.to_vec())
    })?;
    Ok(bytes)
}

/// Dedicated HTTP client + runtime for file fetching. We don't reuse
/// the Slack-API client/runtime in `api.rs` because (a) file fetches
/// have a different bandwidth shape (large bodies) and we don't want
/// to starve auth-test/users-info calls, (b) file fetches run from the
/// protocol-handler thread, not from a tauri command, so the runtime
/// reentrancy rules around `tauri::async_runtime` apply equally.
fn http_client() -> &'static Client {
    use std::sync::OnceLock;
    use std::time::Duration;
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .emulation(Emulation::Chrome131)
            .user_agent(CHROME_UA)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to build wreq client for Slack file CDN")
    })
}

fn http_runtime() -> &'static tokio::runtime::Runtime {
    use std::sync::OnceLock;
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("helmor-slack-files")
            .build()
            .expect("Failed to build tokio runtime for Slack file fetcher")
    })
}

/// File extension → MIME type. Covers the small set of formats Slack
/// thumbnails produce (always PNG/JPEG) plus a few originals we let
/// through (GIF for animations, MP4/WebM for inline video). Anything
/// unknown defaults to `application/octet-stream` so the browser
/// downloads rather than misrenders.
fn ext_to_mime(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconstruct_slack_url_strips_scheme_and_keeps_path() {
        let uri = "slack-file://files-tmb/T056ULHJA2U-F09X/screenshot_720.png";
        assert_eq!(
            reconstruct_slack_url(uri).unwrap(),
            "https://files.slack.com/files-tmb/T056ULHJA2U-F09X/screenshot_720.png",
        );
    }

    #[test]
    fn extract_team_id_finds_t_prefixed_segment() {
        let url = "https://files.slack.com/files-tmb/T056ULHJA2U-F09XCD9LJ5W/image_720.png";
        assert_eq!(extract_team_id(url).as_deref(), Some("T056ULHJA2U"));
    }

    #[test]
    fn extract_team_id_returns_none_when_path_has_no_team_segment() {
        assert!(extract_team_id("https://files.slack.com/some-other-path/x.png").is_none());
    }

    #[test]
    fn url_extension_strips_query_string() {
        assert_eq!(
            url_extension("https://files.slack.com/path/image_720.png?token=foo"),
            Some("png"),
        );
    }

    #[test]
    fn ext_to_mime_handles_common_image_and_video_types() {
        assert_eq!(ext_to_mime("PNG"), "image/png");
        assert_eq!(ext_to_mime("jpg"), "image/jpeg");
        assert_eq!(ext_to_mime("mp4"), "video/mp4");
        assert_eq!(ext_to_mime("docx"), "application/octet-stream");
    }
}
