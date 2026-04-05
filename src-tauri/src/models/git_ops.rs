use anyhow::{bail, Context, Result};
use std::{ffi::OsStr, fs, path::Path, process::Command};

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

/// Fetch latest refs from the remote into the source repo.
pub fn fetch_remote(repo_root: &Path) -> Result<()> {
    let repo_root = repo_root.display().to_string();
    run_git(["-C", repo_root.as_str(), "fetch", "--prune"], None)
        .map(|_| ())
        .context("Failed to fetch from remote")
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
        .filter(|line| !line.is_empty() && *line != "origin/HEAD")
        .map(|line| line.strip_prefix("origin/").unwrap_or(line).to_string())
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
