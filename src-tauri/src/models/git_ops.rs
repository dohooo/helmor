use anyhow::{bail, Context, Result};
use std::{
    ffi::OsStr,
    fs,
    path::Path,
    process::{Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

/// Hard upper bound on any `git` command that touches the network. Long
/// enough to tolerate a slow connection but short enough that a stalled
/// remote (or a credential prompt that we forgot to suppress) cannot park
/// the calling blocking-pool worker indefinitely.
pub const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(30);

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
    // - `GIT_SSH_COMMAND` forces ssh into batch mode with a 10s connect
    //   timeout, so a dead host or missing key fails fast instead of
    //   parking on the TCP handshake.
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GCM_INTERACTIVE", "Never");
    command.env_remove("GIT_ASKPASS");
    command.env_remove("SSH_ASKPASS");
    command.env(
        "GIT_SSH_COMMAND",
        "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new",
    );
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

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
            // Kill the child so the waiter thread observes the death and
            // exits — otherwise we'd leak the OS thread until git decided
            // to give up on its own. There is a small PID-reuse race here
            // (the child may have exited just before we send the signal),
            // but this matches `sidecar.rs::send_sigterm` and is the best
            // option without pulling in a helper crate.
            #[cfg(unix)]
            // SAFETY: `child_pid` is the PID of the child we spawned. Even
            // if the kernel has already reaped the process, `libc::kill`
            // returns ESRCH harmlessly — it cannot corrupt our address
            // space.
            unsafe {
                libc::kill(child_pid as libc::pid_t, libc::SIGKILL);
            }
            #[cfg(not(unix))]
            {
                // No portable PID-only kill on Windows. The waiter will
                // exit eventually when the child does — accept the leak
                // for now (Helmor's primary target is macOS).
                let _ = child_pid;
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

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("git exited with status {}", output.status)
    };

    bail!("{detail}")
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

/// List remote-tracking branches in the source repo.
pub fn list_remote_branches(repo_root: &Path) -> Result<Vec<String>> {
    let repo_root = repo_root.display().to_string();
    let output = run_git(
        [
            "-C",
            repo_root.as_str(),
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/remotes/origin/",
        ],
        None,
    )
    .context("Failed to list remote branches")?;

    let branches: Vec<String> = output
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && *line != "origin/HEAD" && *line != "origin")
        .map(|line| line.strip_prefix("origin/").unwrap_or(line).to_string())
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
pub fn create_worktree_from_start_point(
    repo_root: &Path,
    workspace_dir: &Path,
    branch: &str,
    start_point: &str,
) -> Result<String> {
    let repo_root = repo_root.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    prune_worktrees(&repo_root);
    run_git(
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
    })
}

pub fn remove_worktree(repo_root: &Path, workspace_dir: &Path) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    run_git(
        [
            "-C",
            repo_root.as_str(),
            "worktree",
            "remove",
            "--force",
            workspace_dir_arg.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .with_context(|| format!("Failed to remove worktree at {}", workspace_dir.display()))
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

pub fn default_branch_ref(default_branch: &str) -> String {
    format!("refs/heads/{default_branch}")
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

/// Fetch a specific branch from `origin` into the workspace's repo.
///
/// Bounded by `GIT_NETWORK_TIMEOUT` and runs in a no-prompt environment so
/// a stalled remote or credential prompt cannot park the calling thread.
pub fn fetch_remote_branch(workspace_dir: &Path, branch: &str) -> Result<()> {
    let workspace_dir = workspace_dir.display().to_string();
    run_git_with_timeout(
        ["-C", workspace_dir.as_str(), "fetch", "origin", branch],
        None,
        GIT_NETWORK_TIMEOUT,
    )
    .map(|_| ())
    .with_context(|| format!("Failed to fetch origin/{} into {}", branch, workspace_dir))
}

/// Fetch all branches from `origin`, pruning deleted remote refs.
///
/// Bounded by `GIT_NETWORK_TIMEOUT` and runs in a no-prompt environment so
/// a stalled remote or credential prompt cannot park the calling thread.
pub fn fetch_all_remote(workspace_dir: &Path) -> Result<()> {
    let workspace_dir = workspace_dir.display().to_string();
    run_git_with_timeout(
        ["-C", workspace_dir.as_str(), "fetch", "--prune", "origin"],
        None,
        GIT_NETWORK_TIMEOUT,
    )
    .map(|_| ())
    .with_context(|| format!("Failed to fetch all from origin in {}", workspace_dir))
}

/// Returns true if `refs/remotes/origin/<branch>` exists locally (no network).
pub fn verify_remote_ref_exists(workspace_dir: &Path, branch: &str) -> Result<bool> {
    let workspace_dir = workspace_dir.display().to_string();
    let ref_name = format!("refs/remotes/origin/{branch}");
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

/// Resolve `refs/remotes/origin/<branch>` to its current commit SHA.
pub fn remote_ref_sha(workspace_dir: &Path, branch: &str) -> Result<String> {
    let workspace_dir = workspace_dir.display().to_string();
    let ref_name = format!("refs/remotes/origin/{branch}");
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
