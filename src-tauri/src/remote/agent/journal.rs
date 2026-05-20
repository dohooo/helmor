//! Per-session ring buffer for sidecar events the daemon has emitted
//! during a live agent turn.
//!
//! Phase 24q-1: foundation for desktop reattach replay. Before this
//! module, the daemon was purely forwarding — events emitted before
//! `agent.attach` swapped the notifier reached the previous client
//! (or no one, on cold attach) and were gone. The journal keeps a
//! bounded window of recent events so a fresh client can ask "give
//! me events since seq N" and catch up to the live tail instead of
//! starting mid-stream.
//!
//! ## Sequence semantics
//!
//! Sequence numbers are per-session, start at 1, monotonically
//! increase, never reset for the lifetime of the session. The
//! daemon does not persist them across daemon restarts (24t is a
//! separate phase); a restart resets the counter to 1 and the
//! desktop's stored `last_event_seq` becomes ahead of the daemon's
//! head — `replay_since` reports that as a gap.
//!
//! ## Eviction
//!
//! Bounded by entry count (1024 by default). When the ring is full
//! the oldest entry is popped, so the daemon can outrun a slow
//! reattach indefinitely without OOM. Eviction means the journal
//! can no longer satisfy a `since_seq` older than the oldest seq
//! still in the ring — `replay_since` returns a `ReplayGap` signal
//! and the desktop falls back (today: full history reload from local
//! DB; 24r will wire this into the chat thread).

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::journal_store::JournalDiskWriter;

/// Default ring capacity. Sized for ~10 typical Claude turns of
/// streaming events (each turn ≈ 50–100 events between deltas,
/// tool calls, and the terminal `result`). Override via
/// `EventJournal::with_capacity` if profiling shows the right
/// number is different for a given workload.
pub const DEFAULT_CAPACITY: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalEntry {
    pub seq: u64,
    pub ts_ms: i64,
    pub payload: Value,
}

pub struct EventJournal {
    ring: VecDeque<JournalEntry>,
    /// Seq number for the next append (always `head_seq + 1`). Held
    /// outside the ring so eviction doesn't reset the counter.
    next_seq: u64,
    capacity: usize,
    /// Phase 24t: optional disk-backed mirror. When set, every
    /// successful in-memory append is also written to the on-disk
    /// JSONL file so the daemon can recover the history across
    /// restarts. A disk-write failure logs but does NOT abort the
    /// in-memory append — losing the durability story for one event
    /// is better than dropping a live event the desktop is waiting
    /// for.
    disk_writer: Option<JournalDiskWriter>,
}

impl std::fmt::Debug for EventJournal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventJournal")
            .field("ring_len", &self.ring.len())
            .field("next_seq", &self.next_seq)
            .field("capacity", &self.capacity)
            .field("disk_backed", &self.disk_writer.is_some())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaySnapshot {
    /// Entries the caller asked for, in seq order.
    pub entries: Vec<JournalEntry>,
    /// `Some(earliest_available)` when the caller's `since_seq`
    /// would have required entries the ring has evicted. The
    /// desktop interprets this as "your local DB is missing events
    /// — fall back to a full history reload or accept the gap".
    pub replay_gap: Option<u64>,
    /// Highest seq currently in the ring (or 0 when empty). The
    /// desktop stores this so a follow-up reattach knows where to
    /// resume.
    pub head_seq: u64,
}

impl Default for EventJournal {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }
}

impl EventJournal {
    pub fn with_capacity(capacity: usize) -> Self {
        // A zero-capacity ring would refuse every append. Clamp to
        // 1 to keep the contract simple — tests that want to
        // exercise eviction can use small but non-zero capacities.
        let capacity = capacity.max(1);
        Self {
            ring: VecDeque::with_capacity(capacity),
            next_seq: 1,
            capacity,
            disk_writer: None,
        }
    }

    /// Phase 24t: attach a disk-backed writer so every subsequent
    /// `append` mirrors to the on-disk JSONL file. Idempotent — a
    /// second call overwrites the prior writer (test-only convenience;
    /// production wires the writer once at session creation).
    pub fn with_disk_writer(mut self, writer: JournalDiskWriter) -> Self {
        self.disk_writer = Some(writer);
        self
    }

    /// Append `payload` with a fresh seq. Evicts the oldest entry
    /// when the ring is full. Returns the appended seq so the
    /// caller can include it on the wire alongside the event.
    pub fn append(&mut self, payload: Value) -> u64 {
        let seq = self.next_seq;
        self.next_seq = seq
            .checked_add(1)
            .expect("event journal seq overflow (2^64 events in one session)");
        if self.ring.len() >= self.capacity {
            self.ring.pop_front();
        }
        let entry = JournalEntry {
            seq,
            ts_ms: now_ms(),
            payload,
        };
        // Phase 24t: mirror to disk before pushing into the ring so
        // the on-disk order matches the in-memory order. A write
        // failure detaches the writer (defensive — repeated failures
        // would spam logs) but lets the in-memory append succeed.
        if let Some(writer) = self.disk_writer.as_mut() {
            if let Err(err) = writer.append(&entry) {
                tracing::warn!(
                    seq = entry.seq,
                    error = %format!("{err:#}"),
                    "journal: disk append failed; detaching disk mirror",
                );
                self.disk_writer = None;
            }
        }
        self.ring.push_back(entry);
        seq
    }

    /// Highest seq currently observed. 0 before the first append.
    pub fn head_seq(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }

    /// Phase 24t: consume the journal + return the disk path it was
    /// mirroring to, paired with the current `head_seq`. Used when
    /// the reader thread evicts a completed session into the
    /// `ended_sessions` map — we need the path to feed
    /// `read_journal_entries` on a future replay attach, and the
    /// head_seq for diagnostics. Returns `None` when there's no disk
    /// mirror (in-memory-only sessions don't survive the eviction).
    pub fn into_disk_path_and_head(self) -> Option<(u64, std::path::PathBuf)> {
        let head = self.head_seq();
        let writer = self.disk_writer?;
        Some((head, writer.into_path()))
    }

    /// Snapshot entries the caller asked for.
    ///
    /// `since_seq=None` means "give me everything currently in the
    /// ring". `since_seq=Some(n)` means "give me entries with
    /// `seq > n`"; if the ring no longer holds seq `n+1` (the
    /// caller missed events that have been evicted) the snapshot
    /// reports the gap so the caller can fall back.
    pub fn replay_since(&self, since_seq: Option<u64>) -> ReplaySnapshot {
        let head_seq = self.head_seq();
        let replay_gap = match (since_seq, self.ring.front()) {
            // Caller asked for entries newer than `n`. The smallest
            // seq still in the ring is `earliest.seq`. If
            // `earliest.seq > n + 1`, the entry at `n + 1` was
            // evicted — gap.
            (Some(n), Some(earliest)) if earliest.seq > n.saturating_add(1) => Some(earliest.seq),
            _ => None,
        };
        let cutoff = since_seq.unwrap_or(0);
        let entries = self
            .ring
            .iter()
            .filter(|e| e.seq > cutoff)
            .cloned()
            .collect();
        ReplaySnapshot {
            entries,
            replay_gap,
            head_seq,
        }
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.ring.len()
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(label: &str) -> Value {
        json!({ "type": "test", "label": label })
    }

    #[test]
    fn append_assigns_monotonic_seqs_starting_at_one() {
        let mut journal = EventJournal::default();
        assert_eq!(journal.append(payload("a")), 1);
        assert_eq!(journal.append(payload("b")), 2);
        assert_eq!(journal.append(payload("c")), 3);
    }

    #[test]
    fn head_seq_is_zero_before_any_append() {
        let journal = EventJournal::default();
        assert_eq!(journal.head_seq(), 0);
    }

    #[test]
    fn head_seq_tracks_last_appended() {
        let mut journal = EventJournal::default();
        for _ in 0..5 {
            journal.append(payload("x"));
        }
        assert_eq!(journal.head_seq(), 5);
    }

    #[test]
    fn replay_since_none_returns_full_ring() {
        let mut journal = EventJournal::default();
        for i in 0..3 {
            journal.append(payload(&format!("e{i}")));
        }
        let snap = journal.replay_since(None);
        assert_eq!(snap.entries.len(), 3);
        assert_eq!(snap.entries[0].seq, 1);
        assert_eq!(snap.entries[2].seq, 3);
        assert_eq!(snap.head_seq, 3);
        assert_eq!(snap.replay_gap, None);
    }

    #[test]
    fn replay_since_some_returns_only_newer_entries() {
        let mut journal = EventJournal::default();
        for i in 0..5 {
            journal.append(payload(&format!("e{i}")));
        }
        let snap = journal.replay_since(Some(2));
        let seqs: Vec<u64> = snap.entries.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![3, 4, 5]);
        assert_eq!(snap.replay_gap, None);
        assert_eq!(snap.head_seq, 5);
    }

    #[test]
    fn replay_since_zero_returns_everything_with_no_gap() {
        // `since_seq=Some(0)` is the explicit "I have nothing" form
        // (vs. `None` which means "give me whatever you have").
        // Both should return all entries with no gap, since seq 1
        // is the first ever appended.
        let mut journal = EventJournal::default();
        for i in 0..3 {
            journal.append(payload(&format!("e{i}")));
        }
        let snap = journal.replay_since(Some(0));
        assert_eq!(snap.entries.len(), 3);
        assert_eq!(snap.replay_gap, None);
    }

    #[test]
    fn ring_evicts_oldest_when_full() {
        let mut journal = EventJournal::with_capacity(3);
        for i in 0..5 {
            journal.append(payload(&format!("e{i}")));
        }
        assert_eq!(journal.len(), 3);
        // After 5 appends with cap 3, ring holds seqs 3, 4, 5.
        let snap = journal.replay_since(None);
        let seqs: Vec<u64> = snap.entries.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![3, 4, 5]);
        assert_eq!(snap.head_seq, 5);
    }

    #[test]
    fn replay_since_signals_gap_when_caller_seq_was_evicted() {
        // Caller saw seq 1; ring has evicted 1 and 2; replay starts
        // at 3. The gap field tells the caller they missed seq 2.
        let mut journal = EventJournal::with_capacity(3);
        for i in 0..5 {
            journal.append(payload(&format!("e{i}")));
        }
        // Ring contents: 3, 4, 5. Caller's since_seq=1 means they
        // want 2, 3, 4, 5. Seq 2 was evicted.
        let snap = journal.replay_since(Some(1));
        let seqs: Vec<u64> = snap.entries.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![3, 4, 5]);
        assert_eq!(
            snap.replay_gap,
            Some(3),
            "earliest available seq is 3; caller missed seq 2",
        );
    }

    #[test]
    fn replay_since_no_gap_when_caller_seq_is_one_less_than_earliest() {
        // Caller has seen seq 2; ring's earliest is seq 3. Caller
        // wants seq > 2 = [3, 4, 5]. No gap because the next
        // expected (3) is still in the ring.
        let mut journal = EventJournal::with_capacity(3);
        for i in 0..5 {
            journal.append(payload(&format!("e{i}")));
        }
        let snap = journal.replay_since(Some(2));
        assert_eq!(snap.replay_gap, None);
        let seqs: Vec<u64> = snap.entries.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![3, 4, 5]);
    }

    #[test]
    fn replay_since_future_seq_returns_empty_no_gap() {
        // Caller's last seen seq is ahead of the daemon's head —
        // the daemon must have restarted and reset its counter, or
        // the caller's tracker is corrupted. Either way: empty
        // entries, no gap, head_seq tells the caller where the
        // daemon currently is.
        let mut journal = EventJournal::default();
        for i in 0..3 {
            journal.append(payload(&format!("e{i}")));
        }
        let snap = journal.replay_since(Some(100));
        assert!(snap.entries.is_empty());
        assert_eq!(snap.replay_gap, None);
        assert_eq!(snap.head_seq, 3);
    }

    #[test]
    fn empty_journal_replay_since_some_reports_no_gap() {
        // No entries to gap against. The empty case should look
        // like "I have nothing", not "I lost data".
        let journal = EventJournal::default();
        let snap = journal.replay_since(Some(5));
        assert!(snap.entries.is_empty());
        assert_eq!(snap.replay_gap, None);
        assert_eq!(snap.head_seq, 0);
    }

    #[test]
    fn with_capacity_zero_clamps_to_one() {
        // A zero-capacity ring would refuse every append. Clamping
        // to 1 keeps the contract sane — every append succeeds.
        let mut journal = EventJournal::with_capacity(0);
        journal.append(payload("a"));
        journal.append(payload("b"));
        assert_eq!(journal.len(), 1);
        assert_eq!(journal.head_seq(), 2);
    }
}
