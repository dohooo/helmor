use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_updater::UpdaterExt;

use super::config::{failure_backoff, UpdateBehavior, UpdaterConfig};
use super::events::{
    DownloadProgress, UpdateInfoSnapshot, UpdateStage, UpdateStatusSnapshot,
    APP_UPDATE_STATUS_EVENT,
};
use super::state::{self as persisted, PendingUpdate, UpdateRuntimeState};

static UPDATE_MANAGER: OnceLock<UpdateManager> = OnceLock::new();

const PROGRESS_EMIT_THROTTLE: Duration = Duration::from_millis(200);
const SCHEDULER_FLOOR: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckReason {
    Startup,
    Resume,
    Focus,
    Interval,
    Manual,
}

pub struct UpdateManager {
    config: UpdaterConfig,
    state: Mutex<UpdateRuntimeState>,
}

pub fn configure() -> anyhow::Result<()> {
    let config = UpdaterConfig::load()?;
    let mut initial = UpdateRuntimeState {
        stage: UpdateStage::Idle,
        ..UpdateRuntimeState::default()
    };
    persisted::load_persisted(&mut initial);

    let _ = UPDATE_MANAGER.set(UpdateManager {
        config,
        state: Mutex::new(initial),
    });
    Ok(())
}

pub fn snapshot<R: Runtime>(app: AppHandle<R>) -> UpdateStatusSnapshot {
    let behavior = UpdateBehavior::load();
    manager().snapshot(&app, &behavior)
}

pub fn spawn_startup_check<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let _ = trigger_check(app, CheckReason::Startup, false).await;
    });
}

/// Deadline-based interval poller. Sleeps until the next legitimate check
/// time (last attempt + interval, or last failure + exponential backoff,
/// whichever is later) instead of waking every 60s and short-circuiting.
pub fn spawn_interval_worker<R: Runtime>(app: AppHandle<R>) {
    let app_handle = app.clone();
    if let Err(error) = thread::Builder::new()
        .name("app-update-poller".into())
        .spawn(move || loop {
            let sleep_dur = compute_sleep_duration();
            thread::sleep(sleep_dur);
            let app_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let _ = trigger_check(app_handle, CheckReason::Interval, false).await;
            });
        })
    {
        tracing::error!(error = %error, "Failed to spawn app update poller");
    }
}

pub fn maybe_trigger_on_resume<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let _ = trigger_check(app, CheckReason::Resume, false).await;
    });
}

pub fn maybe_trigger_on_focus<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let _ = trigger_check(app, CheckReason::Focus, false).await;
    });
}

pub async fn trigger_check<R: Runtime>(
    app: AppHandle<R>,
    reason: CheckReason,
    force: bool,
) -> UpdateStatusSnapshot {
    let behavior = UpdateBehavior::load();
    let manager = manager();

    if !manager.config.is_configured() {
        return manager.snapshot(&app, &behavior);
    }

    {
        let mut state = manager.state.lock().expect("update state poisoned");

        if state.in_flight {
            return state.snapshot(manager.config.is_configured(), behavior.auto_update_enabled);
        }

        if !force {
            if !is_reason_enabled(reason, &behavior) {
                return state
                    .snapshot(manager.config.is_configured(), behavior.auto_update_enabled);
            }

            if !behavior.auto_update_enabled {
                return state
                    .snapshot(manager.config.is_configured(), behavior.auto_update_enabled);
            }

            if state.pending_update.is_some() {
                return state
                    .snapshot(manager.config.is_configured(), behavior.auto_update_enabled);
            }

            if !should_attempt(reason, &behavior, &state) {
                return state
                    .snapshot(manager.config.is_configured(), behavior.auto_update_enabled);
            }
        }

        state.in_flight = true;
        state.stage = UpdateStage::Checking;
        state.last_attempt_at = Some(Utc::now());
        state.last_error = None;
        state.download_progress = None;
        persisted::persist(&state);
    }

    manager.emit_status(&app, &behavior);

    let result = manager.do_check(&app, &behavior).await;

    let snapshot = {
        let mut state = manager.state.lock().expect("update state poisoned");
        state.in_flight = false;

        match result {
            Ok(Some(pending)) => {
                state.stage = UpdateStage::Downloaded;
                state.last_success_at = Some(Utc::now());
                state.downloaded_at = Some(Utc::now());
                state.last_error = None;
                state.consecutive_failures = 0;
                state.pending_update = Some(pending);
                state.download_progress = None;
            }
            Ok(None) => {
                state.stage = UpdateStage::Idle;
                state.last_success_at = Some(Utc::now());
                state.last_error = None;
                state.consecutive_failures = 0;
                state.download_progress = None;
            }
            Err(error) => {
                state.stage = UpdateStage::Error;
                state.last_error = Some(error.to_string());
                state.last_failure_at = Some(Utc::now());
                state.consecutive_failures = state.consecutive_failures.saturating_add(1);
                state.download_progress = None;
            }
        }

        persisted::persist(&state);
        state.snapshot(manager.config.is_configured(), behavior.auto_update_enabled)
    };

    let _ = app.emit(APP_UPDATE_STATUS_EVENT, snapshot.clone());
    snapshot
}

pub async fn install_downloaded_update<R: Runtime>(app: AppHandle<R>) -> UpdateStatusSnapshot {
    let behavior = UpdateBehavior::load();
    let manager = manager();

    let pending = {
        let mut state = manager.state.lock().expect("update state poisoned");
        if state.in_flight {
            return state.snapshot(manager.config.is_configured(), behavior.auto_update_enabled);
        }

        let Some(pending) = state.pending_update.take() else {
            return state.snapshot(manager.config.is_configured(), behavior.auto_update_enabled);
        };

        state.in_flight = true;
        state.stage = UpdateStage::Installing;
        state.last_error = None;
        pending
    };

    manager.emit_status(&app, &behavior);

    match pending.update.install(&pending.bytes) {
        Ok(()) => {
            app.request_restart();

            UpdateStatusSnapshot {
                stage: UpdateStage::Installing,
                configured: manager.config.is_configured(),
                auto_update_enabled: behavior.auto_update_enabled,
                update: Some(pending.info),
                last_error: None,
                last_attempt_at: None,
                downloaded_at: None,
                progress: None,
            }
        }
        Err(error) => {
            let snapshot = {
                let mut state = manager.state.lock().expect("update state poisoned");
                state.in_flight = false;
                state.stage = UpdateStage::Downloaded;
                state.last_error = Some(error.to_string());
                state.pending_update = Some(pending);
                state.snapshot(manager.config.is_configured(), behavior.auto_update_enabled)
            };
            let _ = app.emit(APP_UPDATE_STATUS_EVENT, snapshot.clone());
            snapshot
        }
    }
}

/// Install the pending update — if any — synchronously. Called from the
/// Rust event loop's `Exit` handler so the user's next launch is the new
/// version. Best-effort: any failure just logs (the same bundle will be
/// re-fetched on the next launch's update check).
pub fn install_pending_on_exit_blocking() {
    let Some(manager) = UPDATE_MANAGER.get() else {
        return;
    };
    let pending = match manager.state.lock() {
        Ok(mut state) => state.pending_update.take(),
        Err(_) => return,
    };
    let Some(pending) = pending else {
        return;
    };
    tracing::info!(
        version = %pending.info.version,
        "Installing downloaded update on exit"
    );
    if let Err(error) = pending.update.install(&pending.bytes) {
        tracing::warn!(error = %error, "Failed to install update on exit");
    }
}

impl UpdateManager {
    fn snapshot<R: Runtime>(
        &self,
        _app: &AppHandle<R>,
        behavior: &UpdateBehavior,
    ) -> UpdateStatusSnapshot {
        let state = self.state.lock().expect("update state poisoned");
        state.snapshot(self.config.is_configured(), behavior.auto_update_enabled)
    }

    fn emit_status<R: Runtime>(&self, app: &AppHandle<R>, behavior: &UpdateBehavior) {
        let snapshot = self.snapshot(app, behavior);
        let _ = app.emit(APP_UPDATE_STATUS_EVENT, snapshot);
    }

    async fn do_check<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        behavior: &UpdateBehavior,
    ) -> anyhow::Result<Option<PendingUpdate>> {
        let mut builder = app.updater_builder();
        builder = builder
            .endpoints(self.config.endpoints.clone())?
            .pubkey(self.config.pubkey.clone().unwrap_or_default());

        let update = builder.build()?.check().await?;
        let Some(update) = update else {
            return Ok(None);
        };

        let info = snapshot_from_update(&update);

        {
            let mut state = self.state.lock().expect("update state poisoned");
            state.stage = UpdateStage::Downloading;
            state.pending_update = None;
            state.download_progress = Some(DownloadProgress::default());
        }
        self.emit_status(app, behavior);

        // Throttled progress emitter — chunk callback fires per ~16KB read,
        // re-emitting the full snapshot every chunk would saturate the IPC
        // channel for no UI benefit.
        let tracker = Arc::new(Mutex::new(ProgressTracker {
            downloaded: 0,
            total: None,
            last_emit: Instant::now()
                .checked_sub(PROGRESS_EMIT_THROTTLE)
                .unwrap_or_else(Instant::now),
        }));

        let app_for_chunk = app.clone();
        let behavior_for_chunk = behavior.clone();
        let tracker_for_chunk = tracker.clone();
        let on_chunk = move |chunk_len: usize, total: Option<u64>| {
            let mut t = tracker_for_chunk.lock().expect("progress tracker poisoned");
            t.downloaded = t.downloaded.saturating_add(chunk_len as u64);
            t.total = total;
            let now = Instant::now();
            if now.duration_since(t.last_emit) < PROGRESS_EMIT_THROTTLE {
                return;
            }
            t.last_emit = now;
            let progress = DownloadProgress {
                downloaded: t.downloaded,
                total: t.total,
            };
            drop(t);
            update_progress_and_emit(&app_for_chunk, &behavior_for_chunk, progress);
        };

        let app_for_finish = app.clone();
        let behavior_for_finish = behavior.clone();
        let tracker_for_finish = tracker.clone();
        let on_finish = move || {
            let t = tracker_for_finish
                .lock()
                .expect("progress tracker poisoned");
            let progress = DownloadProgress {
                downloaded: t.downloaded,
                total: t.total.or(Some(t.downloaded)),
            };
            drop(t);
            update_progress_and_emit(&app_for_finish, &behavior_for_finish, progress);
        };

        let bytes = update.download(on_chunk, on_finish).await?;
        Ok(Some(PendingUpdate {
            update,
            bytes,
            info,
        }))
    }
}

struct ProgressTracker {
    downloaded: u64,
    total: Option<u64>,
    last_emit: Instant,
}

fn update_progress_and_emit<R: Runtime>(
    app: &AppHandle<R>,
    behavior: &UpdateBehavior,
    progress: DownloadProgress,
) {
    let manager = manager();
    let snapshot = {
        let mut state = manager.state.lock().expect("update state poisoned");
        state.download_progress = Some(progress);
        state.snapshot(manager.config.is_configured(), behavior.auto_update_enabled)
    };
    let _ = app.emit(APP_UPDATE_STATUS_EVENT, snapshot);
}

fn manager() -> &'static UpdateManager {
    UPDATE_MANAGER
        .get()
        .expect("update manager must be configured before use")
}

fn is_reason_enabled(reason: CheckReason, behavior: &UpdateBehavior) -> bool {
    match reason {
        CheckReason::Startup => behavior.check_on_launch,
        CheckReason::Focus | CheckReason::Resume => behavior.check_on_focus,
        CheckReason::Interval | CheckReason::Manual => true,
    }
}

fn should_attempt(
    reason: CheckReason,
    behavior: &UpdateBehavior,
    state: &UpdateRuntimeState,
) -> bool {
    let now = Utc::now();

    if let Some(last_failure_at) = state.last_failure_at {
        let backoff = failure_backoff(state.consecutive_failures);
        if (now - last_failure_at)
            .to_std()
            .ok()
            .is_some_and(|elapsed| elapsed < backoff)
        {
            return false;
        }
    }

    let elapsed_since_attempt = state
        .last_attempt_at
        .and_then(|value| (now - value).to_std().ok());

    match reason {
        CheckReason::Startup | CheckReason::Manual => true,
        CheckReason::Focus | CheckReason::Resume => {
            elapsed_since_attempt.is_none_or(|elapsed| elapsed >= behavior.focus_ttl)
        }
        CheckReason::Interval => {
            elapsed_since_attempt.is_none_or(|elapsed| elapsed >= behavior.interval)
        }
    }
}

/// Compute how long the interval worker should sleep before its next poll.
/// Reads current state to honor manual checks / focus checks that already
/// fired during the previous sleep window — e.g. if user just clicked
/// "Check now", we wait the full interval before firing again.
fn compute_sleep_duration() -> Duration {
    let Some(manager) = UPDATE_MANAGER.get() else {
        return SCHEDULER_FLOOR;
    };
    let behavior = UpdateBehavior::load();
    let state = match manager.state.lock() {
        Ok(s) => s,
        Err(_) => return SCHEDULER_FLOOR,
    };

    let now = Utc::now();
    let interval_deadline = state
        .last_attempt_at
        .map(|t| {
            t + chrono::Duration::from_std(behavior.interval).unwrap_or(chrono::Duration::zero())
        })
        .unwrap_or(now);

    let failure_deadline = if state.consecutive_failures > 0 {
        state.last_failure_at.map(|t| {
            t + chrono::Duration::from_std(failure_backoff(state.consecutive_failures))
                .unwrap_or(chrono::Duration::zero())
        })
    } else {
        None
    };

    let target = match failure_deadline {
        Some(f) if f > interval_deadline => f,
        _ => interval_deadline,
    };

    drop(state);

    let diff = target - now;
    diff.to_std()
        .unwrap_or(SCHEDULER_FLOOR)
        .max(SCHEDULER_FLOOR)
}

fn snapshot_from_update(update: &tauri_plugin_updater::Update) -> UpdateInfoSnapshot {
    UpdateInfoSnapshot {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        body: update.body.clone(),
        date: update.date.map(|value| value.to_string()),
        release_url: release_url_for_version(&update.version),
    }
}

// CI enforces tag == `v{package.json.version}` in .github/workflows/publish.yml,
// so every installable update has a corresponding GitHub release page at this URL.
fn release_url_for_version(version: &str) -> String {
    format!("https://github.com/dohooo/helmor/releases/tag/v{version}")
}
