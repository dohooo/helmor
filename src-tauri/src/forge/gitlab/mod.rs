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
mod merge_request;
mod pipeline;
mod review;
mod types;

use self::api::{command_detail, encode_path_component, glab_api, looks_like_auth_error};
use self::context::load_gitlab_context;
use self::merge_request::{find_workspace_mr, gitlab_mergeable, mr_info};
use self::pipeline::{
    build_gitlab_check_insert_text, load_job_trace, load_pipeline_jobs, pipeline_item,
};
use self::review::load_review_decision;

pub(super) fn lookup_workspace_mr(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let context = load_gitlab_context(workspace_id)?;
    tracing::debug!(
        workspace_id,
        host = %context.remote.host,
        full_path = %context.full_path,
        branch = %context.branch,
        published = context.published,
        "Looking up GitLab MR"
    );
    if !context.published {
        return Ok(None);
    }
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
    let context = match load_gitlab_context(workspace_id) {
        Ok(context) => {
            tracing::debug!(
                workspace_id,
                host = %context.remote.host,
                full_path = %context.full_path,
                branch = %context.branch,
                published = context.published,
                "Looking up GitLab MR action status"
            );
            context
        }
        Err(error) => {
            tracing::warn!(workspace_id, error = %error, "GitLab context lookup failed");
            return Ok(ForgeActionStatus::unavailable(format!("{error:#}")));
        }
    };

    // Host-level liveness check runs FIRST — even before the published
    // short-circuit. Otherwise an unpublished GitLab workspace (no
    // remote-tracking branch, no MR) would always return
    // `no_change_request` and the inspector would never surface a
    // Connect CTA, even after the user logs out of glab. We want
    // `unauthenticated` to win so the user sees they need to reconnect
    // before anything else can happen.
    //
    // Mirrors the GitHub side, where `token_for_user_on_host`'s
    // `is_login_in_hosts` guard plays the same role on every API call.
    if let Some(backend) = crate::forge::accounts::backend_for(crate::forge::ForgeProvider::Gitlab)
    {
        match backend.list_logins(&context.remote.host) {
            Ok(logins) if logins.is_empty() => {
                tracing::warn!(
                    workspace_id,
                    host = %context.remote.host,
                    "No glab account on host; reporting unauthenticated"
                );
                return Ok(ForgeActionStatus::unauthenticated(format!(
                    "Not connected to GitLab on {}",
                    context.remote.host
                )));
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(
                    workspace_id,
                    host = %context.remote.host,
                    error = %format!("{error:#}"),
                    "Failed to probe glab logins; falling through to API call"
                );
            }
        }
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
    let context = load_gitlab_context(workspace_id)?;
    if !context.published {
        bail!("Workspace branch is not published");
    }
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
    let context = load_gitlab_context(workspace_id)?;
    tracing::info!(
        workspace_id,
        host = %context.remote.host,
        full_path = %context.full_path,
        branch = %context.branch,
        "GitLab MR merge requested"
    );
    if !context.published {
        return Ok(None);
    }
    ensure_gitlab_cli_ready(&context.remote.host, "merge")?;
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
    let output = glab_api(&context.remote.host, ["--method", "PUT", endpoint.as_str()])?;
    if !output.success {
        let detail = command_detail(&output);
        tracing::warn!(
            workspace_id,
            host = %context.remote.host,
            iid = mr.iid,
            detail = %detail,
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
    let context = load_gitlab_context(workspace_id)?;
    tracing::info!(
        workspace_id,
        host = %context.remote.host,
        full_path = %context.full_path,
        branch = %context.branch,
        "GitLab MR close requested"
    );
    if !context.published {
        return Ok(None);
    }
    ensure_gitlab_cli_ready(&context.remote.host, "close")?;
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

/// Pre-check before mutating MR state (merge / close): the host must
/// have at least one logged-in glab account. Multi-account aware via
/// the shared accounts module — single source of truth for "is this
/// host authenticated".
fn ensure_gitlab_cli_ready(host: &str, operation: &str) -> Result<()> {
    use crate::forge::accounts;
    use crate::forge::types::ForgeProvider;

    let backend = accounts::backend_for(ForgeProvider::Gitlab).context("GitLab backend missing")?;
    let logins = backend
        .list_logins(host)
        .with_context(|| format!("Failed to probe `glab auth status --hostname {host}`"))?;
    if logins.is_empty() {
        tracing::warn!(host, operation, "GitLab CLI unauthenticated");
        crate::bail_coded!(
            ErrorCode::ForgeOnboarding,
            "GitLab CLI authentication required for {host}. Run `glab auth login --hostname {host}` to connect."
        );
    }
    tracing::debug!(host, operation, login = %logins[0], "GitLab CLI auth ready");
    Ok(())
}
