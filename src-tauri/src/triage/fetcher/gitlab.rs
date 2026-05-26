//! GitLab fetcher — per-repo scan, mirror of `github`. Talks to `glab`
//! via the project-scoped REST endpoints
//! (`projects/{path}/issues|merge_requests`). Discussions don't exist
//! on GitLab, so we only fetch issues + MRs.

use std::collections::BTreeSet;

use anyhow::{Context, Result};
use chrono::{TimeZone, Utc};

use crate::forge::gitlab::inbox as glab;
use crate::forge::inbox::{
    InboxFilters, InboxItem, InboxItemDetail, InboxSource, InboxStateFilter, InboxToggles,
};
use crate::forge::remote::parse_remote;
use crate::models::repos;

use super::cache;
use super::storage::{self, NewCandidate, UpsertOutcome};
use super::{FetchSummary, Fetcher};

const SOURCE: &str = "gitlab";
const PER_REPO_LIMIT: usize = 50;

pub struct GitlabFetcher;

impl Fetcher for GitlabFetcher {
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
                    "gitlab fetcher: repo failed",
                ),
            }
            summary.source_parents_scanned += 1;
        }
        Ok(summary)
    }
}

/// Helmor-registered GitLab repo, deduped by (login, host, project
/// path). `host` is carried so self-hosted GitLab instances don't get
/// routed to gitlab.com via the login's home-host fallback.
#[derive(Debug, Clone)]
struct RepoTarget {
    login: String,
    host: String,
    owner_path: String,
}

fn build_repo_targets() -> Result<Vec<RepoTarget>> {
    let repos = repos::list_repositories().context("list repos for gitlab fetcher")?;
    let mut seen: BTreeSet<(String, String, String)> = BTreeSet::new();
    let mut out: Vec<RepoTarget> = Vec::new();
    for r in repos {
        if r.forge_provider.as_deref() != Some("gitlab") {
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
        // `namespace/repo` preserves subgroup nesting (parse_remote
        // rsplits on the last `/`, so `group/sub/proj` → namespace=
        // `group/sub`, repo=`proj`).
        let owner_path = format!("{}/{}", parsed.namespace, parsed.repo);
        let key = (
            login.to_ascii_lowercase(),
            parsed.host.to_ascii_lowercase(),
            owner_path.to_ascii_lowercase(),
        );
        if seen.insert(key) {
            out.push(RepoTarget {
                login,
                host: parsed.host,
                owner_path,
            });
        }
    }
    Ok(out)
}

fn fetch_repo(target: &RepoTarget, summary: &mut FetchSummary) -> Result<()> {
    let filters = InboxFilters {
        state: Some(InboxStateFilter::Open),
        ..Default::default()
    };
    let toggles = InboxToggles {
        issues: true,
        prs: true,
        discussions: false,
    };
    let page = match glab::list_inbox_items(
        &target.login,
        Some(&target.host),
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
                host = %target.host,
                repo = %target.owner_path,
                error = %format!("{error:#}"),
                "gitlab fetcher: list_inbox_items failed",
            );
            return Ok(());
        }
    };
    for item in page.items {
        if let Err(error) = ingest_item(&target.login, &item, summary) {
            tracing::warn!(
                login = %target.login,
                external_id = %item.external_id,
                error = %format!("{error:#}"),
                "gitlab fetcher: ingest_item failed",
            );
        }
    }
    Ok(())
}

fn ingest_item(login: &str, item: &InboxItem, summary: &mut FetchSummary) -> Result<()> {
    let source_ref = item.external_id.clone();
    let parent = parent_from_external_id(&source_ref);
    let id = format!("gitlab:{source_ref}");
    let source_kind = source_kind_for(item.source).to_string();
    let source_time = match Utc.timestamp_millis_opt(item.last_activity_at).single() {
        Some(t) => t,
        None => Utc::now(),
    };

    let exists = storage::candidate_exists(SOURCE, &source_ref)?;
    let (payload_path, payload_bytes) = if exists {
        let row_path = read_payload_path(&id)?;
        (row_path, 0u64)
    } else {
        let path = build_payload_path(&parent, &source_ref);
        let body = fetch_detail_body(login, item).unwrap_or_else(|error| {
            tracing::warn!(
                login = %login,
                external_id = %item.external_id,
                error = %format!("{error:#}"),
                "gitlab fetcher: detail fetch failed, writing minimal payload",
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
        InboxSource::GitlabIssue => "issue",
        InboxSource::GitlabMr => "mr",
        _ => "other",
    }
}

fn parent_from_external_id(external_id: &str) -> String {
    external_id
        .rsplit_once('#')
        .map(|(repo, _)| repo.to_string())
        .unwrap_or_else(|| external_id.to_string())
}

fn build_payload_path(parent: &str, source_ref: &str) -> String {
    let parent_seg = cache::safe_segment(parent);
    let ref_seg = cache::safe_segment(source_ref);
    format!("gitlab/{parent_seg}/{ref_seg}.md")
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

fn fetch_detail_body(login: &str, item: &InboxItem) -> Result<String> {
    let detail = glab::get_inbox_item_detail(login, None, item.source, &item.external_id)
        .context("gitlab get_inbox_item_detail")?;
    let body = match detail {
        Some(InboxItemDetail::GitlabIssue(d)) => render_issue(&d),
        Some(InboxItemDetail::GitlabMr(d)) => render_mr(&d),
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

fn render_issue(d: &crate::forge::gitlab::inbox::detail::GitlabIssueDetail) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Issue {} — {}\n\n", d.external_id, d.title));
    out.push_str(&format!("- state: {}\n", d.state));
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

fn render_mr(d: &crate::forge::gitlab::inbox::detail::GitlabMergeRequestDetail) -> String {
    let mut out = String::new();
    out.push_str(&format!("# MR {} — {}\n\n", d.external_id, d.title));
    out.push_str(&format!("- state: {}\n", d.state));
    out.push_str(&format!("- merged: {}\n", d.merged));
    out.push_str(&format!("- draft: {}\n", d.draft));
    if let Some(author) = &d.author_login {
        out.push_str(&format!("- author: {author}\n"));
    }
    if let Some(src) = &d.source_branch {
        out.push_str(&format!("- source: {src}\n"));
    }
    if let Some(tgt) = &d.target_branch {
        out.push_str(&format!("- target: {tgt}\n"));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_extraction_gitlab() {
        assert_eq!(parent_from_external_id("group/proj#42"), "group/proj");
        assert_eq!(
            parent_from_external_id("group/sub/proj#1"),
            "group/sub/proj"
        );
    }

    #[test]
    fn repo_target_dedupe_distinguishes_host_and_subgroup() {
        // Same project name under different subgroups must NOT collapse
        // (`platform/tools/api` ≠ `platform/api`). Same project on
        // different hosts must NOT collapse either (gitlab.com vs.
        // self-hosted).
        let mut seen: BTreeSet<(String, String, String)> = BTreeSet::new();
        let a = (
            "alice".into(),
            "gitlab.com".into(),
            "platform/tools/api".into(),
        );
        let b = ("alice".into(), "gitlab.com".into(), "platform/api".into());
        let c = (
            "alice".into(),
            "gitlab.example.com".into(),
            "platform/tools/api".into(),
        );
        assert!(seen.insert(a.clone()));
        assert!(seen.insert(b));
        assert!(seen.insert(c));
        // Re-inserting `a` is a no-op.
        assert!(!seen.insert(a));
    }
}
