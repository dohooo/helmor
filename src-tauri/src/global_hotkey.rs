use std::{str::FromStr, sync::Mutex};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::error::CommandError;

const SHORTCUTS_SETTING_KEY: &str = "app.shortcuts";
const GLOBAL_HOTKEY_ID: &str = "global.hotkey";
const MAIN_WINDOW_LABEL: &str = "main";

// Rust owns plugin registration, so no frontend plugin capability is needed.
// Startup reads only stored overrides; keep the TS default null unless this
// module learns the registry default too.
#[derive(Default)]
pub struct GlobalHotkeyState {
    current: Mutex<Option<String>>,
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
    let mut current = state.current.lock().expect("global hotkey state poisoned");
    if *current == normalized {
        return Ok(());
    }

    let previous = current.clone();
    if let Some(previous) = previous.as_deref() {
        app.global_shortcut()
            .unregister(previous)
            .with_context(|| format!("Failed to unregister global hotkey {previous}"))?;
    }

    if let Some(next) = normalized.as_deref() {
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
                    *current = None;
                }
            }
            return Err(error).with_context(|| format!("Failed to register global hotkey {next}"));
        }
    }

    *current = normalized;
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
    if let Err(error) = toggle_main_window(app) {
        tracing::warn!(error = %format!("{error:#}"), "Failed to toggle main window from global hotkey");
    }
}

fn toggle_main_window(app: &AppHandle) -> Result<()> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| anyhow!("Main window is not available"))?;

    if window.is_visible()? && window.is_focused()? {
        window.hide()?;
        return Ok(());
    }

    window.show()?;
    window.unminimize()?;
    window.set_focus()?;
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
}
