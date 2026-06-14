//! `helmor terminal-hook` — receives an agent CLI's hook callback.
//!
//! Registered as the hook command for Terminal-Mode agents (claude/codex).
//! The agent runs it on lifecycle events with the hook payload
//! on stdin; the owning terminal session id arrives via the
//! `HELMOR_TERMINAL_SESSION_ID` env var (injected when Helmor spawns the PTY).
//!
//! Its job for M4a: persist the agent's real session id into
//! `sessions.provider_session_id` so a later relaunch can `--resume`. It is a
//! strict no-op when not invoked from a Helmor terminal (env missing), so a
//! user running the same agent outside Helmor is never affected. A hook must
//! never break the agent, so every failure is swallowed.

use std::io::Read;

use anyhow::Result;

use super::args::Cli;

pub fn run(agent: &str, _cli: &Cli) -> Result<()> {
    let Ok(terminal_session_id) = std::env::var("HELMOR_TERMINAL_SESSION_ID") else {
        return Ok(());
    };
    if terminal_session_id.is_empty() {
        return Ok(());
    }

    let mut payload = String::new();
    let _ = std::io::stdin().read_to_string(&mut payload);
    if payload.trim().is_empty() {
        return Ok(());
    }

    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&payload) else {
        return Ok(());
    };

    if let Some(provider_session_id) = extract_session_id(agent, &parsed) {
        let _ = crate::models::sessions::set_provider_session_id(
            &terminal_session_id,
            &provider_session_id,
        );
    }

    // Busy/idle + captured prompt both need the owning workspace; look it up
    // once and reuse.
    let workspace_id = crate::models::sessions::workspace_id_for_session(&terminal_session_id)
        .ok()
        .flatten();

    // Mirror the hook lifecycle into busy/idle so the sidebar spinner +
    // completion notification treat this terminal exactly like a GUI session.
    if let (Some(busy), Some(workspace_id)) = (event_to_busy(&parsed), workspace_id.clone()) {
        let _ = crate::ui_sync::notify_running_app(
            crate::ui_sync::UiMutationEvent::TerminalActivityChanged {
                session_id: terminal_session_id.clone(),
                workspace_id,
                busy,
            },
        );
    }

    // Capture the submitted prompt so a Terminal session names itself + renames
    // its branch like a GUI session does on its first turn. The generator is
    // gated server-side, so only the first prompt actually renames.
    if let (Some(prompt), Some(workspace_id)) = (extract_prompt(&parsed), workspace_id) {
        let _ = crate::ui_sync::notify_running_app(
            crate::ui_sync::UiMutationEvent::TerminalPromptCaptured {
                session_id: terminal_session_id.clone(),
                workspace_id,
                prompt,
            },
        );
    }

    Ok(())
}

/// Map a hook event to a busy/idle transition (None = not state-changing).
/// Busy on prompt submit / tool use, idle on Stop or SessionEnd — Stop never
/// fires on a user interrupt, so SessionEnd is the only hook left when the
/// user quits claude mid-turn. SessionStart is NOT busy — the agent fires it
/// just by opening, which would spin the sidebar before any input (mirrors
/// ORCA's hook state machine).
fn event_to_busy(payload: &serde_json::Value) -> Option<bool> {
    match payload.get("hook_event_name").and_then(|v| v.as_str()) {
        Some("UserPromptSubmit" | "PreToolUse" | "PostToolUse") => Some(true),
        Some("Stop" | "SessionEnd") => Some(false),
        _ => None,
    }
}

/// Pull the user's submitted prompt out of a `UserPromptSubmit` payload.
/// claude and codex both use `prompt`; the fallbacks mirror ORCA's
/// candidate-key list for resilience. Gated on the event name — other events
/// carry unrelated text fields (e.g. Notification's `message`) that must not
/// masquerade as a prompt and trigger title/branch generation.
fn extract_prompt(payload: &serde_json::Value) -> Option<String> {
    if payload.get("hook_event_name").and_then(|v| v.as_str()) != Some("UserPromptSubmit") {
        return None;
    }
    for key in ["prompt", "user_prompt", "userPrompt", "message"] {
        if let Some(s) = payload.get(key).and_then(|v| v.as_str()) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Claude and Codex hook payloads both carry the session id in the common
/// `session_id` field, so one extractor covers both.
fn extract_session_id(_agent: &str, payload: &serde_json::Value) -> Option<String> {
    payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_session_id_from_claude_payload() {
        let p = json!({
            "session_id": "abc-123",
            "hook_event_name": "SessionStart",
            "cwd": "/x",
        });
        assert_eq!(extract_session_id("claude", &p).as_deref(), Some("abc-123"));
    }

    #[test]
    fn extracts_session_id_from_codex_payload() {
        let p = json!({ "session_id": "019b-xyz", "hook_event_name": "SessionStart" });
        assert_eq!(extract_session_id("codex", &p).as_deref(), Some("019b-xyz"));
    }

    #[test]
    fn missing_session_id_returns_none() {
        let p = json!({ "hook_event_name": "Stop" });
        assert_eq!(extract_session_id("claude", &p), None);
    }

    #[test]
    fn empty_session_id_returns_none() {
        let p = json!({ "session_id": "" });
        assert_eq!(extract_session_id("claude", &p), None);
    }

    #[test]
    fn session_start_does_not_set_busy() {
        let p = json!({ "hook_event_name": "SessionStart", "session_id": "x" });
        assert_eq!(event_to_busy(&p), None);
    }

    #[test]
    fn prompt_and_tool_events_set_busy() {
        for name in ["UserPromptSubmit", "PreToolUse", "PostToolUse"] {
            let p = json!({ "hook_event_name": name });
            assert_eq!(event_to_busy(&p), Some(true), "{name}");
        }
    }

    #[test]
    fn stop_and_session_end_clear_busy() {
        for name in ["Stop", "SessionEnd"] {
            let p = json!({ "hook_event_name": name });
            assert_eq!(event_to_busy(&p), Some(false), "{name}");
        }
    }

    #[test]
    fn extracts_prompt_from_user_prompt_submit() {
        let p = json!({ "hook_event_name": "UserPromptSubmit", "prompt": "fix the bug" });
        assert_eq!(extract_prompt(&p).as_deref(), Some("fix the bug"));
    }

    #[test]
    fn extract_prompt_trims_and_rejects_blank() {
        let submit = |p: &str| json!({ "hook_event_name": "UserPromptSubmit", "prompt": p });
        assert_eq!(extract_prompt(&submit("  hi  ")).as_deref(), Some("hi"));
        assert_eq!(extract_prompt(&submit("   ")), None);
        assert_eq!(extract_prompt(&json!({ "hook_event_name": "Stop" })), None);
    }

    #[test]
    fn extract_prompt_ignores_other_events_with_text_fields() {
        // Notification carries `message`; it must not masquerade as a prompt.
        let p = json!({ "hook_event_name": "Notification", "message": "perm needed" });
        assert_eq!(extract_prompt(&p), None);
        // No event name at all → not a prompt either.
        assert_eq!(extract_prompt(&json!({ "prompt": "hi" })), None);
    }
}
