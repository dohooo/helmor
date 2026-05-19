//! Server-side workspace file-watch registry.
//!
//! Parallel structure to [`super::terminal::RemoteTerminalState`] and
//! [`super::agent::RemoteAgentState`]: per-connection state that owns
//! the live [`FileWatcher`] instances, keyed by the client-chosen
//! `watch_id`. Each callback batch is wrapped into a
//! [`WorkspaceFileEventNotification`] and pushed up the pipe via the
//! supplied [`super::server::Notifier`].
//!
//! ## Scope
//!
//! Phase 24g wires the daemon side end-to-end:
//! - `start_watch` registers a watcher whose callback emits
//!   `workspace.fileEvent` notifications.
//! - `stop_watch` drops the watcher (RAII) so its background thread
//!   exits + no further events flow.
//! - Dropping the state drops every active watcher.
//!
//! The desktop-side `RpcClient::subscribe_workspace_file_events` +
//! React Query cache invalidation glue is a follow-on slice. This
//! file ships the daemon kernel + full unit-test coverage so future
//! wiring is a single switch.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};

use super::methods::{
    WorkspaceFileEventNotification, WorkspaceStartWatchParams, WorkspaceStartWatchResult,
    WorkspaceStopWatchParams, WorkspaceStopWatchResult, WORKSPACE_FILE_EVENT_METHOD,
};
use super::server::Notifier;
use crate::workspace::files::FileWatcher;

/// Daemon-side registry of live workspace file watchers. Attached
/// to [`super::server::ServerContext`] so the dispatcher handlers
/// can reach it without going through the runtime trait — same
/// pattern terminals + agent sessions use.
#[derive(Default)]
pub struct RemoteWatchState {
    /// `watch_id` → live watcher. Drop semantics on `FileWatcher`
    /// tear down the notify-debouncer thread, so removing an entry
    /// stops every subsequent callback automatically.
    watchers: Mutex<HashMap<String, FileWatcher>>,
}

impl RemoteWatchState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new file watcher under `watch_id`. The callback
    /// emits `workspace.fileEvent` notifications via `notifier` for
    /// every debounced batch.
    ///
    /// Rejects duplicates: a client that wants to re-watch the same
    /// path must stop the existing watcher first. Empty watch_ids
    /// and empty workspace_dirs are bailed before we touch the
    /// filesystem.
    pub fn start_watch(
        &self,
        params: WorkspaceStartWatchParams,
        notifier: Arc<dyn Notifier>,
    ) -> Result<WorkspaceStartWatchResult> {
        if params.watch_id.trim().is_empty() {
            bail!("watch_id must not be empty");
        }
        if params.workspace_dir.trim().is_empty() {
            bail!("workspace_dir must not be empty");
        }
        {
            let watchers = self.watchers.lock().expect("watchers mutex poisoned");
            if watchers.contains_key(&params.watch_id) {
                bail!(
                    "watch `{}` is already running; stop it first to re-watch",
                    params.watch_id
                );
            }
        }

        let watch_id = params.watch_id.clone();
        let notifier_for_cb = Arc::clone(&notifier);
        let watcher = FileWatcher::start(
            PathBuf::from(&params.workspace_dir),
            Box::new(move |changes| {
                if changes.is_empty() {
                    return;
                }
                let notification = WorkspaceFileEventNotification {
                    watch_id: watch_id.clone(),
                    changes,
                };
                let payload = match serde_json::to_value(&notification) {
                    Ok(v) => v,
                    Err(err) => {
                        tracing::warn!(
                            error = %err,
                            "watch: failed to serialise file event notification"
                        );
                        return;
                    }
                };
                notifier_for_cb.notify(WORKSPACE_FILE_EVENT_METHOD, payload);
            }),
        )
        .with_context(|| format!("start watcher for `{}`", params.workspace_dir))?;

        self.watchers
            .lock()
            .expect("watchers mutex poisoned")
            .insert(params.watch_id.clone(), watcher);
        Ok(WorkspaceStartWatchResult {
            watch_id: params.watch_id,
        })
    }

    /// Drop the watcher for `watch_id`. Returns `stopped=false` when
    /// no watcher was registered under that id — the client uses
    /// the bool to debug a stale handle without crashing.
    pub fn stop_watch(&self, params: WorkspaceStopWatchParams) -> Result<WorkspaceStopWatchResult> {
        if params.watch_id.trim().is_empty() {
            bail!("watch_id must not be empty");
        }
        // Take ownership out of the map so the watcher's Drop happens
        // outside the lock — mirrors the terminal close path so
        // expensive teardown can't stall a sibling start.
        let removed = {
            let mut watchers = self.watchers.lock().expect("watchers mutex poisoned");
            watchers.remove(&params.watch_id)
        };
        let stopped = removed.is_some();
        drop(removed); // explicit: drops the FileWatcher, joining the notify thread.
        Ok(WorkspaceStopWatchResult { stopped })
    }

    /// Snapshot of currently-registered watch ids. Used by tests
    /// (and by future operator-facing listing surfaces) to check
    /// what's running without touching the watchers themselves.
    pub fn watch_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .watchers
            .lock()
            .expect("watchers mutex poisoned")
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    /// Per-test fixture: emit a synthesized file-event notification
    /// directly through a notifier, bypassing the real notify
    /// thread. Lets the dispatch + serde path be tested without
    /// racing against the OS event loop.
    #[cfg(test)]
    pub(crate) fn notify_synthetic_event(
        notifier: &Arc<dyn Notifier>,
        watch_id: &str,
        changes: Vec<crate::workspace::files::FileChange>,
    ) {
        let notification = WorkspaceFileEventNotification {
            watch_id: watch_id.to_string(),
            changes,
        };
        let payload = serde_json::to_value(&notification).expect("notification serialises");
        notifier.notify(WORKSPACE_FILE_EVENT_METHOD, payload);
    }
}

impl std::fmt::Debug for RemoteWatchState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let count = self.watchers.lock().map(|w| w.len()).unwrap_or(0);
        f.debug_struct("RemoteWatchState")
            .field("active_watchers", &count)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::files::{FileChange, FileChangeKind};
    use serde_json::Value;
    use std::sync::Mutex as StdMutex;
    use std::time::{Duration, Instant};

    /// Capturing notifier for assertions. Mirrors the one in
    /// `terminal.rs::tests::CapturingNotifier` — pattern repeats
    /// across every notifier consumer in this codebase.
    #[derive(Default)]
    struct CapturingNotifier {
        captured: StdMutex<Vec<(String, Value)>>,
    }

    impl Notifier for CapturingNotifier {
        fn notify(&self, method: &str, params: Value) {
            self.captured
                .lock()
                .unwrap()
                .push((method.to_string(), params));
        }
    }

    fn wait_for<F: Fn(&Vec<(String, Value)>) -> bool>(
        notifier: &Arc<CapturingNotifier>,
        pred: F,
    ) -> Vec<(String, Value)> {
        // 2-second window matches the watcher tests — notify on macOS
        // can take several hundred ms to deliver the first batch.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            {
                let guard = notifier.captured.lock().unwrap();
                if pred(&guard) {
                    return guard.clone();
                }
            }
            if Instant::now() >= deadline {
                return notifier.captured.lock().unwrap().clone();
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn start_watch_rejects_empty_watch_id() {
        let state = RemoteWatchState::new();
        let notifier: Arc<dyn Notifier> = Arc::new(CapturingNotifier::default());
        let err = state
            .start_watch(
                WorkspaceStartWatchParams {
                    workspace_dir: "/tmp".into(),
                    watch_id: "".into(),
                },
                notifier,
            )
            .unwrap_err();
        assert!(format!("{err:#}").contains("watch_id must not be empty"));
    }

    #[test]
    fn start_watch_rejects_empty_workspace_dir() {
        let state = RemoteWatchState::new();
        let notifier: Arc<dyn Notifier> = Arc::new(CapturingNotifier::default());
        let err = state
            .start_watch(
                WorkspaceStartWatchParams {
                    workspace_dir: "".into(),
                    watch_id: "w-1".into(),
                },
                notifier,
            )
            .unwrap_err();
        assert!(format!("{err:#}").contains("workspace_dir must not be empty"));
    }

    #[test]
    fn start_watch_rejects_duplicate_watch_id() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteWatchState::new();
        let notifier: Arc<dyn Notifier> = Arc::new(CapturingNotifier::default());
        state
            .start_watch(
                WorkspaceStartWatchParams {
                    workspace_dir: dir.path().display().to_string(),
                    watch_id: "w-dup".into(),
                },
                Arc::clone(&notifier),
            )
            .unwrap();

        let err = state
            .start_watch(
                WorkspaceStartWatchParams {
                    workspace_dir: dir.path().display().to_string(),
                    watch_id: "w-dup".into(),
                },
                notifier,
            )
            .unwrap_err();
        assert!(
            format!("{err:#}").contains("already running"),
            "duplicate should mention the conflict explicitly"
        );
    }

    #[test]
    fn start_watch_bails_when_workspace_dir_does_not_exist() {
        // Canonicalize fails for a missing path → start_watch
        // surfaces the failure as an Err rather than silently
        // dropping the watcher.
        let state = RemoteWatchState::new();
        let notifier: Arc<dyn Notifier> = Arc::new(CapturingNotifier::default());
        let err = state
            .start_watch(
                WorkspaceStartWatchParams {
                    workspace_dir: "/definitely/does/not/exist/12345".into(),
                    watch_id: "w-bad-dir".into(),
                },
                notifier,
            )
            .unwrap_err();
        // The error wraps the canonicalize failure with our context
        // line so the operator sees both the path and the OS reason.
        let msg = format!("{err:#}");
        assert!(
            msg.contains("/definitely/does/not/exist/12345") || msg.contains("canonicaliz"),
            "expected path / canonicalize in error: {msg}"
        );
    }

    #[test]
    fn start_watch_registers_the_watcher_in_the_id_map() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteWatchState::new();
        let notifier: Arc<dyn Notifier> = Arc::new(CapturingNotifier::default());

        assert!(state.watch_ids().is_empty());
        state
            .start_watch(
                WorkspaceStartWatchParams {
                    workspace_dir: dir.path().display().to_string(),
                    watch_id: "w-1".into(),
                },
                Arc::clone(&notifier),
            )
            .unwrap();
        state
            .start_watch(
                WorkspaceStartWatchParams {
                    workspace_dir: dir.path().display().to_string(),
                    watch_id: "w-2".into(),
                },
                notifier,
            )
            .unwrap();

        assert_eq!(state.watch_ids(), vec!["w-1".to_string(), "w-2".into()]);
    }

    #[test]
    fn callback_emits_workspace_file_event_with_camel_case_changes() {
        // Drive the real notify thread so the dispatch + serde path
        // is exercised end-to-end. The kernel's own tests already
        // lock down platform-specific event-kind quirks; here we
        // assert the notification envelope shape.
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteWatchState::new();
        let notifier: Arc<CapturingNotifier> = Arc::new(CapturingNotifier::default());
        state
            .start_watch(
                WorkspaceStartWatchParams {
                    workspace_dir: dir.path().display().to_string(),
                    watch_id: "w-emit".into(),
                },
                Arc::clone(&notifier) as Arc<dyn Notifier>,
            )
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));

        std::fs::write(dir.path().join("alive.txt"), "hello").unwrap();

        let captured = wait_for(&notifier, |c| !c.is_empty());
        assert!(
            !captured.is_empty(),
            "expected at least one workspace.fileEvent notification"
        );
        let (method, params) = &captured[0];
        assert_eq!(
            method, WORKSPACE_FILE_EVENT_METHOD,
            "notifier method must be workspace.fileEvent"
        );
        assert_eq!(params["watchId"], "w-emit");
        let changes = params["changes"].as_array().expect("changes array");
        assert!(!changes.is_empty(), "expected at least one change");
        // Every change should carry the alive.txt path. The kind
        // varies across platforms so we only assert presence.
        assert!(
            changes
                .iter()
                .any(|c| c["path"].as_str() == Some("alive.txt")),
            "expected alive.txt in changes: {changes:?}"
        );
    }

    #[test]
    fn stop_watch_drops_the_watcher_and_silences_further_events() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteWatchState::new();
        let notifier: Arc<CapturingNotifier> = Arc::new(CapturingNotifier::default());
        state
            .start_watch(
                WorkspaceStartWatchParams {
                    workspace_dir: dir.path().display().to_string(),
                    watch_id: "w-stop".into(),
                },
                Arc::clone(&notifier) as Arc<dyn Notifier>,
            )
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));

        let stopped = state
            .stop_watch(WorkspaceStopWatchParams {
                watch_id: "w-stop".into(),
            })
            .unwrap();
        assert!(stopped.stopped, "first stop should report stopped=true");
        assert!(state.watch_ids().is_empty());

        // Wait a beat after stop, then write a file. The watcher
        // is dropped → no event should arrive.
        std::thread::sleep(Duration::from_millis(200));
        let baseline_count = notifier.captured.lock().unwrap().len();
        std::fs::write(dir.path().join("after-stop.txt"), "silent").unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let post_count = notifier.captured.lock().unwrap().len();
        assert_eq!(
            post_count, baseline_count,
            "no events should fire after stop_watch: captured grew from {baseline_count} to {post_count}"
        );
    }

    #[test]
    fn stop_watch_returns_stopped_false_for_unknown_id() {
        // Idempotent: stopping a watcher that never existed (or
        // that's already been stopped) is a no-op + reports
        // stopped=false so the desktop can detect a stale handle.
        let state = RemoteWatchState::new();
        let result = state
            .stop_watch(WorkspaceStopWatchParams {
                watch_id: "never-existed".into(),
            })
            .unwrap();
        assert!(!result.stopped);
    }

    #[test]
    fn stop_watch_rejects_empty_id() {
        let state = RemoteWatchState::new();
        let err = state
            .stop_watch(WorkspaceStopWatchParams {
                watch_id: "".into(),
            })
            .unwrap_err();
        assert!(format!("{err:#}").contains("watch_id must not be empty"));
    }

    #[test]
    fn dropping_state_drops_every_active_watcher() {
        // Sanity check: dropping the state drops the inner
        // HashMap, which drops every FileWatcher, which joins
        // each notify thread. No assertion needed beyond "does
        // not panic / hang" — the test runs to completion only
        // if every thread cleans up.
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteWatchState::new();
        let notifier: Arc<dyn Notifier> = Arc::new(CapturingNotifier::default());
        for i in 0..5 {
            state
                .start_watch(
                    WorkspaceStartWatchParams {
                        workspace_dir: dir.path().display().to_string(),
                        watch_id: format!("w-{i}"),
                    },
                    Arc::clone(&notifier),
                )
                .unwrap();
        }
        assert_eq!(state.watch_ids().len(), 5);
        drop(state); // every watcher should drop in turn.
    }

    // ── synthetic-event path (no notify thread) ───────────────────

    #[test]
    fn synthetic_event_helper_emits_the_right_envelope() {
        // Verifies the wire envelope under test conditions: the
        // helper builds a `WorkspaceFileEventNotification` with the
        // supplied watch_id + changes and dispatches it through the
        // notifier. Used by dispatch tests that don't want to
        // tangle with a real notify thread.
        let notifier: Arc<CapturingNotifier> = Arc::new(CapturingNotifier::default());
        let notifier_dyn: Arc<dyn Notifier> = Arc::clone(&notifier) as Arc<dyn Notifier>;
        RemoteWatchState::notify_synthetic_event(
            &notifier_dyn,
            "w-synth",
            vec![FileChange {
                path: "src/lib.rs".into(),
                kind: FileChangeKind::Modified,
            }],
        );

        let captured = notifier.captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let (method, params) = &captured[0];
        assert_eq!(method, WORKSPACE_FILE_EVENT_METHOD);
        assert_eq!(params["watchId"], "w-synth");
        assert_eq!(params["changes"][0]["path"], "src/lib.rs");
        assert_eq!(params["changes"][0]["kind"], "modified");
    }
}
