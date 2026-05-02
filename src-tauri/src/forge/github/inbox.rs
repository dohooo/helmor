//! GitHub inbox source. Fans out the user's involved-issues / involved-PRs
//! / involved-discussions across one `gh` login via three GraphQL search
//! queries, then merges into a single recency-sorted page.
//!
//! Pagination model: each kind keeps its own GraphQL `endCursor`. The
//! frontend cursor is a JSON-encoded `MultiCursor { issues, prs,
//! discussions }`, treated as opaque on the JS side. Each page request
//! fetches the next batch from each kind that's still ongoing, merges
//! by `updatedAt` desc, and returns the top `limit` items.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};

use super::api::{run_graphql, GraphqlOutcome};

/// Per-kind toggle the user picks in Settings → Inbox.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxToggles {
    pub issues: bool,
    pub prs: bool,
    pub discussions: bool,
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

#[derive(Debug, Clone, Copy, Serialize)]
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

/// Public entry point — driven by the `list_inbox_items` Tauri command.
pub fn list_inbox_items(
    login: &str,
    toggles: InboxToggles,
    cursor: Option<&str>,
    limit: usize,
) -> Result<InboxPage> {
    let limit = limit.clamp(1, 100);
    let mut state = decode_cursor(cursor)?;

    tracing::debug!(
        target: "helmor::inbox",
        login,
        ?toggles,
        ?state,
        limit,
        "list_inbox_items: starting page"
    );

    let mut items: Vec<InboxItem> = Vec::new();

    if toggles.issues && !state.issues.done {
        match fetch_search(
            login,
            "is:issue involves:@me archived:false",
            &state.issues.cursor,
        )? {
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
        match fetch_search(
            login,
            "is:pr involves:@me archived:false",
            &state.prs.cursor,
        )? {
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
        match fetch_discussion_search(login, &state.discussions.cursor)? {
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
) -> Result<FetchOutcome<SearchPage<DiscussionNode>>> {
    let q = "involves:@me sort:updated-desc";
    let cursor_arg = cursor.clone().unwrap_or_default();
    let mut variables: Vec<(&str, &str)> = vec![("q", q)];
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
}
