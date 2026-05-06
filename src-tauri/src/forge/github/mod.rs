//! GitHub backend — mirrors the GitLab module layout (`api`, `context`,
//! `pull_request`, `actions`, `types`, `accounts`). Public entry points
//! are the workspace-scoped `lookup_workspace_pr` /
//! `lookup_workspace_pr_action_status` / etc. functions consumed by
//! [`crate::forge::workspace`] and the `helmor github pr` CLI.
//!
//! Auth flow:
//!
//! - Multi-account: every API call routes through
//!   `accounts::run_cli_with_login`, which sets `GH_TOKEN` per-spawn so
//!   we never mutate gh's "active account" pointer.
//! - Logout detection: the action-status path runs a `list_logins`
//!   probe BEFORE the published-branch short-circuit, mirroring the
//!   GitLab pre-flight. That way an unpublished workspace whose bound
//!   account has been logged out still surfaces the inspector
//!   "Connect" CTA — instead of getting stuck at `no_change_request`.

use anyhow::{bail, Context, Result};

use crate::error::ErrorCode;
use crate::forge::ChangeRequestInfo;
use crate::forge::ForgeActionStatus;

pub mod accounts;
mod actions;
mod api;
mod context;
pub mod inbox;
mod pull_request;
mod types;

use self::actions::{
    build_check_insert_text, query_check_run_detail, query_workspace_pr_action_status,
};
use self::context::{load_github_context, GithubContext, GithubResolution, HostAuthCheck};
use self::pull_request::{
    close_pull_request, fetch_open_pr_node_id, find_workspace_pr, merge_pull_request,
};

/// Look up the (most recent) pull request matching this workspace's
/// current branch on GitHub.
///
/// Returns:
///   - `Ok(Some(pr))` when a PR is found for `headRefName == branch`.
///   - `Ok(None)` when there's no matching PR, when the workspace has
///     no github.com remote, when the repo has no bound forge account,
///     or when the bound account no longer has access.
///   - `Err(_)` only for unexpected transport / parse failures (so the
///     caller can surface a distinct "something went wrong" state).
pub fn lookup_workspace_pr(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let context = match load_github_context(workspace_id, HostAuthCheck::Skip)? {
        GithubResolution::Ready(ctx) if ctx.has_remote_tracking => ctx,
        // Anything else short-circuits to "no PR linked":
        //   - Initializing / unavailable / unauthenticated / no
        //     remote-tracking → caller sees `None` and renders the
        //     empty-PR state. Auth is not surfaced here because the
        //     primary auth surface is the action-status path.
        _ => return Ok(None),
    };

    find_workspace_pr(&context)
}

/// Full PR action status for the inspector Actions panel.
///
/// Missing GitHub configuration, missing forge binding, inaccessible
/// repositories, and "no PR for this branch" are all represented in
/// the returned status instead of bubbling as command errors. That
/// keeps the local Git rows usable even when remote status cannot be
/// queried.
pub fn lookup_workspace_pr_action_status(workspace_id: &str) -> Result<ForgeActionStatus> {
    let resolution = load_github_context(workspace_id, HostAuthCheck::Probe)?;
    let context = match resolution {
        GithubResolution::Ready(ctx) => ctx,
        GithubResolution::Initializing => {
            return Ok(ForgeActionStatus::no_change_request());
        }
        GithubResolution::Unavailable(message) => {
            return Ok(ForgeActionStatus::unavailable(message));
        }
        GithubResolution::Unauthenticated => {
            return Ok(ForgeActionStatus::unauthenticated(
                "GitHub account is not connected for this repository",
            ));
        }
    };

    if !context.has_remote_tracking {
        return Ok(ForgeActionStatus::no_change_request());
    }

    let status = query_workspace_pr_action_status(&context)
        .unwrap_or_else(|error| ForgeActionStatus::error(format!("{error:#}")));

    Ok(status)
}

pub fn lookup_workspace_pr_check_insert_text(workspace_id: &str, item_id: &str) -> Result<String> {
    let resolution = load_github_context(workspace_id, HostAuthCheck::Probe)?;
    let context = match resolution {
        GithubResolution::Ready(ctx) if ctx.has_remote_tracking => ctx,
        GithubResolution::Ready(_) | GithubResolution::Initializing => {
            bail!("Workspace branch is not published");
        }
        GithubResolution::Unavailable(message) => {
            bail!("{message}");
        }
        GithubResolution::Unauthenticated => {
            crate::bail_coded!(
                ErrorCode::ForgeOnboarding,
                "GitHub account is not connected for this repository"
            );
        }
    };

    let action_status = query_workspace_pr_action_status(&context)
        .context("Failed to load current PR action status")?;

    let item = action_status
        .checks
        .into_iter()
        .find(|check| check.id == item_id)
        .with_context(|| format!("Check item not found: {item_id}"))?;

    let detail = item
        .id
        .strip_prefix("check-run-")
        .and_then(|value| value.parse::<i64>().ok())
        .map(|check_run_id| {
            query_check_run_detail(&context.login, &context.owner, &context.name, check_run_id)
        })
        .transpose()
        .context("Failed to load check run details")?;

    Ok(build_check_insert_text(&item, detail.as_ref()))
}

/// Merge a workspace's open PR via the GitHub GraphQL `mergePullRequest`
/// mutation. Returns the updated `ChangeRequestInfo` on success, or
/// `None` when the PR can't be found / repo isn't bound.
pub fn merge_workspace_pr(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let pr = lookup_workspace_pr(workspace_id)?;
    let Some(pr) = pr else {
        return Ok(None);
    };
    if pr.state != "OPEN" {
        bail!("PR #{} is not open (state: {})", pr.number, pr.state);
    }
    let Some(context) = mutation_context(workspace_id)? else {
        return Ok(None);
    };
    let Some(pr_node_id) = fetch_open_pr_node_id(&context)? else {
        bail!("Could not resolve PR node ID for #{}", pr.number);
    };
    merge_pull_request(&context, &pr_node_id).context("mergePullRequest failed")?;
    lookup_workspace_pr(workspace_id)
}

/// Close a workspace's open PR via the GitHub GraphQL `closePullRequest`
/// mutation. Returns the updated `ChangeRequestInfo` on success.
pub fn close_workspace_pr(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let pr = lookup_workspace_pr(workspace_id)?;
    let Some(pr) = pr else {
        return Ok(None);
    };
    if pr.state != "OPEN" {
        bail!("PR #{} is not open (state: {})", pr.number, pr.state);
    }
    let Some(context) = mutation_context(workspace_id)? else {
        return Ok(None);
    };
    let Some(pr_node_id) = fetch_open_pr_node_id(&context)? else {
        bail!("Could not resolve PR node ID for #{}", pr.number);
    };
    close_pull_request(&context.login, &pr_node_id).context("closePullRequest failed")?;
    lookup_workspace_pr(workspace_id)
}

/// Common up-front work for the merge / close paths. `None` means
/// "preconditions not met" (caller short-circuits with `Ok(None)`).
/// Auth probing is intentionally skipped here: the lookup_workspace_pr
/// call wrapping these has already returned a PR, which means a token
/// just worked.
fn mutation_context(workspace_id: &str) -> Result<Option<GithubContext>> {
    match load_github_context(workspace_id, HostAuthCheck::Skip)? {
        GithubResolution::Ready(ctx) if ctx.has_remote_tracking => Ok(Some(ctx)),
        _ => Ok(None),
    }
}
