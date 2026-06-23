use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{
    agents::ActiveStreams,
    error::{extract_code, outermost_message, ErrorCode},
    git_watcher, settings,
};

use super::lifecycle::{execute_archive_plan, prepare_archive_plan, ArchivePreparedPlan};

pub const ARCHIVE_EXECUTION_FAILED_EVENT: &str = "archive-execution-failed";
pub const ARCHIVE_EXECUTION_SUCCEEDED_EVENT: &str = "archive-execution-succeeded";

/// What kicked off this archive run. Plumbed through to the success /
/// failure events so the frontend can branch on it — manual flow drives
/// the sidebar via the existing `archiveGate` + `pendingArchives`
/// machinery; auto flow has no such state and needs its own sidebar
/// reconcile + a calmer failure toast.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveOrigin {
    Manual,
    AutoAfterMerge,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareArchiveWorkspaceResponse {
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveExecutionFailedPayload {
    pub workspace_id: String,
    pub code: ErrorCode,
    pub message: String,
    pub origin: ArchiveOrigin,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveExecutionSucceededPayload {
    pub workspace_id: String,
    pub origin: ArchiveOrigin,
}

#[derive(Default)]
struct ArchiveJobState {
    prepared: HashMap<String, ArchivePreparedPlan>,
    running: HashSet<String>,
}

pub struct ArchiveJobManager {
    state: Mutex<ArchiveJobState>,
}

impl Default for ArchiveJobManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ArchiveJobManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ArchiveJobState::default()),
        }
    }

    pub fn prepare(&self, workspace_id: &str) -> Result<PrepareArchiveWorkspaceResponse> {
        let plan = prepare_archive_plan(workspace_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("archive job lock poisoned"))?;

        if state.running.contains(workspace_id) {
            bail!("Archive already in progress: {workspace_id}");
        }

        state.prepared.insert(workspace_id.to_string(), plan);

        Ok(PrepareArchiveWorkspaceResponse {
            workspace_id: workspace_id.to_string(),
        })
    }

    fn start_prepared(&self, workspace_id: &str) -> Result<ArchivePreparedPlan> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("archive job lock poisoned"))?;

        if state.running.contains(workspace_id) {
            bail!("Archive already in progress: {workspace_id}");
        }

        let plan = state
            .prepared
            .remove(workspace_id)
            .with_context(|| format!("Archive preflight is missing for {workspace_id}"))?;
        state.running.insert(workspace_id.to_string());
        Ok(plan)
    }

    fn finish(&self, workspace_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.running.remove(workspace_id);
        }
    }
}

/// Opt-in auto-archive triggered when a workspace's PR transitions to
/// merged. Fires once at the edge — callers gate on
/// `state_changed && next_state == Merged` (see `forge_commands`), and
/// `PrSyncState::Merged` is an absorbing state in
/// `stabilize_pr_sync_state`, so this can't re-fire on subsequent polls.
///
/// Best-effort: every skip path logs and returns. Failures are routed
/// through the existing `ARCHIVE_EXECUTION_FAILED_EVENT` so the UI toast
/// still surfaces them.
pub fn try_auto_archive_after_merge<R: Runtime>(app: &AppHandle<R>, workspace_id: &str) {
    let enabled = match settings::load_auto_archive_on_merge_enabled() {
        Ok(v) => v,
        Err(error) => {
            tracing::warn!(
                workspace_id,
                error = %error,
                "Auto-archive: failed to read setting, skipping"
            );
            return;
        }
    };
    if !enabled {
        return;
    }

    // Active agent turn → skip. Yanking the worktree out from under a
    // running session would crash it.
    if app
        .state::<ActiveStreams>()
        .has_active_for_workspace(workspace_id)
    {
        tracing::info!(
            workspace_id,
            "Auto-archive skipped: workspace has an active session"
        );
        return;
    }

    // `prepare` covers eligibility + missing repo/worktree + already-
    // running archive in one shot. A failure here is the right outcome
    // for "conditions not met" — log and bail without retry.
    let manager = app.state::<ArchiveJobManager>();
    if let Err(error) = manager.prepare(workspace_id) {
        tracing::info!(
            workspace_id,
            error = %error,
            "Auto-archive skipped: prepare failed"
        );
        return;
    }

    // Hand off to the existing async path so success / failure events,
    // git unwatch, and the toast pipeline are all reused.
    if let Err(error) = start_archive_workspace(app, workspace_id, ArchiveOrigin::AutoAfterMerge) {
        tracing::warn!(
            workspace_id,
            error = %error,
            "Auto-archive: failed to start archive task"
        );
    } else {
        tracing::info!(workspace_id, "Auto-archive started after merge");
    }
}

pub fn start_archive_workspace<R: Runtime>(
    app: &AppHandle<R>,
    workspace_id: &str,
    origin: ArchiveOrigin,
) -> Result<()> {
    let manager = app.state::<ArchiveJobManager>();
    let plan = manager.start_prepared(workspace_id)?;
    let app_handle = app.clone();
    let workspace_id = workspace_id.to_string();
    // Snapshot the script process manager so the blocking archive task can stop
    // this workspace's live run/terminal processes before the worktree is torn
    // down. Without this, dev servers, watchers, and shell sessions outlive the
    // archive as orphan process trees pointing at a deleted worktree.
    let scripts = app
        .state::<crate::workspace::scripts::ScriptProcessManager>()
        .inner()
        .clone();

    tauri::async_runtime::spawn(async move {
        let task_started = std::time::Instant::now();

        let unwatch_started = std::time::Instant::now();
        app_handle
            .state::<git_watcher::GitWatcherManager>()
            .unwatch(&workspace_id);
        tracing::debug!(
            workspace_id,
            elapsed_ms = unwatch_started.elapsed().as_millis(),
            "Archive: git unwatch finished"
        );

        let kill_workspace_id = workspace_id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            // Stop live run-action / terminal processes before tearing down the
            // worktree. Runs here (not in `execute_archive_plan`) because only
            // the GUI path owns the `ScriptProcessManager`; CLI/MCP archive is
            // headless with no tracked processes.
            let signaled = scripts.kill_workspace(&kill_workspace_id);
            if signaled > 0 {
                tracing::info!(
                    workspace_id = %kill_workspace_id,
                    signaled,
                    "Archive: stopped live workspace processes before teardown"
                );
            }
            execute_archive_plan(&plan)
        })
        .await;

        match result {
            Ok(Ok(_)) => {
                let sync_started = std::time::Instant::now();
                git_watcher::notify_workspace_changed(&app_handle);
                tracing::debug!(
                    workspace_id,
                    elapsed_ms = sync_started.elapsed().as_millis(),
                    "Archive: notify_workspace_changed finished"
                );
                tracing::info!(
                    workspace_id,
                    total_ms = task_started.elapsed().as_millis(),
                    "Archive: task finished (success)"
                );
                let _ = app_handle.emit(
                    ARCHIVE_EXECUTION_SUCCEEDED_EVENT,
                    ArchiveExecutionSucceededPayload {
                        workspace_id: workspace_id.clone(),
                        origin,
                    },
                );
            }
            Ok(Err(error)) => {
                tracing::error!(
                    workspace_id,
                    code = ?extract_code(&error),
                    error = %format!("{error:#}"),
                    "Archive execution failed"
                );
                git_watcher::notify_workspace_changed(&app_handle);
                let _ = app_handle.emit(
                    ARCHIVE_EXECUTION_FAILED_EVENT,
                    ArchiveExecutionFailedPayload {
                        workspace_id: workspace_id.clone(),
                        code: extract_code(&error),
                        message: outermost_message(&error),
                        origin,
                    },
                );
            }
            Err(error) => {
                tracing::error!(workspace_id, error = %error, "Archive execution task crashed");
                git_watcher::notify_workspace_changed(&app_handle);
                let _ = app_handle.emit(
                    ARCHIVE_EXECUTION_FAILED_EVENT,
                    ArchiveExecutionFailedPayload {
                        workspace_id: workspace_id.clone(),
                        code: ErrorCode::Unknown,
                        message: format!("Archive task failed: {error}"),
                        origin,
                    },
                );
            }
        }

        app_handle
            .state::<ArchiveJobManager>()
            .finish(&workspace_id);
    });

    Ok(())
}
