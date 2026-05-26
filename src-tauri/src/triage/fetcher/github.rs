//! GitHub fetcher: per-repo scan of open issues + PRs.
//!
//! For every GitHub repo the user has registered in Helmor we hit the
//! inbox search API with `repo:owner/name is:open` and pull whatever
//! comes back. The "is this actionable for me" call is the LLM's job,
//! not the fetcher's — the goal here is to give Layer-2 a complete
//! picture of what's open in the repos the user actually maintains.
//!
//! Why not `assigned/mentioned/review-requested` like before? Those
//! scopes serve "I'm on the hook" workflows but completely miss the
//! maintainer view: open issues nobody @ed me on, drive-by PRs, etc.
//! Maintainers want the whole open queue. IM sources (Slack/Lark) still
//! cover the passive @-me side via DM + search.messages.

use std::collections::BTreeSet;

use anyhow::{Context, Result};
use chrono::{TimeZone, Utc};

use crate::forge::inbox::{
    InboxFilters, InboxItem, InboxItemDetail, InboxSource, InboxStateFilter, InboxToggles,
};
use crate::forge::remote::parse_remote;
use crate::forge::{github::inbox as gh, ForgeProvider};
use crate::models::repos;

use super::cache;
use super::storage::{self, NewCandidate, UpsertOutcome};
use super::{FetchSummary, Fetcher};

const SOURCE: &str = "github";
/// Issues + PRs per repo per tick. Headroom over Layer-2's
/// max_per_tick=20 so the LLM has options; older items fall off the
/// updated-desc tail naturally.
const PER_REPO_LIMIT: usize = 50;

pub struct GithubFetcher;

impl Fetcher for GithubFetcher {
    fn source(&self) -> &'static str {
        SOURCE
    }

    fn fetch_once(&self) -> Result<FetchSummary> {
        let targets = build_repo_targets()?;
        let mut summary = FetchSummary::default();
        for target in &targets {
            match fetch_repo(target, &mut summary) {
                Ok(()) => {}
                Err(error) => tracing::warn!(
                    login = %target.login,
                    repo = %target.owner_path,
                    error = %format!("{error:#}"),
                    "github fetcher: repo failed",
                ),
            }
            summary.source_parents_scanned += 1;
        }
        Ok(summary)
    }
}

/// One (login, owner/repo) pair derived from a Helmor-registered repo.
/// Deduped on lowercased path so the same repo registered under
/// different casings is hit once.
#[derive(Debug, Clone)]
struct RepoTarget {
    login: String,
    owner_path: String,
}

fn build_repo_targets() -> Result<Vec<RepoTarget>> {
    let repos = repos::list_repositories().context("list repos for github fetcher")?;
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
    let mut out: Vec<RepoTarget> = Vec::new();
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
        let owner_path = format!("{}/{}", parsed.namespace, parsed.repo);
        let key = (login.to_ascii_lowercase(), owner_path.to_ascii_lowercase());
        if seen.insert(key) {
            out.push(RepoTarget { login, owner_path });
        }
    }
    Ok(out)
}

fn fetch_repo(target: &RepoTarget, summary: &mut FetchSummary) -> Result<()> {
    // Open-only; scope=None so query lands as `repo:owner/name is:open`
    // — i.e. the entire open queue, not just "involves me". Sort defaults
    // to updated-desc on the inbox side.
    let filters = InboxFilters {
        state: Some(InboxStateFilter::Open),
        ..Default::default()
    };
    let toggles = InboxToggles {
        issues: true,
        prs: true,
        discussions: false,
    };
    let page = match gh::list_inbox_items(
        &target.login,
        toggles,
        None,
        PER_REPO_LIMIT,
        Some(&target.owner_path),
        Some(filters),
    ) {
        Ok(page) => page,
        Err(error) => {
            tracing::warn!(
                login = %target.login,
                repo = %target.owner_path,
                error = %format!("{error:#}"),
                "github fetcher: list_inbox_items failed",
            );
            return Ok(());
        }
    };
    let cutoff_ms = super::cold_start_cutoff_ms();
    for item in page.items {
        // Server returns updated-desc, so older items past the cutoff
        // are guaranteed tail-only — we could break, but the filter is
        // cheap and skipping is more defensive against API ordering
        // assumptions changing under us.
        if item.last_activity_at < cutoff_ms {
            continue;
        }
        if let Err(error) = ingest_item(&target.login, &item, summary) {
            tracing::warn!(
                login = %target.login,
                external_id = %item.external_id,
                error = %format!("{error:#}"),
                "github fetcher: ingest_item failed",
            );
        }
    }
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
    fn repo_target_dedupe_key_is_case_insensitive() {
        // Two distinct registrations with mixed casing should collapse to
        // one target so we don't hit the same repo twice per tick.
        let mut seen = BTreeSet::new();
        let first = (
            "octocat".to_ascii_lowercase(),
            "Octocat/Hello-World".to_ascii_lowercase(),
        );
        let second = (
            "OCTOCAT".to_ascii_lowercase(),
            "octocat/hello-world".to_ascii_lowercase(),
        );
        assert!(seen.insert(first));
        assert!(!seen.insert(second));
    }
}
