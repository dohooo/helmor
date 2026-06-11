//! In-process, per-source fetch health for the Settings → Triage panel.
//!
//! Volatile by design: this is runtime state, cleared on restart (per the
//! redesign decision — no DB table, no migration). Written by the fetcher
//! scheduler ([`super::run_once`] + the IM backends), read by
//! [`crate::triage::source_health`] to overlay real fetch outcomes on top
//! of the static "is a workspace connected" check.
//!
//! Why this exists: before it, a fetch that failed silently produced zero
//! candidates and the panel still reported "Connected · Watching N
//! workspaces". Failures were invisible. Now they surface as `Degraded`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Default)]
pub struct FetchHealth {
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    /// Set when the whole fetch tick failed (`fetch_once` returned `Err`).
    /// Cleared on the next success.
    pub last_error: Option<String>,
    /// Set when a sub-signal degraded mid-tick (e.g. channel discovery
    /// failed) but the tick still produced partial results. Reset at the
    /// start of each attempt, so it always reflects the latest tick only.
    pub last_degraded: Option<String>,
    pub consecutive_failures: u32,
    pub items_last: usize,
}

fn store() -> &'static Mutex<HashMap<String, FetchHealth>> {
    static STORE: OnceLock<Mutex<HashMap<String, FetchHealth>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Mark the start of a fetch attempt: stamps the time and clears the
/// per-attempt degraded note so it can't leak across ticks.
pub fn record_attempt(source: &str) {
    let mut map = store().lock().expect("fetch-health poisoned");
    let entry = map.entry(source.to_string()).or_default();
    entry.last_attempt_at = Some(Utc::now());
    entry.last_degraded = None;
}

/// A sub-signal degraded mid-tick but partial results still came through.
/// Additive: does not clear a recorded success.
pub fn record_degraded(source: &str, reason: impl Into<String>) {
    let mut map = store().lock().expect("fetch-health poisoned");
    let entry = map.entry(source.to_string()).or_default();
    entry.last_degraded = Some(reason.into());
}

pub fn record_success(source: &str, items: usize) {
    let mut map = store().lock().expect("fetch-health poisoned");
    let entry = map.entry(source.to_string()).or_default();
    entry.last_success_at = Some(Utc::now());
    entry.last_error = None;
    entry.consecutive_failures = 0;
    entry.items_last = items;
}

pub fn record_failure(source: &str, reason: impl Into<String>) {
    let mut map = store().lock().expect("fetch-health poisoned");
    let entry = map.entry(source.to_string()).or_default();
    entry.last_error = Some(reason.into());
    entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
}

pub fn get(source: &str) -> Option<FetchHealth> {
    store()
        .lock()
        .expect("fetch-health poisoned")
        .get(source)
        .cloned()
}
