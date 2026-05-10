//! GitLab inbox source. Mirrors `forge::github::inbox` but talks to
//! GitLab's REST API via `glab api …`.
//!
//! GitLab does NOT have a Discussions feature analogous to GitHub
//! Discussions, so [`supported_inbox_kinds`] omits it. The frontend
//! filters the sub-tab list out of the UI accordingly; this module
//! returns an empty page if it's ever queried for `discussions`.
//!
//! Pagination: GitLab REST exposes link-header pagination, but we
//! flatten it into a JSON `next_cursor` (page number per kind) so the
//! frontend treats it as opaque — same shape as the GitHub adapter.

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use super::accounts as glab_accounts;
use super::api::{
    command_detail, encode_path_component, encode_query_value, glab_api, looks_like_auth_error,
    looks_like_missing_error,
};
use crate::forge::command::CommandOutput;
use crate::forge::inbox::{
    ForgeLabelOption, InboxDraftFilter, InboxFilters, InboxItem, InboxItemDetail, InboxPage,
    InboxScopeFilter, InboxSortFilter, InboxSource, InboxState, InboxStateFilter, InboxStateTone,
    InboxToggles,
};

pub mod detail;

use detail::{GitlabIssueDetail, GitlabMergeRequestDetail};

/// GitLab `per_page` ceiling. Actual page size sent on the wire is the
/// caller's `limit`, capped here so a buggy caller can't ask the API
/// for thousands of items at once.
const PER_PAGE_MAX: u32 = 100;

/// Public entry point — driven by the `list_inbox_items` Tauri command
/// when the active forge is GitLab.
///
/// `host` should be the host the project actually lives on (parsed
/// from the repo's remote URL on the frontend). For self-hosted GitLab
/// this is critical — the bound login may live on a different GitLab
/// instance than the project (a `gitlab.com` user account looking at a
/// `gitlab.example.com` project), and querying the wrong host returns
/// 404 every time. When `host` is `None`, fall back to the login's
/// home host (used for the global "involves @me" feed where there's
/// no project to derive from).
pub fn list_inbox_items(
    login: &str,
    host: Option<&str>,
    toggles: InboxToggles,
    cursor: Option<&str>,
    limit: usize,
    repo_filter: Option<&str>,
    filters: Option<InboxFilters>,
) -> Result<InboxPage> {
    let limit = limit.clamp(1, 100);
    // Send the user's `limit` straight through to GitLab as `per_page`
    // (capped) so the server's natural pagination drives the cursor —
    // the previous "fetch 30, truncate to 20" pattern silently dropped
    // the tail when the total fit in one page.
    let per_page = (limit as u32).min(PER_PAGE_MAX);
    let mut state = decode_cursor(cursor)?;
    if !toggles.issues {
        state.issues.done = true;
    }
    if !toggles.prs {
        state.mrs.done = true;
    }
    // discussions toggle is GitHub-only.

    let host = match host {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => derive_host(login)?,
    };

    tracing::debug!(
        target: "helmor::inbox",
        host = %host,
        login,
        ?toggles,
        ?state,
        limit,
        repo_filter,
        "list_inbox_items: starting page"
    );

    let mut items: Vec<InboxItem> = Vec::new();

    if toggles.issues && !state.issues.done {
        match fetch_issues(
            &host,
            login,
            repo_filter,
            filters.as_ref(),
            state.issues.page,
            per_page,
        )? {
            FetchOutcome::Auth => {
                tracing::warn!(target: "helmor::inbox", host = %host, login, "issues fetch: auth required");
                return Ok(InboxPage {
                    items: Vec::new(),
                    next_cursor: None,
                });
            }
            FetchOutcome::Ok(page) => {
                items.extend(page.items);
                state.issues.page = page.next_page.unwrap_or(state.issues.page);
                state.issues.done = page.next_page.is_none();
            }
        }
    }

    if toggles.prs && !state.mrs.done {
        match fetch_merge_requests(
            &host,
            login,
            repo_filter,
            filters.as_ref(),
            state.mrs.page,
            per_page,
        )? {
            FetchOutcome::Auth => {
                tracing::warn!(target: "helmor::inbox", host = %host, login, "mrs fetch: auth required");
                return Ok(InboxPage {
                    items: Vec::new(),
                    next_cursor: None,
                });
            }
            FetchOutcome::Ok(page) => {
                items.extend(page.items);
                state.mrs.page = page.next_page.unwrap_or(state.mrs.page);
                state.mrs.done = page.next_page.is_none();
            }
        }
    }

    let mut seen = HashSet::new();
    items.retain(|item| seen.insert(item.id.clone()));
    items.sort_by_key(|item| std::cmp::Reverse(item.last_activity_at));
    items.truncate(limit);

    let everything_done = state.issues.done && state.mrs.done;
    let next_cursor = if everything_done {
        None
    } else {
        Some(encode_cursor(&state)?)
    };

    tracing::debug!(
        target: "helmor::inbox",
        host = %host,
        login,
        returned = items.len(),
        has_next_cursor = next_cursor.is_some(),
        "list_inbox_items: page ready"
    );

    Ok(InboxPage { items, next_cursor })
}

/// Detail entry point — fetches a single MR or issue. `host` matches
/// the list-path contract: passed in from the frontend (parsed from the
/// repo's remote URL) so multi-instance setups don't 404. Falls back to
/// `derive_host(login)` only when the caller didn't provide one (e.g.
/// global feed).
pub fn get_inbox_item_detail(
    login: &str,
    host: Option<&str>,
    source: InboxSource,
    external_id: &str,
) -> Result<Option<InboxItemDetail>> {
    let host = match host {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => derive_host(login)?,
    };
    match source {
        InboxSource::GitlabIssue => fetch_issue_detail(&host, external_id),
        InboxSource::GitlabMr => fetch_mr_detail(&host, external_id),
        // Reaching here means the router (`backend_for(provider)`) sent
        // a GitHub source to the GitLab backend — that's a logic bug.
        // Loud crash beats silent `Ok(None)` for diagnosing it.
        InboxSource::GithubIssue | InboxSource::GithubPr | InboxSource::GithubDiscussion => {
            unreachable!(
                "GitLab inbox backend received GitHub source: {source:?}. \
                 This is a router bug — `provider` and the item's `source` got out of sync."
            )
        }
    }
}

/// Fetch the union of labels across the given projects (deduped by
/// name). Mirrors `forge::github::inbox::list_repo_labels`. Each
/// `repos` entry is a `group/.../project` path; missing / inaccessible
/// projects are skipped with a warning rather than failing the batch.
pub fn list_repo_labels(
    host: &str,
    login: &str,
    repos: &[String],
) -> Result<Vec<ForgeLabelOption>> {
    let _ = login; // glab is single-account-per-host; the CLI honors the host's bound token.
    let mut labels_by_name = std::collections::BTreeMap::<String, ForgeLabelOption>::new();
    for repo in repos.iter().filter_map(|repo| sanitize_project_path(repo)) {
        let path = format!(
            "projects/{}/labels?per_page=100&with_counts=false",
            encode_path_component(&repo)
        );
        let output = match glab_api(host, [path.as_str()]) {
            Ok(output) => output,
            Err(error) => {
                tracing::warn!(
                    target: "helmor::inbox",
                    host,
                    repo,
                    error = %format!("{error:#}"),
                    "failed to load GitLab labels for repo"
                );
                continue;
            }
        };
        if !output.success {
            let detail = command_detail(&output);
            // Auth + 404 are best-effort skips: the rest of the batch
            // shouldn't fail because one project is private or missing.
            if looks_like_auth_error(&detail) || looks_like_missing_error(&detail) {
                tracing::warn!(
                    target: "helmor::inbox",
                    host,
                    repo,
                    detail = %detail,
                    "GitLab labels lookup unauthorised or missing"
                );
                continue;
            }
            tracing::warn!(
                target: "helmor::inbox",
                host,
                repo,
                detail = %detail,
                "GitLab labels lookup failed"
            );
            continue;
        }
        let labels = match serde_json::from_str::<Vec<GitlabLabelRest>>(&output.stdout) {
            Ok(labels) => labels,
            Err(error) => {
                tracing::warn!(
                    target: "helmor::inbox",
                    host,
                    repo,
                    error = %error,
                    "failed to parse GitLab labels for repo"
                );
                continue;
            }
        };
        for label in labels {
            labels_by_name
                .entry(label.name.clone())
                .or_insert(ForgeLabelOption {
                    name: label.name,
                    color: label.color,
                    description: label.description,
                });
        }
    }
    Ok(labels_by_name.into_values().collect())
}

#[derive(Debug, Deserialize)]
struct GitlabLabelRest {
    name: String,
    color: Option<String>,
    description: Option<String>,
}

// ---------------------------------------------------------------------------
// Cursor: page-per-kind, JSON-encoded under base64url.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct GitlabCursor {
    #[serde(default)]
    issues: GitlabCursorEntry,
    #[serde(default)]
    mrs: GitlabCursorEntry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitlabCursorEntry {
    /// 1-indexed REST page number, matching GitLab's `page` query param.
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default)]
    done: bool,
}

impl Default for GitlabCursorEntry {
    fn default() -> Self {
        Self {
            page: 1,
            done: false,
        }
    }
}

fn default_page() -> u32 {
    1
}

fn decode_cursor(cursor: Option<&str>) -> Result<GitlabCursor> {
    let Some(raw) = cursor else {
        return Ok(GitlabCursor::default());
    };
    if raw.is_empty() {
        return Ok(GitlabCursor::default());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|e| anyhow!("invalid GitLab inbox cursor encoding: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| anyhow!("invalid GitLab inbox cursor JSON: {e}"))
}

fn encode_cursor(state: &GitlabCursor) -> Result<String> {
    let json = serde_json::to_vec(state)?;
    Ok(URL_SAFE_NO_PAD.encode(&json))
}

// ---------------------------------------------------------------------------
// Host resolution
// ---------------------------------------------------------------------------

/// GitLab accounts are keyed by `(host, login)`. The frontend only
/// passes us `login`, so we need to resolve the host. Single-host today
/// (`gitlab.com` is the default; self-hosted users register an explicit
/// host via `gitlab_hosts`). Cross-host fan-out can come later.
fn derive_host(login: &str) -> Result<String> {
    glab_accounts::host_for_login(login)
        .ok_or_else(|| anyhow!("No GitLab host bound to login {login}. Re-run `glab auth login`."))
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GitlabIssueRest {
    iid: i64,
    title: String,
    description: Option<String>,
    web_url: String,
    state: String,
    updated_at: Option<String>,
    created_at: Option<String>,
    closed_at: Option<String>,
    references: Option<GitlabIssueReferences>,
    author: Option<GitlabUserRest>,
    project_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct GitlabIssueReferences {
    full: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitlabUserRest {
    username: Option<String>,
}

struct ProviderPage {
    items: Vec<InboxItem>,
    next_page: Option<u32>,
}

enum FetchOutcome<T> {
    Ok(T),
    Auth,
}

fn fetch_issues(
    host: &str,
    login: &str,
    repo_filter: Option<&str>,
    filters: Option<&InboxFilters>,
    page: u32,
    per_page: u32,
) -> Result<FetchOutcome<ProviderPage>> {
    let endpoint = if let Some(project) = repo_filter.and_then(sanitize_project_path) {
        format!("projects/{}/issues", encode_path_component(&project))
    } else {
        "issues".to_string()
    };

    let mut query = build_common_query(filters, page, per_page);
    apply_state_filter_issues(&mut query, filters.and_then(|f| f.state));
    apply_scope_filter_issues(&mut query, filters.and_then(|f| f.scope.as_deref()));
    apply_sort_filter(&mut query, filters.and_then(|f| f.sort));
    apply_labels_filter(&mut query, filters.and_then(|f| f.labels.as_deref()));

    let path = build_endpoint(&endpoint, &query);

    let output = match run_glab(host, login, &path)? {
        Some(output) => output,
        None => return Ok(FetchOutcome::Auth),
    };

    let items = serde_json::from_str::<Vec<GitlabIssueRest>>(&output.stdout)
        .with_context(|| "Failed to decode GitLab issues response".to_string())?;

    let next_page = next_page_after(&items, page, per_page);

    let sort = filters.and_then(|f| f.sort);
    let mapped = items
        .into_iter()
        .filter_map(|issue| issue_to_item(issue, sort))
        .collect();

    Ok(FetchOutcome::Ok(ProviderPage {
        items: mapped,
        next_page,
    }))
}

fn issue_to_item(issue: GitlabIssueRest, sort: Option<InboxSortFilter>) -> Option<InboxItem> {
    let project = issue
        .references
        .as_ref()
        .and_then(|r| r.full.clone())
        .map(strip_issue_suffix)
        .or_else(|| issue.project_id.map(|id| format!("project-{id}")))?;
    let last_activity = pick_sort_timestamp(
        sort,
        issue.created_at.as_deref(),
        issue.updated_at.as_deref(),
    )?;
    Some(InboxItem {
        id: format!("gitlab_issue:{project}#{}", issue.iid),
        source: InboxSource::GitlabIssue,
        external_id: format!("{project}#{}", issue.iid),
        external_url: issue.web_url,
        title: issue.title,
        subtitle: Some(project),
        state: Some(issue_state(&issue.state)),
        last_activity_at: last_activity,
    })
}

/// `last_activity_at` carries whichever timestamp the user is sorting
/// by, so the post-fetch sort matches the GitLab `order_by` we sent.
/// Falls back to whichever one parses if the primary is missing.
fn pick_sort_timestamp(
    sort: Option<InboxSortFilter>,
    created_at: Option<&str>,
    updated_at: Option<&str>,
) -> Option<i64> {
    let (primary, fallback) = match sort {
        Some(InboxSortFilter::Created) => (created_at, updated_at),
        _ => (updated_at, created_at),
    };
    parse_iso8601_to_ms(primary).or_else(|| parse_iso8601_to_ms(fallback))
}

fn issue_state(state: &str) -> InboxState {
    match state {
        "opened" => InboxState {
            label: "Open".to_string(),
            tone: InboxStateTone::Open,
        },
        "closed" => InboxState {
            label: "Closed".to_string(),
            tone: InboxStateTone::Closed,
        },
        other => InboxState {
            label: other.to_string(),
            tone: InboxStateTone::Neutral,
        },
    }
}

// ---------------------------------------------------------------------------
// Merge Requests
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GitlabMrRest {
    iid: i64,
    title: String,
    description: Option<String>,
    web_url: String,
    state: String,
    updated_at: Option<String>,
    created_at: Option<String>,
    merged_at: Option<String>,
    references: Option<GitlabIssueReferences>,
    author: Option<GitlabUserRest>,
    project_id: Option<i64>,
    source_branch: Option<String>,
    target_branch: Option<String>,
    draft: Option<bool>,
    work_in_progress: Option<bool>,
}

fn fetch_merge_requests(
    host: &str,
    login: &str,
    repo_filter: Option<&str>,
    filters: Option<&InboxFilters>,
    page: u32,
    per_page: u32,
) -> Result<FetchOutcome<ProviderPage>> {
    let endpoint = if let Some(project) = repo_filter.and_then(sanitize_project_path) {
        format!(
            "projects/{}/merge_requests",
            encode_path_component(&project)
        )
    } else {
        "merge_requests".to_string()
    };

    let mut query = build_common_query(filters, page, per_page);
    apply_state_filter_mrs(&mut query, filters.and_then(|f| f.state));
    apply_scope_filter_mrs(&mut query, filters.and_then(|f| f.scope.as_deref()));
    apply_sort_filter(&mut query, filters.and_then(|f| f.sort));
    apply_labels_filter(&mut query, filters.and_then(|f| f.labels.as_deref()));
    apply_draft_filter_mrs(&mut query, filters.and_then(|f| f.draft));

    let path = build_endpoint(&endpoint, &query);

    let output = match run_glab(host, login, &path)? {
        Some(output) => output,
        None => return Ok(FetchOutcome::Auth),
    };

    let items = serde_json::from_str::<Vec<GitlabMrRest>>(&output.stdout)
        .with_context(|| "Failed to decode GitLab merge requests response".to_string())?;

    let next_page = next_page_after(&items, page, per_page);

    let sort = filters.and_then(|f| f.sort);
    let mapped = items
        .into_iter()
        .filter_map(|mr| mr_to_item(mr, sort))
        .collect();

    Ok(FetchOutcome::Ok(ProviderPage {
        items: mapped,
        next_page,
    }))
}

fn mr_to_item(mr: GitlabMrRest, sort: Option<InboxSortFilter>) -> Option<InboxItem> {
    let project = mr
        .references
        .as_ref()
        .and_then(|r| r.full.clone())
        .map(strip_mr_suffix)
        .or_else(|| mr.project_id.map(|id| format!("project-{id}")))?;
    let last_activity =
        pick_sort_timestamp(sort, mr.created_at.as_deref(), mr.updated_at.as_deref())?;
    let is_draft = mr.draft.unwrap_or(false) || mr.work_in_progress.unwrap_or(false);
    Some(InboxItem {
        id: format!("gitlab_mr:{project}!{}", mr.iid),
        source: InboxSource::GitlabMr,
        external_id: format!("{project}!{}", mr.iid),
        external_url: mr.web_url,
        title: mr.title,
        subtitle: Some(project),
        state: Some(mr_state(&mr.state, is_draft)),
        last_activity_at: last_activity,
    })
}

fn mr_state(state: &str, is_draft: bool) -> InboxState {
    match state {
        "merged" => InboxState {
            label: "Merged".to_string(),
            tone: InboxStateTone::Merged,
        },
        "closed" => InboxState {
            label: "Closed".to_string(),
            tone: InboxStateTone::Closed,
        },
        "opened" if is_draft => InboxState {
            label: "Draft".to_string(),
            tone: InboxStateTone::Draft,
        },
        "opened" => InboxState {
            label: "Open".to_string(),
            tone: InboxStateTone::Open,
        },
        other => InboxState {
            label: other.to_string(),
            tone: InboxStateTone::Neutral,
        },
    }
}

// ---------------------------------------------------------------------------
// Filter -> query-string mapping
// ---------------------------------------------------------------------------

type Query = Vec<(String, String)>;

fn build_common_query(filters: Option<&InboxFilters>, page: u32, per_page: u32) -> Query {
    let mut q: Query = Vec::new();
    q.push(("per_page".to_string(), per_page.to_string()));
    q.push(("page".to_string(), page.to_string()));
    if let Some(query) = filters.and_then(|f| f.query.as_deref()) {
        let trimmed = query.trim();
        if !trimmed.is_empty() {
            q.push(("search".to_string(), trimmed.to_string()));
        }
    }
    q
}

fn apply_state_filter_issues(query: &mut Query, state: Option<InboxStateFilter>) {
    let value = match state {
        Some(InboxStateFilter::Open) => "opened",
        Some(InboxStateFilter::Closed) => "closed",
        // GitLab issues have no "merged" — fall through to all.
        Some(InboxStateFilter::All)
        | Some(InboxStateFilter::Merged)
        | Some(InboxStateFilter::Answered)
        | Some(InboxStateFilter::Unanswered)
        | None => "all",
    };
    query.push(("state".to_string(), value.to_string()));
}

fn apply_state_filter_mrs(query: &mut Query, state: Option<InboxStateFilter>) {
    let value = match state {
        Some(InboxStateFilter::Open) => "opened",
        Some(InboxStateFilter::Closed) => "closed",
        Some(InboxStateFilter::Merged) => "merged",
        Some(InboxStateFilter::All)
        | Some(InboxStateFilter::Answered)
        | Some(InboxStateFilter::Unanswered)
        | None => "all",
    };
    query.push(("state".to_string(), value.to_string()));
}

fn apply_scope_filter_issues(query: &mut Query, scopes: Option<&[InboxScopeFilter]>) {
    let scope = first_scope(scopes);
    let value = match scope {
        Some(InboxScopeFilter::Assigned) => "assigned_to_me",
        Some(InboxScopeFilter::Created) => "created_by_me",
        // GitLab "involves" doesn't exist as a single scope — fall back
        // to "all" and let the user narrow via search/labels. The
        // assigned/authored equivalents are explicit scopes above.
        _ => "all",
    };
    query.push(("scope".to_string(), value.to_string()));
}

fn apply_scope_filter_mrs(query: &mut Query, scopes: Option<&[InboxScopeFilter]>) {
    let scope = first_scope(scopes);
    let value = match scope {
        Some(InboxScopeFilter::Author) | Some(InboxScopeFilter::Created) => "created_by_me",
        Some(InboxScopeFilter::Assignee) | Some(InboxScopeFilter::Assigned) => "assigned_to_me",
        // GitLab doesn't expose review-requested / reviewed-by as REST
        // scopes — the API has it via `reviewer_username` in v15+, which
        // is callable but requires a glab CLI that ships it. For now we
        // fall back to "all" rather than silently dropping items. The
        // frontend's settings-side scope picker is GitHub-only.
        _ => "all",
    };
    query.push(("scope".to_string(), value.to_string()));
}

fn first_scope(scopes: Option<&[InboxScopeFilter]>) -> Option<InboxScopeFilter> {
    scopes.and_then(|s| s.iter().copied().next())
}

fn apply_sort_filter(query: &mut Query, sort: Option<InboxSortFilter>) {
    let order_by = match sort {
        Some(InboxSortFilter::Created) => "created_at",
        Some(InboxSortFilter::Updated) | None => "updated_at",
        // GitLab REST has no comments-count sort; fall back to recently
        // updated which is closest in spirit.
        Some(InboxSortFilter::Comments) => "updated_at",
    };
    query.push(("order_by".to_string(), order_by.to_string()));
    query.push(("sort".to_string(), "desc".to_string()));
}

fn apply_labels_filter(query: &mut Query, labels: Option<&str>) {
    let Some(labels) = labels else { return };
    let cleaned: Vec<&str> = labels
        .split(',')
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .collect();
    if cleaned.is_empty() {
        return;
    }
    query.push(("labels".to_string(), cleaned.join(",")));
}

fn apply_draft_filter_mrs(query: &mut Query, draft: Option<InboxDraftFilter>) {
    let value = match draft {
        Some(InboxDraftFilter::Exclude) => "no",
        Some(InboxDraftFilter::Only) => "yes",
        Some(InboxDraftFilter::Include) | None => return,
    };
    query.push(("wip".to_string(), value.to_string()));
}

// ---------------------------------------------------------------------------
// glab plumbing
// ---------------------------------------------------------------------------

/// Wrapper around `glab_api` that maps auth + missing-endpoint failures
/// to typed outcomes (`None` = caller should surface "Connect" UI).
///
/// Note: we intentionally DON'T pass `-i` (include response headers).
/// glab prepends an HTTP status line + headers to stdout when `-i` is
/// set, and our caller json-parses stdout — adding `-i` makes every
/// response start with `HTTP/1.1 200 OK\n…` and the parse blows up at
/// "line 1 column 1". For pagination we use a cheap length-probe
/// (`next_page_after`) which is good enough.
fn run_glab(host: &str, login: &str, path: &str) -> Result<Option<CommandOutput>> {
    let _ = login; // glab is single-account-per-host; the CLI honors the host's bound token.
    let output = glab_api(host, [path])?;
    if !output.success {
        let detail = command_detail(&output);
        if looks_like_auth_error(&detail) {
            return Ok(None);
        }
        if looks_like_missing_error(&detail) {
            return Err(anyhow!("GitLab inbox endpoint not found: {detail}"));
        }
        return Err(anyhow!("glab api failed for {path}: {detail}"));
    }
    Ok(Some(output))
}

fn build_endpoint(endpoint: &str, query: &Query) -> String {
    if query.is_empty() {
        return endpoint.to_string();
    }
    let mut out = String::with_capacity(endpoint.len() + 32);
    out.push_str(endpoint);
    out.push('?');
    let mut first = true;
    for (key, value) in query {
        if !first {
            out.push('&');
        }
        first = false;
        out.push_str(&encode_query_value(key));
        out.push('=');
        out.push_str(&encode_query_value(value));
    }
    out
}

/// Length-probe pagination: if the page came back full, assume there's
/// at least one more. Costs at most one extra empty fetch when the
/// total count is an exact multiple of `per_page` — cheap, simple, and
/// avoids relying on glab to surface a Link header.
fn next_page_after<T>(items: &[T], current: u32, per_page: u32) -> Option<u32> {
    if items.len() >= per_page as usize {
        Some(current + 1)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn sanitize_project_path(filter: &str) -> Option<String> {
    let trimmed = filter.trim();
    if trimmed.is_empty() {
        return None;
    }
    // GitLab project paths are `[A-Za-z0-9_.-]` per segment, joined by
    // `/`. Reject anything with whitespace or url-unsafe chars so a
    // malformed filter can't escape into a different endpoint.
    let valid = trimmed.split('/').all(|segment| {
        !segment.is_empty()
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    });
    if !valid {
        return None;
    }
    Some(trimmed.to_string())
}

fn strip_issue_suffix(reference: String) -> String {
    if let Some(idx) = reference.rfind('#') {
        reference[..idx].to_string()
    } else {
        reference
    }
}

fn strip_mr_suffix(reference: String) -> String {
    if let Some(idx) = reference.rfind('!') {
        reference[..idx].to_string()
    } else {
        reference
    }
}

fn parse_iso8601_to_ms(value: Option<&str>) -> Option<i64> {
    let value = value?.trim();
    let parsed = chrono::DateTime::parse_from_rfc3339(value).ok()?;
    Some(parsed.timestamp_millis())
}

fn parse_external_reference(external_id: &str) -> Result<(String, i64)> {
    let (project, number) = external_id
        .rsplit_once(['#', '!'])
        .ok_or_else(|| anyhow!("invalid GitLab inbox reference: {external_id}"))?;
    let number = number
        .parse::<i64>()
        .with_context(|| format!("invalid GitLab number in {external_id}"))?;
    Ok((project.to_string(), number))
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

fn fetch_issue_detail(host: &str, external_id: &str) -> Result<Option<InboxItemDetail>> {
    let (project, iid) = parse_external_reference(external_id)?;
    let path = format!("projects/{}/issues/{iid}", encode_path_component(&project));
    let output = match glab_api(host, [path.as_str()]) {
        Ok(output) => output,
        Err(error) => {
            let message = format!("{error:#}");
            if looks_like_auth_error(&message) {
                return Ok(None);
            }
            return Err(error);
        }
    };
    if !output.success {
        let detail = command_detail(&output);
        if looks_like_auth_error(&detail) {
            return Ok(None);
        }
        if looks_like_missing_error(&detail) {
            return Ok(None);
        }
        return Err(anyhow!("GitLab issue detail failed: {detail}"));
    }
    let raw = serde_json::from_str::<GitlabIssueRest>(&output.stdout)
        .context("Failed to decode GitLab issue detail response")?;
    Ok(Some(InboxItemDetail::GitlabIssue(Box::new(
        GitlabIssueDetail {
            external_id: external_id.to_string(),
            title: raw.title,
            body: raw.description,
            url: raw.web_url,
            state: raw.state,
            author_login: raw.author.and_then(|a| a.username),
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            closed_at: raw.closed_at,
        },
    ))))
}

fn fetch_mr_detail(host: &str, external_id: &str) -> Result<Option<InboxItemDetail>> {
    let (project, iid) = parse_external_reference(external_id)?;
    let path = format!(
        "projects/{}/merge_requests/{iid}",
        encode_path_component(&project)
    );
    let output = match glab_api(host, [path.as_str()]) {
        Ok(output) => output,
        Err(error) => {
            let message = format!("{error:#}");
            if looks_like_auth_error(&message) {
                return Ok(None);
            }
            return Err(error);
        }
    };
    if !output.success {
        let detail = command_detail(&output);
        if looks_like_auth_error(&detail) {
            return Ok(None);
        }
        if looks_like_missing_error(&detail) {
            return Ok(None);
        }
        return Err(anyhow!("GitLab MR detail failed: {detail}"));
    }
    let raw = serde_json::from_str::<GitlabMrRest>(&output.stdout)
        .context("Failed to decode GitLab MR detail response")?;
    let is_draft = raw.draft.unwrap_or(false) || raw.work_in_progress.unwrap_or(false);
    let merged = raw.state == "merged" || raw.merged_at.is_some();
    Ok(Some(InboxItemDetail::GitlabMr(Box::new(
        GitlabMergeRequestDetail {
            external_id: external_id.to_string(),
            title: raw.title,
            body: raw.description,
            url: raw.web_url,
            state: raw.state,
            merged,
            draft: is_draft,
            author_login: raw.author.and_then(|a| a.username),
            source_branch: raw.source_branch,
            target_branch: raw.target_branch,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
        },
    ))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_roundtrip() {
        let original = GitlabCursor {
            issues: GitlabCursorEntry {
                page: 3,
                done: false,
            },
            mrs: GitlabCursorEntry {
                page: 1,
                done: true,
            },
        };
        let encoded = encode_cursor(&original).unwrap();
        let decoded = decode_cursor(Some(&encoded)).unwrap();
        assert_eq!(decoded.issues.page, 3);
        assert!(!decoded.issues.done);
        assert!(decoded.mrs.done);
    }

    #[test]
    fn empty_cursor_returns_default() {
        let decoded = decode_cursor(None).unwrap();
        assert_eq!(decoded.issues.page, 1);
        assert!(!decoded.issues.done);
    }

    #[test]
    fn sanitize_project_path_accepts_nested() {
        assert_eq!(
            sanitize_project_path("group/sub/project").as_deref(),
            Some("group/sub/project")
        );
    }

    #[test]
    fn sanitize_project_path_rejects_garbage() {
        assert!(sanitize_project_path("").is_none());
        assert!(sanitize_project_path(" ").is_none());
        assert!(sanitize_project_path("a/").is_none());
        assert!(sanitize_project_path("/a").is_none());
        assert!(sanitize_project_path("a b/c").is_none());
        assert!(sanitize_project_path("a&b/c").is_none());
    }

    #[test]
    fn next_page_after_advances_when_page_is_full() {
        let items = [()].repeat(20);
        assert_eq!(next_page_after(&items, 1, 20), Some(2));
    }

    #[test]
    fn next_page_after_stops_when_page_is_short() {
        let items = [()].repeat(19);
        assert_eq!(next_page_after(&items, 1, 20), None);
    }

    #[test]
    fn next_page_after_stops_on_empty_response() {
        let items: Vec<()> = Vec::new();
        assert_eq!(next_page_after(&items, 5, 20), None);
    }

    #[test]
    fn issue_state_maps_open_closed() {
        assert!(matches!(issue_state("opened").tone, InboxStateTone::Open));
        assert!(matches!(issue_state("closed").tone, InboxStateTone::Closed));
        assert!(matches!(
            issue_state("locked").tone,
            InboxStateTone::Neutral
        ));
    }

    #[test]
    fn mr_state_distinguishes_draft_merged() {
        assert!(matches!(
            mr_state("merged", false).tone,
            InboxStateTone::Merged
        ));
        assert!(matches!(
            mr_state("opened", true).tone,
            InboxStateTone::Draft
        ));
        assert!(matches!(
            mr_state("opened", false).tone,
            InboxStateTone::Open
        ));
        assert!(matches!(
            mr_state("closed", true).tone,
            InboxStateTone::Closed
        ));
    }

    #[test]
    fn parse_external_reference_handles_both_separators() {
        assert_eq!(
            parse_external_reference("group/proj#42").unwrap(),
            ("group/proj".to_string(), 42)
        );
        assert_eq!(
            parse_external_reference("group/proj!7").unwrap(),
            ("group/proj".to_string(), 7)
        );
        assert!(parse_external_reference("noref").is_err());
    }
}
