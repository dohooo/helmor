//! GitHub fetcher: per-repo scan of open issues + PRs (`repo:owner/name is:open`).
//! Maintainer view — LLM does actionable-or-not.

use std::collections::BTreeSet;

use anyhow::{Context, Result};
use chrono::{TimeZone, Utc};

use crate::forge::inbox::{
    InboxDraftFilter, InboxFilters, InboxItem, InboxItemDetail, InboxScopeFilter, InboxSource,
    InboxStateFilter, InboxToggles,
};
use crate::forge::remote::parse_remote;
use crate::forge::{github::inbox as gh, ForgeProvider};
use crate::models::repos;

use super::cache;
use super::storage::{self, NewCandidate, UpsertOutcome};
use super::{FetchSummary, Fetcher};

const SOURCE: &str = "github";
/// Per-repo per-tick cap (headroom over Layer-2's max_per_tick).
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

/// Helmor repo target; deduped on lowercased path.
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

/// One surfacing pass: a single (toggle, scope) GitHub search whose hits all
/// carry `reason`. Passes run highest-precedence first so the dedup keeps the
/// strongest relation when the same item matches several scopes.
struct Pass {
    toggles: InboxToggles,
    scope: InboxScopeFilter,
    reason: &'static str,
}

const ISSUES_ONLY: InboxToggles = InboxToggles {
    issues: true,
    prs: false,
    discussions: false,
};
const PRS_ONLY: InboxToggles = InboxToggles {
    issues: false,
    prs: true,
    discussions: false,
};

/// Person-relation passes for one source, highest precedence first:
/// `review_requested > assigned > mentioned > author`. Issue and PR scopes use
/// distinct enum variants for the same concept, so each relation runs as its
/// own single-scope pass (a scope invalid for a toggle would otherwise degrade
/// to an unscoped "all open" search in the backend).
fn involvement_passes() -> Vec<Pass> {
    vec![
        Pass {
            toggles: PRS_ONLY,
            scope: InboxScopeFilter::ReviewRequested,
            reason: "review_requested",
        },
        Pass {
            toggles: PRS_ONLY,
            scope: InboxScopeFilter::Assignee,
            reason: "assigned",
        },
        Pass {
            toggles: ISSUES_ONLY,
            scope: InboxScopeFilter::Assigned,
            reason: "assigned",
        },
        Pass {
            toggles: PRS_ONLY,
            scope: InboxScopeFilter::Mentions,
            reason: "mentioned",
        },
        Pass {
            toggles: ISSUES_ONLY,
            scope: InboxScopeFilter::Mentioned,
            reason: "mentioned",
        },
        Pass {
            toggles: PRS_ONLY,
            scope: InboxScopeFilter::Author,
            reason: "author",
        },
        Pass {
            toggles: ISSUES_ONLY,
            scope: InboxScopeFilter::Created,
            reason: "author",
        },
    ]
}

/// An inbox item paired with the relation that surfaced it.
struct Scoped {
    item: InboxItem,
    reason: &'static str,
}

fn fetch_repo(target: &RepoTarget, summary: &mut FetchSummary) -> Result<()> {
    // Relevance scoping. Was a maintainer-wide `is:open` scan, which flooded
    // triage with teammates' routine PRs the user has no tie to (offline eval
    // on real data: 58 of 65 proposed tasks did not involve Caspian).
    //
    // Surface ONLY items with a concrete person-relation. The old
    // `involves:@me` union let mere *commenters* in; instead we query the
    // explicit relations — review-requested / assignee / mentioned / author —
    // and stamp which one surfaced each item (highest precedence wins).
    //
    // - Team repos (owner != the gh login): both issues and PRs go through the
    //   person-relation gate.
    // - Solo-owned repos (owner == the gh login, e.g. his OSS project): the
    //   open ISSUE tracker IS his triage inbox, so surface ALL open issues
    //   (reason `owned_issue`); PRs still ride the person-relation gate so
    //   contributor/automation PRs don't flood back in.
    //
    // Draft→ready bumps `updated_at`, so a PR leaving draft resurfaces.
    let owner = target.owner_path.split('/').next().unwrap_or("");
    let solo = owner.eq_ignore_ascii_case(&target.login);

    let mut scoped: Vec<Scoped> = Vec::new();
    if solo {
        // Maintainer issue triage: every open issue, stamped `owned_issue`.
        for item in list_scoped(target, ISSUES_ONLY, None) {
            scoped.push(Scoped {
                item,
                reason: "owned_issue",
            });
        }
        for pass in involvement_passes() {
            if !pass.toggles.prs {
                continue; // solo issues already covered by the all-open pass
            }
            for item in list_scoped(target, pass.toggles, Some(vec![pass.scope])) {
                scoped.push(Scoped {
                    item,
                    reason: pass.reason,
                });
            }
        }
    } else {
        for pass in involvement_passes() {
            for item in list_scoped(target, pass.toggles, Some(vec![pass.scope])) {
                scoped.push(Scoped {
                    item,
                    reason: pass.reason,
                });
            }
        }
    }

    // Dedup by external_id keeping the FIRST (highest-precedence) reason.
    let items = dedup_first_reason(scoped);

    let cutoff_ms = super::cold_start_cutoff_ms();
    for (item, reason) in items {
        // Tail-only past cutoff, but skip rather than break for safety.
        if item.last_activity_at < cutoff_ms {
            continue;
        }
        if let Err(error) = ingest_item(&target.login, &item, reason, summary) {
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

/// Merge the per-pass hits, keeping each `external_id` once with the reason
/// from its first (highest-precedence) appearance. Input order is the pass
/// order, so first-seen == strongest relation.
fn dedup_first_reason(scoped: Vec<Scoped>) -> Vec<(InboxItem, &'static str)> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out: Vec<(InboxItem, &'static str)> = Vec::new();
    for s in scoped {
        if seen.insert(s.item.external_id.clone()) {
            out.push((s.item, s.reason));
        }
    }
    out
}

/// One `list_inbox_items` call with the given toggles + optional involvement
/// scope. A failed call logs and yields no items (per-repo isolation).
fn list_scoped(
    target: &RepoTarget,
    toggles: InboxToggles,
    scope: Option<Vec<InboxScopeFilter>>,
) -> Vec<InboxItem> {
    let filters = InboxFilters {
        state: Some(InboxStateFilter::Open),
        draft: Some(InboxDraftFilter::Exclude),
        scope,
        ..Default::default()
    };
    match gh::list_inbox_items(
        &target.login,
        toggles,
        None,
        PER_REPO_LIMIT,
        Some(&target.owner_path),
        Some(filters),
    ) {
        Ok(page) => page.items,
        Err(error) => {
            tracing::warn!(
                login = %target.login,
                repo = %target.owner_path,
                error = %format!("{error:#}"),
                "github fetcher: list_inbox_items failed",
            );
            Vec::new()
        }
    }
}

/// External ids in `owner_path` that CURRENTLY involve `login` — the exact
/// person-relation set the fetcher proposes on (review-requested / assignee /
/// mentioned / author; open + non-draft). The reaper uses this to retire open
/// workspaces that no longer involve the user. Unlike [`list_scoped`], errors
/// PROPAGATE so the caller stays conservative (never retire on a failed lookup
/// — an empty set from a failed query must not look like "nothing is mine").
pub fn involved_external_ids(
    login: &str,
    owner_path: &str,
) -> Result<std::collections::HashSet<String>> {
    let mut out = std::collections::HashSet::new();
    for pass in involvement_passes() {
        let filters = InboxFilters {
            state: Some(InboxStateFilter::Open),
            draft: Some(InboxDraftFilter::Exclude),
            scope: Some(vec![pass.scope]),
            ..Default::default()
        };
        let page = gh::list_inbox_items(
            login,
            pass.toggles,
            None,
            PER_REPO_LIMIT,
            Some(owner_path),
            Some(filters),
        )
        .with_context(|| format!("involved_external_ids {owner_path} {:?}", pass.scope))?;
        for item in page.items {
            out.insert(item.external_id);
        }
    }
    Ok(out)
}

fn ingest_item(
    login: &str,
    item: &InboxItem,
    involvement_reason: &str,
    summary: &mut FetchSummary,
) -> Result<()> {
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
        involvement_reason: Some(involvement_reason.to_string()),
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

    fn item(external_id: &str) -> InboxItem {
        InboxItem {
            id: format!("github:{external_id}"),
            source: InboxSource::GithubPr,
            external_id: external_id.into(),
            external_url: "https://example.com".into(),
            title: "t".into(),
            subtitle: None,
            state: None,
            last_activity_at: 0,
        }
    }

    #[test]
    fn passes_are_precedence_ordered_with_valid_source_scopes() {
        // Precedence: review_requested > assigned > mentioned > author. Each
        // pass must target a source the scope is actually valid for, else the
        // backend silently degrades to an unscoped "all open" search.
        let passes = involvement_passes();
        let reasons: Vec<&str> = passes.iter().map(|p| p.reason).collect();
        assert_eq!(
            reasons,
            vec![
                "review_requested",
                "assigned",
                "assigned",
                "mentioned",
                "mentioned",
                "author",
                "author",
            ]
        );
        for p in &passes {
            let valid = matches!(
                (p.toggles.issues, p.toggles.prs, p.scope),
                (false, true, InboxScopeFilter::ReviewRequested)
                    | (false, true, InboxScopeFilter::Assignee)
                    | (false, true, InboxScopeFilter::Mentions)
                    | (false, true, InboxScopeFilter::Author)
                    | (true, false, InboxScopeFilter::Assigned)
                    | (true, false, InboxScopeFilter::Mentioned)
                    | (true, false, InboxScopeFilter::Created)
            );
            assert!(valid, "invalid pass: {:?}/{:?}", p.toggles, p.scope);
        }
    }

    #[test]
    fn dedup_keeps_first_highest_precedence_reason() {
        // Same item surfaced as review_requested first, then author later —
        // it must keep the stronger (first-seen) reason and appear once.
        let scoped = vec![
            Scoped {
                item: item("octo/repo#1"),
                reason: "review_requested",
            },
            Scoped {
                item: item("octo/repo#1"),
                reason: "author",
            },
            Scoped {
                item: item("octo/repo#2"),
                reason: "mentioned",
            },
        ];
        let out = dedup_first_reason(scoped);
        assert_eq!(out.len(), 2);
        let by_id: std::collections::HashMap<&str, &str> = out
            .iter()
            .map(|(i, r)| (i.external_id.as_str(), *r))
            .collect();
        assert_eq!(by_id.get("octo/repo#1"), Some(&"review_requested"));
        assert_eq!(by_id.get("octo/repo#2"), Some(&"mentioned"));
    }
}
