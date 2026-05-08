use std::fs;
use std::time::{Duration, SystemTime};

use tempfile::TempDir;

use helmor_lib::workspace::files::editor::{write_editor_file, EditorFileWriteOptions};
use helmor_lib::workspace::files::types::EditorFileWriteOutcome;

fn fixture_with_file(content: &str) -> (TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("hello.txt");
    fs::write(&path, content).unwrap();
    (tmp, path)
}

fn current_mtime_ms(path: &std::path::Path) -> i64 {
    let m = fs::metadata(path).unwrap().modified().unwrap();
    let dur = m.duration_since(SystemTime::UNIX_EPOCH).unwrap();
    (dur.as_millis() as i64).max(0)
}

#[test]
fn write_with_no_expected_mtime_succeeds() {
    let (_tmp, path) = fixture_with_file("hi");
    let outcome = write_editor_file(
        path.to_str().unwrap(),
        "bye",
        EditorFileWriteOptions::default(),
    )
    .unwrap();
    match outcome {
        EditorFileWriteOutcome::Written { .. } => {}
        other => panic!("expected Written, got {other:?}"),
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), "bye");
}

#[test]
fn write_with_matching_expected_mtime_succeeds() {
    let (_tmp, path) = fixture_with_file("hi");
    let mtime = current_mtime_ms(&path);
    let outcome = write_editor_file(
        path.to_str().unwrap(),
        "matched",
        EditorFileWriteOptions {
            expected_mtime_ms: Some(mtime),
            overwrite: false,
        },
    )
    .unwrap();
    assert!(matches!(outcome, EditorFileWriteOutcome::Written { .. }));
    assert_eq!(fs::read_to_string(&path).unwrap(), "matched");
}

#[test]
fn write_with_stale_expected_mtime_returns_conflict() {
    let (_tmp, path) = fixture_with_file("hi");
    let stale = current_mtime_ms(&path) - 5_000;
    let outcome = write_editor_file(
        path.to_str().unwrap(),
        "should-not-write",
        EditorFileWriteOptions {
            expected_mtime_ms: Some(stale),
            overwrite: false,
        },
    )
    .unwrap();
    match outcome {
        EditorFileWriteOutcome::Conflict { .. } => {}
        other => panic!("expected Conflict, got {other:?}"),
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), "hi");
}

#[test]
fn overwrite_flag_bypasses_conflict_check() {
    let (_tmp, path) = fixture_with_file("hi");
    let stale = current_mtime_ms(&path) - 5_000;
    let outcome = write_editor_file(
        path.to_str().unwrap(),
        "force",
        EditorFileWriteOptions {
            expected_mtime_ms: Some(stale),
            overwrite: true,
        },
    )
    .unwrap();
    assert!(matches!(outcome, EditorFileWriteOutcome::Written { .. }));
    assert_eq!(fs::read_to_string(&path).unwrap(), "force");
}

#[test]
fn conflict_includes_current_mtime_for_reload() {
    let (_tmp, path) = fixture_with_file("a");
    std::thread::sleep(Duration::from_millis(20));
    fs::write(&path, "b").unwrap();
    let stale = 0i64;
    let outcome = write_editor_file(
        path.to_str().unwrap(),
        "c",
        EditorFileWriteOptions {
            expected_mtime_ms: Some(stale),
            overwrite: false,
        },
    )
    .unwrap();
    let current = current_mtime_ms(&path);
    match outcome {
        EditorFileWriteOutcome::Conflict {
            current_mtime_ms, ..
        } => {
            assert_eq!(current_mtime_ms, current);
        }
        _ => panic!("expected Conflict"),
    }
}
