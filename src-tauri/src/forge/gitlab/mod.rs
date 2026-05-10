//! GitLab backend — mirrors the GitHub GraphQL surface using `glab api …`
//! (REST + OAuth via the glab CLI, no in-process HTTP client needed).
//!
//! Layout:
//!
//! - [`types`] — serde DTOs (MR / pipeline / job / approvals).
//! - [`api`] — `glab api` argv wrapper + URL encoding + error-shape
//!   sniffing. Every other module runs its calls through here.
//! - [`context`] — `GitlabContext` + workspace → context loader.
//! - [`merge_request`] — find / transform / merge-state for the MR tied
//!   to the current workspace branch.
//! - [`pipeline`] — pipeline & job loading plus the `checks` row
//!   formatting used by the inspector.
//! - [`review`] — approvals → neutral `reviewDecision` string.
//!
//! The pub(super) entry points below (`lookup_workspace_mr`,
//! `merge_workspace_mr`, etc.) are what `forge::workspace` routes to when
//! the provider is `Gitlab`.

use anyhow::{bail, Context, Result};

use crate::error::ErrorCode;

use super::types::{
    ActionProvider, ActionStatusKind, ChangeRequestInfo, ForgeActionItem, ForgeActionStatus,
    RemoteState,
};

pub(super) mod accounts;
mod api;
mod context;
pub(super) mod inbox;
mod merge_request;
mod pipeline;
mod review;
mod types;

use self::api::{command_detail, encode_path_component, glab_api, looks_like_auth_error};
use self::context::{load_gitlab_context, GitlabContext, GitlabResolution};
use self::merge_request::{
    determine_squash_choice, find_workspace_mr, gitlab_mergeable, mr_info, SquashChoice,
};
use self::pipeline::{
    build_gitlab_check_insert_text, load_job_trace, load_pipeline_jobs, pipeline_item,
};
use self::review::load_review_decision;

pub(super) fn lookup_workspace_mr(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let context = match load_gitlab_context(workspace_id)? {
        GitlabResolution::Ready(ctx) if ctx.published => ctx,
        // Lookup paths degrade non-Ready/unpublished to "no MR" — the
        // primary auth surface is the action-status path.
        _ => return Ok(None),
    };
    let mr = match find_workspace_mr(&context) {
        Ok(Some(mr)) => mr,
        Ok(None) => return Ok(None),
        Err(error) => {
            let message = format!("{error:#}");
            if looks_like_auth_error(&message) {
                tracing::warn!(
                    workspace_id,
                    host = %context.remote.host,
                    error = %message,
                    "GitLab MR lookup requires authentication"
                );
                return Ok(None);
            }
            return Err(error);
        }
    };
    Ok(Some(mr_info(&mr)))
}

pub(super) fn lookup_workspace_mr_action_status(workspace_id: &str) -> Result<ForgeActionStatus> {
    let context = match load_gitlab_context(workspace_id)? {
        GitlabResolution::Ready(ctx) => ctx,
        GitlabResolution::Initializing => return Ok(ForgeActionStatus::no_change_request()),
        GitlabResolution::Unavailable(message) => {
            return Ok(ForgeActionStatus::unavailable(message));
        }
        GitlabResolution::Unauthenticated => {
            return Ok(ForgeActionStatus::unauthenticated(
                "GitLab account is not connected for this repository",
            ));
        }
    };

    // Auth probe runs BEFORE the published short-circuit so an
    // unpublished workspace whose bound login was logged out still
    // surfaces Connect. Only `LoggedOut` (definitive) flips the CTA;
    // `Indeterminate` falls through and lets the API call try.
    if gitlab_login_definitely_logged_out(&context) {
        tracing::warn!(
            workspace_id,
            host = %context.remote.host,
            login = %context.login,
            "glab account no longer logged in; reporting unauthenticated"
        );
        return Ok(ForgeActionStatus::unauthenticated(format!(
            "Not connected to GitLab on {}",
            context.remote.host
        )));
    }

    if !context.published {
        return Ok(ForgeActionStatus::no_change_request());
    }

    let mr = match find_workspace_mr(&context) {
        Ok(Some(mr)) => mr,
        Ok(None) => return Ok(ForgeActionStatus::no_change_request()),
        Err(error) => {
            let message = format!("{error:#}");
            if looks_like_auth_error(&message) {
                tracing::warn!(
                    workspace_id,
                    host = %context.remote.host,
                    error = %message,
                    "GitLab MR lookup requires authentication"
                );
                return Ok(ForgeActionStatus::unauthenticated(message));
            }
            tracing::warn!(
                workspace_id,
                host = %context.remote.host,
                error = %message,
                "GitLab MR lookup failed"
            );
            return Ok(ForgeActionStatus::error(message));
        }
    };

    let checks = match mr
        .head_pipeline
        .as_ref()
        .and_then(|pipeline| pipeline.id)
        .map(|pipeline_id| load_pipeline_jobs(&context, pipeline_id))
        .transpose()
    {
        Ok(Some(items)) if !items.is_empty() => items,
        Ok(_) => mr
            .head_pipeline
            .as_ref()
            .map(|pipeline| vec![pipeline_item(pipeline)])
            .unwrap_or_default(),
        Err(error) => {
            let message = format!("{error:#}");
            if looks_like_auth_error(&message) {
                tracing::warn!(
                    workspace_id,
                    host = %context.remote.host,
                    error = %message,
                    "GitLab pipeline job lookup requires authentication"
                );
                return Ok(ForgeActionStatus::unauthenticated(message));
            }
            tracing::warn!(
                workspace_id,
                host = %context.remote.host,
                error = %message,
                "GitLab pipeline job lookup failed"
            );
            vec![ForgeActionItem {
                id: "gitlab-pipeline-jobs".to_string(),
                name: format!("Unable to load pipeline jobs: {message}"),
                provider: ActionProvider::Gitlab,
                status: ActionStatusKind::Failure,
                duration: None,
                url: mr
                    .head_pipeline
                    .as_ref()
                    .and_then(|pipeline| pipeline.web_url.clone()),
            }]
        }
    };
    let review_decision = match load_review_decision(&context, mr.iid) {
        Ok(decision) => decision,
        Err(error) => {
            tracing::warn!(
                workspace_id,
                host = %context.remote.host,
                iid = mr.iid,
                error = %error,
                "GitLab review decision lookup failed"
            );
            None
        }
    };

    Ok(ForgeActionStatus {
        change_request: Some(mr_info(&mr)),
        review_decision,
        mergeable: gitlab_mergeable(&mr),
        deployments: Vec::new(),
        checks,
        remote_state: RemoteState::Ok,
        message: None,
    })
}

pub(super) fn lookup_workspace_mr_check_insert_text(
    workspace_id: &str,
    item_id: &str,
) -> Result<String> {
    let context = match load_gitlab_context(workspace_id)? {
        GitlabResolution::Ready(ctx) if ctx.published => ctx,
        GitlabResolution::Ready(_) | GitlabResolution::Initializing => {
            bail!("Workspace branch is not published");
        }
        GitlabResolution::Unavailable(message) => bail!("{message}"),
        GitlabResolution::Unauthenticated => crate::bail_coded!(
            ErrorCode::ForgeOnboarding,
            "GitLab account is not connected for this repository"
        ),
    };
    let status = lookup_workspace_mr_action_status(workspace_id)?;
    let item = status
        .checks
        .into_iter()
        .find(|check| check.id == item_id)
        .with_context(|| format!("Check item not found: {item_id}"))?;

    let trace = item_id
        .strip_prefix("gitlab-job-")
        .and_then(|value| value.parse::<i64>().ok())
        .map(|job_id| load_job_trace(&context, job_id))
        .transpose()?
        .flatten();

    Ok(build_gitlab_check_insert_text(&item, trace.as_deref()))
}

pub(super) fn merge_workspace_mr(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let Some(context) = mutation_context(workspace_id, "merge")? else {
        return Ok(None);
    };
    ensure_gitlab_cli_ready(&context, "merge")?;
    let Some(mr) = find_workspace_mr(&context)? else {
        return Ok(None);
    };
    if mr.state != "opened" {
        bail!("MR !{} is not open (state: {})", mr.iid, mr.state);
    }

    let endpoint = format!(
        "projects/{}/merge_requests/{}/merge",
        encode_path_component(&context.full_path),
        mr.iid
    );
    let squash = determine_squash_choice(&context);
    let mut args: Vec<&str> = vec!["--method", "PUT", endpoint.as_str()];
    if matches!(squash, SquashChoice::Squash) {
        args.extend(["--field", "squash=true"]);
    }
    let output = glab_api(&context.remote.host, args)?;
    if !output.success {
        let detail = command_detail(&output);
        tracing::warn!(
            workspace_id,
            host = %context.remote.host,
            iid = mr.iid,
            detail = %detail,
            squash = ?squash,
            "GitLab MR merge API failed"
        );
        bail!("GitLab MR merge failed: {detail}");
    }

    tracing::info!(
        workspace_id,
        host = %context.remote.host,
        iid = mr.iid,
        "GitLab MR merged"
    );
    lookup_workspace_mr(workspace_id)
}

pub(super) fn close_workspace_mr(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let Some(context) = mutation_context(workspace_id, "close")? else {
        return Ok(None);
    };
    ensure_gitlab_cli_ready(&context, "close")?;
    let Some(mr) = find_workspace_mr(&context)? else {
        return Ok(None);
    };
    if mr.state != "opened" {
        bail!("MR !{} is not open (state: {})", mr.iid, mr.state);
    }

    let endpoint = format!(
        "projects/{}/merge_requests/{}",
        encode_path_component(&context.full_path),
        mr.iid
    );
    let output = glab_api(
        &context.remote.host,
        [
            "--method",
            "PUT",
            endpoint.as_str(),
            "--field",
            "state_event=close",
        ],
    )?;
    if !output.success {
        let detail = command_detail(&output);
        tracing::warn!(
            workspace_id,
            host = %context.remote.host,
            iid = mr.iid,
            detail = %detail,
            "GitLab MR close API failed"
        );
        bail!("GitLab MR close failed: {detail}");
    }

    tracing::info!(
        workspace_id,
        host = %context.remote.host,
        iid = mr.iid,
        "GitLab MR closed"
    );
    lookup_workspace_mr(workspace_id)
}

/// Common entry for the merge / close paths. `Ok(None)` means
/// "preconditions not met" (caller short-circuits with `Ok(None)`).
/// Mirrors `forge::github::mod::mutation_context`.
fn mutation_context(workspace_id: &str, operation: &'static str) -> Result<Option<GitlabContext>> {
    match load_gitlab_context(workspace_id)? {
        GitlabResolution::Ready(ctx) if ctx.published => {
            tracing::info!(
                workspace_id,
                host = %ctx.remote.host,
                full_path = %ctx.full_path,
                branch = %ctx.branch,
                operation,
                "GitLab MR mutation requested"
            );
            Ok(Some(ctx))
        }
        _ => Ok(None),
    }
}

/// Bail with a `ForgeOnboarding` error only when `check_auth` is
/// definitively `LoggedOut`. `Indeterminate` falls through so the
/// actual API call gets a chance — transient glab hiccups don't block
/// a legitimate merge.
fn ensure_gitlab_cli_ready(context: &GitlabContext, operation: &str) -> Result<()> {
    use crate::forge::accounts;
    use crate::forge::types::ForgeProvider;

    let backend = accounts::backend_for(ForgeProvider::Gitlab).context("GitLab backend missing")?;
    if backend
        .check_auth(&context.remote.host, &context.login)
        .is_definitely_logged_out()
    {
        let host = &context.remote.host;
        tracing::warn!(host = %host, operation, login = %context.login, "GitLab CLI unauthenticated");
        crate::bail_coded!(
            ErrorCode::ForgeOnboarding,
            "GitLab CLI authentication required for {host}. Run `glab auth login --hostname {host}` to connect."
        );
    }
    Ok(())
}

/// Routes through `check_auth`; `Indeterminate` and `LoggedIn`
/// preserve the binding.
fn gitlab_login_definitely_logged_out(context: &GitlabContext) -> bool {
    let Some(backend) = crate::forge::accounts::backend_for(crate::forge::ForgeProvider::Gitlab)
    else {
        return false;
    };
    backend
        .check_auth(&context.remote.host, &context.login)
        .is_definitely_logged_out()
}
