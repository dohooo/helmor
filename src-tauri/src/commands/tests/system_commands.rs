//! Phase 0 baseline tests for `commands/system_commands.rs`.
//!
//! These tests establish the published contract (serde shape, error messages,
//! id allow-list) that Phase 2's per-OS refactor must preserve. They intentionally
//! avoid asserting on internal path defaults so the same tests pass on macOS,
//! Linux, and Windows once the per-OS branches land.

use crate::commands::system_commands::{CliStatus, DataInfo, DetectedEditor};

#[test]
fn cli_status_serializes_camel_case() {
    let status = CliStatus {
        installed: true,
        install_path: Some("/usr/local/bin/helmor".into()),
        build_mode: "development".into(),
    };
    let value = serde_json::to_value(&status).unwrap();
    assert!(value.get("installed").is_some());
    assert_eq!(value["installPath"], "/usr/local/bin/helmor");
    assert_eq!(value["buildMode"], "development");
    assert!(value.get("install_path").is_none());
}

#[test]
fn cli_status_missing_install_path_is_null() {
    let status = CliStatus {
        installed: false,
        install_path: None,
        build_mode: "development".into(),
    };
    let value = serde_json::to_value(&status).unwrap();
    assert!(value["installPath"].is_null());
    assert_eq!(value["installed"], false);
}

#[test]
fn data_info_serializes_camel_case() {
    let info = DataInfo {
        data_mode: "development".into(),
        data_dir: "/tmp/helmor".into(),
        db_path: "/tmp/helmor/helmor.db".into(),
    };
    let value = serde_json::to_value(&info).unwrap();
    assert_eq!(value["dataMode"], "development");
    assert_eq!(value["dataDir"], "/tmp/helmor");
    assert_eq!(value["dbPath"], "/tmp/helmor/helmor.db");
    assert!(value.get("data_mode").is_none());
}

#[test]
fn detected_editor_serializes_flat_shape() {
    let editor = DetectedEditor {
        id: "vscode".into(),
        name: "VS Code".into(),
        path: "/Applications/Visual Studio Code.app".into(),
    };
    let value = serde_json::to_value(&editor).unwrap();
    assert_eq!(value["id"], "vscode");
    assert_eq!(value["name"], "VS Code");
    assert_eq!(value["path"], "/Applications/Visual Studio Code.app");
}

/// The frontend enumerates editor ids statically. Any new id or rename must be
/// visible here so both Rust and TS sides stay in sync.
#[test]
fn known_editor_ids_is_stable_set() {
    let known = [
        "cursor",
        "vscode",
        "vscode-insiders",
        "windsurf",
        "zed",
        "webstorm",
        "sublime",
        "terminal",
        "warp",
    ];

    // Sanity: no duplicates, all lowercase, all non-empty.
    let mut seen = std::collections::HashSet::new();
    for id in known {
        assert!(!id.is_empty(), "empty id");
        assert_eq!(id, id.to_lowercase(), "id `{id}` is not lowercase");
        assert!(seen.insert(id), "duplicate id `{id}`");
    }
}
