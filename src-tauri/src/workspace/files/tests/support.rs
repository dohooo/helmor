use std::{fs, path::PathBuf};

use rusqlite::Connection;
use uuid::Uuid;

use crate::git_ops;

use super::{list_workspace_changes, EditorFileListItem};

pub(super) struct TestDataDir {
    pub(super) root: PathBuf,
}

impl TestDataDir {
    pub(super) fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("helmor-test-{name}-{}", Uuid::new_v4()));
        std::env::set_var("HELMOR_DATA_DIR", root.display().to_string());
        crate::data_dir::ensure_directory_structure().unwrap();

        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        crate::schema::ensure_schema(&connection).unwrap();

        Self { root }
    }
}

impl Drop for TestDataDir {
    fn drop(&mut self) {
        std::env::remove_var("HELMOR_DATA_DIR");
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub(super) struct EditorFilesHarness {
    _test_dir: TestDataDir,
    pub(super) workspace_dir: PathBuf,
    pub(super) outside_dir: PathBuf,
}

impl EditorFilesHarness {
    pub(super) fn new() -> Self {
        let test_dir = TestDataDir::new("editor-files");
        let source_repo_root = test_dir.root.join("source-repo");
        fs::create_dir_all(&source_repo_root).unwrap();

        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        connection
            .execute(
                "INSERT INTO repos (id, name, root_path) VALUES ('repo-1', 'helmor', ?1)",
                [source_repo_root.display().to_string()],
            )
            .unwrap();
        connection
			.execute(
				"INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status) VALUES ('workspace-1', 'repo-1', 'editor-mode', 'ready', 'in-progress')",
				[],
			)
			.unwrap();

        let workspace_dir = crate::data_dir::workspace_dir("helmor", "editor-mode").unwrap();
        fs::create_dir_all(&workspace_dir).unwrap();

        let outside_dir = test_dir.root.join("outside");
        fs::create_dir_all(&outside_dir).unwrap();

        Self {
            _test_dir: test_dir,
            workspace_dir,
            outside_dir,
        }
    }
}

pub(super) struct GitRepoHarness {
    root: PathBuf,
    _temp: tempfile::TempDir,
}

impl GitRepoHarness {
    pub(super) fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();

        git_ops::run_git(["init", "-b", "main"], Some(&root)).unwrap();
        git_ops::run_git(["config", "user.email", "test@helmor.test"], Some(&root)).unwrap();
        git_ops::run_git(["config", "user.name", "Test"], Some(&root)).unwrap();

        fs::write(root.join("README.md"), "# Test\n").unwrap();
        git_ops::run_git(["add", "."], Some(&root)).unwrap();
        git_ops::run_git(["commit", "-m", "init"], Some(&root)).unwrap();
        git_ops::run_git(["checkout", "-b", "feature/test"], Some(&root)).unwrap();

        Self { root, _temp: temp }
    }

    pub(super) fn path_str(&self) -> &str {
        self.root.to_str().unwrap()
    }

    pub(super) fn write_file(&self, relative: &str, content: &str) {
        let absolute = self.root.join(relative);
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(absolute, content).unwrap();
    }

    pub(super) fn git(&self, args: &[&str]) -> String {
        git_ops::run_git(args.iter().copied(), Some(&self.root)).unwrap_or_default()
    }

    pub(super) fn changes(&self) -> Vec<EditorFileListItem> {
        list_workspace_changes(self.path_str()).unwrap()
    }

    pub(super) fn find(&self, path: &str) -> Option<EditorFileListItem> {
        self.changes().into_iter().find(|item| item.path == path)
    }
}

pub(super) fn test_db_with_workspace(
    remote: Option<&str>,
    target: Option<&str>,
    default_branch: &str,
) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::schema::ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO repos (id, name, default_branch, remote) VALUES ('r1', 'test-repo', ?1, ?2)",
        rusqlite::params![default_branch, remote],
    )
    .unwrap();
    conn.execute(
		"INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status, intended_target_branch)
		 VALUES ('w1', 'r1', 'ws-dir', 'ready', 'in-progress', ?1)",
		rusqlite::params![target],
	)
	.unwrap();
    conn
}
