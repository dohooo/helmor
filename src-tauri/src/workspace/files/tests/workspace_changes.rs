use std::{fs, path::Path};

use crate::{git_ops, workspace::agent_contexts::ensure_agent_contexts_in_worktree};

use super::{list_workspace_changes, support::GitRepoHarness};

#[test]
fn classification_unstaged_modification() {
    let repo = GitRepoHarness::new();

    repo.write_file("src/app.ts", "const v1 = true;\n");
    repo.git(&["add", "src/app.ts"]);
    repo.git(&["commit", "-m", "add app"]);
    repo.write_file("src/app.ts", "const v2 = true;\n");

    let item = repo.find("src/app.ts").expect("file should appear");
    assert!(
        item.unstaged_status.is_some(),
        "should have unstaged_status: {item:?}"
    );
    assert_eq!(item.unstaged_status.as_deref(), Some("M"));
    assert!(item.committed_status.is_some());
}

#[test]
fn classification_staged_modification() {
    let repo = GitRepoHarness::new();

    repo.write_file("src/app.ts", "const v1 = true;\n");
    repo.git(&["add", "src/app.ts"]);
    repo.git(&["commit", "-m", "add app"]);
    repo.write_file("src/app.ts", "const v2 = true;\n");
    repo.git(&["add", "src/app.ts"]);

    let item = repo.find("src/app.ts").expect("file should appear");
    assert_eq!(
        item.staged_status.as_deref(),
        Some("M"),
        "should have staged M: {item:?}"
    );
    assert!(
        item.unstaged_status.is_none(),
        "should NOT have unstaged_status: {item:?}"
    );
}

#[test]
fn classification_untracked_file() {
    let repo = GitRepoHarness::new();

    repo.write_file("new-file.txt", "hello\n");

    let item = repo.find("new-file.txt").expect("file should appear");
    assert_eq!(
        item.unstaged_status.as_deref(),
        Some("A"),
        "untracked file should have unstaged A: {item:?}"
    );
    assert!(
        item.staged_status.is_none(),
        "untracked should NOT have staged_status: {item:?}"
    );
    assert!(
        item.committed_status.is_none(),
        "untracked should NOT have committed_status: {item:?}"
    );
}

#[test]
fn agent_contexts_is_ignored_in_real_git_worktree_changes() {
    let repo = GitRepoHarness::new();
    let worktree_parent = tempfile::tempdir().unwrap();
    let worktree_dir = worktree_parent.path().join("workspace");
    let worktree_arg = worktree_dir.display().to_string();

    git_ops::run_git(
        [
            "worktree",
            "add",
            "-b",
            "feature/agent-contexts-ignore",
            worktree_arg.as_str(),
            "main",
        ],
        Some(Path::new(repo.path_str())),
    )
    .unwrap();
    assert!(
        worktree_dir.join(".git").is_file(),
        "test must cover a real linked worktree"
    );

    ensure_agent_contexts_in_worktree(&worktree_dir).unwrap();
    fs::write(worktree_dir.join(".agent-contexts/note.md"), "note\n").unwrap();
    fs::write(worktree_dir.join("visible.txt"), "visible\n").unwrap();

    let ignored = git_ops::run_git(
        ["check-ignore", ".agent-contexts/note.md"],
        Some(&worktree_dir),
    );
    assert!(ignored.is_ok(), "Git itself should ignore .agent-contexts");

    let untracked = git_ops::run_git(
        ["ls-files", "--others", "--exclude-standard"],
        Some(&worktree_dir),
    )
    .unwrap();
    assert!(
        untracked.contains("visible.txt"),
        "positive control should be untracked: {untracked:?}"
    );
    assert!(
        !untracked.contains(".agent-contexts/"),
        ".agent-contexts should be excluded by git: {untracked:?}"
    );

    let items = list_workspace_changes(worktree_dir.to_str().unwrap()).unwrap();
    assert!(
        items.iter().any(|item| item.path == "visible.txt"),
        "positive control should appear in Changes: {items:?}"
    );
    assert!(
        items
            .iter()
            .all(|item| !item.path.starts_with(".agent-contexts/")),
        ".agent-contexts files must not appear in Changes: {items:?}"
    );
}

#[test]
fn classification_staged_new_file() {
    let repo = GitRepoHarness::new();

    repo.write_file("new-file.txt", "hello\n");
    repo.git(&["add", "new-file.txt"]);

    let item = repo.find("new-file.txt").expect("file should appear");
    assert_eq!(
        item.staged_status.as_deref(),
        Some("A"),
        "staged new file should have staged A: {item:?}"
    );
    assert!(
        item.unstaged_status.is_none(),
        "fully staged should NOT have unstaged_status: {item:?}"
    );
}

#[test]
fn classification_committed_on_branch() {
    let repo = GitRepoHarness::new();

    repo.write_file("feature.ts", "export const feature = true;\n");
    repo.git(&["add", "feature.ts"]);
    repo.git(&["commit", "-m", "add feature"]);

    let item = repo.find("feature.ts").expect("file should appear");
    assert_eq!(
        item.committed_status.as_deref(),
        Some("A"),
        "committed file should have committed A: {item:?}"
    );
    assert!(
        item.staged_status.is_none(),
        "clean committed should NOT have staged_status: {item:?}"
    );
    assert!(
        item.unstaged_status.is_none(),
        "clean committed should NOT have unstaged_status: {item:?}"
    );
}

#[test]
fn classification_both_staged_and_unstaged() {
    let repo = GitRepoHarness::new();

    repo.write_file("mixed.ts", "v1\n");
    repo.git(&["add", "mixed.ts"]);
    repo.git(&["commit", "-m", "add mixed"]);
    repo.write_file("mixed.ts", "v2\n");
    repo.git(&["add", "mixed.ts"]);
    repo.write_file("mixed.ts", "v3\n");

    let item = repo.find("mixed.ts").expect("file should appear");
    assert_eq!(
        item.staged_status.as_deref(),
        Some("M"),
        "should have staged M: {item:?}"
    );
    assert_eq!(
        item.unstaged_status.as_deref(),
        Some("M"),
        "should have unstaged M: {item:?}"
    );
}

#[test]
fn classification_after_commit_changes_clear() {
    let repo = GitRepoHarness::new();

    repo.write_file("done.ts", "done\n");
    repo.git(&["add", "done.ts"]);
    repo.git(&["commit", "-m", "add done"]);

    let item = repo.find("done.ts").expect("file should appear");
    assert!(
        item.committed_status.is_some(),
        "should have committed_status: {item:?}"
    );
    assert!(
        item.staged_status.is_none(),
        "committed file should NOT have staged: {item:?}"
    );
    assert!(
        item.unstaged_status.is_none(),
        "committed file should NOT have unstaged: {item:?}"
    );
}

#[test]
fn classification_no_changes_empty_result() {
    let repo = GitRepoHarness::new();

    let items = repo.changes();
    assert!(
        items.is_empty(),
        "clean branch should have no changes: {items:?}"
    );
}

#[test]
fn classification_discard_removes_from_changes() {
    let repo = GitRepoHarness::new();

    repo.write_file("README.md", "modified\n");
    assert!(
        repo.find("README.md").is_some(),
        "modified file should show"
    );

    repo.git(&["checkout", "--", "README.md"]);
    assert!(
        repo.find("README.md").is_none(),
        "discarded file should NOT show"
    );
}

// ---------------------------------------------------------------------------
// Per-area line counts. Each area (committed / staged / unstaged) reports
// its own insertions/deletions; numbers must NOT be summed across areas.
// ---------------------------------------------------------------------------

#[test]
fn line_counts_unstaged_only() {
    let repo = GitRepoHarness::new();
    repo.write_file("app.ts", "line1\nline2\nline3\n");
    repo.git(&["add", "app.ts"]);
    repo.git(&["commit", "-m", "add app"]);
    // Edit on top of HEAD — unstaged only.
    repo.write_file("app.ts", "line1\nline2 changed\nline3\nline4\n");

    let item = repo.find("app.ts").expect("file should appear");
    assert_eq!(item.unstaged_insertions, 2);
    assert_eq!(item.unstaged_deletions, 1);
    assert_eq!(item.staged_insertions, 0);
    assert_eq!(item.staged_deletions, 0);
}

#[test]
fn line_counts_staged_and_unstaged_kept_separate() {
    let repo = GitRepoHarness::new();
    repo.write_file("app.ts", "v1\n");
    repo.git(&["add", "app.ts"]);
    repo.git(&["commit", "-m", "add app"]);
    // Stage a 1-for-1 swap.
    repo.write_file("app.ts", "v2\n");
    repo.git(&["add", "app.ts"]);
    // Then make a different unstaged edit on top.
    repo.write_file("app.ts", "v3\nv4\n");

    let item = repo.find("app.ts").expect("file should appear");
    // Areas keep their own numbers — no summing.
    assert_eq!(item.staged_insertions, 1, "staged: v1 -> v2 (1/1)");
    assert_eq!(item.staged_deletions, 1);
    assert_eq!(item.unstaged_insertions, 2, "unstaged: v2 -> v3+v4 (2/1)");
    assert_eq!(item.unstaged_deletions, 1);
}

#[test]
fn line_counts_committed_and_unstaged_kept_separate() {
    let repo = GitRepoHarness::new();
    // 5 lines committed on the branch (relative to main).
    repo.write_file("feature.ts", "a\nb\nc\nd\ne\n");
    repo.git(&["add", "feature.ts"]);
    repo.git(&["commit", "-m", "add feature"]);
    // Then 2 unstaged tweaks on top of the new commit.
    repo.write_file("feature.ts", "a\nb changed\nc\nd\ne\nf\n");

    let item = repo.find("feature.ts").expect("file should appear");
    // Committed area sees +5/-0 (target_ref..HEAD).
    assert_eq!(item.committed_insertions, 5);
    assert_eq!(item.committed_deletions, 0);
    // Unstaged sees +2/-1 (HEAD vs working tree). Crucially this is NOT
    // the same number as committed, and NOT a sum.
    assert_eq!(item.unstaged_insertions, 2);
    assert_eq!(item.unstaged_deletions, 1);
}

#[test]
fn line_counts_untracked_file_reports_unstaged_lines() {
    let repo = GitRepoHarness::new();
    // Brand-new file, nothing staged. Without explicit handling these
    // would all be zero (numstat doesn't see untracked).
    repo.write_file("notes.md", "one\ntwo\nthree\n");

    let item = repo.find("notes.md").expect("file should appear");
    assert_eq!(item.unstaged_insertions, 3);
    assert_eq!(item.unstaged_deletions, 0);
    assert_eq!(item.committed_insertions, 0);
    assert_eq!(item.staged_insertions, 0);
    assert!(!item.is_binary);
}

#[test]
fn line_counts_untracked_no_trailing_newline_still_counts_last_line() {
    let repo = GitRepoHarness::new();
    repo.write_file("oneliner.txt", "no newline at end");

    let item = repo.find("oneliner.txt").expect("file should appear");
    assert_eq!(item.unstaged_insertions, 1);
}

#[test]
fn line_counts_binary_file_marked_and_zeroed() {
    let repo = GitRepoHarness::new();
    // Bytes that aren't valid UTF-8 — both git numstat and our untracked
    // line counter should classify this as binary.
    let absolute = std::path::Path::new(repo_root(&repo)).join("logo.bin");
    std::fs::write(&absolute, [0u8, 159, 146, 150, 0, 1, 2]).unwrap();

    let item = repo.find("logo.bin").expect("file should appear");
    assert!(item.is_binary, "binary untracked file: {item:?}");
    assert_eq!(item.unstaged_insertions, 0);
    assert_eq!(item.unstaged_deletions, 0);
}

fn repo_root(repo: &GitRepoHarness) -> &str {
    repo.path_str()
}
