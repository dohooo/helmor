//! Cloud serve-mode auto-push (PR6 workflow closure).
//!
//! The CF sandbox disk is wiped on sleep, so any code the agent wrote must
//! reach the git remote before the turn ends. After a turn finalizes, this
//! commits any uncommitted work in the workspace and pushes it to `origin`.
//!
//! Gated entirely by the `HELMOR_CLOUD_AUTOPUSH` env var, which only the
//! container's boot script sets — on the desktop the env is unset, so this is
//! a hard no-op and changes no existing behavior (and never runs in tests).
//! Best-effort throughout: any failure is logged and swallowed, because a push
//! problem must never crash an agent turn.

use std::path::Path;

use crate::git_ops;

/// Env var that opts a process into post-turn auto-commit + push. Set by
/// `cloud/scripts/start-serve.sh` in the container only.
const AUTOPUSH_ENV: &str = "HELMOR_CLOUD_AUTOPUSH";
/// Remote the workspace branch is pushed to (the boot clone wires `origin`
/// with an embedded PAT so the push is non-interactive).
const DEFAULT_REMOTE: &str = "origin";

/// Whether cloud auto-push is enabled for this process.
fn enabled() -> bool {
    matches!(
        std::env::var(AUTOPUSH_ENV).ok().as_deref(),
        Some("1") | Some("true")
    )
}

/// Commit + push the workspace's uncommitted work after a finalized turn.
/// No-op (returns immediately) on the desktop. Runs on a detached thread so it
/// never blocks the streaming loop.
pub(super) fn maybe_autopush_after_turn(working_directory: &str) {
    if !enabled() {
        return;
    }
    let dir = working_directory.to_string();
    std::thread::Builder::new()
        .name("cloud-autopush".into())
        .spawn(move || {
            if let Err(error) = autopush(Path::new(&dir)) {
                tracing::warn!(
                    error = %format!("{error:#}"),
                    dir = %dir,
                    "cloud auto-push failed"
                );
            }
        })
        .ok();
}

fn autopush(workspace_dir: &Path) -> anyhow::Result<()> {
    // Nothing changed → nothing to do (the common case mid-conversation when a
    // turn only read files / answered a question).
    if git_ops::working_tree_clean(workspace_dir)? {
        return Ok(());
    }

    let dir = workspace_dir.display().to_string();

    // Stage everything (tracked + untracked).
    git_ops::run_git(["-C", dir.as_str(), "add", "-A"], None)?;

    // `git diff --cached --quiet` exits 0 when nothing is staged (e.g. all the
    // dirty paths were gitignored), non-zero otherwise. `run_git` maps a
    // non-zero exit to `Err`, so `is_ok()` here means "nothing actually
    // staged" — skip the empty commit in that case.
    let nothing_staged =
        git_ops::run_git(["-C", dir.as_str(), "diff", "--cached", "--quiet"], None).is_ok();
    if nothing_staged {
        return Ok(());
    }

    git_ops::run_git(
        [
            "-C",
            dir.as_str(),
            "commit",
            "-m",
            "helmor: auto-commit after agent turn",
        ],
        None,
    )?;

    git_ops::push_current_branch(workspace_dir, DEFAULT_REMOTE)?;
    tracing::info!(dir = %dir, "cloud auto-push: committed + pushed turn changes");
    Ok(())
}
