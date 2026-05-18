use chrono::{DateTime, Utc};
use tauri_plugin_updater::Update;

use crate::settings;

use super::events::{DownloadProgress, UpdateInfoSnapshot, UpdateStage, UpdateStatusSnapshot};

#[derive(Clone)]
pub struct PendingUpdate {
    pub update: Update,
    pub bytes: Vec<u8>,
    pub info: UpdateInfoSnapshot,
}

#[derive(Default)]
pub struct UpdateRuntimeState {
    pub stage: UpdateStage,
    pub in_flight: bool,
    pub pending_update: Option<PendingUpdate>,
    pub last_error: Option<String>,
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub downloaded_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_failure_at: Option<DateTime<Utc>>,
    pub consecutive_failures: u32,
    pub download_progress: Option<DownloadProgress>,
}

impl UpdateRuntimeState {
    pub fn snapshot(&self, configured: bool, auto_update_enabled: bool) -> UpdateStatusSnapshot {
        let effective_disabled =
            !configured || (!auto_update_enabled && self.pending_update.is_none());
        UpdateStatusSnapshot {
            stage: if effective_disabled {
                UpdateStage::Disabled
            } else {
                self.stage
            },
            configured,
            auto_update_enabled,
            update: self
                .pending_update
                .as_ref()
                .map(|pending| pending.info.clone()),
            last_error: self.last_error.clone(),
            last_attempt_at: self.last_attempt_at.map(|value| value.to_rfc3339()),
            downloaded_at: self.downloaded_at.map(|value| value.to_rfc3339()),
            progress: if matches!(self.stage, UpdateStage::Downloading) {
                self.download_progress
            } else {
                None
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Persistence — outlive process restarts so the interval scheduler and
// failure backoff don't reset every launch (that's why every cold-start
// used to fire a check; with persistence we honor the actual cadence).
// ---------------------------------------------------------------------------

const KEY_LAST_ATTEMPT_AT: &str = "app.updater.last_attempt_at";
const KEY_LAST_SUCCESS_AT: &str = "app.updater.last_success_at";
const KEY_LAST_FAILURE_AT: &str = "app.updater.last_failure_at";
const KEY_CONSECUTIVE_FAILURES: &str = "app.updater.consecutive_failures";

pub fn load_persisted(state: &mut UpdateRuntimeState) {
    state.last_attempt_at = load_datetime(KEY_LAST_ATTEMPT_AT);
    state.last_success_at = load_datetime(KEY_LAST_SUCCESS_AT);
    state.last_failure_at = load_datetime(KEY_LAST_FAILURE_AT);
    state.consecutive_failures = load_u32(KEY_CONSECUTIVE_FAILURES);
}

pub fn persist(state: &UpdateRuntimeState) {
    save_optional_datetime(KEY_LAST_ATTEMPT_AT, state.last_attempt_at);
    save_optional_datetime(KEY_LAST_SUCCESS_AT, state.last_success_at);
    save_optional_datetime(KEY_LAST_FAILURE_AT, state.last_failure_at);
    save_u32(KEY_CONSECUTIVE_FAILURES, state.consecutive_failures);
}

fn load_datetime(key: &str) -> Option<DateTime<Utc>> {
    settings::load_setting_value(key)
        .ok()
        .flatten()
        .and_then(|raw| DateTime::parse_from_rfc3339(raw.trim()).ok())
        .map(|dt| dt.with_timezone(&Utc))
}

fn load_u32(key: &str) -> u32 {
    settings::load_setting_value(key)
        .ok()
        .flatten()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

fn save_optional_datetime(key: &str, value: Option<DateTime<Utc>>) {
    let result = match value {
        Some(dt) => settings::upsert_setting_value(key, &dt.to_rfc3339()),
        None => settings::delete_setting_value(key),
    };
    if let Err(error) = result {
        tracing::warn!(key, error = %error, "Failed to persist updater state");
    }
}

fn save_u32(key: &str, value: u32) {
    if let Err(error) = settings::upsert_setting_value(key, &value.to_string()) {
        tracing::warn!(key, error = %error, "Failed to persist updater state");
    }
}
