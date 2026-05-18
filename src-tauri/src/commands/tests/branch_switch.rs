use super::support::*;

#[test]
fn branch_switch_clean_fresh_resets_to_target() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    let target_dev_sha = harness.workspace_remote_ref_sha("dev");

    let result =
        workspaces::update_intended_target_branch_local(&harness.workspace_id, "dev").unwrap();

    assert!(result.reset, "expected a local reset");
    assert_eq!(result.target_branch, "dev");
    assert_eq!(
        result.post_reset_sha.as_deref(),
        Some(target_dev_sha.as_str())
    );
    assert_eq!(harness.workspace_head(), target_dev_sha);
    assert_eq!(harness.intent_in_db(), "dev");
    assert_eq!(harness.init_parent_in_db().as_deref(), Some("dev"));
}

#[test]
fn branch_switch_dirty_modified_skips_reset_but_keeps_intent() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    let head_before = harness.workspace_head();
    harness.dirty_tracked_file();

    let result =
        workspaces::update_intended_target_branch_local(&harness.workspace_id, "dev").unwrap();

    assert!(!result.reset, "dirty worktree must not be reset");
    assert!(result.post_reset_sha.is_none());
    assert_eq!(harness.workspace_head(), head_before, "HEAD must not move");
    assert_eq!(
        harness.intent_in_db(),
        "dev",
        "intent should still be updated"
    );
    assert_eq!(
        harness.init_parent_in_db().as_deref(),
        Some("main"),
        "init_parent must remain at the original baseline"
    );
}

#[test]
fn branch_switch_dirty_untracked_skips_reset() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    let head_before = harness.workspace_head();
    harness.add_untracked_file();

    let result =
        workspaces::update_intended_target_branch_local(&harness.workspace_id, "dev").unwrap();

    assert!(!result.reset, "untracked files must block the reset");
    assert_eq!(harness.workspace_head(), head_before);
    assert_eq!(harness.intent_in_db(), "dev");
    assert_eq!(harness.init_parent_in_db().as_deref(), Some("main"));
}

#[test]
fn branch_switch_user_commit_skips_reset() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    harness.commit_in_workspace("user.txt", "user work", "user commit");
    let head_after_commit = harness.workspace_head();

    let result =
        workspaces::update_intended_target_branch_local(&harness.workspace_id, "dev").unwrap();

    assert!(
        !result.reset,
        "branch with user commits must never be reset"
    );
    assert_eq!(
        harness.workspace_head(),
        head_after_commit,
        "user's commit must be preserved"
    );
    assert_eq!(harness.intent_in_db(), "dev");
    assert_eq!(harness.init_parent_in_db().as_deref(), Some("main"));
}

#[test]
fn branch_switch_no_init_parent_skips_reset() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    harness.set_init_parent(None);
    let head_before = harness.workspace_head();

    let result =
        workspaces::update_intended_target_branch_local(&harness.workspace_id, "dev").unwrap();

    assert!(
        !result.reset,
        "no baseline → cannot prove the branch is fresh"
    );
    assert_eq!(harness.workspace_head(), head_before);
    assert_eq!(harness.intent_in_db(), "dev");
    assert_eq!(harness.init_parent_in_db(), None);
}

#[test]
fn branch_switch_missing_remote_ref_silent_fallback() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    let head_before = harness.workspace_head();

    let result =
        workspaces::update_intended_target_branch_local(&harness.workspace_id, "no-such-branch")
            .unwrap();

    assert!(
        !result.reset,
        "missing origin/<target> must silent-fallback, not error"
    );
    assert_eq!(harness.workspace_head(), head_before);
    assert_eq!(harness.intent_in_db(), "no-such-branch");
    assert_eq!(harness.init_parent_in_db().as_deref(), Some("main"));
}

#[test]
fn branch_switch_archived_state_bails() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    harness.set_state("archived");

    let err =
        workspaces::update_intended_target_branch_local(&harness.workspace_id, "dev").unwrap_err();
    assert!(
        err.to_string().contains("not found or archived"),
        "expected 'not found or archived' error, got: {err}"
    );
}

#[test]
fn branch_switch_round_trip_baseline_tracking() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();

    let r1 = workspaces::update_intended_target_branch_local(&harness.workspace_id, "dev").unwrap();
    assert!(r1.reset);
    assert_eq!(harness.init_parent_in_db().as_deref(), Some("dev"));
    let head_on_dev = harness.workspace_head();
    assert_eq!(head_on_dev, harness.workspace_remote_ref_sha("dev"));

    harness.commit_in_workspace("more.txt", "more", "more work");
    let head_after_commit = harness.workspace_head();
    assert_ne!(head_after_commit, head_on_dev);

    let r2 = workspaces::update_intended_target_branch_local(&harness.workspace_id, "feature/work")
        .unwrap();
    assert!(
        !r2.reset,
        "user commit on dev must block the next realignment"
    );
    assert_eq!(
        harness.workspace_head(),
        head_after_commit,
        "the user's commit must be preserved across the switch"
    );
    assert_eq!(harness.intent_in_db(), "feature/work");
    assert_eq!(harness.init_parent_in_db().as_deref(), Some("dev"));
}

#[test]
fn branch_switch_silent_re_reset_when_remote_advances() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();

    let r = workspaces::update_intended_target_branch_local(&harness.workspace_id, "dev").unwrap();
    let post_reset_sha = r.post_reset_sha.unwrap();
    assert_eq!(harness.workspace_head(), post_reset_sha);

    harness.upstream_advance("dev", "newdev.txt", "fresh", "advance dev");

    let re_reset =
        workspaces::refresh_remote_and_realign(&harness.workspace_id, "dev", &post_reset_sha)
            .unwrap();

    assert!(re_reset, "remote moved + clean tree → silent re-reset");
    let new_head = harness.workspace_head();
    assert_ne!(new_head, post_reset_sha, "HEAD should have advanced");
    assert_eq!(
        new_head,
        harness.workspace_remote_ref_sha("dev"),
        "HEAD must be the freshly fetched origin/dev"
    );
}

#[test]
fn branch_switch_silent_re_reset_skipped_when_dirty() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();

    let r = workspaces::update_intended_target_branch_local(&harness.workspace_id, "dev").unwrap();
    let post_reset_sha = r.post_reset_sha.unwrap();

    harness.dirty_tracked_file();
    harness.upstream_advance("dev", "newdev.txt", "fresh", "advance dev");

    let re_reset =
        workspaces::refresh_remote_and_realign(&harness.workspace_id, "dev", &post_reset_sha)
            .unwrap();

    assert!(
        !re_reset,
        "dirty worktree must veto the silent re-reset, no matter what"
    );
    assert_eq!(
        harness.workspace_head(),
        post_reset_sha,
        "HEAD must NOT have moved — user's edits would be at risk"
    );
    let readme = fs::read_to_string(harness.workspace_dir().join("README.md")).unwrap();
    assert_eq!(readme, "user edits");
}

#[test]
fn branch_switch_silent_re_reset_skipped_when_head_moved() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();

    let r = workspaces::update_intended_target_branch_local(&harness.workspace_id, "dev").unwrap();
    let post_reset_sha = r.post_reset_sha.unwrap();

    harness.commit_in_workspace("user.txt", "user content", "user commit");
    let head_after_commit = harness.workspace_head();
    assert_ne!(head_after_commit, post_reset_sha);

    harness.upstream_advance("dev", "newdev.txt", "fresh", "advance dev");

    let re_reset =
        workspaces::refresh_remote_and_realign(&harness.workspace_id, "dev", &post_reset_sha)
            .unwrap();

    assert!(
        !re_reset,
        "HEAD moved away from post_reset_sha → veto re-reset"
    );
    assert_eq!(
        harness.workspace_head(),
        head_after_commit,
        "user's commit must be preserved untouched"
    );
}

#[test]
fn prefetch_remote_refs_rate_limit() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();

    let first = workspaces::prefetch_remote_refs(Some(&harness.workspace_id), None).unwrap();
    assert!(first.fetched, "first call should perform a real fetch");

    let second = workspaces::prefetch_remote_refs(Some(&harness.workspace_id), None).unwrap();
    assert!(
        !second.fetched,
        "back-to-back call within the 10s window must be suppressed"
    );

    workspaces::_reset_prefetch_rate_limit();
    let third = workspaces::prefetch_remote_refs(Some(&harness.workspace_id), None).unwrap();
    assert!(third.fetched, "rate limiter should re-enable after reset");
}

#[test]
fn sync_workspace_target_branch_reports_already_up_to_date() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();

    let result = workspaces::sync_workspace_with_target_branch(&harness.workspace_id).unwrap();

    assert_eq!(
        result.outcome,
        workspaces::SyncWorkspaceTargetOutcome::AlreadyUpToDate
    );
    assert_eq!(result.target_branch, "main");
    assert!(result.conflicted_files.is_empty());
}

#[test]
fn sync_workspace_target_branch_merges_latest_target() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    harness.commit_in_workspace("feature.txt", "local work", "local commit");
    harness.upstream_advance("main", "main2.txt", "fresh", "advance main");

    let result = workspaces::sync_workspace_with_target_branch(&harness.workspace_id).unwrap();

    assert_eq!(
        result.outcome,
        workspaces::SyncWorkspaceTargetOutcome::Updated
    );
    assert!(result.conflicted_files.is_empty());
    let merged_main = fs::read_to_string(harness.workspace_dir().join("main2.txt")).unwrap();
    let merged_feature = fs::read_to_string(harness.workspace_dir().join("feature.txt")).unwrap();
    assert_eq!(merged_main, "fresh");
    assert_eq!(merged_feature, "local work");
}

#[test]
fn sync_workspace_target_branch_reports_conflict() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    harness.commit_in_workspace("README.md", "workspace change", "workspace change");
    harness.upstream_advance("main", "README.md", "upstream change", "advance readme");

    let result = workspaces::sync_workspace_with_target_branch(&harness.workspace_id).unwrap();

    assert_eq!(
        result.outcome,
        workspaces::SyncWorkspaceTargetOutcome::Conflict
    );
    assert_eq!(result.conflicted_files, vec!["README.md".to_string()]);
    let status =
        git_ops::workspace_action_status(&harness.workspace_dir(), Some("origin"), Some("main"))
            .unwrap();
    assert!(
        status.conflict_count == 0,
        "preflight conflicts must not dirty the real workspace"
    );
}

#[test]
fn sync_workspace_target_branch_dirty_unrelated_change_pulls_and_preserves_dirty() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    harness.dirty_tracked_file(); // README.md = "user edits"
    harness.upstream_advance("main", "main2.txt", "fresh", "advance main");

    let result = workspaces::sync_workspace_with_target_branch(&harness.workspace_id).unwrap();

    assert_eq!(
        result.outcome,
        workspaces::SyncWorkspaceTargetOutcome::Updated
    );
    assert!(result.conflicted_files.is_empty());
    let merged = fs::read_to_string(harness.workspace_dir().join("main2.txt")).unwrap();
    assert_eq!(merged, "fresh", "target's commit must land in workspace");
    let dirty_readme = fs::read_to_string(harness.workspace_dir().join("README.md")).unwrap();
    assert_eq!(
        dirty_readme, "user edits",
        "uncommitted edits must survive the stash + merge + pop dance"
    );
    let status =
        git_ops::workspace_action_status(&harness.workspace_dir(), Some("origin"), Some("main"))
            .unwrap();
    assert_eq!(status.conflict_count, 0);
    assert_eq!(
        status.uncommitted_count, 1,
        "dirty README.md should remain uncommitted after pull"
    );
}

#[test]
fn sync_workspace_target_branch_dirty_with_overlapping_change_returns_conflict() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    // Workspace HEAD diverges (committed change) AND has uncommitted edits.
    harness.commit_in_workspace("README.md", "workspace change", "workspace change");
    harness.add_untracked_file();
    harness.upstream_advance("main", "README.md", "upstream change", "advance readme");

    let result = workspaces::sync_workspace_with_target_branch(&harness.workspace_id).unwrap();

    assert_eq!(
        result.outcome,
        workspaces::SyncWorkspaceTargetOutcome::Conflict
    );
    assert_eq!(result.conflicted_files, vec!["README.md".to_string()]);
    // Preflight catches the conflict before we touch the worktree, so the
    // user's untracked scratchpad must still be there.
    assert!(harness.workspace_dir().join("scratch.txt").exists());
    let status =
        git_ops::workspace_action_status(&harness.workspace_dir(), Some("origin"), Some("main"))
            .unwrap();
    assert_eq!(
        status.conflict_count, 0,
        "preflight conflicts must not dirty the real workspace"
    );
}

#[test]
fn sync_workspace_target_branch_stash_pop_conflict_reports_outcome() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    // HEAD is clean (preflight will be clean), but the worktree has
    // uncommitted edits to README.md and the upstream commits a competing
    // change to the same file. Pop will conflict after merge succeeds.
    harness.dirty_tracked_file(); // README.md = "user edits" (uncommitted)
    harness.upstream_advance("main", "README.md", "upstream rewrite", "rewrite readme");

    let result = workspaces::sync_workspace_with_target_branch(&harness.workspace_id).unwrap();

    assert_eq!(
        result.outcome,
        workspaces::SyncWorkspaceTargetOutcome::StashPopConflict
    );
    assert!(result.conflicted_files.is_empty());
    let status =
        git_ops::workspace_action_status(&harness.workspace_dir(), Some("origin"), Some("main"))
            .unwrap();
    assert!(
        status.conflict_count > 0,
        "stash pop conflict should leave unmerged paths in the worktree"
    );
}

#[test]
fn push_workspace_to_remote_publishes_unpublished_branch() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();

    let result = workspaces::push_workspace_to_remote(&harness.workspace_id).unwrap();

    assert_eq!(result.target_ref, "origin/test/switch-branch");
    assert_eq!(result.head_commit, harness.workspace_head());
    assert!(
        git_ops::verify_remote_ref_exists(&harness.workspace_dir(), "origin", "test/switch-branch")
            .unwrap(),
        "push should create the same-name remote branch"
    );
    let status =
        git_ops::workspace_action_status(&harness.workspace_dir(), Some("origin"), Some("main"))
            .unwrap();
    assert_eq!(
        status.remote_tracking_ref.as_deref(),
        Some("origin/test/switch-branch")
    );
    assert_eq!(status.push_status, git_ops::WorkspacePushStatus::Published);
}

#[test]
fn push_workspace_to_remote_updates_existing_remote_branch() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    workspaces::push_workspace_to_remote(&harness.workspace_id).unwrap();
    harness.commit_in_workspace("push.txt", "second push", "second push");

    let result = workspaces::push_workspace_to_remote(&harness.workspace_id).unwrap();

    assert_eq!(result.target_ref, "origin/test/switch-branch");
    assert_eq!(result.head_commit, harness.workspace_head());
    assert_eq!(
        git_ops::remote_ref_sha(&harness.workspace_dir(), "origin", "test/switch-branch").unwrap(),
        harness.workspace_head()
    );
}

#[test]
fn push_workspace_to_remote_allows_uncommitted_changes() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    workspaces::push_workspace_to_remote(&harness.workspace_id).unwrap();
    harness.commit_in_workspace("push.txt", "second push", "second push");
    harness.dirty_tracked_file();

    let result = workspaces::push_workspace_to_remote(&harness.workspace_id).unwrap();

    assert_eq!(result.target_ref, "origin/test/switch-branch");
    assert_eq!(result.head_commit, harness.workspace_head());
    assert_eq!(
        git_ops::remote_ref_sha(&harness.workspace_dir(), "origin", "test/switch-branch").unwrap(),
        harness.workspace_head()
    );
    let readme = fs::read_to_string(harness.workspace_dir().join("README.md")).unwrap();
    assert_eq!(readme, "user edits");
}

#[test]
fn continue_workspace_detaches_from_old_pr_branch() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    let workspace_dir = harness.workspace_dir();
    let old_branch = git_ops::current_branch_name(&workspace_dir).unwrap();
    git_ops::run_git(
        [
            "-C",
            workspace_dir.to_str().unwrap(),
            "push",
            "--set-upstream",
            "origin",
            "HEAD:refs/heads/test/switch-branch",
        ],
        None,
    )
    .unwrap();
    let old_upstream = git_ops::run_git(
        [
            "-C",
            workspace_dir.to_str().unwrap(),
            "rev-parse",
            "--abbrev-ref",
            &format!("{old_branch}@{{upstream}}"),
        ],
        None,
    )
    .unwrap();

    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    connection
        .execute(
            "UPDATE workspaces SET status = 'done', pr_sync_state = 'merged', pr_title = 'Old merged PR', pr_url = 'https://github.com/acme/widgets/pull/7' WHERE id = ?1",
            [&harness.workspace_id],
        )
        .unwrap();

    let result = workspaces::continue_workspace_from_target_branch(&harness.workspace_id).unwrap();

    assert_eq!(result.branch, "branch-switch-ws");
    assert_eq!(
        git_ops::current_branch_name(&workspace_dir).unwrap(),
        result.branch
    );
    assert_eq!(
        harness.workspace_head(),
        harness.workspace_remote_ref_sha("main")
    );
    assert!(
        git_ops::run_git(
            [
                "-C",
                workspace_dir.to_str().unwrap(),
                "rev-parse",
                "--verify",
                &format!("refs/heads/{old_branch}"),
            ],
            None,
        )
        .is_ok(),
        "old PR branch should remain as a local branch"
    );
    assert_eq!(
        git_ops::run_git(
            [
                "-C",
                workspace_dir.to_str().unwrap(),
                "rev-parse",
                "--abbrev-ref",
                &format!("{old_branch}@{{upstream}}"),
            ],
            None,
        )
        .unwrap(),
        old_upstream
    );

    let (stored_branch, status, pr_sync_state, pr_title, pr_url): (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT branch, status, pr_sync_state, pr_title, pr_url FROM workspaces WHERE id = ?1",
            [&harness.workspace_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(stored_branch, result.branch);
    assert_eq!(status, "in-progress");
    assert_eq!(pr_sync_state, "none");
    // Continue resets the PR snapshot so the optimistic header doesn't show
    // the old (now-irrelevant) PR badge on the next visit.
    assert_eq!(pr_title, None);
    assert_eq!(pr_url, None);
}

#[test]
fn continue_workspace_carries_uncommitted_changes() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    let workspace_dir = harness.workspace_dir();
    harness.dirty_tracked_file();
    harness.add_untracked_file();

    let result = workspaces::continue_workspace_from_target_branch(&harness.workspace_id).unwrap();

    assert_eq!(result.branch, "branch-switch-ws");
    assert_eq!(
        git_ops::current_branch_name(&workspace_dir).unwrap(),
        result.branch
    );
    assert_eq!(
        fs::read_to_string(workspace_dir.join("README.md")).unwrap(),
        "user edits"
    );
    assert_eq!(
        fs::read_to_string(workspace_dir.join("scratch.txt")).unwrap(),
        "scratchpad"
    );
    let status = git_ops::run_git(
        [
            "-C",
            workspace_dir.to_str().unwrap(),
            "status",
            "--porcelain",
        ],
        None,
    )
    .unwrap();
    assert!(status.contains("M README.md"), "{status}");
    assert!(status.contains("?? scratch.txt"), "{status}");
}

#[test]
fn continue_workspace_reports_conflicting_local_changes() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    let workspace_dir = harness.workspace_dir();
    let old_branch = git_ops::current_branch_name(&workspace_dir).unwrap();
    git_ops::run_git(
        [
            "-C",
            harness.source_repo.to_str().unwrap(),
            "checkout",
            "-b",
            "conflict-target",
            "origin/main",
        ],
        None,
    )
    .unwrap();
    fs::write(harness.source_repo.join("README.md"), "target edits").unwrap();
    git_ops::run_git(
        [
            "-C",
            harness.source_repo.to_str().unwrap(),
            "add",
            "README.md",
        ],
        None,
    )
    .unwrap();
    git_ops::run_git(
        [
            "-C",
            harness.source_repo.to_str().unwrap(),
            "commit",
            "-m",
            "target edits",
        ],
        None,
    )
    .unwrap();
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    connection
        .execute(
            "UPDATE workspaces SET intended_target_branch = 'conflict-target' WHERE id = ?1",
            [&harness.workspace_id],
        )
        .unwrap();
    harness.dirty_tracked_file();

    let error = workspaces::continue_workspace_from_target_branch(&harness.workspace_id)
        .expect_err("conflicting local edits should block continue");

    assert!(
        error
            .to_string()
            .contains("could not move your local changes onto the target branch"),
        "{error:?}"
    );
    assert_eq!(
        git_ops::current_branch_name(&workspace_dir).unwrap(),
        old_branch
    );
}

#[test]
fn continue_workspace_uses_version_suffix_when_default_branch_taken() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    git_ops::run_git(
        [
            "-C",
            harness.source_repo.to_str().unwrap(),
            "branch",
            "branch-switch-ws",
            "origin/main",
        ],
        None,
    )
    .unwrap();

    let result = workspaces::continue_workspace_from_target_branch(&harness.workspace_id).unwrap();

    assert_eq!(result.branch, "branch-switch-ws-v1");
}

#[test]
fn continue_workspace_rolls_back_branch_when_db_update_fails() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    let workspace_dir = harness.workspace_dir();
    let old_branch = git_ops::current_branch_name(&workspace_dir).unwrap();
    let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
    connection
        .execute_batch(
            r#"
            CREATE TRIGGER fail_continue_update
            BEFORE UPDATE OF branch ON workspaces
            WHEN NEW.id = 'branch-switch-1'
            BEGIN
                SELECT RAISE(FAIL, 'continue update failed');
            END;
            "#,
        )
        .unwrap();

    let error = workspaces::continue_workspace_from_target_branch(&harness.workspace_id)
        .expect_err("DB failure should fail continue");

    assert!(
        error.to_string().contains("persist continued workspace"),
        "{error:?}"
    );
    assert_eq!(
        git_ops::current_branch_name(&workspace_dir).unwrap(),
        old_branch
    );
    assert!(
        git_ops::run_git(
            [
                "-C",
                workspace_dir.to_str().unwrap(),
                "rev-parse",
                "--verify",
                "refs/heads/branch-switch-ws",
            ],
            None,
        )
        .is_err(),
        "continued branch should be removed after rollback"
    );
}

#[test]
fn push_workspace_to_remote_preserves_existing_different_upstream() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    git_ops::run_git(
        [
            "-C",
            harness.workspace_dir().to_str().unwrap(),
            "push",
            "--set-upstream",
            "origin",
            "HEAD:refs/heads/test/custom-remote-branch",
        ],
        None,
    )
    .unwrap();
    harness.commit_in_workspace("push.txt", "second push", "second push");

    let result = workspaces::push_workspace_to_remote(&harness.workspace_id).unwrap();

    assert_eq!(result.target_ref, "origin/test/custom-remote-branch");
    assert_eq!(result.head_commit, harness.workspace_head());
    let status =
        git_ops::workspace_action_status(&harness.workspace_dir(), Some("origin"), Some("main"))
            .unwrap();
    assert_eq!(
        status.remote_tracking_ref.as_deref(),
        Some("origin/test/custom-remote-branch")
    );
    assert_eq!(
        git_ops::remote_ref_sha(
            &harness.workspace_dir(),
            "origin",
            "test/custom-remote-branch"
        )
        .unwrap(),
        harness.workspace_head()
    );
    assert!(
        !git_ops::verify_remote_ref_exists(
            &harness.workspace_dir(),
            "origin",
            "test/switch-branch"
        )
        .unwrap(),
        "push should keep using the configured upstream instead of creating a same-name branch"
    );
}
