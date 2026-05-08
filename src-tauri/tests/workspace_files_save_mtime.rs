use std::fs;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, SystemTime};

use helmor_lib::data_dir;
use helmor_lib::db;
use helmor_lib::workspace::files::editor::{write_editor_file, EditorFileWriteOptions};
use helmor_lib::workspace::files::types::EditorFileWriteOutcome;
use tempfile::TempDir;

/// Serialize intra-binary access to the process-wide `HELMOR_DATA_DIR`
/// env var. Cargo runs each test binary in its own OS process, so we
/// don't need to coordinate with the unit-test crate's own lock.
static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// RAII test env: takes the env-var lock, overrides `HELMOR_DATA_DIR`,
/// runs migrations, registers a Local-mode workspace whose repo root
/// points at a tempdir, and cleans up on drop.
///
/// `resolve_allowed_path` consults `models::workspaces::load_workspace_records`
/// to decide whether a path lives inside a known workspace, so each test
/// needs a real DB row pointing at the directory containing the file
/// under test.
struct WorkspaceEnv {
    workspace_root: TempDir,
    _data_dir: TempDir,
    _lock: MutexGuard<'static, ()>,
}

impl WorkspaceEnv {
    fn new() -> Self {
        let lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let data = tempfile::tempdir().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", data.path());
        data_dir::ensure_directory_structure().unwrap();
        let conn = rusqlite::Connection::open(data_dir::db_path().unwrap()).unwrap();
        helmor_lib::schema::ensure_schema(&conn).unwrap();
        db::init_pools().unwrap();

        let workspace_root = tempfile::tempdir().unwrap();
        // Canonicalize so the stored root_path matches what
        // `path_is_inside_known_workspace` produces from
        // `canonicalize_missing_path` on the file we save into it.
        let root_str = workspace_root
            .path()
            .canonicalize()
            .unwrap()
            .display()
            .to_string();
        conn.execute(
            "INSERT INTO repos (id, name, default_branch, root_path) VALUES ('r-1', 'test-repo', 'main', ?1)",
            [&root_str],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, mode, state, status)
             VALUES ('w-1', 'r-1', 'test-ws', 'local', 'ready', 'in-progress')",
            [],
        )
        .unwrap();

        Self {
            workspace_root,
            _data_dir: data,
            _lock: lock,
        }
    }

    fn file(&self, name: &str, content: &str) -> std::path::PathBuf {
        let path = self.workspace_root.path().join(name);
        fs::write(&path, content).unwrap();
        path
    }

    fn path(&self, name: &str) -> std::path::PathBuf {
        self.workspace_root.path().join(name)
    }
}

impl Drop for WorkspaceEnv {
    fn drop(&mut self) {
        std::env::remove_var("HELMOR_DATA_DIR");
    }
}

fn current_mtime_ms(path: &std::path::Path) -> i64 {
    let m = fs::metadata(path).unwrap().modified().unwrap();
    let dur = m.duration_since(SystemTime::UNIX_EPOCH).unwrap();
    (dur.as_millis() as i64).max(0)
}

#[test]
fn write_with_no_expected_mtime_succeeds() {
    let env = WorkspaceEnv::new();
    let path = env.file("hello.txt", "hi");
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
    let env = WorkspaceEnv::new();
    let path = env.file("hello.txt", "hi");
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
    let env = WorkspaceEnv::new();
    let path = env.file("hello.txt", "hi");
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
    let env = WorkspaceEnv::new();
    let path = env.file("hello.txt", "hi");
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
    let env = WorkspaceEnv::new();
    let path = env.file("hello.txt", "a");
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

#[test]
fn rejects_writing_to_a_directory() {
    let env = WorkspaceEnv::new();
    let dir_path = env.path("subdir");
    fs::create_dir(&dir_path).unwrap();
    let err = write_editor_file(
        dir_path.to_str().unwrap(),
        "boom",
        EditorFileWriteOptions::default(),
    )
    .unwrap_err();
    assert!(err.to_string().to_lowercase().contains("not a file"));
}
