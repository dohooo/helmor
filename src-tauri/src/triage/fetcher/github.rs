//! GitHub fetcher: assigned / mentioned / review-requested inbox.
//!
//! Per (provider=github, login) we hit the same inbox API the UI uses,
//! filtered to scopes that imply the user is on the hook. New items
//! get a detail fetch for the body; known-open items just refresh
//! metadata. Decided items are left alone (storage layer enforces).

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result};
use chrono::{TimeZone, Utc};

use crate::forge::inbox::{
    InboxFilters, InboxItem, InboxItemDetail, InboxScopeFilter, InboxSource, InboxToggles,
};
use crate::forge::remote::parse_remote;
use crate::forge::{github::inbox as gh, ForgeProvider};
use crate::models::repos;

use super::cache;
use super::storage::{self, NewCandidate, UpsertOutcome};
use super::{FetchSummary, Fetcher};

const SOURCE: &str = "github";
/// Items per (login, scope) call. Caps the per-tick fan-out — Layer-2
/// only consumes 20 anyway, and the rest will roll forward next tick.
const PER_SCOPE_LIMIT: usize = 30;

pub struct GithubFetcher;

impl Fetcher for GithubFetcher {
    fn source(&self) -> &'static str {
        SOURCE
    }

    fn fetch_once(&self) -> Result<FetchSummary> {
        let allowed = build_allowed_repos()?;
        let mut summary = FetchSummary::default();
        for (login, owned) in &allowed {
            match fetch_login(login, owned, &mut summary) {
                Ok(()) => {}
                Err(error) => tracing::warn!(
                    login = %login,
                    error = %format!("{error:#}"),
                    "github fetcher: login failed",
                ),
            }
            summary.source_parents_scanned += 1;
        }
        Ok(summary)
    }
}

/// Per-(login → set of `owner/repo`) map of repos the user has actually
/// added to Helmor. Drives both:
///   - WHICH logins we run inbox queries for (set keys), and
///   - WHICH items we keep after the query returns (set values).
///
/// We deliberately don't enumerate every `gh auth` login on the
/// machine and we don't keep inbox items that belong to repos the user
/// hasn't registered in Helmor. The GitHub inbox API can't filter to a
/// multi-repo allowlist server-side without N round-trips, so we do
/// client-side filtering after one inbox call per login per scope.
fn build_allowed_repos() -> Result<BTreeMap<String, BTreeSet<String>>> {
    let repos = repos::list_repositories().context("list repos for github fetcher")?;
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for r in repos {
        if r.forge_provider.as_deref() != Some("github") {
            continue;
        }
        let Some(login) = r.forge_login.filter(|l| !l.trim().is_empty()) else {
            continue;
        };
        let Some(remote_url) = r.remote_url.as_deref() else {
            continue;
        };
        let Some(parsed) = parse_remote(remote_url) else {
            continue;
        };
        // GitHub external_id format from `forge::github::inbox` is
        // `<owner>/<repo>` — namespace is exactly one segment, repo is
        // one segment. Case-insensitive compare later via `parent` (we
        // normalize both sides to lowercase).
        let owned = format!(
            "{}/{}",
            parsed.namespace.to_ascii_lowercase(),
            parsed.repo.to_ascii_lowercase()
        );
        out.entry(login).or_default().insert(owned);
    }
    Ok(out)
}

fn fetch_login(login: &str, allowed: &BTreeSet<String>, summary: &mut FetchSummary) -> Result<()> {
    // One pass per scope. The same item can match multiple scopes (e.g.
    // assigned AND mentioned) — upsert is idempotent so we don't dedup
    // upfront. The scope itself never gets stored; Layer-2 reads body +
    // metadata from disk and decides whether the user actually cares.
    for scope in [
        InboxScopeFilter::Assigned,
        InboxScopeFilter::Mentioned,
        InboxScopeFilter::ReviewRequested,
        InboxScopeFilter::Author,
    ] {
        let filters = InboxFilters {
            scope: Some(vec![scope]),
            ..Default::default()
        };
        let toggles = InboxToggles {
            issues: true,
            prs: true,
            discussions: false,
        };
        let page = match gh::list_inbox_items(
            login,
            toggles,
            None,
            PER_SCOPE_LIMIT,
            None,
            Some(filters),
        ) {
            Ok(page) => page,
            Err(error) => {
                tracing::warn!(
                    login = %login,
                    scope = ?scope,
                    error = %format!("{error:#}"),
                    "github fetcher: list_inbox_items failed",
                );
                continue;
            }
        };
        for item in page.items {
            let parent = parent_from_external_id(&item.external_id).to_ascii_lowercase();
            if !allowed.contains(&parent) {
                // Inbox API ignores repo-allowlist filtering server-side,
                // so we drop items from repos the user hasn't added to
                // Helmor. Logging at trace because hit rate is usually
                // high and noise scales with the user's open backlog.
                tracing::trace!(
                    login = %login,
                    external_id = %item.external_id,
                    "github fetcher: item outside Helmor repo allowlist, skipping",
                );
                continue;
            }
            if let Err(error) = ingest_item(login, &item, summary) {
                tracing::warn!(
                    login = %login,
                    external_id = %item.external_id,
                    error = %format!("{error:#}"),
                    "github fetcher: ingest_item failed",
                );
            }
        }
    }
    // No cursor write: gh inbox does its own "what's new" filtering
    // server-side, so we'd never read this back.
    Ok(())
}

fn ingest_item(login: &str, item: &InboxItem, summary: &mut FetchSummary) -> Result<()> {
    let source_ref = item.external_id.clone();
    let parent = parent_from_external_id(&source_ref);
    let id = format!("github:{source_ref}");
    let source_kind = source_kind_for(item.source).to_string();
    let source_time = match Utc.timestamp_millis_opt(item.last_activity_at).single() {
        Some(t) => t,
        None => Utc::now(),
    };

    let exists = storage::candidate_exists(SOURCE, &source_ref)?;
    let (payload_path, payload_bytes) = if exists {
        // Reuse the existing payload path so we don't double-write.
        let row_path = read_payload_path(&id)?;
        (row_path, 0u64)
    } else {
        let path = build_payload_path(&parent, &source_ref);
        let body = fetch_detail_body(login, item).unwrap_or_else(|error| {
            tracing::warn!(
                login = %login,
                external_id = %item.external_id,
                error = %format!("{error:#}"),
                "github fetcher: detail fetch failed, writing minimal payload",
            );
            minimal_payload(item)
        });
        let bytes = cache::write_payload(&path, &body)?;
        (path, bytes)
    };

    let candidate = NewCandidate {
        id,
        source: SOURCE.into(),
        source_kind,
        source_ref,
        source_time,
        sender: item.subtitle.clone(),
        title: Some(item.title.clone()),
        preview: item.subtitle.clone(),
        external_url: Some(item.external_url.clone()),
        payload_path,
        payload_bytes,
    };

    match storage::upsert_candidate(&candidate)? {
        UpsertOutcome::Inserted => summary.inserted += 1,
        UpsertOutcome::UpdatedUnchanged => summary.updated += 1,
        UpsertOutcome::SkippedDecided => summary.skipped_decided += 1,
    }
    Ok(())
}

fn source_kind_for(source: InboxSource) -> &'static str {
    match source {
        InboxSource::GithubIssue => "issue",
        InboxSource::GithubPr => "pr",
        InboxSource::GithubDiscussion => "discussion",
        // Router would never send GitLab here; treat as opaque.
        InboxSource::GitlabIssue | InboxSource::GitlabMr => "other",
    }
}

fn parent_from_external_id(external_id: &str) -> String {
    // External id is "owner/repo#123" — keep just owner/repo.
    external_id
        .rsplit_once('#')
        .map(|(repo, _)| repo.to_string())
        .unwrap_or_else(|| external_id.to_string())
}

fn build_payload_path(parent: &str, source_ref: &str) -> String {
    let parent_seg = cache::safe_segment(parent);
    let ref_seg = cache::safe_segment(source_ref);
    format!("github/{parent_seg}/{ref_seg}.md")
}

fn read_payload_path(candidate_id: &str) -> Result<String> {
    let conn = crate::models::db::read_conn()?;
    conn.query_row(
        "SELECT payload_path FROM triage_candidate WHERE id = ?1",
        rusqlite::params![candidate_id],
        |row| row.get(0),
    )
    .context("read existing payload_path")
}

/// Fetch issue/PR detail and render as Markdown for the LLM to read.
fn fetch_detail_body(login: &str, item: &InboxItem) -> Result<String> {
    let detail = gh::get_inbox_item_detail(login, item.source, &item.external_id)
        .context("github get_inbox_item_detail")?;
    let body = match detail {
        Some(InboxItemDetail::GithubIssue(d)) => render_issue(&d),
        Some(InboxItemDetail::GithubPr(d)) => render_pr(&d),
        Some(InboxItemDetail::GithubDiscussion(d)) => render_discussion(&d),
        Some(_) | None => minimal_payload(item),
    };
    Ok(body)
}

fn minimal_payload(item: &InboxItem) -> String {
    format!(
        "# {title}\n\n- external_id: {external_id}\n- url: {url}\n- (detail unavailable)\n",
        title = item.title,
        external_id = item.external_id,
        url = item.external_url,
    )
}

fn render_issue(d: &crate::forge::github::inbox::detail::GithubIssueDetail) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Issue {} — {}\n\n", d.external_id, d.title));
    out.push_str(&format!("- state: {}\n", d.state));
    if let Some(reason) = &d.state_reason {
        out.push_str(&format!("- state_reason: {reason}\n"));
    }
    if let Some(author) = &d.author_login {
        out.push_str(&format!("- author: {author}\n"));
    }
    if let Some(ts) = &d.created_at {
        out.push_str(&format!("- created: {ts}\n"));
    }
    if let Some(ts) = &d.updated_at {
        out.push_str(&format!("- updated: {ts}\n"));
    }
    out.push_str(&format!("- url: {}\n\n", d.url));
    out.push_str("---\n\n");
    out.push_str(d.body.as_deref().unwrap_or("(no body)"));
    out.push('\n');
    out
}

fn render_pr(d: &crate::forge::github::inbox::detail::GithubPullRequestDetail) -> String {
    let mut out = String::new();
    out.push_str(&format!("# PR {} — {}\n\n", d.external_id, d.title));
    out.push_str(&format!("- state: {}\n", d.state));
    out.push_str(&format!("- merged: {}\n", d.merged));
    out.push_str(&format!("- draft: {}\n", d.draft));
    if let Some(author) = &d.author_login {
        out.push_str(&format!("- author: {author}\n"));
    }
    if let Some(base) = &d.base_ref_name {
        out.push_str(&format!("- base: {base}\n"));
    }
    if let Some(head) = &d.head_ref_name {
        out.push_str(&format!("- head: {head}\n"));
    }
    if let Some(ts) = &d.updated_at {
        out.push_str(&format!("- updated: {ts}\n"));
    }
    out.push_str(&format!("- url: {}\n\n", d.url));
    out.push_str("---\n\n");
    out.push_str(d.body.as_deref().unwrap_or("(no body)"));
    out.push('\n');
    out
}

fn render_discussion(d: &crate::forge::github::inbox::detail::GithubDiscussionDetail) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Discussion {} — {}\n\n", d.external_id, d.title));
    if let Some(cat) = &d.category_name {
        out.push_str(&format!("- category: {cat}\n"));
    }
    if let Some(author) = &d.author_login {
        out.push_str(&format!("- author: {author}\n"));
    }
    if let Some(answered) = d.answered {
        out.push_str(&format!("- answered: {answered}\n"));
    }
    if let Some(ts) = &d.updated_at {
        out.push_str(&format!("- updated: {ts}\n"));
    }
    out.push_str(&format!("- url: {}\n\n", d.url));
    out.push_str("---\n\n");
    out.push_str(d.body.as_deref().unwrap_or("(no body)"));
    out.push('\n');
    out
}

#[allow(dead_code)]
const _ASSERT_PROVIDER_GH: ForgeProvider = ForgeProvider::Github;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_extraction() {
        assert_eq!(parent_from_external_id("octo/repo#42"), "octo/repo");
        assert_eq!(parent_from_external_id("no_hash"), "no_hash");
    }

    #[test]
    fn payload_path_is_safe() {
        let p = build_payload_path("octo/repo", "octo/repo#42");
        assert!(p.starts_with("github/"));
        assert!(p.ends_with(".md"));
        assert!(!p.contains('#'));
    }

    #[test]
    fn allowlist_check_is_case_insensitive() {
        // Real-world: user typed `https://github.com/Octocat/Hello-World.git`
        // and forge::remote preserves the casing on the namespace/repo
        // segments. Inbox API returns `octocat/hello-world#…`. We
        // normalize both to lowercase before comparing.
        let parent = parent_from_external_id("octocat/hello-world#42").to_ascii_lowercase();
        let mut allowed = BTreeSet::new();
        allowed.insert("octocat/hello-world".to_string());
        assert!(allowed.contains(&parent));
    }

    #[test]
    fn allowlist_blocks_foreign_repo() {
        let parent = parent_from_external_id("vercel/next.js#1234").to_ascii_lowercase();
        let mut allowed = BTreeSet::new();
        allowed.insert("octocat/hello-world".to_string());
        assert!(!allowed.contains(&parent));
    }
}
