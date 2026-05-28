//! Pipeline + job (aka "check") integration.
//!
//! GitLab CI jobs surface in Helmor's inspector as rows in the
//! `ForgeActionStatus.checks` list. This module owns the GitLab-side loading, status mapping,
//! duration formatting, and the check-log-insert text builder.

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};

use super::super::types::{ActionProvider, ActionStatusKind, ForgeActionItem};
use super::api::{command_detail, encode_path_component, glab_api};
use super::context::GitlabContext;
use super::types::{GitlabJob, GitlabPipeline};

pub(super) fn load_pipeline_jobs(
    context: &GitlabContext,
    pipeline_id: i64,
) -> Result<Vec<ForgeActionItem>> {
    let endpoint = format!(
        "projects/{}/pipelines/{pipeline_id}/jobs?per_page=100",
        encode_path_component(&context.full_path),
    );
    let output = glab_api(&context.remote.host, [endpoint.as_str()])?;
    if !output.success {
        bail!(
            "GitLab pipeline jobs lookup failed: {}",
            command_detail(&output)
        );
    }

    let jobs = serde_json::from_str::<Vec<GitlabJob>>(&output.stdout)
        .context("Failed to decode GitLab pipeline jobs response")?;
    Ok(jobs.into_iter().map(job_item).collect())
}

pub(super) fn load_job_trace(context: &GitlabContext, job_id: i64) -> Result<Option<String>> {
    let endpoint = format!(
        "projects/{}/jobs/{job_id}/trace",
        encode_path_component(&context.full_path),
    );
    let output = glab_api(&context.remote.host, [endpoint.as_str()])?;
    if !output.success {
        return Ok(None);
    }
    Ok(Some(output.stdout))
}

/// Render a pipeline (parent of jobs) as a single check row — used as a
/// fallback when job enumeration fails or the pipeline has no jobs yet.
pub(super) fn pipeline_item(pipeline: &GitlabPipeline) -> ForgeActionItem {
    ForgeActionItem {
        id: pipeline
            .id
            .map(|id| format!("gitlab-pipeline-{id}"))
            .unwrap_or_else(|| "gitlab-pipeline".to_string()),
        name: pipeline
            .id
            .map(|id| format!("Pipeline #{id}"))
            .unwrap_or_else(|| "Pipeline".to_string()),
        provider: ActionProvider::Gitlab,
        status: normalize_gitlab_status(pipeline.status.as_deref()),
        duration: pipeline.duration.and_then(format_seconds_duration),
        url: pipeline.web_url.clone(),
    }
}

/// Assemble the "Content Log" string shown in the composer when a user
/// clicks the "+ context" button on a failed/running check.
pub(super) fn build_gitlab_check_insert_text(
    item: &ForgeActionItem,
    trace: Option<&str>,
) -> String {
    let mut text = format!(
        "Check: {}\nProvider: GitLab\nStatus: {}{}{}",
        item.name,
        action_status_label(item.status),
        item.duration
            .as_deref()
            .map(|duration| format!("\nDuration: {duration}"))
            .unwrap_or_default(),
        item.url
            .as_deref()
            .map(|url| format!("\nURL: {url}"))
            .unwrap_or_default(),
    );

    text.push_str("\n\nContent Log:\n");
    text.push_str(
        trace
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Detailed log text is not available for this GitLab job."),
    );
    text
}

fn job_item(job: GitlabJob) -> ForgeActionItem {
    ForgeActionItem {
        id: format!("gitlab-job-{}", job.id),
        name: job.name,
        provider: ActionProvider::Gitlab,
        status: normalize_gitlab_status(Some(&job.status)),
        duration: job
            .duration
            .and_then(format_seconds_duration)
            .or_else(|| format_duration(job.started_at.as_deref(), job.finished_at.as_deref())),
        url: job.web_url,
    }
}

fn normalize_gitlab_status(status: Option<&str>) -> ActionStatusKind {
    // GitLab job/pipeline status reference:
    // https://docs.gitlab.com/api/jobs/#list-project-jobs
    //
    // We bucket anything "pipeline is in flight" as Running so the row matches
    // what GitLab itself shows for the parent pipeline. Concretely: a job in
    // `pending` (queued waiting for a runner) or `created` (not yet enqueued)
    // still drives the pipeline header to "Running" in GitLab's UI — keeping
    // the row gray here would tell the user "nothing is happening" when the
    // pipeline is in fact actively in progress. `preparing` and
    // `waiting_for_resource` are even further along.
    //
    // `manual` and `scheduled` stay Pending: those jobs will NOT run without
    // an external trigger (a click / a scheduled time), so gray "waiting on
    // you" reads more honestly than amber "running".
    //
    // This intentionally diverges from the GitHub mapping in
    // `forge::github::actions::normalize_check_run_status`, which treats
    // `QUEUED` / `WAITING` / `REQUESTED` as Pending. GitHub surfaces a per-run
    // status that's already disambiguated from the workflow-level state;
    // GitLab only gives us per-job status, so we lean toward the
    // pipeline-level reading.
    match status.unwrap_or_default() {
        "success" | "skipped" => ActionStatusKind::Success,
        "failed" | "canceled" => ActionStatusKind::Failure,
        "running" | "preparing" | "waiting_for_resource" | "pending" | "created" => {
            ActionStatusKind::Running
        }
        "scheduled" | "manual" => ActionStatusKind::Pending,
        _ => ActionStatusKind::Pending,
    }
}

fn format_seconds_duration(seconds: f64) -> Option<String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    let seconds = seconds.round() as i64;
    if seconds < 60 {
        return Some(format!("{seconds}s"));
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return Some(format!("{minutes}m"));
    }
    Some(format!("{}h", minutes / 60))
}

fn format_duration(started_at: Option<&str>, finished_at: Option<&str>) -> Option<String> {
    let started = parse_gitlab_datetime(started_at?)?;
    let finished = parse_gitlab_datetime(finished_at?)?;
    format_seconds_duration((finished - started).num_seconds() as f64)
}

fn parse_gitlab_datetime(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn action_status_label(status: ActionStatusKind) -> &'static str {
    match status {
        ActionStatusKind::Success => "success",
        ActionStatusKind::Pending => "pending",
        ActionStatusKind::Running => "running",
        ActionStatusKind::Failure => "failure",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_gitlab_statuses_to_action_statuses() {
        assert_eq!(
            normalize_gitlab_status(Some("success")),
            ActionStatusKind::Success
        );
        assert_eq!(
            normalize_gitlab_status(Some("failed")),
            ActionStatusKind::Failure
        );
        assert_eq!(
            normalize_gitlab_status(Some("running")),
            ActionStatusKind::Running
        );
        assert_eq!(
            normalize_gitlab_status(Some("preparing")),
            ActionStatusKind::Running
        );
        assert_eq!(
            normalize_gitlab_status(Some("waiting_for_resource")),
            ActionStatusKind::Running
        );
        // `pending` / `created` collapse into Running on purpose — see the
        // comment on `normalize_gitlab_status`.
        assert_eq!(
            normalize_gitlab_status(Some("pending")),
            ActionStatusKind::Running
        );
        assert_eq!(
            normalize_gitlab_status(Some("created")),
            ActionStatusKind::Running
        );
        assert_eq!(
            normalize_gitlab_status(Some("scheduled")),
            ActionStatusKind::Pending
        );
        assert_eq!(
            normalize_gitlab_status(Some("manual")),
            ActionStatusKind::Pending
        );
        assert_eq!(
            normalize_gitlab_status(Some("skipped")),
            ActionStatusKind::Success
        );
        assert_eq!(
            normalize_gitlab_status(Some("canceled")),
            ActionStatusKind::Failure
        );
    }

    #[test]
    fn formats_short_durations_as_seconds_then_minutes_then_hours() {
        assert_eq!(format_seconds_duration(42.0), Some("42s".to_string()));
        assert_eq!(format_seconds_duration(125.0), Some("2m".to_string()));
        assert_eq!(format_seconds_duration(7200.0), Some("2h".to_string()));
        assert_eq!(format_seconds_duration(-1.0), None);
        assert_eq!(format_seconds_duration(f64::NAN), None);
    }
}
