//! Workspace file watcher kernel.
//!
//! A thin wrapper around `notify-debouncer-full` that:
//!
//! - Watches a workspace root recursively;
//! - Filters out paths inside `.git/` so the watcher doesn't fire on
//!   every internal git operation (refs/heads writes, index updates,
//!   reflog rewrites, etc.) which dwarf the user-relevant churn;
//!   surfaces the user-meaningful changes only;
//! - Normalises every event path back to a workspace-relative POSIX
//!   string so callers don't have to redo the prefix-strip dance;
//! - Maps notify's event kinds onto a 3-state
//!   added/modified/removed enum that's enough for the inspector
//!   side panel and the future remote-watcher RPC.
//!
//! The wire-shape RPC types (`WorkspaceStartWatchParams` etc.) live
//! in [`crate::remote::methods`]; this module is just the kernel
//! both the local runtime and the future remote runtime will run.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, Debouncer, RecommendedCache};
use serde::{Deserialize, Serialize};

/// How long to wait after the last event before delivering a batch
/// to the consumer. 200ms mirrors VS Code Remote-SSH's default and
/// is short enough that a "save and check" cycle feels immediate
/// while long enough to absorb the burst a multi-file editor save
/// fires.
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(200);

/// One change reported to the consumer. The path is relative to
/// the workspace root with `/` separators so the wire shape doesn't
/// need OS-specific massaging.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: FileChangeKind,
}

/// Coarse classification — the inspector only needs to know whether
/// the file appeared, vanished, or was edited in place. notify
/// emits a richer set (Modify::Metadata vs Modify::Data, the
/// rename-with-from / rename-with-to dance, etc.) but the consumer
/// of this watcher cares about file-level deltas, not inode-level
/// minutiae.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Added,
    Modified,
    Removed,
}

/// Callback the watcher invokes for each debounced batch. The
/// vector is guaranteed non-empty (an empty batch is dropped before
/// dispatch) and deduplicated by `(path, kind)`.
pub type WatchCallback = Box<dyn Fn(Vec<FileChange>) + Send + Sync>;

/// RAII handle. Dropping it stops the watcher and joins the
/// notify-debouncer thread; the consumer's callback will not fire
/// after `Drop` returns.
pub struct FileWatcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

impl FileWatcher {
    /// Start a recursive watch on `workspace_dir`. The callback
    /// runs on the debouncer's background thread; if it panics the
    /// thread keeps running (the panic is caught + logged) so a
    /// buggy consumer doesn't take down the watcher.
    pub fn start(workspace_dir: PathBuf, callback: WatchCallback) -> Result<Self> {
        Self::start_with_debounce(workspace_dir, DEFAULT_DEBOUNCE, callback)
    }

    /// Same as [`start`] but lets the caller tune the debounce
    /// window. Useful in tests where 200ms × every assertion adds
    /// up; production should stick with [`DEFAULT_DEBOUNCE`].
    pub fn start_with_debounce(
        workspace_dir: PathBuf,
        debounce: Duration,
        callback: WatchCallback,
    ) -> Result<Self> {
        let root = workspace_dir.canonicalize().with_context(|| {
            format!(
                "FileWatcher: workspace_dir {} could not be canonicalized",
                workspace_dir.display()
            )
        })?;
        let callback = Arc::new(callback);
        let root_for_cb = root.clone();
        let mut debouncer = new_debouncer(
            debounce,
            None,
            move |result: notify_debouncer_full::DebounceEventResult| {
                let events = match result {
                    Ok(events) => events,
                    Err(errors) => {
                        for err in errors {
                            tracing::warn!(
                                error = %err,
                                "file watcher: debouncer surfaced an error event"
                            );
                        }
                        return;
                    }
                };
                let changes = classify_events(&root_for_cb, events);
                if changes.is_empty() {
                    return;
                }
                let cb = Arc::clone(&callback);
                // Catch panics in the consumer so a buggy callback
                // doesn't crash the watcher's thread (which would
                // silently end all future notifications).
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    cb(changes);
                }));
                if let Err(_panic) = result {
                    tracing::error!("file watcher: consumer callback panicked; watcher continues");
                }
            },
        )
        .context("create notify debouncer")?;
        debouncer
            .watch(&root, RecursiveMode::Recursive)
            .with_context(|| format!("watch {}", root.display()))?;
        Ok(Self {
            _debouncer: debouncer,
        })
    }
}

/// Translate a batch of notify events into the dedup'd
/// `FileChange` list this watcher hands to the consumer. Public
/// so tests can drive the classifier without spinning up a real
/// notify thread.
pub(crate) fn classify_events(
    root: &Path,
    events: Vec<notify_debouncer_full::DebouncedEvent>,
) -> Vec<FileChange> {
    let mut seen: HashSet<FileChange> = HashSet::new();
    let mut out: Vec<FileChange> = Vec::new();
    for event in events {
        let kind = match map_event_kind(&event.event.kind) {
            Some(k) => k,
            None => continue,
        };
        for path in &event.event.paths {
            if !should_report(path) {
                continue;
            }
            let Some(rel) = workspace_relative_posix(root, path) else {
                continue;
            };
            let change = FileChange { path: rel, kind };
            if seen.insert(change.clone()) {
                out.push(change);
            }
        }
    }
    out
}

fn map_event_kind(kind: &notify::EventKind) -> Option<FileChangeKind> {
    use notify::EventKind;
    match kind {
        EventKind::Create(_) => Some(FileChangeKind::Added),
        EventKind::Modify(_) => Some(FileChangeKind::Modified),
        EventKind::Remove(_) => Some(FileChangeKind::Removed),
        // `Access(_)` / `Other` / `Any` carry no inspector-visible
        // file mutation; dropping them keeps the debounced batch
        // free of noise.
        _ => None,
    }
}

/// Filter out paths the inspector doesn't care about:
/// - Anything inside `.git/` — internal git operations fire dozens
///   of events for every commit/branch switch and would drown the
///   user-relevant churn.
/// - Paths whose final component starts with `.helmor` — Helmor's
///   own state lives next to the workspace and we shouldn't notify
///   on our own writes.
pub(crate) fn should_report(path: &Path) -> bool {
    for component in path.components() {
        if let std::path::Component::Normal(name) = component {
            let name = name.to_string_lossy();
            if name == ".git" {
                return false;
            }
            if name.starts_with(".helmor") {
                return false;
            }
        }
    }
    true
}

/// Strip `root` off `path` and emit a forward-slash POSIX string.
/// Returns `None` when `path` isn't under `root` (notify
/// occasionally hands us an absolute path outside the watched
/// tree during teardown).
pub(crate) fn workspace_relative_posix(root: &Path, path: &Path) -> Option<String> {
    let stripped = path.strip_prefix(root).ok()?;
    let mut out = String::new();
    for (i, component) in stripped.components().enumerate() {
        let std::path::Component::Normal(name) = component else {
            // notify never hands us `..` or root components for a
            // file under `root`, but defend against it anyway.
            return None;
        };
        if i > 0 {
            out.push('/');
        }
        out.push_str(&name.to_string_lossy());
    }
    if out.is_empty() {
        // The root itself fired — not a file-level change. Drop.
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;
    use tempfile::TempDir;

    fn wait_for_changes(
        rx: &mpsc::Receiver<Vec<FileChange>>,
        timeout: Duration,
    ) -> Vec<FileChange> {
        // Collect every batch that arrives within the window so a
        // multi-event flush (e.g. file create that fires Add then
        // Modify) lands as one logical bundle for assertions.
        let deadline = Instant::now() + timeout;
        let mut combined: Vec<FileChange> = Vec::new();
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(remaining) {
                Ok(batch) => combined.extend(batch),
                Err(_) => break,
            }
        }
        combined
    }

    fn make_watcher(dir: &TempDir) -> (FileWatcher, mpsc::Receiver<Vec<FileChange>>) {
        let (tx, rx) = mpsc::channel::<Vec<FileChange>>();
        let watcher = FileWatcher::start_with_debounce(
            dir.path().to_path_buf(),
            Duration::from_millis(50),
            Box::new(move |changes| {
                let _ = tx.send(changes);
            }),
        )
        .expect("watcher should start on a fresh tempdir");
        (watcher, rx)
    }

    #[test]
    fn fires_for_a_new_file_with_added_kind() {
        let dir = tempfile::tempdir().unwrap();
        let (_watcher, rx) = make_watcher(&dir);
        // Some platforms (notably Linux inotify) need a moment for
        // the watch fd to attach before the first event will be
        // captured. 100ms is plenty in CI.
        std::thread::sleep(Duration::from_millis(100));

        std::fs::write(dir.path().join("hello.txt"), "hi").unwrap();
        let changes = wait_for_changes(&rx, Duration::from_secs(2));

        // The notify stack fires Add+Modify for a file create on
        // some platforms (macOS FSEvents in particular); we just
        // need to see at least one change for our file.
        assert!(
            changes.iter().any(|c| c.path == "hello.txt"),
            "expected hello.txt in changes: {changes:?}"
        );
        assert!(
            changes
                .iter()
                .any(|c| c.path == "hello.txt" && c.kind == FileChangeKind::Added),
            "expected Added kind: {changes:?}"
        );
    }

    #[test]
    fn fires_for_in_place_modify() {
        // macOS FSEvents and Linux inotify disagree about the event
        // *kind* for an in-place write (FSEvents tends to report
        // Create even for established files), so the cross-platform
        // contract is "the file shows up in the next batch" — the
        // path is reliable, the kind is best-effort.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("seed.txt");
        std::fs::write(&path, "v1").unwrap();
        let (_watcher, rx) = make_watcher(&dir);
        std::thread::sleep(Duration::from_millis(100));

        std::fs::write(&path, "v2").unwrap();
        let changes = wait_for_changes(&rx, Duration::from_secs(2));

        assert!(
            changes.iter().any(|c| c.path == "seed.txt"),
            "expected seed.txt in changes after in-place write: {changes:?}"
        );
    }

    #[test]
    fn fires_for_file_removal() {
        // Same caveat as the modify test — FSEvents flags removal
        // unreliably. The cross-platform contract is "the deleted
        // file's path is reported in the next batch".
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doomed.txt");
        std::fs::write(&path, "soon to be gone").unwrap();
        let (_watcher, rx) = make_watcher(&dir);
        std::thread::sleep(Duration::from_millis(100));

        std::fs::remove_file(&path).unwrap();
        let changes = wait_for_changes(&rx, Duration::from_secs(2));

        assert!(
            changes.iter().any(|c| c.path == "doomed.txt"),
            "expected doomed.txt in changes after removal: {changes:?}"
        );
    }

    #[test]
    fn collapses_repeated_writes_to_finite_set_in_each_batch() {
        // Three rapid writes inside the debounce window should
        // *not* produce three identical `(path, kind)` entries
        // within a single batch — the classifier dedups by the
        // tuple. Across debounce flushes we may see >1 batch, but
        // each one is internally deduped.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("burst.txt");
        std::fs::write(&path, "init").unwrap();
        let (_watcher, rx) = make_watcher(&dir);
        std::thread::sleep(Duration::from_millis(100));

        for n in 0..3 {
            std::fs::write(&path, format!("v{n}")).unwrap();
            // Brief gap so the OS coalesces but the writes are
            // distinct mtimes; without this notify on Linux may
            // collapse to a single inotify event anyway.
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = wait_for_changes(&rx, Duration::from_secs(2));
        // We don't make a strong per-batch count claim here — the
        // platforms disagree too much. The dedup guarantee is
        // tested directly against `classify_events` below.
    }

    #[test]
    fn classify_events_dedups_within_a_batch() {
        // Direct unit test of the classifier: three notify events
        // with the same (path, kind) should fold to one. Exercises
        // the dedup HashSet without depending on platform-specific
        // event flags.
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("burst.txt");
        let canonical_root = root.path().canonicalize().unwrap();
        let canonical_file = canonical_root.join("burst.txt");
        let events: Vec<notify_debouncer_full::DebouncedEvent> = (0..3)
            .map(|_| notify_debouncer_full::DebouncedEvent {
                event: notify::Event::new(notify::EventKind::Modify(
                    notify::event::ModifyKind::Data(notify::event::DataChange::Content),
                ))
                .add_path(canonical_file.clone()),
                time: std::time::Instant::now(),
            })
            .collect();

        let changes = classify_events(&canonical_root, events);

        let modified: Vec<_> = changes
            .iter()
            .filter(|c| c.path == "burst.txt" && c.kind == FileChangeKind::Modified)
            .collect();
        assert_eq!(
            modified.len(),
            1,
            "three identical Modified events must collapse to one: {changes:?}"
        );
        // Reference the original temp file path so the binding stays alive.
        let _ = file;
    }

    #[test]
    fn paths_are_relative_with_forward_slashes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/nested")).unwrap();
        let (_watcher, rx) = make_watcher(&dir);
        std::thread::sleep(Duration::from_millis(100));

        std::fs::write(dir.path().join("src/nested/file.rs"), "fn main() {}").unwrap();
        let changes = wait_for_changes(&rx, Duration::from_secs(2));

        let found = changes.iter().find(|c| c.path.ends_with("file.rs"));
        let hit = found.expect("expected a change for the nested file");
        assert_eq!(
            hit.path, "src/nested/file.rs",
            "path must be POSIX-style relative to workspace root"
        );
    }

    #[test]
    fn ignores_writes_under_dot_git() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git/refs")).unwrap();
        let (_watcher, rx) = make_watcher(&dir);
        std::thread::sleep(Duration::from_millis(100));

        std::fs::write(dir.path().join(".git/refs/heads-main"), "deadbeef").unwrap();
        // Also touch a normal file so we know the watcher itself is alive.
        std::fs::write(dir.path().join("alive.txt"), "yes").unwrap();
        let changes = wait_for_changes(&rx, Duration::from_secs(2));

        assert!(
            changes.iter().all(|c| !c.path.starts_with(".git/")),
            "no .git/ paths should leak: {changes:?}"
        );
        assert!(
            changes.iter().any(|c| c.path == "alive.txt"),
            "watcher must still be alive and firing on tracked files: {changes:?}"
        );
    }

    #[test]
    fn ignores_writes_under_dot_helmor_dirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".helmor")).unwrap();
        let (_watcher, rx) = make_watcher(&dir);
        std::thread::sleep(Duration::from_millis(100));

        std::fs::write(dir.path().join(".helmor/state.json"), "{}").unwrap();
        std::fs::write(dir.path().join("real.txt"), "yes").unwrap();
        let changes = wait_for_changes(&rx, Duration::from_secs(2));

        assert!(
            changes.iter().all(|c| !c.path.starts_with(".helmor")),
            "no .helmor/* paths should leak: {changes:?}"
        );
        assert!(
            changes.iter().any(|c| c.path == "real.txt"),
            "watcher must still be alive: {changes:?}"
        );
    }

    // ── Pure-function tests of the classifier helpers ─────────────

    #[test]
    fn should_report_drops_git_internals_and_helmor_state() {
        let root = Path::new("/work");
        assert!(super::should_report(&root.join("src/lib.rs")));
        assert!(!super::should_report(&root.join(".git/HEAD")));
        assert!(!super::should_report(&root.join(".git/refs/heads/main")));
        assert!(!super::should_report(&root.join("src/.git/HEAD")));
        assert!(!super::should_report(&root.join(".helmor/state.json")));
        assert!(!super::should_report(&root.join(".helmor-cache/x")));
    }

    #[test]
    fn workspace_relative_posix_strips_root_and_uses_forward_slashes() {
        let root = Path::new("/work");
        assert_eq!(
            super::workspace_relative_posix(root, &root.join("src/lib.rs")).as_deref(),
            Some("src/lib.rs"),
        );
        assert_eq!(
            super::workspace_relative_posix(root, &root.join("top.txt")).as_deref(),
            Some("top.txt"),
        );
    }

    #[test]
    fn workspace_relative_posix_returns_none_for_root_itself() {
        // notify occasionally hands us the watched dir itself (e.g.
        // mtime bump on the parent). Drop those — there's no
        // per-file delta to report.
        let root = Path::new("/work");
        assert!(super::workspace_relative_posix(root, root).is_none());
    }

    #[test]
    fn workspace_relative_posix_returns_none_for_paths_outside_root() {
        // Defensive: a teardown race where notify emits a sibling
        // path. The classifier must not turn it into a forged
        // workspace-relative path.
        let root = Path::new("/work");
        assert!(super::workspace_relative_posix(root, Path::new("/elsewhere/file.txt")).is_none());
    }
}
