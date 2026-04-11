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
