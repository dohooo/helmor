use chrono::{DateTime, Utc};
use tauri_plugin_updater::Update;

use super::events::{UpdateInfoSnapshot, UpdateStage, UpdateStatusSnapshot};

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
}

impl UpdateRuntimeState {
    pub fn snapshot(&self, configured: bool, auto_update_enabled: bool) -> UpdateStatusSnapshot {
        UpdateStatusSnapshot {
            stage: if !configured || !auto_update_enabled && self.pending_update.is_none() {
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
        }
    }
}
