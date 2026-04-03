use std::{
    ffi::OsStr,
    fs,
    path::Path,
    process::Command,
};

pub fn run_git<I, S>(args: I, current_dir: Option<&Path>) -> Result<String, String>
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

    let output = command
        .output()
        .map_err(|error| format!("Failed to run git: {error}"))?;

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

    Err(detail)
}

pub fn ensure_git_repository(repo_root: &Path) -> Result<(), String> {
    let repo_root = repo_root.display().to_string();
    run_git(
        ["-C", repo_root.as_str(), "rev-parse", "--show-toplevel"],
        None,
    )
    .map(|_| ())
    .map_err(|error| format!("Repository source is invalid: {error}"))
}

pub fn ensure_repo_mirror(source_repo_root: &Path, mirror_dir: &Path) -> Result<(), String> {
    ensure_git_repository(source_repo_root)?;
    fs::create_dir_all(
        mirror_dir
            .parent()
            .ok_or_else(|| format!("Mirror path has no parent: {}", mirror_dir.display()))?,
    )
    .map_err(|error| {
        format!(
            "Failed to create repo mirror parent for {}: {error}",
            mirror_dir.display()
        )
    })?;

    if mirror_dir.exists() {
        let mirror_dir = mirror_dir.display().to_string();
        run_git(
            ["--git-dir", mirror_dir.as_str(), "rev-parse", "--git-dir"],
            None,
        )?;
    } else {
        let source_repo_root = source_repo_root.display().to_string();
        let mirror_dir = mirror_dir.display().to_string();
        run_git(
            [
                "clone",
                "--mirror",
                "--no-local",
                source_repo_root.as_str(),
                mirror_dir.as_str(),
            ],
            None,
        )?;
    }

    let source_repo_root = source_repo_root.display().to_string();
    let mirror_dir = mirror_dir.display().to_string();
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "fetch",
            "--prune",
            source_repo_root.as_str(),
            "+refs/heads/*:refs/remotes/origin/*",
        ],
        None,
    )?;

    Ok(())
}

pub fn create_worktree(
    mirror_dir: &Path,
    workspace_dir: &Path,
    branch: &str,
) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "worktree",
            "add",
            workspace_dir_arg.as_str(),
            branch,
        ],
        None,
    )
    .map(|_| ())
    .map_err(|error| {
        format!(
            "Failed to create worktree at {} for branch {}: {error}",
            workspace_dir.display(),
            branch
        )
    })
}

pub fn create_worktree_from_start_point(
    mirror_dir: &Path,
    workspace_dir: &Path,
    branch: &str,
    start_point: &str,
) -> Result<String, String> {
    let mirror_dir = mirror_dir.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "worktree",
            "add",
            "-b",
            branch,
            workspace_dir_arg.as_str(),
            start_point,
        ],
        None,
    )
    .map_err(|error| {
        format!(
            "Failed to create worktree at {} for branch {} from {}: {error}",
            workspace_dir.display(),
            branch,
            start_point
        )
    })
}

pub fn remove_worktree(mirror_dir: &Path, workspace_dir: &Path) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let workspace_dir_arg = workspace_dir.display().to_string();
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "worktree",
            "remove",
            "--force",
            workspace_dir_arg.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .map_err(|error| {
        format!(
            "Failed to remove worktree at {}: {error}",
            workspace_dir.display()
        )
    })
}

pub fn remove_branch(mirror_dir: &Path, branch: &str) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let branch_ref = format!("refs/heads/{branch}");
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "update-ref",
            "-d",
            branch_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .or_else(|error| {
        if error.contains("cannot lock ref") || error.contains("does not exist") {
            Ok(())
        } else {
            Err(format!("Failed to remove branch {branch}: {error}"))
        }
    })
}

pub fn refresh_repo_setup_root(
    mirror_dir: &Path,
    setup_root_dir: &Path,
    start_point: &str,
) -> Result<(), String> {
    if setup_root_dir.exists() {
        let _ = remove_worktree(mirror_dir, setup_root_dir);
        let _ = fs::remove_dir_all(setup_root_dir);
    }

    fs::create_dir_all(
        setup_root_dir
            .parent()
            .ok_or_else(|| format!("Setup root path has no parent: {}", setup_root_dir.display()))?,
    )
    .map_err(|error| {
        format!(
            "Failed to create setup root parent for {}: {error}",
            setup_root_dir.display()
        )
    })?;

    let mirror_dir = mirror_dir.display().to_string();
    let setup_root_dir_arg = setup_root_dir.display().to_string();
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "worktree",
            "add",
            "--detach",
            setup_root_dir_arg.as_str(),
            start_point,
        ],
        None,
    )
    .map(|_| ())
    .map_err(|error| {
        format!(
            "Failed to materialize setup root at {} from {}: {error}",
            setup_root_dir.display(),
            start_point
        )
    })
}

pub fn verify_branch_exists_in_mirror(mirror_dir: &Path, branch: &str) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let branch_ref = format!("refs/remotes/origin/{branch}");
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "rev-parse",
            "--verify",
            branch_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .map_err(|_| format!("Archived workspace branch no longer exists in source repo: {branch}"))
}

pub fn verify_commit_exists_in_mirror(
    mirror_dir: &Path,
    archive_commit: &str,
) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let commit_ref = format!("{archive_commit}^{{commit}}");
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "rev-parse",
            "--verify",
            commit_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .map_err(|_| format!("Archived workspace commit is missing in source repo: {archive_commit}"))
}

pub fn verify_commitish_exists_in_mirror(
    mirror_dir: &Path,
    commitish: &str,
    error_message: &str,
) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let verify_ref = format!("{commitish}^{{commit}}");
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "rev-parse",
            "--verify",
            verify_ref.as_str(),
        ],
        None,
    )
    .map(|_| ())
    .map_err(|_| error_message.to_string())
}

pub fn point_branch_to_archive_commit(
    mirror_dir: &Path,
    branch: &str,
    archive_commit: &str,
) -> Result<(), String> {
    let mirror_dir = mirror_dir.display().to_string();
    let branch_ref = format!("refs/heads/{branch}");
    run_git(
        [
            "--git-dir",
            mirror_dir.as_str(),
            "update-ref",
            branch_ref.as_str(),
            archive_commit,
        ],
        None,
    )
    .map(|_| ())
    .map_err(|error| {
        format!("Failed to point branch {branch} at {archive_commit}: {error}")
    })
}

pub fn current_workspace_head_commit(workspace_dir: &Path) -> Result<String, String> {
    let workspace_dir = workspace_dir.display().to_string();
    let commit = run_git(["-C", workspace_dir.as_str(), "rev-parse", "HEAD"], None)
        .map_err(|error| {
            format!(
                "Failed to resolve archive commit from workspace {}: {error}",
                workspace_dir
            )
        })?;

    if commit.trim().is_empty() {
        return Err(format!(
            "Resolved empty archive commit for workspace {}",
            workspace_dir
        ));
    }

    Ok(commit)
}

pub fn remote_tracking_branch_ref(default_branch: &str) -> String {
    format!("refs/remotes/origin/{default_branch}")
}

pub fn tracked_file_count(workspace_dir: &Path) -> Result<i64, String> {
    let workspace_dir = workspace_dir.display().to_string();
    let output = run_git(["-C", workspace_dir.as_str(), "ls-files"], None).map_err(|error| {
        format!(
            "Failed to count tracked files for workspace {}: {error}",
            workspace_dir
        )
    })?;

    Ok(output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count() as i64)
}
