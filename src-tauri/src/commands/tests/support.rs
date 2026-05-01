pub(crate) use crate::data_dir::TEST_ENV_LOCK as TEST_LOCK;
pub(crate) use crate::{git_ops, helpers, repos, sessions, workspaces};
pub(crate) use rusqlite::Connection;
pub(crate) use std::fs;
pub(crate) use std::path::{Path, PathBuf};

struct TestDataDir {
    root: PathBuf,
}

impl TestDataDir {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("helmor-test-{name}-{}", uuid::Uuid::new_v4()));
        std::env::set_var("HELMOR_DATA_DIR", root.display().to_string());
        crate::data_dir::ensure_directory_structure().unwrap();
        // Match production startup order: schema first, pools second.
        let schema_conn =
            Connection::open(crate::data_dir::db_path().unwrap()).expect("open schema conn");
        crate::schema::ensure_schema(&schema_conn).expect("ensure_schema in test setup");
        drop(schema_conn);
        crate::models::db::init_pools().expect("failed to init test DB pools");
        Self { root }
    }

    fn db_path(&self) -> PathBuf {
        crate::data_dir::db_path().unwrap()
    }
}

impl Drop for TestDataDir {
    fn drop(&mut self) {
        std::env::remove_var("HELMOR_DATA_DIR");
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub(crate) struct RestoreTestHarness {
    _test_dir: TestDataDir,
    pub(crate) root: PathBuf,
    pub(crate) source_repo_root: PathBuf,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) repo_name: String,
    pub(crate) directory_name: String,
    pub(crate) branch: String,
}

impl RestoreTestHarness {
    pub(crate) fn new() -> Self {
        Self::build(false)
    }

    /// Variant that installs a `BEFORE UPDATE` trigger on `workspaces`,
    /// forcing `update_restored_workspace_state` to fail. Used to exercise
    /// the cleanup path in `restore_workspace_impl`.
    pub(crate) fn new_with_blocked_workspace_update() -> Self {
        Self::build(true)
    }

    fn build(block_workspace_updates: bool) -> Self {
        let test_dir = TestDataDir::new("restore");
        let root = test_dir.root.clone();
        let source_repo_root = root.join("source-repo");

        fs::create_dir_all(&source_repo_root).unwrap();
        init_git_repo(&source_repo_root);

        let archive_commit = git_ops::run_git(
            [
                "-C",
                source_repo_root.to_str().unwrap(),
                "rev-parse",
                "HEAD",
            ],
            None,
        )
        .unwrap();

        git_ops::run_git(
            ["-C", source_repo_root.to_str().unwrap(), "checkout", "main"],
            None,
        )
        .unwrap();

        let repo_name = "demo-repo".to_string();
        let directory_name = "archived-city".to_string();
        let workspace_id = "workspace-1".to_string();
        let session_id = "session-1".to_string();
        let branch = "feature/restore-target".to_string();

        let ws_dir = crate::data_dir::workspace_dir(&repo_name, &directory_name).unwrap();
        fs::create_dir_all(ws_dir.parent().unwrap()).unwrap();

        create_archived_fixture_db(
            &test_dir.db_path(),
            &source_repo_root,
            &repo_name,
            &directory_name,
            &workspace_id,
            &session_id,
            &branch,
            &archive_commit,
        );

        if block_workspace_updates {
            install_workspace_update_blocker(&test_dir.db_path());
        }

        Self {
            _test_dir: test_dir,
            root,
            source_repo_root,
            workspace_id,
            session_id,
            repo_name,
            directory_name,
            branch,
        }
    }

    pub(crate) fn workspace_dir(&self) -> PathBuf {
        crate::data_dir::workspace_dir(&self.repo_name, &self.directory_name).unwrap()
    }

    pub(crate) fn source_repo_root(&self) -> PathBuf {
        self.root.join("source-repo")
    }
}

pub(crate) struct ArchiveTestHarness {
    _test_dir: TestDataDir,
    pub(crate) root: PathBuf,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) repo_name: String,
    pub(crate) directory_name: String,
    pub(crate) head_commit: String,
}

impl ArchiveTestHarness {
    pub(crate) fn new() -> Self {
        Self::build(false)
    }

    /// Variant that installs a `BEFORE UPDATE` trigger on `workspaces`,
    /// forcing `update_archived_workspace_state` to fail. Used to exercise
    /// the cleanup path in `archive_workspace_impl`.
    pub(crate) fn new_with_blocked_workspace_update() -> Self {
        Self::build(true)
    }

    fn build(block_workspace_updates: bool) -> Self {
        let test_dir = TestDataDir::new("archive");
        let root = test_dir.root.clone();
        let source_repo_root = root.join("source-repo");

        fs::create_dir_all(&source_repo_root).unwrap();
        init_git_repo(&source_repo_root);

        let repo_name = "demo-repo".to_string();
        let directory_name = "ready-city".to_string();
        let workspace_id = "workspace-archive".to_string();
        let session_id = "session-archive".to_string();
        let branch = "feature/restore-target".to_string();
        let head_commit = git_ops::run_git(
            [
                "-C",
                source_repo_root.to_str().unwrap(),
                "rev-parse",
                "HEAD",
            ],
            None,
        )
        .unwrap();

        let ws_parent = crate::data_dir::workspaces_dir().unwrap().join(&repo_name);
        fs::create_dir_all(&ws_parent).unwrap();

        create_ready_fixture_db(
            &test_dir.db_path(),
            &source_repo_root,
            &repo_name,
            &directory_name,
            &workspace_id,
            &session_id,
            &branch,
        );

        if block_workspace_updates {
            install_workspace_update_blocker(&test_dir.db_path());
        }

        let workspace_dir = crate::data_dir::workspace_dir(&repo_name, &directory_name).unwrap();
        git_ops::point_branch_to_commit(&source_repo_root, &branch, &head_commit).unwrap();
        git_ops::create_worktree(&source_repo_root, &workspace_dir, &branch).unwrap();

        Self {
            _test_dir: test_dir,
            root,
            workspace_id,
            session_id,
            repo_name,
            directory_name,
            head_commit,
        }
    }

    pub(crate) fn workspace_dir(&self) -> PathBuf {
        crate::data_dir::workspace_dir(&self.repo_name, &self.directory_name).unwrap()
    }

    pub(crate) fn source_repo_root(&self) -> PathBuf {
        self.root.join("source-repo")
    }

    pub(crate) fn archived_context_dir(&self) -> PathBuf {
        self.root.join("archived-contexts").join(&self.workspace_id)
    }

    pub(crate) fn set_state(&self, state: &str) {
        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        connection
            .execute(
                "UPDATE workspaces SET state = ?2 WHERE id = ?1",
                (&self.workspace_id, state),
            )
            .unwrap();
    }
}

pub(crate) struct CreateTestHarness {
    _test_dir: TestDataDir,
    pub(crate) root: PathBuf,
    pub(crate) source_repo_root: PathBuf,
    pub(crate) repo_id: String,
    pub(crate) repo_name: String,
}

impl CreateTestHarness {
    pub(crate) fn new() -> Self {
        let test_dir = TestDataDir::new("create");
        let root = test_dir.root.clone();
        let source_repo_root = root.join("source-repo");
        let repo_id = "repo-create".to_string();
        let repo_name = "demo-repo".to_string();

        fs::create_dir_all(&source_repo_root).unwrap();
        init_create_git_repo(&source_repo_root);

        create_workspace_fixture_db(&test_dir.db_path(), &source_repo_root, &repo_id, &repo_name);

        Self {
            _test_dir: test_dir,
            root,
            source_repo_root,
            repo_id,
            repo_name,
        }
    }

    pub(crate) fn db_path(&self) -> PathBuf {
        crate::data_dir::db_path().unwrap()
    }

    pub(crate) fn workspace_dir(&self, directory_name: &str) -> PathBuf {
        crate::data_dir::workspace_dir(&self.repo_name, directory_name).unwrap()
    }

    pub(crate) fn insert_workspace_name(&self, directory_name: &str) {
        let connection = Connection::open(self.db_path()).unwrap();
        connection
            .execute(
                r#"
                INSERT INTO workspaces (
                  id, repository_id, directory_name, active_session_id, branch,
                  state, initialization_parent_branch,
                  intended_target_branch, status, unread
                ) VALUES (?1, ?2, ?3, NULL, ?4, 'ready', 'main', 'main', 'in-progress', 0)
                "#,
                (
                    format!("workspace-{directory_name}"),
                    &self.repo_id,
                    directory_name,
                    format!("testuser/{directory_name}"),
                ),
            )
            .unwrap();
    }

    pub(crate) fn insert_repo(
        &self,
        repo_id: &str,
        repo_name: &str,
        display_order: i64,
        hidden: i64,
    ) {
        let connection = Connection::open(self.db_path()).unwrap();
        // Production schema enforces UNIQUE(repos.root_path), so each
        // synthetic repo needs its own path even though the test never
        // touches the filesystem under it.
        let synthetic_root = self.root.join(format!("synthetic-{repo_id}"));
        connection
            .execute(
                r#"
                INSERT INTO repos (
                  id, remote_url, name, default_branch, root_path, display_order, hidden
                ) VALUES (?1, NULL, ?2, 'main', ?3, ?4, ?5)
                "#,
                (
                    repo_id,
                    repo_name,
                    synthetic_root.to_str().unwrap(),
                    display_order,
                    hidden,
                ),
            )
            .unwrap();
    }

    pub(crate) fn commit_repo_files(&self, files: &[(&str, &str)]) {
        for (relative_path, contents) in files {
            let path = self.source_repo_root.join(relative_path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, contents).unwrap();
            make_executable_if_script(&path);
            git_ops::run_git(
                [
                    "-C",
                    self.source_repo_root.to_str().unwrap(),
                    "add",
                    relative_path,
                ],
                None,
            )
            .unwrap();
        }

        let root = self.source_repo_root.to_str().unwrap();
        git_ops::run_git(
            [
                "-C",
                root,
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Helmor",
                "-c",
                "user.email=helmor@example.com",
                "commit",
                "-m",
                &format!("add {}", files[0].0),
            ],
            None,
        )
        .unwrap();
        git_ops::run_git(["-C", root, "fetch", "origin"], None).unwrap();
    }
}

pub(crate) struct BranchSwitchTestHarness {
    _test_dir: TestDataDir,
    pub(crate) upstream_repo: PathBuf,
    #[allow(dead_code)]
    pub(crate) source_repo: PathBuf,
    pub(crate) workspace_id: String,
    repo_name: String,
    directory_name: String,
    #[allow(dead_code)]
    workspace_branch: String,
}

impl BranchSwitchTestHarness {
    pub(crate) fn new() -> Self {
        let test_dir = TestDataDir::new("branch-switch");
        let root = test_dir.root.clone();

        let upstream_repo = root.join("upstream");
        fs::create_dir_all(&upstream_repo).unwrap();
        init_branch_switch_repo(&upstream_repo);

        run_in_repo(&upstream_repo, &["checkout", "-b", "dev"]);
        commit_file(&upstream_repo, "dev1.txt", "dev one", "add dev1");

        run_in_repo(&upstream_repo, &["checkout", "main"]);
        run_in_repo(&upstream_repo, &["checkout", "-b", "feature/work"]);
        commit_file(
            &upstream_repo,
            "feature1.txt",
            "feature one",
            "add feature1",
        );
        run_in_repo(&upstream_repo, &["checkout", "main"]);

        let source_repo = root.join("source");
        git_ops::run_git(
            [
                "clone",
                upstream_repo.to_str().unwrap(),
                source_repo.to_str().unwrap(),
            ],
            None,
        )
        .unwrap();
        run_in_repo(
            &source_repo,
            &["config", "user.email", "helmor@example.com"],
        );
        run_in_repo(&source_repo, &["config", "user.name", "Helmor"]);
        run_in_repo(&source_repo, &["config", "commit.gpgsign", "false"]);

        let repo_name = "demo-repo".to_string();
        let directory_name = "branch-switch-ws".to_string();
        let workspace_id = "branch-switch-1".to_string();
        let workspace_branch = "test/switch-branch".to_string();

        let workspace_dir = crate::data_dir::workspace_dir(&repo_name, &directory_name).unwrap();
        fs::create_dir_all(workspace_dir.parent().unwrap()).unwrap();

        git_ops::create_worktree_from_start_point(
            &source_repo,
            &workspace_dir,
            &workspace_branch,
            "origin/main",
        )
        .unwrap();

        create_branch_switch_fixture_db(
            &test_dir.db_path(),
            &source_repo,
            &repo_name,
            &directory_name,
            &workspace_id,
            &workspace_branch,
        );

        workspaces::_reset_prefetch_rate_limit();

        Self {
            _test_dir: test_dir,
            upstream_repo,
            source_repo,
            workspace_id,
            repo_name,
            directory_name,
            workspace_branch,
        }
    }

    pub(crate) fn workspace_dir(&self) -> PathBuf {
        crate::data_dir::workspace_dir(&self.repo_name, &self.directory_name).unwrap()
    }

    pub(crate) fn workspace_head(&self) -> String {
        git_ops::current_workspace_head_commit(&self.workspace_dir()).unwrap()
    }

    pub(crate) fn workspace_remote_ref_sha(&self, branch: &str) -> String {
        git_ops::remote_ref_sha(&self.workspace_dir(), "origin", branch).unwrap()
    }

    pub(crate) fn intent_in_db(&self) -> String {
        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        connection
            .query_row(
                "SELECT intended_target_branch FROM workspaces WHERE id = ?1",
                [&self.workspace_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    pub(crate) fn init_parent_in_db(&self) -> Option<String> {
        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        connection
            .query_row(
                "SELECT initialization_parent_branch FROM workspaces WHERE id = ?1",
                [&self.workspace_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    pub(crate) fn set_state(&self, state: &str) {
        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        connection
            .execute(
                "UPDATE workspaces SET state = ?2 WHERE id = ?1",
                (&self.workspace_id, state),
            )
            .unwrap();
    }

    pub(crate) fn set_init_parent(&self, init_parent: Option<&str>) {
        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        connection
            .execute(
                "UPDATE workspaces SET initialization_parent_branch = ?2 WHERE id = ?1",
                rusqlite::params![&self.workspace_id, init_parent],
            )
            .unwrap();
    }

    pub(crate) fn upstream_advance(&self, branch: &str, file: &str, contents: &str, msg: &str) {
        run_in_repo(&self.upstream_repo, &["checkout", branch]);
        fs::write(self.upstream_repo.join(file), contents).unwrap();
        run_in_repo(&self.upstream_repo, &["add", file]);
        run_in_repo(&self.upstream_repo, &["commit", "-m", msg]);
        run_in_repo(&self.upstream_repo, &["checkout", "main"]);
    }

    pub(crate) fn dirty_tracked_file(&self) {
        fs::write(self.workspace_dir().join("README.md"), "user edits").unwrap();
    }

    pub(crate) fn add_untracked_file(&self) {
        fs::write(self.workspace_dir().join("scratch.txt"), "scratchpad").unwrap();
    }

    pub(crate) fn commit_in_workspace(&self, file: &str, contents: &str, msg: &str) {
        let dir = self.workspace_dir();
        fs::write(dir.join(file), contents).unwrap();
        run_in_repo(&dir, &["add", file]);
        run_in_repo(&dir, &["commit", "-m", msg]);
    }
}

fn init_create_git_repo(repo_root: &Path) {
    let root = repo_root.to_str().unwrap();
    git_ops::run_git(["init", "-b", "main", root], None).unwrap();
    fs::write(repo_root.join("tracked.txt"), "main").unwrap();
    git_ops::run_git(["-C", root, "add", "tracked.txt"], None).unwrap();
    git_ops::run_git(
        [
            "-C",
            root,
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Helmor",
            "-c",
            "user.email=helmor@example.com",
            "commit",
            "-m",
            "initial",
        ],
        None,
    )
    .unwrap();
    git_ops::run_git(["-C", root, "remote", "add", "origin", root], None).unwrap();
    git_ops::run_git(["-C", root, "fetch", "origin"], None).unwrap();
}

fn make_executable_if_script(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if path.extension().and_then(|value| value.to_str()) == Some("sh") {
        let metadata = fs::metadata(path).unwrap();
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }
}

fn init_git_repo(repo_root: &Path) {
    git_ops::run_git(["init", "-b", "main", repo_root.to_str().unwrap()], None).unwrap();
    fs::write(repo_root.join("tracked.txt"), "main").unwrap();
    git_ops::run_git(
        ["-C", repo_root.to_str().unwrap(), "add", "tracked.txt"],
        None,
    )
    .unwrap();
    git_ops::run_git(
        [
            "-C",
            repo_root.to_str().unwrap(),
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Helmor",
            "-c",
            "user.email=helmor@example.com",
            "commit",
            "-m",
            "initial",
        ],
        None,
    )
    .unwrap();
    git_ops::run_git(
        [
            "-C",
            repo_root.to_str().unwrap(),
            "checkout",
            "-b",
            "feature/restore-target",
        ],
        None,
    )
    .unwrap();
    fs::write(repo_root.join("tracked.txt"), "archived snapshot").unwrap();
    git_ops::run_git(
        ["-C", repo_root.to_str().unwrap(), "add", "tracked.txt"],
        None,
    )
    .unwrap();
    git_ops::run_git(
        [
            "-C",
            repo_root.to_str().unwrap(),
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Helmor",
            "-c",
            "user.email=helmor@example.com",
            "commit",
            "-m",
            "archived snapshot",
        ],
        None,
    )
    .unwrap();
    git_ops::run_git(
        ["-C", repo_root.to_str().unwrap(), "checkout", "main"],
        None,
    )
    .unwrap();
}

/// Open a connection to a fixture DB. Schema is already applied by
/// `TestDataDir::new`, so this is just a thin `Connection::open` wrapper
/// kept for symmetry with the rest of the fixture helpers.
fn open_fixture_db(db_path: &Path) -> Connection {
    Connection::open(db_path).unwrap()
}

/// Install a trigger that fails only on UPDATEs touching `workspaces.state`.
/// Lets tests exercise the cleanup path in `update_archived_workspace_state` /
/// `update_restored_workspace_state` without disturbing the earlier
/// branch-name UPDATE that runs first in `restore_workspace_impl`.
fn install_workspace_update_blocker(db_path: &Path) {
    let connection = Connection::open(db_path).unwrap();
    connection
        .execute_batch(
            r#"
            CREATE TRIGGER block_workspace_state_update
            BEFORE UPDATE OF state ON workspaces
            BEGIN
                SELECT RAISE(FAIL, 'blocked update');
            END;
            "#,
        )
        .unwrap();
}

fn create_workspace_fixture_db(
    db_path: &Path,
    source_repo_root: &Path,
    repo_id: &str,
    repo_name: &str,
) {
    let connection = open_fixture_db(db_path);
    // Prefix lives on the repo row in the multi-account world. Pin
    // `custom + testuser/` directly on the repo so create_workspace
    // produces the `testuser/<directory>` branch the assertions expect.
    connection
        .execute(
            r#"INSERT INTO repos (
                id, remote_url, name, default_branch, root_path, display_order, hidden,
                branch_prefix_type, branch_prefix_custom
              ) VALUES (?1, NULL, ?2, 'main', ?3, 1, 0, 'custom', 'testuser/')"#,
            (repo_id, repo_name, source_repo_root.to_str().unwrap()),
        )
        .unwrap();
}

#[allow(clippy::too_many_arguments)]
fn create_archived_fixture_db(
    db_path: &Path,
    source_repo_root: &Path,
    repo_name: &str,
    directory_name: &str,
    workspace_id: &str,
    session_id: &str,
    branch: &str,
    archive_commit: &str,
) {
    let connection = open_fixture_db(db_path);
    connection
        .execute(
            "INSERT INTO repos (id, name, remote_url, default_branch, root_path) VALUES (?1, ?2, NULL, 'main', ?3)",
            ["repo-1", repo_name, source_repo_root.to_str().unwrap()],
        )
        .unwrap();
    connection
        .execute(
            r#"INSERT INTO workspaces (id, repository_id, directory_name, state, status, branch, active_session_id, archive_commit) VALUES (?1, 'repo-1', ?2, 'archived', 'in-progress', ?3, ?4, ?5)"#,
            [workspace_id, directory_name, branch, session_id, archive_commit],
        )
        .unwrap();
    connection
        .execute(
            r#"INSERT INTO sessions (id, workspace_id, title, agent_type, status, model, permission_mode) VALUES (?1, ?2, 'Archived session', 'claude', 'idle', 'opus', 'default')"#,
            [session_id, workspace_id],
        )
        .unwrap();
}

fn create_ready_fixture_db(
    db_path: &Path,
    source_repo_root: &Path,
    repo_name: &str,
    directory_name: &str,
    workspace_id: &str,
    session_id: &str,
    branch: &str,
) {
    let connection = open_fixture_db(db_path);
    connection
        .execute(
            "INSERT INTO repos (id, name, remote_url, default_branch, root_path) VALUES (?1, ?2, NULL, 'main', ?3)",
            ["repo-1", repo_name, source_repo_root.to_str().unwrap()],
        )
        .unwrap();
    connection
        .execute(
            r#"INSERT INTO workspaces (id, repository_id, directory_name, state, status, branch, active_session_id) VALUES (?1, 'repo-1', ?2, 'ready', 'in-progress', ?3, ?4)"#,
            (workspace_id, directory_name, branch, session_id),
        )
        .unwrap();
    connection
        .execute(
            r#"INSERT INTO sessions (id, workspace_id, title, agent_type, status, model, permission_mode) VALUES (?1, ?2, 'Ready session', 'claude', 'idle', 'opus', 'default')"#,
            [session_id, workspace_id],
        )
        .unwrap();
}

fn init_branch_switch_repo(repo: &Path) {
    git_ops::run_git(["init", "-b", "main", repo.to_str().unwrap()], None).unwrap();
    run_in_repo(repo, &["config", "user.email", "helmor@example.com"]);
    run_in_repo(repo, &["config", "user.name", "Helmor"]);
    run_in_repo(repo, &["config", "commit.gpgsign", "false"]);
    fs::write(repo.join("README.md"), "main initial").unwrap();
    run_in_repo(repo, &["add", "README.md"]);
    run_in_repo(repo, &["commit", "-m", "initial"]);
}

fn run_in_repo(repo: &Path, args: &[&str]) {
    let repo_str = repo.display().to_string();
    let mut full: Vec<&str> = vec!["-C", repo_str.as_str()];
    full.extend_from_slice(args);
    git_ops::run_git(full, None).unwrap();
}

fn commit_file(repo: &Path, file: &str, contents: &str, msg: &str) {
    fs::write(repo.join(file), contents).unwrap();
    run_in_repo(repo, &["add", file]);
    run_in_repo(repo, &["commit", "-m", msg]);
}

fn create_branch_switch_fixture_db(
    db_path: &Path,
    source_repo: &Path,
    repo_name: &str,
    directory_name: &str,
    workspace_id: &str,
    branch: &str,
) {
    let connection = open_fixture_db(db_path);
    connection
        .execute(
            "INSERT INTO repos (id, name, remote_url, default_branch, root_path) VALUES (?1, ?2, NULL, 'main', ?3)",
            ["repo-1", repo_name, source_repo.to_str().unwrap()],
        )
        .unwrap();
    connection
        .execute(
            r#"INSERT INTO workspaces (
                id, repository_id, directory_name, state, status,
                branch, initialization_parent_branch, intended_target_branch
              ) VALUES (?1, 'repo-1', ?2, 'ready', 'in-progress', ?3, 'main', 'main')"#,
            (workspace_id, directory_name, branch),
        )
        .unwrap();
}
