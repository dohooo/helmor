//! `.agent-contexts/` — a per-workspace scratch directory agents can
//! drop files into to coordinate across sessions or sub-tasks.
//!
//! The directory is **not** committed: we add it to the worktree's
//! local exclude file (`<gitdir>/info/exclude`) so the rule lives next
//! to the worktree itself and does **not** leak into the user's
//! tracked `.gitignore`. The user's repo on disk has zero new lines
//! after Helmor materialises a workspace — clean as it was.
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
//! `gitdir: <abs-path-to-main-repo>/.git/worktrees/<name>`. The
//! per-worktree `info/exclude` lives **at that linked path**, not
//! under the worktree's local `.git/`. [`resolve_worktree_git_dir`]
//! handles both the linked-file form and the unusual "this is the
//! main repo itself" directory form so the helper is correct under
//! both layouts.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Subdirectory under the worktree root where agents can drop files
/// that other agents (or the same agent in a later session) can read.
pub const AGENT_CONTEXTS_DIR: &str = ".agent-contexts";

/// The line we append to `<gitdir>/info/exclude`. Matches `git`'s
/// usual pathspec syntax — a leading slash anchors to the worktree
/// root so we don't accidentally exclude any nested `.agent-contexts`
/// folders the user might create later.
const EXCLUDE_RULE: &str = "/.agent-contexts/";

/// Comment line written above the rule. Makes it obvious to anyone
/// inspecting `info/exclude` why the entry is there.
const EXCLUDE_COMMENT: &str = "# Helmor: scratch space for agents to share files across sessions.";

/// Materialise `.agent-contexts/` under `workspace_dir` and add it to
/// the worktree's local exclude file. Best-effort: errors are returned
/// so callers can log them, but callers should NOT abort workspace
/// creation on failure — agents will still work without the scratch
/// dir, just without cross-session file sharing.
pub fn ensure_agent_contexts_in_worktree(workspace_dir: &Path) -> Result<()> {
    let contexts_dir = workspace_dir.join(AGENT_CONTEXTS_DIR);
    std::fs::create_dir_all(&contexts_dir)
        .with_context(|| format!("create agent-contexts dir at {}", contexts_dir.display()))?;

    let git_dir = resolve_worktree_git_dir(workspace_dir)
        .with_context(|| format!("resolve worktree git dir for {}", workspace_dir.display()))?;
    append_worktree_local_exclude(&git_dir).with_context(|| {
        format!(
            "append agent-contexts rule to {}/info/exclude",
            git_dir.display()
        )
    })?;
    Ok(())
}

/// Resolve the path that owns `info/exclude` for this worktree.
///
/// - If `<workspace_dir>/.git` is a **directory**, this worktree is the
///   main checkout: return that directory.
/// - If `<workspace_dir>/.git` is a **file**, this worktree is a git
///   linked worktree: read the file, extract the `gitdir: <path>` line
///   (per git's worktree layout), and return that path.
pub(crate) fn resolve_worktree_git_dir(workspace_dir: &Path) -> Result<PathBuf> {
    let git_pointer = workspace_dir.join(".git");
    let metadata = std::fs::metadata(&git_pointer)
        .with_context(|| format!("stat {}", git_pointer.display()))?;

    if metadata.is_dir() {
        return Ok(git_pointer);
    }
    if !metadata.is_file() {
        anyhow::bail!(
            "{} is neither a file nor a directory — cannot locate worktree git dir",
            git_pointer.display()
        );
    }

    let raw = std::fs::read_to_string(&git_pointer)
        .with_context(|| format!("read {}", git_pointer.display()))?;
    let line = raw
        .lines()
        .find(|l| !l.trim().is_empty())
        .with_context(|| {
            format!(
                "{} is empty — expected `gitdir: ...`",
                git_pointer.display()
            )
        })?;
    let path = line
        .strip_prefix("gitdir:")
        .map(|s| s.trim())
        .with_context(|| {
            format!(
                "{} does not start with `gitdir:` — got {:?}",
                git_pointer.display(),
                line
            )
        })?;
    Ok(PathBuf::from(path))
}

/// Append our exclude rule to `<git_dir>/info/exclude`. Idempotent: if
/// the rule (or our exact comment) is already present, no second copy
/// is written, so calling this repeatedly across workspace recreations
/// doesn't litter the file.
pub(crate) fn append_worktree_local_exclude(git_dir: &Path) -> Result<()> {
    let info_dir = git_dir.join("info");
    std::fs::create_dir_all(&info_dir).with_context(|| format!("create {}", info_dir.display()))?;
    let exclude_path = info_dir.join("exclude");

    let existing = std::fs::read_to_string(&exclude_path).unwrap_or_default();
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
    std::fs::write(&exclude_path, buffer)
        .with_context(|| format!("write {}", exclude_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `.git` is a directory (main-checkout case) → resolver returns
    /// it directly.
    #[test]
    fn resolves_main_checkout_git_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let git_dir = tmp.path().join(".git");
        std::fs::create_dir_all(&git_dir).unwrap();

        let resolved = resolve_worktree_git_dir(tmp.path()).unwrap();
        assert_eq!(resolved, git_dir);
    }

    /// `.git` is a file whose first line is `gitdir: …` (linked
    /// worktree case) → resolver returns the gitdir target.
    #[test]
    fn resolves_linked_worktree_git_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("main-repo/.git/worktrees/feature");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(
            tmp.path().join(".git"),
            format!("gitdir: {}\n", target.display()),
        )
        .unwrap();

        let resolved = resolve_worktree_git_dir(tmp.path()).unwrap();
        assert_eq!(resolved, target);
    }

    /// `.git` file without `gitdir:` prefix → error mentions the
    /// missing prefix so the caller can surface a useful message.
    #[test]
    fn rejects_git_pointer_without_gitdir_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".git"), "not a real pointer\n").unwrap();

        let err = resolve_worktree_git_dir(tmp.path()).unwrap_err();
        assert!(format!("{err:#}").contains("gitdir"));
    }

    /// First call writes both comment + rule; second call is a no-op
    /// (file unchanged). Locks in idempotency so re-running on the
    /// same workspace doesn't pile up duplicates.
    #[test]
    fn exclude_append_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let git_dir = tmp.path().join(".git");
        std::fs::create_dir_all(&git_dir).unwrap();

        append_worktree_local_exclude(&git_dir).unwrap();
        let after_first = std::fs::read_to_string(git_dir.join("info/exclude")).unwrap();
        assert!(after_first.contains(EXCLUDE_RULE));
        assert!(after_first.contains(EXCLUDE_COMMENT));

        append_worktree_local_exclude(&git_dir).unwrap();
        let after_second = std::fs::read_to_string(git_dir.join("info/exclude")).unwrap();
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
        let info_dir = tmp.path().join(".git/info");
        std::fs::create_dir_all(&info_dir).unwrap();
        std::fs::write(info_dir.join("exclude"), "*.local\n").unwrap();

        append_worktree_local_exclude(&tmp.path().join(".git")).unwrap();
        let final_content = std::fs::read_to_string(info_dir.join("exclude")).unwrap();

        assert!(final_content.starts_with("*.local\n"));
        assert!(final_content.contains(EXCLUDE_RULE));
    }

    /// Full happy-path end-to-end: from a workspace dir with a fake
    /// `.git` directory, `ensure_agent_contexts_in_worktree` should
    /// create the contexts dir AND write the exclude rule.
    #[test]
    fn ensure_creates_dir_and_exclude_for_main_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path();
        std::fs::create_dir_all(workspace.join(".git")).unwrap();

        ensure_agent_contexts_in_worktree(workspace).unwrap();

        assert!(workspace.join(AGENT_CONTEXTS_DIR).is_dir());
        let exclude = std::fs::read_to_string(workspace.join(".git/info/exclude")).unwrap();
        assert!(exclude.contains(EXCLUDE_RULE));
    }

    /// End-to-end for the linked-worktree shape: `.git` is a file
    /// pointing at an external gitdir, and the exclude lands there
    /// (not under the worktree's own path).
    #[test]
    fn ensure_creates_dir_and_exclude_for_linked_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let linked_gitdir = tmp.path().join("main-repo/.git/worktrees/feature");
        std::fs::create_dir_all(&linked_gitdir).unwrap();
        std::fs::write(
            workspace.join(".git"),
            format!("gitdir: {}\n", linked_gitdir.display()),
        )
        .unwrap();

        ensure_agent_contexts_in_worktree(&workspace).unwrap();

        assert!(workspace.join(AGENT_CONTEXTS_DIR).is_dir());
        let exclude = std::fs::read_to_string(linked_gitdir.join("info/exclude")).unwrap();
        assert!(exclude.contains(EXCLUDE_RULE));
        // The exclude file under the worktree's local `.git` (which
        // for linked worktrees is a *file*, not a dir) must NOT exist.
        assert!(!workspace.join(".git/info/exclude").exists());
    }
}
