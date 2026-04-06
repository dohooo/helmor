pub mod auth;
pub mod db;
pub mod editor_files;
pub mod git_ops;
pub mod github_cli;
pub mod helpers;
pub mod repos;
pub mod sessions;
pub mod settings;
pub mod workspaces;

use anyhow::Context;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::CommandError;

type CmdResult<T> = Result<T, CommandError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataInfo {
    pub data_mode: String,
    pub data_dir: String,
    pub db_path: String,
}

// ---------------------------------------------------------------------------
// Tauri commands — thin wrappers calling into sub-modules
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_data_info() -> CmdResult<DataInfo> {
    let data_dir = crate::data_dir::data_dir()?;
    let db_path = crate::data_dir::db_path()?;

    Ok(DataInfo {
        data_mode: crate::data_dir::data_mode_label().to_string(),
        data_dir: data_dir.display().to_string(),
        db_path: db_path.display().to_string(),
    })
}

#[tauri::command]
pub fn get_app_settings() -> CmdResult<std::collections::HashMap<String, String>> {
    let conn = db::open_connection(false)?;
    let mut stmt = conn
        .prepare(
            "SELECT key, value FROM settings WHERE key LIKE 'app.%' OR key LIKE 'branch_prefix_%'",
        )
        .context("Failed to query app settings")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .context("Failed to iterate app settings")?;

    let mut map = std::collections::HashMap::new();
    for row in rows.flatten() {
        map.insert(row.0, row.1);
    }
    Ok(map)
}

#[tauri::command]
pub fn update_app_settings(settings: std::collections::HashMap<String, String>) -> CmdResult<()> {
    for (key, value) in &settings {
        if !key.starts_with("app.") && !key.starts_with("branch_prefix_") {
            continue;
        }
        settings::upsert_setting_value(key, value)?;
    }
    Ok(())
}

#[tauri::command]
pub fn conductor_source_available() -> bool {
    crate::import::conductor_source_available()
}

#[tauri::command]
pub fn get_github_identity_session() -> CmdResult<auth::GithubIdentitySnapshot> {
    Ok(auth::get_github_identity_session()?)
}

#[tauri::command]
pub fn start_github_identity_connect(
    app: AppHandle,
    runtime: State<'_, auth::GithubIdentityFlowRuntime>,
) -> CmdResult<auth::GithubIdentityDeviceFlowStart> {
    Ok(auth::start_github_identity_connect(
        app,
        runtime.inner().clone(),
    )?)
}

#[tauri::command]
pub fn cancel_github_identity_connect(
    app: AppHandle,
    runtime: State<'_, auth::GithubIdentityFlowRuntime>,
) -> CmdResult<()> {
    Ok(auth::cancel_github_identity_connect(
        app,
        runtime.inner().clone(),
    )?)
}

#[tauri::command]
pub fn disconnect_github_identity(
    app: AppHandle,
    runtime: State<'_, auth::GithubIdentityFlowRuntime>,
) -> CmdResult<()> {
    Ok(auth::disconnect_github_identity(
        app,
        runtime.inner().clone(),
    )?)
}

#[tauri::command]
pub fn get_github_cli_status() -> CmdResult<github_cli::GithubCliStatus> {
    Ok(github_cli::get_github_cli_status()?)
}

#[tauri::command]
pub fn get_github_cli_user() -> CmdResult<Option<github_cli::GithubCliUser>> {
    Ok(github_cli::get_github_cli_user()?)
}

#[tauri::command]
pub fn list_github_accessible_repositories() -> CmdResult<Vec<github_cli::GithubRepositorySummary>>
{
    Ok(github_cli::list_github_accessible_repositories()?)
}

#[tauri::command]
pub fn list_conductor_repos() -> CmdResult<Vec<crate::import::ConductorRepo>> {
    Ok(crate::import::list_conductor_repos()?)
}

#[tauri::command]
pub fn list_conductor_workspaces(
    repo_id: String,
) -> CmdResult<Vec<crate::import::ConductorWorkspace>> {
    Ok(crate::import::list_conductor_workspaces(&repo_id)?)
}

#[tauri::command]
pub fn import_conductor_workspaces(
    workspace_ids: Vec<String>,
) -> CmdResult<crate::import::ImportWorkspacesResult> {
    Ok(crate::import::import_conductor_workspaces(&workspace_ids)?)
}

#[tauri::command]
pub fn list_repositories() -> CmdResult<Vec<repos::RepositoryCreateOption>> {
    Ok(repos::list_repositories()?)
}

#[tauri::command]
pub fn get_add_repository_defaults() -> CmdResult<repos::AddRepositoryDefaults> {
    Ok(repos::AddRepositoryDefaults {
        last_clone_directory: settings::load_setting_value("last_clone_directory")?,
    })
}

#[tauri::command]
pub fn add_repository_from_local_path(
    folder_path: String,
) -> CmdResult<repos::AddRepositoryResponse> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock poisoned"))?;

    Ok(repos::add_repository_from_local_path(&folder_path)?)
}

#[tauri::command]
pub fn create_workspace_from_repo(
    repo_id: String,
) -> CmdResult<workspaces::CreateWorkspaceResponse> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock poisoned"))?;

    Ok(workspaces::create_workspace_from_repo_impl(&repo_id)?)
}

#[tauri::command]
pub fn list_workspace_groups() -> CmdResult<Vec<workspaces::WorkspaceSidebarGroup>> {
    Ok(workspaces::list_workspace_groups()?)
}

#[tauri::command]
pub fn list_archived_workspaces() -> CmdResult<Vec<workspaces::WorkspaceSummary>> {
    Ok(workspaces::list_archived_workspaces()?)
}

#[tauri::command]
pub fn get_workspace(workspace_id: String) -> CmdResult<workspaces::WorkspaceDetail> {
    Ok(workspaces::get_workspace(&workspace_id)?)
}

#[tauri::command]
pub fn list_workspace_sessions(
    workspace_id: String,
) -> CmdResult<Vec<sessions::WorkspaceSessionSummary>> {
    Ok(sessions::list_workspace_sessions(&workspace_id)?)
}

#[tauri::command]
pub fn list_session_messages(session_id: String) -> CmdResult<Vec<sessions::SessionMessageRecord>> {
    Ok(sessions::list_session_messages(&session_id)?)
}

#[tauri::command]
pub fn list_session_attachments(
    session_id: String,
) -> CmdResult<Vec<sessions::SessionAttachmentRecord>> {
    Ok(sessions::list_session_attachments(&session_id)?)
}

#[tauri::command]
pub fn create_session(workspace_id: String) -> CmdResult<sessions::CreateSessionResponse> {
    Ok(sessions::create_session(&workspace_id)?)
}

#[tauri::command]
pub fn rename_session(session_id: String, title: String) -> CmdResult<()> {
    Ok(sessions::rename_session(&session_id, &title)?)
}

#[tauri::command]
pub fn hide_session(session_id: String) -> CmdResult<()> {
    Ok(sessions::hide_session(&session_id)?)
}

#[tauri::command]
pub fn unhide_session(session_id: String) -> CmdResult<()> {
    Ok(sessions::unhide_session(&session_id)?)
}

#[tauri::command]
pub fn delete_session(session_id: String) -> CmdResult<()> {
    Ok(sessions::delete_session(&session_id)?)
}

#[tauri::command]
pub fn list_hidden_sessions(
    workspace_id: String,
) -> CmdResult<Vec<sessions::WorkspaceSessionSummary>> {
    Ok(sessions::list_hidden_sessions(&workspace_id)?)
}

#[tauri::command]
pub fn mark_session_read(session_id: String) -> CmdResult<()> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock poisoned"))?;

    Ok(sessions::mark_session_read(&session_id)?)
}

#[tauri::command]
pub fn mark_workspace_read(workspace_id: String) -> CmdResult<()> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock poisoned"))?;

    Ok(workspaces::mark_workspace_read(&workspace_id)?)
}

#[tauri::command]
pub fn mark_workspace_unread(workspace_id: String) -> CmdResult<()> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock poisoned"))?;

    Ok(workspaces::mark_workspace_unread(&workspace_id)?)
}

#[tauri::command]
pub fn pin_workspace(workspace_id: String) -> CmdResult<()> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock poisoned"))?;

    Ok(workspaces::pin_workspace(&workspace_id)?)
}

#[tauri::command]
pub fn unpin_workspace(workspace_id: String) -> CmdResult<()> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock poisoned"))?;

    Ok(workspaces::unpin_workspace(&workspace_id)?)
}

#[tauri::command]
pub fn set_workspace_manual_status(workspace_id: String, status: Option<String>) -> CmdResult<()> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock poisoned"))?;

    Ok(workspaces::set_workspace_manual_status(
        &workspace_id,
        status.as_deref(),
    )?)
}

#[tauri::command]
pub fn list_remote_branches(workspace_id: String) -> CmdResult<Vec<String>> {
    Ok(workspaces::list_remote_branches(&workspace_id)?)
}

#[tauri::command]
pub fn update_intended_target_branch(workspace_id: String, target_branch: String) -> CmdResult<()> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock poisoned"))?;

    Ok(workspaces::update_intended_target_branch(
        &workspace_id,
        &target_branch,
    )?)
}

#[tauri::command]
pub fn restore_workspace(workspace_id: String) -> CmdResult<workspaces::RestoreWorkspaceResponse> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Restore lock poisoned"))?;

    Ok(workspaces::restore_workspace_impl(&workspace_id)?)
}

#[tauri::command]
pub fn archive_workspace(workspace_id: String) -> CmdResult<workspaces::ArchiveWorkspaceResponse> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock poisoned"))?;

    Ok(workspaces::archive_workspace_impl(&workspace_id)?)
}

#[tauri::command]
pub fn permanently_delete_workspace(workspace_id: String) -> CmdResult<()> {
    let _lock = db::WORKSPACE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace mutation lock poisoned"))?;

    Ok(workspaces::permanently_delete_workspace(&workspace_id)?)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEditor {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub fn detect_installed_editors() -> CmdResult<Vec<DetectedEditor>> {
    let mut editors = Vec::new();

    // macOS application paths to check
    let candidates: &[(&str, &str, &[&str])] = &[
        (
            "cursor",
            "Cursor",
            &["/Applications/Cursor.app", "$HOME/Applications/Cursor.app"],
        ),
        (
            "vscode",
            "VS Code",
            &[
                "/Applications/Visual Studio Code.app",
                "$HOME/Applications/Visual Studio Code.app",
            ],
        ),
    ];

    let home = std::env::var("HOME").unwrap_or_default();

    for (id, name, paths) in candidates {
        for path in *paths {
            let resolved = path.replace("$HOME", &home);
            if std::path::Path::new(&resolved).exists() {
                editors.push(DetectedEditor {
                    id: id.to_string(),
                    name: name.to_string(),
                    path: resolved,
                });
                break;
            }
        }
    }

    Ok(editors)
}

#[tauri::command]
pub fn open_workspace_in_editor(workspace_id: String, editor: String) -> CmdResult<()> {
    let record = workspaces::load_workspace_record_by_id(&workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    let workspace_dir = crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
    if !workspace_dir.is_dir() {
        Err(anyhow::anyhow!(
            "Workspace directory not found: {}",
            workspace_dir.display()
        ))?;
    }

    let home = std::env::var("HOME").unwrap_or_default();
    let dir_str = workspace_dir.display().to_string();

    // Try to open via macOS `open -a` first, then fall back to CLI
    let result = match editor.as_str() {
        "cursor" => std::process::Command::new("open")
            .args(["-a", "Cursor", &dir_str])
            .spawn(),
        "vscode" => std::process::Command::new("open")
            .args(["-a", "Visual Studio Code", &dir_str])
            .spawn(),
        _ => {
            Err(anyhow::anyhow!("Unsupported editor: {editor}"))?;
            unreachable!()
        }
    };

    let _ = home; // suppress unused warning
    result.with_context(|| format!("Failed to open {editor}"))?;
    Ok(())
}

#[tauri::command]
pub fn read_editor_file(path: String) -> CmdResult<editor_files::EditorFileReadResponse> {
    Ok(editor_files::read_editor_file(&path)?)
}

#[tauri::command]
pub fn list_editor_files(
    workspace_root_path: String,
) -> CmdResult<Vec<editor_files::EditorFileListItem>> {
    Ok(editor_files::list_editor_files(&workspace_root_path)?)
}

#[tauri::command]
pub fn list_editor_files_with_content(
    workspace_root_path: String,
) -> CmdResult<editor_files::EditorFilesWithContentResponse> {
    Ok(editor_files::list_editor_files_with_content(
        &workspace_root_path,
    )?)
}

#[tauri::command]
pub fn list_workspace_changes(
    workspace_root_path: String,
) -> CmdResult<Vec<editor_files::EditorFileListItem>> {
    Ok(editor_files::list_workspace_changes(&workspace_root_path)?)
}

#[tauri::command]
pub fn list_workspace_changes_with_content(
    workspace_root_path: String,
) -> CmdResult<editor_files::EditorFilesWithContentResponse> {
    Ok(editor_files::list_workspace_changes_with_content(
        &workspace_root_path,
    )?)
}

#[tauri::command]
pub fn write_editor_file(
    path: String,
    content: String,
) -> CmdResult<editor_files::EditorFileWriteResponse> {
    Ok(editor_files::write_editor_file(&path, &content)?)
}

#[tauri::command]
pub fn stat_editor_file(path: String) -> CmdResult<editor_files::EditorFileStatResponse> {
    Ok(editor_files::stat_editor_file(&path)?)
}

#[tauri::command]
pub fn update_session_settings(
    session_id: String,
    effort_level: Option<String>,
    permission_mode: Option<String>,
) -> CmdResult<()> {
    let connection = db::open_connection(true)?;
    connection
        .execute(
            r#"
            UPDATE sessions SET
              effort_level = COALESCE(?2, effort_level),
              permission_mode = COALESCE(?3, permission_mode)
            WHERE id = ?1
            "#,
            rusqlite::params![session_id, effort_level, permission_mode],
        )
        .context("Failed to update session settings")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_dir::TEST_ENV_LOCK as TEST_LOCK;
    use rusqlite::Connection;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Helper: set HELMOR_DATA_DIR to a temp dir for tests that hit the DB.
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

    // ---- Test harnesses ----

    struct RestoreTestHarness {
        _test_dir: TestDataDir,
        #[allow(dead_code)]
        root: PathBuf,
        source_repo_root: PathBuf,
        workspace_id: String,
        session_id: String,
        repo_name: String,
        directory_name: String,
        branch: String,
    }

    impl RestoreTestHarness {
        fn new(include_updated_at: bool) -> Self {
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

            // Create archived context directory
            let archived_ctx =
                crate::data_dir::archived_context_dir(&repo_name, &directory_name).unwrap();
            fs::create_dir_all(archived_ctx.join("attachments")).unwrap();
            fs::write(archived_ctx.join("notes.md"), "archived notes").unwrap();
            fs::write(archived_ctx.join("attachments/evidence.txt"), "evidence").unwrap();

            // Create workspace parent directory
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

        fn archived_context_dir(&self) -> PathBuf {
            crate::data_dir::archived_context_dir(&self.repo_name, &self.directory_name).unwrap()
        }

        fn workspace_dir(&self) -> PathBuf {
            crate::data_dir::workspace_dir(&self.repo_name, &self.directory_name).unwrap()
        }

        fn source_repo_root(&self) -> PathBuf {
            self.root.join("source-repo")
        }

        fn attachment_path(&self) -> String {
            self.workspace_dir()
                .join(".context/attachments/evidence.txt")
                .display()
                .to_string()
        }
    }

    struct ArchiveTestHarness {
        _test_dir: TestDataDir,
        #[allow(dead_code)]
        root: PathBuf,
        workspace_id: String,
        session_id: String,
        repo_name: String,
        directory_name: String,
        head_commit: String,
    }

    impl ArchiveTestHarness {
        fn new(include_updated_at: bool) -> Self {
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

            // Create archived-contexts parent
            let archived_ctx_parent = crate::data_dir::archived_contexts_dir()
                .unwrap()
                .join(&repo_name);
            fs::create_dir_all(&archived_ctx_parent).unwrap();

            // Create workspaces parent
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

            let workspace_dir =
                crate::data_dir::workspace_dir(&repo_name, &directory_name).unwrap();
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

        fn archived_context_dir(&self) -> PathBuf {
            crate::data_dir::archived_context_dir(&self.repo_name, &self.directory_name).unwrap()
        }

        fn workspace_dir(&self) -> PathBuf {
            crate::data_dir::workspace_dir(&self.repo_name, &self.directory_name).unwrap()
        }

        fn source_repo_root(&self) -> PathBuf {
            self.root.join("source-repo")
        }

        fn attachment_path(&self) -> String {
            self.workspace_dir()
                .join(".context/attachments/evidence.txt")
                .display()
                .to_string()
        }
    }

    struct CreateTestHarness {
        _test_dir: TestDataDir,
        root: PathBuf,
        source_repo_root: PathBuf,
        repo_id: String,
        repo_name: String,
    }

    impl CreateTestHarness {
        fn new() -> Self {
            let test_dir = TestDataDir::new("create");
            let root = test_dir.root.clone();
            let source_repo_root = root.join("source-repo");
            let repo_id = "repo-create".to_string();
            let repo_name = "demo-repo".to_string();

            fs::create_dir_all(&source_repo_root).unwrap();
            init_create_git_repo(&source_repo_root);

            create_workspace_fixture_db(
                &test_dir.db_path(),
                &source_repo_root,
                &repo_id,
                &repo_name,
            );

            Self {
                _test_dir: test_dir,
                root,
                source_repo_root,
                repo_id,
                repo_name,
            }
        }

        fn db_path(&self) -> PathBuf {
            crate::data_dir::db_path().unwrap()
        }

        fn workspace_dir(&self, directory_name: &str) -> PathBuf {
            crate::data_dir::workspace_dir(&self.repo_name, directory_name).unwrap()
        }

        fn set_repo_setup_script(&self, script: Option<&str>) {
            let connection = Connection::open(self.db_path()).unwrap();
            connection
                .execute(
                    "UPDATE repos SET setup_script = ?2 WHERE id = ?1",
                    (&self.repo_id, script),
                )
                .unwrap();
        }

        fn insert_workspace_name(&self, directory_name: &str) {
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

        fn insert_repo(&self, repo_id: &str, repo_name: &str, display_order: i64, hidden: i64) {
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

        fn commit_repo_files(&self, files: &[(&str, &str)]) {
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

            git_ops::run_git(
                [
                    "-C",
                    self.source_repo_root.to_str().unwrap(),
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
        }
    }

    // ---- Tests ----

    #[test]
    fn restore_workspace_recreates_worktree_and_context() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(true);

        let response = workspaces::restore_workspace_impl(&harness.workspace_id).unwrap();

        assert_eq!(response.restored_workspace_id, harness.workspace_id);
        assert_eq!(response.restored_state, "ready");
        assert_eq!(response.selected_workspace_id, harness.workspace_id);
        assert!(harness.source_repo_root().exists());
        assert!(harness.workspace_dir().join(".git").exists());
        assert!(harness.workspace_dir().join("tracked.txt").exists());
        assert!(harness.workspace_dir().join(".context/notes.md").exists());
        assert!(harness
            .workspace_dir()
            .join(".context/attachments/evidence.txt")
            .exists());
        assert!(!harness.archived_context_dir().exists());

        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        let state: String = connection
            .query_row(
                "SELECT state FROM workspaces WHERE id = ?1",
                [&harness.workspace_id],
                |row| row.get(0),
            )
            .unwrap();
        let attachment_path: String = connection
            .query_row(
                "SELECT path FROM attachments WHERE session_id = ?1",
                [&harness.session_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(state, "ready");
        assert_eq!(attachment_path, harness.attachment_path());
    }

    #[test]
    fn archive_workspace_moves_context_and_removes_worktree() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(true);

        let response = workspaces::archive_workspace_impl(&harness.workspace_id).unwrap();

        assert_eq!(response.archived_workspace_id, harness.workspace_id);
        assert_eq!(response.archived_state, "archived");
        assert!(!harness.workspace_dir().exists());
        assert!(harness.archived_context_dir().join("notes.md").exists());
        assert!(harness
            .archived_context_dir()
            .join("attachments/evidence.txt")
            .exists());

        let worktree_list = git_ops::run_git(
            [
                "-C",
                harness.source_repo_root().to_str().unwrap(),
                "worktree",
                "list",
            ],
            None,
        )
        .unwrap();
        assert!(!worktree_list.contains(harness.workspace_dir().to_str().unwrap()));

        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        let (state, archive_commit, attachment_path): (String, String, String) = connection
            .query_row(
                "SELECT state, archive_commit, (SELECT path FROM attachments WHERE session_id = ?2) FROM workspaces WHERE id = ?1",
                (&harness.workspace_id, &harness.session_id),
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(state, "archived");
        assert_eq!(archive_commit, harness.head_commit);
        assert_eq!(attachment_path, harness.attachment_path());
    }

    #[test]
    fn restore_workspace_cleans_up_existing_target_directory() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(true);
        // Pre-create the target directory — restore should clean it up and succeed
        fs::create_dir_all(harness.workspace_dir()).unwrap();
        fs::write(harness.workspace_dir().join("stale.txt"), "old").unwrap();

        let result = workspaces::restore_workspace_impl(&harness.workspace_id);
        assert!(
            result.is_ok(),
            "Restore should succeed by replacing existing dir: {:?}",
            result.err()
        );
        // Stale file should be gone, replaced by worktree
        assert!(!harness.workspace_dir().join("stale.txt").exists());
        assert!(harness.workspace_dir().join(".git").exists());
    }

    #[test]
    fn restore_workspace_recreates_deleted_branch() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(true);
        // Delete the branch — restore should recreate it from archive_commit
        git_ops::run_git(
            [
                "-C",
                harness.source_repo_root.to_str().unwrap(),
                "branch",
                "-D",
                harness.branch.as_str(),
            ],
            None,
        )
        .unwrap();

        let result = workspaces::restore_workspace_impl(&harness.workspace_id);
        assert!(
            result.is_ok(),
            "Restore should succeed by recreating branch: {:?}",
            result.err()
        );
        assert!(
            harness.workspace_dir().exists(),
            "Worktree should be created"
        );
    }

    #[test]
    fn restore_workspace_cleans_up_when_db_update_fails() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(false);

        let error = workspaces::restore_workspace_impl(&harness.workspace_id).unwrap_err();

        assert!(error.to_string().contains("update workspace restore state"));
        assert!(!harness.workspace_dir().exists());
        assert!(harness.archived_context_dir().exists());
    }

    #[test]
    fn archive_workspace_cleans_up_when_db_update_fails() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(false);

        let error = workspaces::archive_workspace_impl(&harness.workspace_id).unwrap_err();

        assert!(error.to_string().contains("update workspace archive state"));
        assert!(harness.workspace_dir().exists());
        assert!(harness.workspace_dir().join(".context/notes.md").exists());
        assert!(harness
            .workspace_dir()
            .join(".context/attachments/evidence.txt")
            .exists());
        assert!(!harness.archived_context_dir().exists());

        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        let state: String = connection
            .query_row(
                "SELECT state FROM workspaces WHERE id = ?1",
                [&harness.workspace_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "ready");
    }

    #[test]
    fn workspace_record_marks_unread_when_session_has_unread_even_if_workspace_flag_is_clear() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(true);
        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

        connection
            .execute(
                "UPDATE sessions SET unread_count = 1 WHERE id = ?1",
                [&harness.session_id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE workspaces SET unread = 0 WHERE id = ?1",
                [&harness.workspace_id],
            )
            .unwrap();

        let record = workspaces::load_workspace_record_by_id(&harness.workspace_id)
            .unwrap()
            .unwrap();

        assert!(record.has_unread);
        assert_eq!(record.workspace_unread, 0);
        assert_eq!(record.session_unread_total, 1);
        assert_eq!(record.unread_session_count, 1);
    }

    #[test]
    fn archived_workspace_summary_reports_unread_state() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(true);
        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

        connection
            .execute(
                "UPDATE sessions SET unread_count = 1 WHERE id = ?1",
                [&harness.session_id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE workspaces SET unread = 0 WHERE id = ?1",
                [&harness.workspace_id],
            )
            .unwrap();

        let record = workspaces::load_workspace_record_by_id(&harness.workspace_id)
            .unwrap()
            .unwrap();
        let summary = workspaces::record_to_summary(record);

        assert!(summary.has_unread);
        assert_eq!(summary.session_unread_total, 1);
        assert_eq!(summary.unread_session_count, 1);
    }

    #[test]
    fn mark_session_read_clears_session_and_workspace_unread() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(true);
        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

        connection
            .execute(
                "UPDATE sessions SET unread_count = 1 WHERE id = ?1",
                [&harness.session_id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE workspaces SET unread = 1 WHERE id = ?1",
                [&harness.workspace_id],
            )
            .unwrap();

        sessions::mark_session_read(&harness.session_id).unwrap();

        let (session_unread, workspace_unread): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT unread_count FROM sessions WHERE id = ?1), (SELECT unread FROM workspaces WHERE id = ?2)",
                (&harness.session_id, &harness.workspace_id),
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(session_unread, 0);
        assert_eq!(workspace_unread, 0);
    }

    #[test]
    fn mark_workspace_read_clears_all_workspace_sessions() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(true);
        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

        connection
            .execute(
                "UPDATE sessions SET unread_count = 1 WHERE id = ?1",
                [&harness.session_id],
            )
            .unwrap();
        connection
            .execute(
                r#"
                INSERT INTO sessions (
                  id, workspace_id, title, agent_type, status, model, permission_mode,
                  provider_session_id, unread_count, context_token_count, context_used_percent,
                  thinking_enabled, fast_mode, agent_personality,
                  created_at, updated_at, last_user_message_at, resume_session_at,
                  is_hidden, is_compacting
                ) VALUES ('session-archive-2', ?1, 'Second session', 'claude', 'idle', 'opus', 'default', NULL, 2, 0, NULL, 0, 0, 'none', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 0, 0)
                "#,
                [&harness.workspace_id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE workspaces SET unread = 1 WHERE id = ?1",
                [&harness.workspace_id],
            )
            .unwrap();

        workspaces::mark_workspace_read(&harness.workspace_id).unwrap();

        let (session_unread_total, workspace_unread): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COALESCE(SUM(unread_count), 0) FROM sessions WHERE workspace_id = ?1), (SELECT unread FROM workspaces WHERE id = ?1)",
                [&harness.workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(session_unread_total, 0);
        assert_eq!(workspace_unread, 0);
    }

    #[test]
    fn mark_workspace_unread_sets_workspace_flag_without_touching_sessions() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = ArchiveTestHarness::new(true);
        let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();

        connection
            .execute(
                "UPDATE sessions SET unread_count = 0 WHERE id = ?1",
                [&harness.session_id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE workspaces SET unread = 0 WHERE id = ?1",
                [&harness.workspace_id],
            )
            .unwrap();

        workspaces::mark_workspace_unread(&harness.workspace_id).unwrap();

        let (session_unread_total, workspace_unread): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COALESCE(SUM(unread_count), 0) FROM sessions WHERE workspace_id = ?1), (SELECT unread FROM workspaces WHERE id = ?1)",
                [&harness.workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(session_unread_total, 0);
        assert_eq!(workspace_unread, 1);
    }

    #[test]
    fn source_repo_branches_accessible_for_worktree_creation() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = RestoreTestHarness::new(true);
        let source = &harness.source_repo_root;

        git_ops::run_git(["-C", source.to_str().unwrap(), "checkout", "main"], None).unwrap();
        git_ops::run_git(
            [
                "-C",
                source.to_str().unwrap(),
                "checkout",
                "-b",
                "feature/second-restore-target",
            ],
            None,
        )
        .unwrap();
        fs::write(source.join("second.txt"), "second branch").unwrap();
        git_ops::run_git(["-C", source.to_str().unwrap(), "add", "second.txt"], None).unwrap();
        git_ops::run_git(
            [
                "-C",
                source.to_str().unwrap(),
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Helmor",
                "-c",
                "user.email=helmor@example.com",
                "commit",
                "-m",
                "second restore target",
            ],
            None,
        )
        .unwrap();

        // Branch should be directly visible in the source repo
        git_ops::verify_branch_exists(source, "feature/second-restore-target").unwrap();
        git_ops::verify_branch_exists(source, &harness.branch).unwrap();
    }

    #[test]
    fn list_repositories_filters_hidden_and_sorts_by_display_order() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        harness.insert_repo("repo-hidden", "hidden-repo", 0, 1);
        harness.insert_repo("repo-alpha", "alpha-repo", 0, 0);

        let repositories = repos::list_repositories().unwrap();
        let repository_names = repositories
            .iter()
            .map(|repository| repository.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(repository_names, vec!["alpha-repo", "demo-repo"]);
    }

    #[test]
    fn create_workspace_from_repo_creates_ready_workspace_and_initial_session() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();

        harness.commit_repo_files(&[
            (
                "conductor.json",
                r#"{"scripts":{"setup":"$CONDUCTOR_ROOT_PATH/conductor-setup.sh"}}"#,
            ),
            (
                "conductor-setup.sh",
                "#!/bin/sh\nset -e\nprintf '%s' \"$CONDUCTOR_ROOT_PATH\" > \"$CONDUCTOR_WORKSPACE_PATH/.context/setup-root.txt\"\nprintf 'json' > \"$CONDUCTOR_WORKSPACE_PATH/setup-from-json.txt\"\n",
            ),
        ]);

        let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

        assert_eq!(response.created_state, "ready");
        assert!(
            helpers::WORKSPACE_NAMES.contains(&response.directory_name.as_str()),
            "Expected a name from WORKSPACE_NAMES, got: {}",
            response.directory_name
        );
        assert!(
            response.branch.starts_with("caspian/"),
            "Expected caspian/ prefix, got: {}",
            response.branch
        );

        let workspace_dir = harness.workspace_dir(&response.directory_name);
        assert!(workspace_dir.join(".git").exists());
        assert!(workspace_dir.join(".context/notes.md").exists());
        assert!(workspace_dir.join(".context/todos.md").exists());
        assert!(workspace_dir.join(".context/attachments").is_dir());
        assert!(workspace_dir.join(".context/setup-root.txt").exists());
        assert!(workspace_dir.join("setup-from-json.txt").exists());

        let connection = Connection::open(harness.db_path()).unwrap();
        let (
            state,
            branch,
            placeholder_branch_name,
            initialization_parent_branch,
            intended_target_branch,
            initialization_files_copied,
            setup_log_path,
            initialization_log_path,
            active_session_id,
        ): (
            String,
            String,
            String,
            String,
            String,
            i64,
            String,
            String,
            String,
        ) = connection
            .query_row(
                r#"
                SELECT state, branch, placeholder_branch_name, initialization_parent_branch,
                  intended_target_branch, initialization_files_copied, setup_log_path,
                  initialization_log_path, active_session_id
                FROM workspaces WHERE id = ?1
                "#,
                [&response.created_workspace_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )
            .unwrap();
        let (session_title, session_model, session_permission_mode, thinking_enabled): (String, String, String, i64) = connection
            .query_row(
                "SELECT title, model, permission_mode, thinking_enabled FROM sessions WHERE id = ?1",
                [&active_session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(state, "ready");
        assert!(
            branch.starts_with("caspian/"),
            "Expected caspian/ prefix, got: {branch}"
        );
        assert_eq!(branch, placeholder_branch_name);
        assert_eq!(initialization_parent_branch, "main");
        assert_eq!(intended_target_branch, "main");
        assert!(initialization_files_copied > 0);
        assert!(Path::new(&setup_log_path).is_file());
        assert!(Path::new(&initialization_log_path).is_file());
        assert_eq!(session_title, "Untitled");
        assert_eq!(session_model, "opus");
        assert_eq!(session_permission_mode, "default");
        assert_eq!(thinking_enabled, 1);
    }

    #[test]
    fn create_workspace_from_repo_prefers_repo_setup_script_over_conductor_json() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        harness.set_repo_setup_script(Some("$CONDUCTOR_ROOT_PATH/repo-settings-setup.sh"));
        harness.commit_repo_files(&[
            (
                "conductor.json",
                r#"{"scripts":{"setup":"$CONDUCTOR_ROOT_PATH/conductor-setup.sh"}}"#,
            ),
            (
                "conductor-setup.sh",
                "#!/bin/sh\nset -e\nprintf 'json' > \"$CONDUCTOR_WORKSPACE_PATH/json-setup.txt\"\n",
            ),
            (
                "repo-settings-setup.sh",
                "#!/bin/sh\nset -e\nprintf 'repo' > \"$CONDUCTOR_WORKSPACE_PATH/repo-setup.txt\"\n",
            ),
        ]);

        let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();
        let workspace_dir = harness.workspace_dir(&response.directory_name);

        assert!(workspace_dir.join("repo-setup.txt").exists());
        assert!(!workspace_dir.join("json-setup.txt").exists());
    }

    #[test]
    fn create_workspace_from_repo_uses_v2_suffix_after_star_list_is_exhausted() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();

        for star_name in helpers::WORKSPACE_NAMES {
            harness.insert_workspace_name(star_name);
        }

        let response = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

        assert!(
            response.directory_name.ends_with("-v2"),
            "Expected -v2 suffix, got: {}",
            response.directory_name
        );
        assert!(
            response.branch.starts_with("caspian/") && response.branch.ends_with("-v2"),
            "Expected caspian/*-v2 branch, got: {}",
            response.branch
        );
    }

    #[test]
    fn create_workspace_from_repo_cleans_up_after_worktree_failure() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();

        // Create conflicting directories for ALL possible names so any random pick fails
        for name in helpers::WORKSPACE_NAMES {
            let dir = harness.workspace_dir(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("keep.txt"), "keep").unwrap();
        }

        let error = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap_err();

        assert!(error.to_string().contains("already exists"));

        let connection = Connection::open(harness.db_path()).unwrap();
        let (workspace_count, session_count): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM workspaces), (SELECT COUNT(*) FROM sessions)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(workspace_count, 0);
        assert_eq!(session_count, 0);
    }

    #[test]
    fn create_workspace_from_repo_cleans_up_after_setup_failure_and_keeps_logs() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();

        harness.commit_repo_files(&[
            (
                "conductor.json",
                r#"{"scripts":{"setup":"$CONDUCTOR_ROOT_PATH/conductor-setup.sh"}}"#,
            ),
            (
                "conductor-setup.sh",
                "#!/bin/sh\nset -e\necho 'failing setup'\nexit 7\n",
            ),
        ]);

        let error = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap_err();

        assert!(error.to_string().contains("Setup script failed"));
        assert!(!harness.workspace_dir("acamar").exists());

        let connection = Connection::open(harness.db_path()).unwrap();
        let (workspace_count, session_count): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM workspaces), (SELECT COUNT(*) FROM sessions)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(workspace_count, 0);
        assert_eq!(session_count, 0);

        let log_root = crate::data_dir::logs_dir().unwrap().join("workspaces");
        let mut log_files = fs::read_dir(&log_root)
            .unwrap()
            .flat_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        log_files.sort();

        assert!(!log_files.is_empty());
        let setup_log = log_files[0].join("setup.log");
        assert!(setup_log.is_file());
        let setup_log_contents = fs::read_to_string(setup_log).unwrap();
        assert!(setup_log_contents.contains("failing setup"));
    }

    #[test]
    fn add_repository_from_local_path_adds_repo_and_first_workspace() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        let added_repo_root = harness.root.join("added-repo");

        fs::create_dir_all(&added_repo_root).unwrap();
        init_create_git_repo(&added_repo_root);
        let normalized_repo_root = repos::normalize_filesystem_path(&added_repo_root).unwrap();

        let response =
            repos::add_repository_from_local_path(added_repo_root.to_str().unwrap()).unwrap();
        let connection = Connection::open(harness.db_path()).unwrap();
        let (repo_count, workspace_count, session_count): (i64, i64, i64) = connection
            .query_row(
                r#"SELECT (SELECT COUNT(*) FROM repos WHERE root_path = ?1), (SELECT COUNT(*) FROM workspaces WHERE repository_id = ?2), (SELECT COUNT(*) FROM sessions WHERE workspace_id = ?3)"#,
                (normalized_repo_root.as_str(), &response.repository_id, response.created_workspace_id.as_deref().unwrap()),
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let (remote, remote_url, default_branch): (Option<String>, Option<String>, String) =
            connection
                .query_row(
                    "SELECT remote, remote_url, default_branch FROM repos WHERE id = ?1",
                    [&response.repository_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
        let created_workspace_state: String = connection
            .query_row(
                "SELECT state FROM workspaces WHERE id = ?1",
                [response.selected_workspace_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();

        assert!(response.created_repository);
        assert_eq!(repo_count, 1);
        assert_eq!(workspace_count, 1);
        assert_eq!(session_count, 1);
        assert_eq!(response.created_workspace_state, "ready");
        assert_eq!(created_workspace_state, "ready");
        assert_eq!(default_branch, "main");
        assert_eq!(remote, None);
        assert_eq!(remote_url, None);
    }

    #[test]
    fn add_repository_from_local_path_focuses_existing_workspace_for_duplicate_repo() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        let created = workspaces::create_workspace_from_repo_impl(&harness.repo_id).unwrap();

        let response =
            repos::add_repository_from_local_path(harness.source_repo_root.to_str().unwrap())
                .unwrap();
        let connection = Connection::open(harness.db_path()).unwrap();
        let (repo_count, workspace_count): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM repos), (SELECT COUNT(*) FROM workspaces)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert!(!response.created_repository);
        assert_eq!(response.created_workspace_id, None);
        assert_eq!(response.selected_workspace_id, created.created_workspace_id);
        assert_eq!(response.created_workspace_state, "ready");
        assert_eq!(repo_count, 1);
        assert_eq!(workspace_count, 1);
    }

    #[test]
    fn add_repository_from_local_path_rejects_non_git_directory_without_side_effects() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let harness = CreateTestHarness::new();
        let plain_dir = harness.root.join("not-a-repo");
        fs::create_dir_all(&plain_dir).unwrap();

        let error = repos::add_repository_from_local_path(plain_dir.to_str().unwrap()).unwrap_err();
        let connection = Connection::open(harness.db_path()).unwrap();
        let (repo_count, workspace_count): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM repos), (SELECT COUNT(*) FROM workspaces)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert!(error.to_string().contains("Git working tree"));
        assert_eq!(repo_count, 1);
        assert_eq!(workspace_count, 0);
    }

    // ---- Test helpers ----

    fn init_create_git_repo(repo_root: &Path) {
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
        // Switch back to main so feature/restore-target is free for worktree checkout
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
            .execute("INSERT INTO repos (id, name, remote_url, default_branch, root_path) VALUES (?1, ?2, NULL, 'main', ?3)", ["repo-1", repo_name, source_repo_root.to_str().unwrap()])
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

        let archived_attachment_path =
            crate::data_dir::archived_context_dir(repo_name, directory_name)
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
            .execute("INSERT INTO repos (id, name, remote_url, default_branch, root_path) VALUES (?1, ?2, NULL, 'main', ?3)", ["repo-1", repo_name, source_repo_root.to_str().unwrap()])
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
}
