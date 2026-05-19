//! Desktop-side workspace file-watch manager + Tauri commands.
//!
//! Bridges two paths into a single per-workspace watcher that fires
//! the existing [`UiMutationEvent::WorkspaceFilesChanged`] event so
//! React Query keys (`workspaceChanges`, `workspaceFileTree`, etc.)
//! get invalidated on every debounced batch:
//!
//! - **Local workspaces** spawn a [`FileWatcher`] directly in the
//!   desktop process.
//! - **Remote workspaces** call `workspace.startWatch` on the bound
//!   runtime, subscribe to `workspace.fileEvent` notifications, and
//!   convert each into the same UI mutation event.
//!
//! The manager is a Tauri-managed `Arc<Self>` keyed by `workspace_id`
//! — exactly one watcher per workspace at a time. Re-starting a
//! watch on an already-watched workspace replaces the old one
//! (drop + spawn) rather than erroring; the desktop's higher-level
//! hook fires `start` on every mount and doesn't want to be told
//! about its own previous mount.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use uuid::Uuid;

use crate::remote::methods::{
    WorkspaceFileEventNotification, WorkspaceStartWatchParams, WorkspaceStopWatchParams,
};
use crate::remote::{NotificationSubscription, RuntimeRegistry, LOCAL_RUNTIME_NAME};
use crate::ui_sync::{publish, UiMutationEvent};
use crate::workspace::files::FileWatcher;

use super::common::{run_blocking, CmdResult};

/// One in-flight watch tied to a workspace.
enum ActiveWatch {
    /// Desktop-process watcher. Drop tears down the notify thread.
    Local { _watcher: FileWatcher },
    /// Daemon-side watcher; we hold the notification subscription so
    /// dropping it stops the per-event callback. `stop_watch` on
    /// the runtime is best-effort — if the daemon's already gone
    /// (disconnect), the subscription drops cleanly and we skip
    /// the wire call.
    Remote {
        runtime_name: String,
        watch_id: String,
        _subscription: NotificationSubscription,
    },
}

/// Tauri-managed state. Stash one instance via `.manage(Arc::new(
/// WorkspaceFileWatchManager::new()))` at app boot; the two
/// commands below reach it as `tauri::State`.
#[derive(Default)]
pub struct WorkspaceFileWatchManager {
    watches: Mutex<HashMap<String, ActiveWatch>>,
}

impl WorkspaceFileWatchManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot of currently-active workspace ids. Used by tests and
    /// by a future operator-facing surface.
    #[allow(dead_code)]
    pub fn active_workspace_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .watches
            .lock()
            .expect("watch manager mutex poisoned")
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
    }
}

/// Wire-shape result for the `start_workspace_watch` command.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartWorkspaceWatchResult {
    /// Echoes the workspace id back so a future tagged-response
    /// pipeline can correlate the start with the events that
    /// follow.
    pub workspace_id: String,
    /// `"local"` or `"remote"` so the frontend can render a
    /// runtime chip on the watcher status indicator (without
    /// re-resolving the binding on the JS side).
    pub kind: WatchKindLabel,
}

/// Serializable runtime-label for [`StartWorkspaceWatchResult`].
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WatchKindLabel {
    Local,
    Remote,
}

/// Treat `None`, empty string, and the reserved `"local"` name as
/// "use the local path". Anything else hits the registry.
fn wants_local(runtime_name: Option<&str>) -> bool {
    match runtime_name.map(str::trim) {
        None | Some("") | Some(LOCAL_RUNTIME_NAME) => true,
        Some(_) => false,
    }
}

/// Start watching files in `workspace_dir` and fire
/// `WorkspaceFilesChanged` on every debounced batch. Replaces any
/// existing watch for the same `workspace_id` — re-starting is a
/// no-op-equivalent rather than an error so the frontend's
/// workspace-open hook can `start` unconditionally.
///
/// `runtime_name=None` or `"local"` runs an in-process
/// [`FileWatcher`]; any other name resolves to a registered remote
/// runtime and dispatches through `workspace.startWatch` over the
/// wire.
#[tauri::command]
pub async fn start_workspace_watch(
    app: tauri::AppHandle,
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    manager: tauri::State<'_, Arc<WorkspaceFileWatchManager>>,
    workspace_id: String,
    workspace_dir: String,
    runtime_name: Option<String>,
) -> CmdResult<StartWorkspaceWatchResult> {
    let registry = Arc::clone(&registry);
    let manager = Arc::clone(&manager);
    run_blocking(move || {
        start_workspace_watch_inner(
            app,
            &registry,
            &manager,
            workspace_id,
            workspace_dir,
            runtime_name.as_deref(),
        )
    })
    .await
}

pub(crate) fn start_workspace_watch_inner(
    app: tauri::AppHandle,
    registry: &Arc<RuntimeRegistry>,
    manager: &Arc<WorkspaceFileWatchManager>,
    workspace_id: String,
    workspace_dir: String,
    runtime_name: Option<&str>,
) -> Result<StartWorkspaceWatchResult> {
    if workspace_id.trim().is_empty() {
        bail!("workspace_id must not be empty");
    }
    if workspace_dir.trim().is_empty() {
        bail!("workspace_dir must not be empty");
    }

    let app_for_cb = app.clone();
    let workspace_id_for_cb = workspace_id.clone();

    let (active_watch, label) = if wants_local(runtime_name) {
        let watcher = FileWatcher::start(
            PathBuf::from(&workspace_dir),
            Box::new(move |_changes| {
                publish(
                    &app_for_cb,
                    UiMutationEvent::WorkspaceFilesChanged {
                        workspace_id: workspace_id_for_cb.clone(),
                    },
                );
            }),
        )
        .with_context(|| format!("start local watcher for `{workspace_dir}`"))?;
        (
            ActiveWatch::Local { _watcher: watcher },
            WatchKindLabel::Local,
        )
    } else {
        // Safe to unwrap because `wants_local` returned false →
        // runtime_name is non-empty and not "local".
        let name = runtime_name
            .expect("remote branch implies Some(name)")
            .to_string();
        let runtime = registry
            .lookup(Some(&name))
            .with_context(|| format!("resolve remote runtime `{name}` for workspace watch"))?;

        // Use a UUID per-start so re-starting a watch on the same
        // workspace produces a fresh server-side watch id (avoids
        // the daemon's "already running" rejection).
        let watch_id = format!("ws-watch-{}", Uuid::new_v4());

        let _result = runtime
            .workspace_start_watch(WorkspaceStartWatchParams {
                workspace_dir: workspace_dir.clone(),
                watch_id: watch_id.clone(),
            })
            .with_context(|| {
                format!("workspace.startWatch on `{name}` for workspace `{workspace_id}`")
            })?;

        let watch_id_for_cb = watch_id.clone();
        let subscription = runtime
            .subscribe_workspace_file_events(Box::new(
                move |notif: WorkspaceFileEventNotification| {
                    // Demux by watch id so a sibling watcher on
                    // the same connection doesn't cross-talk.
                    if notif.watch_id != watch_id_for_cb {
                        return;
                    }
                    publish(
                        &app_for_cb,
                        UiMutationEvent::WorkspaceFilesChanged {
                            workspace_id: workspace_id_for_cb.clone(),
                        },
                    );
                },
            ))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "runtime `{name}` does not support workspace.fileEvent subscriptions",
                )
            })?;

        (
            ActiveWatch::Remote {
                runtime_name: name,
                watch_id,
                _subscription: subscription,
            },
            WatchKindLabel::Remote,
        )
    };

    // Replace any prior watch for this workspace. We drop the prior
    // entry OUTSIDE the lock so its teardown can't stall siblings.
    let prior = {
        let mut watches = manager
            .watches
            .lock()
            .expect("watch manager mutex poisoned");
        watches.insert(workspace_id.clone(), active_watch)
    };
    drop(prior);

    Ok(StartWorkspaceWatchResult {
        workspace_id,
        kind: label,
    })
}

/// Stop the watcher for `workspace_id`. Returns `stopped=false`
/// when no watcher was active for that workspace — the desktop
/// hook uses the bool to detect a lost handle but doesn't treat
/// it as an error (a workspace can close without ever having a
/// watcher started for it).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopWorkspaceWatchResult {
    pub stopped: bool,
}

#[tauri::command]
pub async fn stop_workspace_watch(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    manager: tauri::State<'_, Arc<WorkspaceFileWatchManager>>,
    workspace_id: String,
) -> CmdResult<StopWorkspaceWatchResult> {
    let registry = Arc::clone(&registry);
    let manager = Arc::clone(&manager);
    run_blocking(move || stop_workspace_watch_inner(&registry, &manager, workspace_id)).await
}

pub(crate) fn stop_workspace_watch_inner(
    registry: &Arc<RuntimeRegistry>,
    manager: &Arc<WorkspaceFileWatchManager>,
    workspace_id: String,
) -> Result<StopWorkspaceWatchResult> {
    if workspace_id.trim().is_empty() {
        bail!("workspace_id must not be empty");
    }
    let removed = {
        let mut watches = manager
            .watches
            .lock()
            .expect("watch manager mutex poisoned");
        watches.remove(&workspace_id)
    };

    match removed {
        None => Ok(StopWorkspaceWatchResult { stopped: false }),
        Some(ActiveWatch::Local { _watcher }) => {
            drop(_watcher); // Explicit: drops the notify thread.
            Ok(StopWorkspaceWatchResult { stopped: true })
        }
        Some(ActiveWatch::Remote {
            runtime_name,
            watch_id,
            _subscription,
        }) => {
            // Best-effort: tell the daemon to stop. If the runtime
            // is gone the call fails — we still drop the
            // subscription handle below so no further events flow
            // to a freed callback.
            if let Ok(runtime) = registry.lookup(Some(&runtime_name)) {
                if let Err(err) =
                    runtime.workspace_stop_watch(WorkspaceStopWatchParams { watch_id })
                {
                    tracing::warn!(
                        workspace_id = %workspace_id,
                        runtime = %runtime_name,
                        error = %format!("{err:#}"),
                        "workspace_watch: stop_watch on daemon failed; subscription will be dropped anyway"
                    );
                }
            }
            drop(_subscription);
            Ok(StopWorkspaceWatchResult { stopped: true })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_manager() -> Arc<WorkspaceFileWatchManager> {
        Arc::new(WorkspaceFileWatchManager::new())
    }

    fn empty_registry() -> Arc<RuntimeRegistry> {
        Arc::new(RuntimeRegistry::new())
    }

    #[test]
    fn wants_local_treats_none_empty_and_local_uniformly() {
        assert!(wants_local(None));
        assert!(wants_local(Some("")));
        assert!(wants_local(Some("   ")));
        assert!(wants_local(Some(LOCAL_RUNTIME_NAME)));
        // Any other name is remote.
        assert!(!wants_local(Some("dev.box")));
        assert!(!wants_local(Some("stub.box")));
    }

    #[test]
    fn stop_unknown_workspace_returns_stopped_false() {
        let registry = empty_registry();
        let manager = empty_manager();
        let result =
            stop_workspace_watch_inner(&registry, &manager, "never-watched".into()).unwrap();
        assert!(!result.stopped);
    }

    #[test]
    fn stop_rejects_empty_workspace_id() {
        let registry = empty_registry();
        let manager = empty_manager();
        let err = stop_workspace_watch_inner(&registry, &manager, "".into()).unwrap_err();
        assert!(format!("{err:#}").contains("workspace_id must not be empty"));
    }

    #[test]
    fn manager_tracks_no_active_workspaces_at_construction() {
        let manager = WorkspaceFileWatchManager::new();
        assert!(manager.active_workspace_ids().is_empty());
    }

    #[test]
    fn start_kind_label_round_trips_through_serde() {
        // The frontend distinguishes local vs remote watchers via
        // the `kind` field so it can render a runtime chip — lock
        // the wire spelling.
        let local = StartWorkspaceWatchResult {
            workspace_id: "ws-1".into(),
            kind: WatchKindLabel::Local,
        };
        let wire = serde_json::to_string(&local).unwrap();
        assert!(wire.contains("\"kind\":\"local\""));
        let remote = StartWorkspaceWatchResult {
            workspace_id: "ws-2".into(),
            kind: WatchKindLabel::Remote,
        };
        let wire = serde_json::to_string(&remote).unwrap();
        assert!(wire.contains("\"kind\":\"remote\""));
    }

    #[test]
    fn stop_result_round_trips_with_camel_case() {
        let yes = StopWorkspaceWatchResult { stopped: true };
        let wire = serde_json::to_string(&yes).unwrap();
        assert!(wire.contains("\"stopped\":true"));
    }
}
