//! GitLab fetcher — same shape as `github`, talks to `glab` instead.
//! Discussions don't exist on GitLab, so we only fetch issues + MRs.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result};
use chrono::{TimeZone, Utc};

use crate::forge::gitlab::inbox as glab;
use crate::forge::inbox::{
    InboxFilters, InboxItem, InboxItemDetail, InboxScopeFilter, InboxSource, InboxToggles,
};
use crate::forge::remote::parse_remote;
use crate::models::repos;

use super::cache;
use super::storage::{self, NewCandidate, UpsertOutcome};
use super::{FetchSummary, Fetcher};

const SOURCE: &str = "gitlab";
const PER_SCOPE_LIMIT: usize = 30;

pub struct GitlabFetcher;

impl Fetcher for GitlabFetcher {
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
                    "gitlab fetcher: login failed",
                ),
            }
            summary.source_parents_scanned += 1;
        }
        Ok(summary)
    }
}

/// `(login → set of "namespace/.../repo")` for Helmor-registered GitLab
/// repos. Nested namespaces (groups + subgroups) are preserved verbatim
/// — that's also the shape `forge::gitlab::inbox` emits in
/// `external_id`. See `github::build_allowed_repos` for the rationale
/// on client-side filtering.
fn build_allowed_repos() -> Result<BTreeMap<String, BTreeSet<String>>> {
    let repos = repos::list_repositories().context("list repos for gitlab fetcher")?;
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
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
    for scope in [
        InboxScopeFilter::Assignee,
        InboxScopeFilter::Mentions,
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
        let page = match glab::list_inbox_items(
            login,
            None,
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
                    "gitlab fetcher: list_inbox_items failed",
                );
                continue;
            }
        };
        for item in page.items {
            let parent = parent_from_external_id(&item.external_id).to_ascii_lowercase();
            if !allowed.contains(&parent) {
                tracing::trace!(
                    login = %login,
                    external_id = %item.external_id,
                    "gitlab fetcher: item outside Helmor repo allowlist, skipping",
                );
                continue;
            }
            if let Err(error) = ingest_item(login, &item, summary) {
                tracing::warn!(
                    login = %login,
                    external_id = %item.external_id,
                    error = %format!("{error:#}"),
                    "gitlab fetcher: ingest_item failed",
                );
            }
        }
    }
    // No cursor write: glab inbox handles "what's new" server-side.
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
    fn allowlist_handles_nested_namespace() {
        // GitLab subgroups: the inbox external_id includes the full
        // path, so the allowlist key must include subgroups too.
        let parent = parent_from_external_id("platform/tools/api#7").to_ascii_lowercase();
        let mut allowed = BTreeSet::new();
        allowed.insert("platform/tools/api".to_string());
        assert!(allowed.contains(&parent));
        // Same project under a different subgroup is not the same.
        let other = parent_from_external_id("platform/api#7").to_ascii_lowercase();
        assert!(!allowed.contains(&other));
    }
}
