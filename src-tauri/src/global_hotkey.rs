use std::{str::FromStr, sync::Mutex};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::error::CommandError;

const SHORTCUTS_SETTING_KEY: &str = "app.shortcuts";
const GLOBAL_HOTKEY_ID: &str = "global.hotkey";
const MAIN_WINDOW_LABEL: &str = "main";
const VOICE_PANEL_WINDOW_LABEL: &str = "voice-panel";
const VOICE_PANEL_WIDTH: f64 = 328.0;
const VOICE_PANEL_HEIGHT: f64 = 80.0;
const VOICE_PANEL_BOTTOM_MARGIN: f64 = 28.0;
const VOICE_TOGGLE_REQUEST_EVENT: &str = "helmor://voice-toggle-request";
const MAIN_WINDOW_FOCUSED_EVENT: &str = "helmor://main-window-focused";

// Rust owns plugin registration, so no frontend plugin capability is needed.
// Startup reads only stored overrides; the frontend syncs registry defaults
// after settings load.
#[derive(Default)]
pub struct GlobalHotkeyState {
    desired: Mutex<Option<String>>,
    registered: Mutex<Option<String>>,
    main_focused: Mutex<bool>,
    voice_active: Mutex<bool>,
}

pub fn sync_from_settings(app: &AppHandle) -> Result<()> {
    let raw = crate::settings::load_setting_value(SHORTCUTS_SETTING_KEY)?;
    let hotkey = raw.as_deref().and_then(global_hotkey_from_shortcuts_json);
    sync_global_hotkey_inner(app, hotkey)
}

#[tauri::command]
pub fn sync_global_hotkey(app: AppHandle, hotkey: Option<String>) -> Result<(), CommandError> {
    Ok(sync_global_hotkey_inner(&app, hotkey)?)
}

fn sync_global_hotkey_inner(app: &AppHandle, hotkey: Option<String>) -> Result<()> {
    let normalized = hotkey
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(to_tauri_accelerator)
        .transpose()?;

    let state = app.state::<GlobalHotkeyState>();
    *state
        .desired
        .lock()
        .expect("global hotkey desired state poisoned") = normalized.clone();
    let main_focused = *state
        .main_focused
        .lock()
        .expect("global hotkey focus state poisoned");
    sync_registered_hotkey(app, if main_focused { None } else { normalized })
}

pub fn set_main_window_focused(app: &AppHandle, focused: bool) -> Result<()> {
    let state = app.state::<GlobalHotkeyState>();
    *state
        .main_focused
        .lock()
        .expect("global hotkey focus state poisoned") = focused;
    tracing::info!(focused, "voice focus bridge: main focus changed");
    app.emit(MAIN_WINDOW_FOCUSED_EVENT, focused)
        .context("Failed to emit main window focus state")?;
    apply_voice_panel_visibility(app)?;
    let desired = state
        .desired
        .lock()
        .expect("global hotkey desired state poisoned")
        .clone();
    sync_registered_hotkey(app, if focused { None } else { desired })
}

fn sync_registered_hotkey(app: &AppHandle, target: Option<String>) -> Result<()> {
    let state = app.state::<GlobalHotkeyState>();
    let mut registered = state
        .registered
        .lock()
        .expect("global hotkey registered state poisoned");
    if *registered == target {
        return Ok(());
    }

    let previous = registered.clone();
    if let Some(previous) = previous.as_deref() {
        app.global_shortcut()
            .unregister(previous)
            .with_context(|| format!("Failed to unregister global hotkey {previous}"))?;
    }

    if let Some(next) = target.as_deref() {
        if let Err(error) = app
            .global_shortcut()
            .on_shortcut(next, handle_global_hotkey)
        {
            if let Some(previous) = previous.as_deref() {
                if let Err(restore_error) = app
                    .global_shortcut()
                    .on_shortcut(previous, handle_global_hotkey)
                {
                    tracing::warn!(
                        error = %restore_error,
                        hotkey = %previous,
                        "Failed to restore previous global hotkey",
                    );
                    *registered = None;
                }
            }
            return Err(error).with_context(|| format!("Failed to register global hotkey {next}"));
        }
    }

    *registered = target;
    Ok(())
}

fn handle_global_hotkey(
    app: &AppHandle,
    _shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: ShortcutEvent,
) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    if let Err(error) = request_voice_toggle(app) {
        tracing::warn!(error = %format!("{error:#}"), "Failed to request voice toggle from global hotkey");
    }
}

fn request_voice_toggle(app: &AppHandle) -> Result<()> {
    if app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .is_some_and(|window| {
            window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
        })
    {
        return Ok(());
    }

    app.emit(VOICE_TOGGLE_REQUEST_EVENT, ())
        .context("Failed to emit voice toggle request")
}

/// Main-window voice state is the source of truth. Rust only mirrors
/// whether the always-on-top global panel should be visible while the
/// main window is unfocused.
#[tauri::command]
pub fn set_voice_mode_active(app: AppHandle, active: bool) -> Result<(), CommandError> {
    {
        let state = app.state::<GlobalHotkeyState>();
        *state
            .voice_active
            .lock()
            .expect("voice active state poisoned") = active;
    }
    tracing::info!(active, "voice focus bridge: active changed");
    Ok(apply_voice_panel_visibility(&app)?)
}

/// Compatibility command for existing JS callers. Ending the session
/// means the main-window-owned voice mode is no longer active.
#[tauri::command]
pub fn hide_voice_panel(app: AppHandle) -> Result<(), CommandError> {
    {
        let state = app.state::<GlobalHotkeyState>();
        *state
            .voice_active
            .lock()
            .expect("voice active state poisoned") = false;
    }
    Ok(apply_voice_panel_visibility(&app)?)
}

fn apply_voice_panel_visibility(app: &AppHandle) -> Result<()> {
    let state = app.state::<GlobalHotkeyState>();
    let voice_active = *state
        .voice_active
        .lock()
        .expect("voice active state poisoned");
    let recorded_main_focused = *state
        .main_focused
        .lock()
        .expect("global hotkey focus state poisoned");
    let main_focused = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .map(|window| window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false))
        .unwrap_or(recorded_main_focused);
    let visible = should_show_voice_panel(voice_active, main_focused);
    let panel = app
        .get_webview_window(VOICE_PANEL_WINDOW_LABEL)
        .ok_or_else(|| anyhow!("Voice panel window is not available"))?;
    tracing::info!(
        voice_active,
        recorded_main_focused,
        main_focused,
        visible,
        "voice focus bridge: applying panel visibility",
    );

    if visible {
        position_voice_panel(&panel)?;
        panel.show()?;
        panel.unminimize()?;
    } else {
        panel.hide()?;
    }

    Ok(())
}

fn should_show_voice_panel(voice_active: bool, main_focused: bool) -> bool {
    voice_active && !main_focused
}

fn position_voice_panel(panel: &tauri::WebviewWindow) -> Result<()> {
    panel
        .set_size(LogicalSize::new(VOICE_PANEL_WIDTH, VOICE_PANEL_HEIGHT))
        .context("Failed to size voice panel")?;

    let monitor = panel
        .current_monitor()?
        .or(panel.primary_monitor()?)
        .or_else(|| {
            panel
                .available_monitors()
                .ok()
                .and_then(|mut monitors| monitors.pop())
        });
    let Some(monitor) = monitor else {
        return Ok(());
    };

    let scale = monitor.scale_factor();
    let work_area = monitor.work_area();
    let panel_width = (VOICE_PANEL_WIDTH * scale).round() as i32;
    let panel_height = (VOICE_PANEL_HEIGHT * scale).round() as i32;
    let bottom_margin = (VOICE_PANEL_BOTTOM_MARGIN * scale).round() as i32;
    let x = work_area.position.x + ((work_area.size.width as i32 - panel_width) / 2);
    let y = work_area.position.y + work_area.size.height as i32 - panel_height - bottom_margin;

    panel
        .set_position(PhysicalPosition::new(x, y))
        .context("Failed to position voice panel")?;
    Ok(())
}

fn global_hotkey_from_shortcuts_json(raw: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    value
        .get(GLOBAL_HOTKEY_ID)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn to_tauri_accelerator(hotkey: &str) -> Result<String> {
    let parts: Vec<&str> = hotkey
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return Err(anyhow!("Global hotkey is empty"));
    }

    let mut converted = Vec::with_capacity(parts.len());
    for part in parts {
        converted.push(match part {
            "Mod" => "CommandOrControl".to_owned(),
            "Control" => "Ctrl".to_owned(),
            "ArrowUp" => "Up".to_owned(),
            "ArrowDown" => "Down".to_owned(),
            "ArrowLeft" => "Left".to_owned(),
            "ArrowRight" => "Right".to_owned(),
            "Escape" => "Esc".to_owned(),
            " " | "Space" => "Space".to_owned(),
            key => key.to_owned(),
        });
    }

    let accelerator = converted.join("+");
    Shortcut::from_str(&accelerator).with_context(|| format!("Invalid global hotkey {hotkey}"))?;
    Ok(accelerator)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_global_hotkey_from_shortcuts_json() {
        assert_eq!(
            global_hotkey_from_shortcuts_json(r#"{"global.hotkey":"Mod+Shift+Space"}"#),
            Some("Mod+Shift+Space".to_owned()),
        );
        assert_eq!(
            global_hotkey_from_shortcuts_json(r#"{"global.hotkey":null}"#),
            None,
        );
    }

    #[test]
    fn converts_frontend_hotkey_to_tauri_accelerator() {
        assert_eq!(
            to_tauri_accelerator("Mod+Shift+Space").unwrap(),
            "CommandOrControl+Shift+Space",
        );
        assert_eq!(
            to_tauri_accelerator("Control+Alt+ArrowUp").unwrap(),
            "Ctrl+Alt+Up",
        );
    }

    #[test]
    fn validates_special_key_accelerators() {
        assert_eq!(to_tauri_accelerator("Mod+=").unwrap(), "CommandOrControl+=");
        assert_eq!(to_tauri_accelerator("Mod+-").unwrap(), "CommandOrControl+-");
        assert_eq!(to_tauri_accelerator("Mod+,").unwrap(), "CommandOrControl+,");
        assert_eq!(to_tauri_accelerator("Mod+/").unwrap(), "CommandOrControl+/");
    }

    #[test]
    fn rejects_empty_or_modifier_only_hotkeys() {
        assert!(to_tauri_accelerator("").is_err());
        assert!(to_tauri_accelerator("   ").is_err());
        assert!(to_tauri_accelerator("Mod+").is_err());
        assert!(to_tauri_accelerator("Mod+Shift").is_err());
    }

    #[test]
    fn voice_panel_visible_only_when_voice_active_and_main_unfocused() {
        assert!(!should_show_voice_panel(false, false));
        assert!(!should_show_voice_panel(false, true));
        assert!(!should_show_voice_panel(true, true));
        assert!(should_show_voice_panel(true, false));
    }
}
