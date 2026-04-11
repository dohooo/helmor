use super::support::GitRepoHarness;

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
