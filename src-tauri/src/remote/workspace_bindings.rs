//! Per-workspace runtime binding — the lookup table from
//! `workspace_id` to the registered runtime that workspace's
//! operations should route through.
//!
//! Today no command actually *consumes* the binding yet (workspace
//! ops still go straight through the local runtime); this module
//! lands the persistence + management surface so a follow-up phase
//! can lift git / scripts / sidecar onto the seam without also
//! having to invent the binding shape.
//!
//! ## Why a separate file (not a workspaces-table column)?
//!
//! Adding `runtime_name` to the `workspaces` table would be a real
//! schema migration with snapshot-test fallout. The spike scope is
//! "demonstrate the shape", not "rewrite the workspace schema". A
//! hand-written JSON file under `<data_dir>/workspace_runtime_bindings.json`
//! matches the pattern phase 10 used for the registry's persisted
//! list. If we keep the feature it'll graduate into the schema; if
//! we don't, the file deletion is trivial.
//!
//! ## Lifecycle
//!
//! - `set(workspace_id, runtime_name)` overwrites any prior binding
//!   for the same workspace. Unknown workspace IDs aren't validated
//!   here — the registry doesn't know about workspaces, and
//!   forcing a registry lookup at set-time would break the "set the
//!   binding before the runtime is reachable" case (useful on first
//!   boot where the user wires up a remote then assigns).
//! - `clear(workspace_id)` is idempotent; missing entry is a no-op.
//! - `lookup(workspace_id)` returns `None` if no binding exists.
//!   Callers default to `"local"` themselves so a missing binding
//!   silently routes to the local runtime — the most conservative
//!   fallback.
//!
//! ## Concurrency
//!
//! The store sits behind a `Mutex<HashMap>`; the command layer
//! grabs the lock per operation. Persistence runs *outside* the
//! lock so a slow disk doesn't stall concurrent lookups. A failed
//! save logs + continues — the in-memory state stays authoritative
//! for the running session.

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Schema version on the persisted file. Bump when the on-disk
/// shape changes in a way the loader has to branch on.
const CURRENT_VERSION: u8 = 1;

/// Filename inside `<data_dir>`.
const FILE_NAME: &str = "workspace_runtime_bindings.json";

/// One persisted binding. Wire-friendly so the command layer can
/// pass these straight to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRuntimeBinding {
    pub workspace_id: String,
    pub runtime_name: String,
}

/// On-disk envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedBindings {
    version: u8,
    bindings: Vec<WorkspaceRuntimeBinding>,
}

impl PersistedBindings {
    fn new(bindings: Vec<WorkspaceRuntimeBinding>) -> Self {
        Self {
            version: CURRENT_VERSION,
            bindings,
        }
    }
    fn empty() -> Self {
        Self::new(Vec::new())
    }
}

/// In-memory binding store. Wrapped behind `tauri::State<Arc<...>>`
/// so the command layer reaches one shared instance per app.
pub struct WorkspaceRuntimeBindings {
    inner: Mutex<HashMap<String, String>>,
}

impl Default for WorkspaceRuntimeBindings {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceRuntimeBindings {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Seed the store from the disk file. Missing / corrupt file →
    /// empty list (warn log), never blocks boot.
    pub fn load_from_disk(data_dir: &Path) -> Self {
        let bindings = load(data_dir);
        let map = bindings
            .bindings
            .into_iter()
            .map(|b| (b.workspace_id, b.runtime_name))
            .collect();
        Self {
            inner: Mutex::new(map),
        }
    }

    /// Look up the binding for a workspace. `None` means the caller
    /// should fall back to the local runtime.
    pub fn lookup(&self, workspace_id: &str) -> Option<String> {
        let map = self
            .inner
            .lock()
            .expect("workspace bindings mutex poisoned");
        map.get(workspace_id).cloned()
    }

    /// Set the binding, overwriting any prior value. The caller is
    /// responsible for triggering the matching `save_to_disk` —
    /// the store doesn't write on every mutation because the
    /// command layer batches a single save after each command.
    pub fn set(&self, workspace_id: impl Into<String>, runtime_name: impl Into<String>) {
        let mut map = self
            .inner
            .lock()
            .expect("workspace bindings mutex poisoned");
        map.insert(workspace_id.into(), runtime_name.into());
    }

    /// Remove the binding. Returns `true` if an entry was removed,
    /// `false` if there was nothing to remove. The boolean is mostly
    /// useful for diagnostics — the command layer always considers
    /// a `clear` idempotent.
    pub fn clear(&self, workspace_id: &str) -> bool {
        let mut map = self
            .inner
            .lock()
            .expect("workspace bindings mutex poisoned");
        map.remove(workspace_id).is_some()
    }

    /// Snapshot of every binding, sorted by `workspace_id` so the
    /// frontend list is stable across reloads.
    pub fn list(&self) -> Vec<WorkspaceRuntimeBinding> {
        let map = self
            .inner
            .lock()
            .expect("workspace bindings mutex poisoned");
        let mut out: Vec<WorkspaceRuntimeBinding> = map
            .iter()
            .map(|(workspace_id, runtime_name)| WorkspaceRuntimeBinding {
                workspace_id: workspace_id.clone(),
                runtime_name: runtime_name.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.workspace_id.cmp(&b.workspace_id));
        out
    }

    /// Persist the current state to disk. Best-effort — failures
    /// log + continue so the running session isn't taken hostage by
    /// a disk hiccup.
    pub fn save_to_disk(&self, data_dir: &Path) {
        let snapshot = self.snapshot_persisted();
        save(data_dir, &snapshot);
    }

    fn snapshot_persisted(&self) -> PersistedBindings {
        let mut entries: Vec<WorkspaceRuntimeBinding> = {
            let map = self
                .inner
                .lock()
                .expect("workspace bindings mutex poisoned");
            map.iter()
                .map(|(workspace_id, runtime_name)| WorkspaceRuntimeBinding {
                    workspace_id: workspace_id.clone(),
                    runtime_name: runtime_name.clone(),
                })
                .collect()
        };
        entries.sort_by(|a, b| a.workspace_id.cmp(&b.workspace_id));
        PersistedBindings::new(entries)
    }
}

/// Path the persistence layer reads + writes.
pub fn file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

fn load(data_dir: &Path) -> PersistedBindings {
    let path = file_path(data_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(err) if err.kind() == ErrorKind::NotFound => return PersistedBindings::empty(),
        Err(err) => {
            tracing::warn!(
                error = %err,
                path = %path.display(),
                "remote-runner: failed to read workspace runtime bindings; starting empty"
            );
            return PersistedBindings::empty();
        }
    };
    match serde_json::from_str::<PersistedBindings>(&raw) {
        Ok(parsed) => parsed,
        Err(err) => {
            tracing::warn!(
                error = %err,
                path = %path.display(),
                "remote-runner: workspace runtime bindings file is malformed; starting empty"
            );
            PersistedBindings::empty()
        }
    }
}

fn save(data_dir: &Path, snapshot: &PersistedBindings) {
    if let Err(err) = save_inner(data_dir, snapshot) {
        tracing::warn!(
            error = %format!("{err:#}"),
            "remote-runner: failed to persist workspace runtime bindings; in-memory state is authoritative"
        );
    }
}

fn save_inner(data_dir: &Path, snapshot: &PersistedBindings) -> Result<()> {
    fs::create_dir_all(data_dir)
        .with_context(|| format!("create data dir {}", data_dir.display()))?;
    let final_path = file_path(data_dir);
    let tmp_path = final_path.with_extension("json.tmp");
    let serialised =
        serde_json::to_string_pretty(snapshot).context("serialise PersistedBindings to JSON")?;
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

    #[test]
    fn set_and_lookup_round_trip() {
        let bindings = WorkspaceRuntimeBindings::new();
        bindings.set("ws-1", "dev.box");
        assert_eq!(bindings.lookup("ws-1"), Some("dev.box".to_string()));
    }

    #[test]
    fn lookup_returns_none_for_unbound_workspace() {
        let bindings = WorkspaceRuntimeBindings::new();
        assert_eq!(bindings.lookup("never-bound"), None);
    }

    #[test]
    fn set_overwrites_prior_binding() {
        let bindings = WorkspaceRuntimeBindings::new();
        bindings.set("ws-1", "old.box");
        bindings.set("ws-1", "new.box");
        assert_eq!(bindings.lookup("ws-1"), Some("new.box".to_string()));
    }

    #[test]
    fn clear_returns_true_only_when_an_entry_existed() {
        let bindings = WorkspaceRuntimeBindings::new();
        bindings.set("ws-1", "dev.box");
        assert!(bindings.clear("ws-1"));
        assert!(!bindings.clear("ws-1"), "second clear should report no-op");
        assert!(!bindings.clear("never-existed"));
    }

    #[test]
    fn list_returns_sorted_snapshot() {
        let bindings = WorkspaceRuntimeBindings::new();
        bindings.set("z-ws", "z.box");
        bindings.set("a-ws", "a.box");
        bindings.set("m-ws", "m.box");
        let snapshot = bindings.list();
        let ids: Vec<&str> = snapshot.iter().map(|b| b.workspace_id.as_str()).collect();
        assert_eq!(ids, vec!["a-ws", "m-ws", "z-ws"]);
    }

    // ── persistence ────────────────────────────────────────────

    #[test]
    fn save_then_load_round_trips_bindings() {
        let d = dir();
        let bindings = WorkspaceRuntimeBindings::new();
        bindings.set("ws-1", "dev.box");
        bindings.set("ws-2", "stage");
        bindings.save_to_disk(d.path());

        let reloaded = WorkspaceRuntimeBindings::load_from_disk(d.path());
        assert_eq!(reloaded.lookup("ws-1"), Some("dev.box".to_string()));
        assert_eq!(reloaded.lookup("ws-2"), Some("stage".to_string()));
        assert_eq!(reloaded.list().len(), 2);
    }

    #[test]
    fn load_missing_file_returns_empty_store_without_error() {
        let d = dir();
        let bindings = WorkspaceRuntimeBindings::load_from_disk(d.path());
        assert_eq!(bindings.list().len(), 0);
    }

    #[test]
    fn load_with_malformed_file_returns_empty_store_without_panicking() {
        let d = dir();
        fs::write(file_path(d.path()), "{not json").unwrap();
        let bindings = WorkspaceRuntimeBindings::load_from_disk(d.path());
        assert_eq!(bindings.list().len(), 0);
    }

    #[test]
    fn save_is_atomic_via_tmp_rename() {
        let d = dir();
        let bindings = WorkspaceRuntimeBindings::new();
        bindings.set("ws-1", "dev.box");
        bindings.save_to_disk(d.path());
        let tmp = file_path(d.path()).with_extension("json.tmp");
        assert!(!tmp.exists(), "tmp file should be cleaned up by rename");
        assert!(file_path(d.path()).exists());
    }

    #[test]
    fn wire_format_uses_camel_case_keys() {
        let snapshot = PersistedBindings::new(vec![WorkspaceRuntimeBinding {
            workspace_id: "ws-1".into(),
            runtime_name: "dev.box".into(),
        }]);
        let wire = serde_json::to_string(&snapshot).unwrap();
        assert!(wire.contains("\"workspaceId\""));
        assert!(wire.contains("\"runtimeName\""));
        assert!(
            !wire.contains("workspace_id") && !wire.contains("runtime_name"),
            "snake_case leaked: {wire}"
        );
    }
}
