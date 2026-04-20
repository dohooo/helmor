//! Commands for the "Claude Design" takeover view.
//!
//! A single child `Webview` pinned to a fixed URL (`https://claude.ai/design`)
//! that the frontend opens as a full-window overlay when the user clicks the
//! dedicated sidebar button. Only one instance exists at a time (singleton —
//! no per-session id), and its lifecycle is owned entirely by the frontend
//! overlay component: mount → open (or re-show), unmount → hide so login
//! state and page position survive across close/reopen.
//!
//! ## OAuth intercept + cookie bridge
//!
//! Embedded WebViews cannot complete Google OAuth (GSI refuses them). We:
//!   1. Intercept the `window.open(...)` call GSI uses for its popup via
//!      `on_new_window` → `NewWindowResponse::Deny` and emit
//!      `claude-design-oauth-intercepted` so the frontend can show a modal.
//!   2. Expose `import_claude_design_cookies(browser)` which uses the
//!      `rookie` crate to read claude.ai cookies from the user's real
//!      desktop browser and injects them into our child webview via
//!      `Webview::set_cookie`, then reloads the view.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{
        cookie::{time::OffsetDateTime, Cookie},
        NewWindowResponse, WebviewBuilder,
    },
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

use super::common::{run_blocking, CmdResult};

const CLAUDE_DESIGN_URL: &str = "https://claude.ai/design";
const CLAUDE_DESIGN_LABEL: &str = "claude-design-view";

/// Domains the cookie bridge is allowed to import. Narrow on purpose — we
/// don't drag the user's entire cookie jar into our app.
const IMPORTABLE_DOMAINS: &[&str] = &["claude.ai", "anthropic.com"];

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthInterceptedPayload {
    url: String,
    host: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceBrowser {
    Chrome,
    Arc,
    Brave,
    Edge,
    Firefox,
}

impl SourceBrowser {
    fn label(self) -> &'static str {
        match self {
            SourceBrowser::Chrome => "Chrome",
            SourceBrowser::Arc => "Arc",
            SourceBrowser::Brave => "Brave",
            SourceBrowser::Edge => "Edge",
            SourceBrowser::Firefox => "Firefox",
        }
    }

    fn read_cookies(self, domains: Vec<String>) -> Result<Vec<rookie::common::enums::Cookie>> {
        let result = match self {
            SourceBrowser::Chrome => rookie::chrome(Some(domains)),
            SourceBrowser::Arc => rookie::arc(Some(domains)),
            SourceBrowser::Brave => rookie::brave(Some(domains)),
            SourceBrowser::Edge => rookie::edge(Some(domains)),
            SourceBrowser::Firefox => rookie::firefox(Some(domains)),
        };
        result.map_err(|e| anyhow!("Failed to read {} cookies: {e:#}", self.label()))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCookiesResponse {
    pub browser: String,
    pub imported: usize,
    pub skipped: usize,
    pub total_read: usize,
}

fn sanitize_bounds(bounds: ViewBounds) -> ViewBounds {
    ViewBounds {
        x: bounds.x.max(0.0),
        y: bounds.y.max(0.0),
        // A zero/negative size crashes wry on some platforms; clamp to 1px.
        width: bounds.width.max(1.0),
        height: bounds.height.max(1.0),
    }
}

fn apply_bounds(webview: &tauri::Webview, bounds: ViewBounds) -> Result<()> {
    let bounds = sanitize_bounds(bounds);
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| anyhow!("Failed to set Claude Design view position: {e}"))?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| anyhow!("Failed to set Claude Design view size: {e}"))?;
    Ok(())
}

fn rookie_to_tauri_cookie(rc: rookie::common::enums::Cookie) -> Cookie<'static> {
    let mut builder = Cookie::build((rc.name, rc.value))
        .domain(rc.domain)
        .path(rc.path)
        .secure(rc.secure)
        .http_only(rc.http_only);
    if let Some(expires_unix) = rc.expires {
        if let Ok(odt) = OffsetDateTime::from_unix_timestamp(expires_unix as i64) {
            builder = builder.expires(odt);
        }
    }
    builder.build()
}

fn open_or_show(app: &AppHandle, bounds: ViewBounds) -> Result<()> {
    if let Some(existing) = app.get_webview(CLAUDE_DESIGN_LABEL) {
        apply_bounds(&existing, bounds)?;
        existing
            .show()
            .map_err(|e| anyhow!("Failed to show Claude Design view: {e}"))?;
        return Ok(());
    }

    // `add_child` is defined on `Window`, not `WebviewWindow` — we pick the
    // lower-level handle here even though the host window is also a
    // `WebviewWindow`.
    let main_window = app
        .get_window("main")
        .ok_or_else(|| anyhow!("Main window not available"))?;

    let url = CLAUDE_DESIGN_URL
        .parse()
        .map_err(|e| anyhow!("Invalid Claude Design URL: {e}"))?;
    let bounds = sanitize_bounds(bounds);

    // Intercept every `window.open(...)` from the embedded site. Google
    // Identity Services uses a popup for OAuth; denying it here prevents GSI
    // from showing its "there was an error logging you in" fallback. The
    // frontend listens for the emitted event and shows its own modal.
    let intercept_app = app.clone();
    let builder = WebviewBuilder::new(CLAUDE_DESIGN_LABEL, WebviewUrl::External(url))
        .on_new_window(move |url, _features| {
            let host = url.host_str().unwrap_or("").to_string();
            let url_string = url.to_string();
            tracing::info!(
                host = %host,
                "Claude Design: on_new_window intercepted — denying popup + notifying frontend"
            );
            if let Err(err) = intercept_app.emit(
                "claude-design-oauth-intercepted",
                OAuthInterceptedPayload {
                    url: url_string,
                    host,
                },
            ) {
                tracing::warn!("Failed to emit claude-design-oauth-intercepted: {err}");
            }
            NewWindowResponse::Deny
        });

    main_window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| anyhow!("Failed to create Claude Design view: {e}"))?;
    Ok(())
}

fn set_bounds(app: &AppHandle, bounds: ViewBounds) -> Result<()> {
    // Silent no-op when the webview isn't created yet — ResizeObserver can
    // fire before the initial open command has returned.
    if let Some(webview) = app.get_webview(CLAUDE_DESIGN_LABEL) {
        apply_bounds(&webview, bounds)?;
    }
    Ok(())
}

fn hide(app: &AppHandle) -> Result<()> {
    if let Some(webview) = app.get_webview(CLAUDE_DESIGN_LABEL) {
        webview
            .hide()
            .map_err(|e| anyhow!("Failed to hide Claude Design view: {e}"))?;
    }
    Ok(())
}

fn close(app: &AppHandle) -> Result<()> {
    if let Some(webview) = app.get_webview(CLAUDE_DESIGN_LABEL) {
        webview
            .close()
            .map_err(|e| anyhow!("Failed to close Claude Design view: {e}"))?;
    }
    Ok(())
}

fn reload(app: &AppHandle) -> Result<()> {
    if let Some(webview) = app.get_webview(CLAUDE_DESIGN_LABEL) {
        webview
            .reload()
            .map_err(|e| anyhow!("Failed to reload Claude Design view: {e}"))?;
    }
    Ok(())
}

fn import_cookies(app: &AppHandle, browser: SourceBrowser) -> Result<ImportCookiesResponse> {
    let webview = app
        .get_webview(CLAUDE_DESIGN_LABEL)
        .ok_or_else(|| anyhow!("Claude Design view is not open"))?;

    let domains: Vec<String> = IMPORTABLE_DOMAINS.iter().map(|d| d.to_string()).collect();
    let cookies = browser.read_cookies(domains)?;
    let total_read = cookies.len();
    tracing::info!(
        browser = browser.label(),
        total_read,
        "Read cookies from source browser"
    );

    let mut imported = 0usize;
    let mut skipped = 0usize;
    for rc in cookies {
        let name = rc.name.clone();
        let cookie = rookie_to_tauri_cookie(rc);
        match webview.set_cookie(cookie) {
            Ok(()) => imported += 1,
            Err(e) => {
                tracing::warn!(
                    cookie = %name,
                    error = %e,
                    "set_cookie failed for imported cookie"
                );
                skipped += 1;
            }
        }
    }

    webview
        .reload()
        .map_err(|e| anyhow!("Failed to reload after cookie import: {e}"))?;

    Ok(ImportCookiesResponse {
        browser: browser.label().to_string(),
        imported,
        skipped,
        total_read,
    })
}

#[tauri::command]
pub async fn open_claude_design_view(app: AppHandle, bounds: ViewBounds) -> CmdResult<()> {
    run_blocking(move || open_or_show(&app, bounds)).await
}

#[tauri::command]
pub async fn set_claude_design_view_bounds(app: AppHandle, bounds: ViewBounds) -> CmdResult<()> {
    run_blocking(move || set_bounds(&app, bounds)).await
}

#[tauri::command]
pub async fn hide_claude_design_view(app: AppHandle) -> CmdResult<()> {
    run_blocking(move || hide(&app)).await
}

#[tauri::command]
pub async fn close_claude_design_view(app: AppHandle) -> CmdResult<()> {
    run_blocking(move || close(&app)).await
}

#[tauri::command]
pub async fn reload_claude_design_view(app: AppHandle) -> CmdResult<()> {
    run_blocking(move || reload(&app)).await
}

#[tauri::command]
pub async fn import_claude_design_cookies(
    app: AppHandle,
    browser: SourceBrowser,
) -> CmdResult<ImportCookiesResponse> {
    run_blocking(move || import_cookies(&app, browser)).await
}
