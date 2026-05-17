//! Desktop-side persistence of "terminals this desktop opened".
//!
//! Phase 19b made server-side PTYs survive client disconnect; what
//! 19c does on top is *remember which terminals belong to this
//! desktop instance*. When the user reopens Helmor and reconnects
//! to a remote, the dev panel can show "you opened 3 terminals
//! last time, all still running — click to reattach".
//!
//! The store is intentionally a sidecar JSON at
//! `<data_dir>/owned_terminals.json`, mirroring the
//! `remote_runtimes.json` + `workspace_runtime_bindings.json`
//! pattern. We never gate boot on the file — corrupt content
//! degrades to empty so a bad write can't lock the user out.
//!
//! ## What "owned" actually means
//!
//! The desktop persists `(runtime_name, terminal_id)` pairs at
//! `terminal.open` time and removes them on `terminal.close`. The
//! server doesn't know about ownership — `terminal.list` returns
//! every live session, ours or not. The dev panel uses the
//! owned-set as a hint: matching IDs render as "your session"
//! (with a Reattach button), others as "other sessions" (with
//! an Attach affordance for the curious).
//!
//! ## What happens on a mismatch
//!
//! - **Owned but not on server**: the daemon was restarted, the
//!   shell exited on its own, or someone killed the process. The
//!   stale entry is harvested next time we successfully list +
//!   reconcile.
//! - **On server but not owned**: shows up under "other sessions"
//!   so the user can still reattach. Attaching adds it to the
//!   owned set (we now know it).
//!
//! Neither shape is fatal; both reconcile silently.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Schema version. Bumped if the on-disk shape ever changes in a
/// way the loader has to branch on.
const CURRENT_VERSION: u8 = 1;

/// Filename under `<data_dir>`. Centralised so tests can hand a
/// tempdir to [`file_path`] for isolation.
const FILE_NAME: &str = "owned_terminals.json";

/// One row in the persisted file. The whole struct is wire-shape:
/// what we serialise IS what loads back. `openedAtMs` is the
/// client-side clock (millis epoch); used so the dev panel can
/// sort "most recent first" without round-tripping to the remote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedTerminalEntry {
    pub runtime_name: String,
    pub terminal_id: String,
    pub opened_at_ms: i64,
}

/// On-disk body. The shape stays versioned so we can change it
/// later without breaking old installs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedOwnedTerminals {
    pub version: u8,
    pub owned: Vec<OwnedTerminalEntry>,
}

impl PersistedOwnedTerminals {
    pub fn new(owned: Vec<OwnedTerminalEntry>) -> Self {
        Self {
            version: CURRENT_VERSION,
            owned,
        }
    }

    pub fn empty() -> Self {
        Self::new(Vec::new())
    }
}

/// Process-wide registry of terminals the desktop has opened. Held
/// inside `Arc` behind `tauri::State` so the open / close / attach
/// command paths can poke at it.
///
/// Internal shape is `runtime_name → set<terminal_id>` — we don't
/// need full per-terminal metadata in memory at runtime, only the
/// "is this id ours?" predicate the dev panel needs. The
/// `opened_at_ms` field exists for the disk format (so a fresh
/// dev-panel render can sort) but isn't surfaced through the
/// in-memory API; callers that want it read the disk file.
#[derive(Default)]
pub struct OwnedTerminals {
    inner: RwLock<HashMap<String, HashSet<String>>>,
}

impl OwnedTerminals {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hydrate from disk on app boot. Missing file → empty (fresh
    /// install), corrupt file → empty + warn log (don't refuse to
    /// boot over a malformed sidecar).
    pub fn load_from_disk(data_dir: &Path) -> Self {
        let persisted = load(data_dir);
        let mut by_runtime: HashMap<String, HashSet<String>> = HashMap::new();
        for entry in persisted.owned {
            by_runtime
                .entry(entry.runtime_name)
                .or_default()
                .insert(entry.terminal_id);
        }
        Self {
            inner: RwLock::new(by_runtime),
        }
    }

    /// Record a new terminal as owned. Returns `true` if this was
    /// a fresh insert (i.e. the (runtime, id) pair wasn't already
    /// in the set). Caller is responsible for triggering the disk
    /// save after — kept off this method so write-batching is
    /// possible later.
    pub fn insert(&self, runtime_name: &str, terminal_id: &str) -> bool {
        let mut guard = self.inner.write().expect("owned_terminals rwlock poisoned");
        guard
            .entry(runtime_name.to_string())
            .or_default()
            .insert(terminal_id.to_string())
    }

    /// Forget a terminal. Returns `true` iff the entry existed. No
    /// disk save inside — caller responsibility.
    pub fn remove(&self, runtime_name: &str, terminal_id: &str) -> bool {
        let mut guard = self.inner.write().expect("owned_terminals rwlock poisoned");
        let Some(set) = guard.get_mut(runtime_name) else {
            return false;
        };
        let removed = set.remove(terminal_id);
        if set.is_empty() {
            guard.remove(runtime_name);
        }
        removed
    }

    /// Drop every owned id for a runtime. Used when the user
    /// disconnects the remote — the bindings to its terminals
    /// become meaningless since the daemon dies with the SSH
    /// session. (For the spike's terminology: a disconnect is a
    /// user-initiated severing of the registry entry, not a
    /// liveness blip; phase 9's tombstone path doesn't trigger
    /// this clear.)
    pub fn clear_runtime(&self, runtime_name: &str) {
        let mut guard = self.inner.write().expect("owned_terminals rwlock poisoned");
        guard.remove(runtime_name);
    }

    /// Snapshot the owned id set for a runtime. Returns an empty
    /// set (not an `Option`) so callers always get an iterable
    /// without special-casing "no entries".
    pub fn list_for_runtime(&self, runtime_name: &str) -> HashSet<String> {
        let guard = self.inner.read().expect("owned_terminals rwlock poisoned");
        guard.get(runtime_name).cloned().unwrap_or_default()
    }

    /// Flatten the in-memory map into a `PersistedOwnedTerminals`
    /// ready for disk write. `opened_at_ms` is filled in with the
    /// current clock — we don't track per-entry open times in
    /// memory (the dev panel sorts by server-side `opened_at_ms`
    /// from `terminal.list`, not ours). This means a save after a
    /// boot+reload rewrites all `opened_at_ms` to "now", which is
    /// fine for the spike — the field's only use is "best-effort
    /// recency hint when the server is unreachable".
    pub fn snapshot_for_disk(&self) -> PersistedOwnedTerminals {
        let guard = self.inner.read().expect("owned_terminals rwlock poisoned");
        let now = chrono::Utc::now().timestamp_millis();
        let mut owned: Vec<OwnedTerminalEntry> = Vec::new();
        for (runtime_name, ids) in guard.iter() {
            for terminal_id in ids {
                owned.push(OwnedTerminalEntry {
                    runtime_name: runtime_name.clone(),
                    terminal_id: terminal_id.clone(),
                    opened_at_ms: now,
                });
            }
        }
        owned.sort_by(|a, b| {
            a.runtime_name
                .cmp(&b.runtime_name)
                .then_with(|| a.terminal_id.cmp(&b.terminal_id))
        });
        PersistedOwnedTerminals::new(owned)
    }

    /// Convenience: snapshot + write. Best-effort — failures log
    /// but don't propagate (mirrors `persistence::save`).
    pub fn save_to_disk(&self, data_dir: &Path) {
        let snapshot = self.snapshot_for_disk();
        save(data_dir, &snapshot);
    }
}

/// File path under `<data_dir>` — public so tests and callers
/// share the canonical location.
pub fn file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// Load the persisted file. Missing or unreadable → empty list,
/// no error.
pub fn load(data_dir: &Path) -> PersistedOwnedTerminals {
    let path = file_path(data_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return PersistedOwnedTerminals::empty();
        }
        Err(err) => {
            tracing::warn!(
                error = %err,
                path = %path.display(),
                "owned-terminals: failed to read; starting with empty list"
            );
            return PersistedOwnedTerminals::empty();
        }
    };
    match serde_json::from_str::<PersistedOwnedTerminals>(&raw) {
        Ok(parsed) => parsed,
        Err(err) => {
            tracing::warn!(
                error = %err,
                path = %path.display(),
                "owned-terminals: file is malformed; starting with empty list"
            );
            PersistedOwnedTerminals::empty()
        }
    }
}

/// Atomically rewrite via `.tmp + rename`. Same shape as
/// `persistence::save` so a crash mid-write leaves the previous
/// file intact.
pub fn save(data_dir: &Path, snapshot: &PersistedOwnedTerminals) {
    if let Err(err) = save_inner(data_dir, snapshot) {
        tracing::warn!(
            error = %format!("{err:#}"),
            "owned-terminals: failed to persist; in-memory state is still authoritative"
        );
    }
}

fn save_inner(data_dir: &Path, snapshot: &PersistedOwnedTerminals) -> Result<()> {
    fs::create_dir_all(data_dir)
        .with_context(|| format!("create data dir {}", data_dir.display()))?;
    let final_path = file_path(data_dir);
    let tmp_path = final_path.with_extension("json.tmp");
    let serialised = serde_json::to_string_pretty(snapshot)
        .context("serialise PersistedOwnedTerminals to JSON")?;
    fs::write(&tmp_path, serialised).with_context(|| format!("write {}", tmp_path.display()))?;
    fs::rename(&tmp_path, &final_path)
        .with_context(|| format!("rename {} → {}", tmp_path.display(), final_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn dir() -> TempDir {
        TempDir::new().unwrap()
    }

    // ── on-disk format ──────────────────────────────────────────

    #[test]
    fn load_missing_file_returns_empty_without_error() {
        let d = dir();
        let loaded = load(d.path());
        assert_eq!(loaded.version, CURRENT_VERSION);
        assert!(loaded.owned.is_empty());
    }

    #[test]
    fn save_then_load_round_trips_entries() {
        let d = dir();
        let snapshot = PersistedOwnedTerminals::new(vec![
            OwnedTerminalEntry {
                runtime_name: "dev.box".into(),
                terminal_id: "t-1".into(),
                opened_at_ms: 1_700_000_000_000,
            },
            OwnedTerminalEntry {
                runtime_name: "stage".into(),
                terminal_id: "t-7".into(),
                opened_at_ms: 1_700_000_001_000,
            },
        ]);
        save(d.path(), &snapshot);
        let loaded = load(d.path());
        assert_eq!(loaded, snapshot);
    }

    #[test]
    fn save_is_atomic_via_tmp_rename() {
        let d = dir();
        save(d.path(), &PersistedOwnedTerminals::empty());
        let tmp = file_path(d.path()).with_extension("json.tmp");
        assert!(!tmp.exists(), "tmp should be cleaned up by rename");
        assert!(file_path(d.path()).exists());
    }

    #[test]
    fn load_with_malformed_file_returns_empty_and_does_not_panic() {
        let d = dir();
        fs::write(file_path(d.path()), "{not valid json").unwrap();
        let loaded = load(d.path());
        assert!(loaded.owned.is_empty());
    }

    #[test]
    fn wire_format_uses_camel_case_keys() {
        let snapshot = PersistedOwnedTerminals::new(vec![OwnedTerminalEntry {
            runtime_name: "x".into(),
            terminal_id: "y".into(),
            opened_at_ms: 1,
        }]);
        let wire = serde_json::to_string(&snapshot).unwrap();
        assert!(wire.contains("\"runtimeName\""));
        assert!(wire.contains("\"terminalId\""));
        assert!(wire.contains("\"openedAtMs\""));
        assert!(!wire.contains('_'), "snake_case leaked: {wire}");
    }

    // ── OwnedTerminals in-memory API ────────────────────────────

    #[test]
    fn fresh_owned_terminals_lists_empty_set_for_any_runtime() {
        let owned = OwnedTerminals::new();
        assert!(owned.list_for_runtime("dev.box").is_empty());
    }

    #[test]
    fn insert_returns_true_for_new_and_false_for_duplicate() {
        let owned = OwnedTerminals::new();
        assert!(owned.insert("dev.box", "t-1"));
        assert!(
            !owned.insert("dev.box", "t-1"),
            "duplicate insert should report false"
        );
        // Different terminal id on same runtime — that's fresh.
        assert!(owned.insert("dev.box", "t-2"));
    }

    #[test]
    fn remove_returns_true_iff_entry_existed() {
        let owned = OwnedTerminals::new();
        owned.insert("dev.box", "t-1");
        assert!(owned.remove("dev.box", "t-1"));
        assert!(!owned.remove("dev.box", "t-1"), "second remove is a noop");
        assert!(!owned.remove("never", "t-1"), "unknown runtime is a noop");
    }

    #[test]
    fn list_for_runtime_returns_exact_set() {
        let owned = OwnedTerminals::new();
        owned.insert("dev.box", "t-1");
        owned.insert("dev.box", "t-2");
        owned.insert("stage", "t-9");
        let ids = owned.list_for_runtime("dev.box");
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("t-1"));
        assert!(ids.contains("t-2"));
        // Other runtime — different set.
        let ids = owned.list_for_runtime("stage");
        assert_eq!(ids.len(), 1);
        assert!(ids.contains("t-9"));
    }

    #[test]
    fn clear_runtime_drops_only_its_ids() {
        let owned = OwnedTerminals::new();
        owned.insert("dev.box", "t-1");
        owned.insert("dev.box", "t-2");
        owned.insert("stage", "t-9");
        owned.clear_runtime("dev.box");
        assert!(owned.list_for_runtime("dev.box").is_empty());
        // Other runtime untouched.
        assert!(owned.list_for_runtime("stage").contains("t-9"));
    }

    #[test]
    fn empty_runtime_entry_collapses_after_last_remove() {
        // Stops the map growing forever as terminals come and go.
        let owned = OwnedTerminals::new();
        owned.insert("dev.box", "t-1");
        owned.remove("dev.box", "t-1");
        // Internal invariant: no leftover empty HashSet.
        let guard = owned.inner.read().unwrap();
        assert!(
            !guard.contains_key("dev.box"),
            "empty set should have been pruned"
        );
    }

    // ── round-trip through disk ────────────────────────────────

    #[test]
    fn load_from_disk_hydrates_in_memory_state() {
        let d = dir();
        save(
            d.path(),
            &PersistedOwnedTerminals::new(vec![
                OwnedTerminalEntry {
                    runtime_name: "dev.box".into(),
                    terminal_id: "t-1".into(),
                    opened_at_ms: 1,
                },
                OwnedTerminalEntry {
                    runtime_name: "dev.box".into(),
                    terminal_id: "t-2".into(),
                    opened_at_ms: 2,
                },
                OwnedTerminalEntry {
                    runtime_name: "stage".into(),
                    terminal_id: "t-9".into(),
                    opened_at_ms: 3,
                },
            ]),
        );
        let owned = OwnedTerminals::load_from_disk(d.path());
        let dev_set = owned.list_for_runtime("dev.box");
        assert_eq!(dev_set.len(), 2);
        assert!(dev_set.contains("t-1"));
        assert!(dev_set.contains("t-2"));
        assert_eq!(owned.list_for_runtime("stage").len(), 1);
    }

    #[test]
    fn snapshot_for_disk_emits_stable_sorted_entries() {
        let owned = OwnedTerminals::new();
        owned.insert("dev.box", "t-2");
        owned.insert("dev.box", "t-1");
        owned.insert("stage", "t-3");
        let snapshot = owned.snapshot_for_disk();
        // The file order is `runtime_name asc, terminal_id asc`
        // so diffs across boots are minimal.
        let pairs: Vec<(String, String)> = snapshot
            .owned
            .iter()
            .map(|e| (e.runtime_name.clone(), e.terminal_id.clone()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("dev.box".to_string(), "t-1".to_string()),
                ("dev.box".to_string(), "t-2".to_string()),
                ("stage".to_string(), "t-3".to_string()),
            ]
        );
    }

    #[test]
    fn save_to_disk_then_reload_round_trips_state() {
        let d = dir();
        let owned = OwnedTerminals::new();
        owned.insert("dev.box", "t-1");
        owned.insert("dev.box", "t-2");
        owned.save_to_disk(d.path());

        let reloaded = OwnedTerminals::load_from_disk(d.path());
        let ids = reloaded.list_for_runtime("dev.box");
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("t-1"));
        assert!(ids.contains("t-2"));
    }
}
