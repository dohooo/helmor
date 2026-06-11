//! `.agent-contexts/` — a per-workspace scratch directory agents can
//! drop files into to coordinate across sessions or sub-tasks.
//!
//! The directory is **not** committed: we add it to Git's local exclude
//! file (`git rev-parse --git-path info/exclude`) so the rule does
//! **not** leak into the user's tracked `.gitignore`. The user's repo
//! on disk has zero new tracked lines after Helmor materialises a
//! workspace — clean as it was.
//!
//! Both arms of `finalize_workspace_from_repo_impl` (FromBranch +
//! UseBranch) call [`ensure_agent_contexts_in_worktree`] right after
//! the worktree is materialised. The function is best-effort: any IO
//! failure is logged and swallowed so a missing scratch dir cannot
//! block workspace creation.
//!
//! ## Git worktree gotcha
//!
//! In a linked git worktree (which is what Helmor creates), the
//! worktree's `.git` is a *file* whose first line reads
//! `gitdir: <abs-path-to-main-repo>/.git/worktrees/<name>`. That path
//! is **not** necessarily where Git reads `info/exclude` from. Ask Git
//! for `--git-path info/exclude` and write exactly there so our rule
//! matches `git check-ignore` and `git ls-files --exclude-standard`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::{db, git_ops};

/// Subdirectory under the worktree root where agents can drop files
/// that other agents (or the same agent in a later session) can read.
pub const AGENT_CONTEXTS_DIR: &str = ".agent-contexts";

/// The line we append to Git's local `info/exclude`. Matches `git`'s
/// usual pathspec syntax — a leading slash anchors to the worktree
/// root so we don't accidentally exclude any nested `.agent-contexts`
/// folders the user might create later.
const EXCLUDE_RULE: &str = "/.agent-contexts/";

/// Comment line written above the rule. Makes it obvious to anyone
/// inspecting `info/exclude` why the entry is there.
const EXCLUDE_COMMENT: &str = "# Helmor: scratch space for agents to share files across sessions.";

/// Materialise `.agent-contexts/` under `workspace_dir` and add it to
/// Git's local exclude file. Best-effort: errors are returned so
/// callers can log them, but callers should NOT abort workspace
/// creation on failure — agents will still work without the scratch
/// dir, just without cross-session file sharing.
pub fn ensure_agent_contexts_in_worktree(workspace_dir: &Path) -> Result<()> {
    let contexts_dir = workspace_dir.join(AGENT_CONTEXTS_DIR);
    std::fs::create_dir_all(&contexts_dir)
        .with_context(|| format!("create agent-contexts dir at {}", contexts_dir.display()))?;

    let exclude_path = resolve_git_exclude_path(workspace_dir)
        .with_context(|| format!("resolve git exclude path for {}", workspace_dir.display()))?;
    append_local_exclude(&exclude_path)
        .with_context(|| format!("append agent-contexts rule to {}", exclude_path.display()))?;
    Ok(())
}

/// Backfill existing operational worktree workspaces. New workspace
/// creation calls [`ensure_agent_contexts_in_worktree`] directly; this
/// repair path covers workspaces created before the correct exclude
/// path logic shipped.
pub fn ensure_existing_worktree_contexts() -> Result<usize> {
    let connection = db::read_conn()?;
    let mut stmt = connection.prepare(&format!(
        "SELECT w.id, r.name, w.directory_name
         FROM workspaces w
         JOIN repos r ON r.id = w.repository_id
         WHERE w.state {} AND COALESCE(w.mode, 'worktree') = 'worktree'",
        crate::workspace_state::OPERATIONAL_FILTER
    ))?;
    let workspaces: Vec<(String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .filter_map(|row| row.ok())
        .collect();
    drop(stmt);
    drop(connection);

    let mut ensured = 0;
    for (workspace_id, repo_name, directory_name) in workspaces {
        let workspace_dir = match crate::data_dir::workspace_dir(&repo_name, &directory_name) {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %format!("{error:#}"),
                    "Failed to resolve workspace dir while repairing .agent-contexts/"
                );
                continue;
            }
        };
        if !workspace_dir.is_dir() {
            continue;
        }
        match ensure_agent_contexts_in_worktree(&workspace_dir) {
            Ok(()) => ensured += 1,
            Err(error) => {
                tracing::warn!(
                    workspace_id = %workspace_id,
                    path = %workspace_dir.display(),
                    error = %format!("{error:#}"),
                    "Failed to repair .agent-contexts/ — workspace still usable"
                );
            }
        }
    }
    Ok(ensured)
}

/// Resolve the exact `info/exclude` path Git will read for
/// `workspace_dir`.
pub(crate) fn resolve_git_exclude_path(workspace_dir: &Path) -> Result<PathBuf> {
    let raw = git_ops::run_git(
        [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
        ],
        Some(workspace_dir),
    )
    .with_context(|| {
        format!(
            "run `git rev-parse --git-path info/exclude` in {}",
            workspace_dir.display()
        )
    })?;
    if raw.is_empty() {
        anyhow::bail!(
            "git returned an empty exclude path for {}",
            workspace_dir.display()
        );
    }
    Ok(PathBuf::from(raw))
}

/// Append our exclude rule to `exclude_path`. Idempotent: if
/// the rule (or our exact comment) is already present, no second copy
/// is written, so calling this repeatedly across workspace recreations
/// doesn't litter the file.
pub(crate) fn append_local_exclude(exclude_path: &Path) -> Result<()> {
    let info_dir = exclude_path.parent().with_context(|| {
        format!(
            "exclude path has no parent directory: {}",
            exclude_path.display()
        )
    })?;
    std::fs::create_dir_all(info_dir).with_context(|| format!("create {}", info_dir.display()))?;

    let existing = std::fs::read_to_string(exclude_path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == EXCLUDE_RULE) {
        // Already present — nothing to do. Idempotent across retries
        // and across re-creating a workspace at the same path.
        return Ok(());
    }

    let mut buffer = existing;
    if !buffer.is_empty() && !buffer.ends_with('\n') {
        buffer.push('\n');
    }
    buffer.push_str(EXCLUDE_COMMENT);
    buffer.push('\n');
    buffer.push_str(EXCLUDE_RULE);
    buffer.push('\n');
    std::fs::write(exclude_path, buffer)
        .with_context(|| format!("write {}", exclude_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(repo: &Path, args: &[&str]) {
        git_ops::run_git(args, Some(repo)).unwrap_or_else(|error| {
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

    /// First call writes both comment + rule; second call is a no-op
    /// (file unchanged). Locks in idempotency so re-running on the
    /// same workspace doesn't pile up duplicates.
    #[test]
    fn exclude_append_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let exclude_path = tmp.path().join(".git/info/exclude");

        append_local_exclude(&exclude_path).unwrap();
        let after_first = std::fs::read_to_string(&exclude_path).unwrap();
        assert!(after_first.contains(EXCLUDE_RULE));
        assert!(after_first.contains(EXCLUDE_COMMENT));

        append_local_exclude(&exclude_path).unwrap();
        let after_second = std::fs::read_to_string(&exclude_path).unwrap();
        assert_eq!(
            after_first, after_second,
            "second call must not change the file"
        );
    }

    /// Pre-existing exclude content (e.g. user-authored rules) is
    /// preserved; we only append our block, separated by a newline.
    #[test]
    fn exclude_append_preserves_existing_content() {
        let tmp = tempfile::tempdir().unwrap();
        let exclude_path = tmp.path().join(".git/info/exclude");
        std::fs::create_dir_all(exclude_path.parent().unwrap()).unwrap();
        std::fs::write(&exclude_path, "*.local\n").unwrap();

        append_local_exclude(&exclude_path).unwrap();
        let final_content = std::fs::read_to_string(&exclude_path).unwrap();

        assert!(final_content.starts_with("*.local\n"));
        assert!(final_content.contains(EXCLUDE_RULE));
    }

    /// Full happy-path end-to-end: from a real repo checkout,
    /// `ensure_agent_contexts_in_worktree` should create the contexts
    /// dir, write the exclude rule, and make Git ignore files under it.
    #[test]
    fn ensure_creates_dir_and_exclude_for_main_checkout() {
        let repo = init_repo();
        let workspace = repo.path();

        ensure_agent_contexts_in_worktree(workspace).unwrap();
        std::fs::write(workspace.join(".agent-contexts/probe.txt"), "probe\n").unwrap();

        assert!(workspace.join(AGENT_CONTEXTS_DIR).is_dir());
        let exclude_path = resolve_git_exclude_path(workspace).unwrap();
        let exclude = std::fs::read_to_string(&exclude_path).unwrap();
        assert!(exclude.contains(EXCLUDE_RULE));
        let ignored = git_ops::run_git(
            ["check-ignore", "-v", ".agent-contexts/probe.txt"],
            Some(workspace),
        )
        .unwrap();
        assert!(ignored.contains(EXCLUDE_RULE));
    }

    /// End-to-end for a real linked worktree. This catches the bug
    /// where writing to `.git/worktrees/<name>/info/exclude` looks
    /// plausible but is not read by `git check-ignore` or
    /// `git ls-files --others --exclude-standard`.
    #[test]
    fn ensure_creates_dir_and_exclude_for_linked_worktree() {
        let repo = init_repo();
        let worktree_root = tempfile::tempdir().unwrap();
        let workspace = worktree_root.path().join("workspace");
        let workspace_arg = workspace.display().to_string();
        run(
            repo.path(),
            &[
                "worktree",
                "add",
                "-b",
                "feature/agent-contexts",
                workspace_arg.as_str(),
                "HEAD",
            ],
        );

        ensure_agent_contexts_in_worktree(&workspace).unwrap();
        std::fs::write(workspace.join(".agent-contexts/probe.txt"), "probe\n").unwrap();

        assert!(workspace.join(AGENT_CONTEXTS_DIR).is_dir());
        let exclude_path = resolve_git_exclude_path(&workspace).unwrap();
        let exclude = std::fs::read_to_string(&exclude_path).unwrap();
        assert!(exclude.contains(EXCLUDE_RULE));

        let ignored = git_ops::run_git(
            ["check-ignore", "-v", ".agent-contexts/probe.txt"],
            Some(&workspace),
        )
        .unwrap();
        assert!(ignored.contains(EXCLUDE_RULE));

        let untracked = git_ops::run_git(
            [
                "ls-files",
                "--others",
                "--exclude-standard",
                ".agent-contexts",
            ],
            Some(&workspace),
        )
        .unwrap();
        assert!(
            untracked.is_empty(),
            ".agent-contexts should be hidden from Changes, got {untracked:?}"
        );
    }
}
