//! Shared test helpers for integration tests across the crate.
//!
//! Provides `TestEnv` (isolated data dir + DB), `GitTestRepo` (temp git repos),
//! and DB fixture insertion helpers. Only compiled in `#[cfg(test)]`.

use std::path::{Path, PathBuf};
use std::sync::MutexGuard;
use std::{env, fs};

use rusqlite::Connection;
use uuid::Uuid;

use crate::data_dir::TEST_ENV_LOCK;
use crate::git_ops;

// ── TestEnv ──────────────────────────────────────────────────────────────

/// Isolated test environment: temp data directory + SQLite DB + env lock.
///
/// Holds `TEST_ENV_LOCK` for the lifetime of the test, ensuring only one
/// test at a time touches the `HELMOR_DATA_DIR` env var.
pub(crate) struct TestEnv {
    pub root: PathBuf,
    _lock: MutexGuard<'static, ()>,
}

impl TestEnv {
    pub fn new(name: &str) -> Self {
        let lock = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let root = env::temp_dir().join(format!("helmor-test-{name}-{}", Uuid::new_v4()));
        env::set_var("HELMOR_DATA_DIR", root.display().to_string());
        crate::data_dir::ensure_directory_structure().expect("failed to create test dirs");

        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        crate::models::db::init_connection(&connection, true)
            .expect("failed to apply PRAGMA init in test env");
        crate::schema::ensure_schema(&connection).expect("failed to init test DB schema");
        drop(connection);

        // Rebuild pools against the fresh tempdir. `init_pools` is re-entrant
        // so back-to-back tests each get their own isolated pools.
        crate::models::db::init_pools().expect("failed to init test DB pools");

        Self { root, _lock: lock }
    }

    pub fn db_connection(&self) -> Connection {
        let path = crate::data_dir::db_path().unwrap();
        let conn = Connection::open(&path).unwrap();
        crate::models::db::init_connection(&conn, true)
            .expect("failed to apply PRAGMA init on test connection");
        conn
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        env::remove_var("HELMOR_DATA_DIR");
        let _ = fs::remove_dir_all(&self.root);
    }
}

// ── GitTestRepo ──────────────────────────────────────────────────────────

/// A temporary git repository for testing.
#[allow(dead_code)]
pub(crate) struct GitTestRepo {
    pub dir: tempfile::TempDir,
}

impl GitTestRepo {
    /// Create a bare-bones repo on `main` with one commit.
    pub fn init() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        Self::run_git(p, &["init", "-b", "main"]);
        Self::run_git(p, &["config", "user.email", "test@helmor.test"]);
        Self::run_git(p, &["config", "user.name", "Test"]);
        Self::run_git(p, &["config", "commit.gpgsign", "false"]);
        fs::write(p.join("file.txt"), "init\n").unwrap();
        Self::run_git(p, &["add", "."]);
        Self::run_git(p, &["commit", "-m", "initial"]);
        Self { dir }
    }

    /// Create an origin repo + a clone that tracks it. Returns `(origin, clone)`.
    pub fn with_remote() -> (Self, Self) {
        let origin = Self::init();
        let clone_dir = tempfile::tempdir().unwrap();
        git_ops::run_git(
            [
                "clone",
                &origin.dir.path().display().to_string(),
                &clone_dir.path().display().to_string(),
            ],
            None,
        )
        .unwrap();
        let p = clone_dir.path();
        Self::run_git(p, &["config", "user.email", "test@helmor.test"]);
        Self::run_git(p, &["config", "user.name", "Test"]);
        Self::run_git(p, &["config", "commit.gpgsign", "false"]);
        (origin, Self { dir: clone_dir })
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    #[allow(dead_code)]
    pub fn git(&self, args: &[&str]) -> String {
        git_ops::run_git(args, Some(self.path()))
            .unwrap_or_else(|e| panic!("git {args:?} failed in {}: {e:#}", self.path().display()))
    }

    #[allow(dead_code)]
    pub fn commit_file(&self, path: &str, content: &str, msg: &str) {
        let file_path = self.path().join(path);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&file_path, content).unwrap();
        self.git(&["add", path]);
        self.git(&["commit", "-m", msg]);
    }

    fn run_git(dir: &Path, args: &[&str]) {
        git_ops::run_git(args, Some(dir))
            .unwrap_or_else(|e| panic!("git {args:?} failed in {}: {e:#}", dir.display()));
    }
}

// ── DB fixture helpers ───────────────────────────────────────────────────

pub(crate) fn insert_repo(conn: &Connection, id: &str, name: &str, remote: Option<&str>) {
    conn.execute(
        "INSERT INTO repos (id, name, default_branch, remote)
         VALUES (?1, ?2, 'main', ?3)",
        rusqlite::params![id, name, remote],
    )
    .unwrap();
}

pub(crate) struct WorkspaceFixture<'a> {
    pub id: &'a str,
    pub repo_id: &'a str,
    pub directory_name: &'a str,
    pub state: &'a str,
    pub branch: Option<&'a str>,
    pub intended_target_branch: Option<&'a str>,
}

pub(crate) fn insert_workspace(conn: &Connection, ws: &WorkspaceFixture) {
    conn.execute(
        "INSERT INTO workspaces (id, repository_id, directory_name, state, status, branch, intended_target_branch, display_order)
         VALUES (?1, ?2, ?3, ?4, 'in-progress', ?5, ?6, ?7)",
        rusqlite::params![
            ws.id,
            ws.repo_id,
            ws.directory_name,
            ws.state,
            ws.branch,
            ws.intended_target_branch,
            crate::workspace::sidebar_order::ORDER_STEP,
        ],
    )
    .unwrap();
}
