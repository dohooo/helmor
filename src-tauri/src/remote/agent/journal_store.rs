//! Disk-backed persistence for the per-session event journal.
//!
//! Phase 24t: the in-memory ring buffer (`EventJournal`) is lost on
//! daemon restart, so a desktop reattaching post-crash sees nothing
//! older than whatever the live session has emitted since startup.
//! Mirroring every appended entry to an append-only JSONL file under
//! `$HOME/.helmor/server/journals/<request_id>.jsonl` lets the daemon
//! recover the full event history on startup and serve replay-only
//! attaches to sessions whose sidecar process is gone.
//!
//! ## File format
//!
//! One JSONL file per request_id. Each line is a serialized
//! [`JournalEntry`]: `{"seq":<u64>,"tsMs":<i64>,"payload":<event>}`.
//! camelCase field names because the journal entries flow back through
//! the same wire envelope the desktop already consumes.
//!
//! ## Durability
//!
//! `append` calls `File::write_all(line)` + `write_all("\n")` — two
//! POSIX writes per event. No `fsync` per event; the OS page cache
//! flushes on natural cadence. On a hard daemon crash the last event
//! line *may* be partial, but [`read_journal_entries`] tolerates a
//! trailing malformed line by stopping the scan there. The desktop's
//! `since_seq` cursor accepts a slightly-stale daemon state because
//! the next live event will exceed any persisted seq anyway.
//!
//! ## Concurrency
//!
//! One writer per file is the contract: only the daemon's reader
//! thread appends, single-threaded per session. The on-disk file
//! is opened on session creation and kept open through every append.
//! Recovery / replay readers open separate read-only handles; they
//! never collide with the writer's append handle.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::journal::JournalEntry;

/// Subdirectory under the daemon dir where per-session JSONL files
/// live. `$HOME/.helmor/server/journals/`.
pub const JOURNAL_SUBDIR: &str = "journals";

/// Default retention window for completed journal files. Files older
/// than this are dropped by [`sweep_expired_journals`] on daemon
/// startup. Override via the `HELMOR_JOURNAL_RETENTION_HOURS` env var.
pub const DEFAULT_RETENTION_HOURS: u64 = 24;

/// Owning handle for a session's on-disk journal file. Open for the
/// lifetime of the session — created on `agent.send`, dropped when the
/// reader thread evicts the entry on terminal. Closing the file (via
/// Drop) flushes any pending writes.
pub struct JournalDiskWriter {
    path: PathBuf,
    file: fs::File,
}

impl JournalDiskWriter {
    /// Open `path` for append, creating it if missing. Errors propagate
    /// up so the caller can decide whether to disable persistence for
    /// this session (a permissions / disk-full failure shouldn't kill
    /// the live event stream — see `EventJournal::with_disk_writer`).
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create journal dir {}", parent.display()))?;
        }
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("open journal file {}", path.display()))?;
        Ok(Self { path, file })
    }

    /// Append a single [`JournalEntry`] as a JSONL line. Best-effort
    /// crash safety: one `write_all` per line means a partial write
    /// at most truncates the trailing entry. The reader tolerates
    /// that.
    pub fn append(&mut self, entry: &JournalEntry) -> Result<()> {
        let line = serde_json::to_string(&JournalEntryOnDisk::from(entry))
            .context("serialise journal entry")?;
        self.file
            .write_all(line.as_bytes())
            .with_context(|| format!("append to {}", self.path.display()))?;
        self.file
            .write_all(b"\n")
            .with_context(|| format!("append newline to {}", self.path.display()))?;
        Ok(())
    }

    /// Consume the writer + return its path. Used by
    /// `EventJournal::into_disk_path_and_head` when a session
    /// transitions from `active` → `ended` so the ended-session
    /// entry can keep referencing the on-disk file.
    pub fn into_path(self) -> PathBuf {
        self.path
    }
}

/// Wire shape for an on-disk journal entry. Mirrors [`JournalEntry`]
/// but in camelCase so the format is consistent with the
/// `agent.event` notification envelope the rest of the stack uses.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalEntryOnDisk {
    seq: u64,
    ts_ms: i64,
    payload: Value,
}

impl From<&JournalEntry> for JournalEntryOnDisk {
    fn from(entry: &JournalEntry) -> Self {
        Self {
            seq: entry.seq,
            ts_ms: entry.ts_ms,
            payload: entry.payload.clone(),
        }
    }
}

impl From<JournalEntryOnDisk> for JournalEntry {
    fn from(on_disk: JournalEntryOnDisk) -> Self {
        Self {
            seq: on_disk.seq,
            ts_ms: on_disk.ts_ms,
            payload: on_disk.payload,
        }
    }
}

/// Read every entry from `path`. A trailing malformed line (from a
/// crash mid-append) stops the scan without erroring; everything
/// before that line is returned. Caller decides whether a partially-
/// recovered journal is fatal (today: never — the desktop's
/// `since_seq` plus `ON CONFLICT(id) DO NOTHING` absorbs duplicates).
pub fn read_journal_entries(path: &Path) -> Result<Vec<JournalEntry>> {
    let file = fs::File::open(path)
        .with_context(|| format!("open journal file for replay: {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let parsed: JournalEntryOnDisk = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                // Trailing partial line from a crash — stop here so
                // earlier entries still surface.
                tracing::debug!(
                    path = %path.display(),
                    "journal: stopping replay scan at malformed trailing line"
                );
                break;
            }
        };
        entries.push(parsed.into());
    }
    Ok(entries)
}

/// Summary metadata for a journal file the daemon discovered on
/// startup. Used to populate the "ended; replay-only" entries surfaced
/// by `agent.list` so an operator (or desktop) can still browse +
/// reattach to past conversations.
#[derive(Debug, Clone)]
pub struct RecoveredSession {
    pub request_id: String,
    pub helmor_session_id: Option<String>,
    pub provider: Option<String>,
    pub workspace_dir: Option<String>,
    pub started_at_ms: i64,
    pub last_event_ms: i64,
    pub last_seq: u64,
    pub path: PathBuf,
}

/// Scan every `*.jsonl` file in `dir` and return one
/// [`RecoveredSession`] per file. Files that fail to parse are
/// logged + skipped — a corrupted journal shouldn't block daemon
/// startup. Returns an empty vec when `dir` does not exist (fresh
/// daemon install).
pub fn scan_journal_dir(dir: &Path) -> Result<Vec<RecoveredSession>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut recovered = Vec::new();
    let read_dir =
        fs::read_dir(dir).with_context(|| format!("read journal dir {}", dir.display()))?;
    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                tracing::warn!(
                    dir = %dir.display(),
                    error = %err,
                    "journal: failed to read dir entry; skipping",
                );
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let request_id = match path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        {
            Some(id) if !id.is_empty() => id,
            _ => continue,
        };
        match summarise_journal_file(&path, request_id) {
            Ok(Some(summary)) => recovered.push(summary),
            Ok(None) => {} // empty file — skip
            Err(err) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %format!("{err:#}"),
                    "journal: failed to summarise file; skipping",
                );
            }
        }
    }
    Ok(recovered)
}

fn summarise_journal_file(path: &Path, request_id: String) -> Result<Option<RecoveredSession>> {
    let entries = read_journal_entries(path)?;
    if entries.is_empty() {
        return Ok(None);
    }
    let first = entries.first().expect("non-empty");
    let last = entries.last().expect("non-empty");
    // Pull metadata from any event that carries it. `system.init` is
    // the canonical source for `session_id`; provider comes from the
    // same envelope. Workspace dir is sniffed from the sidecar's
    // request echo (when present).
    let mut helmor_session_id: Option<String> = None;
    let mut provider: Option<String> = None;
    let mut workspace_dir: Option<String> = None;
    for entry in &entries {
        if helmor_session_id.is_none() {
            helmor_session_id = entry
                .payload
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if provider.is_none() {
            provider = entry
                .payload
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if workspace_dir.is_none() {
            workspace_dir = entry
                .payload
                .get("cwd")
                .or_else(|| entry.payload.get("workspace"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if helmor_session_id.is_some() && provider.is_some() && workspace_dir.is_some() {
            break;
        }
    }
    Ok(Some(RecoveredSession {
        request_id,
        helmor_session_id,
        provider,
        workspace_dir,
        started_at_ms: first.ts_ms,
        last_event_ms: last.ts_ms,
        last_seq: last.seq,
        path: path.to_path_buf(),
    }))
}

/// Drop journal files whose mtime is older than `retention`. Called
/// once on daemon startup so a long-running daemon doesn't accumulate
/// stale conversations indefinitely. Returns the count of files
/// removed for telemetry.
pub fn sweep_expired_journals(dir: &Path, retention: Duration) -> Result<usize> {
    if !dir.exists() {
        return Ok(0);
    }
    let now = SystemTime::now();
    let mut removed = 0_usize;
    let read_dir = fs::read_dir(dir)
        .with_context(|| format!("read journal dir for sweep {}", dir.display()))?;
    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime = match entry.metadata().and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let age = match now.duration_since(mtime) {
            Ok(a) => a,
            Err(_) => continue, // file mtime in the future — skip
        };
        if age >= retention {
            if let Err(err) = fs::remove_file(&path) {
                tracing::warn!(
                    path = %path.display(),
                    error = %err,
                    "journal: failed to sweep expired file",
                );
            } else {
                removed += 1;
                tracing::debug!(
                    path = %path.display(),
                    age_secs = age.as_secs(),
                    "journal: swept expired file",
                );
            }
        }
    }
    Ok(removed)
}

/// Read the retention window from the env, falling back to
/// [`DEFAULT_RETENTION_HOURS`]. Invalid values fall through to the
/// default with a warning so a typo doesn't accidentally disable
/// the sweep entirely.
pub fn retention_from_env() -> Duration {
    let hours = match std::env::var("HELMOR_JOURNAL_RETENTION_HOURS") {
        Ok(v) => v.parse::<u64>().unwrap_or_else(|_| {
            tracing::warn!(
                value = %v,
                default = DEFAULT_RETENTION_HOURS,
                "HELMOR_JOURNAL_RETENTION_HOURS is not a valid u64; using default"
            );
            DEFAULT_RETENTION_HOURS
        }),
        Err(_) => DEFAULT_RETENTION_HOURS,
    };
    Duration::from_secs(hours.saturating_mul(3600))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(seq: u64, ts_ms: i64, label: &str) -> JournalEntry {
        JournalEntry {
            seq,
            ts_ms,
            payload: json!({ "type": "test", "label": label }),
        }
    }

    #[test]
    fn writer_appends_jsonl_lines_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rid-1.jsonl");
        {
            let mut writer = JournalDiskWriter::open(path.clone()).unwrap();
            writer.append(&entry(1, 1000, "a")).unwrap();
            writer.append(&entry(2, 1001, "b")).unwrap();
            writer.append(&entry(3, 1002, "c")).unwrap();
        }
        let raw = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 3);
        // Decoded shape must round-trip via read_journal_entries.
        let entries = read_journal_entries(&path).unwrap();
        let seqs: Vec<u64> = entries.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
    }

    #[test]
    fn read_journal_entries_skips_trailing_partial_line() {
        // Simulate a crash mid-append: a valid line followed by a
        // partial line that fails to parse. The reader must stop at
        // the partial line without erroring + return the earlier
        // entries.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rid-crash.jsonl");
        {
            let mut writer = JournalDiskWriter::open(path.clone()).unwrap();
            writer.append(&entry(1, 1000, "ok")).unwrap();
        }
        // Append a malformed line directly.
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"seq\":2,\"tsMs\":1001,\"payload\"")
            .unwrap();
        drop(file);
        let entries = read_journal_entries(&path).unwrap();
        assert_eq!(entries.len(), 1, "should recover the one good entry");
        assert_eq!(entries[0].seq, 1);
    }

    #[test]
    fn scan_journal_dir_returns_empty_when_dir_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert_eq!(scan_journal_dir(&missing).unwrap().len(), 0);
    }

    #[test]
    fn scan_journal_dir_recovers_metadata_per_file() {
        let dir = tempfile::tempdir().unwrap();
        // Session A: has system.init, provider, workspace.
        let path_a = dir.path().join("rid-A.jsonl");
        {
            let mut writer = JournalDiskWriter::open(path_a.clone()).unwrap();
            writer
                .append(&JournalEntry {
                    seq: 1,
                    ts_ms: 5_000,
                    payload: json!({
                        "type": "system",
                        "session_id": "hs-A",
                        "provider": "claude",
                        "cwd": "/srv/A",
                    }),
                })
                .unwrap();
            writer
                .append(&JournalEntry {
                    seq: 2,
                    ts_ms: 6_000,
                    payload: json!({ "type": "assistant" }),
                })
                .unwrap();
        }
        // Session B: no metadata events — recovery returns Nones for
        // those fields but still surfaces the request_id.
        let path_b = dir.path().join("rid-B.jsonl");
        {
            let mut writer = JournalDiskWriter::open(path_b.clone()).unwrap();
            writer
                .append(&JournalEntry {
                    seq: 1,
                    ts_ms: 7_000,
                    payload: json!({ "type": "delta" }),
                })
                .unwrap();
        }
        // Empty file: skipped entirely (no entries → no summary).
        let path_c = dir.path().join("rid-C.jsonl");
        fs::write(&path_c, b"").unwrap();
        // Non-JSONL file: ignored.
        let path_d = dir.path().join("notes.txt");
        fs::write(&path_d, b"this is not a journal").unwrap();

        let mut recovered = scan_journal_dir(dir.path()).unwrap();
        recovered.sort_by(|a, b| a.request_id.cmp(&b.request_id));
        assert_eq!(recovered.len(), 2, "expected only A + B, got {recovered:?}");

        assert_eq!(recovered[0].request_id, "rid-A");
        assert_eq!(recovered[0].helmor_session_id.as_deref(), Some("hs-A"));
        assert_eq!(recovered[0].provider.as_deref(), Some("claude"));
        assert_eq!(recovered[0].workspace_dir.as_deref(), Some("/srv/A"));
        assert_eq!(recovered[0].last_seq, 2);
        assert_eq!(recovered[0].started_at_ms, 5_000);
        assert_eq!(recovered[0].last_event_ms, 6_000);

        assert_eq!(recovered[1].request_id, "rid-B");
        assert_eq!(recovered[1].helmor_session_id, None);
        assert_eq!(recovered[1].last_seq, 1);
    }

    #[test]
    fn sweep_expired_journals_drops_only_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let fresh = dir.path().join("rid-fresh.jsonl");
        let stale = dir.path().join("rid-stale.jsonl");
        // Make a fresh file (its mtime defaults to now).
        fs::write(&fresh, b"").unwrap();
        // Make a stale file + back-date its mtime by 48 hours via
        // `File::set_modified` (stable since 1.75 — avoids pulling
        // in the `filetime` crate just for tests).
        fs::write(&stale, b"").unwrap();
        let old = SystemTime::now() - Duration::from_secs(48 * 3600);
        let stale_file = fs::OpenOptions::new().write(true).open(&stale).unwrap();
        stale_file.set_modified(old).unwrap();
        drop(stale_file);

        let removed = sweep_expired_journals(dir.path(), Duration::from_secs(24 * 3600)).unwrap();
        assert_eq!(removed, 1, "expected exactly the stale file to be removed");
        assert!(fresh.exists(), "fresh file must survive the sweep");
        assert!(!stale.exists(), "stale file must be removed");
    }

    #[test]
    fn retention_from_env_uses_default_when_unset() {
        std::env::remove_var("HELMOR_JOURNAL_RETENTION_HOURS");
        assert_eq!(
            retention_from_env(),
            Duration::from_secs(DEFAULT_RETENTION_HOURS * 3600),
        );
    }
}
