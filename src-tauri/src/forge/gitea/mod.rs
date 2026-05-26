use anyhow::{anyhow, bail, Context, Result};

use crate::error::ErrorCode;
use crate::forge::{
    ActionProvider, ActionStatusKind, ChangeRequestInfo, ForgeActionItem, ForgeActionStatus,
    RemoteState,
};

pub(super) mod accounts;
mod api;
mod context;
pub(super) mod inbox;
mod types;

use self::api::{command_detail, looks_like_auth_error, tea_api};
use self::context::{load_gitea_context, GiteaContext, GiteaResolution};
use self::types::{
    GiteaCombinedStatus, GiteaCommitStatus, GiteaPullRequest, GiteaPullRequestMergeability,
    GiteaWorkflowRunsResponse,
};

pub(super) fn lookup_workspace_pr(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let context = match load_gitea_context(workspace_id)? {
        GiteaResolution::Ready(ctx) if ctx.published => ctx,
        _ => return Ok(None),
    };
    Ok(find_workspace_pr(&context)?.map(pr_info))
}

pub(super) fn lookup_workspace_pr_action_status(workspace_id: &str) -> Result<ForgeActionStatus> {
    let context = match load_gitea_context(workspace_id)? {
        GiteaResolution::Ready(ctx) => ctx,
        GiteaResolution::Initializing => return Ok(ForgeActionStatus::no_change_request()),
        GiteaResolution::Unavailable(message) => {
            return Ok(ForgeActionStatus::unavailable(message))
        }
        GiteaResolution::Unauthenticated => {
            return Ok(ForgeActionStatus::unauthenticated(
                "Gitea account is not connected for this repository",
            ));
        }
    };

    if !context.published {
        return Ok(ForgeActionStatus::no_change_request());
    }

    let Some(pr) = find_workspace_pr(&context)? else {
        return Ok(ForgeActionStatus::no_change_request());
    };

    let checks = load_checks(&context, &pr).unwrap_or_default();
    let mergeability = fetch_pr_mergeability(&context, pr.number).ok();

    Ok(ForgeActionStatus {
        change_request: Some(pr_info(pr.clone())),
        review_decision: None,
        mergeable: mergeability
            .as_ref()
            .and_then(|value| value.mergeable)
            .map(|value| if value { "MERGEABLE" } else { "CONFLICTING" }.to_string()),
        merge_state_status: None,
        deployments: Vec::new(),
        checks,
        remote_state: RemoteState::Ok,
        message: None,
    })
}

pub(super) fn lookup_workspace_pr_check_insert_text(
    workspace_id: &str,
    item_id: &str,
) -> Result<String> {
    let status = lookup_workspace_pr_action_status(workspace_id)?;
    let item = status
        .checks
        .into_iter()
        .find(|check| check.id == item_id)
        .with_context(|| format!("Check item not found: {item_id}"))?;
    Ok(format!(
        "Check: {}\nProvider: Gitea\nStatus: {}{}{}",
        item.name,
        action_status_label(item.status),
        item.duration
            .as_deref()
            .map(|value| format!("\nDuration: {value}"))
            .unwrap_or_default(),
        item.url
            .as_deref()
            .map(|value| format!("\nURL: {value}"))
            .unwrap_or_default()
    ))
}

pub(super) fn merge_workspace_pr(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let Some(context) = mutation_context(workspace_id)? else {
        return Ok(None);
    };
    let Some(pr) = find_workspace_pr(&context)? else {
        return Ok(None);
    };
    let path = format!(
        "/repos/{}/{}/pulls/{}/merge",
        context.remote.namespace, context.remote.repo, pr.number
    );
    let output = tea_api(
        &context.login,
        ["-X", "POST", "-f", "do=merge", path.as_str()],
    )?;
    if !output.success {
        bail!("Gitea PR merge failed: {}", command_detail(&output));
    }
    lookup_workspace_pr(workspace_id)
}

pub(super) fn close_workspace_pr(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let Some(context) = mutation_context(workspace_id)? else {
        return Ok(None);
    };
    let Some(pr) = find_workspace_pr(&context)? else {
        return Ok(None);
    };
    let path = format!(
        "/repos/{}/{}/issues/{}",
        context.remote.namespace, context.remote.repo, pr.number
    );
    let output = tea_api(
        &context.login,
        ["-X", "PATCH", "-f", "state=closed", path.as_str()],
    )?;
    if !output.success {
        bail!("Gitea PR close failed: {}", command_detail(&output));
    }
    lookup_workspace_pr(workspace_id)
}

fn mutation_context(workspace_id: &str) -> Result<Option<GiteaContext>> {
    match load_gitea_context(workspace_id)? {
        GiteaResolution::Ready(ctx) if ctx.published => Ok(Some(ctx)),
        _ => Ok(None),
    }
}

fn find_workspace_pr(context: &GiteaContext) -> Result<Option<GiteaPullRequest>> {
    let path = format!(
        "/repos/{}/{}/pulls?state=all&limit=50",
        context.remote.namespace, context.remote.repo
    );
    let output = tea_api(&context.login, [path.as_str()])?;
    if !output.success {
        let detail = command_detail(&output);
        if looks_like_auth_error(&detail) {
            crate::bail_coded!(ErrorCode::ForgeOnboarding, "{detail}");
        }
        return Err(anyhow!("Gitea pull request lookup failed: {detail}"));
    }
    let prs = serde_json::from_str::<Vec<GiteaPullRequest>>(&output.stdout)
        .context("Failed to decode Gitea pull requests")?;
    Ok(prs.into_iter().find(|pr| {
        pr.head.as_ref().and_then(|head| head.branch_ref.as_deref())
            == Some(context.branch.as_str())
    }))
}

fn fetch_pr_mergeability(
    context: &GiteaContext,
    number: i64,
) -> Result<GiteaPullRequestMergeability> {
    let path = format!(
        "/repos/{}/{}/pulls/{}",
        context.remote.namespace, context.remote.repo, number
    );
    let output = tea_api(&context.login, [path.as_str()])?;
    if !output.success {
        bail!("Gitea PR detail lookup failed: {}", command_detail(&output));
    }
    serde_json::from_str::<GiteaPullRequestMergeability>(&output.stdout)
        .context("Failed to decode Gitea pull request mergeability")
}

fn load_checks(context: &GiteaContext, pr: &GiteaPullRequest) -> Result<Vec<ForgeActionItem>> {
    let mut checks = Vec::new();
    if let Some(sha) = pr.head.as_ref().and_then(|head| head.sha.as_deref()) {
        let runs_path = format!(
            "/repos/{}/{}/actions/runs?head_sha={}&limit=20",
            context.remote.namespace, context.remote.repo, sha
        );
        let runs_output = tea_api(&context.login, [runs_path.as_str()])?;
        if runs_output.success {
            let runs = serde_json::from_str::<GiteaWorkflowRunsResponse>(&runs_output.stdout)
                .context("Failed to decode Gitea workflow runs")?;
            for run in runs.workflow_runs {
                checks.push(ForgeActionItem {
                    id: format!("gitea-run-{}", run.id),
                    name: run
                        .display_title
                        .unwrap_or_else(|| format!("Workflow run #{}", run.id)),
                    provider: ActionProvider::Gitea,
                    status: action_status_from_run(
                        run.status.as_deref(),
                        run.conclusion.as_deref(),
                    ),
                    duration: None,
                    url: run.html_url,
                });
            }
        }

        let status_path = format!(
            "/repos/{}/{}/commits/{}/status",
            context.remote.namespace, context.remote.repo, sha
        );
        let status_output = tea_api(&context.login, [status_path.as_str()])?;
        if status_output.success {
            let combined = serde_json::from_str::<GiteaCombinedStatus>(&status_output.stdout)
                .context("Failed to decode Gitea combined status")?;
            if let Some(statuses) = combined.statuses {
                for status in statuses {
                    checks.push(status_item(status));
                }
            }
        }
    }
    Ok(checks)
}

fn status_item(status: GiteaCommitStatus) -> ForgeActionItem {
    ForgeActionItem {
        id: format!("gitea-status-{}", status.id),
        name: status
            .context
            .or(status.description)
            .unwrap_or_else(|| format!("Status {}", status.id)),
        provider: ActionProvider::Gitea,
        status: match status.status.as_str() {
            "success" | "skipped" => ActionStatusKind::Success,
            "pending" => ActionStatusKind::Pending,
            _ => ActionStatusKind::Failure,
        },
        duration: None,
        url: status.target_url,
    }
}

fn action_status_from_run(status: Option<&str>, conclusion: Option<&str>) -> ActionStatusKind {
    match (status.unwrap_or_default(), conclusion.unwrap_or_default()) {
        ("completed", "success") => ActionStatusKind::Success,
        ("completed", "skipped") => ActionStatusKind::Success,
        ("completed", _) => ActionStatusKind::Failure,
        ("queued", _) | ("pending", _) => ActionStatusKind::Pending,
        ("in_progress", _) | ("running", _) => ActionStatusKind::Running,
        _ => ActionStatusKind::Pending,
    }
}

fn pr_info(pr: GiteaPullRequest) -> ChangeRequestInfo {
    ChangeRequestInfo {
        url: pr.html_url,
        number: pr.number,
        state: if pr.merged.unwrap_or(false) {
            "MERGED".to_string()
        } else if pr.state == "open" {
            "OPEN".to_string()
        } else {
            "CLOSED".to_string()
        },
        title: pr.title,
        is_merged: pr.merged.unwrap_or(false),
    }
}

fn action_status_label(status: ActionStatusKind) -> &'static str {
    match status {
        ActionStatusKind::Success => "success",
        ActionStatusKind::Pending => "pending",
        ActionStatusKind::Running => "running",
        ActionStatusKind::Failure => "failure",
    }
}
