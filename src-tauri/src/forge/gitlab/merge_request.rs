//! Merge-request-shaped operations: look up the current workspace's MR,
//! convert a GitLab MR record into Helmor's neutral `ChangeRequestInfo`,
//! and translate GitLab's mergeable/state enums.

use anyhow::{bail, Context, Result};

use crate::error::ErrorCode;

use super::super::types::ChangeRequestInfo;

use super::api::{
    command_detail, encode_path_component, encode_query_value, glab_api, looks_like_auth_error,
    looks_like_missing_error,
};
use super::context::GitlabContext;
use super::types::GitlabMergeRequest;

/// Fetch the most recently updated MR that has the workspace's branch as
/// its source. Returns `None` when there is no MR (or when glab can't
/// authenticate / the repo isn't reachable — those cases look the same
/// to callers and should degrade gracefully).
pub(super) fn find_workspace_mr(context: &GitlabContext) -> Result<Option<GitlabMergeRequest>> {
    let endpoint = format!(
        "projects/{}/merge_requests?source_branch={}&state=all&order_by=updated_at&sort=desc&per_page=1",
        encode_path_component(&context.full_path),
        encode_query_value(&context.branch),
    );
    let output = glab_api(&context.remote.host, [endpoint.as_str()])?;
    if !output.success {
        let detail = command_detail(&output);
        if looks_like_auth_error(&detail) {
            crate::bail_coded!(
                ErrorCode::ForgeOnboarding,
                "GitLab CLI authentication required: {detail}"
            );
        }
        if looks_like_missing_error(&detail) {
            return Ok(None);
        }
        bail!("GitLab MR lookup failed: {detail}");
    }

    let mut items = serde_json::from_str::<Vec<GitlabMergeRequest>>(&output.stdout)
        .context("Failed to decode GitLab merge request response")?;
    let Some(mr) = items.pop() else {
        return Ok(None);
    };
    fetch_mr_detail(context, mr.iid).map(Some)
}

fn fetch_mr_detail(context: &GitlabContext, iid: i64) -> Result<GitlabMergeRequest> {
    let endpoint = format!(
        "projects/{}/merge_requests/{iid}",
        encode_path_component(&context.full_path),
    );
    let output = glab_api(&context.remote.host, [endpoint.as_str()])?;
    if !output.success {
        let detail = command_detail(&output);
        if looks_like_auth_error(&detail) {
            crate::bail_coded!(
                ErrorCode::ForgeOnboarding,
                "GitLab CLI authentication required: {detail}"
            );
        }
        bail!("GitLab MR detail lookup failed: {detail}");
    }
    serde_json::from_str::<GitlabMergeRequest>(&output.stdout)
        .context("Failed to decode GitLab merge request detail response")
}

/// Collapse a GitLab MR record into the neutral shape the frontend
/// expects — the same struct GitHub's GraphQL path returns so the
/// inspector can render either provider without knowing which backend
/// produced the data.
pub(super) fn mr_info(mr: &GitlabMergeRequest) -> ChangeRequestInfo {
    ChangeRequestInfo {
        url: mr.web_url.clone(),
        number: mr.iid,
        state: gitlab_mr_state(&mr.state).to_string(),
        title: mr.title.clone(),
        is_merged: mr.state == "merged" || mr.merged_at.is_some(),
    }
}

pub(super) fn gitlab_mr_state(state: &str) -> &'static str {
    match state {
        "opened" => "OPEN",
        "merged" => "MERGED",
        "closed" => "CLOSED",
        _ => "UNKNOWN",
    }
}

/// What value (if any) we should send as `squash` on the merge API,
/// derived from the project's `squash_option`.
///
/// GitLab refuses the merge if we send a value incompatible with the
/// project setting (e.g. `squash=true` when the project is `"never"`,
/// or omitting it on `"always"`). We can't override the project-level
/// `merge_method` (merge / rebase_merge / ff) — that's enforced
/// server-side without an API knob — so this is the only knob we tune.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SquashChoice {
    /// Pass `squash=true`. Required for `"always"`; honors project
    /// preference for `"default_on"`.
    Squash,
    /// Omit `squash` (server default = false). Right for `"never"`,
    /// `"default_off"`, missing fields, or older GitLab without the flag.
    Default,
}

impl SquashChoice {
    fn for_option(option: Option<&str>) -> Self {
        match option {
            Some("always") | Some("default_on") => Self::Squash,
            _ => Self::Default,
        }
    }
}

/// Best-effort: ask GitLab for the project's `squash_option` and map it
/// to a `SquashChoice`. Any failure (network, auth, parse) degrades to
/// `Default` with a warning log — we'd rather attempt the merge with no
/// squash flag and let GitLab surface the real error than block the
/// user on a project-info lookup.
pub(super) fn determine_squash_choice(context: &GitlabContext) -> SquashChoice {
    let endpoint = format!("projects/{}", encode_path_component(&context.full_path));
    let output = match glab_api(&context.remote.host, [endpoint.as_str()]) {
        Ok(output) => output,
        Err(error) => {
            tracing::warn!(
                host = %context.remote.host,
                full_path = %context.full_path,
                error = %format!("{error:#}"),
                "Failed to fetch GitLab project for squash_option; using default"
            );
            return SquashChoice::Default;
        }
    };
    if !output.success {
        tracing::warn!(
            host = %context.remote.host,
            full_path = %context.full_path,
            detail = %command_detail(&output),
            "GitLab project lookup unsuccessful; using default squash choice"
        );
        return SquashChoice::Default;
    }
    let value: serde_json::Value = match serde_json::from_str(&output.stdout) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(
                host = %context.remote.host,
                full_path = %context.full_path,
                error = %format!("{error:#}"),
                "Failed to parse GitLab project response; using default squash choice"
            );
            return SquashChoice::Default;
        }
    };
    SquashChoice::for_option(value.get("squash_option").and_then(|v| v.as_str()))
}

/// Map GitLab's merge status to the same three-way enum GitHub's
/// `mergeable` field uses (`MERGEABLE` / `CONFLICTING` / `UNKNOWN`).
pub(super) fn gitlab_mergeable(mr: &GitlabMergeRequest) -> Option<String> {
    if mr.has_conflicts.unwrap_or(false) {
        return Some("CONFLICTING".to_string());
    }

    let status = mr
        .detailed_merge_status
        .as_deref()
        .or(mr.merge_status.as_deref())?;
    match status {
        "can_be_merged" | "mergeable" => Some("MERGEABLE".to_string()),
        "checking" | "unchecked" | "ci_must_pass" | "not_open" => Some("UNKNOWN".to_string()),
        value if value.contains("conflict") => Some("CONFLICTING".to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_gitlab_mr_state_to_existing_pr_state_shape() {
        assert_eq!(gitlab_mr_state("opened"), "OPEN");
        assert_eq!(gitlab_mr_state("merged"), "MERGED");
        assert_eq!(gitlab_mr_state("closed"), "CLOSED");
        assert_eq!(gitlab_mr_state("locked"), "UNKNOWN");
        assert_eq!(gitlab_mr_state("draft"), "UNKNOWN");
    }

    fn mr_with_merge_status(
        merge_status: Option<&str>,
        detailed_merge_status: Option<&str>,
        has_conflicts: Option<bool>,
    ) -> GitlabMergeRequest {
        GitlabMergeRequest {
            iid: 1,
            title: "MR".to_string(),
            state: "opened".to_string(),
            web_url: "https://gitlab.example.com/acme/repo/-/merge_requests/1".to_string(),
            merged_at: None,
            merge_status: merge_status.map(str::to_string),
            detailed_merge_status: detailed_merge_status.map(str::to_string),
            has_conflicts,
            head_pipeline: None,
        }
    }

    #[test]
    fn squash_choice_required_when_project_demands_it() {
        // The original bug shape: project requires squash, we used to send
        // no params and GitLab rejected.
        assert_eq!(
            SquashChoice::for_option(Some("always")),
            SquashChoice::Squash
        );
    }

    #[test]
    fn squash_choice_honors_default_on_preference() {
        assert_eq!(
            SquashChoice::for_option(Some("default_on")),
            SquashChoice::Squash
        );
    }

    #[test]
    fn squash_choice_omits_flag_when_forbidden_or_optional() {
        // never  → sending true would be rejected; default false matches.
        // default_off → user-overridable but server default is false.
        // None / unknown → older GitLab or missing field; safest is default.
        for option in [Some("never"), Some("default_off"), None, Some("garbled")] {
            assert_eq!(SquashChoice::for_option(option), SquashChoice::Default);
        }
    }

    #[test]
    fn maps_gitlab_mergeable_status_to_existing_shape() {
        let cases = [
            (Some("can_be_merged"), None, None, Some("MERGEABLE")),
            (Some("mergeable"), None, None, Some("MERGEABLE")),
            (Some("checking"), None, None, Some("UNKNOWN")),
            (Some("unchecked"), None, None, Some("UNKNOWN")),
            (Some("ci_must_pass"), None, None, Some("UNKNOWN")),
            (Some("not_open"), None, None, Some("UNKNOWN")),
            (Some("has_conflicts"), None, None, Some("CONFLICTING")),
            (Some("mergeable"), None, Some(true), Some("CONFLICTING")),
            (Some("mergeable"), Some("checking"), None, Some("UNKNOWN")),
            (Some("unexpected"), None, None, None),
        ];

        for (merge_status, detailed_status, has_conflicts, expected) in cases {
            let mr = mr_with_merge_status(merge_status, detailed_status, has_conflicts);
            assert_eq!(gitlab_mergeable(&mr).as_deref(), expected);
        }
    }
}
