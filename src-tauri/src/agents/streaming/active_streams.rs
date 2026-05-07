//! Per-process registry of in-flight agent streams.
//!
//! `ActiveStreams` holds one `ActiveStreamHandle` per running turn so the
//! Tauri shutdown path (`abort_all_active_streams_blocking`) can issue a
//! stopSession to every sidecar request and wait briefly for them to
//! drain. The event loop in `streaming/mod.rs` registers/unregisters
//! handles around its lifetime; nothing else mutates the map.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use uuid::Uuid;

#[derive(Debug, Clone)]
pub(crate) struct ActiveStreamHandle {
    pub request_id: String,
    pub sidecar_session_id: String,
    pub provider: String,
    /// Helmor session this stream belongs to. Drives the per-session
    /// dedup in `try_register_for_session`. `None` for streams without
    /// one (e.g. title generation).
    pub helmor_session_id: Option<String>,
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
