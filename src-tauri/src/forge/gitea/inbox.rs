use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};

use super::accounts::resolve_login_name;
use super::api::{command_detail, encode_query_value, looks_like_auth_error, tea_api};
use super::types::{GiteaIssue, GiteaLabel, GiteaPullRequest};
use crate::forge::inbox::{
    ForgeLabelOption, InboxDraftFilter, InboxFilters, InboxItem, InboxItemDetail, InboxPage,
    InboxScopeFilter, InboxSortFilter, InboxSource, InboxState, InboxStateFilter, InboxStateTone,
    InboxToggles,
};

pub mod detail;

use detail::{GiteaIssueDetail, GiteaPullRequestDetail};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct GiteaCursor {
    page: u32,
}

pub fn list_inbox_items(
    login: &str,
    host: Option<&str>,
    toggles: InboxToggles,
    cursor: Option<&str>,
    limit: usize,
    repo_filter: Option<&str>,
    filters: Option<InboxFilters>,
) -> Result<InboxPage> {
    let login_name = gitea_login_name(host, login)?;
    let state = decode_cursor(cursor)?;
    let page = state.page.max(1);
    if toggles.issues {
        return fetch_issues(&login_name, page, limit, repo_filter, filters);
    }
    if toggles.prs {
        return fetch_prs(&login_name, page, limit, repo_filter, filters);
    }
    Ok(InboxPage {
        items: Vec::new(),
        next_cursor: None,
    })
}

pub fn get_inbox_item_detail(
    login: &str,
    host: Option<&str>,
    source: InboxSource,
    external_id: &str,
) -> Result<Option<InboxItemDetail>> {
    let login_name = gitea_login_name(host, login)?;
    let (repo, number) = parse_repo_number(external_id)?;
    let (owner, name) = split_repo(&repo)?;
    match source {
        InboxSource::GiteaIssue => {
            let path = format!("/repos/{owner}/{name}/issues/{number}");
            let output = tea_api(&login_name, [path.as_str()])?;
            if !output.success {
                return Ok(None);
            }
            let issue = serde_json::from_str::<GiteaIssue>(&output.stdout)
                .context("Failed to decode Gitea issue detail")?;
            Ok(Some(InboxItemDetail::GiteaIssue(Box::new(
                GiteaIssueDetail {
                    external_id: external_id.to_string(),
                    title: issue.title,
                    body: issue.body,
                    url: issue.html_url,
                    state: issue.state,
                    author_login: issue.user.and_then(|user| user.login.or(user.user_name)),
                    created_at: issue.created_at,
                    updated_at: issue.updated_at,
                    closed_at: issue.closed_at,
                },
            ))))
        }
        InboxSource::GiteaPr => {
            let path = format!("/repos/{owner}/{name}/pulls/{number}");
            let output = tea_api(&login_name, [path.as_str()])?;
            if !output.success {
                return Ok(None);
            }
            let pr = serde_json::from_str::<GiteaPullRequest>(&output.stdout)
                .context("Failed to decode Gitea pull request detail")?;
            Ok(Some(InboxItemDetail::GiteaPr(Box::new(
                GiteaPullRequestDetail {
                    external_id: external_id.to_string(),
                    title: pr.title,
                    body: pr.body,
                    url: pr.html_url,
                    state: pr.state,
                    merged: pr.merged.unwrap_or(false),
                    draft: pr.draft.unwrap_or(false),
                    author_login: pr.user.and_then(|user| user.login.or(user.user_name)),
                    source_branch: pr.head.and_then(|head| head.branch_ref),
                    target_branch: pr.base.and_then(|base| base.branch_ref),
                    created_at: pr.created_at,
                    updated_at: pr.updated_at,
                },
            ))))
        }
        _ => unreachable!("non-Gitea source routed to Gitea inbox backend"),
    }
}

pub fn list_repo_labels(
    host: &str,
    login: &str,
    repos: &[String],
) -> Result<Vec<ForgeLabelOption>> {
    let login_name = gitea_login_name(Some(host), login)?;
    let mut out = std::collections::BTreeMap::<String, ForgeLabelOption>::new();
    for repo in repos {
        let (owner, name) = match split_repo(repo) {
            Ok(parts) => parts,
            Err(_) => continue,
        };
        let path = format!("/repos/{owner}/{name}/labels");
        let output = tea_api(&login_name, [path.as_str()])?;
        if !output.success {
            continue;
        }
        let labels = serde_json::from_str::<Vec<GiteaLabel>>(&output.stdout)
            .context("Failed to decode Gitea labels")?;
        for label in labels {
            out.entry(label.name.clone()).or_insert(ForgeLabelOption {
                name: label.name,
                color: label.color,
                description: label.description,
            });
        }
    }
    Ok(out.into_values().collect())
}

fn fetch_issues(
    login: &str,
    page: u32,
    limit: usize,
    repo_filter: Option<&str>,
    filters: Option<InboxFilters>,
) -> Result<InboxPage> {
    let repo = repo_filter.ok_or_else(|| anyhow!("Gitea inbox requires a repository filter"))?;
    let (owner, name) = split_repo(repo)?;
    let mut query = vec![
        ("page", page.to_string()),
        ("limit", limit.to_string()),
        (
            "state",
            map_issue_state(filters.as_ref().and_then(|f| f.state)).to_string(),
        ),
        ("type", "issues".to_string()),
    ];
    if let Some(q) = filters
        .as_ref()
        .and_then(|f| f.query.as_deref())
        .filter(|q| !q.trim().is_empty())
    {
        query.push(("q", q.trim().to_string()));
    }
    if let Some(labels) = filters
        .as_ref()
        .and_then(|f| f.labels.as_deref())
        .filter(|value| !value.trim().is_empty())
    {
        query.push(("labels", labels.trim().to_string()));
    }
    if let Some(scope) = filters
        .as_ref()
        .and_then(|f| f.scope.as_deref())
        .and_then(|scopes| scopes.first())
    {
        match scope {
            InboxScopeFilter::Assigned => query.push(("assigned_by", "@me".to_string())),
            InboxScopeFilter::Created => query.push(("created_by", "@me".to_string())),
            InboxScopeFilter::Mentioned => query.push(("mentioned_by", "@me".to_string())),
            _ => {}
        }
    }

    let path = format!("/repos/{owner}/{name}/issues?{}", encode_query(&query));
    let output = tea_api(login, [path.as_str()])?;
    if !output.success {
        let detail = command_detail(&output);
        if looks_like_auth_error(&detail) {
            return Ok(InboxPage {
                items: Vec::new(),
                next_cursor: None,
            });
        }
        return Err(anyhow!("Gitea issues lookup failed: {detail}"));
    }
    let issues = serde_json::from_str::<Vec<GiteaIssue>>(&output.stdout)
        .context("Failed to decode Gitea issues list")?;
    let items: Vec<InboxItem> = issues
        .into_iter()
        .filter(|issue| issue.pull_request.is_none())
        .filter_map(|issue| {
            Some(InboxItem {
                id: format!("gitea_issue:{repo}#{}", issue.number),
                source: InboxSource::GiteaIssue,
                external_id: format!("{repo}#{}", issue.number),
                external_url: issue.html_url,
                title: issue.title,
                subtitle: Some(repo.to_string()),
                state: Some(issue_state(&issue.state)),
                last_activity_at: parse_ts(issue.updated_at.as_deref())?,
            })
        })
        .collect();
    Ok(InboxPage {
        next_cursor: (items.len() >= limit).then(|| encode_cursor(page + 1)),
        items,
    })
}

fn fetch_prs(
    login: &str,
    page: u32,
    limit: usize,
    repo_filter: Option<&str>,
    filters: Option<InboxFilters>,
) -> Result<InboxPage> {
    let repo = repo_filter.ok_or_else(|| anyhow!("Gitea inbox requires a repository filter"))?;
    let (owner, name) = split_repo(repo)?;
    let mut query = vec![
        ("page", page.to_string()),
        ("limit", limit.to_string()),
        (
            "state",
            map_pr_state(filters.as_ref().and_then(|f| f.state)).to_string(),
        ),
    ];
    if let Some(sort) = filters.as_ref().and_then(|f| f.sort) {
        query.push(("sort", map_pr_sort(sort).to_string()));
    }
    let path = format!("/repos/{owner}/{name}/pulls?{}", encode_query(&query));
    let output = tea_api(login, [path.as_str()])?;
    if !output.success {
        let detail = command_detail(&output);
        if looks_like_auth_error(&detail) {
            return Ok(InboxPage {
                items: Vec::new(),
                next_cursor: None,
            });
        }
        return Err(anyhow!("Gitea pull request lookup failed: {detail}"));
    }
    let mut prs = serde_json::from_str::<Vec<GiteaPullRequest>>(&output.stdout)
        .context("Failed to decode Gitea pull request list")?;
    if let Some(q) = filters
        .as_ref()
        .and_then(|f| f.query.as_deref())
        .filter(|q| !q.trim().is_empty())
    {
        let query_lower = q.to_ascii_lowercase();
        prs.retain(|pr| {
            pr.title.to_ascii_lowercase().contains(&query_lower)
                || pr
                    .body
                    .as_deref()
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .contains(&query_lower)
        });
    }
    match filters.as_ref().and_then(|f| f.draft) {
        Some(InboxDraftFilter::Exclude) => prs.retain(|pr| !pr.draft.unwrap_or(false)),
        Some(InboxDraftFilter::Only) => prs.retain(|pr| pr.draft.unwrap_or(false)),
        _ => {}
    }
    let items: Vec<InboxItem> = prs
        .into_iter()
        .filter_map(|pr| {
            let state = pr_state(&pr);
            let last_activity_at = parse_ts(pr.updated_at.as_deref())?;
            Some(InboxItem {
                id: format!("gitea_pr:{repo}#{}", pr.number),
                source: InboxSource::GiteaPr,
                external_id: format!("{repo}#{}", pr.number),
                external_url: pr.html_url,
                title: pr.title,
                subtitle: Some(repo.to_string()),
                state: Some(state),
                last_activity_at,
            })
        })
        .collect();
    Ok(InboxPage {
        next_cursor: (items.len() >= limit).then(|| encode_cursor(page + 1)),
        items,
    })
}

fn map_issue_state(filter: Option<InboxStateFilter>) -> &'static str {
    match filter {
        Some(InboxStateFilter::Closed) => "closed",
        Some(InboxStateFilter::All) => "all",
        _ => "open",
    }
}

fn map_pr_state(filter: Option<InboxStateFilter>) -> &'static str {
    match filter {
        Some(InboxStateFilter::Closed) | Some(InboxStateFilter::Merged) => "closed",
        Some(InboxStateFilter::All) => "all",
        _ => "open",
    }
}

fn map_pr_sort(sort: InboxSortFilter) -> &'static str {
    match sort {
        InboxSortFilter::Created => "oldest",
        InboxSortFilter::Comments => "mostcomment",
        InboxSortFilter::Updated => "recentupdate",
    }
}

fn issue_state(state: &str) -> InboxState {
    match state {
        "open" => InboxState {
            label: "Open".to_string(),
            tone: InboxStateTone::Open,
        },
        "closed" => InboxState {
            label: "Closed".to_string(),
            tone: InboxStateTone::Closed,
        },
        _ => InboxState {
            label: state.to_string(),
            tone: InboxStateTone::Neutral,
        },
    }
}

fn pr_state(pr: &GiteaPullRequest) -> InboxState {
    if pr.merged.unwrap_or(false) {
        return InboxState {
            label: "Merged".to_string(),
            tone: InboxStateTone::Merged,
        };
    }
    if pr.draft.unwrap_or(false) && pr.state == "open" {
        return InboxState {
            label: "Draft".to_string(),
            tone: InboxStateTone::Draft,
        };
    }
    issue_state(&pr.state)
}

fn split_repo(repo: &str) -> Result<(String, String)> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| anyhow!("Invalid Gitea repo slug: {repo}"))?;
    Ok((owner.to_string(), name.to_string()))
}

fn gitea_login_name(host: Option<&str>, login: &str) -> Result<String> {
    resolve_login_name(host, login)?.ok_or_else(|| {
        anyhow!(
            "No Gitea login found for {}",
            host.unwrap_or("configured host")
        )
    })
}

fn parse_repo_number(external_id: &str) -> Result<(String, i64)> {
    let (repo, number) = external_id
        .rsplit_once('#')
        .ok_or_else(|| anyhow!("Invalid Gitea external id: {external_id}"))?;
    Ok((repo.to_string(), number.parse()?))
}

fn parse_ts(value: Option<&str>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|value| value.timestamp_millis())
}

fn encode_query(values: &[(impl AsRef<str>, impl AsRef<str>)]) -> String {
    values
        .iter()
        .map(|(k, v)| {
            format!(
                "{}={}",
                encode_query_value(k.as_ref()),
                encode_query_value(v.as_ref())
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn decode_cursor(cursor: Option<&str>) -> Result<GiteaCursor> {
    let Some(raw) = cursor else {
        return Ok(GiteaCursor { page: 1 });
    };
    let bytes = URL_SAFE_NO_PAD.decode(raw)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn encode_cursor(page: u32) -> String {
    URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&GiteaCursor { page }).expect("serialize gitea cursor"))
}
