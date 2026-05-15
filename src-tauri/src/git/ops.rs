use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::error::{AnyhowCodedExt, ErrorCode};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitActionStatus {
    pub uncommitted_count: usize,
    pub conflict_count: usize,
    pub sync_target_branch: Option<String>,
    pub sync_status: WorkspaceSyncStatus,
    pub behind_target_count: u32,
    pub remote_tracking_ref: Option<String>,
    pub ahead_of_remote_count: u32,
    /// How many commits this branch is ahead of its **target** branch's
    /// remote-tracking ref (e.g. `origin/main`). Unlike `ahead_of_remote_count`
    /// — which reads as 0 for unpublished branches because there is no upstream
    /// — this measures user-introduced commits regardless of push state, so
    /// frontends can tell "fresh empty branch" from "has unpushed work" even
    /// before the first `git push`. 0 when the target branch ref can't be
    /// resolved.
    pub ahead_of_target_count: u32,
    pub push_status: WorkspacePushStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushBranchResult {
    pub branch: String,
    pub target_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergePreflightResult {
    pub conflicted_files: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceSyncStatus {
    UpToDate,
    Behind,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspacePushStatus {
    Published,
    Unpublished,
    Unknown,
}

/// Hard upper bound on any `git` command that touches the network. Long
/// enough to tolerate a slow connection but short enough that a stalled
/// remote (or a credential prompt that we forgot to suppress) cannot park
/// the calling blocking-pool worker indefinitely.
pub const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(30);

/// Hard upper bound on `git clone`. Cloning large repositories over a slow
/// network regularly exceeds the 30s `GIT_NETWORK_TIMEOUT`, so use a more
/// generous cap here while still preventing the blocking pool from being
/// parked indefinitely on a stalled remote.
pub const GIT_CLONE_TIMEOUT: Duration = Duration::from_secs(300);

pub fn run_git<I, S>(args: I, current_dir: Option<&Path>) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("git");

    for arg in args {
        command.arg(arg.as_ref());
    }

    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }

    let output = command.output().context("Failed to run git")?;
    handle_git_output(output)
}

/// Like `run_git`, but returns stdout **verbatim** (no trimming). Use this
/// when stdout *is* the payload — e.g. `git show <ref>:<path>` reading a
/// file's bytes — where a trailing newline is part of the file, not shell
/// noise. The standard `run_git` trims, which is right for status/rev-parse
/// lines but wrong for file content (a trimmed file content makes every
/// diff editor show a spurious "trailing newline" delta against the
/// working-tree side).
pub fn run_git_capture<I, S>(args: I, current_dir: Option<&Path>) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("git");

    for arg in args {
        command.arg(arg.as_ref());
    }

    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }

    let output = command.output().context("Failed to run git")?;
    handle_git_output_raw(output)
}

/// Run `git` with a hard wall-clock timeout and an environment that locks
/// down every interactive prompt path. Use this for any command that may
/// contact a remote (`fetch`, `pull`, `push`, `ls-remote`, …) — without it,
/// a hung remote or an unexpected credential prompt will park the calling
/// thread forever, eventually saturating Tokio's blocking pool and freezing
/// the entire app.
///
/// On timeout the child is killed via `SIGKILL` (Unix) — matching the
/// existing pattern in `sidecar.rs::send_sigterm` — and a "git command
/// timed out" error is returned to the caller.
pub fn run_git_with_timeout<I, S>(
    args: I,
    current_dir: Option<&Path>,
    timeout: Duration,
) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("git");
    for arg in args {
        command.arg(arg.as_ref());
    }
    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }

    // Lock down every interactive-prompt path:
    //
    // - `GIT_TERMINAL_PROMPT=0` makes git fail fast instead of asking for
    //   credentials on stdin.
    // - `GCM_INTERACTIVE=Never` tells the Git Credential Manager to never
    //   pop a GUI prompt.
    // - Clearing `*_ASKPASS` prevents OS-level helpers (Keychain prompts,
    //   GUI dialogs) from rescuing git either — failure here MUST surface
    //   so callers can choose to retry rather than hanging forever.
    // - `GIT_SSH_COMMAND` appends batch mode, a 10s connect timeout, and
    //   strict host-key checking to the user's existing SSH command (or
    //   plain `ssh` if unset), so a dead host or missing key fails fast
    //   without clobbering custom identity files or agent settings.
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GCM_INTERACTIVE", "Never");
    command.env_remove("GIT_ASKPASS");
    command.env_remove("SSH_ASKPASS");
    let base_ssh = std::env::var("GIT_SSH_COMMAND").unwrap_or_else(|_| "ssh".to_string());
    command.env(
        "GIT_SSH_COMMAND",
        format!("{base_ssh} -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes"),
    );
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    use std::os::unix::process::CommandExt;
    command.process_group(0);

    let child = command.spawn().context("Failed to spawn git")?;
    let child_pid = child.id();

    // The waiter thread owns `wait_with_output` and ferries the result back
    // through a oneshot channel. The main thread does `recv_timeout` so we
    // can cap the wall-clock wait without polling.
    //
    // (`wait_with_output` consumes `child`, so there's no clean way to
    // wait on the Child from one thread and kill it from another in std
    // alone — killing via `libc::kill` on the saved PID is the workaround,
    // mirroring the existing pattern in `sidecar.rs::send_sigterm`.)
    let (tx, rx) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let result = child.wait_with_output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => {
            // Waiter completed naturally; reap it so the OS thread is freed.
            let _ = waiter.join();
            handle_git_output(output)
        }
        Ok(Err(io_err)) => {
            let _ = waiter.join();
            Err(anyhow::Error::from(io_err).context("Failed to wait for git"))
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // Kill the child's entire process group so the waiter thread
            // observes the death and exits — otherwise we'd leak the OS
            // thread until git decided to give up on its own. Using the
            // negative PGID (== child PID because we set process_group(0)
            // at spawn) ensures child processes like ssh are also killed.
            //
            // SAFETY: `child_pid` == PGID (we set process_group(0) at
            // spawn). Negative PID targets the whole group. If the group
            // has already exited, `libc::kill` returns ESRCH harmlessly.
            unsafe {
                libc::kill(-(child_pid as libc::pid_t), libc::SIGKILL);
            }
            let _ = waiter.join();
            bail!(
                "git command timed out after {timeout:?} (likely a stalled remote or credential prompt)"
            )
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = waiter.join();
            bail!("git waiter thread crashed before sending result")
        }
    }
}

fn handle_git_output(output: Output) -> Result<String> {
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    handle_git_failure(output)
}

/// Same failure handling as `handle_git_output`, but on success returns
/// stdout **without** trimming. Pair with `run_git_capture` for callers
/// that need byte-faithful output (e.g. file content from `git show`).
fn handle_git_output_raw(output: Output) -> Result<String> {
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    handle_git_failure(output)
}

fn handle_git_failure(output: Output) -> Result<String> {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr.clone()
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("git exited with status {}", output.status)
    };

    let err = anyhow::anyhow!("{detail}");
    if is_broken_worktree_stderr(&stderr) {
        return Err(err.with_code(ErrorCode::WorkspaceBroken));
    }
    Err(err)
}

/// Detects git stderr patterns that indicate the worktree is orphaned or
/// unusable — directory moved, `.git/worktrees/<name>` gone, gitdir pointer
/// dangling, or the `-C` target path vanished. These errors are
/// unrecoverable without purging the DB row.
fn is_broken_worktree_stderr(stderr: &str) -> bool {
    stderr.contains("not a git repository")
        || stderr.contains("is not a working tree")
        || stderr.contains("cannot change to") // `git -C <missing>` emits this
}

#[cfg(test)]
mod broken_worktree_detection_tests {
    use super::is_broken_worktree_stderr;

    #[test]
    fn detects_orphaned_gitdir_pointer() {
        assert!(is_broken_worktree_stderr(
            "fatal: not a git repository: /Users/x/.git/worktrees/foo"
        ));
    }

    #[test]
    fn detects_missing_workdir() {
        assert!(is_broken_worktree_stderr(
            "fatal: cannot change to '/tmp/gone': No such file or directory"
        ));
    }

    #[test]
    fn ignores_unrelated_errors() {
        assert!(!is_broken_worktree_stderr(
            "error: pathspec 'foo' did not match"
        ));
        assert!(!is_broken_worktree_stderr(
            "fatal: not a valid object name HEAD~99"
        ));
    }
}

pub fn ensure_git_repository(repo_root: &Path) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    run_git(
        ["-C", repo_root.as_str(), "rev-parse", "--show-toplevel"],
        None,
    )
    .map(|_| ())
    .context("Repository source is invalid")
}

/// List all remote names in the repo.
pub fn list_remotes(repo_root: &Path) -> Result<Vec<String>> {
    let repo_root = repo_root.display().to_string();
    let output =
        run_git(["-C", repo_root.as_str(), "remote"], None).context("Failed to list remotes")?;
    let mut remotes: Vec<String> = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    remotes.sort();
    Ok(remotes)
}

/// Check whether a named remote exists in the repo.
pub fn has_remote(repo_root: &Path, remote: &str) -> Result<bool> {
    let repo_root = repo_root.display().to_string();
    let output =
        run_git(["-C", repo_root.as_str(), "remote"], None).context("Failed to list remotes")?;
    Ok(output.lines().any(|line| line.trim() == remote))
}

/// List local branches under `refs/heads/`, sorted alphabetically.
pub fn list_local_branches(repo_root: &Path) -> Result<Vec<String>> {
    let repo_root = repo_root.display().to_string();
    let output = run_git(
        [
            "-C",
            repo_root.as_str(),
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/",
        ],
        None,
    )
    .context("Failed to list local branches")?;

    let mut branches: Vec<String> = output
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    branches.sort();
    Ok(branches)
}

/// Switch the repo's HEAD to `branch`. Used by the local-mode create
/// flow when the user picks a branch different from the current HEAD.
/// Caller is expected to verify the working tree is clean first.
///
/// `git checkout <name>` uses git's DWIM: if no local branch exists but
/// a single remote-tracking ref matches, git creates a local tracking
/// branch automatically. That's enough to cover the local picker
/// selecting a remote-only branch — no extra branch around it.
pub fn checkout_branch(repo_root: &Path, branch: &str) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    run_git(["-C", repo_root.as_str(), "checkout", branch], None)
        .map(|_| ())
        .with_context(|| format!("Failed to checkout `{branch}` in {repo_root}"))
}

/// Create a new branch at HEAD and switch to it (`git checkout -b`).
/// Used by the "Create and checkout new branch" picker action.
pub fn create_and_checkout_branch(repo_root: &Path, branch: &str) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    run_git(["-C", repo_root.as_str(), "checkout", "-b", branch], None)
        .map(|_| ())
        .with_context(|| format!("Failed to create branch `{branch}` in {repo_root}"))
}

/// Snapshot the working tree + index changes (relative to HEAD) into a
/// stash commit object **without** modifying the working tree or
/// pushing the entry into the stash list. Returns `Some(sha)` when
/// there were tracked changes to capture, `None` when the tree was
/// clean. Untracked files are NOT included — caller is expected to
/// enumerate + copy them separately.
pub fn stash_create(repo_root: &Path) -> Result<Option<String>> {
    let repo_root = repo_root.display().to_string();
    let output = run_git(["-C", repo_root.as_str(), "stash", "create"], None)
        .with_context(|| format!("Failed to `git stash create` in {repo_root}"))?;
    let sha = output.trim();
    if sha.is_empty() {
        Ok(None)
    } else {
        Ok(Some(sha.to_string()))
    }
}

/// Apply a previously-captured stash commit (from `stash_create`) to
/// the target worktree's working tree. Useful for transferring
/// uncommitted changes into a fresh worktree without touching the
/// source.
pub fn stash_apply_sha(workspace_dir: &Path, stash_sha: &str) -> Result<()> {
    let workspace_dir = workspace_dir.display().to_string();
    run_git(
        ["-C", workspace_dir.as_str(), "stash", "apply", stash_sha],
        None,
    )
    .map(|_| ())
    .with_context(|| format!("Failed to apply stash {stash_sha} into {workspace_dir}"))
}

/// List untracked files in the repo (respecting `.gitignore`),
/// returning paths relative to repo root. Used by the move-local-to-
/// worktree flow to carry untracked files over.
pub fn list_untracked_files(repo_root: &Path) -> Result<Vec<String>> {
    let repo_root = repo_root.display().to_string();
    let output = run_git(
        [
            "-C",
            repo_root.as_str(),
            "ls-files",
            "--others",
            "--exclude-standard",
        ],
        None,
    )
    .context("Failed to list untracked files")?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

/// List remote-tracking branches for the given remote.
pub fn list_remote_branches(repo_root: &Path, remote: &str) -> Result<Vec<String>> {
    let repo_root = repo_root.display().to_string();
    let ref_prefix = format!("refs/remotes/{remote}/");
    let output = run_git(
        [
            "-C",
            repo_root.as_str(),
            "for-each-ref",
            "--format=%(refname:short)",
            ref_prefix.as_str(),
        ],
        None,
    )
    .context("Failed to list remote branches")?;

    let strip_prefix = format!("{remote}/");
    let head_ref = format!("{remote}/HEAD");
    let branches: Vec<String> = output
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && *line != head_ref && *line != remote)
        .map(|line| {
            line.strip_prefix(strip_prefix.as_str())
                .unwrap_or(line)
                .to_string()
        })
        .filter(|name| !name.is_empty() && name != "HEAD")
        .collect();

    let mut sorted = branches;
    sorted.sort();
    Ok(sorted)
}

/// Prune stale worktree registrations whose directories no longer exist.
fn prune_worktrees(repo_root: &str) {
    let _ = run_git(["-C", repo_root, "worktree", "prune"], None);
}

/// Create a worktree that checks out an existing branch.
pub fn create_worktree(repo_root: &Path, workspace_dir: &Path, branch: &str) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    prune_worktrees(&repo_root);
    run_git(
        [
            "-C",
            repo_root.as_str(),
            "worktree",
            "add",
            workspace_dir_arg.as_str(),
            branch,
        ],
        None,
    )
    .map(|_| ())
    .with_context(|| {
        format!(
            "Failed to create worktree at {} for branch {}",
            workspace_dir.display(),
            branch
        )
    })
}

/// Create a worktree with a branch based on a start point.
/// Uses `-B` to create or reset the branch if it already exists.
/// The upstream is explicitly unset so the branch stays local-only.
pub fn create_worktree_from_start_point(
    repo_root: &Path,
    workspace_dir: &Path,
    branch: &str,
    start_point: &str,
) -> Result<String> {
    let repo_root = repo_root.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    prune_worktrees(&repo_root);
    let output = run_git(
        [
            "-C",
            repo_root.as_str(),
            "worktree",
            "add",
            "-B",
            branch,
            workspace_dir_arg.as_str(),
            start_point,
        ],
        None,
    )
    .with_context(|| {
        format!(
            "Failed to create worktree at {} for branch {} from {}",
            workspace_dir.display(),
            branch,
            start_point
        )
    })?;

    // Git auto-sets upstream when branching from a remote-tracking ref.
    // Unset it — the branch should push to its own remote name, not the parent.
    let _ = run_git(
        [
            "-C",
            repo_root.as_str(),
            "branch",
            "--unset-upstream",
            branch,
        ],
        None,
    );

    Ok(output)
}

/// Remove worktree dir + prune. Refuses if `workspace_dir == repo_root`
/// (local-mode mis-routed here would `.trash-` and delete the user's repo).
pub fn remove_worktree(repo_root: &Path, workspace_dir: &Path) -> Result<()> {
    if paths_resolve_equal(repo_root, workspace_dir) {
        bail!(
            "Refusing to remove worktree at {} — path equals repo_root (likely a local-mode workspace mis-routed into the worktree teardown path)",
            workspace_dir.display()
        );
    }
    let repo_root_str = repo_root.display().to_string();
    if workspace_dir.exists() {
        // Rename to a sibling temp dir (instant O(1) on the same filesystem),
        // then hand the slow recursive delete to the global serial queue.
        // Serial — not per-call spawn — so N concurrent archives don't thrash
        // disk IO deleting node_modules / target in parallel.
        let trash_dir = renamed_to_trash(workspace_dir)?;
        crate::git::trash::queue().enqueue(trash_dir);
    }
    run_git(["-C", repo_root_str.as_str(), "worktree", "prune"], None)
        .map(|_| ())
        .with_context(|| format!("Failed to prune worktree for {}", workspace_dir.display()))
}

/// Same on-disk location? Falls back to lexical equality if canonicalize fails.
pub(crate) fn paths_resolve_equal(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
}

/// Rename `dir` to a `.trash-*` sibling so the caller can treat it as gone.
///
/// The suffix combines PID + nanos + a per-process counter so we never collide
/// with a leftover trash dir from an earlier archive in the same process (e.g.
/// archive → restore → archive of the same workspace before the background
/// cleanup finishes).
fn renamed_to_trash(dir: &Path) -> Result<PathBuf> {
    static TRASH_SEQ: AtomicU64 = AtomicU64::new(0);

    let parent = dir
        .parent()
        .with_context(|| format!("No parent for {}", dir.display()))?;
    let name = dir
        .file_name()
        .with_context(|| format!("No filename for {}", dir.display()))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TRASH_SEQ.fetch_add(1, Ordering::Relaxed);
    let trash_name = format!(
        ".trash-{}-{}-{}-{}",
        name.to_string_lossy(),
        std::process::id(),
        nanos,
        seq,
    );
    let trash_dir = parent.join(&trash_name);
    fs::rename(dir, &trash_dir).with_context(|| {
        format!(
            "Failed to rename {} to {}",
            dir.display(),
            trash_dir.display()
        )
    })?;
    Ok(trash_dir)
}

pub fn remove_branch(repo_root: &Path, branch: &str) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    let branch_ref = format!("refs/heads/{branch}");
    run_git(
        [
            "-C",
            repo_root.as_str(),
            "update-ref",
            "-d",
            branch_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .or_else(|error| {
        let msg = error.to_string();
        if msg.contains("cannot lock ref") || msg.contains("does not exist") {
            Ok(())
        } else {
            Err(error).with_context(|| format!("Failed to remove branch {branch}"))
        }
    })
}

/// Create a detached worktree for setup script execution.
pub fn refresh_repo_setup_root(
    repo_root: &Path,
    setup_root_dir: &Path,
    start_point: &str,
) -> Result<()> {
    if setup_root_dir.exists() {
        let _ = remove_worktree(repo_root, setup_root_dir);
        let _ = fs::remove_dir_all(setup_root_dir);
    }

    fs::create_dir_all(setup_root_dir.parent().with_context(|| {
        format!(
            "Setup root path has no parent: {}",
            setup_root_dir.display()
        )
    })?)
    .with_context(|| {
        format!(
            "Failed to create setup root parent for {}",
            setup_root_dir.display()
        )
    })?;

    let repo_root = repo_root.display().to_string();
    let setup_root_dir_arg = setup_root_dir.display().to_string();
    run_git(
        [
            "-C",
            repo_root.as_str(),
            "worktree",
            "add",
            "--detach",
            setup_root_dir_arg.as_str(),
            start_point,
        ],
        None,
    )
    .map(|_| ())
    .with_context(|| {
        format!(
            "Failed to materialize setup root at {} from {}",
            setup_root_dir.display(),
            start_point
        )
    })
}

/// Verify a local branch exists in the repo.
pub fn verify_branch_exists(repo_root: &Path, branch: &str) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    let branch_ref = format!("refs/heads/{branch}");
    run_git(
        [
            "-C",
            repo_root.as_str(),
            "rev-parse",
            "--verify",
            branch_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .with_context(|| format!("Branch does not exist: {branch}"))
}

/// Verify a commit exists in the repo.
pub fn verify_commit_exists(repo_root: &Path, commit: &str) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    let commit_ref = format!("{commit}^{{commit}}");
    run_git(
        [
            "-C",
            repo_root.as_str(),
            "rev-parse",
            "--verify",
            commit_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .with_context(|| format!("Commit not found: {commit}"))
}

/// Verify an arbitrary ref/commitish exists in the repo.
pub fn verify_commitish_exists(
    repo_root: &Path,
    commitish: &str,
    error_message: &str,
) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    let verify_ref = format!("{commitish}^{{commit}}");
    run_git(
        [
            "-C",
            repo_root.as_str(),
            "rev-parse",
            "--verify",
            verify_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .context(error_message.to_string())
}

/// Rename a local branch: `git branch -m <old> <new>`.
pub fn rename_branch(repo_root: &Path, old_name: &str, new_name: &str) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    run_git(
        ["-C", repo_root.as_str(), "branch", "-m", old_name, new_name],
        None,
    )
    .map(|_| ())
    .with_context(|| format!("Failed to rename branch {old_name} → {new_name}"))
}

/// Point a branch ref at a specific commit.
pub fn point_branch_to_commit(repo_root: &Path, branch: &str, commit: &str) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    let branch_ref = format!("refs/heads/{branch}");
    run_git(
        [
            "-C",
            repo_root.as_str(),
            "update-ref",
            branch_ref.as_str(),
            commit,
        ],
        None,
    )
    .map(|_| ())
    .with_context(|| format!("Failed to point branch {branch} at {commit}"))
}

pub fn current_workspace_head_commit(workspace_dir: &Path) -> Result<String> {
    let workspace_dir = workspace_dir.display().to_string();
    let commit =
        run_git(["-C", workspace_dir.as_str(), "rev-parse", "HEAD"], None).with_context(|| {
            format!(
                "Failed to resolve archive commit from workspace {}",
                workspace_dir
            )
        })?;

    if commit.trim().is_empty() {
        bail!(
            "Resolved empty archive commit for workspace {}",
            workspace_dir
        );
    }

    Ok(commit)
}

pub fn current_branch_name(workspace_dir: &Path) -> Result<String> {
    let workspace_dir = workspace_dir.display().to_string();
    let branch = run_git(
        ["-C", workspace_dir.as_str(), "branch", "--show-current"],
        None,
    )
    .with_context(|| format!("Failed to resolve current branch for {}", workspace_dir))?;

    let branch = branch.trim();
    if branch.is_empty() {
        bail!("Workspace {} is not on a branch", workspace_dir);
    }

    Ok(branch.to_string())
}

pub fn current_upstream_ref_name(workspace_dir: &Path) -> Option<String> {
    current_upstream_ref(workspace_dir)
}

fn upstream_push_ref(upstream_ref: &str) -> Option<String> {
    let branch = if let Some(branch) = upstream_ref.strip_prefix("refs/remotes/") {
        let (_, branch) = branch.split_once('/')?;
        branch
    } else {
        let (_, branch) = upstream_ref.split_once('/')?;
        branch
    };
    Some(format!("HEAD:refs/heads/{branch}"))
}

pub fn default_branch_ref(remote: &str, default_branch: &str) -> String {
    format!("refs/remotes/{remote}/{default_branch}")
}

pub fn tracked_file_count(workspace_dir: &Path) -> Result<i64> {
    let workspace_dir = workspace_dir.display().to_string();
    let output = run_git(["-C", workspace_dir.as_str(), "ls-files"], None).with_context(|| {
        format!(
            "Failed to count tracked files for workspace {}",
            workspace_dir
        )
    })?;

    Ok(output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count() as i64)
}

/// Returns true if the workspace's working tree has no uncommitted changes
/// (no staged, unstaged, or untracked files).
pub fn working_tree_clean(workspace_dir: &Path) -> Result<bool> {
    let workspace_dir = workspace_dir.display().to_string();
    let output = run_git(
        [
            "-C",
            workspace_dir.as_str(),
            "status",
            "--porcelain",
            "--untracked-files=normal",
        ],
        None,
    )
    .with_context(|| format!("Failed to read working tree status for {}", workspace_dir))?;

    Ok(output.trim().is_empty())
}

/// True when no staged/unstaged tracked changes (untracked ignored).
/// Right pre-check for `git checkout`, which only refuses on conflict.
pub fn tracked_changes_clean(workspace_dir: &Path) -> Result<bool> {
    let workspace_dir = workspace_dir.display().to_string();
    let output = run_git(
        [
            "-C",
            workspace_dir.as_str(),
            "status",
            "--porcelain",
            "--untracked-files=no",
        ],
        None,
    )
    .with_context(|| {
        format!(
            "Failed to read tracked working tree status for {}",
            workspace_dir
        )
    })?;

    Ok(output.trim().is_empty())
}

/// Compact status for the inspector Actions panel.
///
/// This is intentionally local-only: it never fetches or contacts a remote, so
/// the Actions panel can poll it frequently without hanging on credentials or
/// network.
pub fn workspace_action_status(
    workspace_dir: &Path,
    remote: Option<&str>,
    target_branch: Option<&str>,
) -> Result<WorkspaceGitActionStatus> {
    let workspace_dir_arg = workspace_dir.display().to_string();
    let status_output = run_git(
        [
            "-C",
            workspace_dir_arg.as_str(),
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
        ],
        None,
    )
    .with_context(|| {
        format!(
            "Failed to read workspace git status for {}",
            workspace_dir.display()
        )
    })?;

    let uncommitted_count = parse_porcelain_status_paths(&status_output).len();

    let conflict_output =
        run_git(["-C", workspace_dir_arg.as_str(), "ls-files", "-u"], None).unwrap_or_default();
    let conflict_count = parse_unmerged_paths(&conflict_output).len();
    let sync_target_branch = target_branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let (sync_status, behind_target_count) =
        workspace_sync_status(workspace_dir, remote, sync_target_branch.as_deref());
    let ahead_of_target_count =
        commits_ahead_of_target(workspace_dir, remote, sync_target_branch.as_deref());
    let remote_tracking_ref = resolve_remote_tracking_ref(workspace_dir, remote);
    let ahead_of_remote_count = remote_tracking_ref
        .as_deref()
        .and_then(|upstream| commits_ahead_of(workspace_dir, upstream).ok())
        .unwrap_or(0);
    let push_status = resolve_push_status(workspace_dir, remote, remote_tracking_ref.as_deref());

    Ok(WorkspaceGitActionStatus {
        uncommitted_count,
        conflict_count,
        sync_target_branch,
        sync_status,
        behind_target_count,
        remote_tracking_ref,
        ahead_of_remote_count,
        ahead_of_target_count,
        push_status,
    })
}

/// Count commits this workspace's HEAD has on top of the *target* branch's
/// remote-tracking ref. Unlike `ahead_of_remote_count` (which compares to
/// `current_upstream_ref` and is 0 for unpublished branches), this works even
/// before the first push — useful for "does the user have anything to review"
/// signals.
fn commits_ahead_of_target(
    workspace_dir: &Path,
    remote: Option<&str>,
    target_branch: Option<&str>,
) -> u32 {
    let Some(remote) = remote.map(str::trim).filter(|value| !value.is_empty()) else {
        return 0;
    };
    let Some(target_branch) = target_branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return 0;
    };
    if !verify_remote_ref_exists(workspace_dir, remote, target_branch).unwrap_or(false) {
        return 0;
    }
    let target_ref = format!("refs/remotes/{remote}/{target_branch}");
    commits_ahead_of(workspace_dir, &target_ref).unwrap_or(0)
}

fn workspace_sync_status(
    workspace_dir: &Path,
    remote: Option<&str>,
    target_branch: Option<&str>,
) -> (WorkspaceSyncStatus, u32) {
    let Some(remote) = remote.map(str::trim).filter(|value| !value.is_empty()) else {
        return (WorkspaceSyncStatus::Unknown, 0);
    };
    let Some(target_branch) = target_branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return (WorkspaceSyncStatus::Unknown, 0);
    };

    let target_ref = format!("refs/remotes/{remote}/{target_branch}");
    let exists = verify_remote_ref_exists(workspace_dir, remote, target_branch).unwrap_or(false);
    if !exists {
        return (WorkspaceSyncStatus::Unknown, 0);
    }

    match commits_behind(workspace_dir, &target_ref) {
        Ok(count) if count > 0 => (WorkspaceSyncStatus::Behind, count),
        Ok(_) => (WorkspaceSyncStatus::UpToDate, 0),
        Err(_) => (WorkspaceSyncStatus::Unknown, 0),
    }
}

fn current_upstream_ref(workspace_dir: &Path) -> Option<String> {
    let workspace_dir_arg = workspace_dir.display().to_string();
    run_git(
        [
            "-C",
            workspace_dir_arg.as_str(),
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        None,
    )
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

/// Returns the workspace branch's effective remote-tracking ref, if any.
/// Tries upstream config first, then falls back to a literal
/// `refs/remotes/<remote>/<branch>` lookup so manually-pushed branches
/// (without `-u`) are still recognised. `None` means the local branch has
/// no corresponding remote ref Helmor can see — treat as "branch was
/// never published".
pub fn resolve_remote_tracking_ref(workspace_dir: &Path, remote: Option<&str>) -> Option<String> {
    if let Some(upstream) = current_upstream_ref(workspace_dir) {
        return Some(upstream);
    }

    let remote = remote.map(str::trim).filter(|value| !value.is_empty())?;
    let branch = current_branch_name(workspace_dir).ok()?;
    verify_remote_ref_exists(workspace_dir, remote, &branch)
        .ok()
        .filter(|exists| *exists)
        .map(|_| format!("{remote}/{branch}"))
}

fn resolve_push_status(
    workspace_dir: &Path,
    remote: Option<&str>,
    remote_tracking_ref: Option<&str>,
) -> WorkspacePushStatus {
    if remote_tracking_ref.is_some() {
        return WorkspacePushStatus::Published;
    }

    let Some(_remote) = remote.map(str::trim).filter(|value| !value.is_empty()) else {
        return WorkspacePushStatus::Unknown;
    };
    if current_branch_name(workspace_dir).is_err() {
        return WorkspacePushStatus::Unknown;
    }

    WorkspacePushStatus::Unpublished
}

pub fn push_current_branch(workspace_dir: &Path, remote: &str) -> Result<PushBranchResult> {
    let branch = current_branch_name(workspace_dir)?;
    let workspace_dir = workspace_dir.display().to_string();
    let upstream = current_upstream_ref(Path::new(&workspace_dir));

    if let Some(target_ref) = upstream {
        let push_ref = upstream_push_ref(&target_ref)
            .with_context(|| format!("Unsupported upstream ref for push: {target_ref}"))?;
        return run_git_with_timeout(
            [
                "-C",
                workspace_dir.as_str(),
                "push",
                remote,
                push_ref.as_str(),
            ],
            None,
            GIT_NETWORK_TIMEOUT,
        )
        .map(|_| PushBranchResult {
            branch: branch.clone(),
            target_ref,
        })
        .with_context(|| format!("Failed to push branch {branch} to its upstream"));
    }

    let push_ref = format!("HEAD:refs/heads/{branch}");
    run_git_with_timeout(
        [
            "-C",
            workspace_dir.as_str(),
            "push",
            "--set-upstream",
            remote,
            push_ref.as_str(),
        ],
        None,
        GIT_NETWORK_TIMEOUT,
    )
    .map(|_| PushBranchResult {
        branch: branch.clone(),
        target_ref: format!("{remote}/{branch}"),
    })
    .with_context(|| format!("Failed to push branch {branch} to {remote}"))
}

/// Counts how many commits are reachable from HEAD but not from `base_ref`.
/// Returns 0 if HEAD is fully contained in `base_ref` (i.e. no user commits
/// beyond the baseline).
pub fn commits_ahead_of(workspace_dir: &Path, base_ref: &str) -> Result<u32> {
    let workspace_dir = workspace_dir.display().to_string();
    let range = format!("{base_ref}..HEAD");
    let output = run_git(
        [
            "-C",
            workspace_dir.as_str(),
            "rev-list",
            "--count",
            range.as_str(),
        ],
        None,
    )
    .with_context(|| {
        format!(
            "Failed to count commits ahead of {} in {}",
            base_ref, workspace_dir
        )
    })?;

    output
        .trim()
        .parse::<u32>()
        .with_context(|| format!("Unexpected rev-list count output: {}", output))
}

/// Counts how many commits are reachable from `base_ref` but not from HEAD.
/// Returns 0 if HEAD already contains everything in `base_ref`.
pub fn commits_behind(workspace_dir: &Path, base_ref: &str) -> Result<u32> {
    let workspace_dir = workspace_dir.display().to_string();
    let range = format!("HEAD..{base_ref}");
    let output = run_git(
        [
            "-C",
            workspace_dir.as_str(),
            "rev-list",
            "--count",
            range.as_str(),
        ],
        None,
    )
    .with_context(|| {
        format!(
            "Failed to count commits behind {} in {}",
            base_ref, workspace_dir
        )
    })?;

    output
        .trim()
        .parse::<u32>()
        .with_context(|| format!("Unexpected rev-list count output: {}", output))
}

fn parse_porcelain_status_paths(output: &str) -> std::collections::BTreeSet<String> {
    output
        .lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let path = line[3..].trim();
            if path.is_empty() {
                return None;
            }
            Some(path.to_string())
        })
        .collect()
}

fn parse_unmerged_paths(output: &str) -> std::collections::BTreeSet<String> {
    output
        .lines()
        .filter_map(|line| {
            let (_, path) = line.split_once('\t')?;
            let path = path.trim();
            if path.is_empty() {
                return None;
            }
            Some(path.to_string())
        })
        .collect()
}

/// Fetch a specific branch from `origin` into the workspace's repo.
///
/// Bounded by `GIT_NETWORK_TIMEOUT` and runs in a no-prompt environment so
/// a stalled remote or credential prompt cannot park the calling thread.
pub fn fetch_remote_branch(workspace_dir: &Path, remote: &str, branch: &str) -> Result<()> {
    let workspace_dir = workspace_dir.display().to_string();
    run_git_with_timeout(
        ["-C", workspace_dir.as_str(), "fetch", remote, branch],
        None,
        GIT_NETWORK_TIMEOUT,
    )
    .map(|_| ())
    .with_context(|| format!("Failed to fetch {remote}/{branch} into {workspace_dir}"))
}

/// Fetch all branches from the given remote, pruning deleted remote refs.
pub fn fetch_all_remote(workspace_dir: &Path, remote: &str) -> Result<()> {
    let workspace_dir = workspace_dir.display().to_string();
    run_git_with_timeout(
        ["-C", workspace_dir.as_str(), "fetch", "--prune", remote],
        None,
        GIT_NETWORK_TIMEOUT,
    )
    .map(|_| ())
    .with_context(|| format!("Failed to fetch all from {remote} in {workspace_dir}"))
}

/// Returns true if `refs/remotes/<remote>/<branch>` exists locally (no network).
pub fn verify_remote_ref_exists(workspace_dir: &Path, remote: &str, branch: &str) -> Result<bool> {
    let workspace_dir = workspace_dir.display().to_string();
    let ref_name = format!("refs/remotes/{remote}/{branch}");
    match run_git(
        [
            "-C",
            workspace_dir.as_str(),
            "rev-parse",
            "--verify",
            "--quiet",
            ref_name.as_str(),
        ],
        None,
    ) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Resolve `refs/remotes/<remote>/<branch>` to its current commit SHA.
pub fn remote_ref_sha(workspace_dir: &Path, remote: &str, branch: &str) -> Result<String> {
    let workspace_dir = workspace_dir.display().to_string();
    let ref_name = format!("refs/remotes/{remote}/{branch}");
    let sha = run_git(
        ["-C", workspace_dir.as_str(), "rev-parse", ref_name.as_str()],
        None,
    )
    .with_context(|| format!("Failed to resolve {} in {}", ref_name, workspace_dir))?;
    if sha.trim().is_empty() {
        bail!("Empty SHA for {} in {}", ref_name, workspace_dir);
    }
    Ok(sha.trim().to_string())
}

pub fn merge_ref_no_edit(workspace_dir: &Path, target_ref: &str) -> Result<()> {
    let workspace_dir = workspace_dir.display().to_string();
    run_git(
        [
            "-C",
            workspace_dir.as_str(),
            "merge",
            "--no-edit",
            target_ref,
        ],
        None,
    )
    .map(|_| ())
    .with_context(|| format!("Failed to merge {target_ref} into {workspace_dir}"))
}

pub fn abort_merge(workspace_dir: &Path) -> Result<()> {
    let workspace_dir = workspace_dir.display().to_string();
    run_git(["-C", workspace_dir.as_str(), "merge", "--abort"], None)
        .map(|_| ())
        .with_context(|| format!("Failed to abort merge in {workspace_dir}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StashPopOutcome {
    Clean,
    Conflict,
}

/// Push a stash entry that captures both tracked changes and untracked files.
/// Returns `true` when a new stash entry was created, `false` if there was
/// nothing to save.
pub fn stash_push_include_untracked(workspace_dir: &Path, message: &str) -> Result<bool> {
    let workspace_dir_arg = workspace_dir.display().to_string();
    let output = run_git(
        [
            "-C",
            workspace_dir_arg.as_str(),
            "stash",
            "push",
            "--include-untracked",
            "-m",
            message,
        ],
        None,
    )
    .with_context(|| format!("Failed to git stash push in {}", workspace_dir.display()))?;
    Ok(!output.contains("No local changes to save"))
}

/// Pop the most recent stash entry. Conflicts during pop leave the stash
/// entry intact (git's default), so the caller / agent can retry.
pub fn stash_pop(workspace_dir: &Path) -> Result<StashPopOutcome> {
    let workspace_dir_arg = workspace_dir.display().to_string();
    let output = Command::new("git")
        .args(["-C", workspace_dir_arg.as_str(), "stash", "pop"])
        .output()
        .with_context(|| format!("Failed to git stash pop in {}", workspace_dir.display()))?;
    if output.status.success() {
        return Ok(StashPopOutcome::Clean);
    }
    let unmerged =
        run_git(["-C", workspace_dir_arg.as_str(), "ls-files", "-u"], None).unwrap_or_default();
    if unmerged.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "git stash pop failed in {}: {}",
            workspace_dir.display(),
            stderr.trim()
        );
    }
    Ok(StashPopOutcome::Conflict)
}

pub fn preflight_merge_ref(workspace_dir: &Path, target_ref: &str) -> Result<MergePreflightResult> {
    let head_sha = current_workspace_head_commit(workspace_dir)?;
    let preflight_dir =
        std::env::temp_dir().join(format!("helmor-merge-preflight-{}", uuid::Uuid::new_v4()));
    refresh_repo_setup_root(workspace_dir, &preflight_dir, &head_sha)?;

    let merge_result = run_git(
        [
            "-C",
            preflight_dir.to_string_lossy().as_ref(),
            "merge",
            "--no-commit",
            "--no-ff",
            target_ref,
        ],
        None,
    );

    let outcome = match merge_result {
        Ok(_) => Ok(MergePreflightResult {
            conflicted_files: Vec::new(),
        }),
        Err(error) => {
            let conflict_output = run_git(
                [
                    "-C",
                    preflight_dir.to_string_lossy().as_ref(),
                    "ls-files",
                    "-u",
                ],
                None,
            )
            .unwrap_or_default();
            let conflicted_files = parse_unmerged_paths(&conflict_output)
                .into_iter()
                .collect::<Vec<_>>();
            if conflicted_files.is_empty() {
                Err(error).with_context(|| {
                    format!(
                        "Failed to preflight-merge {target_ref} into {}",
                        workspace_dir.display()
                    )
                })
            } else {
                Ok(MergePreflightResult { conflicted_files })
            }
        }
    };

    let _ = abort_merge(&preflight_dir);
    if let Err(error) = remove_worktree(workspace_dir, &preflight_dir) {
        tracing::warn!(
            path = %preflight_dir.display(),
            "Failed to clean up merge preflight worktree: {error:#}"
        );
    }

    outcome
}

/// Hard-reset the currently checked-out branch in the workspace to `target_ref`.
/// Caller is responsible for ensuring this is safe (clean tree, no user commits).
pub fn reset_current_branch_hard(workspace_dir: &Path, target_ref: &str) -> Result<()> {
    let workspace_dir = workspace_dir.display().to_string();
    run_git(
        ["-C", workspace_dir.as_str(), "reset", "--hard", target_ref],
        None,
    )
    .map(|_| ())
    .with_context(|| {
        format!(
            "Failed to reset workspace {} to {}",
            workspace_dir, target_ref
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(repo: &Path, args: &[&str]) {
        run_git(args, Some(repo)).unwrap_or_else(|error| {
            panic!("git {:?} failed in {}: {error:#}", args, repo.display())
        });
    }

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init"]);
        run(dir.path(), &["checkout", "-b", "main"]);
        run(dir.path(), &["config", "user.email", "helmor@example.com"]);
        run(dir.path(), &["config", "user.name", "Helmor Test"]);
        run(dir.path(), &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.path().join("file.txt"), "base\n").unwrap();
        run(dir.path(), &["add", "file.txt"]);
        run(dir.path(), &["commit", "-m", "initial"]);
        dir
    }

    #[test]
    fn workspace_action_status_reports_clean_repo() {
        let dir = init_repo();

        let status = workspace_action_status(dir.path(), None, None).unwrap();

        assert_eq!(status.uncommitted_count, 0);
        assert_eq!(status.conflict_count, 0);
        assert_eq!(status.sync_status, WorkspaceSyncStatus::Unknown);
        assert_eq!(status.behind_target_count, 0);
        assert_eq!(status.remote_tracking_ref, None);
        assert_eq!(status.ahead_of_remote_count, 0);
        assert_eq!(status.push_status, WorkspacePushStatus::Unknown);
    }

    #[test]
    fn workspace_action_status_counts_dirty_and_untracked_files() {
        let dir = init_repo();
        std::fs::write(dir.path().join("file.txt"), "changed\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "new\n").unwrap();

        let status = workspace_action_status(dir.path(), None, None).unwrap();

        assert_eq!(status.uncommitted_count, 2);
        assert_eq!(status.conflict_count, 0);
    }

    #[test]
    fn workspace_action_status_counts_merge_conflicts() {
        let dir = init_repo();
        run(dir.path(), &["checkout", "-b", "feature"]);
        std::fs::write(dir.path().join("file.txt"), "feature\n").unwrap();
        run(dir.path(), &["commit", "-am", "feature"]);
        run(dir.path(), &["checkout", "main"]);
        std::fs::write(dir.path().join("file.txt"), "main\n").unwrap();
        run(dir.path(), &["commit", "-am", "main"]);
        run(dir.path(), &["checkout", "feature"]);

        let merge_result = run_git(["merge", "main"], Some(dir.path()));
        assert!(merge_result.is_err(), "merge should conflict");

        let status = workspace_action_status(dir.path(), None, None).unwrap();

        assert_eq!(status.conflict_count, 1);
        assert!(status.uncommitted_count >= 1);
    }

    #[test]
    fn workspace_action_status_reports_behind_target_branch() {
        let (origin, clone) = init_repo_with_remote();
        run(origin.path(), &["checkout", "main"]);
        std::fs::write(origin.path().join("remote.txt"), "fresh\n").unwrap();
        run(origin.path(), &["add", "remote.txt"]);
        run(origin.path(), &["commit", "-m", "advance main"]);
        fetch_remote_branch(clone.path(), "origin", "main").unwrap();

        let status = workspace_action_status(clone.path(), Some("origin"), Some("main")).unwrap();

        assert_eq!(status.sync_target_branch.as_deref(), Some("main"));
        assert_eq!(status.sync_status, WorkspaceSyncStatus::Behind);
        assert_eq!(status.behind_target_count, 1);
        assert_eq!(status.remote_tracking_ref.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead_of_remote_count, 0);
        assert_eq!(status.push_status, WorkspacePushStatus::Published);
    }

    #[test]
    fn workspace_action_status_reports_up_to_date_target_branch() {
        let (_origin, clone) = init_repo_with_remote();

        let status = workspace_action_status(clone.path(), Some("origin"), Some("main")).unwrap();

        assert_eq!(status.sync_target_branch.as_deref(), Some("main"));
        assert_eq!(status.sync_status, WorkspaceSyncStatus::UpToDate);
        assert_eq!(status.behind_target_count, 0);
        assert_eq!(status.remote_tracking_ref.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead_of_remote_count, 0);
        assert_eq!(status.push_status, WorkspacePushStatus::Published);
    }

    #[test]
    fn workspace_action_status_reports_commits_ahead_of_remote() {
        let (_origin, clone) = init_repo_with_remote();
        std::fs::write(clone.path().join("local.txt"), "local\n").unwrap();
        run(clone.path(), &["add", "local.txt"]);
        run(clone.path(), &["commit", "-m", "local commit"]);

        let status = workspace_action_status(clone.path(), Some("origin"), Some("main")).unwrap();

        assert_eq!(status.remote_tracking_ref.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead_of_remote_count, 1);
        assert_eq!(status.push_status, WorkspacePushStatus::Published);
    }

    #[test]
    fn workspace_action_status_reports_unpublished_branch_without_upstream() {
        let (_origin, clone) = init_repo_with_remote();
        run(clone.path(), &["checkout", "-b", "feature/unpublished"]);

        let status = workspace_action_status(clone.path(), Some("origin"), Some("main")).unwrap();

        assert_eq!(status.remote_tracking_ref, None);
        assert_eq!(status.ahead_of_remote_count, 0);
        // Fresh branch identical to origin/main — nothing to review yet.
        assert_eq!(status.ahead_of_target_count, 0);
        assert_eq!(status.push_status, WorkspacePushStatus::Unpublished);
    }

    #[test]
    fn workspace_action_status_reports_ahead_of_target_for_unpublished_branch_with_commits() {
        // Branch is unpublished (no upstream) but has local commits past
        // origin/main. `ahead_of_remote_count` is 0 here (no upstream),
        // but `ahead_of_target_count` must surface the unpushed work.
        let (_origin, clone) = init_repo_with_remote();
        run(clone.path(), &["checkout", "-b", "feature/local-only"]);
        std::fs::write(clone.path().join("local.txt"), "local\n").unwrap();
        run(clone.path(), &["add", "local.txt"]);
        run(clone.path(), &["commit", "-m", "local-only commit"]);

        let status = workspace_action_status(clone.path(), Some("origin"), Some("main")).unwrap();

        assert_eq!(status.push_status, WorkspacePushStatus::Unpublished);
        assert_eq!(status.ahead_of_remote_count, 0);
        assert_eq!(status.ahead_of_target_count, 1);
    }

    #[test]
    fn workspace_action_status_reports_ahead_of_target_for_published_branch() {
        // Sanity: `ahead_of_target_count` works when the branch HAS an
        // upstream too (shouldn't depend on `pushStatus`).
        let (_origin, clone) = init_repo_with_remote();
        std::fs::write(clone.path().join("pushed.txt"), "pushed\n").unwrap();
        run(clone.path(), &["add", "pushed.txt"]);
        run(clone.path(), &["commit", "-m", "pushed commit"]);

        let status = workspace_action_status(clone.path(), Some("origin"), Some("main")).unwrap();

        assert_eq!(status.ahead_of_target_count, 1);
    }

    #[test]
    fn push_current_branch_sets_upstream_when_missing() {
        let (_origin, clone) = init_repo_with_remote();
        run(clone.path(), &["checkout", "-b", "feature/push-same-name"]);

        let result = push_current_branch(clone.path(), "origin").unwrap();

        assert_eq!(result.branch, "feature/push-same-name");
        assert_eq!(result.target_ref, "origin/feature/push-same-name");
        assert!(has_upstream(clone.path(), "feature/push-same-name"));
        assert!(verify_remote_ref_exists(clone.path(), "origin", &result.branch).unwrap());
    }

    #[test]
    fn push_current_branch_preserves_existing_differently_named_upstream() {
        let (_origin, clone) = init_repo_with_remote();
        run(clone.path(), &["checkout", "-b", "feature/local-name"]);
        run(
            clone.path(),
            &[
                "push",
                "--set-upstream",
                "origin",
                "HEAD:refs/heads/feature/remote-name",
            ],
        );
        std::fs::write(clone.path().join("follow-up.txt"), "next\n").unwrap();
        run(clone.path(), &["add", "follow-up.txt"]);
        run(clone.path(), &["commit", "-m", "follow up"]);

        let result = push_current_branch(clone.path(), "origin").unwrap();

        assert_eq!(result.branch, "feature/local-name");
        assert_eq!(result.target_ref, "origin/feature/remote-name");
        assert_eq!(
            current_upstream_ref(clone.path()).as_deref(),
            Some("origin/feature/remote-name")
        );
        assert_eq!(
            remote_ref_sha(clone.path(), "origin", "feature/remote-name").unwrap(),
            current_workspace_head_commit(clone.path()).unwrap()
        );
        assert!(!verify_remote_ref_exists(clone.path(), "origin", "feature/local-name").unwrap());
    }

    /// Clone a repo so we have a real `origin` remote with tracking refs.
    fn init_repo_with_remote() -> (tempfile::TempDir, tempfile::TempDir) {
        let origin = init_repo();
        let clone_dir = tempfile::tempdir().unwrap();
        run_git(
            [
                "clone",
                &origin.path().display().to_string(),
                &clone_dir.path().display().to_string(),
            ],
            None,
        )
        .unwrap();
        // Configure user in clone
        run(
            clone_dir.path(),
            &["config", "user.email", "helmor@example.com"],
        );
        run(clone_dir.path(), &["config", "user.name", "Helmor Test"]);
        run(clone_dir.path(), &["config", "commit.gpgsign", "false"]);
        (origin, clone_dir)
    }

    fn has_upstream(repo: &Path, branch: &str) -> bool {
        run_git(
            [
                "-C",
                &repo.display().to_string(),
                "config",
                "--get",
                &format!("branch.{branch}.remote"),
            ],
            None,
        )
        .is_ok()
    }

    #[test]
    fn create_worktree_from_start_point_unsets_upstream() {
        let (_origin, clone) = init_repo_with_remote();
        let wt_dir = tempfile::tempdir().unwrap();

        create_worktree_from_start_point(
            clone.path(),
            wt_dir.path(),
            "workspace/test",
            "origin/main",
        )
        .unwrap();

        assert!(
            !has_upstream(clone.path(), "workspace/test"),
            "workspace branch should have no upstream after creation"
        );
    }

    #[test]
    fn resolve_remote_tracking_ref_is_none_for_freshly_created_workspace() {
        // After `create_worktree_from_start_point` unsets upstream, no
        // remote-tracking ref should be reported even though the branch
        // shares a name with `origin/main`'s history.
        let (_origin, clone) = init_repo_with_remote();
        let wt_dir = tempfile::tempdir().unwrap();
        create_worktree_from_start_point(
            clone.path(),
            wt_dir.path(),
            "dohooo/whirlpool",
            "origin/main",
        )
        .unwrap();

        assert_eq!(
            resolve_remote_tracking_ref(wt_dir.path(), Some("origin")),
            None,
        );
    }

    #[test]
    fn resolve_remote_tracking_ref_returns_upstream_after_push() {
        let (_origin, clone) = init_repo_with_remote();
        let wt_dir = tempfile::tempdir().unwrap();
        create_worktree_from_start_point(
            clone.path(),
            wt_dir.path(),
            "feature/published",
            "origin/main",
        )
        .unwrap();

        push_current_branch(wt_dir.path(), "origin").unwrap();

        assert_eq!(
            resolve_remote_tracking_ref(wt_dir.path(), Some("origin")).as_deref(),
            Some("origin/feature/published"),
        );
    }

    #[test]
    fn resolve_remote_tracking_ref_recovers_via_remote_ref_when_upstream_unset() {
        // Manual `git push origin <branch>` (no `-u`) leaves upstream unset
        // but populates `refs/remotes/origin/<branch>`. The fallback path
        // should still recognise the branch as published.
        let (_origin, clone) = init_repo_with_remote();
        let wt_dir = tempfile::tempdir().unwrap();
        create_worktree_from_start_point(
            clone.path(),
            wt_dir.path(),
            "feature/manual-push",
            "origin/main",
        )
        .unwrap();
        run(
            wt_dir.path(),
            &["push", "origin", "HEAD:refs/heads/feature/manual-push"],
        );

        assert!(!has_upstream(wt_dir.path(), "feature/manual-push"));
        assert_eq!(
            resolve_remote_tracking_ref(wt_dir.path(), Some("origin")).as_deref(),
            Some("origin/feature/manual-push"),
        );
    }

    #[test]
    fn parse_porcelain_status_paths_skips_short_lines_and_empty_paths() {
        // Note: every line must keep its leading 3 chars of porcelain prefix
        // (XY + space). A 3-char line like "XX " has no path → must be skipped.
        let raw = " M file_one.txt\n?? new.rs\nXX\n\n   \nA  second.toml\n";
        let parsed = parse_porcelain_status_paths(raw);
        let collected: Vec<&str> = parsed.iter().map(String::as_str).collect();
        assert!(collected.contains(&"file_one.txt"));
        assert!(collected.contains(&"new.rs"));
        assert!(collected.contains(&"second.toml"));
        // BTreeSet dedupes — no duplicates allowed.
        assert_eq!(collected.len(), 3);
    }

    #[test]
    fn parse_porcelain_status_paths_returns_empty_for_blank_input() {
        assert!(parse_porcelain_status_paths("").is_empty());
        assert!(parse_porcelain_status_paths("\n\n\n").is_empty());
    }

    #[test]
    fn parse_porcelain_status_paths_dedupes_repeated_paths() {
        let raw = " M file.txt\nMM file.txt\n";
        let parsed = parse_porcelain_status_paths(raw);
        assert_eq!(parsed.len(), 1);
        assert!(parsed.contains("file.txt"));
    }

    #[test]
    fn parse_unmerged_paths_extracts_path_after_tab() {
        let raw = "100644 abc 1\tconflict.txt\n100644 def 2\tnested/foo.toml\n";
        let parsed = parse_unmerged_paths(raw);
        assert_eq!(parsed.len(), 2);
        assert!(parsed.contains("conflict.txt"));
        assert!(parsed.contains("nested/foo.toml"));
    }

    #[test]
    fn parse_unmerged_paths_skips_lines_without_tab() {
        let raw = "no-tab here\n100644 abc 1\tvalid.txt\nempty\t\n";
        let parsed = parse_unmerged_paths(raw);
        assert_eq!(parsed.len(), 1);
        assert!(parsed.contains("valid.txt"));
    }
}
