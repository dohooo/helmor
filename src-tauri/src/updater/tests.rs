//! Phase 0 baseline tests for the updater module.
//!
//! These lock in the current serialization shape and configuration defaults so
//! later cross-platform refactors (Phase 2+) cannot regress them silently.

use super::events::{
    UpdateInfoSnapshot, UpdateStage, UpdateStatusSnapshot, APP_UPDATE_STATUS_EVENT,
};

#[test]
fn update_stage_serializes_as_camel_case() {
    let idle = serde_json::to_string(&UpdateStage::Idle).unwrap();
    let checking = serde_json::to_string(&UpdateStage::Checking).unwrap();
    let downloading = serde_json::to_string(&UpdateStage::Downloading).unwrap();
    let downloaded = serde_json::to_string(&UpdateStage::Downloaded).unwrap();
    let installing = serde_json::to_string(&UpdateStage::Installing).unwrap();
    let error = serde_json::to_string(&UpdateStage::Error).unwrap();
    let disabled = serde_json::to_string(&UpdateStage::Disabled).unwrap();

    assert_eq!(idle, "\"idle\"");
    assert_eq!(checking, "\"checking\"");
    assert_eq!(downloading, "\"downloading\"");
    assert_eq!(downloaded, "\"downloaded\"");
    assert_eq!(installing, "\"installing\"");
    assert_eq!(error, "\"error\"");
    assert_eq!(disabled, "\"disabled\"");
}

#[test]
fn update_stage_default_is_idle() {
    assert_eq!(UpdateStage::default(), UpdateStage::Idle);
}

#[test]
fn update_status_snapshot_disabled_shape() {
    let snap = UpdateStatusSnapshot::disabled(false, false);
    let value = serde_json::to_value(&snap).unwrap();

    assert_eq!(value["stage"], "disabled");
    assert_eq!(value["configured"], false);
    assert_eq!(value["autoUpdateEnabled"], false);
    assert!(value["update"].is_null());
    assert!(value["lastError"].is_null());
    assert!(value["lastAttemptAt"].is_null());
    assert!(value["downloadedAt"].is_null());
}

#[test]
fn update_status_snapshot_serializes_camel_case_fields() {
    let snap = UpdateStatusSnapshot {
        stage: UpdateStage::Downloaded,
        configured: true,
        auto_update_enabled: true,
        update: Some(UpdateInfoSnapshot {
            current_version: "0.1.0".into(),
            version: "0.2.0".into(),
            body: Some("release notes".into()),
            date: None,
            release_url: Some("https://example.com/release".into()),
            changelog_url: None,
        }),
        last_error: Some("network".into()),
        last_attempt_at: Some("2026-04-17T00:00:00Z".into()),
        downloaded_at: None,
    };

    let value = serde_json::to_value(&snap).unwrap();
    assert_eq!(value["stage"], "downloaded");
    assert_eq!(value["configured"], true);
    assert_eq!(value["autoUpdateEnabled"], true);
    assert_eq!(value["update"]["currentVersion"], "0.1.0");
    assert_eq!(value["update"]["version"], "0.2.0");
    assert_eq!(value["update"]["releaseUrl"], "https://example.com/release");
    assert_eq!(value["lastError"], "network");
    assert_eq!(value["lastAttemptAt"], "2026-04-17T00:00:00Z");
}

#[test]
fn app_update_status_event_name_is_stable() {
    // Frontend subscribes via this literal; cross-platform refactors must not
    // rename it.
    assert_eq!(APP_UPDATE_STATUS_EVENT, "app-update-status");
}
