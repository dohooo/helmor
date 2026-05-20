//! Per-method RPC metrics for the daemon (Track E2).
//!
//! The dispatcher records every handler invocation's duration + outcome
//! so the desktop's runtime-debug panel can show "which methods are
//! the busiest? which are slow? which are erroring?" without an
//! external metrics pipeline. Bounded in memory; no histograms /
//! cardinality explosion.
//!
//! Each method keeps:
//!   - total call count
//!   - error count (handler returned `Err`)
//!   - a bounded ring of recent latency samples (`SAMPLES_PER_METHOD`)
//!     used to compute p50/p99 on read.
//!
//! Reads are cheap: `snapshot()` clones the per-method map under one
//! mutex acquire, then computes percentiles outside the lock.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

/// How many latency samples to keep per method. 512 is enough that a
/// p99 lookup is meaningful (~5 worst-case samples back the tail) and
/// small enough that the memory footprint stays in the low KB range
/// across the whole method catalogue.
pub const SAMPLES_PER_METHOD: usize = 512;

#[derive(Debug, Default)]
struct MethodCounters {
    count: u64,
    error_count: u64,
    /// Latency samples in milliseconds, in insertion order. Oldest at
    /// the front. Bounded by `SAMPLES_PER_METHOD`.
    samples_ms: VecDeque<u32>,
}

/// Process-wide metrics registry. Held inside an `Arc<RpcMetrics>`
/// on the `ServerContext` so handlers + the dispatcher both see the
/// same state. All public methods are interior-mutable + thread-safe.
#[derive(Debug, Default)]
pub struct RpcMetrics {
    per_method: Mutex<HashMap<&'static str, MethodCounters>>,
}

impl RpcMetrics {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one handler invocation. `method` is the static name
    /// from [`super::super::methods::Method::as_str`].
    pub fn record(&self, method: &'static str, elapsed: Duration, is_error: bool) {
        let mut guard = self.per_method.lock().expect("rpc metrics mutex poisoned");
        let entry = guard.entry(method).or_default();
        entry.count = entry.count.saturating_add(1);
        if is_error {
            entry.error_count = entry.error_count.saturating_add(1);
        }
        let ms = u32::try_from(elapsed.as_millis()).unwrap_or(u32::MAX);
        if entry.samples_ms.len() == SAMPLES_PER_METHOD {
            entry.samples_ms.pop_front();
        }
        entry.samples_ms.push_back(ms);
    }

    /// Snapshot the per-method counters, computing p50/p99 from the
    /// stored samples. The returned vec is sorted by descending call
    /// count so the busiest methods land at the top of the panel.
    pub fn snapshot(&self) -> Vec<MethodMetricsSnapshot> {
        let guard = self.per_method.lock().expect("rpc metrics mutex poisoned");
        let mut out: Vec<MethodMetricsSnapshot> = guard
            .iter()
            .map(|(method, counters)| MethodMetricsSnapshot {
                method: (*method).to_string(),
                count: counters.count,
                error_count: counters.error_count,
                p50_ms: percentile(&counters.samples_ms, 50.0),
                p99_ms: percentile(&counters.samples_ms, 99.0),
                last_sample_ms: counters.samples_ms.back().copied(),
            })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.method.cmp(&b.method)));
        out
    }
}

/// Snapshot of a single method's metrics, shaped for serde / the wire.
/// Lives here (not in `methods.rs`) because it's the dispatcher's
/// concern; `methods.rs` re-exports it as part of the RPC result type.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodMetricsSnapshot {
    /// Method name (e.g. `"agent.send"`).
    pub method: String,
    /// Total invocations recorded since the daemon started.
    pub count: u64,
    /// Invocations where the handler returned `Err`. Subset of `count`.
    pub error_count: u64,
    /// p50 latency in milliseconds across the stored samples.
    pub p50_ms: u32,
    /// p99 latency in milliseconds across the stored samples. Equal
    /// to `p50_ms` when fewer than 100 samples have been collected.
    pub p99_ms: u32,
    /// Most-recent sample's latency. Useful for a "is this method
    /// currently slow?" eye-on-the-tail debug surface.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sample_ms: Option<u32>,
}

/// Compute the `p` percentile (0-100) of the supplied samples.
/// Returns 0 for an empty input. Uses nearest-rank, which is
/// adequate for diagnostic display + doesn't need an interpolation
/// pass.
fn percentile(samples: &VecDeque<u32>, p: f64) -> u32 {
    if samples.is_empty() {
        return 0;
    }
    let mut sorted: Vec<u32> = samples.iter().copied().collect();
    sorted.sort_unstable();
    let n = sorted.len();
    let rank = ((p / 100.0) * n as f64).ceil() as usize;
    let idx = rank.saturating_sub(1).min(n - 1);
    sorted[idx]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_of_empty_is_zero() {
        let q: VecDeque<u32> = VecDeque::new();
        assert_eq!(percentile(&q, 50.0), 0);
        assert_eq!(percentile(&q, 99.0), 0);
    }

    #[test]
    fn percentile_picks_nearest_rank() {
        // 10 samples 1..=10; p50 = 5 (rank 5), p99 = 10 (rank 10).
        let q: VecDeque<u32> = (1..=10u32).collect();
        assert_eq!(percentile(&q, 50.0), 5);
        assert_eq!(percentile(&q, 99.0), 10);
        // p0 falls to index 0 (saturating_sub).
        assert_eq!(percentile(&q, 0.0), 1);
    }

    #[test]
    fn record_aggregates_per_method() {
        let m = RpcMetrics::new();
        m.record("agent.send", Duration::from_millis(10), false);
        m.record("agent.send", Duration::from_millis(20), false);
        m.record("agent.send", Duration::from_millis(30), true);
        m.record("ping", Duration::from_millis(1), false);
        let snap = m.snapshot();
        assert_eq!(snap.len(), 2);
        // Busiest method first.
        assert_eq!(snap[0].method, "agent.send");
        assert_eq!(snap[0].count, 3);
        assert_eq!(snap[0].error_count, 1);
        assert_eq!(snap[0].last_sample_ms, Some(30));
        assert_eq!(snap[1].method, "ping");
        assert_eq!(snap[1].count, 1);
        assert_eq!(snap[1].error_count, 0);
    }

    #[test]
    fn samples_ring_evicts_oldest_when_full() {
        let m = RpcMetrics::new();
        for i in 0..(SAMPLES_PER_METHOD as u32 + 10) {
            m.record("ping", Duration::from_millis(i as u64), false);
        }
        let snap = m.snapshot();
        assert_eq!(snap[0].count, SAMPLES_PER_METHOD as u64 + 10);
        // p99 reflects the recent tail (the early small samples were
        // evicted). The latest sample is `count - 1`.
        assert!(snap[0].p99_ms >= snap[0].p50_ms);
        assert_eq!(snap[0].last_sample_ms, Some(SAMPLES_PER_METHOD as u32 + 9));
    }

    #[test]
    fn snapshot_sorts_busiest_first() {
        let m = RpcMetrics::new();
        for _ in 0..3 {
            m.record("agent.send", Duration::from_millis(5), false);
        }
        for _ in 0..7 {
            m.record("ping", Duration::from_millis(1), false);
        }
        let snap = m.snapshot();
        assert_eq!(snap[0].method, "ping");
        assert_eq!(snap[1].method, "agent.send");
    }
}
