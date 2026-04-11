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
    pub(crate) fn new(include_updated_at: bool) -> Self {
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

        let archived_ctx =
            crate::data_dir::archived_context_dir(&repo_name, &directory_name).unwrap();
        fs::create_dir_all(archived_ctx.join("attachments")).unwrap();
        fs::write(archived_ctx.join("notes.md"), "archived notes").unwrap();
        fs::write(archived_ctx.join("attachments/evidence.txt"), "evidence").unwrap();

        let ws_dir = crate::data_dir::workspace_dir(&repo_name, &directory_name).unwrap();
        fs::create_dir_all(ws_dir.parent().unwrap()).unwrap();

        create_fixture_db(
            &test_dir.db_path(),
            &source_repo_root,
            &repo_name,
            &directory_name,
            &workspace_id,
            &session_id,
            &branch,
            &archive_commit,
            include_updated_at,
        );

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

    pub(crate) fn archived_context_dir(&self) -> PathBuf {
        crate::data_dir::archived_context_dir(&self.repo_name, &self.directory_name).unwrap()
    }

    pub(crate) fn workspace_dir(&self) -> PathBuf {
        crate::data_dir::workspace_dir(&self.repo_name, &self.directory_name).unwrap()
    }

    pub(crate) fn source_repo_root(&self) -> PathBuf {
        self.root.join("source-repo")
    }

    pub(crate) fn attachment_path(&self) -> String {
        self.workspace_dir()
            .join(".context/attachments/evidence.txt")
            .display()
            .to_string()
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
    pub(crate) fn new(include_updated_at: bool) -> Self {
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

        let archived_ctx_parent = crate::data_dir::archived_contexts_dir()
            .unwrap()
            .join(&repo_name);
        fs::create_dir_all(&archived_ctx_parent).unwrap();

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
            include_updated_at,
        );

        let workspace_dir = crate::data_dir::workspace_dir(&repo_name, &directory_name).unwrap();
        git_ops::point_branch_to_commit(&source_repo_root, &branch, &head_commit).unwrap();
        git_ops::create_worktree(&source_repo_root, &workspace_dir, &branch).unwrap();
        fs::create_dir_all(workspace_dir.join(".context/attachments")).unwrap();
        fs::write(workspace_dir.join(".context/notes.md"), "ready notes").unwrap();
        fs::write(
            workspace_dir.join(".context/attachments/evidence.txt"),
            "ready evidence",
        )
        .unwrap();

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

    pub(crate) fn archived_context_dir(&self) -> PathBuf {
        crate::data_dir::archived_context_dir(&self.repo_name, &self.directory_name).unwrap()
    }

    pub(crate) fn workspace_dir(&self) -> PathBuf {
        crate::data_dir::workspace_dir(&self.repo_name, &self.directory_name).unwrap()
    }

    pub(crate) fn source_repo_root(&self) -> PathBuf {
        self.root.join("source-repo")
    }

    pub(crate) fn attachment_path(&self) -> String {
        self.workspace_dir()
            .join(".context/attachments/evidence.txt")
            .display()
            .to_string()
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

    pub(crate) fn set_repo_setup_script(&self, script: Option<&str>) {
        let connection = Connection::open(self.db_path()).unwrap();
        connection
            .execute(
                "UPDATE repos SET setup_script = ?2 WHERE id = ?1",
                (&self.repo_id, script),
            )
            .unwrap();
    }

    pub(crate) fn insert_workspace_name(&self, directory_name: &str) {
        let connection = Connection::open(self.db_path()).unwrap();
        connection
            .execute(
                r#"
                INSERT INTO workspaces (
                  id, repository_id, directory_name, active_session_id, branch,
                  placeholder_branch_name, state, initialization_parent_branch,
                  intended_target_branch, derived_status, unread, created_at, updated_at
                ) VALUES (?1, ?2, ?3, NULL, ?4, ?4, 'ready', 'main', 'main', 'in-progress', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                "#,
                (
                    format!("workspace-{directory_name}"),
                    &self.repo_id,
                    directory_name,
                    format!("caspian/{directory_name}"),
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
        connection
            .execute(
                r#"
                INSERT INTO repos (
                  id, remote_url, name, default_branch, root_path, setup_script, created_at,
                  updated_at, display_order, hidden
                ) VALUES (?1, NULL, ?2, 'main', ?3, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?4, ?5)
                "#,
                (
                    repo_id,
                    repo_name,
                    self.source_repo_root.to_str().unwrap(),
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

#[cfg(unix)]
fn make_executable_if_script(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if path.extension().and_then(|value| value.to_str()) == Some("sh") {
        let metadata = fs::metadata(path).unwrap();
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }
}

#[cfg(not(unix))]
fn make_executable_if_script(_path: &Path) {}

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

fn create_workspace_fixture_db(
    db_path: &Path,
    source_repo_root: &Path,
    repo_id: &str,
    repo_name: &str,
) {
    let connection = Connection::open(db_path).unwrap();
    connection.execute_batch(&fixture_schema_sql(true)).unwrap();
    connection
        .execute(
            r#"INSERT INTO repos (id, remote_url, name, default_branch, root_path, setup_script, created_at, updated_at, display_order, hidden) VALUES (?1, NULL, ?2, 'main', ?3, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 0)"#,
            (repo_id, repo_name, source_repo_root.to_str().unwrap()),
        )
        .unwrap();
    connection.execute("INSERT INTO settings (key, value, created_at, updated_at) VALUES ('branch_prefix_type', 'custom', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)", []).unwrap();
    connection.execute("INSERT INTO settings (key, value, created_at, updated_at) VALUES ('branch_prefix_custom', 'caspian/', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)", []).unwrap();
}

#[allow(clippy::too_many_arguments)]
fn create_fixture_db(
    db_path: &Path,
    source_repo_root: &Path,
    repo_name: &str,
    directory_name: &str,
    workspace_id: &str,
    session_id: &str,
    branch: &str,
    archive_commit: &str,
    include_updated_at: bool,
) {
    let connection = Connection::open(db_path).unwrap();
    connection
        .execute_batch(&fixture_schema_sql(include_updated_at))
        .unwrap();
    connection
        .execute(
            "INSERT INTO repos (id, name, remote_url, default_branch, root_path) VALUES (?1, ?2, NULL, 'main', ?3)",
            ["repo-1", repo_name, source_repo_root.to_str().unwrap()],
        )
        .unwrap();
    if include_updated_at {
        connection.execute(
            r#"INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status, manual_status, unread, branch, initialization_parent_branch, intended_target_branch, notes, pinned_at, active_session_id, pr_title, pr_description, archive_commit, created_at, updated_at) VALUES (?1, 'repo-1', ?2, 'archived', 'in-progress', NULL, 0, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"#,
            [workspace_id, directory_name, branch, session_id, archive_commit],
        ).unwrap();
    } else {
        connection.execute(
            r#"INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status, manual_status, unread, branch, initialization_parent_branch, intended_target_branch, notes, pinned_at, active_session_id, pr_title, pr_description, archive_commit, created_at) VALUES (?1, 'repo-1', ?2, 'archived', 'in-progress', NULL, 0, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, ?5, CURRENT_TIMESTAMP)"#,
            [workspace_id, directory_name, branch, session_id, archive_commit],
        ).unwrap();
    }
    connection.execute(
        r#"INSERT INTO sessions (id, workspace_id, title, agent_type, status, model, permission_mode, provider_session_id, unread_count, context_token_count, context_used_percent, thinking_enabled, fast_mode, agent_personality, created_at, updated_at, last_user_message_at, resume_session_at, is_hidden, is_compacting) VALUES (?1, ?2, 'Archived session', 'claude', 'idle', 'opus', 'default', NULL, 0, 0, NULL, 0, 0, 'none', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 0, 0)"#,
        [session_id, workspace_id],
    ).unwrap();

    let archived_attachment_path = crate::data_dir::archived_context_dir(repo_name, directory_name)
        .unwrap()
        .join("attachments/evidence.txt")
        .display()
        .to_string();
    connection.execute(
        "INSERT INTO attachments (id, session_id, session_message_id, type, original_name, path, is_loading, is_draft, created_at) VALUES ('attachment-1', ?1, NULL, 'text', 'evidence.txt', ?2, 0, 0, CURRENT_TIMESTAMP)",
        [session_id, archived_attachment_path.as_str()],
    ).unwrap();
}

#[allow(clippy::too_many_arguments)]
fn create_ready_fixture_db(
    db_path: &Path,
    source_repo_root: &Path,
    repo_name: &str,
    directory_name: &str,
    workspace_id: &str,
    session_id: &str,
    branch: &str,
    include_updated_at: bool,
) {
    let connection = Connection::open(db_path).unwrap();
    connection
        .execute_batch(&fixture_schema_sql(include_updated_at))
        .unwrap();
    connection
        .execute(
            "INSERT INTO repos (id, name, remote_url, default_branch, root_path) VALUES (?1, ?2, NULL, 'main', ?3)",
            ["repo-1", repo_name, source_repo_root.to_str().unwrap()],
        )
        .unwrap();
    if include_updated_at {
        connection.execute(
            r#"INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status, manual_status, unread, branch, initialization_parent_branch, intended_target_branch, notes, pinned_at, active_session_id, pr_title, pr_description, archive_commit, created_at, updated_at) VALUES (?1, 'repo-1', ?2, 'ready', 'in-progress', NULL, 0, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"#,
            (workspace_id, directory_name, branch, session_id),
        ).unwrap();
    } else {
        connection.execute(
            r#"INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status, manual_status, unread, branch, initialization_parent_branch, intended_target_branch, notes, pinned_at, active_session_id, pr_title, pr_description, archive_commit, created_at) VALUES (?1, 'repo-1', ?2, 'ready', 'in-progress', NULL, 0, ?3, NULL, NULL, NULL, NULL, ?4, NULL, NULL, NULL, CURRENT_TIMESTAMP)"#,
            (workspace_id, directory_name, branch, session_id),
        ).unwrap();
    }
    connection.execute(
        r#"INSERT INTO sessions (id, workspace_id, title, agent_type, status, model, permission_mode, provider_session_id, unread_count, context_token_count, context_used_percent, thinking_enabled, fast_mode, agent_personality, created_at, updated_at, last_user_message_at, resume_session_at, is_hidden, is_compacting) VALUES (?1, ?2, 'Ready session', 'claude', 'idle', 'opus', 'default', NULL, 0, 0, NULL, 0, 0, 'none', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 0, 0)"#,
        [session_id, workspace_id],
    ).unwrap();

    let workspace_attachment_path = crate::data_dir::workspace_dir(repo_name, directory_name)
        .unwrap()
        .join(".context/attachments/evidence.txt")
        .display()
        .to_string();
    connection.execute(
        "INSERT INTO attachments (id, session_id, session_message_id, type, original_name, path, is_loading, is_draft, created_at) VALUES ('attachment-1', ?1, NULL, 'text', 'evidence.txt', ?2, 0, 0, CURRENT_TIMESTAMP)",
        [session_id, workspace_attachment_path.as_str()],
    ).unwrap();
}

fn fixture_schema_sql(include_updated_at: bool) -> String {
    let workspaces_updated_at_column = if include_updated_at {
        ",\n              updated_at TEXT DEFAULT CURRENT_TIMESTAMP"
    } else {
        ""
    };

    format!(
        r#"
        CREATE TABLE repos (id TEXT PRIMARY KEY, remote_url TEXT, name TEXT NOT NULL, default_branch TEXT DEFAULT 'main', root_path TEXT NOT NULL, setup_script TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, storage_version INTEGER DEFAULT 1, archive_script TEXT, display_order INTEGER DEFAULT 0, run_script TEXT, run_script_mode TEXT DEFAULT 'concurrent', remote TEXT, custom_prompt_code_review TEXT, custom_prompt_create_pr TEXT, custom_prompt_rename_branch TEXT, conductor_config TEXT, custom_prompt_general TEXT, icon TEXT, hidden INTEGER DEFAULT 0, custom_prompt_fix_errors TEXT, custom_prompt_resolve_merge_conflicts TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, DEPRECATED_city_name TEXT, directory_name TEXT, DEPRECATED_archived INTEGER DEFAULT 0, active_session_id TEXT, branch TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, state TEXT, derived_status TEXT, manual_status TEXT, unread INTEGER DEFAULT 0, placeholder_branch_name TEXT, initialization_parent_branch TEXT, big_terminal_mode INTEGER DEFAULT 0, setup_log_path TEXT, initialization_log_path TEXT, initialization_files_copied INTEGER, pinned_at TEXT, linked_workspace_ids TEXT, notes TEXT, intended_target_branch TEXT, pr_title TEXT, pr_description TEXT, archive_commit TEXT, secondary_directory_name TEXT, linked_directory_paths TEXT{workspaces_updated_at_column});
        CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, provider_session_id TEXT, unread_count INTEGER DEFAULT 0, freshly_compacted INTEGER DEFAULT 0, context_token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, is_compacting INTEGER DEFAULT 0, model TEXT, permission_mode TEXT, DEPRECATED_thinking_level TEXT DEFAULT 'NONE', last_user_message_at TEXT, resume_session_at TEXT, workspace_id TEXT NOT NULL, is_hidden INTEGER DEFAULT 0, agent_type TEXT, title TEXT DEFAULT 'Untitled', context_used_percent REAL, thinking_enabled INTEGER DEFAULT 1, codex_thinking_level TEXT, fast_mode INTEGER DEFAULT 0, agent_personality TEXT);
        CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT, content TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, sent_at TEXT, cancelled_at TEXT, model TEXT, sdk_message_id TEXT, last_assistant_message_id TEXT, turn_id TEXT, is_resumable_message INTEGER);
        CREATE TABLE attachments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_message_id TEXT, type TEXT, original_name TEXT, path TEXT, is_loading INTEGER DEFAULT 0, is_draft INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        "#
    )
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
    let connection = Connection::open(db_path).unwrap();
    connection.execute_batch(&fixture_schema_sql(true)).unwrap();
    connection
        .execute(
            "INSERT INTO repos (id, name, remote_url, default_branch, root_path) VALUES (?1, ?2, NULL, 'main', ?3)",
            ["repo-1", repo_name, source_repo.to_str().unwrap()],
        )
        .unwrap();
    connection
        .execute(
            r#"INSERT INTO workspaces (
                id, repository_id, directory_name, state, derived_status,
                manual_status, unread, branch, initialization_parent_branch,
                intended_target_branch, notes, pinned_at, active_session_id,
                pr_title, pr_description, archive_commit, created_at, updated_at
              ) VALUES (
                ?1, 'repo-1', ?2, 'ready', 'in-progress',
                NULL, 0, ?3, 'main',
                'main', NULL, NULL, NULL,
                NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
              )"#,
            (workspace_id, directory_name, branch),
        )
        .unwrap();
}
