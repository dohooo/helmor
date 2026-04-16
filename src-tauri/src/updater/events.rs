use serde::Serialize;

pub const APP_UPDATE_STATUS_EVENT: &str = "app-update-status";

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStage {
    Disabled,
    #[default]
    Idle,
    Checking,
    Downloading,
    Downloaded,
    Installing,
    Error,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfoSnapshot {
    pub current_version: String,
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
    pub release_url: Option<String>,
    pub changelog_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusSnapshot {
    pub stage: UpdateStage,
    pub configured: bool,
    pub auto_update_enabled: bool,
    pub update: Option<UpdateInfoSnapshot>,
    pub last_error: Option<String>,
    pub last_attempt_at: Option<String>,
    pub downloaded_at: Option<String>,
}

impl UpdateStatusSnapshot {
    pub fn disabled(configured: bool, auto_update_enabled: bool) -> Self {
        Self {
            stage: UpdateStage::Disabled,
            configured,
            auto_update_enabled,
            update: None,
            last_error: None,
            last_attempt_at: None,
            downloaded_at: None,
        }
    }
}
