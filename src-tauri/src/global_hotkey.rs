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
/// Broadcast on every voice-session ownership change.
///
/// Payload is one of the strings in [`VoiceTarget::as_str`]
/// (`"main"` / `"panel"` / `"none"`); both webviews listen and decide
/// whether to mount their WebRTC peer based on whether the payload
/// names them. Replaces the old `helmor://voice-panel-active` boolean
/// event — that one couldn't express "voice is still running, just
/// follow the user into the main window" which is the whole point of
/// the focus-follow flow added in this revision.
const VOICE_ACTIVE_WINDOW_EVENT: &str = "helmor://voice-active-window";

/// Which webview owns the active voice session right now. The session
/// is OS-level singleton (one WebRTC peer + one mic permission grant)
/// so this is necessarily one-of-three: nowhere, the global panel, or
/// the main window's sidebar bar.
///
/// State transitions are driven by three inputs:
///   1. Global hotkey (only fires when main is unfocused) — toggles
///      between `None` ↔ `Panel`.
///   2. Main window focus change — if voice is running, follow the
///      user: `Panel` → `Main` on focus, `Main` → `Panel` on blur.
///      `None` stays `None` (focus changes alone don't start voice).
///   3. `notify_voice_ended` (agent-invoked `end_session` from either
///      webview) — any → `None`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum VoiceTarget {
    #[default]
    None,
    Panel,
    Main,
}

impl VoiceTarget {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Panel => "panel",
            Self::Main => "main",
        }
    }
}

// Rust owns plugin registration, so no frontend plugin capability is needed.
// Startup reads only stored overrides; the frontend syncs registry defaults
// after settings load.
#[derive(Default)]
pub struct GlobalHotkeyState {
    desired: Mutex<Option<String>>,
    registered: Mutex<Option<String>>,
    main_focused: Mutex<bool>,
    voice_target: Mutex<VoiceTarget>,
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
    // Voice follows focus. If the user is mid-call when they alt-tab
    // into / out of the main window, the WebRTC peer hands off between
    // panel and main-window sidebar so the conversation stays alive
    // without them having to re-summon. `None` is unchanged — focus
    // doesn't start voice by itself.
    {
        let mut target = state
            .voice_target
            .lock()
            .expect("voice target state poisoned");
        let next = match (*target, focused) {
            (VoiceTarget::Panel, true) => Some(VoiceTarget::Main),
            (VoiceTarget::Main, false) => Some(VoiceTarget::Panel),
            _ => None,
        };
        if let Some(next) = next {
            *target = next;
            // Drop the mutex guard before mutating windows / emitting so
            // a slow Tauri call can't deadlock a follow-up read of the
            // same state.
            drop(target);
            if let Err(error) = apply_voice_target(app, next) {
                tracing::warn!(
                    target_after = next.as_str(),
                    error = %format!("{error:#}"),
                    "Failed to apply voice target on focus change",
                );
            }
        }
    }
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
    if let Err(error) = toggle_voice_panel(app) {
        tracing::warn!(error = %format!("{error:#}"), "Failed to toggle voice panel from global hotkey");
    }
}

fn toggle_voice_panel(app: &AppHandle) -> Result<()> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| anyhow!("Main window is not available"))?;

    // Global hotkey shouldn't run while the main window owns focus —
    // the frontend has its own in-app voice toggle for that scenario.
    if window.is_visible()? && window.is_focused()? {
        return Ok(());
    }

    let state = app.state::<GlobalHotkeyState>();
    let next = {
        let target = state
            .voice_target
            .lock()
            .expect("voice target state poisoned");
        match *target {
            VoiceTarget::None => VoiceTarget::Panel,
            // Either Panel (user dismissing) or the unusual case where
            // Main is still recorded but the window blurred — collapse
            // to None either way.
            VoiceTarget::Panel | VoiceTarget::Main => VoiceTarget::None,
        }
    };
    set_voice_target(app, next)
}

/// Tauri command for either webview to call when the agent invokes
/// the synthetic `end_session` tool. Resets the voice target to
/// `None`, hides the panel (idempotent), and broadcasts so both
/// webviews drop their WebRTC peer. Keeps the name `hide_voice_panel`
/// for wire-compatibility with the existing JS callers — the behavior
/// is "voice session ended", panel hide is a side effect.
#[tauri::command]
pub fn hide_voice_panel(app: AppHandle) -> Result<(), CommandError> {
    Ok(set_voice_target(&app, VoiceTarget::None)?)
}

/// Update the recorded voice target, then apply the side effects
/// (panel show/hide + broadcast). Single source of truth — every voice
/// ownership change funnels through here so the state machine, the OS
/// window, and the broadcast event can't disagree.
fn set_voice_target(app: &AppHandle, next: VoiceTarget) -> Result<()> {
    {
        let state = app.state::<GlobalHotkeyState>();
        let mut target = state
            .voice_target
            .lock()
            .expect("voice target state poisoned");
        if *target == next {
            return Ok(());
        }
        *target = next;
    }
    apply_voice_target(app, next)
}

/// Side effects for a given voice target: show/hide the panel and
/// broadcast which webview should own the WebRTC peer. Idempotent on
/// the OS window state — calling with the current target is fine
/// (use `set_voice_target` if you want the de-dupe).
fn apply_voice_target(app: &AppHandle, target: VoiceTarget) -> Result<()> {
    let panel = app
        .get_webview_window(VOICE_PANEL_WINDOW_LABEL)
        .ok_or_else(|| anyhow!("Voice panel window is not available"))?;
    match target {
        VoiceTarget::Panel => {
            position_voice_panel(&panel)?;
            panel.show()?;
            panel.unminimize()?;
            panel.set_focus()?;
        }
        VoiceTarget::Main | VoiceTarget::None => {
            // Main owns the voice now; the panel must go away so the
            // user doesn't see a stale always-on-top frame. `None`
            // simply ends voice altogether.
            panel.hide()?;
        }
    }
    app.emit(VOICE_ACTIVE_WINDOW_EVENT, target.as_str())
        .context("Failed to broadcast voice target change")?;
    Ok(())
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
}
