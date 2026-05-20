//! Track E4: daemon startup history for crash-loop detection.
//!
//! Each time the daemon starts it appends a timestamp (ms since
//! epoch) to `$HOME/.helmor/server/crash-history.json`. The
//! `runtime.metrics` RPC surfaces the recent entries so the desktop
//! can show a "remote daemon crashed N times in 5 min" warning when
//! the count exceeds an operator threshold.
//!
//! The file is tiny (a single JSON array) + bounded — only the last
//! [`MAX_ENTRIES`] timestamps are kept. Writes use atomic rename so a
//! daemon dying mid-write can't corrupt the file.
//!
//! "Crash" here is intentionally fuzzy — any startup counts. A clean
//! `--daemon` restart that wasn't preceded by a crash will still
//! bump the counter, which is fine for the warning UX (frequent
//! restarts for any reason are worth surfacing to the operator).

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};

/// How many startup entries we keep. 64 is far more than the 5-min
/// window needs but cheap to store + lets the desktop render
/// "started 12 times in the last hour" if it wants.
pub const MAX_ENTRIES: usize = 64;

const HISTORY_FILE: &str = "crash-history.json";

/// Resolve the on-disk path for the startup-history file.
pub fn history_path() -> Result<PathBuf> {
    Ok(super::super::daemon::default_daemon_dir()?.join(HISTORY_FILE))
}

/// Append the current time (ms) to the history file. Best-effort —
/// a read/write failure logs but doesn't bubble up (a daemon that
/// can't write its crash counter shouldn't fail to start).
pub fn record_startup() {
    let path = match history_path() {
        Ok(p) => p,
        Err(err) => {
            tracing::warn!(
                error = %format!("{err:#}"),
                "crash_history: resolve path failed; skipping startup record",
            );
            return;
        }
    };
    let now_ms = current_ms();
    let mut entries = read_entries(&path).unwrap_or_default();
    entries.push(now_ms);
    // Bound + dedupe-sort.
    entries.sort_unstable();
    if entries.len() > MAX_ENTRIES {
        let excess = entries.len() - MAX_ENTRIES;
        entries.drain(0..excess);
    }
    if let Err(err) = write_entries(&path, &entries) {
        tracing::warn!(
            error = %format!("{err:#}"),
            "crash_history: write failed; counter will be missing this start",
        );
    }
}

/// Snapshot startup timestamps within the last `window_ms`
/// milliseconds. Returned oldest-first. `Vec::new()` on read failure
/// — diagnostics shouldn't fail loud just because the history file
/// can't be read.
pub fn recent_starts_ms(window_ms: i64) -> Vec<i64> {
    let path = match history_path() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let entries = match read_entries(&path) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let cutoff = current_ms().saturating_sub(window_ms);
    entries.into_iter().filter(|ts| *ts >= cutoff).collect()
}

fn read_entries(path: &std::path::Path) -> Result<Vec<i64>> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err).with_context(|| format!("read {}", path.display())),
    };
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let entries: Vec<i64> =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    Ok(entries)
}

fn write_entries(path: &std::path::Path, entries: &[i64]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create dir {}", parent.display()))?;
    }
    // Atomic write via tempfile + rename so a crash mid-write can't
    // leave a half-formed JSON file behind.
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(entries).context("serialise crash history")?;
    fs::write(&tmp, &bytes).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, path)
        .with_context(|| format!("rename {} → {}", tmp.display(), path.display()))?;
    Ok(())
}

fn current_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialise tests because they fiddle with $HOME.
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_home(test: impl FnOnce(&std::path::Path)) {
        let _guard = HOME_LOCK.lock().unwrap();
        let prev = std::env::var("HOME").ok();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", dir.path());
        test(dir.path());
        match prev {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn record_startup_creates_file_and_appends_timestamp() {
        with_temp_home(|home| {
            record_startup();
            let path = history_path().unwrap();
            assert!(
                path.exists(),
                "history file at {} should exist",
                path.display()
            );
            let entries = read_entries(&path).unwrap();
            assert_eq!(entries.len(), 1);
            // Verify the file landed under $HOME/.helmor/server/.
            assert!(path.starts_with(home.join(".helmor/server")));
        });
    }

    #[test]
    fn recent_starts_filters_by_window() {
        with_temp_home(|_| {
            let path = history_path().unwrap();
            let now = current_ms();
            let entries = vec![
                now - 600_000, // 10 min ago — outside 5 min window
                now - 60_000,  // 1 min ago — inside
                now - 10_000,  // 10s ago — inside
            ];
            // Make sure the parent exists.
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            write_entries(&path, &entries).unwrap();
            let recent = recent_starts_ms(5 * 60 * 1000);
            assert_eq!(recent.len(), 2);
        });
    }

    #[test]
    fn entries_are_bounded_to_max_entries() {
        with_temp_home(|_| {
            for _ in 0..(MAX_ENTRIES + 10) {
                record_startup();
            }
            let path = history_path().unwrap();
            let entries = read_entries(&path).unwrap();
            assert_eq!(entries.len(), MAX_ENTRIES);
        });
    }
}
