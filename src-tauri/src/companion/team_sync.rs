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
                replace_workspace_sessions: None,
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
                messages: vec![],
                replace_workspace_sessions: Some(ReplaceWorkspaceSessions {
                    workspace_id: workspace_id.to_string(),
                    session_ids,
                }),
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
pub fn on_ui_mutation<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: &UiMutationEvent) {
    // `try_state` (not `state`) so this never panics in a test app that didn't
    // `.manage(TeamSync)`. Gates both jobs below.
    if !app
        .try_state::<TeamSync>()
        .is_some_and(|sync| sync.is_enabled())
    {
        return;
    }

    // Stage C — realtime: broadcast EVERY ui-mutation. Serialize here (the event
    // is borrowed) then move the owned line into the spawn.
    if let Ok(body) = serde_json::to_string(&EventEnvelope {
        event: "ui-mutation",
        data: event,
    }) {
        let app_evt = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(sync) = app_evt.try_state::<TeamSync>() {
                if let Err(error) = sync.broadcast_event(body).await {
                    tracing::warn!(error = %format!("{error:#}"), "team_sync: event broadcast failed");
                }
            }
        });
    }

    // Stage B — data mirror: only the session/message subset hits D1.
    let session_id = match event {
        UiMutationEvent::SessionTurnPersisted { session_id }
        | UiMutationEvent::SessionMessagesAppended { session_id } => Some(session_id.clone()),
        _ => None,
    };
    let workspace_id = match event {
        UiMutationEvent::SessionListChanged { workspace_id } => Some(workspace_id.clone()),
        _ => None,
    };
    if session_id.is_none() && workspace_id.is_none() {
        return;
    }

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
    });
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
            sessions: Vec::new(),
            messages: vec![SyncMessage {
                id: "m1".into(),
                session_id: "s1".into(),
                role: None,
                content: None,
                sent_at: None,
                created_at: None,
                author_id: None,
            }],
            replace_workspace_sessions: None,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert!(json.get("sessions").is_none());
        assert!(json.get("messages").is_some());
        assert!(json.get("replaceWorkspaceSessions").is_none());
    }

    /// The authoritative-set prune field must serialize to
    /// `replaceWorkspaceSessions` with camelCase `sessionIds` — the Worker keys
    /// the prune off this exact shape.
    #[test]
    fn replace_workspace_sessions_serializes_as_camel_case() {
        let payload = SyncPayload {
            sessions: Vec::new(),
            messages: Vec::new(),
            replace_workspace_sessions: Some(ReplaceWorkspaceSessions {
                workspace_id: "w1".into(),
                session_ids: vec!["s1".into(), "s2".into()],
            }),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["replaceWorkspaceSessions"]["workspaceId"], "w1");
        assert_eq!(json["replaceWorkspaceSessions"]["sessionIds"][0], "s1");
        assert_eq!(json["replaceWorkspaceSessions"]["sessionIds"][1], "s2");
        assert!(json.get("sessions").is_none());
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
}
