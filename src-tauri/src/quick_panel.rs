//! The quick panel: a small always-on-top companion window (label `quick`)
//! summoned by a global hotkey. It loads the same frontend bundle as the main
//! window; `App.tsx` routes the `quick` label to the QuickShell UI. The window
//! is created lazily on first summon and then only ever hidden (never
//! destroyed) so its conversation state survives across summons.

use anyhow::{anyhow, Context, Result};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::CommandError;

pub const QUICK_PANEL_LABEL: &str = "quick";

/// Fixed logical size — the panel never resizes between views.
const PANEL_WIDTH: f64 = 507.0;
const PANEL_HEIGHT: f64 = 640.0;

/// Fraction of the monitor height where the panel's BOTTOM edge sits.
const BOTTOM_EDGE_RATIO: f64 = 0.96;

/// Global-hotkey entry point: summon (creating on first use) or dismiss.
pub fn toggle(app: &AppHandle) -> Result<()> {
    if let Some(window) = app.get_webview_window(QUICK_PANEL_LABEL) {
        if window.is_visible()? && window.is_focused()? {
            window.hide()?;
        } else {
            window.show()?;
            window.set_focus()?;
        }
        return Ok(());
    }
    create(app)
}

fn create(app: &AppHandle) -> Result<()> {
    let (x, y) = initial_position(app, PANEL_HEIGHT);
    WebviewWindowBuilder::new(app, QUICK_PANEL_LABEL, WebviewUrl::App("index.html".into()))
        .title("Helmor")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .resizable(false)
        .accept_first_mouse(true)
        .focused(true)
        // Runs before any page script: lets index.html's CSS make the body
        // transparent for this window only, so the dark main-window background
        // never flashes behind the rounded card.
        .initialization_script("document.documentElement.classList.add('helmor-quick-window');")
        .build()
        .context("Failed to create quick panel window")?;
    Ok(())
}

/// Initial logical position: horizontally centered, bottom edge near the lower
/// third of the monitor under the cursor (fallback: primary monitor).
fn initial_position(app: &AppHandle, height: f64) -> (f64, f64) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        // No monitor info (headless edge case): let the OS place it.
        return (0.0, 0.0);
    };

    let scale = monitor.scale_factor();
    let monitor_x = monitor.position().x as f64 / scale;
    let monitor_y = monitor.position().y as f64 / scale;
    let monitor_w = monitor.size().width as f64 / scale;
    let monitor_h = monitor.size().height as f64 / scale;

    let x = monitor_x + (monitor_w - PANEL_WIDTH) / 2.0;
    let y = monitor_y + monitor_h * BOTTOM_EDGE_RATIO - height;
    (x, y)
}

#[tauri::command]
pub fn toggle_quick_panel(app: AppHandle) -> Result<(), CommandError> {
    Ok(toggle(&app)?)
}

#[tauri::command]
pub fn hide_quick_panel(app: AppHandle) -> Result<(), CommandError> {
    if let Some(window) = app.get_webview_window(QUICK_PANEL_LABEL) {
        window.hide().map_err(anyhow::Error::from)?;
    }
    Ok(())
}

/// "Open in Helmor" from the quick panel: bring the main window forward and
/// broadcast a reveal request. The main window's ui-sync bridge navigates to
/// the workspace; the quick panel ignores the event.
#[tauri::command]
pub fn reveal_workspace_in_main_window(
    app: AppHandle,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<(), CommandError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| anyhow!("Main window is not available"))?;
    window.show().map_err(anyhow::Error::from)?;
    window.unminimize().map_err(anyhow::Error::from)?;
    window.set_focus().map_err(anyhow::Error::from)?;

    crate::ui_sync::publish(
        &app,
        crate::ui_sync::UiMutationEvent::WorkspaceRevealRequested {
            workspace_id,
            session_id,
        },
    );
    Ok(())
}
