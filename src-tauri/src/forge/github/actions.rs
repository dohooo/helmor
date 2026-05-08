//! Action-status path: query the rich GraphQL envelope for a PR's
//! latest commit (checks + deployments), normalise it into the
//! provider-agnostic `ForgeActionStatus`, and produce the insert text
//! the inspector dumps when the user clicks a check.
//!
//! Counterpart to `forge::gitlab::pipeline` — same shape, GitHub-flavoured
//! data sources.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use std::collections::BTreeMap;

use crate::forge::command::command_detail;
use crate::forge::{
    ActionProvider, ActionStatusKind, ChangeRequestInfo, ForgeActionItem, ForgeActionStatus,
    RemoteState,
};

use super::accounts as gh_accounts;
use super::api::{run_graphql, GraphqlOutcome, GITHUB_HOST};
use super::context::GithubContext;
use super::types::{
    ActionCheckContextNode, ActionDeploymentNode, ActionGraphqlEnvelope, ActionPullRequestNode,
    GithubCheckRunDetail,
};

// `first: 10` leaves room for the cross-repo filter (see pull_request.rs).
const ACTION_STATUS_QUERY: &str = r#"
query($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN, MERGED, CLOSED], first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        url
        number
        state
        title
        merged
        reviewDecision
        mergeable
        isCrossRepository
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 50) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      databaseId
                      name
                      status
                      conclusion
                      detailsUrl
                      startedAt
                      completedAt
                      checkSuite {
                        app { name }
                      }
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                    }
                  }
                }
              }
              deployments(first: 20, orderBy: {field: CREATED_AT, direction: DESC}) {
                nodes {
                  id
                  environment
                  latestStatus {
                    state
                    logUrl
                    environmentUrl
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;

/// Query the action-status GraphQL envelope and normalise it into a
/// `ForgeActionStatus`. Auth rejection / "no PR for branch" / GraphQL
/// errors are encoded in the returned status (not bubbled as `Err`).
pub(super) fn query_workspace_pr_action_status(
    context: &GithubContext,
) -> Result<ForgeActionStatus> {
    let parsed: ActionGraphqlEnvelope = match run_graphql(
        &context.login,
        ACTION_STATUS_QUERY,
        &[
            ("owner", context.owner.as_str()),
            ("name", context.name.as_str()),
            ("head", context.branch.as_str()),
        ],
    )? {
        GraphqlOutcome::Auth => {
            // Either the token was rejected upstream (401/403) or the
            // bound account is gone from `gh` entirely. Either way the
            // user-facing fix is the same: re-authenticate. Use
            // `unauthenticated` so the inspector swaps to the Connect
            // CTA instead of a generic "unavailable" stub.
            return Ok(ForgeActionStatus::unauthenticated(
                "GitHub account is not connected for this repository",
            ));
        }
        GraphqlOutcome::Ok(value) => value,
    };

    if let Some(errors) = &parsed.errors {
        if !errors.is_empty() {
            let message = errors
                .iter()
                .map(|e| e.message.as_str())
                .collect::<Vec<_>>()
                .join("; ");
            let is_repo_not_found = errors.iter().any(|e| {
                e.message.contains("Could not resolve to a Repository")
                    || e.message.contains("NOT_FOUND")
            });
            if is_repo_not_found {
                return Ok(ForgeActionStatus::unavailable(message));
            }
            return Ok(ForgeActionStatus::error(message));
        }
    }

    let Some(data) = parsed.data else {
        return Ok(ForgeActionStatus::no_change_request());
    };
    let Some(repository) = data.repository else {
        return Ok(ForgeActionStatus::unavailable(
            "GitHub repository was not returned",
        ));
    };
    let Some(pr) = pick_in_repo_action_pr(repository.pull_requests.nodes) else {
        return Ok(ForgeActionStatus::no_change_request());
    };

    Ok(build_action_status(pr))
}

/// Action-status counterpart to `pull_request::pick_in_repo_pr`.
fn pick_in_repo_action_pr(nodes: Vec<ActionPullRequestNode>) -> Option<ActionPullRequestNode> {
    nodes.into_iter().find(|node| !node.is_cross_repository)
}

/// REST-side companion: fetch the human-readable detail blob for a
/// single check run (used by the inspector "insert log" button).
pub(super) fn query_check_run_detail(
    login: &str,
    owner: &str,
    name: &str,
    check_run_id: i64,
) -> Result<GithubCheckRunDetail> {
    let path = format!("/repos/{owner}/{name}/check-runs/{check_run_id}");
    let args = [
        "api",
        "--hostname",
        GITHUB_HOST,
        "-H",
        "Accept: application/vnd.github+json",
        path.as_str(),
    ];
    let output = gh_accounts::run_cli_with_login(GITHUB_HOST, login, &args)
        .with_context(|| format!("Failed to spawn `gh api {path}`"))?;
    if !output.success {
        return Err(anyhow!(
            "`gh api {path}` failed: {}",
            command_detail(&output)
        ));
    }
    serde_json::from_str::<GithubCheckRunDetail>(&output.stdout)
        .context("Failed to decode GitHub check run response")
}

/// Render an inspector-friendly "Check: foo / Provider: GitHub /
/// Status: failure / ..." string from a normalised action item +
/// optional REST detail blob.
pub(super) fn build_check_insert_text(
    item: &ForgeActionItem,
    detail: Option<&GithubCheckRunDetail>,
) -> String {
    let url = detail
        .and_then(|run| run.details_url.as_deref().or(run.html_url.as_deref()))
        .or(item.url.as_deref());

    let mut sections = vec![format!(
        "Check: {}\nProvider: {}\nStatus: {}{}{}",
        item.name,
        action_provider_label(item.provider),
        action_status_label(item.status),
        item.duration
            .as_deref()
            .map(|duration| format!("\nDuration: {duration}"))
            .unwrap_or_default(),
        url.map(|value| format!("\nURL: {value}"))
            .unwrap_or_default(),
    )];

    if let Some(title) = detail
        .and_then(|run| run.output.as_ref())
        .and_then(|output| output.title.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(format!("Content Title:\n{title}"));
    }

    if let Some(summary) = detail
        .and_then(|run| run.output.as_ref())
        .and_then(|output| output.summary.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(format!("Content Summary:\n{summary}"));
    }

    if let Some(text) = detail
        .and_then(|run| run.output.as_ref())
        .and_then(|output| output.text.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(format!("Content Log:\n{text}"));
    }

    if sections.len() == 1 {
        sections
            .push("Content Log:\nDetailed log text is not available for this check.".to_string());
    }

    sections.join("\n\n")
}

fn build_action_status(node: ActionPullRequestNode) -> ForgeActionStatus {
    let pr = ChangeRequestInfo {
        url: node.url,
        number: node.number,
        state: node.state,
        title: node.title,
        is_merged: node.merged,
    };
    let review_decision = node.review_decision;
    let mergeable = node.mergeable;
    let latest_commit = node
        .commits
        .nodes
        .into_iter()
        .next()
        .map(|node| node.commit);

    let checks = latest_commit
        .as_ref()
        .and_then(|commit| commit.status_check_rollup.as_ref())
        .map(|rollup| {
            dedupe_action_items(
                rollup
                    .contexts
                    .nodes
                    .iter()
                    .filter_map(normalize_check_context)
                    .collect(),
            )
        })
        .unwrap_or_default();

    let deployments = latest_commit
        .map(|commit| {
            commit
                .deployments
                .nodes
                .iter()
                .map(normalize_deployment)
                .collect()
        })
        .unwrap_or_default();

    ForgeActionStatus {
        change_request: Some(pr),
        review_decision,
        mergeable,
        deployments,
        checks,
        remote_state: RemoteState::Ok,
        message: None,
    }
}

fn normalize_check_context(node: &ActionCheckContextNode) -> Option<ForgeActionItem> {
    match node {
        ActionCheckContextNode::CheckRun(check) => {
            let app_name = check
                .check_suite
                .as_ref()
                .and_then(|suite| suite.app.as_ref())
                .map(|app| app.name.as_str());
            let url = check.details_url.clone();
            let provider = infer_provider(
                ActionProvider::Unknown,
                [Some(check.name.as_str()), app_name, url.as_deref()],
            );
            let provider = if provider == ActionProvider::Unknown {
                ActionProvider::Github
            } else {
                provider
            };
            Some(ForgeActionItem {
                id: check
                    .database_id
                    .map(|id| format!("check-run-{id}"))
                    .unwrap_or_else(|| format!("check-run-{}", check.name)),
                name: check.name.clone(),
                provider,
                status: normalize_check_run_status(&check.status, check.conclusion.as_deref()),
                duration: format_duration(
                    check.started_at.as_deref(),
                    check.completed_at.as_deref(),
                ),
                url,
            })
        }
        ActionCheckContextNode::StatusContext(status) => {
            let url = status.target_url.clone();
            let provider = infer_provider(
                ActionProvider::Github,
                [Some(status.context.as_str()), url.as_deref(), None],
            );
            Some(ForgeActionItem {
                id: format!("status-context-{}", status.context),
                name: status.context.clone(),
                provider,
                status: normalize_status_context_state(&status.state),
                duration: None,
                url,
            })
        }
        ActionCheckContextNode::Other => None,
    }
}

fn normalize_deployment(node: &ActionDeploymentNode) -> ForgeActionItem {
    let latest = node.latest_status.as_ref();
    let log_url = latest.and_then(|status| status.log_url.clone());
    let environment_url = latest.and_then(|status| status.environment_url.clone());
    let url = environment_url.or(log_url);
    let environment = node
        .environment
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Deployment");
    let provider = infer_provider(
        ActionProvider::Unknown,
        [
            Some(environment),
            url.as_deref(),
            latest.map(|status| status.state.as_str()),
        ],
    );

    ForgeActionItem {
        id: node.id.clone(),
        name: environment.to_string(),
        provider,
        status: latest
            .map(|status| normalize_deployment_state(&status.state))
            .unwrap_or(ActionStatusKind::Pending),
        duration: None,
        url,
    }
}

fn dedupe_action_items(items: Vec<ForgeActionItem>) -> Vec<ForgeActionItem> {
    let mut deduped = BTreeMap::<String, ForgeActionItem>::new();

    for item in items {
        let key = format!("{:?}::{}", item.provider, item.name);
        match deduped.get(&key) {
            Some(existing)
                if action_status_priority(existing.status)
                    < action_status_priority(item.status) => {}
            _ => {
                deduped.insert(key, item);
            }
        }
    }

    deduped.into_values().collect()
}

fn action_status_priority(status: ActionStatusKind) -> u8 {
    match status {
        ActionStatusKind::Failure => 0,
        ActionStatusKind::Running => 1,
        ActionStatusKind::Pending => 2,
        ActionStatusKind::Success => 3,
    }
}

fn normalize_check_run_status(status: &str, conclusion: Option<&str>) -> ActionStatusKind {
    match status {
        "COMPLETED" => match conclusion {
            Some("SUCCESS" | "NEUTRAL" | "SKIPPED") => ActionStatusKind::Success,
            _ => ActionStatusKind::Failure,
        },
        "IN_PROGRESS" => ActionStatusKind::Running,
        "WAITING" | "REQUESTED" | "QUEUED" | "PENDING" => ActionStatusKind::Pending,
        _ => ActionStatusKind::Pending,
    }
}

fn normalize_status_context_state(state: &str) -> ActionStatusKind {
    match state {
        "SUCCESS" => ActionStatusKind::Success,
        "FAILURE" | "ERROR" => ActionStatusKind::Failure,
        "PENDING" => ActionStatusKind::Running,
        _ => ActionStatusKind::Pending,
    }
}

fn normalize_deployment_state(state: &str) -> ActionStatusKind {
    match state {
        "SUCCESS" => ActionStatusKind::Success,
        "FAILURE" | "ERROR" | "INACTIVE" => ActionStatusKind::Failure,
        "PENDING" | "QUEUED" => ActionStatusKind::Pending,
        _ => ActionStatusKind::Running,
    }
}

fn infer_provider<'a>(
    default_provider: ActionProvider,
    values: impl IntoIterator<Item = Option<&'a str>>,
) -> ActionProvider {
    let mut saw_github = false;
    for value in values.into_iter().flatten() {
        let value = value.to_ascii_lowercase();
        if value.contains("vercel") {
            return ActionProvider::Vercel;
        }
        if value.contains("github") {
            saw_github = true;
        }
    }
    if saw_github {
        ActionProvider::Github
    } else {
        default_provider
    }
}

fn format_duration(started_at: Option<&str>, completed_at: Option<&str>) -> Option<String> {
    let started = parse_github_datetime(started_at?)?;
    let completed = parse_github_datetime(completed_at?)?;
    let seconds = (completed - started).num_seconds();
    if seconds < 0 {
        return None;
    }
    if seconds < 60 {
        return Some(format!("{seconds}s"));
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return Some(format!("{minutes}m"));
    }
    Some(format!("{}h", minutes / 60))
}

fn action_provider_label(provider: ActionProvider) -> &'static str {
    match provider {
        ActionProvider::Github => "GitHub",
        ActionProvider::Gitlab => "GitLab",
        ActionProvider::Vercel => "Vercel",
        ActionProvider::Unknown => "Unknown",
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

fn parse_github_datetime(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|datetime| datetime.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::github::types::{
        ActionCheckApp, ActionCheckContextConnection, ActionCheckRunNode, ActionCheckSuite,
        ActionCommitConnection, ActionCommitNode, ActionDeploymentConnection,
        ActionDeploymentStatusNode, ActionPullRequestCommitNode, ActionStatusCheckRollup,
        GithubCheckRunOutput,
    };

    #[test]
    fn normalize_check_run_status_treats_unknown_completed_as_failure() {
        assert_eq!(
            normalize_check_run_status("COMPLETED", None),
            ActionStatusKind::Failure
        );
        assert_eq!(
            normalize_check_run_status("COMPLETED", Some("CANCELLED")),
            ActionStatusKind::Failure
        );
        assert_eq!(
            normalize_check_run_status("COMPLETED", Some("TIMED_OUT")),
            ActionStatusKind::Failure
        );
    }

    #[test]
    fn normalize_check_run_status_unknown_status_falls_back_to_pending() {
        assert_eq!(
            normalize_check_run_status("FUTURE_STATE", None),
            ActionStatusKind::Pending
        );
        assert_eq!(
            normalize_check_run_status("", None),
            ActionStatusKind::Pending
        );
    }

    #[test]
    fn normalize_check_run_status_completed_neutral_is_success() {
        assert_eq!(
            normalize_check_run_status("COMPLETED", Some("NEUTRAL")),
            ActionStatusKind::Success
        );
    }

    #[test]
    fn action_status_priority_orders_failure_first() {
        let priorities: Vec<u8> = [
            ActionStatusKind::Failure,
            ActionStatusKind::Running,
            ActionStatusKind::Pending,
            ActionStatusKind::Success,
        ]
        .iter()
        .map(|s| action_status_priority(*s))
        .collect();
        assert_eq!(priorities, vec![0, 1, 2, 3]);
    }

    #[test]
    fn format_duration_returns_none_when_completion_before_start() {
        assert!(
            format_duration(Some("2026-04-10T00:01:00Z"), Some("2026-04-10T00:00:30Z")).is_none()
        );
    }

    #[test]
    fn format_duration_returns_none_when_either_input_is_invalid() {
        assert!(format_duration(Some("not-a-date"), Some("2026-04-10T00:00:00Z")).is_none());
        assert!(format_duration(Some("2026-04-10T00:00:00Z"), Some("garbage")).is_none());
    }

    #[test]
    fn infer_provider_falls_back_to_default_when_no_known_match() {
        let provider = infer_provider(ActionProvider::Gitlab, [Some("custom-runner"), None]);
        assert_eq!(provider, ActionProvider::Gitlab);
    }

    #[test]
    fn infer_provider_vercel_wins_over_github_in_same_input() {
        let provider = infer_provider(
            ActionProvider::Unknown,
            [Some("https://vercel.com/team/app"), Some("github.com/x")],
        );
        assert_eq!(provider, ActionProvider::Vercel);
    }

    #[test]
    fn normalizes_check_run_statuses() {
        assert_eq!(
            normalize_check_run_status("COMPLETED", Some("SUCCESS")),
            ActionStatusKind::Success
        );
        assert_eq!(
            normalize_check_run_status("COMPLETED", Some("SKIPPED")),
            ActionStatusKind::Success
        );
        assert_eq!(
            normalize_check_run_status("COMPLETED", Some("FAILURE")),
            ActionStatusKind::Failure
        );
        assert_eq!(
            normalize_check_run_status("IN_PROGRESS", None),
            ActionStatusKind::Running
        );
        assert_eq!(
            normalize_check_run_status("QUEUED", None),
            ActionStatusKind::Pending
        );
    }

    #[test]
    fn normalizes_status_context_and_deployment_states() {
        assert_eq!(
            normalize_status_context_state("SUCCESS"),
            ActionStatusKind::Success
        );
        assert_eq!(
            normalize_status_context_state("ERROR"),
            ActionStatusKind::Failure
        );
        assert_eq!(
            normalize_status_context_state("PENDING"),
            ActionStatusKind::Running
        );
        assert_eq!(
            normalize_deployment_state("SUCCESS"),
            ActionStatusKind::Success
        );
        assert_eq!(
            normalize_deployment_state("FAILURE"),
            ActionStatusKind::Failure
        );
        assert_eq!(
            normalize_deployment_state("IN_PROGRESS"),
            ActionStatusKind::Running
        );
    }

    #[test]
    fn infers_action_providers() {
        assert_eq!(
            infer_provider(
                ActionProvider::Unknown,
                [Some("Vercel – app"), Some("https://vercel.com/team/app")]
            ),
            ActionProvider::Vercel
        );
        assert_eq!(
            infer_provider(
                ActionProvider::Unknown,
                [
                    Some("GitHub Actions"),
                    Some("https://github.com/org/repo/actions")
                ]
            ),
            ActionProvider::Github
        );
        assert_eq!(
            infer_provider(ActionProvider::Unknown, [Some("custom-ci"), None]),
            ActionProvider::Unknown
        );
    }

    #[test]
    fn formats_check_run_durations() {
        assert_eq!(
            format_duration(Some("2026-04-10T00:00:00Z"), Some("2026-04-10T00:00:12Z")).as_deref(),
            Some("12s")
        );
        assert_eq!(
            format_duration(Some("2026-04-10T00:00:00Z"), Some("2026-04-10T00:02:03Z")).as_deref(),
            Some("2m")
        );
        assert_eq!(
            format_duration(Some("2026-04-10T00:00:00Z"), Some("2026-04-10T01:20:00Z")).as_deref(),
            Some("1h")
        );
        assert_eq!(format_duration(None, Some("2026-04-10T00:00:00Z")), None);
    }

    fn make_action_node(number: i64, cross: bool) -> ActionPullRequestNode {
        ActionPullRequestNode {
            url: format!("https://github.com/octocat/hello-world/pull/{number}"),
            number,
            state: "OPEN".to_string(),
            title: "Update".to_string(),
            merged: false,
            review_decision: None,
            mergeable: None,
            is_cross_repository: cross,
            commits: ActionCommitConnection { nodes: vec![] },
        }
    }

    #[test]
    fn pick_in_repo_action_pr_skips_cross_repository_nodes() {
        let nodes = vec![make_action_node(433, true), make_action_node(100, false)];
        let picked = pick_in_repo_action_pr(nodes).expect("expected an in-repo PR");
        assert_eq!(picked.number, 100);
    }

    #[test]
    fn pick_in_repo_action_pr_returns_none_when_only_cross_repo_matches() {
        let nodes = vec![make_action_node(433, true)];
        assert!(pick_in_repo_action_pr(nodes).is_none());
    }

    #[test]
    fn builds_action_status_with_review_and_mergeable_fields() {
        let status = build_action_status(ActionPullRequestNode {
            url: "https://github.com/octocat/hello-world/pull/1".to_string(),
            number: 1,
            state: "OPEN".to_string(),
            title: "Update".to_string(),
            merged: false,
            review_decision: Some("CHANGES_REQUESTED".to_string()),
            mergeable: Some("CONFLICTING".to_string()),
            is_cross_repository: false,
            commits: ActionCommitConnection {
                nodes: vec![ActionPullRequestCommitNode {
                    commit: ActionCommitNode {
                        status_check_rollup: Some(ActionStatusCheckRollup {
                            contexts: ActionCheckContextConnection {
                                nodes: vec![ActionCheckContextNode::CheckRun(ActionCheckRunNode {
                                    database_id: Some(42),
                                    name: "changes".to_string(),
                                    status: "COMPLETED".to_string(),
                                    conclusion: Some("SUCCESS".to_string()),
                                    details_url: Some(
                                        "https://github.com/octocat/hello-world/actions/runs/1"
                                            .to_string(),
                                    ),
                                    started_at: Some("2026-04-10T00:00:00Z".to_string()),
                                    completed_at: Some("2026-04-10T00:00:12Z".to_string()),
                                    check_suite: Some(ActionCheckSuite {
                                        app: Some(ActionCheckApp {
                                            name: "GitHub Actions".to_string(),
                                        }),
                                    }),
                                })],
                            },
                        }),
                        deployments: ActionDeploymentConnection {
                            nodes: vec![ActionDeploymentNode {
                                id: "deployment-1".to_string(),
                                environment: Some("Vercel Preview".to_string()),
                                latest_status: Some(ActionDeploymentStatusNode {
                                    state: "SUCCESS".to_string(),
                                    log_url: Some("https://vercel.com/log".to_string()),
                                    environment_url: Some("https://app.vercel.app".to_string()),
                                }),
                            }],
                        },
                    },
                }],
            },
        });

        assert_eq!(status.remote_state, RemoteState::Ok);
        assert_eq!(status.review_decision.as_deref(), Some("CHANGES_REQUESTED"));
        assert_eq!(status.mergeable.as_deref(), Some("CONFLICTING"));
        assert_eq!(status.checks.len(), 1);
        assert_eq!(status.checks[0].status, ActionStatusKind::Success);
        assert_eq!(status.checks[0].provider, ActionProvider::Github);
        assert_eq!(status.checks[0].duration.as_deref(), Some("12s"));
        assert_eq!(status.deployments.len(), 1);
        assert_eq!(status.deployments[0].provider, ActionProvider::Vercel);
    }

    #[test]
    fn deduplicates_duplicate_check_runs_with_same_name() {
        let status = build_action_status(ActionPullRequestNode {
            url: "https://github.com/octocat/hello-world/pull/1".to_string(),
            number: 1,
            state: "OPEN".to_string(),
            title: "Update".to_string(),
            merged: false,
            review_decision: None,
            mergeable: Some("MERGEABLE".to_string()),
            is_cross_repository: false,
            commits: ActionCommitConnection {
                nodes: vec![ActionPullRequestCommitNode {
                    commit: ActionCommitNode {
                        status_check_rollup: Some(ActionStatusCheckRollup {
                            contexts: ActionCheckContextConnection {
                                nodes: vec![
                                    ActionCheckContextNode::CheckRun(ActionCheckRunNode {
                                        database_id: Some(101),
                                        name: "Lint".to_string(),
                                        status: "COMPLETED".to_string(),
                                        conclusion: Some("SUCCESS".to_string()),
                                        details_url: Some(
                                            "https://github.com/octocat/hello-world/actions/runs/1"
                                                .to_string(),
                                        ),
                                        started_at: Some("2026-04-16T01:45:30Z".to_string()),
                                        completed_at: Some("2026-04-16T01:45:36Z".to_string()),
                                        check_suite: Some(ActionCheckSuite {
                                            app: Some(ActionCheckApp {
                                                name: "GitHub Actions".to_string(),
                                            }),
                                        }),
                                    }),
                                    ActionCheckContextNode::CheckRun(ActionCheckRunNode {
                                        database_id: Some(202),
                                        name: "Lint".to_string(),
                                        status: "IN_PROGRESS".to_string(),
                                        conclusion: None,
                                        details_url: Some(
                                            "https://github.com/octocat/hello-world/actions/runs/2"
                                                .to_string(),
                                        ),
                                        started_at: Some("2026-04-16T01:46:00Z".to_string()),
                                        completed_at: None,
                                        check_suite: Some(ActionCheckSuite {
                                            app: Some(ActionCheckApp {
                                                name: "GitHub Actions".to_string(),
                                            }),
                                        }),
                                    }),
                                ],
                            },
                        }),
                        deployments: ActionDeploymentConnection { nodes: vec![] },
                    },
                }],
            },
        });

        assert_eq!(status.checks.len(), 1);
        assert_eq!(status.checks[0].name, "Lint");
        assert_eq!(status.checks[0].status, ActionStatusKind::Running);
        assert_eq!(
            status.checks[0].url.as_deref(),
            Some("https://github.com/octocat/hello-world/actions/runs/2")
        );
    }

    #[test]
    fn builds_check_insert_text_with_detail_sections() {
        let text = build_check_insert_text(
            &ForgeActionItem {
                id: "check-run-42".to_string(),
                name: "changes".to_string(),
                provider: ActionProvider::Github,
                status: ActionStatusKind::Failure,
                duration: Some("12s".to_string()),
                url: Some("https://github.com/octocat/hello-world/actions/runs/1".to_string()),
            },
            Some(&GithubCheckRunDetail {
                details_url: Some(
                    "https://github.com/octocat/hello-world/actions/runs/1/job/99".to_string(),
                ),
                html_url: None,
                output: Some(GithubCheckRunOutput {
                    title: Some("Job failed".to_string()),
                    summary: Some("1 step failed".to_string()),
                    text: Some("Step 3: tests failed".to_string()),
                }),
            }),
        );

        assert!(text.contains("Check: changes"));
        assert!(text.contains("Provider: GitHub"));
        assert!(text.contains("Status: failure"));
        assert!(text.contains("Duration: 12s"));
        assert!(text.contains("Content Title:\nJob failed"));
        assert!(text.contains("Content Summary:\n1 step failed"));
        assert!(text.contains("Content Log:\nStep 3: tests failed"));
    }

    #[test]
    fn builds_check_insert_text_with_unavailable_log_fallback() {
        let text = build_check_insert_text(
            &ForgeActionItem {
                id: "status-context-ci".to_string(),
                name: "CI".to_string(),
                provider: ActionProvider::Github,
                status: ActionStatusKind::Pending,
                duration: None,
                url: None,
            },
            None,
        );

        assert!(text.contains("Check: CI"));
        assert!(text.contains("Status: pending"));
        assert!(text.contains("Content Log:\nDetailed log text is not available for this check."));
    }
}
