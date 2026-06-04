//! Triage reaper: the automatic "review existing proposals" pass.
//!
//! Two reasons a proposed-task workspace should retire, both checked LIVE:
//!  - TERMINAL: its upstream GitHub PR/issue is merged or closed (work shipped/dropped).
//!  - NOT MINE: it no longer carries a concrete relation to the user — a teammate's
//!    open PR you were never assigned/asked to review, or a Slack chat that no longer
//!    @-mentions you. (Person entry point: only your items belong on your desk.)
//!
//! There is NO time-decay: an un-answered ask still needs doing, so age alone never
//! retires anything.
//!
//! Conservative + reversible: never archives a workspace with an active session, one
//! the user has already touched, or on ANY uncertain/failed live lookup (a network
//! blip leaves the workspace alone). Archive reuses the existing reversible path, so
//! a mistake is one "restore" away.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};

use anyhow::Result;
use chrono::Utc;
use rusqlite::OptionalExtension;
use tauri::{AppHandle, Manager, Runtime};

use crate::agents::ActiveStreams;
use crate::forge::github::inbox as gh;
use crate::forge::inbox::{InboxItemDetail, InboxSource};
use crate::models::db;
use crate::triage::fetcher::github as gh_fetch;
use crate::workspace::archive::{start_archive_workspace, ArchiveJobManager, ArchiveOrigin};

/// Re-check cadence. The fetch loop ticks every 5 min, but probing each
/// workspace's upstream costs API calls, so throttle the reaper to hourly.
const MIN_INTERVAL_SEC: i64 = 3600;
static LAST_RUN_EPOCH: AtomicI64 = AtomicI64::new(0);

struct TriageWorkspace {
    id: String,
    source_type: String,
    repository_id: String,
    source_ref: String,
}

/// Outcome of reviewing one workspace. Pure (unit-tested) where possible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Keep,
    RetireTerminal,
    RetireNotMine,
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
    let workspaces = match list_open_triage_workspaces() {
        Ok(w) => w,
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "triage reaper: list workspaces failed");
            return;
        }
    };
    if workspaces.is_empty() {
        return;
    }

    // Precompute, once per run, the "currently mine" sets used to detect
    // not-mine workspaces. A `None` value == the lookup failed → callers stay
    // conservative and KEEP (never retire on a failed/uncertain probe).
    let mut gh_involved: HashMap<String, Option<HashSet<String>>> = HashMap::new(); // owner_path -> involved external_ids
    let mut slack_mentions: HashMap<String, Option<HashSet<String>>> = HashMap::new(); // team_id -> @me channel_ids
    for ws in &workspaces {
        match ws.source_type.as_str() {
            "github" => {
                if let Some(owner_path) = owner_path_of(&ws.source_ref) {
                    gh_involved.entry(owner_path.clone()).or_insert_with(
                        || match repo_forge_login(&ws.repository_id) {
                            Ok(Some(login)) => {
                                gh_fetch::involved_external_ids(&login, &owner_path).ok()
                            }
                            _ => None,
                        },
                    );
                }
            }
            "slack" => {
                if let Some(team) = ws.source_ref.split(':').next().map(str::to_string) {
                    slack_mentions
                        .entry(team.clone())
                        .or_insert_with(|| slack_team_mention_channels(&team).ok());
                }
            }
            _ => {}
        }
    }

    let (mut terminal, mut not_mine) = (0u32, 0u32);
    for ws in &workspaces {
        match consider(app, ws, &gh_involved, &slack_mentions) {
            Ok(Verdict::RetireTerminal) => terminal += 1,
            Ok(Verdict::RetireNotMine) => not_mine += 1,
            Ok(Verdict::Keep) => {}
            Err(error) => tracing::debug!(
                workspace_id = %ws.id,
                error = %format!("{error:#}"),
                "triage reaper: skip workspace",
            ),
        }
    }
    tracing::info!(
        scanned = workspaces.len(),
        retired_terminal = terminal,
        retired_not_mine = not_mine,
        "triage reaper: pass complete",
    );
}

/// Decide + (when retiring & safe) archive one workspace.
fn consider<R: Runtime>(
    app: &AppHandle<R>,
    ws: &TriageWorkspace,
    gh_involved: &HashMap<String, Option<HashSet<String>>>,
    slack_mentions: &HashMap<String, Option<HashSet<String>>>,
) -> Result<Verdict> {
    // Never yank a worktree out from under a running agent.
    if app
        .state::<ActiveStreams>()
        .has_active_for_workspace(&ws.id)
    {
        return Ok(Verdict::Keep);
    }
    // Never retire something the user has already engaged with.
    if workspace_is_touched(&ws.id)? {
        return Ok(Verdict::Keep);
    }

    let verdict = match ws.source_type.as_str() {
        "github" => github_verdict(ws, gh_involved)?,
        "slack" => slack_verdict(ws, slack_mentions),
        _ => Verdict::Keep,
    };
    if verdict == Verdict::Keep {
        return Ok(Verdict::Keep);
    }

    // Reuse the existing reversible archive path (git unwatch, success/failure
    // events, sidebar reconcile, restore metadata).
    let manager = app.state::<ArchiveJobManager>();
    manager.prepare(&ws.id)?;
    start_archive_workspace(app, &ws.id, ArchiveOrigin::AutoAfterMerge)?;
    let reason = match verdict {
        Verdict::RetireTerminal => "upstream merged/closed",
        Verdict::RetireNotMine => "no longer involves you",
        Verdict::Keep => unreachable!(),
    };
    tracing::info!(
        workspace_id = %ws.id,
        source = %ws.source_type,
        reason,
        "triage reaper: archiving",
    );
    Ok(verdict)
}

// ---- GitHub --------------------------------------------------------------

fn github_verdict(
    ws: &TriageWorkspace,
    gh_involved: &HashMap<String, Option<HashSet<String>>>,
) -> Result<Verdict> {
    let Some(external_id) = upstream_external_id(&ws.source_ref) else {
        return Ok(Verdict::Keep);
    };
    let Some(login) = repo_forge_login(&ws.repository_id)? else {
        return Ok(Verdict::Keep);
    };
    // One detail probe yields terminal-state + issue/PR kind. Failure → Keep.
    let Some(detail) = probe_detail(&login, &external_id) else {
        return Ok(Verdict::Keep);
    };
    let terminal = detail_terminal(&detail) == Some(true);
    let is_issue = matches!(detail, InboxItemDetail::GithubIssue(_));
    let owner = external_id.split('/').next().unwrap_or("");
    let solo = owner.eq_ignore_ascii_case(&login);
    // `involves_me` only consulted when open; None == uncertain lookup → Keep.
    let involves_me = match gh_involved.get(&owner_path_of(&ws.source_ref).unwrap_or_default()) {
        Some(Some(set)) => Some(set.contains(&external_id)),
        _ => None,
    };
    Ok(gh_decision(terminal, solo && is_issue, involves_me))
}

/// Pure GitHub decision. terminal wins; else a solo-owned-repo issue is the
/// maintainer's triage inbox (keep); else keep iff currently mine, retire iff
/// definitely not mine, keep on uncertainty (`None`).
fn gh_decision(terminal: bool, solo_issue: bool, involves_me: Option<bool>) -> Verdict {
    if terminal {
        return Verdict::RetireTerminal;
    }
    if solo_issue {
        return Verdict::Keep;
    }
    match involves_me {
        Some(false) => Verdict::RetireNotMine,
        Some(true) | None => Verdict::Keep,
    }
}

/// Probe live upstream: try PR then issue; require the kind to actually answer.
fn probe_detail(login: &str, external_id: &str) -> Option<InboxItemDetail> {
    for source in [InboxSource::GithubPr, InboxSource::GithubIssue] {
        if let Ok(Some(detail)) = gh::get_inbox_item_detail(login, source, external_id) {
            if detail_terminal(&detail).is_some() {
                return Some(detail);
            }
        }
    }
    None
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

// ---- Slack ---------------------------------------------------------------

fn slack_verdict(
    ws: &TriageWorkspace,
    slack_mentions: &HashMap<String, Option<HashSet<String>>>,
) -> Verdict {
    // source_ref = "team:channel:anchor_ts"
    let mut parts = ws.source_ref.split(':');
    let (Some(team), Some(channel)) = (parts.next(), parts.next()) else {
        return Verdict::Keep;
    };
    let mentions = match slack_mentions.get(team) {
        Some(Some(set)) => Some(set.contains(channel)),
        _ => None, // uncertain
    };
    slack_decision(mentions)
}

/// Pure Slack decision: retire only when we are SURE the conversation no longer
/// @-mentions the user; keep on a current mention or any uncertainty.
fn slack_decision(mentions_me: Option<bool>) -> Verdict {
    match mentions_me {
        Some(false) => Verdict::RetireNotMine,
        Some(true) | None => Verdict::Keep,
    }
}

/// Channels in `team_id` that CURRENTLY @-mention the user. Errors (incl.
/// degraded discovery) propagate so the caller treats the team as uncertain
/// and keeps its workspaces.
fn slack_team_mention_channels(team_id: &str) -> Result<HashSet<String>> {
    let ws = crate::models::slack_workspaces::list_workspaces()?
        .into_iter()
        .find(|w| w.team_id == team_id)
        .ok_or_else(|| anyhow::anyhow!("slack workspace {team_id} not found"))?;
    let creds = crate::slack::credentials::load_credentials(team_id)?
        .ok_or_else(|| anyhow::anyhow!("no slack credentials for {team_id}"))?;
    let outcome = crate::slack::relevance::involved_channel_hits(
        &creds,
        &ws.my_user_id,
        crate::triage::fetcher::COLD_START_DAYS,
    )?;
    if let Some(reason) = outcome.degraded {
        anyhow::bail!("slack mention discovery degraded: {reason}");
    }
    Ok(outcome
        .value
        .into_iter()
        .filter(|h| h.is_mention)
        .map(|h| h.channel_id)
        .collect())
}

// ---- DB helpers ----------------------------------------------------------

fn list_open_triage_workspaces() -> Result<Vec<TriageWorkspace>> {
    let conn = db::read_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, triage_source_type, repository_id, triage_source_ref
         FROM workspaces
         WHERE kind = 'ai_triage'
           AND triage_source_type IN ('github', 'slack')
           AND triage_source_ref IS NOT NULL
           AND state != 'archived'",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TriageWorkspace {
            id: row.get(0)?,
            source_type: row.get(1)?,
            repository_id: row.get(2)?,
            source_ref: row.get(3)?,
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

/// `"owner/repo#NN:anchor"` → `"owner/repo#NN"`. None for non-forge refs (Slack).
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

/// `"owner/repo#NN:anchor"` → `"owner/repo"`.
fn owner_path_of(source_ref: &str) -> Option<String> {
    upstream_external_id(source_ref).and_then(|ext| ext.split('#').next().map(str::to_string))
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
    fn parses_external_id_and_owner_path() {
        assert_eq!(
            upstream_external_id("dosu-ai/dosu#10802:10802").as_deref(),
            Some("dosu-ai/dosu#10802"),
        );
        assert_eq!(
            upstream_external_id("dosu-ai/dosu#10763:github:dosu-ai/dosu#10763").as_deref(),
            Some("dosu-ai/dosu#10763"),
        );
        assert_eq!(
            owner_path_of("dosu-ai/dosu#10802:10802").as_deref(),
            Some("dosu-ai/dosu")
        );
        // slack-style ref has no '#'/'/': not a forge item
        assert_eq!(upstream_external_id("T056:C05:1780295262.50"), None);
        assert_eq!(owner_path_of("T056:C05:1780295262.50"), None);
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

    #[test]
    fn github_decision_matrix() {
        // terminal always retires (even a solo-repo issue that closed).
        assert_eq!(gh_decision(true, true, Some(true)), Verdict::RetireTerminal);
        assert_eq!(gh_decision(true, false, None), Verdict::RetireTerminal);
        // open solo-repo issue: maintainer inbox → keep even if not "involved".
        assert_eq!(gh_decision(false, true, Some(false)), Verdict::Keep);
        // open, currently mine → keep; definitely not mine → retire.
        assert_eq!(gh_decision(false, false, Some(true)), Verdict::Keep);
        assert_eq!(
            gh_decision(false, false, Some(false)),
            Verdict::RetireNotMine
        );
        // open, uncertain involvement lookup → conservative keep.
        assert_eq!(gh_decision(false, false, None), Verdict::Keep);
    }

    #[test]
    fn slack_decision_matrix() {
        assert_eq!(slack_decision(Some(true)), Verdict::Keep);
        assert_eq!(slack_decision(Some(false)), Verdict::RetireNotMine);
        assert_eq!(slack_decision(None), Verdict::Keep); // uncertain → keep
    }
}
