//! Screen / window capture for the voice agent's `capture_screen` tool.
//!
//! The voice agent invokes this when the user asks it to "look at the
//! screen" — typically because they've referenced something visible
//! (a Slack message, an error in another window, a design in Figma)
//! that the agent needs to read before acting. The captured PNG is
//! delivered as a base64 data URL on the voice tool envelope's `image`
//! field; the frontend dispatcher injects it into the active Realtime
//! conversation as an `input_image` user item so the model can reason
//! about it on its next response.
//!
//! ## Permission model (macOS)
//!
//! Screen Recording is a TCC-gated permission. `CGPreflightScreenCaptureAccess`
//! returns the granted/denied state synchronously without prompting;
//! `CGRequestScreenCaptureAccess` triggers the system prompt exactly
//! once per install per code-signing identity. Two important gotchas
//! that drive the UX here:
//!
//! 1. **`preflight()` caches for the lifetime of the process.** Once
//!    we've seen `false`, we keep seeing `false` even after the user
//!    grants. The only reliable recovery is a full app restart — we
//!    surface that to the voice agent as part of the error string so
//!    it can tell the user.
//! 2. **Denied captures don't error.** `xcap::Monitor::capture_image`
//!    on macOS happily returns a black/blank `RgbaImage` if Screen
//!    Recording is denied. So we MUST preflight before every capture
//!    rather than relying on the capture call to fail.
//!
//! On non-macOS platforms the permission gate is a no-op (`is_granted`
//! returns `true`) and capture works directly.

use std::path::PathBuf;
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::RgbaImage;
use uuid::Uuid;
use xcap::{Monitor, Window};

/// Long-edge cap before encoding. The hard ceiling is set by the
/// WebRTC dataChannel's SCTP message size limit (~16–256 KB depending
/// on platform/peer negotiation — see
/// github.com/openai/openai-agents-js/issues/501). Even at JPEG
/// quality 60, a 1920×1200 capture base64s to ~250 KB, well over the
/// reliable ceiling. 1280 long edge + JPEG q60 lands at ~80–110 KB
/// base64, which we've seen reliably traverse the channel.
///
/// Slack-text + IDE legibility is still acceptable at 1280px; raise
/// the ceiling only if we switch transport to WebSocket (no SCTP
/// limit) or OpenAI starts honoring `input_image.file_id` on
/// Realtime (so the dataChannel only carries the id).
const MAX_LONG_EDGE: u32 = 1280;

/// JPEG quality (0–100) for the lossy encode path. 60 is the sweet
/// spot for screen text: high enough that anti-aliased fonts stay
/// readable, low enough that a 1280×800 frame compresses to ~70 KB.
/// Raise to 75 if details get smeared; lower to 50 if the dataChannel
/// rejects the payload.
const JPEG_QUALITY: u8 = 60;

/// Which surface to capture. `Window` is the default — it's both more
/// privacy-preserving (only the focused app) and significantly smaller
/// (a chat window is ~600 KB PNG vs ~3 MB for a Retina full screen),
/// which matters for voice round-trip latency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureMode {
    /// Currently focused, non-minimized window.
    Window,
    /// Primary monitor, entire desktop.
    Screen,
}

impl CaptureMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Window => "window",
            Self::Screen => "screen",
        }
    }

    /// Parse the JSON Schema `mode` arg from the voice tool. Unknown
    /// values fall back to `Window` rather than erroring — the user's
    /// intent is clearly "look at the screen", and the model
    /// occasionally improvises enum values it wasn't given.
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("screen") | Some("desktop") | Some("full") => Self::Screen,
            _ => Self::Window,
        }
    }
}

/// Result of a successful capture, shaped for the voice tool envelope.
/// `data_url` is a fully-formed `data:image/jpeg;base64,…` ready to
/// drop into a Realtime API `input_image.image_url` content part.
///
/// Why inline base64 (and not a Files API `file_id`): we tried that
/// — `gpt-realtime-2` rejects `input_image` items that omit
/// `image_url`, even when `file_id` is set, with
/// `Missing required parameter: 'item.content[*].image_url'`. The
/// only path that gets past server-side validation today is a
/// `data:` (or HTTPS) URL inlined into `image_url`. The dataChannel
/// size ceiling forces the aggressive downscale + JPEG above.
#[derive(Debug, Clone)]
pub struct CaptureResult {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    /// Encoded JPEG size in bytes, *before* base64. Lets the operator
    /// see in the log whether the encode hit the dataChannel ceiling.
    pub encoded_bytes: usize,
    /// Which mode was actually used. May differ from the requested mode
    /// when the window fallback didn't find a focused window and we
    /// dropped to the primary monitor instead — the model can phrase
    /// "couldn't see your focused window, looking at the whole screen"
    /// if it wants.
    pub mode_used: String,
    /// Absolute path of the JPEG written to the OS temp dir. Voice
    /// tools that hand work off to a workspace agent (`send_prompt` /
    /// `create_workspace_and_send` / `create_workspace_variants`)
    /// forward this path as `image_paths` so the underlying claude /
    /// codex SDK can read the image — the inline base64 `data_url`
    /// only feeds back into the realtime conversation, not the
    /// downstream agent. `None` when the disk write failed; we still
    /// return the in-memory `data_url` so the voice agent can at
    /// least see the screenshot even if it can't forward it.
    pub path: Option<String>,
}

/// Capture the requested surface. Caller is responsible for preflight —
/// see [`is_granted`] — and for surfacing a permission-missing error
/// before invoking this. We don't preflight inline because the caller
/// (the voice agent's tool handler) wants to package the permission
/// error specially before returning.
pub fn capture(mode: CaptureMode) -> Result<CaptureResult> {
    let start = std::time::Instant::now();

    // Phase 1: native capture (xcap → RgbaImage). On macOS this is the
    // expensive one — Retina full screen pull is a few hundred ms.
    let capture_phase_start = std::time::Instant::now();
    let (rgba, mode_used) = match mode {
        CaptureMode::Window => match capture_focused_window()? {
            Some(img) => (img, CaptureMode::Window),
            None => {
                // No focused window (rare — e.g. desktop has focus). Fall
                // back to primary monitor so the tool returns *something*
                // useful rather than failing.
                tracing::info!("no focused window found; falling back to primary monitor");
                (capture_primary_monitor()?, CaptureMode::Screen)
            }
        },
        CaptureMode::Screen => (capture_primary_monitor()?, CaptureMode::Screen),
    };
    let raw_width = rgba.width();
    let raw_height = rgba.height();
    let capture_phase_ms = capture_phase_start.elapsed().as_millis() as u64;
    tracing::info!(
        mode = mode_used.as_str(),
        raw_width,
        raw_height,
        capture_phase_ms,
        "capture phase: native capture done"
    );

    // Phase 2: downscale if over the long-edge cap. Logged whether or
    // not it triggers — operators want to know "did we hit the cap?"
    // not just "what's the final size?".
    let downscale_phase_start = std::time::Instant::now();
    let resized = maybe_downscale(rgba);
    let (width, height) = (resized.width(), resized.height());
    let downscaled = width != raw_width || height != raw_height;
    let downscale_phase_ms = downscale_phase_start.elapsed().as_millis() as u64;
    tracing::info!(
        downscaled,
        width,
        height,
        downscale_phase_ms,
        "capture phase: downscale done"
    );

    // Phase 3: JPEG, not PNG. JPEG is ~4–6× smaller than PNG for UI
    // screenshots at q60 with negligible legibility loss; PNG would
    // blow past the dataChannel size ceiling at the 1280px cap. The
    // image crate's JpegEncoder wants an RGB8 buffer, but xcap hands
    // us RGBA — strip the alpha plane in place by re-interpreting and
    // dropping every 4th byte. Allocating a fresh buffer is fine; it's
    // at most a few MB and the encode dominates.
    let encode_phase_start = std::time::Instant::now();
    let mut rgb: Vec<u8> = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for px in resized.pixels() {
        rgb.push(px[0]);
        rgb.push(px[1]);
        rgb.push(px[2]);
    }
    let mut jpeg_bytes: Vec<u8> = Vec::with_capacity(128 * 1024);
    {
        let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, JPEG_QUALITY);
        encoder
            .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
            .context("encode capture as JPEG")?;
    }
    let encoded_bytes = jpeg_bytes.len();
    let encode_phase_ms = encode_phase_start.elapsed().as_millis() as u64;

    // Phase 4: base64 to data URL. Cheap relative to encode but worth
    // breaking out so operators can see if it spikes (large images).
    let base64_phase_start = std::time::Instant::now();
    let data_url = format!("data:image/jpeg;base64,{}", BASE64.encode(&jpeg_bytes));
    let base64_phase_ms = base64_phase_start.elapsed().as_millis() as u64;

    // Phase 5: persist the JPEG so the voice agent can hand the path to
    // `send_prompt` / `create_workspace_and_send` (the underlying claude
    // / codex SDK needs a real file on disk; the inline base64 only
    // works for the Realtime conversation). System temp dir is fine —
    // these screenshots are ephemeral context, the OS sweeps them on
    // reboot.
    let persist_phase_start = std::time::Instant::now();
    let path = persist_jpeg(&jpeg_bytes);
    let persist_phase_ms = persist_phase_start.elapsed().as_millis() as u64;

    tracing::info!(
        mode = mode_used.as_str(),
        width,
        height,
        jpeg_quality = JPEG_QUALITY,
        jpeg_bytes = encoded_bytes,
        data_url_bytes = data_url.len(),
        path = path.as_deref().unwrap_or("(disk write failed)"),
        capture_phase_ms,
        downscale_phase_ms,
        encode_phase_ms,
        base64_phase_ms,
        persist_phase_ms,
        total_elapsed_ms = start.elapsed().as_millis() as u64,
        "captured screen"
    );

    Ok(CaptureResult {
        data_url,
        width,
        height,
        encoded_bytes,
        mode_used: mode_used.as_str().to_string(),
        path,
    })
}

/// Write the encoded JPEG to `<temp_dir>/helmor-voice-captures/<uuid>.jpg`
/// and return the absolute path. Best-effort: any IO error returns
/// `None` and gets logged at warn — the voice agent loses the ability
/// to forward this particular screenshot to a workspace agent, but the
/// Realtime side still has the inline data URL and can describe what
/// it sees.
fn persist_jpeg(jpeg_bytes: &[u8]) -> Option<String> {
    let dir: PathBuf = std::env::temp_dir().join("helmor-voice-captures");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!(
            dir = %dir.display(),
            error = %format!("{e:#}"),
            "persist_jpeg: failed to create capture dir",
        );
        return None;
    }
    let path = dir.join(format!("{}.jpg", Uuid::new_v4()));
    if let Err(e) = std::fs::write(&path, jpeg_bytes) {
        tracing::warn!(
            path = %path.display(),
            error = %format!("{e:#}"),
            "persist_jpeg: failed to write capture",
        );
        return None;
    }
    Some(path.display().to_string())
}

/// Upload a captured PNG to the OpenAI Files API and return the
/// resulting `file_id`.
///
/// **Currently unused.** This was the original transport plan, but as
/// of 2026-05 `gpt-realtime-2` rejects `input_image` items that omit
/// `image_url` even when `file_id` is set
/// (`Missing required parameter: 'item.content[*].image_url'`). The
/// Responses API honors `file_id`; Realtime does not, despite sharing
/// the same content-part schema name. Kept here ready-to-wire so when
/// OpenAI lifts that restriction we can swap transports without
/// re-discovering the multipart shape — it's worth ~30 lines + a
/// `reqwest` feature flag.
///
/// Blocking reqwest is OK here: this function is only ever called from
/// inside `tauri::async_runtime::spawn_blocking` (via `run_blocking`),
/// matching how `create_openai_realtime_client_secret` makes its own
/// blocking POST. Timeout is 30 s.
#[allow(dead_code)]
pub fn upload_png_to_openai_files(api_key: &str, png_bytes: Vec<u8>) -> Result<String> {
    let start = std::time::Instant::now();
    let total_bytes = png_bytes.len();
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .context("build OpenAI Files HTTP client")?;
    let part = reqwest::blocking::multipart::Part::bytes(png_bytes)
        .file_name("helmor-voice-capture.png")
        .mime_str("image/png")
        .context("build multipart png part")?;
    let form = reqwest::blocking::multipart::Form::new()
        // `purpose=vision` is the magic string that makes the file
        // referenceable from chat / responses / realtime input_image
        // content. `assistants` purpose does NOT work for vision.
        .text("purpose", "vision")
        .part("file", part);
    let response = client
        .post("https://api.openai.com/v1/files")
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .context("upload capture to OpenAI Files API")?;
    let status = response.status();
    let text = response
        .text()
        .context("read OpenAI Files API response body")?;
    if !status.is_success() {
        anyhow::bail!("OpenAI Files upload failed: HTTP {status}: {text}");
    }
    #[derive(serde::Deserialize)]
    struct FilesResponse {
        id: String,
    }
    let parsed: FilesResponse =
        serde_json::from_str(&text).context("parse OpenAI Files API response")?;
    tracing::info!(
        file_id = %parsed.id,
        bytes = total_bytes,
        elapsed_ms = start.elapsed().as_millis() as u64,
        "uploaded capture to OpenAI Files API"
    );
    Ok(parsed.id)
}

fn capture_primary_monitor() -> Result<RgbaImage> {
    let monitor = Monitor::all()
        .map_err(|e| anyhow!("enumerate monitors: {e}"))?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("no monitors found"))?;
    monitor
        .capture_image()
        .map_err(|e| anyhow!("capture monitor: {e}"))
}

/// Returns the focused, non-minimized window's capture, or `None` if
/// nothing was focused (e.g. user clicked the desktop). Errors only on
/// hard failures from the xcap enumeration or capture call.
fn capture_focused_window() -> Result<Option<RgbaImage>> {
    let windows = Window::all().map_err(|e| anyhow!("enumerate windows: {e}"))?;
    let focused = windows
        .into_iter()
        .find(|w| w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(true));
    match focused {
        Some(w) => Ok(Some(
            w.capture_image()
                .map_err(|e| anyhow!("capture focused window: {e}"))?,
        )),
        None => Ok(None),
    }
}

/// Resize so the long edge is at most [`MAX_LONG_EDGE`], preserving
/// aspect ratio. Sub-threshold images pass through untouched. We use
/// the Triangle filter for the cheap-but-decent ratio — Lanczos is
/// nicer but ~5× slower for no perceptible difference on UI screenshots.
fn maybe_downscale(img: RgbaImage) -> RgbaImage {
    let (w, h) = (img.width(), img.height());
    let long_edge = w.max(h);
    if long_edge <= MAX_LONG_EDGE {
        return img;
    }
    let scale = MAX_LONG_EDGE as f32 / long_edge as f32;
    let new_w = (w as f32 * scale).round().max(1.0) as u32;
    let new_h = (h as f32 * scale).round().max(1.0) as u32;
    image::imageops::resize(&img, new_w, new_h, image::imageops::FilterType::Triangle)
}

/// macOS Screen Recording TCC state. `false` means denied or
/// not-yet-determined; we treat both as "needs user action" because the
/// process-lifetime cache means once we've ever seen `false`, we can't
/// observe a subsequent grant without restart.
#[cfg(target_os = "macos")]
pub fn is_granted() -> bool {
    use core_graphics::access::ScreenCaptureAccess;
    let granted = ScreenCaptureAccess.preflight();
    // Trace at debug level — granted is the boring path, but having
    // it in the log makes "was permission checked at all?" trivially
    // answerable.
    tracing::debug!(granted, "screen-recording preflight");
    granted
}

/// Fire the one-shot system prompt. Idempotent — TCC suppresses repeat
/// prompts on the same install, so calling this on a previously-denied
/// session is a no-op. Returns immediately; the user decides
/// asynchronously in System Settings.
#[cfg(target_os = "macos")]
pub fn request() {
    use core_graphics::access::ScreenCaptureAccess;
    let _ = ScreenCaptureAccess.request();
}

/// Deep-link to System Settings → Privacy & Security → Screen Recording.
/// Verified on macOS 12 Monterey through 15 Sequoia. We shell out to
/// `open` rather than using `tauri-plugin-opener` so the URL scheme
/// allowlist doesn't have to grow a special case for `x-apple.*`.
#[cfg(target_os = "macos")]
pub fn open_settings() -> Result<()> {
    Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn()
        .context("open System Settings → Screen Recording")?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn is_granted() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn request() {}

#[cfg(not(target_os = "macos"))]
pub fn open_settings() -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mode_defaults_to_window() {
        assert_eq!(CaptureMode::parse(None), CaptureMode::Window);
        assert_eq!(CaptureMode::parse(Some("window")), CaptureMode::Window);
        assert_eq!(CaptureMode::parse(Some("screen")), CaptureMode::Screen);
        // Defensive aliases: model occasionally improvises.
        assert_eq!(CaptureMode::parse(Some("desktop")), CaptureMode::Screen);
        assert_eq!(CaptureMode::parse(Some("full")), CaptureMode::Screen);
        // Unknown values fall back to window rather than erroring.
        assert_eq!(CaptureMode::parse(Some("garbage")), CaptureMode::Window);
    }

    #[test]
    fn mode_str_round_trips() {
        assert_eq!(CaptureMode::Window.as_str(), "window");
        assert_eq!(CaptureMode::Screen.as_str(), "screen");
    }

    /// Synthetic image: 3000 long edge → expect down to MAX_LONG_EDGE.
    /// Asserts against the constant so the test doesn't bit-rot when
    /// the ceiling moves (it has — 1920 → 1280 the moment we learned
    /// the WebRTC dataChannel size ceiling).
    #[test]
    fn downscale_caps_long_edge() {
        let img = RgbaImage::new(3000, 1500);
        let resized = maybe_downscale(img);
        assert_eq!(resized.width(), MAX_LONG_EDGE);
        // Aspect ratio preserved (1500/3000 = 0.5 → MAX * 0.5).
        assert_eq!(resized.height(), MAX_LONG_EDGE / 2);
    }

    /// Sub-threshold image passes through untouched.
    #[test]
    fn downscale_passthrough_for_small_images() {
        let img = RgbaImage::new(1200, 800);
        let resized = maybe_downscale(img);
        assert_eq!(resized.width(), 1200);
        assert_eq!(resized.height(), 800);
    }
}
