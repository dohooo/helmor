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

use super::{
    accounts as gh_accounts,
    api::{looks_like_auth_rejection, run_graphql, GraphqlOutcome, GITHUB_HOST},
};
use crate::forge::command::command_detail;

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
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxStateFilter {
    Open,
    Closed,
    Merged,
    Answered,
    Unanswered,
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

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
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
    let mut state = decode_cursor(cursor)?;
    let repo_qual = repo_qualifier(repo_filter);
    let search_qual = search_qualifier(
        filters
            .as_ref()
            .and_then(|filters| filters.query.as_deref()),
    );
    let state_filter = filters.as_ref().and_then(|filters| filters.state);

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

    // When the user has scoped to a single repo, the kanban inbox shows
    // "everything in this repo" rather than "everything I'm personally
    // involved in" — otherwise repos where the user has access but
    // hasn't authored / commented on issues come back empty even though
    // 17 issues exist (real-world helmor case). Without a repo filter
    // the query stays narrow so the global feed isn't a firehose.
    let involvement_qual = if repo_qual.is_empty() {
        "involves:@me "
    } else {
        ""
    };

    let mut items: Vec<InboxItem> = Vec::new();

    if toggles.issues && !state.issues.done {
        let q = format!(
            "{repo_qual}{search_qual}is:issue {}{involvement_qual}archived:false",
            state_qualifier(InboxSource::GithubIssue, state_filter)
        );
        match fetch_search(login, &q, &state.issues.cursor)? {
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
                    "issues search results"
                );
                items.extend(
                    page.nodes
                        .into_iter()
                        .filter_map(|n| issue_or_pr_to_item(n, false)),
                );
                state.issues = MultiCursorEntry {
                    cursor: page.end_cursor,
                    done: !page.has_next_page,
                };
            }
        }
    }

    if toggles.prs && !state.prs.done {
        let q = format!(
            "{repo_qual}{search_qual}is:pr {}{involvement_qual}archived:false",
            state_qualifier(InboxSource::GithubPr, state_filter)
        );
        match fetch_search(login, &q, &state.prs.cursor)? {
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
                    "prs search results"
                );
                items.extend(
                    page.nodes
                        .into_iter()
                        .filter_map(|n| issue_or_pr_to_item(n, true)),
                );
                state.prs = MultiCursorEntry {
                    cursor: page.end_cursor,
                    done: !page.has_next_page,
                };
            }
        }
    }

    if toggles.discussions && !state.discussions.done {
        match fetch_discussion_search(
            login,
            &state.discussions.cursor,
            &repo_qual,
            &search_qual,
            state_qualifier(InboxSource::GithubDiscussion, state_filter),
            involvement_qual,
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

    items.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
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

    tracing::info!(
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
    if looks_like_auth_rejection(&detail) {
        return Ok(None);
    }
    Err(anyhow!("`gh api` failed for {label}: {detail}"))
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
    html_url: String,
    title: String,
    body: Option<String>,
    state: String,
    merged: bool,
    draft: Option<bool>,
    user: Option<PullRequestRestUser>,
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
    html_url: String,
    title: String,
    body: Option<String>,
    state: String,
    state_reason: Option<String>,
    user: Option<PullRequestRestUser>,
    created_at: Option<String>,
    updated_at: Option<String>,
    closed_at: Option<String>,
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
) -> Result<FetchOutcome<SearchPage<IssueOrPrNode>>> {
    let q = format!("{base_query} sort:updated-desc");
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
    involvement_qual: &str,
) -> Result<FetchOutcome<SearchPage<DiscussionNode>>> {
    let q = format!("{repo_qual}{search_qual}{state_qual}{involvement_qual}sort:updated-desc");
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
}
