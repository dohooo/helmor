//! Triage reaper: the automatic "review existing proposals" pass.
//!
//! Every `ai_triage` workspace was created because triage thought an upstream
//! GitHub PR/issue needed Caspian. Once that upstream is merged or closed the
//! proposed task is done — but nothing retires it, so stale "review this …"
//! workspaces pile up (61 open, 40 of them already merged/closed at the time of
//! writing). The reaper closes that loop: on a throttled cadence it re-checks
//! each open triage workspace's upstream live state and, when the upstream is
//! terminal, archives the workspace through the EXISTING reversible archive path.
//!
//! Deliberately conservative ("smart, no toggle", per product intent): it never
//! archives a workspace the user has started working in, never one with an
//! active session, and never on an uncertain upstream signal (a failed/ambiguous
//! fetch leaves the workspace alone). Archive is reversible (restore), so the
//! worst case of a mistake is one undo.

use std::sync::atomic::{AtomicI64, Ordering};

use anyhow::Result;
use chrono::Utc;
use rusqlite::OptionalExtension;
use tauri::{AppHandle, Manager, Runtime};

use crate::agents::ActiveStreams;
use crate::forge::github::inbox as gh;
use crate::forge::inbox::{InboxItemDetail, InboxSource};
use crate::models::db;
use crate::workspace::archive::{start_archive_workspace, ArchiveJobManager, ArchiveOrigin};

/// Re-check cadence. The fetch loop ticks every 5 min, but probing each
/// workspace's upstream costs an API call, so throttle the reaper to hourly.
const MIN_INTERVAL_SEC: i64 = 3600;
static LAST_RUN_EPOCH: AtomicI64 = AtomicI64::new(0);

struct TriageWorkspace {
    id: String,
    repository_id: String,
    source_ref: String,
}

/// Throttled entry point, called from the fetcher scheduler loop after each
/// tick. Gated on triage being enabled; independent of `auto_run` / the local
/// LLM (cleanup is deterministic and should happen even in manual mode).
pub fn maybe_run<R: Runtime>(app: &AppHandle<R>) {
    match crate::triage::load_config() {
        Ok(cfg) if cfg.enabled => {}
        Ok(_) => return,
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "triage reaper: load_config failed");
            return;
        }
    }
    let now = Utc::now().timestamp();
    let last = LAST_RUN_EPOCH.load(Ordering::Relaxed);
    if last != 0 && now - last < MIN_INTERVAL_SEC {
        return;
    }
    LAST_RUN_EPOCH.store(now, Ordering::Relaxed);
    run_once(app);
}

fn run_once<R: Runtime>(app: &AppHandle<R>) {
    let workspaces = match list_open_github_triage_workspaces() {
        Ok(w) => w,
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "triage reaper: list workspaces failed");
            return;
        }
    };
    if workspaces.is_empty() {
        return;
    }
    let mut archived = 0u32;
    for ws in &workspaces {
        match consider(app, ws) {
            Ok(true) => archived += 1,
            Ok(false) => {}
            Err(error) => tracing::debug!(
                workspace_id = %ws.id,
                error = %format!("{error:#}"),
                "triage reaper: skip workspace",
            ),
        }
    }
    tracing::info!(
        scanned = workspaces.len(),
        archived,
        "triage reaper: pass complete",
    );
}

/// Decide + (when terminal & safe) archive one workspace. Ok(true) = archived.
fn consider<R: Runtime>(app: &AppHandle<R>, ws: &TriageWorkspace) -> Result<bool> {
    // Never yank a worktree out from under a running agent.
    if app
        .state::<ActiveStreams>()
        .has_active_for_workspace(&ws.id)
    {
        return Ok(false);
    }
    // Only retire UNTOUCHED, never-processed proposals — exactly the case the
    // user described ("a PR already merged that it told me to review but I
    // never got to"). If he has engaged with it, leave it for him.
    if workspace_is_touched(&ws.id)? {
        return Ok(false);
    }
    // Resolve the upstream's live state; bail (leave alone) on any uncertainty.
    let Some(external_id) = upstream_external_id(&ws.source_ref) else {
        return Ok(false);
    };
    let Some(login) = repo_forge_login(&ws.repository_id)? else {
        return Ok(false);
    };
    if !upstream_is_terminal(&login, &external_id) {
        return Ok(false);
    }
    // Reuse the existing reversible archive path (git unwatch, success/failure
    // events, sidebar reconcile, restore metadata) — mirrors
    // `try_auto_archive_after_merge`.
    let manager = app.state::<ArchiveJobManager>();
    manager.prepare(&ws.id)?;
    start_archive_workspace(app, &ws.id, ArchiveOrigin::AutoAfterMerge)?;
    tracing::info!(
        workspace_id = %ws.id,
        upstream = %external_id,
        "triage reaper: archiving (upstream merged/closed)",
    );
    Ok(true)
}

fn list_open_github_triage_workspaces() -> Result<Vec<TriageWorkspace>> {
    let conn = db::read_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, repository_id, triage_source_ref
         FROM workspaces
         WHERE kind = 'ai_triage'
           AND triage_source_type = 'github'
           AND triage_source_ref IS NOT NULL
           AND state != 'archived'",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TriageWorkspace {
            id: row.get(0)?,
            repository_id: row.get(1)?,
            source_ref: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// True when the user has engaged with the workspace (sent the first message,
/// or any non-priming message exists). Such workspaces are never auto-archived.
fn workspace_is_touched(workspace_id: &str) -> Result<bool> {
    let conn = db::read_conn()?;
    let consumed: i64 = conn.query_row(
        "SELECT COALESCE(ai_priming_consumed, 0) FROM workspaces WHERE id = ?1",
        rusqlite::params![workspace_id],
        |row| row.get(0),
    )?;
    if consumed != 0 {
        return Ok(true);
    }
    let non_priming: i64 = conn.query_row(
        "SELECT COUNT(*) FROM session_messages sm
         JOIN sessions s ON sm.session_id = s.id
         WHERE s.workspace_id = ?1 AND COALESCE(sm.is_ai_priming, 0) = 0",
        rusqlite::params![workspace_id],
        |row| row.get(0),
    )?;
    Ok(non_priming > 0)
}

fn repo_forge_login(repository_id: &str) -> Result<Option<String>> {
    let conn = db::read_conn()?;
    let login: Option<String> = conn
        .query_row(
            "SELECT forge_login FROM repos WHERE id = ?1",
            rusqlite::params![repository_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(login.filter(|l| !l.trim().is_empty()))
}

/// `"owner/repo#NN:anchor"` → `"owner/repo#NN"`. Returns None for shapes that
/// aren't a forge reference (e.g. Slack `team:channel:ts`), so the reaper only
/// probes real GitHub items.
fn upstream_external_id(source_ref: &str) -> Option<String> {
    let head = source_ref
        .split_once(':')
        .map(|(before, _)| before)
        .unwrap_or(source_ref);
    if head.contains('#') && head.contains('/') {
        Some(head.to_string())
    } else {
        None
    }
}

/// Probe live upstream state. Tries PR then issue. Any fetch error or unknown
/// shape → `false` (conservative: never reap on uncertainty).
fn upstream_is_terminal(login: &str, external_id: &str) -> bool {
    for source in [InboxSource::GithubPr, InboxSource::GithubIssue] {
        if let Ok(Some(detail)) = gh::get_inbox_item_detail(login, source, external_id) {
            if let Some(terminal) = detail_terminal(&detail) {
                return terminal;
            }
        }
    }
    false
}

/// `Some(true)` when merged/closed, `Some(false)` when still open, `None` when
/// the detail kind can't answer (so the caller keeps probing / stays safe).
fn detail_terminal(detail: &InboxItemDetail) -> Option<bool> {
    match detail {
        InboxItemDetail::GithubPr(pr) => Some(
            pr.merged
                || pr.state.eq_ignore_ascii_case("closed")
                || pr.state.eq_ignore_ascii_case("merged"),
        ),
        InboxItemDetail::GithubIssue(issue) => Some(issue.state.eq_ignore_ascii_case("closed")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::github::inbox::detail::{GithubIssueDetail, GithubPullRequestDetail};

    fn pr(state: &str, merged: bool) -> InboxItemDetail {
        InboxItemDetail::GithubPr(Box::new(GithubPullRequestDetail {
            external_id: "o/r#1".into(),
            title: "t".into(),
            body: None,
            url: "u".into(),
            state: state.into(),
            merged,
            draft: false,
            author_login: None,
            base_ref_name: None,
            head_ref_name: None,
            created_at: None,
            updated_at: None,
        }))
    }

    fn issue(state: &str) -> InboxItemDetail {
        InboxItemDetail::GithubIssue(Box::new(GithubIssueDetail {
            external_id: "o/r#1".into(),
            title: "t".into(),
            body: None,
            url: "u".into(),
            state: state.into(),
            state_reason: None,
            author_login: None,
            created_at: None,
            updated_at: None,
            closed_at: None,
        }))
    }

    #[test]
    fn parses_external_id_from_composed_ref() {
        assert_eq!(
            upstream_external_id("dosu-ai/dosu#10802:10802").as_deref(),
            Some("dosu-ai/dosu#10802"),
        );
        // doubled-anchor shape still resolves to the leading reference
        assert_eq!(
            upstream_external_id("dosu-ai/dosu#10763:github:dosu-ai/dosu#10763").as_deref(),
            Some("dosu-ai/dosu#10763"),
        );
        // slack-style ref has no '#'/'/': not a forge item
        assert_eq!(upstream_external_id("T056:C05:1780295262.50"), None);
    }

    #[test]
    fn pr_terminal_logic() {
        assert_eq!(detail_terminal(&pr("OPEN", false)), Some(false));
        assert_eq!(detail_terminal(&pr("OPEN", true)), Some(true)); // merged
        assert_eq!(detail_terminal(&pr("CLOSED", false)), Some(true));
        assert_eq!(detail_terminal(&pr("MERGED", false)), Some(true));
    }

    #[test]
    fn issue_terminal_logic() {
        assert_eq!(detail_terminal(&issue("OPEN")), Some(false));
        assert_eq!(detail_terminal(&issue("CLOSED")), Some(true));
    }
}
