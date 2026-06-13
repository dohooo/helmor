//! Terminal-session busy state.
//!
//! `set_busy` mirrors a Terminal session's working/idle state into the shared
//! active-stream registry (sidebar spinner) and `sessions.status` (tab
//! spinner). The working state itself is hook-driven (`cli/terminal_hook.rs`),
//! but hooks cannot signal the one transition this module infers instead: a
//! user interrupt. Claude fires NO hook on Esc-abort (Stop is documented as
//! "does not run on user interrupt"), so without `observe_stdin` an aborted
//! turn would spin forever.

use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

const INTERRUPT_SETTLE: Duration = Duration::from_millis(500);

/// Apply a busy/idle transition for a Terminal session: active-stream
/// registry + `sessions.status` + the UI events both spinners listen to.
pub async fn set_busy<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    workspace_id: &str,
    provider: Option<&str>,
    busy: bool,
) -> anyhow::Result<()> {
    app.state::<crate::agents::ActiveStreams>()
        .set_session_active(
            session_id,
            Some(workspace_id.to_string()),
            provider.unwrap_or("terminal"),
            busy,
        );

    let status = if busy { "streaming" } else { "idle" };
    let sid = session_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        crate::models::sessions::set_session_status(&sid, status)
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??;

    crate::ui_sync::publish(app, crate::ui_sync::UiMutationEvent::ActiveStreamsChanged);
    // The session tab's spinner also reads sessions.status — refetch it now
    // (interrupt/exit paths come through here, not through the hook's
    // TerminalSessionIdle, so without this the tab lags the sidebar).
    crate::ui_sync::publish(
        app,
        crate::ui_sync::UiMutationEvent::SessionListChanged {
            workspace_id: workspace_id.to_string(),
        },
    );
    Ok(())
}

/// Infer a user interrupt from the bytes the renderer writes to the PTY:
/// Esc/Ctrl+C on a busy session clears busy after a settle window unless a
/// hook flipped it idle first.
///
/// Deliberately liberal — claude's Esc is overloaded (close menu / clear
/// input / press-twice-to-interrupt) — because the failure modes are
/// asymmetric: a false idle self-heals on the next PreToolUse/Stop hook,
/// while a missed interrupt sticks the spinner until app restart. Lives
/// backend-side so a misfire costs the renderer nothing; the old
/// renderer-side heuristic was removed because each misfire's IPC +
/// invalidation re-render could break an in-flight IME composition.
pub fn observe_stdin<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    workspace_id: &str,
    data: &str,
) {
    if !is_interrupt_keypress(data) {
        return;
    }
    if !app
        .state::<crate::agents::ActiveStreams>()
        .is_session_active(session_id)
    {
        return;
    }
    let app = app.clone();
    let session_id = session_id.to_string();
    let workspace_id = workspace_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INTERRUPT_SETTLE).await;
        // Still busy after the settle → no Stop/SessionEnd hook claimed the
        // turn; trust the keypress.
        if !app
            .state::<crate::agents::ActiveStreams>()
            .is_session_active(&session_id)
        {
            return;
        }
        if let Err(error) = set_busy(&app, &session_id, &workspace_id, None, false).await {
            tracing::warn!(%session_id, "interrupt inference failed to clear busy: {error}");
        }
    });
}

/// True iff `data` is a lone interrupt keypress. xterm.js delivers each
/// keystroke as one onData chunk: plain Esc is exactly ESC (arrow keys arrive
/// as full CSI sequences, bracketed paste wraps any pasted ESC) and Ctrl+C is
/// ETX. The CSI-u forms are their kitty-keyboard-protocol encodings, in case
/// a future xterm.js supports it.
fn is_interrupt_keypress(data: &str) -> bool {
    matches!(
        data,
        "\x1b" | "\x03" | "\x1b[27u" | "\x1b[27;1u" | "\x1b[99;5u"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn esc_and_ctrl_c_are_interrupt_keypresses() {
        assert!(is_interrupt_keypress("\x1b"));
        assert!(is_interrupt_keypress("\x03"));
    }

    #[test]
    fn kitty_encodings_are_interrupt_keypresses() {
        assert!(is_interrupt_keypress("\x1b[27u"));
        assert!(is_interrupt_keypress("\x1b[27;1u"));
        assert!(is_interrupt_keypress("\x1b[99;5u"));
    }

    #[test]
    fn other_input_is_not_an_interrupt() {
        // Printable text, arrow key, Alt+f, function key, bracketed paste
        // containing a lone ESC — none are a plain Esc/Ctrl+C press.
        for data in [
            "a",
            "hello",
            "\x1b[A",
            "\x1bf",
            "\x1bOP",
            "\r",
            "\x1b[200~\x1b\x1b[201~",
        ] {
            assert!(!is_interrupt_keypress(data), "{data:?}");
        }
    }

    #[test]
    fn empty_input_is_not_an_interrupt() {
        assert!(!is_interrupt_keypress(""));
    }
}
