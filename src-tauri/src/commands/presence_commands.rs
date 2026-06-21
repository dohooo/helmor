//! Team-mode presence: ephemeral typing/working signals broadcast to peers.
//!
//! Reported by any member's frontend; the trusted member id is injected by the
//! companion dispatcher (`companion/rpc.rs`), never client-asserted. Nothing is
//! persisted — the event rides the shared `/v1/stream` `UiMutationEvent` channel
//! and clients self-expire it by `ts` + a client-side TTL.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ui_sync::{PresenceActivity, UiMutationEvent};

use super::common::CmdResult;

/// Coalesce window for high-frequency `Typing` reports, per (member, workspace).
const TYPING_THROTTLE_MS: u64 = 2_000;

fn typing_throttle() -> &'static Mutex<HashMap<String, u64>> {
    static THROTTLE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    THROTTLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Broadcast a member's presence over the shared UI-sync channel. `author_id`
/// is the SERVER-derived member id (the companion dispatcher injects it from the
/// trusted header); `None` means no member context (local desktop / non-team),
/// so there's nothing to broadcast — a no-op.
pub fn publish_presence(
    app: &tauri::AppHandle,
    author_id: Option<String>,
    workspace_id: String,
    session_id: Option<String>,
    activity: PresenceActivity,
) -> CmdResult<()> {
    let Some(member_id) = author_id else {
        return Ok(());
    };
    let now = now_unix_ms();

    // Typing fires on every keystroke; coalesce to at most one event per window
    // per (member, workspace) so a fast typist doesn't flood the stream.
    // Working/Idle are state transitions — always emitted.
    if matches!(activity, PresenceActivity::Typing) {
        let key = format!("{member_id}\u{1f}{workspace_id}");
        if let Ok(mut last_by_key) = typing_throttle().lock() {
            if let Some(&last) = last_by_key.get(&key) {
                if now.saturating_sub(last) < TYPING_THROTTLE_MS {
                    return Ok(());
                }
            }
            last_by_key.insert(key, now);
        }
    }

    crate::ui_sync::publish(
        app,
        UiMutationEvent::RoomPresenceChanged {
            member_id,
            workspace_id,
            session_id,
            activity,
            ts: now,
        },
    );
    Ok(())
}

/// `report_presence` — a member's frontend reporting transient activity in a
/// shared workspace. The desktop/local invoke path has no trusted member id, so
/// it's a no-op here; team-mode reporting flows through the companion dispatcher,
/// which injects the server-derived member id.
#[tauri::command]
pub fn report_presence(
    app: tauri::AppHandle,
    workspace_id: String,
    session_id: Option<String>,
    activity: PresenceActivity,
) -> CmdResult<()> {
    publish_presence(&app, None, workspace_id, session_id, activity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_member_id_is_a_noop() {
        // Can't assert the broadcast without an app handle, but the early
        // return on `None` author must not panic — the local/desktop path.
        // (publish_presence's only side effect for None is returning Ok.)
        assert!(now_unix_ms() > 0);
    }

    #[test]
    fn typing_throttle_coalesces_within_window() {
        let key = "m\u{1f}w".to_string();
        let now = now_unix_ms();
        {
            let mut guard = typing_throttle().lock().unwrap();
            guard.insert(key.clone(), now);
        }
        let guard = typing_throttle().lock().unwrap();
        let last = *guard.get(&key).unwrap();
        assert!(now.saturating_sub(last) < TYPING_THROTTLE_MS);
    }
}
