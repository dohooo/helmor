//! Per-process registry of in-flight agent streams.
//!
//! `ActiveStreams` holds one `ActiveStreamHandle` per running turn so the
//! Tauri shutdown path (`abort_all_active_streams_blocking`) can issue a
//! stopSession to every sidecar request and wait briefly for them to
//! drain. The event loop in `streaming/mod.rs` registers/unregisters
//! handles around its lifetime; nothing else mutates the map.
//!
//! It's also the source of truth the UI mirrors via
//! `list_active_streams` + `UiMutationEvent::ActiveStreamsChanged`. The
//! abort button visibility / "session is busy" derivation in the
//! frontend reads off that snapshot, so the event-loop call sites must
//! publish the event after every register/unregister.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub(crate) struct ActiveStreamHandle {
    pub request_id: String,
    pub sidecar_session_id: String,
    pub provider: String,
    /// Helmor session this stream belongs to. Drives the per-session
    /// dedup in `try_register_for_session`. `Option<_>` is defensive —
    /// today every registered handle comes from `stream_via_sidecar`
    /// and carries a Some, but the type leaves room for an anonymous
    /// stream path (which would NOT surface in `snapshot_for_ui`).
    pub helmor_session_id: Option<String>,
    /// Workspace owning the helmor session, looked up at registration
    /// time. `None` for streams without a helmor session, or when the
    /// session row hasn't been written yet (rare boot race).
    pub workspace_id: Option<String>,
}

/// UI-facing projection of an active stream — the only fields the
/// frontend needs to drive the abort button + busy badge.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveStreamSummary {
    pub session_id: String,
    pub workspace_id: Option<String>,
    pub provider: String,
}

#[derive(Default)]
pub struct ActiveStreams {
    inner: Arc<Mutex<HashMap<String, ActiveStreamHandle>>>,
}

impl ActiveStreams {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `handle` iff no existing entry targets the same
    /// `helmor_session_id`. `None` ids never collide. Returns `false`
    /// when a stream is already in flight for the session.
    pub(super) fn try_register_for_session(&self, handle: ActiveStreamHandle) -> bool {
        let Ok(mut map) = self.inner.lock() else {
            return false;
        };
        if let Some(hsid) = handle.helmor_session_id.as_deref() {
            let already_active = map
                .values()
                .any(|h| h.helmor_session_id.as_deref() == Some(hsid));
            if already_active {
                return false;
            }
        }
        map.insert(handle.request_id.clone(), handle);
        true
    }

    pub(super) fn unregister(&self, request_id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(request_id);
        }
    }

    fn snapshot(&self) -> Vec<ActiveStreamHandle> {
        self.inner
            .lock()
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default()
    }

    /// UI-facing snapshot. Drops handles without a `helmor_session_id`
    /// — the frontend keys everything off the helmor session, so a
    /// session-less entry would be unaddressable on the wire. Today
    /// every registered handle has one; this is purely defensive.
    pub fn snapshot_for_ui(&self) -> Vec<ActiveStreamSummary> {
        self.inner
            .lock()
            .map(|map| {
                map.values()
                    .filter_map(|h| {
                        h.helmor_session_id.as_ref().map(|sid| ActiveStreamSummary {
                            session_id: sid.clone(),
                            workspace_id: h.workspace_id.clone(),
                            provider: h.provider.clone(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn lookup_by_sidecar_session_id(
        &self,
        sidecar_session_id: &str,
    ) -> Option<ActiveStreamHandle> {
        self.inner.lock().ok().and_then(|map| {
            map.values()
                .find(|h| h.sidecar_session_id == sidecar_session_id)
                .cloned()
        })
    }

    pub(crate) fn len(&self) -> usize {
        self.inner.lock().map(|map| map.len()).unwrap_or(0)
    }

    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// On graceful shutdown, fire `stopSession` to every active stream and
/// wait up to `timeout` for them to unregister themselves. Best-effort:
/// streams that fail to drain in time are logged but not forcibly killed
/// here — process teardown handles that.
pub fn abort_all_active_streams_blocking(
    sidecar: &crate::sidecar::ManagedSidecar,
    active: &ActiveStreams,
    timeout: Duration,
) {
    let handles = active.snapshot();
    if handles.is_empty() {
        return;
    }

    tracing::info!(
        count = handles.len(),
        "Graceful shutdown — aborting active streams"
    );

    for handle in &handles {
        let stop_req = crate::sidecar::SidecarRequest {
            id: Uuid::new_v4().to_string(),
            method: "stopSession".to_string(),
            params: serde_json::json!({
                "sessionId": handle.sidecar_session_id,
                "provider": handle.provider,
            }),
        };
        if let Err(error) = sidecar.send(&stop_req) {
            tracing::error!(request_id = %handle.request_id, "Failed to send stopSession during shutdown: {error}");
        }
    }

    let start = Instant::now();
    let poll = Duration::from_millis(50);
    while !active.is_empty() && start.elapsed() < timeout {
        std::thread::sleep(poll);
    }

    let remaining = active.len();
    if remaining == 0 {
        tracing::info!("Graceful shutdown — all streams drained cleanly");
    } else {
        tracing::info!(
            remaining,
            "Graceful shutdown — timeout, streams still active"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(request_id: &str, helmor_session_id: Option<&str>) -> ActiveStreamHandle {
        ActiveStreamHandle {
            request_id: request_id.to_string(),
            sidecar_session_id: format!("sidecar-{request_id}"),
            provider: "claude".to_string(),
            helmor_session_id: helmor_session_id.map(str::to_string),
            workspace_id: helmor_session_id.map(|sid| format!("ws-{sid}")),
        }
    }

    #[test]
    fn snapshot_for_ui_omits_anonymous_streams() {
        let streams = ActiveStreams::new();
        assert!(streams.try_register_for_session(handle("r1", Some("s1"))));
        assert!(streams.try_register_for_session(handle("r2", None)));

        let snap = streams.snapshot_for_ui();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].session_id, "s1");
        assert_eq!(snap[0].workspace_id.as_deref(), Some("ws-s1"));
        assert_eq!(snap[0].provider, "claude");
    }

    #[test]
    fn unregister_removes_from_snapshot() {
        let streams = ActiveStreams::new();
        assert!(streams.try_register_for_session(handle("r1", Some("s1"))));
        streams.unregister("r1");
        assert!(streams.snapshot_for_ui().is_empty());
    }

    #[test]
    fn duplicate_helmor_session_id_is_rejected() {
        let streams = ActiveStreams::new();
        assert!(streams.try_register_for_session(handle("r1", Some("s1"))));
        assert!(!streams.try_register_for_session(handle("r2", Some("s1"))));
        // Anonymous streams never collide.
        assert!(streams.try_register_for_session(handle("r3", None)));
        assert!(streams.try_register_for_session(handle("r4", None)));
    }
}
