//! GitHub inbox source. Fans out the user's involved-issues / involved-PRs
//! / involved-discussions across one `gh` login via three GraphQL search
//! queries, then merges into a single recency-sorted page.
//!
//! Pagination model: each kind keeps its own GraphQL `endCursor`. The
//! frontend cursor is a JSON-encoded `MultiCursor { issues, prs,
//! discussions }`, treated as opaque on the JS side. Each page request
//! fetches the next batch from each kind that's still ongoing, merges
//! by `updatedAt` desc, and returns the top `limit` items.

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

use super::{
    accounts as gh_accounts,
    api::{looks_like_auth_rejection, run_graphql, GraphqlOutcome, GITHUB_HOST},
};
use crate::forge::command::{command_detail, CommandOutput};

/// Per-kind toggle the user picks in Settings → Inbox.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxToggles {
    pub issues: bool,
    pub prs: bool,
    pub discussions: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxFilters {
    pub query: Option<String>,
    pub state: Option<InboxStateFilter>,
    pub scope: Option<Vec<InboxScopeFilter>>,
    pub sort: Option<InboxSortFilter>,
    pub draft: Option<InboxDraftFilter>,
    pub labels: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxStateFilter {
    Open,
    Closed,
    Merged,
    All,
    Answered,
    Unanswered,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Ord, PartialOrd, Hash)]
#[serde(rename_all = "camelCase")]
pub enum InboxScopeFilter {
    Involves,
    Assigned,
    Mentioned,
    Created,
    Author,
    Assignee,
    Mentions,
    ReviewRequested,
    ReviewedBy,
    All,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxSortFilter {
    Updated,
    Created,
    Comments,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxDraftFilter {
    Exclude,
    Include,
    Only,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubLabelOption {
    pub name: String,
    pub color: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubLabelRestResponse {
    name: String,
    color: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPage {
    pub items: Vec<InboxItem>,
    /// Opaque cursor — null when no more items in any source. Pass back
    /// verbatim to fetch the next page.
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    /// Stable, source-prefixed key safe to use as React key + chip key.
    pub id: String,
    pub source: InboxSource,
    pub external_id: String,
    pub external_url: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub state: Option<InboxState>,
    /// Unix milliseconds — already converted from ISO 8601 in the
    /// adapter so the frontend's "Xh ago" formatter works directly.
    pub last_activity_at: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InboxSource {
    GithubIssue,
    GithubPr,
    GithubDiscussion,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxState {
    pub label: String,
    pub tone: InboxStateTone,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxStateTone {
    Open,
    Closed,
    Merged,
    Draft,
    Answered,
    Unanswered,
    Urgent,
    Neutral,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum InboxItemDetail {
    GithubIssue(Box<GithubIssueDetail>),
    GithubPr(Box<GithubPullRequestDetail>),
    GithubDiscussion(Box<GithubDiscussionDetail>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueDetail {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub state: String,
    pub state_reason: Option<String>,
    pub author_login: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub closed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullRequestDetail {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub state: String,
    pub merged: bool,
    pub draft: bool,
    pub author_login: Option<String>,
    pub base_ref_name: Option<String>,
    pub head_ref_name: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDiscussionDetail {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub answered: Option<bool>,
    pub author_login: Option<String>,
    pub category_name: Option<String>,
    pub category_emoji: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Validate `owner/name` shape so we can splice it directly into a
/// search query string. Reject anything that could escape the qualifier
/// (whitespace, quotes, search operators) — GitHub repository names are
/// `[A-Za-z0-9._-]` and owner logins are `[A-Za-z0-9-]`.
fn sanitize_repo_filter(filter: &str) -> Option<String> {
    let trimmed = filter.trim();
    // Reject anything beyond a single owner/name pair so whitespace +
    // search-operator chars in the middle (e.g. `foo /bar`,
    // `foo/bar OR is:pr`) can't leak through and broaden the query.
    let (owner, name) = trimmed.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    let valid = |s: &str, extra: &[char]| -> bool {
        s.chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
    };
    if !valid(owner, &['-', '_', '.']) || !valid(name, &['-', '_', '.']) {
        return None;
    }
    Some(format!("{owner}/{name}"))
}

/// Build the qualifier prefix `repo:owner/name ` (trailing space) when
/// the caller passed a repo filter; otherwise empty.
fn repo_qualifier(filter: Option<&str>) -> String {
    filter
        .and_then(sanitize_repo_filter)
        .map(|safe| format!("repo:{safe} "))
        .unwrap_or_default()
}

fn repo_filters_exact_reference(repo_filter: Option<&str>, reference_repo: &str) -> bool {
    repo_filter
        .and_then(sanitize_repo_filter)
        .is_some_and(|repo| !repo.eq_ignore_ascii_case(reference_repo))
}

fn sanitize_search_query(query: &str) -> Option<String> {
    let cleaned = query
        .trim()
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '"' | '\\' | ':') {
                ' '
            } else {
                c
            }
        })
        .collect::<String>();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed)
    }
}

fn search_qualifier(query: Option<&str>) -> String {
    query
        .and_then(sanitize_search_query)
        .map(|safe| format!("{safe} in:title,body "))
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExactIssuePrReference {
    repo_with_owner: String,
    owner: String,
    repo: String,
    number: i64,
    source: InboxSource,
}

fn parse_exact_issue_pr_reference(
    query: &str,
    repo_filter: Option<&str>,
    toggles: InboxToggles,
) -> Option<ExactIssuePrReference> {
    let trimmed = query.trim();
    if let Some(reference) = parse_exact_issue_pr_url(trimmed) {
        return Some(reference);
    }

    let source = exact_issue_pr_source_from_toggles(toggles)?;
    if let Some((repo_with_owner, number)) = trimmed.split_once('#') {
        if !repo_with_owner.is_empty() {
            let repo_with_owner = sanitize_repo_filter(repo_with_owner)?;
            let number = number.parse::<i64>().ok()?;
            let (owner, repo) = repo_with_owner.split_once('/')?;
            return Some(ExactIssuePrReference {
                repo_with_owner: repo_with_owner.clone(),
                owner: owner.to_string(),
                repo: repo.to_string(),
                number,
                source,
            });
        }
    }

    let number_text = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if !number_text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let repo_with_owner = repo_filter.and_then(sanitize_repo_filter)?;
    let number = number_text.parse::<i64>().ok()?;
    let (owner, repo) = repo_with_owner.split_once('/')?;
    Some(ExactIssuePrReference {
        repo_with_owner: repo_with_owner.clone(),
        owner: owner.to_string(),
        repo: repo.to_string(),
        number,
        source,
    })
}

fn parse_exact_issue_pr_url(query: &str) -> Option<ExactIssuePrReference> {
    let without_scheme = match query.split_once("://") {
        Some((scheme, rest))
            if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") =>
        {
            rest
        }
        _ => query,
    };
    let (host, without_host) = without_scheme.split_once('/')?;
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let parts = without_host
        .split(['/', '?', '#'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let [owner, repo, kind, number, ..] = parts.as_slice() else {
        return None;
    };
    sanitize_repo_filter(&format!("{owner}/{repo}"))?;
    let source = match *kind {
        "issues" => InboxSource::GithubIssue,
        "pull" => InboxSource::GithubPr,
        _ => return None,
    };
    let number = number.parse::<i64>().ok()?;
    Some(ExactIssuePrReference {
        repo_with_owner: format!("{owner}/{repo}"),
        owner: (*owner).to_string(),
        repo: (*repo).to_string(),
        number,
        source,
    })
}

fn exact_issue_pr_source_from_toggles(toggles: InboxToggles) -> Option<InboxSource> {
    match (toggles.issues, toggles.prs) {
        (true, false) => Some(InboxSource::GithubIssue),
        (false, true) => Some(InboxSource::GithubPr),
        _ => None,
    }
}

fn labels_qualifier(labels: Option<&str>) -> String {
    let Some(labels) = labels else {
        return String::new();
    };
    labels
        .split(',')
        .filter_map(|label| {
            let cleaned = label
                .trim()
                .chars()
                .map(|c| {
                    if c.is_control() || matches!(c, '"' | '\\') {
                        ' '
                    } else {
                        c
                    }
                })
                .collect::<String>();
            let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
            (!collapsed.is_empty()).then(|| format!("label:\"{collapsed}\" "))
        })
        .collect::<String>()
}

fn state_qualifier(source: InboxSource, state: Option<InboxStateFilter>) -> &'static str {
    match (source, state) {
        (InboxSource::GithubIssue, Some(InboxStateFilter::Open)) => "is:open ",
        (InboxSource::GithubIssue, Some(InboxStateFilter::Closed)) => "is:closed ",
        (InboxSource::GithubPr, Some(InboxStateFilter::Open)) => "is:open ",
        (InboxSource::GithubPr, Some(InboxStateFilter::Closed)) => "is:closed is:unmerged ",
        (InboxSource::GithubPr, Some(InboxStateFilter::Merged)) => "is:merged ",
        (InboxSource::GithubDiscussion, Some(InboxStateFilter::Answered)) => "is:answered ",
        (InboxSource::GithubDiscussion, Some(InboxStateFilter::Unanswered)) => "is:unanswered ",
        _ => "",
    }
}

fn scope_qualifier(source: InboxSource, scope: Option<InboxScopeFilter>) -> &'static str {
    match (source, scope) {
        (_, None | Some(InboxScopeFilter::All)) => "",
        (_, Some(InboxScopeFilter::Involves)) => "involves:@me ",
        (InboxSource::GithubIssue, Some(InboxScopeFilter::Assigned)) => "assignee:@me ",
        (InboxSource::GithubIssue, Some(InboxScopeFilter::Mentioned)) => "mentions:@me ",
        (InboxSource::GithubIssue, Some(InboxScopeFilter::Created)) => "author:@me ",
        (InboxSource::GithubPr, Some(InboxScopeFilter::Author)) => "author:@me ",
        (InboxSource::GithubPr, Some(InboxScopeFilter::Assignee)) => "assignee:@me ",
        (InboxSource::GithubPr, Some(InboxScopeFilter::Mentions)) => "mentions:@me ",
        (InboxSource::GithubPr, Some(InboxScopeFilter::ReviewRequested)) => "review-requested:@me ",
        (InboxSource::GithubPr, Some(InboxScopeFilter::ReviewedBy)) => "reviewed-by:@me ",
        _ => "",
    }
}

fn scope_key(scope: Option<InboxScopeFilter>) -> String {
    match scope {
        Some(scope) => format!("{scope:?}"),
        None => "default".to_string(),
    }
}

fn source_scopes(
    source: InboxSource,
    scopes: Option<&[InboxScopeFilter]>,
) -> Vec<Option<InboxScopeFilter>> {
    let Some(scopes) = scopes else {
        return vec![None];
    };
    let mut out: Vec<Option<InboxScopeFilter>> = scopes
        .iter()
        .copied()
        .filter(|scope| {
            matches!(
                (source, scope),
                (_, InboxScopeFilter::All)
                    | (_, InboxScopeFilter::Involves)
                    | (InboxSource::GithubIssue, InboxScopeFilter::Assigned)
                    | (InboxSource::GithubIssue, InboxScopeFilter::Mentioned)
                    | (InboxSource::GithubIssue, InboxScopeFilter::Created)
                    | (InboxSource::GithubPr, InboxScopeFilter::Author)
                    | (InboxSource::GithubPr, InboxScopeFilter::Assignee)
                    | (InboxSource::GithubPr, InboxScopeFilter::Mentions)
                    | (InboxSource::GithubPr, InboxScopeFilter::ReviewRequested)
                    | (InboxSource::GithubPr, InboxScopeFilter::ReviewedBy)
            )
        })
        .map(Some)
        .collect();
    out.sort();
    out.dedup();
    if out.is_empty() {
        vec![None]
    } else {
        out
    }
}

fn draft_qualifier(draft: Option<InboxDraftFilter>) -> &'static str {
    match draft {
        Some(InboxDraftFilter::Exclude) => "-is:draft ",
        Some(InboxDraftFilter::Only) => "is:draft ",
        Some(InboxDraftFilter::Include) | None => "",
    }
}

fn sort_qualifier(sort: Option<InboxSortFilter>) -> &'static str {
    match sort {
        Some(InboxSortFilter::Created) => "sort:created-desc",
        Some(InboxSortFilter::Comments) => "sort:comments-desc",
        Some(InboxSortFilter::Updated) | None => "sort:updated-desc",
    }
}

fn discussion_sort_qualifier(sort: Option<InboxSortFilter>) -> &'static str {
    match sort {
        Some(InboxSortFilter::Created) => "sort:created-desc",
        Some(InboxSortFilter::Updated | InboxSortFilter::Comments) | None => "sort:updated-desc",
    }
}

/// Public entry point — driven by the `list_inbox_items` Tauri command.
pub fn list_inbox_items(
    login: &str,
    toggles: InboxToggles,
    cursor: Option<&str>,
    limit: usize,
    repo_filter: Option<&str>,
    filters: Option<InboxFilters>,
) -> Result<InboxPage> {
    let limit = limit.clamp(1, 100);
    let exact_reference = filters
        .as_ref()
        .and_then(|filters| filters.query.as_deref())
        .and_then(|query| parse_exact_issue_pr_reference(query, repo_filter, toggles));
    if let Some(reference) = exact_reference {
        return list_exact_issue_pr_reference(
            login,
            toggles,
            repo_filter,
            filters.as_ref(),
            reference,
        );
    }
    let mut state = decode_cursor(cursor)?;
    if !toggles.issues {
        state.issues.done = true;
    }
    if !toggles.prs {
        state.prs.done = true;
    }
    if !toggles.discussions {
        state.discussions.done = true;
    }
    let repo_qual = repo_qualifier(repo_filter);
    let search_qual = search_qualifier(
        filters
            .as_ref()
            .and_then(|filters| filters.query.as_deref()),
    );
    let labels_qual = labels_qualifier(
        filters
            .as_ref()
            .and_then(|filters| filters.labels.as_deref()),
    );
    let state_filter = filters.as_ref().and_then(|filters| filters.state);
    let scope_filters = filters
        .as_ref()
        .and_then(|filters| filters.scope.as_deref());
    let sort_qual = sort_qualifier(filters.as_ref().and_then(|filters| filters.sort));
    let discussion_sort_qual =
        discussion_sort_qualifier(filters.as_ref().and_then(|filters| filters.sort));
    let draft_filter = filters.as_ref().and_then(|filters| filters.draft);

    tracing::debug!(
        target: "helmor::inbox",
        login,
        ?toggles,
        ?state,
        limit,
        repo_filter,
        query_filter = filters.as_ref().and_then(|filters| filters.query.as_deref()),
        state_filter = ?state_filter,
        "list_inbox_items: starting page"
    );

    let mut items: Vec<InboxItem> = Vec::new();
    let discussion_scope_qual = if repo_qual.is_empty() {
        "involves:@me "
    } else {
        ""
    };

    if toggles.issues && !state.issues.done {
        let scopes = source_scopes(InboxSource::GithubIssue, scope_filters);
        let mut all_done = true;
        for scope in scopes {
            let scope_key = scope_key(scope);
            let cursor_entry = state
                .issue_scopes
                .entry(scope_key.clone())
                .or_insert_with(MultiCursorEntry::default);
            if cursor_entry.done {
                continue;
            }
            let q = format!(
                "{repo_qual}{search_qual}{labels_qual}is:issue {}{}archived:false",
                state_qualifier(InboxSource::GithubIssue, state_filter),
                scope_qualifier(InboxSource::GithubIssue, scope)
            );
            match fetch_search(login, &q, &cursor_entry.cursor, sort_qual)? {
                FetchOutcome::Auth => {
                    tracing::warn!(target: "helmor::inbox", login, "issues search: auth required");
                    return Ok(InboxPage {
                        items: Vec::new(),
                        next_cursor: None,
                    });
                }
                FetchOutcome::Ok(page) => {
                    tracing::debug!(
                        target: "helmor::inbox",
                        login,
                        fetched = page.nodes.len(),
                        has_next = page.has_next_page,
                        scope = scope_key,
                        "issues search results"
                    );
                    items.extend(
                        page.nodes
                            .into_iter()
                            .filter_map(|n| issue_or_pr_to_item(n, false)),
                    );
                    *cursor_entry = MultiCursorEntry {
                        cursor: page.end_cursor,
                        done: !page.has_next_page,
                    };
                    if !cursor_entry.done {
                        all_done = false;
                    }
                }
            }
        }
        state.issues.done = all_done;
    }

    if toggles.prs && !state.prs.done {
        let scopes = source_scopes(InboxSource::GithubPr, scope_filters);
        let mut all_done = true;
        for scope in scopes {
            let scope_key = scope_key(scope);
            let cursor_entry = state
                .pr_scopes
                .entry(scope_key.clone())
                .or_insert_with(MultiCursorEntry::default);
            if cursor_entry.done {
                continue;
            }
            let q = format!(
                "{repo_qual}{search_qual}{labels_qual}is:pr {}{}{}archived:false",
                state_qualifier(InboxSource::GithubPr, state_filter),
                scope_qualifier(InboxSource::GithubPr, scope),
                draft_qualifier(draft_filter)
            );
            match fetch_search(login, &q, &cursor_entry.cursor, sort_qual)? {
                FetchOutcome::Auth => {
                    tracing::warn!(target: "helmor::inbox", login, "prs search: auth required");
                    return Ok(InboxPage {
                        items: Vec::new(),
                        next_cursor: None,
                    });
                }
                FetchOutcome::Ok(page) => {
                    tracing::debug!(
                        target: "helmor::inbox",
                        login,
                        fetched = page.nodes.len(),
                        has_next = page.has_next_page,
                        scope = scope_key,
                        "prs search results"
                    );
                    items.extend(
                        page.nodes
                            .into_iter()
                            .filter_map(|n| issue_or_pr_to_item(n, true)),
                    );
                    *cursor_entry = MultiCursorEntry {
                        cursor: page.end_cursor,
                        done: !page.has_next_page,
                    };
                    if !cursor_entry.done {
                        all_done = false;
                    }
                }
            }
        }
        state.prs.done = all_done;
    }

    if toggles.discussions && !state.discussions.done {
        match fetch_discussion_search(
            login,
            &state.discussions.cursor,
            &repo_qual,
            &search_qual,
            state_qualifier(InboxSource::GithubDiscussion, state_filter),
            discussion_scope_qual,
            discussion_sort_qual,
        )? {
            FetchOutcome::Auth => {
                tracing::warn!(target: "helmor::inbox", login, "discussions search: auth required");
            }
            FetchOutcome::Ok(page) => {
                tracing::debug!(
                    target: "helmor::inbox",
                    login,
                    fetched = page.nodes.len(),
                    has_next = page.has_next_page,
                    "discussions search results"
                );
                items.extend(page.nodes.into_iter().filter_map(discussion_to_item));
                state.discussions = MultiCursorEntry {
                    cursor: page.end_cursor,
                    done: !page.has_next_page,
                };
            }
        }
    }

    let mut seen = HashSet::new();
    items.retain(|item| seen.insert(item.id.clone()));
    items.sort_by_key(|item| std::cmp::Reverse(item.last_activity_at));
    items.truncate(limit);

    let everything_done = state.issues.done && state.prs.done && state.discussions.done;
    let next_cursor = if everything_done && items.is_empty() {
        None
    } else if everything_done {
        // Last page — no more cursor.
        None
    } else {
        Some(encode_cursor(&state)?)
    };

    tracing::debug!(
        target: "helmor::inbox",
        login,
        returned = items.len(),
        has_next_cursor = next_cursor.is_some(),
        "list_inbox_items: page ready"
    );

    Ok(InboxPage { items, next_cursor })
}

/// Detail entry point for a single GitHub inbox item. The command shape
/// is in place so each source can grow its native detail query without
/// forcing a shared cross-provider schema.
pub fn get_inbox_item_detail(
    login: &str,
    source: InboxSource,
    external_id: &str,
) -> Result<Option<InboxItemDetail>> {
    match source {
        InboxSource::GithubIssue => fetch_issue_detail(login, external_id),
        InboxSource::GithubPr => fetch_pull_request_detail(login, external_id),
        InboxSource::GithubDiscussion => fetch_discussion_detail(login, external_id),
    }
}

pub fn list_github_labels(login: &str, repos: &[String]) -> Result<Vec<GithubLabelOption>> {
    let mut labels_by_name = BTreeMap::<String, GithubLabelOption>::new();
    for repo in repos.iter().filter_map(|repo| sanitize_repo_filter(repo)) {
        let path = format!("/repos/{repo}/labels?per_page=100");
        let raw = match run_github_api(login, &path, "repository labels") {
            Ok(Some(raw)) => raw,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(
                    target: "helmor::inbox",
                    login,
                    repo,
                    error = %error,
                    "failed to load GitHub labels for repo"
                );
                continue;
            }
        };
        let labels = match serde_json::from_str::<Vec<GithubLabelRestResponse>>(&raw) {
            Ok(labels) => labels,
            Err(error) => {
                tracing::warn!(
                    target: "helmor::inbox",
                    login,
                    repo,
                    error = %error,
                    "failed to parse GitHub labels for repo"
                );
                continue;
            }
        };
        for label in labels {
            labels_by_name
                .entry(label.name.clone())
                .or_insert(GithubLabelOption {
                    name: label.name,
                    color: label.color,
                    description: label.description,
                });
        }
    }
    Ok(labels_by_name.into_values().collect())
}

fn fetch_pull_request_detail(login: &str, external_id: &str) -> Result<Option<InboxItemDetail>> {
    let (owner, repo, number) = parse_external_reference(external_id)?;
    let path = format!("/repos/{owner}/{repo}/pulls/{number}");
    let Some(stdout) = run_github_api(login, &path, "GitHub PR detail")? else {
        return Ok(None);
    };
    let response = serde_json::from_str::<PullRequestRestResponse>(&stdout)
        .with_context(|| "Failed to decode GitHub PR detail response".to_string())?;
    Ok(Some(InboxItemDetail::GithubPr(Box::new(
        GithubPullRequestDetail {
            external_id: external_id.to_string(),
            title: response.title,
            body: response.body,
            url: response.html_url,
            state: response.state,
            merged: response.merged,
            draft: response.draft.unwrap_or(false),
            author_login: response.user.map(|user| user.login),
            base_ref_name: response.base.map(|base| base.ref_name),
            head_ref_name: response.head.map(|head| head.ref_name),
            created_at: response.created_at,
            updated_at: response.updated_at,
        },
    ))))
}

fn fetch_issue_detail(login: &str, external_id: &str) -> Result<Option<InboxItemDetail>> {
    let (owner, repo, number) = parse_external_reference(external_id)?;
    let path = format!("/repos/{owner}/{repo}/issues/{number}");
    let Some(stdout) = run_github_api(login, &path, "GitHub issue detail")? else {
        return Ok(None);
    };
    let response = serde_json::from_str::<IssueRestResponse>(&stdout)
        .with_context(|| "Failed to decode GitHub issue detail response".to_string())?;
    Ok(Some(InboxItemDetail::GithubIssue(Box::new(
        GithubIssueDetail {
            external_id: external_id.to_string(),
            title: response.title,
            body: response.body,
            url: response.html_url,
            state: response.state,
            state_reason: response.state_reason,
            author_login: response.user.map(|user| user.login),
            created_at: response.created_at,
            updated_at: response.updated_at,
            closed_at: response.closed_at,
        },
    ))))
}

fn fetch_discussion_detail(login: &str, external_id: &str) -> Result<Option<InboxItemDetail>> {
    let (owner, repo, number) = parse_external_reference(external_id)?;
    let args = vec![
        "api".to_string(),
        "--hostname".to_string(),
        GITHUB_HOST.to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={DISCUSSION_DETAIL_QUERY}"),
        "-f".to_string(),
        format!("owner={owner}"),
        "-f".to_string(),
        format!("name={repo}"),
        "-F".to_string(),
        format!("number={number}"),
    ];
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = match gh_accounts::run_cli_with_login(GITHUB_HOST, login, &arg_refs) {
        Ok(output) => output,
        Err(error) => {
            let message = format!("{error:#}");
            if looks_like_auth_rejection(&message) {
                return Ok(None);
            }
            return Err(
                error.context("Failed to spawn `gh api graphql` for GitHub discussion detail")
            );
        }
    };

    if !output.success {
        let detail = command_detail(&output);
        if looks_like_auth_rejection(&detail) {
            return Ok(None);
        }
        return Err(anyhow!(
            "`gh api graphql` failed for GitHub discussion detail: {detail}"
        ));
    }

    let envelope = serde_json::from_str::<DiscussionDetailEnvelope>(&output.stdout)
        .with_context(|| "Failed to decode GitHub discussion detail response".to_string())?;
    if let Some(errors) = envelope.errors {
        if !errors.is_empty() {
            return Err(anyhow!(
                "GitHub discussion detail errors: {}",
                errors
                    .iter()
                    .map(|error| error.message.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
    }
    let Some(discussion) = envelope.data.and_then(|data| data.repository?.discussion) else {
        return Ok(None);
    };
    Ok(Some(InboxItemDetail::GithubDiscussion(Box::new(
        GithubDiscussionDetail {
            external_id: external_id.to_string(),
            title: discussion.title,
            body: discussion.body,
            url: discussion.url,
            answered: discussion.is_answered,
            author_login: discussion.author.map(|author| author.login),
            category_name: discussion
                .category
                .as_ref()
                .map(|category| category.name.clone()),
            category_emoji: discussion.category.and_then(|category| category.emoji),
            created_at: discussion.created_at,
            updated_at: discussion.updated_at,
        },
    ))))
}

fn run_github_api(login: &str, path: &str, label: &str) -> Result<Option<String>> {
    run_github_api_with_options(login, path, label, false)
}

fn run_github_api_allow_not_found(login: &str, path: &str, label: &str) -> Result<Option<String>> {
    run_github_api_with_options(login, path, label, true)
}

fn run_github_api_with_options(
    login: &str,
    path: &str,
    label: &str,
    not_found_as_empty: bool,
) -> Result<Option<String>> {
    let args = [
        "api",
        "--hostname",
        GITHUB_HOST,
        "-H",
        "Accept: application/vnd.github+json",
        path,
    ];
    let output = match gh_accounts::run_cli_with_login(GITHUB_HOST, login, &args) {
        Ok(output) => output,
        Err(error) => {
            let message = format!("{error:#}");
            if looks_like_auth_rejection(&message) {
                return Ok(None);
            }
            return Err(error.context(format!("Failed to spawn `gh api` for {label}")));
        }
    };

    if output.success {
        return Ok(Some(output.stdout));
    }

    let detail = command_detail(&output);
    if looks_like_auth_rejection(&detail)
        || (not_found_as_empty && looks_like_not_found(&output, &detail))
    {
        return Ok(None);
    }
    Err(anyhow!("`gh api` failed for {label}: {detail}"))
}

fn looks_like_not_found(output: &CommandOutput, detail: &str) -> bool {
    output.status == Some(1)
        && (detail.contains("HTTP 404")
            || detail.contains("404 Not Found")
            || detail.contains("Not Found (HTTP 404)"))
}

fn exact_issue_matches_filters(
    login: &str,
    issue: &IssueRestResponse,
    filters: Option<&InboxFilters>,
) -> bool {
    if exact_issue_payload_is_pull_request(issue) {
        return false;
    }
    let Some(filters) = filters else {
        return true;
    };
    let state = issue.state.to_ascii_uppercase();
    exact_state_matches(InboxSource::GithubIssue, filters.state, &state, false)
        && exact_labels_match(filters.labels.as_deref(), &issue.labels)
        && exact_issue_scopes_match(login, filters.scope.as_deref(), issue)
}

fn exact_issue_payload_is_pull_request(issue: &IssueRestResponse) -> bool {
    issue.pull_request.is_some()
}

fn exact_pull_request_matches_filters(
    login: &str,
    pull_request: &PullRequestRestResponse,
    filters: Option<&InboxFilters>,
) -> bool {
    let Some(filters) = filters else {
        return true;
    };
    let state = pull_request.state.to_ascii_uppercase();
    let is_draft = pull_request.draft.unwrap_or(false);
    exact_state_matches(
        InboxSource::GithubPr,
        filters.state,
        &state,
        pull_request.merged,
    ) && exact_draft_matches(filters.draft, is_draft)
        && exact_labels_match(filters.labels.as_deref(), &pull_request.labels)
        && exact_pull_request_scopes_match(login, filters.scope.as_deref(), pull_request)
}

fn exact_state_matches(
    source: InboxSource,
    state_filter: Option<InboxStateFilter>,
    state: &str,
    merged: bool,
) -> bool {
    match (source, state_filter) {
        (_, None | Some(InboxStateFilter::All)) => true,
        (InboxSource::GithubIssue, Some(InboxStateFilter::Open)) => state == "OPEN",
        (InboxSource::GithubIssue, Some(InboxStateFilter::Closed)) => state == "CLOSED",
        (InboxSource::GithubPr, Some(InboxStateFilter::Open)) => state == "OPEN" && !merged,
        (InboxSource::GithubPr, Some(InboxStateFilter::Closed)) => state == "CLOSED" && !merged,
        (InboxSource::GithubPr, Some(InboxStateFilter::Merged)) => merged,
        _ => false,
    }
}

fn exact_draft_matches(draft_filter: Option<InboxDraftFilter>, is_draft: bool) -> bool {
    match draft_filter {
        Some(InboxDraftFilter::Exclude) => !is_draft,
        Some(InboxDraftFilter::Only) => is_draft,
        Some(InboxDraftFilter::Include) | None => true,
    }
}

fn exact_labels_match(labels_filter: Option<&str>, labels: &[GithubRestLabel]) -> bool {
    let Some(labels_filter) = labels_filter else {
        return true;
    };
    let required = labels_filter
        .split(',')
        .filter_map(|label| {
            let label = label.trim();
            (!label.is_empty()).then(|| label.to_ascii_lowercase())
        })
        .collect::<Vec<_>>();
    if required.is_empty() {
        return true;
    }
    let present = labels
        .iter()
        .map(|label| label.name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    required.iter().all(|label| present.contains(label))
}

fn exact_scope_filters_match<F>(
    scope_filters: Option<&[InboxScopeFilter]>,
    mut matches_scope: F,
) -> bool
where
    F: FnMut(InboxScopeFilter) -> bool,
{
    let Some(scope_filters) = scope_filters else {
        return true;
    };
    if scope_filters.is_empty() {
        return true;
    }
    scope_filters
        .iter()
        .copied()
        .any(|scope| matches!(scope, InboxScopeFilter::All) || matches_scope(scope))
}

fn exact_issue_scopes_match(
    login: &str,
    scope_filters: Option<&[InboxScopeFilter]>,
    issue: &IssueRestResponse,
) -> bool {
    exact_scope_filters_match(scope_filters, |scope| match scope {
        InboxScopeFilter::Assigned | InboxScopeFilter::Assignee => issue
            .assignees
            .iter()
            .any(|user| user.login.eq_ignore_ascii_case(login)),
        InboxScopeFilter::Created | InboxScopeFilter::Author => issue
            .user
            .as_ref()
            .is_some_and(|user| user.login.eq_ignore_ascii_case(login)),
        // The issue REST payload proves author/assignee but not every
        // `involves:@me` case (comments, mentions, review activity). For an
        // exact pasted URL, avoid a false-empty result when the active scope
        // depends on those search-only relationships.
        InboxScopeFilter::Involves | InboxScopeFilter::Mentioned | InboxScopeFilter::Mentions => {
            true
        }
        InboxScopeFilter::ReviewRequested
        | InboxScopeFilter::ReviewedBy
        | InboxScopeFilter::All => false,
    })
}

fn exact_pull_request_scopes_match(
    login: &str,
    scope_filters: Option<&[InboxScopeFilter]>,
    pull_request: &PullRequestRestResponse,
) -> bool {
    exact_scope_filters_match(scope_filters, |scope| match scope {
        InboxScopeFilter::Author | InboxScopeFilter::Created => pull_request
            .user
            .as_ref()
            .is_some_and(|user| user.login.eq_ignore_ascii_case(login)),
        InboxScopeFilter::Assignee | InboxScopeFilter::Assigned => pull_request
            .assignees
            .iter()
            .any(|user| user.login.eq_ignore_ascii_case(login)),
        InboxScopeFilter::ReviewRequested => pull_request
            .requested_reviewers
            .iter()
            .any(|user| user.login.eq_ignore_ascii_case(login)),
        // The PR REST payload does not include all search relationships for
        // `involves:@me`, mentions, or reviews by the user. Enforcing those
        // here would hide exact pasted URLs that normal GitHub search finds.
        InboxScopeFilter::Involves
        | InboxScopeFilter::Mentioned
        | InboxScopeFilter::Mentions
        | InboxScopeFilter::ReviewedBy => true,
        InboxScopeFilter::All => true,
    })
}

fn list_exact_issue_pr_reference(
    login: &str,
    toggles: InboxToggles,
    repo_filter: Option<&str>,
    filters: Option<&InboxFilters>,
    reference: ExactIssuePrReference,
) -> Result<InboxPage> {
    if repo_filters_exact_reference(repo_filter, &reference.repo_with_owner) {
        return Ok(InboxPage {
            items: Vec::new(),
            next_cursor: None,
        });
    }

    let item = match reference.source {
        InboxSource::GithubIssue if toggles.issues => {
            fetch_exact_issue_item(login, &reference, filters)?
        }
        InboxSource::GithubPr if toggles.prs => {
            fetch_exact_pull_request_item(login, &reference, filters)?
        }
        _ => None,
    };

    Ok(InboxPage {
        items: item.into_iter().collect(),
        next_cursor: None,
    })
}

fn fetch_exact_pull_request_item(
    login: &str,
    reference: &ExactIssuePrReference,
    filters: Option<&InboxFilters>,
) -> Result<Option<InboxItem>> {
    let path = format!(
        "/repos/{}/{}/pulls/{}",
        reference.owner, reference.repo, reference.number
    );
    let Some(stdout) = run_github_api_allow_not_found(login, &path, "GitHub PR search result")?
    else {
        return Ok(None);
    };
    let response = serde_json::from_str::<PullRequestRestResponse>(&stdout)
        .with_context(|| "Failed to decode GitHub PR search result".to_string())?;
    let state = response.state.to_ascii_uppercase();
    if !exact_pull_request_matches_filters(login, &response, filters) {
        return Ok(None);
    }
    Ok(Some(InboxItem {
        id: format!("github_pr:{}", response.node_id),
        source: InboxSource::GithubPr,
        external_id: format!("{}#{}", reference.repo_with_owner, reference.number),
        external_url: response.html_url,
        title: response.title,
        subtitle: Some(reference.repo_with_owner.clone()),
        state: Some(pr_state(
            &state,
            response.draft.unwrap_or(false),
            response.merged,
        )),
        last_activity_at: response
            .updated_at
            .as_deref()
            .and_then(parse_iso8601_to_ms)
            .unwrap_or(0),
    }))
}

fn fetch_exact_issue_item(
    login: &str,
    reference: &ExactIssuePrReference,
    filters: Option<&InboxFilters>,
) -> Result<Option<InboxItem>> {
    let path = format!(
        "/repos/{}/{}/issues/{}",
        reference.owner, reference.repo, reference.number
    );
    let Some(stdout) = run_github_api_allow_not_found(login, &path, "GitHub issue search result")?
    else {
        return Ok(None);
    };
    let response = serde_json::from_str::<IssueRestResponse>(&stdout)
        .with_context(|| "Failed to decode GitHub issue search result".to_string())?;
    let state = response.state.to_ascii_uppercase();
    let state_reason = response
        .state_reason
        .as_deref()
        .map(str::to_ascii_uppercase);
    if !exact_issue_matches_filters(login, &response, filters) {
        return Ok(None);
    }
    Ok(Some(InboxItem {
        id: format!("github_issue:{}", response.node_id),
        source: InboxSource::GithubIssue,
        external_id: format!("{}#{}", reference.repo_with_owner, reference.number),
        external_url: response.html_url,
        title: response.title,
        subtitle: Some(reference.repo_with_owner.clone()),
        state: Some(issue_state(&state, state_reason.as_deref())),
        last_activity_at: response
            .updated_at
            .as_deref()
            .and_then(parse_iso8601_to_ms)
            .unwrap_or(0),
    }))
}

fn parse_external_reference(external_id: &str) -> Result<(String, String, i64)> {
    let Some((repo_with_owner, number)) = external_id.rsplit_once('#') else {
        return Err(anyhow!("invalid GitHub PR reference: {external_id}"));
    };
    let Some((owner, repo)) = repo_with_owner.split_once('/') else {
        return Err(anyhow!("invalid GitHub PR repository: {external_id}"));
    };
    let number = number
        .parse::<i64>()
        .with_context(|| format!("invalid GitHub PR number in {external_id}"))?;
    Ok((owner.to_string(), repo.to_string(), number))
}

#[derive(Debug, Deserialize)]
struct PullRequestRestResponse {
    node_id: String,
    html_url: String,
    title: String,
    body: Option<String>,
    state: String,
    merged: bool,
    draft: Option<bool>,
    user: Option<PullRequestRestUser>,
    #[serde(default)]
    assignees: Vec<PullRequestRestUser>,
    #[serde(default)]
    requested_reviewers: Vec<PullRequestRestUser>,
    #[serde(default)]
    labels: Vec<GithubRestLabel>,
    base: Option<PullRequestRestRef>,
    head: Option<PullRequestRestRef>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PullRequestRestUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct PullRequestRestRef {
    #[serde(rename = "ref")]
    ref_name: String,
}

#[derive(Debug, Deserialize)]
struct IssueRestResponse {
    node_id: String,
    html_url: String,
    title: String,
    body: Option<String>,
    state: String,
    state_reason: Option<String>,
    user: Option<PullRequestRestUser>,
    #[serde(default)]
    assignees: Vec<PullRequestRestUser>,
    #[serde(default)]
    labels: Vec<GithubRestLabel>,
    pull_request: Option<serde_json::Value>,
    created_at: Option<String>,
    updated_at: Option<String>,
    closed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRestLabel {
    name: String,
}

#[derive(Debug, Deserialize)]
struct DiscussionDetailEnvelope {
    data: Option<DiscussionDetailData>,
    errors: Option<Vec<GraphqlSearchError>>,
}

#[derive(Debug, Deserialize)]
struct DiscussionDetailData {
    repository: Option<DiscussionDetailRepository>,
}

#[derive(Debug, Deserialize)]
struct DiscussionDetailRepository {
    discussion: Option<DiscussionDetailNode>,
}

#[derive(Debug, Deserialize)]
struct DiscussionDetailNode {
    title: String,
    body: Option<String>,
    url: String,
    #[serde(rename = "isAnswered")]
    is_answered: Option<bool>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    author: Option<DiscussionDetailAuthor>,
    category: Option<DiscussionCategory>,
}

#[derive(Debug, Deserialize)]
struct DiscussionDetailAuthor {
    login: String,
}

const DISCUSSION_DETAIL_QUERY: &str = r#"
query InboxDiscussionDetail($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      title
      body
      url
      isAnswered
      createdAt
      updatedAt
      author { login }
      category { name emoji }
    }
  }
}
"#;

/// Multi-source cursor — JSON-encoded under base64url so the frontend
/// treats it as opaque. Decoded server-side per page request.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct MultiCursor {
    #[serde(default)]
    issues: MultiCursorEntry,
    #[serde(default)]
    prs: MultiCursorEntry,
    #[serde(default)]
    discussions: MultiCursorEntry,
    #[serde(default)]
    issue_scopes: BTreeMap<String, MultiCursorEntry>,
    #[serde(default)]
    pr_scopes: BTreeMap<String, MultiCursorEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct MultiCursorEntry {
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    done: bool,
}

fn decode_cursor(cursor: Option<&str>) -> Result<MultiCursor> {
    let Some(raw) = cursor else {
        return Ok(MultiCursor::default());
    };
    if raw.is_empty() {
        return Ok(MultiCursor::default());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|e| anyhow!("invalid inbox cursor encoding: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| anyhow!("invalid inbox cursor JSON: {e}"))
}

fn encode_cursor(state: &MultiCursor) -> Result<String> {
    let json = serde_json::to_vec(state)?;
    Ok(URL_SAFE_NO_PAD.encode(&json))
}

const ISSUE_PR_SEARCH_QUERY: &str = r#"
query InboxIssuePrSearch($q: String!, $cursor: String) {
  search(type: ISSUE, query: $q, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue {
        id
        number
        title
        url
        state
        stateReason
        updatedAt
        repository { nameWithOwner }
      }
      ... on PullRequest {
        id
        number
        title
        url
        state
        isDraft
        merged
        updatedAt
        repository { nameWithOwner }
      }
    }
  }
}
"#;

const DISCUSSION_SEARCH_QUERY: &str = r#"
query InboxDiscussionSearch($q: String!, $cursor: String) {
  search(type: DISCUSSION, query: $q, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Discussion {
        id
        number
        title
        url
        updatedAt
        isAnswered
        repository { nameWithOwner }
        category { name emoji }
      }
    }
  }
}
"#;

enum FetchOutcome<T> {
    Ok(T),
    Auth,
}

#[derive(Debug)]
struct SearchPage<T> {
    nodes: Vec<T>,
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "__typename")]
enum IssueOrPrNode {
    Issue {
        id: String,
        number: i64,
        title: String,
        url: String,
        state: String,
        #[serde(rename = "stateReason")]
        state_reason: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        repository: RepoNameWithOwner,
    },
    PullRequest {
        id: String,
        number: i64,
        title: String,
        url: String,
        state: String,
        #[serde(rename = "isDraft")]
        is_draft: bool,
        merged: bool,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        repository: RepoNameWithOwner,
    },
    /// Unknown variants from `search(type: ISSUE)` are tolerated so the
    /// adapter stays forward-compatible (e.g. if GitHub adds new types).
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct DiscussionNode {
    #[allow(dead_code)]
    #[serde(rename = "__typename")]
    typename: Option<String>,
    #[allow(dead_code)]
    id: String,
    number: i64,
    title: String,
    url: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "isAnswered")]
    is_answered: Option<bool>,
    repository: RepoNameWithOwner,
    category: Option<DiscussionCategory>,
}

#[derive(Debug, Deserialize)]
struct DiscussionCategory {
    name: String,
    #[allow(dead_code)]
    emoji: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RepoNameWithOwner {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: String,
}

#[derive(Debug, Deserialize)]
struct GraphqlSearchEnvelope<T> {
    data: Option<GraphqlSearchData<T>>,
    errors: Option<Vec<GraphqlSearchError>>,
}

#[derive(Debug, Deserialize)]
struct GraphqlSearchData<T> {
    search: GraphqlSearchPayload<T>,
}

#[derive(Debug, Deserialize)]
struct GraphqlSearchPayload<T> {
    #[serde(rename = "pageInfo")]
    page_info: PageInfo,
    nodes: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct PageInfo {
    #[serde(rename = "hasNextPage")]
    has_next_page: bool,
    #[serde(rename = "endCursor")]
    end_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphqlSearchError {
    message: String,
}

fn fetch_search(
    login: &str,
    base_query: &str,
    cursor: &Option<String>,
    sort_qualifier: &str,
) -> Result<FetchOutcome<SearchPage<IssueOrPrNode>>> {
    let q = format!("{base_query} {sort_qualifier}");
    let cursor_arg = cursor.clone().unwrap_or_default();
    let mut variables: Vec<(&str, &str)> = vec![("q", q.as_str())];
    if !cursor_arg.is_empty() {
        variables.push(("cursor", cursor_arg.as_str()));
    }

    match run_graphql::<GraphqlSearchEnvelope<IssueOrPrNode>>(
        login,
        ISSUE_PR_SEARCH_QUERY,
        &variables,
    )? {
        GraphqlOutcome::Auth => Ok(FetchOutcome::Auth),
        GraphqlOutcome::Ok(envelope) => {
            if let Some(errors) = envelope.errors {
                if !errors.is_empty() {
                    return Err(anyhow!(
                        "GitHub search errors: {}",
                        errors
                            .iter()
                            .map(|e| e.message.as_str())
                            .collect::<Vec<_>>()
                            .join("; ")
                    ));
                }
            }
            let payload = envelope
                .data
                .ok_or_else(|| anyhow!("GitHub search returned no data"))?
                .search;
            Ok(FetchOutcome::Ok(SearchPage {
                nodes: payload.nodes,
                has_next_page: payload.page_info.has_next_page,
                end_cursor: payload.page_info.end_cursor,
            }))
        }
    }
}

fn fetch_discussion_search(
    login: &str,
    cursor: &Option<String>,
    repo_qual: &str,
    search_qual: &str,
    state_qual: &str,
    scope_qual: &str,
    sort_qualifier: &str,
) -> Result<FetchOutcome<SearchPage<DiscussionNode>>> {
    let q = format!("{repo_qual}{search_qual}{state_qual}{scope_qual}{sort_qualifier}");
    let cursor_arg = cursor.clone().unwrap_or_default();
    let mut variables: Vec<(&str, &str)> = vec![("q", q.as_str())];
    if !cursor_arg.is_empty() {
        variables.push(("cursor", cursor_arg.as_str()));
    }

    match run_graphql::<GraphqlSearchEnvelope<DiscussionNode>>(
        login,
        DISCUSSION_SEARCH_QUERY,
        &variables,
    )? {
        GraphqlOutcome::Auth => Ok(FetchOutcome::Auth),
        GraphqlOutcome::Ok(envelope) => {
            if let Some(errors) = envelope.errors {
                if !errors.is_empty() {
                    return Err(anyhow!(
                        "GitHub discussion search errors: {}",
                        errors
                            .iter()
                            .map(|e| e.message.as_str())
                            .collect::<Vec<_>>()
                            .join("; ")
                    ));
                }
            }
            let payload = envelope
                .data
                .ok_or_else(|| anyhow!("GitHub discussion search returned no data"))?
                .search;
            Ok(FetchOutcome::Ok(SearchPage {
                nodes: payload.nodes,
                has_next_page: payload.page_info.has_next_page,
                end_cursor: payload.page_info.end_cursor,
            }))
        }
    }
}

fn issue_or_pr_to_item(node: IssueOrPrNode, expect_pr: bool) -> Option<InboxItem> {
    match node {
        IssueOrPrNode::Issue {
            id,
            number,
            title,
            url,
            state,
            state_reason,
            updated_at,
            repository,
        } => {
            // The `is:issue` and `is:pr` query qualifiers mean we should
            // only ever see the right kind in each call; defensive skip
            // if not.
            if expect_pr {
                return None;
            }
            Some(InboxItem {
                id: format!("github_issue:{id}"),
                source: InboxSource::GithubIssue,
                external_id: format!("{}#{}", repository.name_with_owner, number),
                external_url: url,
                title,
                subtitle: Some(repository.name_with_owner.clone()),
                state: Some(issue_state(&state, state_reason.as_deref())),
                last_activity_at: parse_iso8601_to_ms(&updated_at)?,
            })
        }
        IssueOrPrNode::PullRequest {
            id,
            number,
            title,
            url,
            state,
            is_draft,
            merged,
            updated_at,
            repository,
        } => {
            if !expect_pr {
                return None;
            }
            Some(InboxItem {
                id: format!("github_pr:{id}"),
                source: InboxSource::GithubPr,
                external_id: format!("{}#{}", repository.name_with_owner, number),
                external_url: url,
                title,
                subtitle: Some(repository.name_with_owner.clone()),
                state: Some(pr_state(&state, is_draft, merged)),
                last_activity_at: parse_iso8601_to_ms(&updated_at)?,
            })
        }
        IssueOrPrNode::Other => None,
    }
}

fn discussion_to_item(node: DiscussionNode) -> Option<InboxItem> {
    let category_label = node.category.map(|c| c.name);
    let subtitle = match category_label {
        Some(cat) => Some(format!("{} · {}", node.repository.name_with_owner, cat)),
        None => Some(node.repository.name_with_owner.clone()),
    };
    let answered = node.is_answered.unwrap_or(false);
    Some(InboxItem {
        id: format!(
            "github_discussion:{}#{}",
            node.repository.name_with_owner, node.number
        ),
        source: InboxSource::GithubDiscussion,
        external_id: format!("{}#{}", node.repository.name_with_owner, node.number),
        external_url: node.url,
        title: node.title,
        subtitle,
        state: Some(if answered {
            InboxState {
                label: "Answered".to_string(),
                tone: InboxStateTone::Answered,
            }
        } else {
            InboxState {
                label: "Unanswered".to_string(),
                tone: InboxStateTone::Unanswered,
            }
        }),
        last_activity_at: parse_iso8601_to_ms(&node.updated_at)?,
    })
}

fn issue_state(state: &str, reason: Option<&str>) -> InboxState {
    match state {
        "OPEN" => InboxState {
            label: "Open".to_string(),
            tone: InboxStateTone::Open,
        },
        "CLOSED" => InboxState {
            label: match reason {
                Some("COMPLETED") => "Closed".to_string(),
                Some("NOT_PLANNED") => "Not planned".to_string(),
                _ => "Closed".to_string(),
            },
            tone: InboxStateTone::Closed,
        },
        other => InboxState {
            label: other.to_string(),
            tone: InboxStateTone::Neutral,
        },
    }
}

fn pr_state(state: &str, is_draft: bool, merged: bool) -> InboxState {
    if merged {
        return InboxState {
            label: "Merged".to_string(),
            tone: InboxStateTone::Merged,
        };
    }
    if state == "CLOSED" {
        return InboxState {
            label: "Closed".to_string(),
            tone: InboxStateTone::Closed,
        };
    }
    if is_draft {
        return InboxState {
            label: "Draft".to_string(),
            tone: InboxStateTone::Draft,
        };
    }
    if state == "OPEN" {
        return InboxState {
            label: "Open".to_string(),
            tone: InboxStateTone::Open,
        };
    }
    InboxState {
        label: state.to_string(),
        tone: InboxStateTone::Neutral,
    }
}

/// Parse `2024-05-17T12:34:56Z` into unix-ms. Returns `None` (not an
/// error) when the timestamp is malformed — we'd rather drop a single
/// item than fail the whole page.
fn parse_iso8601_to_ms(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    let parsed = chrono::DateTime::parse_from_rfc3339(trimmed).ok()?;
    Some(parsed.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue_only_toggles() -> InboxToggles {
        InboxToggles {
            issues: true,
            prs: false,
            discussions: false,
        }
    }

    fn pr_only_toggles() -> InboxToggles {
        InboxToggles {
            issues: false,
            prs: true,
            discussions: false,
        }
    }

    #[test]
    fn cursor_roundtrip() {
        let original = MultiCursor {
            issues: MultiCursorEntry {
                cursor: Some("Y3Vyc29y".to_string()),
                done: false,
            },
            prs: MultiCursorEntry {
                cursor: None,
                done: true,
            },
            discussions: MultiCursorEntry::default(),
            issue_scopes: BTreeMap::new(),
            pr_scopes: BTreeMap::new(),
        };
        let encoded = encode_cursor(&original).unwrap();
        let decoded = decode_cursor(Some(&encoded)).unwrap();
        assert_eq!(decoded.issues.cursor.as_deref(), Some("Y3Vyc29y"));
        assert!(!decoded.issues.done);
        assert!(decoded.prs.done);
    }

    #[test]
    fn decode_empty_cursor_returns_default() {
        let decoded = decode_cursor(None).unwrap();
        assert!(!decoded.issues.done);
        assert!(decoded.issues.cursor.is_none());
    }

    #[test]
    fn single_kind_finished_cursor_stops_when_other_kinds_are_disabled() {
        let cursor = encode_cursor(&MultiCursor {
            issues: MultiCursorEntry {
                cursor: None,
                done: true,
            },
            prs: MultiCursorEntry::default(),
            discussions: MultiCursorEntry::default(),
            issue_scopes: BTreeMap::from([(
                "All".to_string(),
                MultiCursorEntry {
                    cursor: Some("Y3Vyc29yOjk=".to_string()),
                    done: true,
                },
            )]),
            pr_scopes: BTreeMap::new(),
        })
        .unwrap();

        let page = list_inbox_items(
            "dohooo",
            InboxToggles {
                issues: true,
                prs: false,
                discussions: false,
            },
            Some(&cursor),
            20,
            Some("dohooo/helmor"),
            None,
        )
        .unwrap();

        assert!(page.items.is_empty());
        assert!(
            page.next_cursor.is_none(),
            "disabled inbox kinds must not keep pagination alive"
        );
    }

    #[test]
    fn pr_state_handles_merged_priority() {
        let state = pr_state("CLOSED", false, true);
        assert!(matches!(state.tone, InboxStateTone::Merged));
        assert_eq!(state.label, "Merged");
    }

    #[test]
    fn issue_state_not_planned_label() {
        let state = issue_state("CLOSED", Some("NOT_PLANNED"));
        assert!(matches!(state.tone, InboxStateTone::Closed));
        assert_eq!(state.label, "Not planned");
    }

    #[test]
    fn sanitize_repo_filter_accepts_simple_owner_name() {
        assert_eq!(
            sanitize_repo_filter("dosu-ai/dosu").as_deref(),
            Some("dosu-ai/dosu"),
        );
        assert_eq!(
            sanitize_repo_filter("dohooo/react-native-reanimated-carousel").as_deref(),
            Some("dohooo/react-native-reanimated-carousel"),
        );
    }

    #[test]
    fn sanitize_repo_filter_rejects_garbage() {
        assert!(sanitize_repo_filter("").is_none());
        assert!(sanitize_repo_filter("noslash").is_none());
        assert!(sanitize_repo_filter("/").is_none());
        assert!(sanitize_repo_filter("a/").is_none());
        assert!(sanitize_repo_filter("/a").is_none());
        // No spaces / quotes / search-operator chars allowed.
        assert!(sanitize_repo_filter("foo /bar").is_none());
        assert!(sanitize_repo_filter("foo/bar baz").is_none());
        assert!(sanitize_repo_filter("\"foo\"/bar").is_none());
        assert!(sanitize_repo_filter("foo/bar OR is:pr").is_none());
    }

    #[test]
    fn repo_qualifier_emits_trailing_space_when_present() {
        assert_eq!(repo_qualifier(None), "");
        assert_eq!(repo_qualifier(Some("")), "");
        assert_eq!(repo_qualifier(Some("invalid")), "");
        assert_eq!(repo_qualifier(Some("dosu-ai/dosu")), "repo:dosu-ai/dosu ");
    }

    #[test]
    fn exact_reference_repo_scope_is_case_insensitive() {
        assert!(!repo_filters_exact_reference(
            Some("dohooo/helmor"),
            "Dohooo/Helmor",
        ));
        assert!(!repo_filters_exact_reference(
            Some("Dohooo/Helmor"),
            "dohooo/helmor",
        ));
        assert!(repo_filters_exact_reference(
            Some("dohooo/helmor"),
            "octocat/hello-world",
        ));
    }

    #[test]
    fn search_qualifier_sanitizes_user_text() {
        assert_eq!(search_qualifier(None), "");
        assert_eq!(
            search_qualifier(Some("  refresh token  ")),
            "refresh token in:title,body "
        );
        assert_eq!(
            search_qualifier(Some("is:open \"quoted\"")),
            "is open quoted in:title,body ",
        );
    }

    #[test]
    fn parse_exact_issue_pr_reference_accepts_github_links() {
        let issue = parse_exact_issue_pr_reference(
            "https://github.com/dohooo/helmor/issues/123?notification_referrer_id=1",
            None,
            pr_only_toggles(),
        )
        .unwrap();
        assert_eq!(issue.repo_with_owner, "dohooo/helmor");
        assert_eq!(issue.number, 123);
        assert_eq!(issue.source, InboxSource::GithubIssue);

        let pr = parse_exact_issue_pr_reference(
            "github.com/dohooo/helmor/pull/456#discussion",
            None,
            issue_only_toggles(),
        )
        .unwrap();
        assert_eq!(pr.repo_with_owner, "dohooo/helmor");
        assert_eq!(pr.number, 456);
        assert_eq!(pr.source, InboxSource::GithubPr);

        let mixed_case = parse_exact_issue_pr_reference(
            "HtTpS://GitHub.com/dohooo/helmor/issues/789",
            None,
            issue_only_toggles(),
        )
        .unwrap();
        assert_eq!(mixed_case.repo_with_owner, "dohooo/helmor");
        assert_eq!(mixed_case.number, 789);
    }

    #[test]
    fn parse_exact_issue_pr_reference_accepts_numbers_when_unambiguous() {
        let repo_number =
            parse_exact_issue_pr_reference("dohooo/helmor#123", None, pr_only_toggles()).unwrap();
        assert_eq!(repo_number.repo_with_owner, "dohooo/helmor");
        assert_eq!(repo_number.number, 123);
        assert_eq!(repo_number.source, InboxSource::GithubPr);

        let hash_number =
            parse_exact_issue_pr_reference("#456", Some("dohooo/helmor"), issue_only_toggles())
                .unwrap();
        assert_eq!(hash_number.repo_with_owner, "dohooo/helmor");
        assert_eq!(hash_number.number, 456);
        assert_eq!(hash_number.source, InboxSource::GithubIssue);

        let plain_number =
            parse_exact_issue_pr_reference("789", Some("dohooo/helmor"), issue_only_toggles())
                .unwrap();
        assert_eq!(plain_number.repo_with_owner, "dohooo/helmor");
        assert_eq!(plain_number.number, 789);
        assert_eq!(plain_number.source, InboxSource::GithubIssue);
    }

    #[test]
    fn parse_exact_issue_pr_reference_rejects_non_exact_search() {
        assert!(parse_exact_issue_pr_reference("123", None, issue_only_toggles()).is_none());
        assert!(parse_exact_issue_pr_reference(
            "123",
            Some("dohooo/helmor"),
            InboxToggles {
                issues: true,
                prs: true,
                discussions: false,
            },
        )
        .is_none());
        assert!(parse_exact_issue_pr_reference(
            "https://github.com/dohooo/helmor",
            None,
            issue_only_toggles()
        )
        .is_none());
        assert!(parse_exact_issue_pr_reference(
            "https://github.com/dohooo/helmor/discussions/123",
            None,
            issue_only_toggles()
        )
        .is_none());
        assert!(parse_exact_issue_pr_reference(
            "https://github.com/dohooo/helmor/issues/not-a-number",
            None,
            issue_only_toggles()
        )
        .is_none());
    }

    #[test]
    fn exact_filters_reject_items_outside_active_state_or_draft() {
        assert!(!exact_state_matches(
            InboxSource::GithubIssue,
            Some(InboxStateFilter::Open),
            "CLOSED",
            false,
        ));
        assert!(!exact_state_matches(
            InboxSource::GithubPr,
            Some(InboxStateFilter::Closed),
            "CLOSED",
            true,
        ));
        assert!(!exact_draft_matches(Some(InboxDraftFilter::Exclude), true));
        assert!(exact_draft_matches(Some(InboxDraftFilter::Only), true));
    }

    #[test]
    fn exact_filters_reject_items_outside_active_labels_or_scope() {
        let labels = vec![
            GithubRestLabel {
                name: "bug".to_string(),
            },
            GithubRestLabel {
                name: "area:ui".to_string(),
            },
        ];
        assert!(exact_labels_match(Some("bug, area:ui"), &labels));
        assert!(!exact_labels_match(Some("bug, backend"), &labels));

        let issue = IssueRestResponse {
            node_id: "I_kw".to_string(),
            html_url: "https://github.com/dohooo/helmor/issues/1".to_string(),
            title: "Issue".to_string(),
            body: None,
            state: "open".to_string(),
            state_reason: None,
            user: Some(PullRequestRestUser {
                login: "dohooo".to_string(),
            }),
            assignees: Vec::new(),
            labels,
            pull_request: None,
            created_at: None,
            updated_at: None,
            closed_at: None,
        };
        assert!(exact_issue_scopes_match(
            "dohooo",
            Some(&[InboxScopeFilter::Created]),
            &issue,
        ));
        assert!(!exact_issue_scopes_match(
            "octocat",
            Some(&[InboxScopeFilter::Created]),
            &issue,
        ));
        assert!(exact_issue_scopes_match(
            "octocat",
            Some(&[InboxScopeFilter::Involves]),
            &issue,
        ));
        assert!(exact_issue_scopes_match(
            "octocat",
            Some(&[InboxScopeFilter::Mentioned]),
            &issue,
        ));

        let pull_request = PullRequestRestResponse {
            node_id: "PR_kw".to_string(),
            html_url: "https://github.com/dohooo/helmor/pull/2".to_string(),
            title: "PR".to_string(),
            body: None,
            state: "open".to_string(),
            merged: false,
            draft: Some(false),
            user: Some(PullRequestRestUser {
                login: "octocat".to_string(),
            }),
            assignees: Vec::new(),
            requested_reviewers: vec![PullRequestRestUser {
                login: "dohooo".to_string(),
            }],
            labels: Vec::new(),
            base: None,
            head: None,
            created_at: None,
            updated_at: None,
        };
        assert!(exact_pull_request_scopes_match(
            "dohooo",
            Some(&[InboxScopeFilter::ReviewRequested]),
            &pull_request,
        ));
        assert!(!exact_pull_request_scopes_match(
            "dohooo",
            Some(&[InboxScopeFilter::Author]),
            &pull_request,
        ));
        assert!(exact_pull_request_scopes_match(
            "dohooo",
            Some(&[InboxScopeFilter::ReviewedBy]),
            &pull_request,
        ));
        assert!(exact_pull_request_scopes_match(
            "octocat",
            Some(&[InboxScopeFilter::Involves]),
            &pull_request,
        ));
    }

    #[test]
    fn exact_issue_filter_rejects_pull_request_payloads() {
        let pull_request_as_issue = IssueRestResponse {
            node_id: "PR_kw".to_string(),
            html_url: "https://github.com/dohooo/helmor/pull/487".to_string(),
            title: "PR".to_string(),
            body: None,
            state: "open".to_string(),
            state_reason: None,
            user: None,
            assignees: Vec::new(),
            labels: Vec::new(),
            pull_request: Some(serde_json::json!({
                "url": "https://api.github.com/repos/dohooo/helmor/pulls/487"
            })),
            created_at: None,
            updated_at: None,
            closed_at: None,
        };

        assert!(exact_issue_payload_is_pull_request(&pull_request_as_issue));
        assert!(!exact_issue_matches_filters(
            "dohooo",
            &pull_request_as_issue,
            None
        ));
    }

    #[test]
    fn exact_lookup_treats_gh_404_as_empty() {
        let output = CommandOutput {
            stdout: String::new(),
            stderr: "gh: Not Found (HTTP 404)".to_string(),
            success: false,
            status: Some(1),
        };

        assert!(looks_like_not_found(&output, &command_detail(&output)));
    }

    #[test]
    fn labels_qualifier_sanitizes_and_quotes_labels() {
        assert_eq!(labels_qualifier(None), "");
        assert_eq!(
            labels_qualifier(Some("bug, good first issue, area:ui")),
            "label:\"bug\" label:\"good first issue\" label:\"area:ui\" ",
        );
    }

    #[test]
    fn state_qualifier_maps_source_specific_states() {
        assert_eq!(
            state_qualifier(InboxSource::GithubIssue, Some(InboxStateFilter::Open)),
            "is:open ",
        );
        assert_eq!(
            state_qualifier(InboxSource::GithubPr, Some(InboxStateFilter::Closed)),
            "is:closed is:unmerged ",
        );
        assert_eq!(
            state_qualifier(
                InboxSource::GithubDiscussion,
                Some(InboxStateFilter::Answered),
            ),
            "is:answered ",
        );
        assert_eq!(
            state_qualifier(InboxSource::GithubIssue, Some(InboxStateFilter::Merged)),
            "",
        );
    }

    #[test]
    fn scope_qualifier_maps_source_specific_scopes() {
        assert_eq!(
            scope_qualifier(InboxSource::GithubIssue, Some(InboxScopeFilter::Mentioned),),
            "mentions:@me ",
        );
        assert_eq!(
            scope_qualifier(
                InboxSource::GithubPr,
                Some(InboxScopeFilter::ReviewRequested),
            ),
            "review-requested:@me ",
        );
        assert_eq!(
            scope_qualifier(InboxSource::GithubDiscussion, Some(InboxScopeFilter::All)),
            "",
        );
    }

    #[test]
    fn draft_and_sort_qualifiers_map_settings() {
        assert_eq!(
            draft_qualifier(Some(InboxDraftFilter::Exclude)),
            "-is:draft "
        );
        assert_eq!(draft_qualifier(Some(InboxDraftFilter::Only)), "is:draft ");
        assert_eq!(draft_qualifier(Some(InboxDraftFilter::Include)), "");
        assert_eq!(
            sort_qualifier(Some(InboxSortFilter::Comments)),
            "sort:comments-desc",
        );
        assert_eq!(
            discussion_sort_qualifier(Some(InboxSortFilter::Comments)),
            "sort:updated-desc",
        );
    }
}
