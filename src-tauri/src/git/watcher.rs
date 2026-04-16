use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{git_ops, models::db};

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

const AUTO_FETCH_INTERVAL: Duration = Duration::from_secs(120);

/// One auto-fetch thread per unique (repo_id, remote, branch).
type FetchKey = (String, String, String);

// -- Internal state per workspace --

struct WorkspaceWatcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
    /// Stored for change detection — if these change we restart the watcher.
    remote: Option<String>,
    target_branch: Option<String>,
}

/// Tracks a single auto-fetch loop for one unique target.
/// The `cancel` field stops the thread on drop.
#[allow(dead_code)]
struct FetcherEntry {
    workspace_dir: PathBuf,
    cancel: AutoFetchCancel,
}

/// Sets the cancel flag on drop so the fetch thread exits promptly.
struct AutoFetchCancel(Arc<AtomicBool>);

impl Drop for AutoFetchCancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Lightweight record of what we need to set up a watcher.
struct WatchableWorkspace {
    id: String,
    repo_id: String,
    repo_name: String,
    directory_name: String,
    branch: Option<String>,
    state: String,
    remote: Option<String>,
    target_branch: Option<String>,
}

// -- Manager (Tauri-managed state) --

pub struct GitWatcherManager {
    watchers: Mutex<HashMap<String, WorkspaceWatcher>>,
    /// One auto-fetch loop per unique (repo_name, remote, branch).
    fetchers: Mutex<HashMap<FetchKey, FetcherEntry>>,
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
            fetchers: Mutex::new(HashMap::new()),
        }
    }

    /// Sync watchers and auto-fetchers with the current DB state.
    pub fn sync_from_db(&self, app: AppHandle) -> Result<()> {
        let workspaces = load_watchable_workspaces()?;
        let ready: Vec<&WatchableWorkspace> =
            workspaces.iter().filter(|w| w.state == "ready").collect();
        let ready_ids: HashMap<&str, &WatchableWorkspace> =
            ready.iter().map(|w| (w.id.as_str(), *w)).collect();

        // ── Sync file-system watchers (per workspace) ──
        {
            let mut watchers = self
                .watchers
                .lock()
                .map_err(|_| anyhow::anyhow!("git watcher lock poisoned"))?;

            watchers.retain(|id, _| {
                if ready_ids.contains_key(id.as_str()) {
                    true
                } else {
                    tracing::debug!(workspace_id = %id, "Stopping git watcher (no longer ready)");
                    false
                }
            });

            // Restart watchers whose remote/target_branch changed
            let restart_ids: Vec<String> = ready_ids
                .iter()
                .filter(|(id, ws)| {
                    watchers.get(**id).is_some_and(|w| {
                        w.remote != ws.remote || w.target_branch != ws.target_branch
                    })
                })
                .map(|(id, _)| id.to_string())
                .collect();
            for id in &restart_ids {
                tracing::info!(workspace_id = %id, "Restarting git watcher (target changed)");
                watchers.remove(id);
            }

            for (id, ws) in &ready_ids {
                if watchers.contains_key(*id) {
                    continue;
                }
                match start_watcher(&app, ws) {
                    Ok(watcher) => {
                        tracing::info!(workspace_id = %id, "Started git watcher");
                        watchers.insert(id.to_string(), watcher);
                    }
                    Err(e) => {
                        tracing::warn!(workspace_id = %id, "Failed to start git watcher: {e:#}");
                    }
                }
            }
        }

        // ── Sync auto-fetchers (per unique target) ──
        {
            let mut fetchers = self
                .fetchers
                .lock()
                .map_err(|_| anyhow::anyhow!("fetcher lock poisoned"))?;

            let desired = build_desired_fetch_targets(&ready);

            // Stop fetchers for targets no longer needed
            fetchers.retain(|key, _| {
                if desired.contains_key(key) {
                    true
                } else {
                    tracing::debug!(repo = %key.0, remote = %key.1, branch = %key.2,
                        "Stopping auto-fetch (no longer needed)");
                    false
                }
            });

            // Restart fetchers whose workspace_dir changed (e.g. workspace deleted)
            let restart_keys: Vec<FetchKey> = fetchers
                .iter()
                .filter(|(key, entry)| {
                    desired
                        .get(key)
                        .is_some_and(|dir| *dir != entry.workspace_dir)
                })
                .map(|(key, _)| key.clone())
                .collect();
            for key in &restart_keys {
                fetchers.remove(key);
            }

            // Start fetchers for new targets
            for (key, dir) in &desired {
                if fetchers.contains_key(key) {
                    continue;
                }
                let cancel = start_auto_fetch(key, dir);
                tracing::info!(repo = %key.0, remote = %key.1, branch = %key.2,
                    "Started auto-fetch");
                fetchers.insert(
                    key.clone(),
                    FetcherEntry {
                        workspace_dir: dir.clone(),
                        cancel,
                    },
                );
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

    /// Stop all watchers and fetchers (app shutdown).
    pub fn shutdown(&self) {
        if let Ok(mut watchers) = self.watchers.lock() {
            let count = watchers.len();
            watchers.clear();
            if count > 0 {
                tracing::info!(count, "Shut down all git watchers");
            }
        }
        if let Ok(mut fetchers) = self.fetchers.lock() {
            let count = fetchers.len();
            fetchers.clear();
            if count > 0 {
                tracing::info!(count, "Shut down all auto-fetchers");
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
        remote: ws.remote.clone(),
        target_branch: ws.target_branch.clone(),
    })
}

// -- Auto-fetch (one thread per unique target) --

/// Build the set of fetch targets from ready workspaces.
/// Deduplicates by (repo_id, remote, branch) and skips non-existent directories.
fn build_desired_fetch_targets(workspaces: &[&WatchableWorkspace]) -> HashMap<FetchKey, PathBuf> {
    let mut desired = HashMap::new();
    for ws in workspaces {
        if let (Some(remote), Some(branch)) = (&ws.remote, &ws.target_branch) {
            let key = (ws.repo_id.clone(), remote.clone(), branch.clone());
            if desired.contains_key(&key) {
                continue;
            }
            if let Ok(dir) = crate::data_dir::workspace_dir(&ws.repo_name, &ws.directory_name) {
                if dir.is_dir() {
                    desired.insert(key, dir);
                }
            }
        }
    }
    desired
}

fn start_auto_fetch(key: &FetchKey, workspace_dir: &Path) -> AutoFetchCancel {
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_flag = cancelled.clone();

    let (repo, remote, branch) = key.clone();
    let dir = workspace_dir.to_path_buf();

    thread::Builder::new()
        .name(format!("auto-fetch-{repo}/{remote}/{branch}"))
        .spawn(move || {
            run_fetch(&dir, &remote, &branch, &repo);

            loop {
                if sleep_interruptible(&cancel_flag, AUTO_FETCH_INTERVAL) {
                    break;
                }
                run_fetch(&dir, &remote, &branch, &repo);
            }

            tracing::debug!(repo, remote, branch, "Auto-fetch thread stopped");
        })
        .ok();

    AutoFetchCancel(cancelled)
}

fn run_fetch(workspace_dir: &Path, remote: &str, branch: &str, repo_name: &str) {
    match git_ops::fetch_remote_branch(workspace_dir, remote, branch) {
        Ok(()) => tracing::debug!(repo_name, remote, branch, "Fetch completed"),
        Err(e) => tracing::debug!(repo_name, "Fetch failed (expected offline): {e:#}"),
    }
}

// -- Triggered fetch (user interaction, throttled per target) --

const TRIGGER_THROTTLE: Duration = Duration::from_secs(15);

/// Tracks last triggered-fetch time per target to avoid redundant network calls.
static TRIGGER_LAST: LazyLock<Mutex<HashMap<FetchKey, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Trigger an async fetch for a workspace's target branch.
/// Throttled: same (repo, remote, branch) won't re-fetch within 15 s.
pub fn trigger_fetch_for_workspace(workspace_id: &str) {
    let ws_id = workspace_id.to_string();

    thread::Builder::new()
        .name(format!("trigger-fetch-{ws_id}"))
        .spawn(move || {
            if let Err(e) = do_triggered_fetch(&ws_id) {
                tracing::debug!(workspace_id = %ws_id, "Triggered fetch failed: {e:#}");
            }
        })
        .ok();
}

fn do_triggered_fetch(workspace_id: &str) -> Result<()> {
    let (workspace_dir, remote, branch, repo_id) = lookup_fetch_target(workspace_id)?;

    let key = (repo_id.clone(), remote.clone(), branch.clone());

    // Check-and-stamp atomically: write the timestamp BEFORE fetching so
    // concurrent triggers for the same target are rejected immediately.
    if let Ok(mut map) = TRIGGER_LAST.lock() {
        if map
            .get(&key)
            .is_some_and(|t| t.elapsed() < TRIGGER_THROTTLE)
        {
            tracing::debug!(workspace_id, "Triggered fetch throttled");
            return Ok(());
        }
        map.insert(key, Instant::now());
    }

    run_fetch(&workspace_dir, &remote, &branch, &repo_id);

    Ok(())
}

/// Returns (workspace_dir, remote, branch, repo_id).
fn lookup_fetch_target(workspace_id: &str) -> Result<(PathBuf, String, String, String)> {
    let connection = db::open_connection(false)?;
    let mut stmt = connection.prepare(
        "SELECT r.name, w.directory_name, r.remote,
                COALESCE(w.intended_target_branch, r.default_branch), r.id
         FROM workspaces w
         JOIN repos r ON r.id = w.repository_id
         WHERE w.id = ?1 AND w.state = 'ready'",
    )?;
    let (repo_name, dir_name, remote, branch, repo_id) = stmt
        .query_row(rusqlite::params![workspace_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .context("Workspace not found or not ready")?;

    let remote = remote.context("No remote configured")?;
    let branch = branch.context("No target branch configured")?;
    let workspace_dir = crate::data_dir::workspace_dir(&repo_name, &dir_name)?;
    Ok((workspace_dir, remote, branch, repo_id))
}

/// Sleep for `duration`, checking the cancel flag every second.
/// Returns `true` if cancelled.
fn sleep_interruptible(cancel: &AtomicBool, duration: Duration) -> bool {
    let step = Duration::from_secs(1);
    let mut remaining = duration;
    while remaining > Duration::ZERO {
        if cancel.load(Ordering::Relaxed) {
            return true;
        }
        let t = remaining.min(step);
        thread::sleep(t);
        remaining = remaining.saturating_sub(t);
    }
    cancel.load(Ordering::Relaxed)
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
        "SELECT w.id, r.name, w.directory_name, w.branch, w.state,
                r.remote, COALESCE(w.intended_target_branch, r.default_branch), r.id
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
            remote: row.get(5)?,
            target_branch: row.get(6)?,
            repo_id: row.get(7)?,
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

    // -- FetchKey identity --

    #[test]
    fn fetch_key_uses_repo_id_not_name() {
        // Two repos with the same name but different IDs must produce different keys
        let key_a: FetchKey = ("repo-id-aaa".into(), "origin".into(), "main".into());
        let key_b: FetchKey = ("repo-id-bbb".into(), "origin".into(), "main".into());
        assert_ne!(key_a, key_b);
    }

    #[test]
    fn fetch_key_same_repo_different_branches_are_distinct() {
        let key_main: FetchKey = ("repo-1".into(), "origin".into(), "main".into());
        let key_dev: FetchKey = ("repo-1".into(), "origin".into(), "develop".into());
        assert_ne!(key_main, key_dev);
    }

    // -- AutoFetchCancel --

    #[test]
    fn auto_fetch_cancel_sets_flag_on_drop() {
        let flag = Arc::new(AtomicBool::new(false));
        let guard = AutoFetchCancel(flag.clone());
        assert!(!flag.load(Ordering::Relaxed));
        drop(guard);
        assert!(flag.load(Ordering::Relaxed));
    }

    // -- sleep_interruptible --

    #[test]
    fn sleep_interruptible_returns_false_when_not_cancelled() {
        let cancel = AtomicBool::new(false);
        let cancelled = sleep_interruptible(&cancel, Duration::from_millis(10));
        assert!(!cancelled);
    }

    #[test]
    fn sleep_interruptible_returns_true_when_pre_cancelled() {
        let cancel = AtomicBool::new(true);
        let cancelled = sleep_interruptible(&cancel, Duration::from_secs(60));
        assert!(cancelled);
    }

    // -- Trigger throttle --

    #[test]
    fn trigger_throttle_per_target() {
        // Clear any state from other tests
        let key_a: FetchKey = ("throttle-test-a".into(), "origin".into(), "main".into());
        let key_b: FetchKey = ("throttle-test-b".into(), "origin".into(), "main".into());

        // Record a recent fetch for key_a
        if let Ok(mut map) = TRIGGER_LAST.lock() {
            map.insert(key_a.clone(), Instant::now());
        }

        // key_a should be throttled
        let throttled_a = TRIGGER_LAST
            .lock()
            .ok()
            .and_then(|m| m.get(&key_a).map(|t| t.elapsed() < TRIGGER_THROTTLE))
            .unwrap_or(false);
        assert!(throttled_a, "same target should be throttled");

        // key_b should NOT be throttled
        let throttled_b = TRIGGER_LAST
            .lock()
            .ok()
            .and_then(|m| m.get(&key_b).map(|t| t.elapsed() < TRIGGER_THROTTLE))
            .unwrap_or(false);
        assert!(!throttled_b, "different target should not be throttled");
    }

    // -- Manager fetcher lifecycle --

    #[test]
    fn manager_shutdown_clears_fetchers() {
        let manager = GitWatcherManager::new();
        // Insert a dummy fetcher
        if let Ok(mut fetchers) = manager.fetchers.lock() {
            let cancel = AutoFetchCancel(Arc::new(AtomicBool::new(false)));
            fetchers.insert(
                ("repo-1".into(), "origin".into(), "main".into()),
                FetcherEntry {
                    workspace_dir: PathBuf::from("/tmp/test"),
                    cancel,
                },
            );
        }
        manager.shutdown();
        let fetchers = manager.fetchers.lock().unwrap();
        assert!(fetchers.is_empty());
    }

    // -- Integration tests (DB + filesystem) --

    use crate::testkit::{self, GitTestRepo, TestEnv, WorkspaceFixture};

    fn make_workspace_dir(env: &TestEnv, repo_name: &str, dir_name: &str) -> PathBuf {
        let dir = env.root.join("workspaces").join(repo_name).join(dir_name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn same_repo_multiple_workspaces_produce_one_fetch_key() {
        let env = TestEnv::new("fetch-dedup-same");
        let conn = env.db_connection();

        testkit::insert_repo(&conn, "repo-1", "myapp", Some("origin"));
        testkit::insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "ws-a",
                repo_id: "repo-1",
                directory_name: "ws-a",
                state: "ready",
                branch: Some("feat"),
                intended_target_branch: Some("main"),
            },
        );
        testkit::insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "ws-b",
                repo_id: "repo-1",
                directory_name: "ws-b",
                state: "ready",
                branch: Some("feat2"),
                intended_target_branch: Some("main"),
            },
        );
        make_workspace_dir(&env, "myapp", "ws-a");
        make_workspace_dir(&env, "myapp", "ws-b");

        let workspaces = load_watchable_workspaces().unwrap();
        let ready: Vec<&WatchableWorkspace> =
            workspaces.iter().filter(|w| w.state == "ready").collect();
        let targets = build_desired_fetch_targets(&ready);

        assert_eq!(targets.len(), 1, "same repo+remote+branch → one key");
        assert!(targets.contains_key(&("repo-1".into(), "origin".into(), "main".into())));
    }

    #[test]
    fn same_name_different_repos_produce_distinct_keys() {
        let env = TestEnv::new("fetch-dedup-distinct");
        let conn = env.db_connection();

        testkit::insert_repo(&conn, "repo-aaa", "myapp", Some("origin"));
        testkit::insert_repo(&conn, "repo-bbb", "myapp", Some("origin"));
        testkit::insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "ws-1",
                repo_id: "repo-aaa",
                directory_name: "ws-1",
                state: "ready",
                branch: Some("dev"),
                intended_target_branch: Some("main"),
            },
        );
        testkit::insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "ws-2",
                repo_id: "repo-bbb",
                directory_name: "ws-2",
                state: "ready",
                branch: Some("dev"),
                intended_target_branch: Some("main"),
            },
        );
        // Both share the same repo name "myapp" but have different repo IDs
        make_workspace_dir(&env, "myapp", "ws-1");
        make_workspace_dir(&env, "myapp", "ws-2");

        let workspaces = load_watchable_workspaces().unwrap();
        let ready: Vec<&WatchableWorkspace> =
            workspaces.iter().filter(|w| w.state == "ready").collect();
        let targets = build_desired_fetch_targets(&ready);

        assert_eq!(targets.len(), 2, "different repo_id → distinct keys");
        assert!(targets.contains_key(&("repo-aaa".into(), "origin".into(), "main".into())));
        assert!(targets.contains_key(&("repo-bbb".into(), "origin".into(), "main".into())));
    }

    #[test]
    fn invalid_workspace_dir_excluded_from_desired() {
        let env = TestEnv::new("fetch-invalid-dir");
        let conn = env.db_connection();

        testkit::insert_repo(&conn, "repo-1", "ghost-repo", Some("origin"));
        testkit::insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "ws-ghost",
                repo_id: "repo-1",
                directory_name: "does-not-exist",
                state: "ready",
                branch: Some("dev"),
                intended_target_branch: Some("main"),
            },
        );
        // Intentionally NOT creating the directory

        let workspaces = load_watchable_workspaces().unwrap();
        let ready: Vec<&WatchableWorkspace> =
            workspaces.iter().filter(|w| w.state == "ready").collect();
        let targets = build_desired_fetch_targets(&ready);

        assert!(targets.is_empty(), "non-existent dir should be excluded");
    }

    #[test]
    fn triggered_fetch_throttles_same_target() {
        let env = TestEnv::new("fetch-trigger-throttle");
        let conn = env.db_connection();
        let (_origin, clone) = GitTestRepo::with_remote();

        // Create workspace dir as a symlink/copy of the clone
        let ws_dir = make_workspace_dir(&env, "throttle-repo", "ws-1");
        // Initialize git in the workspace dir so fetch can work
        fs::remove_dir(&ws_dir).unwrap();
        crate::git_ops::run_git(
            [
                "clone",
                &clone.path().display().to_string(),
                &ws_dir.display().to_string(),
            ],
            None,
        )
        .unwrap();

        testkit::insert_repo(&conn, "repo-throttle", "throttle-repo", Some("origin"));
        testkit::insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: "ws-throttle",
                repo_id: "repo-throttle",
                directory_name: "ws-1",
                state: "ready",
                branch: Some("main"),
                intended_target_branch: Some("main"),
            },
        );

        // First trigger should succeed
        let result1 = do_triggered_fetch("ws-throttle");
        assert!(result1.is_ok());

        // Immediate second trigger should be throttled (not error, just skipped)
        let result2 = do_triggered_fetch("ws-throttle");
        assert!(result2.is_ok());

        // Verify the throttle timestamp was set
        let key: FetchKey = ("repo-throttle".into(), "origin".into(), "main".into());
        let was_throttled = TRIGGER_LAST
            .lock()
            .ok()
            .and_then(|m| m.get(&key).map(|t| t.elapsed() < TRIGGER_THROTTLE))
            .unwrap_or(false);
        assert!(was_throttled, "throttle timestamp should be recent");
    }
}
