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
                    let started = Instant::now();
                    match fs::remove_dir_all(&path) {
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

fn detached_cleanup(path: PathBuf) {
    thread::Builder::new()
        .name("helmor-trash-detached".into())
        .spawn(move || {
            if let Err(error) = fs::remove_dir_all(&path) {
                tracing::warn!(
                    path = %path.display(),
                    error = %error,
                    "detached trash cleanup failed"
                );
            }
        })
        .ok();
}

/// Enqueue every `.trash-*` entry directly under `parent`.
pub fn sweep_dir(parent: &Path) -> usize {
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
            return 0;
        }
    };
    let q = queue();
    let mut count = 0;
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(TRASH_PREFIX)
        {
            q.enqueue(entry.path());
            count += 1;
        }
    }
    count
}

/// Walk one level into `<workspaces_root>/<repo>/` and sweep each repo dir.
/// Trash siblings live next to workspace dirs, so the prefix never appears
/// at the workspaces root itself.
pub fn sweep_workspaces_root(workspaces_root: &Path) {
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
            return;
        }
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total += sweep_dir(&path);
        }
    }
    if total > 0 {
        tracing::info!(
            path = %workspaces_root.display(),
            count = total,
            "trash sweep enqueued leftover dirs"
        );
    }
}
