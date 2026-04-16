use std::sync::{Mutex, OnceLock};
use std::thread;

use chrono::Utc;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_updater::UpdaterExt;

use super::config::{UpdateBehavior, UpdaterConfig};
use super::events::{
    UpdateInfoSnapshot, UpdateStage, UpdateStatusSnapshot, APP_UPDATE_STATUS_EVENT,
};
use super::state::{PendingUpdate, UpdateRuntimeState};

static UPDATE_MANAGER: OnceLock<UpdateManager> = OnceLock::new();

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
    let _ = UPDATE_MANAGER.set(UpdateManager {
        config,
        state: Mutex::new(UpdateRuntimeState {
            stage: UpdateStage::Idle,
            ..UpdateRuntimeState::default()
        }),
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

pub fn spawn_interval_worker<R: Runtime>(app: AppHandle<R>) {
    let app_handle = app.clone();
    if let Err(error) = thread::Builder::new()
        .name("app-update-poller".into())
        .spawn(move || loop {
            thread::sleep(std::time::Duration::from_secs(60));
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
    }

    manager.emit_status(&app, &behavior);

    let result = manager.do_check(&app).await;

    let snapshot = {
        let mut state = manager.state.lock().expect("update state poisoned");
        state.in_flight = false;

        match result {
            Ok(Some(pending)) => {
                state.stage = UpdateStage::Downloaded;
                state.last_success_at = Some(Utc::now());
                state.downloaded_at = Some(Utc::now());
                state.last_error = None;
                state.pending_update = Some(pending);
            }
            Ok(None) => {
                state.stage = UpdateStage::Idle;
                state.last_success_at = Some(Utc::now());
                state.last_error = None;
            }
            Err(error) => {
                state.stage = UpdateStage::Error;
                state.last_error = Some(error.to_string());
                state.last_failure_at = Some(Utc::now());
            }
        }

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
            #[cfg(not(target_os = "windows"))]
            app.request_restart();

            UpdateStatusSnapshot {
                stage: UpdateStage::Installing,
                configured: manager.config.is_configured(),
                auto_update_enabled: behavior.auto_update_enabled,
                update: Some(pending.info),
                last_error: None,
                last_attempt_at: None,
                downloaded_at: None,
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
        }

        let bytes = update.download(|_, _| {}, || {}).await?;
        Ok(Some(PendingUpdate {
            update,
            bytes,
            info,
        }))
    }
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
        if (now - last_failure_at)
            .to_std()
            .ok()
            .is_some_and(|elapsed| elapsed < behavior.failure_backoff)
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

fn snapshot_from_update(update: &tauri_plugin_updater::Update) -> UpdateInfoSnapshot {
    let release_url = raw_json_string(&update.raw_json, &["releaseUrl", "release_url"]);
    let changelog_url = raw_json_string(&update.raw_json, &["changelogUrl", "changelog_url"]);

    UpdateInfoSnapshot {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        body: update.body.clone(),
        date: update.date.map(|value| value.to_string()),
        release_url,
        changelog_url,
    }
}

fn raw_json_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    })
}
