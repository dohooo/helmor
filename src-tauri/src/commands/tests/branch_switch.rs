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
        err.to_string().contains("not in ready state"),
        "expected 'not in ready state' error, got: {err}"
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
fn sync_workspace_target_branch_reports_dirty_worktree_without_error() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let harness = BranchSwitchTestHarness::new();
    harness.dirty_tracked_file();
    harness.upstream_advance("main", "main2.txt", "fresh", "advance main");

    let result = workspaces::sync_workspace_with_target_branch(&harness.workspace_id).unwrap();

    assert_eq!(
        result.outcome,
        workspaces::SyncWorkspaceTargetOutcome::DirtyWorktree
    );
    assert!(result.conflicted_files.is_empty());
    assert_eq!(
        harness.workspace_head(),
        harness.workspace_remote_ref_sha("main")
    );
    let status =
        git_ops::workspace_action_status(&harness.workspace_dir(), Some("origin"), Some("main"))
            .unwrap();
    assert_eq!(status.conflict_count, 0);
    assert_eq!(status.uncommitted_count, 1);
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
