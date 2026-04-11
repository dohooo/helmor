use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use anyhow::{bail, Context, Result};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, Debouncer, FileIdMap};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::models::db;

// -- Events --

pub const GIT_BRANCH_CHANGED_EVENT: &str = "git-branch-changed";
pub const GIT_REFS_CHANGED_EVENT: &str = "git-refs-changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchChangedPayload {
    pub workspace_id: String,
    pub old_branch: Option<String>,
    pub new_branch: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefsChangedPayload {
    pub workspace_id: String,
}

// -- Internal state per workspace --

struct WorkspaceWatcher {
    /// Dropping the debouncer stops its background threads.
    _debouncer: Debouncer<notify::RecommendedWatcher, FileIdMap>,
}

/// Lightweight record of what we need to set up a watcher.
struct WatchableWorkspace {
    id: String,
    repo_name: String,
    directory_name: String,
    branch: Option<String>,
    state: String,
}

// -- Manager (Tauri-managed state) --

pub struct GitWatcherManager {
    watchers: Mutex<HashMap<String, WorkspaceWatcher>>,
}

impl Default for GitWatcherManager {
    fn default() -> Self {
        Self::new()
    }
}

impl GitWatcherManager {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }

    /// Sync watchers with the current DB state. Starts watchers for new ready
    /// workspaces, stops watchers for removed/archived ones.
    pub fn sync_from_db(&self, app: AppHandle) -> Result<()> {
        let workspaces = load_watchable_workspaces()?;
        let ready_ids: HashMap<String, WatchableWorkspace> = workspaces
            .into_iter()
            .filter(|w| w.state == "ready")
            .map(|w| (w.id.clone(), w))
            .collect();

        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| anyhow::anyhow!("git watcher lock poisoned"))?;

        // Remove watchers for workspaces no longer ready
        watchers.retain(|id, _| {
            if ready_ids.contains_key(id) {
                true
            } else {
                tracing::debug!(workspace_id = %id, "Stopping git watcher (no longer ready)");
                false
            }
        });

        // Start watchers for new ready workspaces
        for (id, ws) in &ready_ids {
            if watchers.contains_key(id) {
                continue;
            }
            match start_watcher(&app, ws) {
                Ok(watcher) => {
                    tracing::info!(workspace_id = %id, "Started git watcher");
                    watchers.insert(id.clone(), watcher);
                }
                Err(e) => {
                    tracing::warn!(workspace_id = %id, "Failed to start git watcher: {e:#}");
                }
            }
        }

        Ok(())
    }

    /// Stop watching a single workspace.
    pub fn unwatch(&self, workspace_id: &str) {
        if let Ok(mut watchers) = self.watchers.lock() {
            if watchers.remove(workspace_id).is_some() {
                tracing::debug!(workspace_id, "Stopped git watcher");
            }
        }
    }

    /// Stop all watchers (app shutdown).
    pub fn shutdown(&self) {
        if let Ok(mut watchers) = self.watchers.lock() {
            let count = watchers.len();
            watchers.clear();
            if count > 0 {
                tracing::info!(count, "Shut down all git watchers");
            }
        }
    }
}

// -- Gitdir resolution --

/// Resolve the `.git` directory for a workspace. Handles both normal repos
/// (`.git` is a directory) and worktrees (`.git` is a file with `gitdir: ...`).
fn resolve_gitdir(workspace_dir: &Path) -> Result<PathBuf> {
    let dot_git = workspace_dir.join(".git");
    if dot_git.is_dir() {
        return Ok(dot_git);
    }
    if dot_git.is_file() {
        let content = fs::read_to_string(&dot_git)
            .with_context(|| format!("Failed to read {}", dot_git.display()))?;
        let path_str = content
            .lines()
            .find(|l| l.starts_with("gitdir:"))
            .context("No gitdir line in .git file")?
            .trim_start_matches("gitdir:")
            .trim();
        let resolved = if Path::new(path_str).is_absolute() {
            PathBuf::from(path_str)
        } else {
            workspace_dir.join(path_str)
        };
        // canonicalize may fail on some OSes if intermediate dirs have issues
        return Ok(resolved.canonicalize().unwrap_or(resolved));
    }
    bail!("No .git found at {}", workspace_dir.display())
}

/// For worktrees, refs are shared in the "common dir". For normal repos
/// this is the same as the gitdir.
fn resolve_common_dir(gitdir: &Path) -> PathBuf {
    let common_dir_file = gitdir.join("commondir");
    if let Ok(content) = fs::read_to_string(&common_dir_file) {
        let trimmed = content.trim();
        let path = if Path::new(trimmed).is_absolute() {
            PathBuf::from(trimmed)
        } else {
            gitdir.join(trimmed)
        };
        return path.canonicalize().unwrap_or(path);
    }
    gitdir.to_path_buf()
}

/// Read the current branch from HEAD. Returns `None` for detached HEAD.
fn read_head_branch(gitdir: &Path) -> Option<String> {
    let head_path = gitdir.join("HEAD");
    let content = fs::read_to_string(head_path).ok()?;
    content
        .trim()
        .strip_prefix("ref: refs/heads/")
        .map(String::from)
}

// -- Watcher setup --

fn start_watcher(app: &AppHandle, ws: &WatchableWorkspace) -> Result<WorkspaceWatcher> {
    let workspace_dir = crate::data_dir::workspace_dir(&ws.repo_name, &ws.directory_name)?;
    if !workspace_dir.is_dir() {
        bail!("Workspace directory missing: {}", workspace_dir.display());
    }

    let gitdir = resolve_gitdir(&workspace_dir)?;
    let common_dir = resolve_common_dir(&gitdir);

    let workspace_id = ws.id.clone();
    let db_branch = ws.branch.clone();
    let app_handle = app.clone();
    let gitdir_for_callback = gitdir.clone();

    // Shared state for the callback: last-known branch
    let last_branch = std::sync::Arc::new(Mutex::new(db_branch));
    let last_branch_clone = last_branch.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                Err(errors) => {
                    for e in errors {
                        tracing::warn!(workspace_id = %workspace_id, "notify error: {e}");
                    }
                    return;
                }
            };

            let mut head_changed = false;
            let mut refs_changed = false;

            for event in &events {
                for path in &event.event.paths {
                    let path_str = path.to_string_lossy();
                    // Skip lock files — transient git state
                    if path_str.ends_with(".lock") {
                        continue;
                    }
                    if path_str.contains("ORIG_HEAD")
                        || path_str.contains("FETCH_HEAD")
                        || path_str.contains("MERGE_HEAD")
                    {
                        continue;
                    }

                    if path.ends_with("HEAD") {
                        head_changed = true;
                    } else if path_str.contains("refs/heads")
                        || path_str.contains("refs/remotes")
                        || path_str.ends_with("packed-refs")
                    {
                        refs_changed = true;
                    }
                }
            }

            if head_changed {
                handle_head_change(
                    &app_handle,
                    &workspace_id,
                    &gitdir_for_callback,
                    &last_branch_clone,
                );
            }
            if refs_changed {
                if let Err(e) = app_handle.emit(
                    GIT_REFS_CHANGED_EVENT,
                    GitRefsChangedPayload {
                        workspace_id: workspace_id.clone(),
                    },
                ) {
                    tracing::warn!("Failed to emit git-refs-changed: {e}");
                }
            }
        },
    )
    .context("Failed to create git debouncer")?;

    // Watch HEAD (in the worktree-specific gitdir)
    let head_path = gitdir.join("HEAD");
    if head_path.exists() {
        debouncer
            .watch(&head_path, RecursiveMode::NonRecursive)
            .with_context(|| format!("Failed to watch {}", head_path.display()))?;
    }

    // Watch shared refs directories
    let refs_heads = common_dir.join("refs").join("heads");
    if refs_heads.is_dir() {
        debouncer
            .watch(&refs_heads, RecursiveMode::Recursive)
            .with_context(|| format!("Failed to watch {}", refs_heads.display()))?;
    }

    let refs_remotes = common_dir.join("refs").join("remotes");
    if refs_remotes.is_dir() {
        debouncer
            .watch(&refs_remotes, RecursiveMode::Recursive)
            .with_context(|| format!("Failed to watch {}", refs_remotes.display()))?;
    }

    // Watch common_dir itself (non-recursive) to catch packed-refs creation
    // and any other top-level gitdir changes.
    debouncer
        .watch(&common_dir, RecursiveMode::NonRecursive)
        .with_context(|| format!("Failed to watch {}", common_dir.display()))?;

    // Seed last_branch with the actual current HEAD
    if let Some(current) = read_head_branch(&gitdir) {
        if let Ok(mut lb) = last_branch.lock() {
            *lb = Some(current);
        }
    }

    Ok(WorkspaceWatcher {
        _debouncer: debouncer,
    })
}

/// Detect branch name change from HEAD, update DB if needed, emit event.
fn handle_head_change(
    app: &AppHandle,
    workspace_id: &str,
    gitdir: &Path,
    last_branch: &Mutex<Option<String>>,
) {
    let new_branch = read_head_branch(gitdir);
    let old_branch = last_branch.lock().ok().and_then(|b| b.clone());

    if new_branch == old_branch {
        return;
    }

    tracing::info!(
        workspace_id,
        old = ?old_branch,
        new = ?new_branch,
        "Git branch changed (external)"
    );

    // Update cached value
    if let Ok(mut lb) = last_branch.lock() {
        *lb = new_branch.clone();
    }

    // Update DB branch column (CAS: only if DB still holds old_branch)
    if let Some(ref branch) = new_branch {
        if let Err(e) = update_branch_in_db(workspace_id, old_branch.as_deref(), branch) {
            tracing::error!(workspace_id, "Failed to update branch in DB: {e:#}");
        }
    }

    if let Err(e) = app.emit(
        GIT_BRANCH_CHANGED_EVENT,
        GitBranchChangedPayload {
            workspace_id: workspace_id.to_string(),
            old_branch,
            new_branch,
        },
    ) {
        tracing::warn!("Failed to emit git-branch-changed: {e}");
    }
}

/// CAS-style update: only writes if the DB still holds `old_branch`.
/// This prevents overwriting a concurrent `rename_workspace_branch` call.
fn update_branch_in_db(
    workspace_id: &str,
    old_branch: Option<&str>,
    new_branch: &str,
) -> Result<()> {
    let connection = db::open_connection(true)?;
    let rows = match old_branch {
        Some(old) => connection.execute(
            "UPDATE workspaces SET branch = ?1 WHERE id = ?2 AND state = 'ready' AND branch = ?3",
            (new_branch, workspace_id, old),
        ),
        None => connection.execute(
            "UPDATE workspaces SET branch = ?1 WHERE id = ?2 AND state = 'ready' AND branch IS NULL",
            (new_branch, workspace_id),
        ),
    }
    .context("Failed to update workspace branch from git watcher")?;
    if rows == 0 {
        tracing::debug!(
            workspace_id,
            "CAS miss: branch already changed by another path"
        );
    }
    Ok(())
}

// -- DB helper --

fn load_watchable_workspaces() -> Result<Vec<WatchableWorkspace>> {
    let connection = db::open_connection(false)?;
    let mut stmt = connection.prepare(
        "SELECT w.id, r.name, w.directory_name, w.branch, w.state
         FROM workspaces w
         JOIN repos r ON r.id = w.repository_id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(WatchableWorkspace {
            id: row.get(0)?,
            repo_name: row.get(1)?,
            directory_name: row.get(2)?,
            branch: row.get(3)?,
            state: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Called from workspace lifecycle commands to keep watchers in sync.
pub fn notify_workspace_changed(app: &AppHandle) {
    let manager = app.state::<GitWatcherManager>();
    if let Err(e) = manager.sync_from_db(app.clone()) {
        tracing::warn!("Failed to sync git watchers after workspace change: {e:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"));
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init"]);
        git(dir.path(), &["checkout", "-b", "main"]);
        git(dir.path(), &["config", "user.email", "test@helmor.dev"]);
        git(dir.path(), &["config", "user.name", "Test"]);
        std::fs::write(dir.path().join("f.txt"), "init\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", "init"]);
        dir
    }

    // -- resolve_gitdir --

    #[test]
    fn resolve_gitdir_normal_repo() {
        let repo = init_repo();
        let gitdir = resolve_gitdir(repo.path()).unwrap();
        assert_eq!(gitdir, repo.path().join(".git"));
        assert!(gitdir.is_dir());
    }

    #[test]
    fn resolve_gitdir_worktree() {
        let repo = init_repo();
        git(repo.path(), &["branch", "wt-branch"]);
        let wt_dir = tempfile::tempdir().unwrap();
        git(
            repo.path(),
            &[
                "worktree",
                "add",
                &wt_dir.path().display().to_string(),
                "wt-branch",
            ],
        );

        let gitdir = resolve_gitdir(wt_dir.path()).unwrap();
        // Worktree gitdir lives inside the main repo's .git/worktrees/
        assert!(gitdir.is_dir());
        assert!(gitdir.join("HEAD").exists());
        // It should NOT be .git itself (that's a file in worktrees)
        assert!(wt_dir.path().join(".git").is_file());
    }

    #[test]
    fn resolve_gitdir_missing() {
        let dir = tempfile::tempdir().unwrap();
        let result = resolve_gitdir(dir.path());
        assert!(result.is_err());
    }

    // -- resolve_common_dir --

    #[test]
    fn resolve_common_dir_normal_repo() {
        let repo = init_repo();
        let gitdir = resolve_gitdir(repo.path()).unwrap();
        let common = resolve_common_dir(&gitdir);
        // For a normal repo, common dir == gitdir
        assert_eq!(common, gitdir);
    }

    #[test]
    fn resolve_common_dir_worktree() {
        let repo = init_repo();
        git(repo.path(), &["branch", "wt-branch"]);
        let wt_dir = tempfile::tempdir().unwrap();
        git(
            repo.path(),
            &[
                "worktree",
                "add",
                &wt_dir.path().display().to_string(),
                "wt-branch",
            ],
        );

        let gitdir = resolve_gitdir(wt_dir.path()).unwrap();
        let common = resolve_common_dir(&gitdir);
        // Common dir should be the main repo's .git
        let main_gitdir = repo.path().join(".git").canonicalize().unwrap();
        assert_eq!(common, main_gitdir);
    }

    // -- read_head_branch --

    #[test]
    fn read_head_branch_on_branch() {
        let repo = init_repo();
        let gitdir = resolve_gitdir(repo.path()).unwrap();
        assert_eq!(read_head_branch(&gitdir), Some("main".to_string()));
    }

    #[test]
    fn read_head_branch_detached() {
        let repo = init_repo();
        git(repo.path(), &["checkout", "--detach", "HEAD"]);
        let gitdir = resolve_gitdir(repo.path()).unwrap();
        assert_eq!(read_head_branch(&gitdir), None);
    }

    #[test]
    fn read_head_branch_after_checkout() {
        let repo = init_repo();
        git(repo.path(), &["checkout", "-b", "feature/test"]);
        let gitdir = resolve_gitdir(repo.path()).unwrap();
        assert_eq!(read_head_branch(&gitdir), Some("feature/test".to_string()));
    }

    #[test]
    fn read_head_branch_after_rename() {
        let repo = init_repo();
        git(repo.path(), &["branch", "-m", "main", "trunk"]);
        let gitdir = resolve_gitdir(repo.path()).unwrap();
        assert_eq!(read_head_branch(&gitdir), Some("trunk".to_string()));
    }

    #[test]
    fn read_head_branch_worktree() {
        let repo = init_repo();
        git(repo.path(), &["branch", "wt-branch"]);
        let wt_dir = tempfile::tempdir().unwrap();
        git(
            repo.path(),
            &[
                "worktree",
                "add",
                &wt_dir.path().display().to_string(),
                "wt-branch",
            ],
        );

        let wt_gitdir = resolve_gitdir(wt_dir.path()).unwrap();
        assert_eq!(read_head_branch(&wt_gitdir), Some("wt-branch".to_string()));
        // Main repo still on main
        let main_gitdir = resolve_gitdir(repo.path()).unwrap();
        assert_eq!(read_head_branch(&main_gitdir), Some("main".to_string()));
    }

    // -- GitWatcherManager --

    #[test]
    fn manager_unwatch_noop_for_unknown() {
        let manager = GitWatcherManager::new();
        manager.unwatch("nonexistent"); // should not panic
    }

    #[test]
    fn manager_shutdown_clears_all() {
        let manager = GitWatcherManager::new();
        manager.shutdown();
        let watchers = manager.watchers.lock().unwrap();
        assert!(watchers.is_empty());
    }

    // -- Payload serialization --

    #[test]
    fn branch_changed_payload_serializes_camel_case() {
        let payload = GitBranchChangedPayload {
            workspace_id: "ws-1".to_string(),
            old_branch: Some("main".to_string()),
            new_branch: Some("trunk".to_string()),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["workspaceId"], "ws-1");
        assert_eq!(json["oldBranch"], "main");
        assert_eq!(json["newBranch"], "trunk");
    }

    #[test]
    fn refs_changed_payload_serializes_camel_case() {
        let payload = GitRefsChangedPayload {
            workspace_id: "ws-2".to_string(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["workspaceId"], "ws-2");
    }

    #[test]
    fn branch_changed_payload_null_branches() {
        let payload = GitBranchChangedPayload {
            workspace_id: "ws-1".to_string(),
            old_branch: None,
            new_branch: None,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert!(json["oldBranch"].is_null());
        assert!(json["newBranch"].is_null());
    }
}
