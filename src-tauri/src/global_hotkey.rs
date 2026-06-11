use std::{collections::HashMap, str::FromStr, sync::Mutex};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::error::CommandError;

const SHORTCUTS_SETTING_KEY: &str = "app.shortcuts";
const GLOBAL_HOTKEY_ID: &str = "global.hotkey";
const QUICK_PANEL_HOTKEY_ID: &str = "quickPanel.hotkey";
const OS_HOTKEY_IDS: [&str; 2] = [GLOBAL_HOTKEY_ID, QUICK_PANEL_HOTKEY_ID];
const MAIN_WINDOW_LABEL: &str = "main";

// Rust owns plugin registration, so no frontend plugin capability is needed.
// The registry defaults below MUST stay in sync with `defaultHotkey` in
// src/features/shortcuts/registry.ts: the startup sync registers them when the
// stored overrides have no entry for the id, while an explicit `null` override
// means the user unbound the hotkey.
fn default_hotkey(id: &str) -> Option<&'static str> {
    match id {
        QUICK_PANEL_HOTKEY_ID => Some("Shift+Alt+Space"),
        _ => None,
    }
}

/// Registered accelerators by hotkey id.
#[derive(Default)]
pub struct GlobalHotkeyState {
    current: Mutex<HashMap<String, String>>,
}

pub fn sync_from_settings(app: &AppHandle) -> Result<()> {
    let raw = crate::settings::load_setting_value(SHORTCUTS_SETTING_KEY)?;
    let mut first_error = None;
    for id in OS_HOTKEY_IDS {
        let hotkey = hotkey_from_shortcuts_json(raw.as_deref(), id);
        // One hotkey failing to register must not block the other.
        if let Err(error) = sync_hotkey_inner(app, id, hotkey) {
            tracing::warn!(
                error = %format!("{error:#}"),
                hotkey_id = id,
                "Failed to register startup global hotkey",
            );
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[tauri::command]
pub fn sync_global_hotkey(
    app: AppHandle,
    id: String,
    hotkey: Option<String>,
) -> Result<(), CommandError> {
    if !OS_HOTKEY_IDS.contains(&id.as_str()) {
        return Err(anyhow!("Unknown global hotkey id {id}").into());
    }
    Ok(sync_hotkey_inner(&app, &id, hotkey)?)
}

fn sync_hotkey_inner(app: &AppHandle, id: &str, hotkey: Option<String>) -> Result<()> {
    let normalized = hotkey
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(to_tauri_accelerator)
        .transpose()?;

    let state = app.state::<GlobalHotkeyState>();
    let mut current = state.current.lock().expect("global hotkey state poisoned");
    if current.get(id).cloned() == normalized {
        return Ok(());
    }

    let handler = handler_for(id);
    let previous = current.get(id).cloned();
    if let Some(previous) = previous.as_deref() {
        app.global_shortcut()
            .unregister(previous)
            .with_context(|| format!("Failed to unregister global hotkey {previous}"))?;
    }

    if let Some(next) = normalized.as_deref() {
        if let Err(error) = app.global_shortcut().on_shortcut(next, handler) {
            if let Some(previous) = previous.as_deref() {
                if let Err(restore_error) = app.global_shortcut().on_shortcut(previous, handler) {
                    tracing::warn!(
                        error = %restore_error,
                        hotkey = %previous,
                        "Failed to restore previous global hotkey",
                    );
                    current.remove(id);
                }
            }
            return Err(error).with_context(|| format!("Failed to register global hotkey {next}"));
        }
    }

    match normalized {
        Some(accelerator) => current.insert(id.to_owned(), accelerator),
        None => current.remove(id),
    };
    Ok(())
}

fn handler_for(id: &str) -> fn(&AppHandle, &Shortcut, ShortcutEvent) {
    match id {
        QUICK_PANEL_HOTKEY_ID => handle_quick_panel_hotkey,
        _ => handle_main_hotkey,
    }
}

fn handle_main_hotkey(
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

fn handle_quick_panel_hotkey(
    app: &AppHandle,
    _shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: ShortcutEvent,
) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    if let Err(error) = crate::quick_panel::toggle(app) {
        tracing::warn!(error = %format!("{error:#}"), "Failed to toggle quick panel from global hotkey");
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

fn hotkey_from_shortcuts_json(raw: Option<&str>, id: &str) -> Option<String> {
    let fallback = || default_hotkey(id).map(str::to_owned);
    let Some(raw) = raw else {
        return fallback();
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return fallback();
    };
    match value.get(id) {
        // No override stored: the registry default applies.
        None => fallback(),
        // Explicit null: the user unbound this hotkey.
        Some(Value::Null) => None,
        Some(other) => other.as_str().map(str::to_owned),
    }
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
            hotkey_from_shortcuts_json(
                Some(r#"{"global.hotkey":"Mod+Shift+Space"}"#),
                GLOBAL_HOTKEY_ID
            ),
            Some("Mod+Shift+Space".to_owned()),
        );
        assert_eq!(
            hotkey_from_shortcuts_json(Some(r#"{"global.hotkey":null}"#), GLOBAL_HOTKEY_ID),
            None,
        );
        // No override stored: global.hotkey has no registry default.
        assert_eq!(hotkey_from_shortcuts_json(None, GLOBAL_HOTKEY_ID), None);
        assert_eq!(
            hotkey_from_shortcuts_json(Some("{}"), GLOBAL_HOTKEY_ID),
            None,
        );
    }

    #[test]
    fn quick_panel_hotkey_falls_back_to_registry_default() {
        // No settings / no override: the registry default applies.
        assert_eq!(
            hotkey_from_shortcuts_json(None, QUICK_PANEL_HOTKEY_ID),
            Some("Shift+Alt+Space".to_owned()),
        );
        assert_eq!(
            hotkey_from_shortcuts_json(Some("{}"), QUICK_PANEL_HOTKEY_ID),
            Some("Shift+Alt+Space".to_owned()),
        );
        // Explicit null: the user unbound it.
        assert_eq!(
            hotkey_from_shortcuts_json(
                Some(r#"{"quickPanel.hotkey":null}"#),
                QUICK_PANEL_HOTKEY_ID
            ),
            None,
        );
        // Override wins over the default.
        assert_eq!(
            hotkey_from_shortcuts_json(
                Some(r#"{"quickPanel.hotkey":"Mod+Shift+K"}"#),
                QUICK_PANEL_HOTKEY_ID
            ),
            Some("Mod+Shift+K".to_owned()),
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
        assert_eq!(
            to_tauri_accelerator("Shift+Alt+Space").unwrap(),
            "Shift+Alt+Space",
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
