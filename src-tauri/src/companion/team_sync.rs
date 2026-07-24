//! Stage B data-plane mirror: write-through from the in-container `helmor serve`
//! to the team Worker's D1 mirror, so the desktop can browse session/message
//! history while the sandbox is asleep.
//!
//! Enabled ONLY when `HELMOR_SYNC_URL` (the Worker origin, injected by the
//! Worker's `ensureServe`) and `HELMOR_COMPANION_TOKEN` are present — i.e. the
//! cloud serve host. On the desktop / local-dev they're unset, so this is fully
//! inert. The write-through is BEST-EFFORT: a failed POST never affects the
//! local turn. A per-session `rowid` high-water-mark means only NEW messages are
//! sent on each live mutation; [`TeamSync::backfill_all`] (run once at serve
//! startup) pushes ALL existing rows, so history created before the write-through
//! existed is mirrored too — the self-healing reconcile.
//!
//! Single integration point: [`on_ui_mutation`] is called from
//! `crate::ui_sync::publish`, the choke point every mutation flows through.

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::Result;
use rusqlite::OptionalExtension;
use serde::Serialize;
use tauri::Manager;

use crate::models::db;
use crate::ui_sync::UiMutationEvent;

const SYNC_PATH: &str = "/team/sync";
/// Stage C: the Worker route that broadcasts one event to the team hub.
const EVENT_PATH: &str = "/team/event";

/// Tauri-managed write-through client. Inert unless `HELMOR_SYNC_URL` +
/// `HELMOR_COMPANION_TOKEN` are in the environment.
pub struct TeamSync {
    config: Option<SyncConfig>,
    /// Per-session high-water-mark: the max `session_messages.rowid` already
    /// mirrored. Append-only, so we only ever POST rows beyond it.
    cursors: Mutex<HashMap<String, i64>>,
    /// R2-E: per-workspace git-snapshot throttle (the git watcher can fire
    /// bursts; one snapshot per ~2s per workspace is plenty — the watcher
    /// re-fires on quiesce so the last burst always gets a trailing push).
    git_pushed_at: Mutex<HashMap<String, std::time::Instant>>,
}

struct SyncConfig {
    /// Worker origin, trailing slash stripped.
    sync_url: String,
    /// Shared companion token (the Worker classifies it as "admin", the only
    /// caller allowed to write the mirror).
    token: String,
    client: reqwest::Client,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncSession {
    id: String,
    workspace_id: String,
    title: Option<String>,
    status: Option<String>,
    model: Option<String>,
    agent_type: Option<String>,
    permission_mode: Option<String>,
    effort_level: Option<String>,
    action_kind: Option<String>,
    session_kind: Option<String>,
    is_hidden: bool,
    last_user_message_at: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncMessage {
    id: String,
    session_id: String,
    role: Option<String>,
    content: Option<String>,
    sent_at: Option<String>,
    created_at: Option<String>,
    author_id: Option<String>,
}

/// Authoritative session-id set for one workspace. The Worker prunes any D1
/// session for this workspace whose id isn't listed (empty ⇒ prune all).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceWorkspaceSessions {
    workspace_id: String,
    session_ids: Vec<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SyncPayload {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    sessions: Vec<SyncSession>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    messages: Vec<SyncMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    replace_workspace_sessions: Option<ReplaceWorkspaceSessions>,
    /// R2-E: workspace git snapshot pushed on `WorkspaceGitStateChanged` /
    /// `WorkspaceFilesChanged` so team clients read git status + changes from
    /// D1 instead of polling `/rpc` every 10s (which pinned the container
    /// awake for the whole attended session).
    #[serde(skip_serializing_if = "Option::is_none")]
    git_snapshot: Option<GitSnapshot>,
    /// Lever A: workspace-detail mirror rows so team mode answers the
    /// switch-time `get_workspace` from D1 with the container asleep.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    workspace_details: Vec<WorkspaceDetailRow>,
}

/// Zero shape invention (same contract as [`GitSnapshot`]): `detail` is the
/// exact `get_workspace` `WorkspaceDetail` serialization, stored opaque by the
/// Worker, so the frontend team branch consumes the D1 copy with the SAME type.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDetailRow {
    workspace_id: String,
    detail: serde_json::Value,
}

/// Zero shape invention: the two fields serialize the exact structs the
/// desktop `/rpc` commands return, so the frontend team branch can consume
/// the D1 copy with the SAME types.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitSnapshot {
    workspace_id: String,
    captured_at: String,
    version: u32,
    git_status: crate::git::ops::WorkspaceGitActionStatus,
    changes: Vec<crate::workspace::files::EditorFileListItem>,
}

/// Stage C realtime envelope. Mirrors the old SSE frame the desktop parsed (an
/// `event` name + JSON `data`), so `companionListen("ui-mutation", …)` consumes
/// it unchanged once the transport flips from SSE to the TeamHub WebSocket.
#[derive(Serialize)]
struct EventEnvelope<'a> {
    event: &'a str,
    data: &'a UiMutationEvent,
}

impl Default for TeamSync {
    fn default() -> Self {
        Self::from_env()
    }
}

impl TeamSync {
    /// Build from the process environment. Disabled (inert) unless both
    /// `HELMOR_SYNC_URL` and `HELMOR_COMPANION_TOKEN` are set + non-empty.
    pub fn from_env() -> Self {
        let url = std::env::var("HELMOR_SYNC_URL").ok();
        let token = std::env::var("HELMOR_COMPANION_TOKEN").ok();
        let config = match (url, token) {
            (Some(url), Some(token)) if !url.trim().is_empty() && !token.trim().is_empty() => {
                Some(SyncConfig {
                    sync_url: url.trim().trim_end_matches('/').to_string(),
                    token,
                    client: reqwest::Client::new(),
                })
            }
            _ => None,
        };
        Self {
            config,
            cursors: Mutex::new(HashMap::new()),
            git_pushed_at: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.config.is_some()
    }

    /// Mirror one session's row + its new messages (since the cursor).
    async fn sync_session(&self, session_id: &str) -> Result<()> {
        let Some(cfg) = self.config.as_ref() else {
            return Ok(());
        };
        let after = self
            .cursors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .copied()
            .unwrap_or(0);

        let sid = session_id.to_string();
        let (session, messages, max_rowid) = tauri::async_runtime::spawn_blocking(move || {
            read_session_and_new_messages(&sid, after)
        })
        .await??;
        // Session gone (deleted between event + read) — nothing to upsert; the
        // workspace-level prune (replaceWorkspaceSessions, sent on the same
        // SessionListChanged the delete fires) removes its D1 rows.
        let Some(session) = session else {
            return Ok(());
        };

        post_sync(
            cfg,
            &SyncPayload {
                sessions: vec![session],
                messages,
                ..Default::default()
            },
        )
        .await?;

        if let Some(max) = max_rowid {
            let mut cursors = self.cursors.lock().unwrap_or_else(|e| e.into_inner());
            let slot = cursors.entry(session_id.to_string()).or_insert(0);
            if max > *slot {
                *slot = max;
            }
        }
        Ok(())
    }

    /// Mirror every session ROW for a workspace (metadata only) — covers
    /// create / rename / hide / unhide. Message rows ride [`sync_session`].
    async fn sync_workspace_sessions(&self, workspace_id: &str) -> Result<()> {
        let Some(cfg) = self.config.as_ref() else {
            return Ok(());
        };
        let wid = workspace_id.to_string();
        let sessions =
            tauri::async_runtime::spawn_blocking(move || read_workspace_session_rows(&wid))
                .await??;
        // Send the AUTHORITATIVE id set (even when empty) so the Worker prunes
        // sessions the container no longer has — incl. the last one deleted.
        let session_ids = sessions.iter().map(|s| s.id.clone()).collect();
        post_sync(
            cfg,
            &SyncPayload {
                sessions,
                replace_workspace_sessions: Some(ReplaceWorkspaceSessions {
                    workspace_id: workspace_id.to_string(),
                    session_ids,
                }),
                ..Default::default()
            },
        )
        .await
    }

    /// Lever A: mirror one workspace's `get_workspace` detail to D1. Fired on
    /// the workspace-metadata events (see [`workspace_detail_target`]); cheap —
    /// a single SQLite row read, no git subprocesses.
    async fn sync_workspace_detail(&self, workspace_id: &str) -> Result<()> {
        let Some(cfg) = self.config.as_ref() else {
            return Ok(());
        };
        let wid = workspace_id.to_string();
        let row =
            tauri::async_runtime::spawn_blocking(move || read_workspace_detail(&wid)).await??;
        // Workspace gone (deleted between event + read) — nothing to mirror.
        let Some(row) = row else {
            return Ok(());
        };
        post_sync(
            cfg,
            &SyncPayload {
                workspace_details: vec![row],
                ..Default::default()
            },
        )
        .await
    }

    /// Lever A: mirror EVERY workspace's detail — `WorkspaceListChanged`
    /// (create / archive / delete carries no id) and the startup backfill.
    async fn sync_all_workspace_details(&self) -> Result<()> {
        let Some(cfg) = self.config.as_ref() else {
            return Ok(());
        };
        let rows = tauri::async_runtime::spawn_blocking(read_all_workspace_details).await??;
        if rows.is_empty() {
            return Ok(());
        }
        post_sync(
            cfg,
            &SyncPayload {
                workspace_details: rows,
                ..Default::default()
            },
        )
        .await
    }

    /// One-time reconcile run once at serve startup: push EVERY workspace's
    /// session rows (authoritative set ⇒ also prunes stale D1 rows) and then all
    /// messages for every session. Idempotent (id-keyed upserts + append-only
    /// inserts), so history created before the write-through existed gets
    /// mirrored, and any drift from a missed best-effort write self-heals. The
    /// cursors it sets mean subsequent live syncs only send new rows.
    pub async fn backfill_all(&self) -> Result<()> {
        if self.config.is_none() {
            return Ok(());
        }
        let workspace_ids = tauri::async_runtime::spawn_blocking(read_all_workspace_ids).await??;
        for workspace_id in &workspace_ids {
            if let Err(error) = self.sync_workspace_sessions(workspace_id).await {
                tracing::warn!(error = %format!("{error:#}"), workspace_id = %workspace_id, "team_sync: backfill workspace failed");
            }
        }
        let session_ids = tauri::async_runtime::spawn_blocking(read_all_session_ids).await??;
        for session_id in &session_ids {
            if let Err(error) = self.sync_session(session_id).await {
                tracing::warn!(error = %format!("{error:#}"), session_id = %session_id, "team_sync: backfill session failed");
            }
        }
        // Lever A: mirror every workspace's detail so pre-existing workspaces
        // are covered without waiting for their first mutation.
        if let Err(error) = self.sync_all_workspace_details().await {
            tracing::warn!(error = %format!("{error:#}"), "team_sync: backfill workspace details failed");
        }
        tracing::info!(
            workspaces = workspace_ids.len(),
            sessions = session_ids.len(),
            "team_sync: backfill complete"
        );
        Ok(())
    }

    /// Stage C: POST one already-serialized event envelope to the team hub for
    /// realtime broadcast to every connected member. Best-effort; inert when
    /// disabled. Does NOT touch D1 — that is the Stage-B data mirror's job.
    async fn broadcast_event(&self, body: String) -> Result<()> {
        let Some(cfg) = self.config.as_ref() else {
            return Ok(());
        };
        let response = cfg
            .client
            .post(format!("{}{}", cfg.sync_url, EVENT_PATH))
            .bearer_auth(&cfg.token)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await?;
        if !response.status().is_success() {
            anyhow::bail!("POST /team/event returned HTTP {}", response.status());
        }
        Ok(())
    }
}

impl TeamSync {
    /// R2-E: push one workspace's git snapshot to D1 (throttled per
    /// workspace). Best-effort like every other mirror job.
    async fn sync_git_snapshot(&self, workspace_id: &str) -> Result<()> {
        let Some(cfg) = self.config.as_ref() else {
            return Ok(());
        };
        const GIT_SNAPSHOT_THROTTLE: std::time::Duration = std::time::Duration::from_secs(2);
        {
            let mut pushed = self.git_pushed_at.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(at) = pushed.get(workspace_id) {
                if at.elapsed() < GIT_SNAPSHOT_THROTTLE {
                    return Ok(());
                }
            }
            pushed.insert(workspace_id.to_string(), std::time::Instant::now());
        }
        let wid = workspace_id.to_string();
        let snapshot =
            tauri::async_runtime::spawn_blocking(move || read_git_snapshot(&wid)).await??;
        let Some(snapshot) = snapshot else {
            return Ok(());
        };
        post_sync(
            cfg,
            &SyncPayload {
                git_snapshot: Some(snapshot),
                ..Default::default()
            },
        )
        .await
    }
}

/// Compute the git snapshot for a workspace (blocking: git subprocesses).
/// Chat / non-operational workspaces have no worktree — returns None.
fn read_git_snapshot(workspace_id: &str) -> Result<Option<GitSnapshot>> {
    let Some(record) = crate::models::workspaces::load_workspace_record_by_id(workspace_id)? else {
        return Ok(None);
    };
    if record.mode == crate::workspace::state::WorkspaceMode::Chat || !record.state.is_operational()
    {
        return Ok(None);
    }
    let root = crate::workspace::helpers::workspace_path(&record)?;
    let git_status = crate::git::ops::workspace_action_status(
        &root,
        record.remote.as_deref(),
        record
            .intended_target_branch
            .as_deref()
            .or(record.default_branch.as_deref()),
    )?;
    let changes = crate::workspace::files::list_workspace_changes_for_workspace(
        &root.display().to_string(),
        Some(workspace_id),
    )?;
    Ok(Some(GitSnapshot {
        workspace_id: workspace_id.to_string(),
        captured_at: crate::models::db::current_timestamp()?,
        version: 1,
        git_status,
        changes,
    }))
}

async fn post_sync(cfg: &SyncConfig, payload: &SyncPayload) -> Result<()> {
    let response = cfg
        .client
        .put(format!("{}{}", cfg.sync_url, SYNC_PATH))
        .bearer_auth(&cfg.token)
        .json(payload)
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("PUT /team/sync returned HTTP {}", response.status());
    }
    Ok(())
}

/// Called from `ui_sync::publish` for EVERY mutation. Two best-effort jobs, both
/// inert when disabled / unmanaged (tests / non-serve apps):
///   - Stage C realtime: relay EVERY event to the team hub (`/team/event`) so
///     members see it live WITHOUT the container holding a desktop stream.
///   - Stage B data mirror: the session/message subset → D1 (`/team/sync`).
///
/// ORDERING (round6 P1-6b): for an event with a Stage-B target, the broadcast
/// rides the SAME task as the mirror and fires only after the mirror attempt
/// completes. Broadcasting concurrently let the (single-POST) broadcast beat
/// the mirror's read-DB+PUT to the receivers, whose active refetch then read a
/// D1 that didn't have the row yet — the WP3 race R2-E's correction A reopened.
/// Events with no Stage-B target keep the immediate broadcast path.
pub fn on_ui_mutation<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: &UiMutationEvent) {
    // `try_state` (not `state`) so this never panics in a test app that didn't
    // `.manage(TeamSync)`. Gates both jobs below.
    if !app
        .try_state::<TeamSync>()
        .is_some_and(|sync| sync.is_enabled())
    {
        return;
    }

    // Serialize the broadcast envelope up front (the event is borrowed).
    let broadcast_body = serde_json::to_string(&EventEnvelope {
        event: "ui-mutation",
        data: event,
    })
    .ok();

    // Stage B — data mirror: only the session/message subset hits D1.
    let (session_id, workspace_id) = stage_b_targets(event);
    // Lever A — workspace-detail mirror target (rides the same deferred task).
    let detail_target = workspace_detail_target(event);

    // Stage C — realtime. Mirrored events DEFER their broadcast to the Stage-B
    // task below (P1-6b, see the fn docs); everything else broadcasts now.
    if !defers_broadcast(event) {
        if let Some(body) = broadcast_body.clone() {
            let app_evt = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(sync) = app_evt.try_state::<TeamSync>() {
                    if let Err(error) = sync.broadcast_event(body).await {
                        tracing::warn!(error = %format!("{error:#}"), "team_sync: event broadcast failed");
                    }
                }
            });
        }
    }

    // R2-E: git snapshot mirror — fed by the container git watcher's events
    // (the same ones the desktop bridge consumes), so team clients read git
    // state from D1 instead of polling the container.
    //
    // This MUST run before the no-target early-return below.
    // `WorkspaceGitStateChanged` / `WorkspaceFilesChanged` carry no Stage-B
    // session/workspace target (see `stage_b_targets` → `(None, None)`), so
    // when this block sat AFTER the guard it was dead code: the mirror was
    // never written for any workspace, and every team client's inspector read
    // the empty default ("No changes on this branch yet" / "Branch not
    // published to remote") no matter what the agent actually committed +
    // autopushed. Handle the git target first, THEN fall through to the guard.
    if let Some(wid) = git_snapshot_target(event) {
        let app_git = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(sync) = app_git.try_state::<TeamSync>() {
                if let Err(error) = sync.sync_git_snapshot(&wid).await {
                    tracing::warn!(error = %format!("{error:#}"), workspace_id = %wid, "team_sync: git snapshot mirror failed");
                }
            }
        });
    }

    if session_id.is_none() && workspace_id.is_none() && detail_target.is_none() {
        return;
    }

    // One task: mirror to completion, THEN broadcast (P1-6b). A failed mirror
    // attempt still broadcasts (best-effort — the receiver falls back to the
    // next event / backfill reconcile), but the systematic broadcast-first
    // race is gone: by broadcast time the row is in D1 on every success path.
    let deferred_broadcast = defers_broadcast(event).then_some(broadcast_body).flatten();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(sync) = app.try_state::<TeamSync>() else {
            return;
        };
        if let Some(sid) = session_id {
            if let Err(error) = sync.sync_session(&sid).await {
                tracing::warn!(error = %format!("{error:#}"), session_id = %sid, "team_sync: session mirror failed");
            }
        }
        if let Some(wid) = workspace_id {
            if let Err(error) = sync.sync_workspace_sessions(&wid).await {
                tracing::warn!(error = %format!("{error:#}"), workspace_id = %wid, "team_sync: workspace mirror failed");
            }
        }
        match detail_target {
            Some(WorkspaceDetailTarget::One(wid)) => {
                if let Err(error) = sync.sync_workspace_detail(&wid).await {
                    tracing::warn!(error = %format!("{error:#}"), workspace_id = %wid, "team_sync: workspace detail mirror failed");
                }
            }
            Some(WorkspaceDetailTarget::All) => {
                if let Err(error) = sync.sync_all_workspace_details().await {
                    tracing::warn!(error = %format!("{error:#}"), "team_sync: workspace details mirror failed");
                }
            }
            None => {}
        }
        if let Some(body) = deferred_broadcast {
            if let Err(error) = sync.broadcast_event(body).await {
                tracing::warn!(error = %format!("{error:#}"), "team_sync: event broadcast failed");
            }
        }
    });
}

/// Round6 P1-6b: does this event's broadcast wait for its D1 mirror?
/// Exactly the events with a Stage-B target OR a workspace-detail target —
/// their receivers react by READING the D1 mirror, so the row must be there
/// before the event fans out. Pure so the classification is unit-testable
/// next to `stage_b_targets` / `workspace_detail_target`.
fn defers_broadcast(event: &UiMutationEvent) -> bool {
    let (session_id, workspace_id) = stage_b_targets(event);
    session_id.is_some() || workspace_id.is_some() || workspace_detail_target(event).is_some()
}

/// Classify which Stage B mirror target(s) a ui-mutation drives: `(session_id,
/// workspace_id)`. Pure, so the routing is unit-testable without a Tauri app
/// handle — in particular that room-chat appends mirror like an appended message
/// (session target), which `WorkspaceListChanged` (neither target) never did.
fn stage_b_targets(event: &UiMutationEvent) -> (Option<String>, Option<String>) {
    let session_id = match event {
        UiMutationEvent::SessionTurnPersisted { session_id }
        | UiMutationEvent::SessionMessagesAppended { session_id }
        | UiMutationEvent::RoomChatMessageAppended { session_id, .. } => Some(session_id.clone()),
        _ => None,
    };
    let workspace_id = match event {
        UiMutationEvent::SessionListChanged { workspace_id } => Some(workspace_id.clone()),
        _ => None,
    };
    (session_id, workspace_id)
}

/// Lever A: which workspace-detail mirror push a ui-mutation drives, if any.
/// `One` covers the events that change ONE workspace's `get_workspace` output
/// (rename / status / active session / PR fields / session counts); `All`
/// covers `WorkspaceListChanged` (create / archive / delete — no id on the
/// event). Git-watcher events are deliberately NOT detail targets: the header's
/// dirty/ahead-behind chips read the separate git-snapshot mirror, and the
/// detail's DB-backed fields don't change on watcher ticks.
#[derive(Debug, PartialEq, Eq)]
enum WorkspaceDetailTarget {
    One(String),
    All,
}

fn workspace_detail_target(event: &UiMutationEvent) -> Option<WorkspaceDetailTarget> {
    match event {
        UiMutationEvent::WorkspaceChanged { workspace_id }
        | UiMutationEvent::SessionListChanged { workspace_id }
        | UiMutationEvent::WorkspaceChangeRequestChanged { workspace_id } => {
            Some(WorkspaceDetailTarget::One(workspace_id.clone()))
        }
        UiMutationEvent::WorkspaceListChanged => Some(WorkspaceDetailTarget::All),
        _ => None,
    }
}

/// Workspace whose git snapshot must be re-mirrored to D1 for this event, or
/// `None`. These git-watcher events carry NO Stage-B session/workspace target
/// (see `stage_b_targets`), so `on_ui_mutation` handles them BEFORE its
/// no-target early-return — otherwise the mirror is never written and team
/// clients read the empty git-status default.
fn git_snapshot_target(event: &UiMutationEvent) -> Option<String> {
    match event {
        UiMutationEvent::WorkspaceGitStateChanged { workspace_id }
        | UiMutationEvent::WorkspaceFilesChanged { workspace_id } => Some(workspace_id.clone()),
        _ => None,
    }
}

/// Read a session row + its messages with `rowid > after_rowid` (append-only),
/// returning the rows + the max rowid seen (the new cursor). `None` session ⇒
/// the row is gone.
fn read_session_and_new_messages(
    session_id: &str,
    after_rowid: i64,
) -> Result<(Option<SyncSession>, Vec<SyncMessage>, Option<i64>)> {
    let conn = db::read_conn()?;
    let session = conn
        .query_row(SESSION_ROW_SQL, [session_id], map_session_row)
        .optional()?;
    if session.is_none() {
        return Ok((None, Vec::new(), None));
    }

    let mut statement = conn.prepare(
        "SELECT rowid, id, role, content, sent_at, created_at, author_id
         FROM session_messages
         WHERE session_id = ?1 AND rowid > ?2
         ORDER BY rowid ASC",
    )?;
    let rows = statement.query_map(rusqlite::params![session_id, after_rowid], |row| {
        let rowid: i64 = row.get(0)?;
        Ok((
            rowid,
            SyncMessage {
                id: row.get(1)?,
                session_id: session_id.to_string(),
                role: row.get(2)?,
                content: row.get(3)?,
                sent_at: row.get(4)?,
                created_at: row.get(5)?,
                author_id: row.get(6)?,
            },
        ))
    })?;

    let mut max_rowid = after_rowid;
    let mut messages = Vec::new();
    for row in rows {
        let (rowid, message) = row?;
        if rowid > max_rowid {
            max_rowid = rowid;
        }
        messages.push(message);
    }
    let max = if messages.is_empty() {
        None
    } else {
        Some(max_rowid)
    };
    Ok((session, messages, max))
}

fn read_workspace_session_rows(workspace_id: &str) -> Result<Vec<SyncSession>> {
    let conn = db::read_conn()?;
    let mut statement = conn.prepare(
        "SELECT id, workspace_id, title, status, model, agent_type, permission_mode,
                effort_level, action_kind, session_kind, is_hidden, last_user_message_at,
                created_at, updated_at
         FROM sessions WHERE workspace_id = ?1",
    )?;
    let rows = statement.query_map([workspace_id], map_session_row)?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Lever A: one workspace's detail as the exact `get_workspace` serialization
/// (blocking: one SQLite row read + the cheap `record_to_detail` touches).
/// `None` ⇒ the workspace row is gone.
fn read_workspace_detail(workspace_id: &str) -> Result<Option<WorkspaceDetailRow>> {
    let Some(record) = crate::models::workspaces::load_workspace_record_by_id(workspace_id)? else {
        return Ok(None);
    };
    let detail = crate::workspace::workspaces::record_to_detail(record);
    Ok(Some(WorkspaceDetailRow {
        workspace_id: workspace_id.to_string(),
        detail: serde_json::to_value(detail)?,
    }))
}

/// Lever A: every workspace's detail row (the `All` target + startup backfill).
fn read_all_workspace_details() -> Result<Vec<WorkspaceDetailRow>> {
    let ids = {
        let conn = db::read_conn()?;
        let mut statement = conn.prepare("SELECT id FROM workspaces")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<String>, _>>()?
    };
    let mut details = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(row) = read_workspace_detail(&id)? {
            details.push(row);
        }
    }
    Ok(details)
}

/// Distinct workspace ids that currently have any session (backfill scope).
fn read_all_workspace_ids() -> Result<Vec<String>> {
    let conn = db::read_conn()?;
    let mut statement = conn.prepare("SELECT DISTINCT workspace_id FROM sessions")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Every session id (backfill: each gets its full message history pushed).
fn read_all_session_ids() -> Result<Vec<String>> {
    let conn = db::read_conn()?;
    let mut statement = conn.prepare("SELECT id FROM sessions")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

const SESSION_ROW_SQL: &str = "SELECT id, workspace_id, title, status, model, agent_type, \
     permission_mode, effort_level, action_kind, session_kind, is_hidden, \
     last_user_message_at, created_at, updated_at FROM sessions WHERE id = ?1";

fn map_session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncSession> {
    Ok(SyncSession {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        status: row.get(3)?,
        model: row.get(4)?,
        agent_type: row.get(5)?,
        permission_mode: row.get(6)?,
        effort_level: row.get(7)?,
        action_kind: row.get(8)?,
        session_kind: row.get(9)?,
        is_hidden: row.get::<_, Option<i64>>(10)?.unwrap_or(0) != 0,
        last_user_message_at: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire contract MUST match the Worker's `TeamSyncSessionRow` /
    /// `TeamSyncMessageRow` (camelCase). If this drifts, the mirror silently
    /// stops populating.
    #[test]
    fn rows_serialize_as_camel_case() {
        let session = SyncSession {
            id: "s1".into(),
            workspace_id: "w1".into(),
            title: Some("Hello".into()),
            status: Some("idle".into()),
            model: None,
            agent_type: Some("claude".into()),
            permission_mode: Some("default".into()),
            effort_level: None,
            action_kind: None,
            session_kind: Some("gui".into()),
            is_hidden: false,
            last_user_message_at: None,
            created_at: Some("2026-01-01T00:00:00Z".into()),
            updated_at: Some("2026-01-01T00:00:01Z".into()),
        };
        let json = serde_json::to_value(&session).unwrap();
        assert_eq!(json["workspaceId"], "w1");
        assert_eq!(json["agentType"], "claude");
        assert_eq!(json["sessionKind"], "gui");
        assert_eq!(json["isHidden"], false);
        assert!(json.get("workspace_id").is_none());

        let message = SyncMessage {
            id: "m1".into(),
            session_id: "s1".into(),
            role: Some("user".into()),
            content: Some("{\"type\":\"user_prompt\"}".into()),
            sent_at: Some("2026-01-01T00:00:02Z".into()),
            created_at: Some("2026-01-01T00:00:02Z".into()),
            author_id: Some("42".into()),
        };
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["sessionId"], "s1");
        assert_eq!(json["sentAt"], "2026-01-01T00:00:02Z");
        assert_eq!(json["authorId"], "42");
        assert!(json.get("session_id").is_none());
    }

    /// Empty arrays are omitted so a messages-only sync doesn't send `sessions:
    /// []` (and vice-versa).
    #[test]
    fn empty_arrays_are_omitted() {
        let payload = SyncPayload {
            messages: vec![SyncMessage {
                id: "m1".into(),
                session_id: "s1".into(),
                role: None,
                content: None,
                sent_at: None,
                created_at: None,
                author_id: None,
            }],
            ..Default::default()
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert!(json.get("sessions").is_none());
        assert!(json.get("messages").is_some());
        assert!(json.get("replaceWorkspaceSessions").is_none());
        assert!(json.get("workspaceDetails").is_none());
    }

    /// The authoritative-set prune field must serialize to
    /// `replaceWorkspaceSessions` with camelCase `sessionIds` — the Worker keys
    /// the prune off this exact shape.
    #[test]
    fn replace_workspace_sessions_serializes_as_camel_case() {
        let payload = SyncPayload {
            replace_workspace_sessions: Some(ReplaceWorkspaceSessions {
                workspace_id: "w1".into(),
                session_ids: vec!["s1".into(), "s2".into()],
            }),
            ..Default::default()
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["replaceWorkspaceSessions"]["workspaceId"], "w1");
        assert_eq!(json["replaceWorkspaceSessions"]["sessionIds"][0], "s1");
        assert_eq!(json["replaceWorkspaceSessions"]["sessionIds"][1], "s2");
        assert!(json.get("sessions").is_none());
    }

    /// Lever A wire contract: the detail mirror row must serialize to
    /// `workspaceDetails: [{workspaceId, detail}]` — the Worker's
    /// `TeamSyncInput.workspaceDetails` keys the upsert off this exact shape.
    #[test]
    fn workspace_details_serialize_as_camel_case() {
        let payload = SyncPayload {
            workspace_details: vec![WorkspaceDetailRow {
                workspace_id: "w1".into(),
                detail: serde_json::json!({ "id": "w1", "title": "Feature" }),
            }],
            ..Default::default()
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["workspaceDetails"][0]["workspaceId"], "w1");
        assert_eq!(json["workspaceDetails"][0]["detail"]["title"], "Feature");
        assert!(json.get("workspace_details").is_none());
        assert!(json.get("sessions").is_none());
    }

    /// Lever A routing: exactly the workspace-metadata events drive a detail
    /// push — `One` for id-carrying events, `All` for `WorkspaceListChanged`
    /// (create / archive / delete has no id). Git-watcher events are NOT
    /// detail targets (the header's dirty chips read the git-snapshot mirror).
    #[test]
    fn workspace_detail_targets_route_metadata_events_only() {
        assert_eq!(
            workspace_detail_target(&UiMutationEvent::WorkspaceChanged {
                workspace_id: "w1".into(),
            }),
            Some(WorkspaceDetailTarget::One("w1".into())),
        );
        assert_eq!(
            workspace_detail_target(&UiMutationEvent::SessionListChanged {
                workspace_id: "w1".into(),
            }),
            Some(WorkspaceDetailTarget::One("w1".into())),
        );
        assert_eq!(
            workspace_detail_target(&UiMutationEvent::WorkspaceChangeRequestChanged {
                workspace_id: "w1".into(),
            }),
            Some(WorkspaceDetailTarget::One("w1".into())),
        );
        assert_eq!(
            workspace_detail_target(&UiMutationEvent::WorkspaceListChanged),
            Some(WorkspaceDetailTarget::All),
        );
        for event in [
            UiMutationEvent::WorkspaceGitStateChanged {
                workspace_id: "w1".into(),
            },
            UiMutationEvent::WorkspaceFilesChanged {
                workspace_id: "w1".into(),
            },
            UiMutationEvent::SessionTurnPersisted {
                session_id: "s1".into(),
            },
        ] {
            assert_eq!(
                workspace_detail_target(&event),
                None,
                "must not be a detail target: {event:?}"
            );
        }
    }

    /// The realtime envelope must serialize to `{"event":"ui-mutation","data":…}`
    /// with `data` the tagged UiMutationEvent — the exact frame the desktop's
    /// `companionListen("ui-mutation", …)` consumer already parses.
    #[test]
    fn event_envelope_matches_sse_frame_shape() {
        let event = UiMutationEvent::SessionListChanged {
            workspace_id: "w1".into(),
        };
        let json = serde_json::to_value(EventEnvelope {
            event: "ui-mutation",
            data: &event,
        })
        .unwrap();
        assert_eq!(json["event"], "ui-mutation");
        assert_eq!(json["data"]["type"], "sessionListChanged");
        assert_eq!(json["data"]["workspaceId"], "w1");
    }

    /// WP3 fix: a room-chat append must mirror to D1 keyed by `session_id`,
    /// exactly like `SessionMessagesAppended`. Before WP3, room chat only
    /// published `WorkspaceListChanged` (see the next test) so it never reached
    /// the mirror — the root cause of "message flashes then disappears".
    #[test]
    fn room_chat_appended_routes_to_session_mirror() {
        let (session_id, workspace_id) =
            stage_b_targets(&UiMutationEvent::RoomChatMessageAppended {
                session_id: "s1".into(),
                author_id: Some("42".into()),
            });
        assert_eq!(session_id.as_deref(), Some("s1"));
        assert_eq!(workspace_id, None);
    }

    /// Regression guard on the OLD behaviour: `WorkspaceListChanged` maps to
    /// NEITHER Stage B target, which is exactly why room chat never hit D1.
    #[test]
    fn workspace_list_changed_routes_to_no_stage_b_target() {
        let (session_id, workspace_id) = stage_b_targets(&UiMutationEvent::WorkspaceListChanged);
        assert_eq!(session_id, None);
        assert_eq!(workspace_id, None);
    }

    /// The pre-existing session-mirror events still route unchanged (no
    /// regression from folding room chat into the same arm).
    #[test]
    fn session_appended_and_turn_persisted_still_route_to_session_mirror() {
        for event in [
            UiMutationEvent::SessionMessagesAppended {
                session_id: "s".into(),
            },
            UiMutationEvent::SessionTurnPersisted {
                session_id: "s".into(),
            },
        ] {
            let (session_id, workspace_id) = stage_b_targets(&event);
            assert_eq!(session_id.as_deref(), Some("s"));
            assert_eq!(workspace_id, None);
        }
    }

    /// `SessionListChanged` still routes to the workspace mirror (metadata).
    #[test]
    fn session_list_changed_routes_to_workspace_mirror() {
        let (session_id, workspace_id) = stage_b_targets(&UiMutationEvent::SessionListChanged {
            workspace_id: "w1".into(),
        });
        assert_eq!(session_id, None);
        assert_eq!(workspace_id.as_deref(), Some("w1"));
    }

    /// Round6 P1-6b: every Stage-B-mirrored event DEFERS its broadcast until
    /// the mirror attempt completes — the receivers' active refetch reads the
    /// D1 mirror, so broadcasting first let them read a D1 without the row
    /// (the WP3 race R2-E's correction A reopened). The deferral rides
    /// `on_ui_mutation`'s single Stage-B task (mirror awaits, then broadcast),
    /// so pinning the CLASSIFICATION here pins which events take that path.
    #[test]
    fn stage_b_mirrored_events_defer_their_broadcast() {
        for event in [
            UiMutationEvent::RoomChatMessageAppended {
                session_id: "s1".into(),
                author_id: Some("42".into()),
            },
            UiMutationEvent::SessionMessagesAppended {
                session_id: "s1".into(),
            },
            UiMutationEvent::SessionTurnPersisted {
                session_id: "s1".into(),
            },
            UiMutationEvent::SessionListChanged {
                workspace_id: "w1".into(),
            },
            // Lever A: detail-mirrored events defer too — team receivers of
            // WorkspaceChanged/WorkspaceListChanged refetch workspace detail,
            // which now reads the D1 mirror (same P1-6b stale-read race).
            UiMutationEvent::WorkspaceChanged {
                workspace_id: "w1".into(),
            },
            UiMutationEvent::WorkspaceChangeRequestChanged {
                workspace_id: "w1".into(),
            },
            UiMutationEvent::WorkspaceListChanged,
        ] {
            assert!(
                defers_broadcast(&event),
                "mirrored event must defer its broadcast: {event:?}"
            );
        }
    }

    /// Non-mirrored events keep the immediate broadcast path — deferral would
    /// add mirror-RTT latency to realtime signals with no D1 read to protect.
    /// (Git-watcher events stay immediate: their git-snapshot mirror push is
    /// throttled/fire-and-forget by design, not a read-after-broadcast dep.)
    #[test]
    fn non_mirrored_events_broadcast_immediately() {
        assert!(!defers_broadcast(
            &UiMutationEvent::WorkspaceGitStateChanged {
                workspace_id: "w1".into(),
            }
        ));
        assert!(!defers_broadcast(&UiMutationEvent::ActiveStreamsChanged));
    }

    /// Regression: the git-snapshot mirror must run BEFORE `on_ui_mutation`'s
    /// `session_id.is_none() && workspace_id.is_none()` early-return.
    /// `WorkspaceGitStateChanged` / `WorkspaceFilesChanged` (the container git
    /// watcher's events) carry NO Stage-B target, so gating the mirror on those
    /// alone turned it into dead code — `git_snapshots` was never written and
    /// every team inspector read the empty default ("No changes on this branch
    /// yet" / "Branch not published to remote") regardless of what the agent
    /// committed + autopushed. Pin the two facts that make the ordering
    /// load-bearing: git events have no Stage-B target, yet ARE mirror targets.
    #[test]
    fn git_events_are_mirror_targets_despite_no_stage_b_target() {
        for wid in ["w1", "w2"] {
            for event in [
                UiMutationEvent::WorkspaceGitStateChanged {
                    workspace_id: wid.into(),
                },
                UiMutationEvent::WorkspaceFilesChanged {
                    workspace_id: wid.into(),
                },
            ] {
                // Would hit on_ui_mutation's no-target early-return…
                assert_eq!(
                    stage_b_targets(&event),
                    (None, None),
                    "git event has no Stage-B target: {event:?}"
                );
                // …but IS a git-snapshot mirror target, handled before that guard.
                assert_eq!(
                    git_snapshot_target(&event).as_deref(),
                    Some(wid),
                    "git event must be a git-snapshot target: {event:?}"
                );
            }
        }
        // A pure session/workspace event is NOT a git-snapshot target.
        assert_eq!(
            git_snapshot_target(&UiMutationEvent::SessionListChanged {
                workspace_id: "w1".into(),
            }),
            None,
        );
        assert_eq!(
            git_snapshot_target(&UiMutationEvent::SessionTurnPersisted {
                session_id: "s1".into(),
            }),
            None,
        );
    }
}
