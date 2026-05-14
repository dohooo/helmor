//! Serial cleanup queue for `.trash-*` directories.
//!
//! `remove_worktree` renames the workspace to a `.trash-*` sibling (O(1) on
//! the same filesystem) and hands the path to this queue. A single worker
//! thread drains it serially: `node_modules` / `target` deletes are IO-heavy,
//! so doing N in parallel just thrashes the disk and the OS page cache.
//!
//! On startup, sweep `<data_dir>/workspaces/<repo>/` for `.trash-*` left from
//! a prior run (worker killed mid-cleanup, OS crash, etc.) and re-enqueue.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        mpsc::{sync_channel, SyncSender, TrySendError},
        OnceLock,
    },
    thread,
    time::Instant,
};

const TRASH_PREFIX: &str = ".trash-";

/// Bounded so a runaway producer can't grow the queue without limit.
/// 1024 is well past any realistic burst (mass archive of every workspace).
const QUEUE_CAPACITY: usize = 1024;

static QUEUE: OnceLock<TrashCleanupQueue> = OnceLock::new();

/// Global handle. Lazily starts the worker on first use.
pub fn queue() -> &'static TrashCleanupQueue {
    QUEUE.get_or_init(TrashCleanupQueue::start)
}

pub struct TrashCleanupQueue {
    sender: SyncSender<PathBuf>,
}

impl TrashCleanupQueue {
    fn start() -> Self {
        let (tx, rx) = sync_channel::<PathBuf>(QUEUE_CAPACITY);
        thread::Builder::new()
            .name("helmor-trash-cleanup".into())
            .spawn(move || {
                while let Ok(path) = rx.recv() {
                    cleanup_path(&path);
                }
            })
            .expect("spawn helmor-trash-cleanup thread");
        Self { sender: tx }
    }

    /// Hand a `.trash-*` path to the worker. Non-blocking; falls back to a
    /// detached delete if the queue is full or the worker is gone (neither
    /// should happen in practice — log loudly).
    pub fn enqueue(&self, path: PathBuf) {
        match self.sender.try_send(path) {
            Ok(()) => {}
            Err(TrySendError::Full(path)) => {
                tracing::warn!(
                    path = %path.display(),
                    "trash queue full, detaching cleanup"
                );
                detached_cleanup(path);
            }
            Err(TrySendError::Disconnected(path)) => {
                tracing::error!(
                    path = %path.display(),
                    "trash worker disconnected, detaching cleanup"
                );
                detached_cleanup(path);
            }
        }
    }
}

/// Recursively delete a single trash directory, logging the outcome.
/// Pure — safe to call from any thread.
fn cleanup_path(path: &Path) {
    let started = Instant::now();
    match fs::remove_dir_all(path) {
        Ok(()) => tracing::debug!(
            path = %path.display(),
            elapsed_ms = started.elapsed().as_millis(),
            "trash dir cleaned",
        ),
        Err(error) => tracing::warn!(
            path = %path.display(),
            error = %error,
            "trash cleanup failed",
        ),
    }
}

fn detached_cleanup(path: PathBuf) {
    thread::Builder::new()
        .name("helmor-trash-detached".into())
        .spawn(move || cleanup_path(&path))
        .ok();
}

/// Find every `.trash-*` entry directly under `parent`. Pure — does not
/// touch the queue. Returns empty on missing-dir / read errors.
fn find_trash_dirs(parent: &Path) -> Vec<PathBuf> {
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %parent.display(),
                    error = %error,
                    "trash sweep: read_dir failed"
                );
            }
            return Vec::new();
        }
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(TRASH_PREFIX)
        })
        .map(|entry| entry.path())
        .collect()
}

/// Walk one level into `<workspaces_root>/<repo>/` and collect every
/// `.trash-*` found. Trash siblings live next to workspace dirs, so the
/// prefix never appears at the workspaces root itself.
fn find_trash_dirs_under_workspaces_root(workspaces_root: &Path) -> Vec<PathBuf> {
    let entries = match fs::read_dir(workspaces_root) {
        Ok(entries) => entries,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %workspaces_root.display(),
                    error = %error,
                    "trash sweep: read_dir workspaces root failed"
                );
            }
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(find_trash_dirs(&path));
        }
    }
    out
}

/// Enqueue every `.trash-*` entry directly under `parent`.
pub fn sweep_dir(parent: &Path) -> usize {
    let dirs = find_trash_dirs(parent);
    let q = queue();
    for path in &dirs {
        q.enqueue(path.clone());
    }
    dirs.len()
}

/// Sweep all repo subdirs under `<data_dir>/workspaces/`.
pub fn sweep_workspaces_root(workspaces_root: &Path) {
    let dirs = find_trash_dirs_under_workspaces_root(workspaces_root);
    if dirs.is_empty() {
        return;
    }
    let q = queue();
    for path in &dirs {
        q.enqueue(path.clone());
    }
    tracing::info!(
        path = %workspaces_root.display(),
        count = dirs.len(),
        "trash sweep enqueued leftover dirs"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn touch_dir(parent: &Path, name: &str) -> PathBuf {
        let p = parent.join(name);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn find_trash_dirs_picks_only_prefixed_entries() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();

        // Trash entries — should be picked.
        let t1 = touch_dir(root, ".trash-foo-123-456-0");
        let t2 = touch_dir(root, ".trash-bar-987-654-1");

        // Decoys — should be ignored.
        touch_dir(root, "regular-workspace");
        touch_dir(root, ".not-trash"); // dotfile but wrong prefix
        touch_dir(root, "trash-no-leading-dot"); // missing leading dot
        fs::write(root.join(".trash-stray-file"), b"").unwrap(); // file, not dir — still picked
                                                                 // (the worker handles non-dirs harmlessly via remove_dir_all err path)

        let mut found = find_trash_dirs(root);
        found.sort();
        let mut expected = vec![t1, t2, root.join(".trash-stray-file")];
        expected.sort();
        assert_eq!(found, expected);
    }

    #[test]
    fn find_trash_dirs_returns_empty_on_missing_parent() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        assert!(find_trash_dirs(&missing).is_empty());
    }

    #[test]
    fn find_trash_dirs_returns_empty_on_empty_dir() {
        let tmp = tempdir().unwrap();
        assert!(find_trash_dirs(tmp.path()).is_empty());
    }

    #[test]
    fn find_under_workspaces_root_descends_one_level() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();

        // workspaces_root/repo-a/
        let repo_a = touch_dir(root, "repo-a");
        let a1 = touch_dir(&repo_a, ".trash-x-1-1-0");
        let a2 = touch_dir(&repo_a, ".trash-y-2-2-0");
        touch_dir(&repo_a, "live-workspace");

        // workspaces_root/repo-b/
        let repo_b = touch_dir(root, "repo-b");
        let b1 = touch_dir(&repo_b, ".trash-z-3-3-0");
        // nested .trash one level too deep — should NOT be picked, sweep is one-level-only
        let nested = touch_dir(&repo_b, "live-workspace/nested");
        touch_dir(&nested, ".trash-too-deep");

        // a `.trash-*` directly at the workspaces root — also should NOT be picked
        // (the comment in the source says: "Trash siblings live next to workspace
        // dirs, so the prefix never appears at the workspaces root itself.")
        touch_dir(root, ".trash-misplaced");

        let mut found = find_trash_dirs_under_workspaces_root(root);
        found.sort();
        let mut expected = vec![a1, a2, b1];
        expected.sort();
        assert_eq!(found, expected);
    }

    #[test]
    fn find_under_workspaces_root_returns_empty_on_missing() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join("nope");
        assert!(find_trash_dirs_under_workspaces_root(&missing).is_empty());
    }

    #[test]
    fn cleanup_path_removes_directory_recursively() {
        let tmp = tempdir().unwrap();
        let target = touch_dir(tmp.path(), ".trash-cleanup-1");
        fs::write(target.join("a.txt"), b"hello").unwrap();
        fs::create_dir_all(target.join("nested/deeper")).unwrap();
        fs::write(target.join("nested/deeper/b.txt"), b"world").unwrap();

        cleanup_path(&target);

        assert!(!target.exists(), "cleanup_path must remove the directory");
    }

    #[test]
    fn cleanup_path_is_silent_on_missing_target() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join(".trash-never-existed");
        // Must not panic — failures are logged, not propagated.
        cleanup_path(&missing);
    }

    #[test]
    fn enqueue_then_worker_actually_deletes() {
        // Real end-to-end test against the global queue. Use a uniquely
        // named tmpdir so this can't collide with anything else.
        let tmp = tempdir().unwrap();
        let target = touch_dir(tmp.path(), ".trash-e2e-enqueue");
        fs::write(target.join("payload.txt"), b"x").unwrap();

        queue().enqueue(target.clone());

        // Worker is async — poll with a deadline. The actual delete is
        // microseconds for a tmpdir this size; 5s is paranoid headroom for
        // CI under heavy load.
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while target.exists() && Instant::now() < deadline {
            thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            !target.exists(),
            "worker should have deleted {}",
            target.display()
        );
    }
}
