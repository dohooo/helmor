//! Tests for `read_file_at_ref` — specifically the three diff bases used by
//! the inspector:
//!   - "HEAD" → HEAD ref (staged area's original side, committed-diff base)
//!   - ":0" → git stage 0 (index), used as the modified side of the staged
//!     area AND the original side of the unstaged area
//!   - working-tree reads are NOT covered here (they go through
//!     `read_editor_file`, not `read_file_at_ref`)
//!
//! Regression cover for issue #544: same file in both Staged and Unstaged
//! produced a `HEAD ↔ working-tree` diff because the unstaged side never
//! asked for the index version. With `:0` plumbed through, each area now
//! reads its own base ref.

use super::{read_file_at_ref, support::GitRepoHarness};

#[test]
fn reads_file_at_head_ref() {
    let repo = GitRepoHarness::new();
    repo.write_file("src/app.ts", "const v1 = true;\n");
    repo.git(&["add", "src/app.ts"]);
    repo.git(&["commit", "-m", "add app"]);
    // Subsequent edits must not leak into HEAD.
    repo.write_file("src/app.ts", "const v2 = true;\n");
    repo.git(&["add", "src/app.ts"]);
    repo.write_file("src/app.ts", "const v3 = true;\n");

    let absolute = format!("{}/src/app.ts", repo.path_str());
    let content = read_file_at_ref(repo.path_str(), &absolute, "HEAD")
        .unwrap()
        .expect("file must exist at HEAD");
    assert_eq!(content, "const v1 = true;\n");
}

#[test]
fn reads_file_at_index_ref() {
    let repo = GitRepoHarness::new();
    repo.write_file("src/app.ts", "const v1 = true;\n");
    repo.git(&["add", "src/app.ts"]);
    repo.git(&["commit", "-m", "add app"]);
    // Stage a modification, then make an unstaged change on top. The index
    // must hold the staged version (v2), distinct from HEAD (v1) and from
    // the working tree (v3).
    repo.write_file("src/app.ts", "const v2 = true;\n");
    repo.git(&["add", "src/app.ts"]);
    repo.write_file("src/app.ts", "const v3 = true;\n");

    let absolute = format!("{}/src/app.ts", repo.path_str());
    let content = read_file_at_ref(repo.path_str(), &absolute, ":0")
        .unwrap()
        .expect("file must exist in the index");
    assert_eq!(content, "const v2 = true;\n");
}

#[test]
fn head_index_and_worktree_yield_distinct_content() {
    // The whole point of the fix: the three areas must read different bytes
    // when a file lives in all three "stages" with different content.
    let repo = GitRepoHarness::new();
    repo.write_file("foo.txt", "head\n");
    repo.git(&["add", "foo.txt"]);
    repo.git(&["commit", "-m", "init foo"]);
    repo.write_file("foo.txt", "index\n");
    repo.git(&["add", "foo.txt"]);
    repo.write_file("foo.txt", "worktree\n");

    let absolute = format!("{}/foo.txt", repo.path_str());
    let head = read_file_at_ref(repo.path_str(), &absolute, "HEAD")
        .unwrap()
        .unwrap();
    let index = read_file_at_ref(repo.path_str(), &absolute, ":0")
        .unwrap()
        .unwrap();
    assert_eq!(head, "head\n");
    assert_eq!(index, "index\n");
    // The working-tree side is the editor's job — we just confirm git did
    // not bleed working-tree bytes into either ref view.
    assert_ne!(head, index);
}

#[test]
fn returns_none_when_path_not_in_index() {
    // Untracked file → `git show :0:path` fails → caller gets None. The
    // unstaged area relies on this when status=="A" (we skip reading the
    // original side anyway, but defense in depth).
    let repo = GitRepoHarness::new();
    repo.write_file("untracked.txt", "fresh\n");

    let absolute = format!("{}/untracked.txt", repo.path_str());
    let result = read_file_at_ref(repo.path_str(), &absolute, ":0").unwrap();
    assert!(result.is_none());
}

#[test]
fn returns_none_when_path_not_in_head() {
    // Staged-but-not-committed file → `git show HEAD:path` fails. The staged
    // area relies on this when stagedStatus=="A".
    let repo = GitRepoHarness::new();
    repo.write_file("new.txt", "added\n");
    repo.git(&["add", "new.txt"]);

    let absolute = format!("{}/new.txt", repo.path_str());
    let result = read_file_at_ref(repo.path_str(), &absolute, "HEAD").unwrap();
    assert!(result.is_none());
}
