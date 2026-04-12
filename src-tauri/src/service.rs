//! Public service facade for non-Tauri consumers (e.g. `helmorctl`).
//!
//! Re-exports domain types and functions from the core backend modules so
//! that `[[bin]]` targets can use them without going through Tauri commands.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

// ---- Types ----

pub use crate::commands::DataInfo;
pub use crate::repos::{AddRepositoryResponse, RepositoryCreateOption};
pub use crate::sessions::{CreateSessionResponse, WorkspaceSessionSummary};
pub use crate::workspaces::{
    CreateWorkspaceResponse, WorkspaceDetail, WorkspaceSidebarGroup, WorkspaceSidebarRow,
};

// ---- Domain functions ----

pub use crate::models::workspaces::load_workspace_records;
pub use crate::repos::{add_repository_from_local_path, list_repositories};
pub use crate::sessions::{create_session, list_workspace_sessions};
pub use crate::workspaces::{
    create_workspace_from_repo_impl, get_workspace, list_workspace_groups,
};

/// Build [`DataInfo`] without needing a Tauri runtime.
pub fn get_data_info() -> Result<DataInfo> {
    let data_dir = crate::data_dir::data_dir()?;
    let db_path = crate::data_dir::db_path()?;
    Ok(DataInfo {
        data_mode: crate::data_dir::data_mode_label().to_string(),
        data_dir: data_dir.display().to_string(),
        db_path: db_path.display().to_string(),
    })
}

/// Resolve a repository reference to a repository ID.
///
/// Accepts either a UUID or a repository name (case-insensitive exact match).
pub fn resolve_repo_ref(reference: &str) -> Result<String> {
    if looks_like_uuid(reference) {
        return Ok(reference.to_string());
    }

    let repos = list_repositories()?;
    let matches: Vec<_> = repos
        .iter()
        .filter(|r| r.name.eq_ignore_ascii_case(reference))
        .collect();

    match matches.len() {
        0 => bail!("No repository found matching '{reference}'"),
        1 => Ok(matches[0].id.clone()),
        n => {
            bail!("Ambiguous repo ref '{reference}' matches {n} repositories. Use a UUID instead.")
        }
    }
}

/// Resolve a workspace reference to a workspace ID.
///
/// Accepts either:
/// - A UUID string (validated to exist)
/// - A `repo-name/directory-name` human-readable ref
pub fn resolve_workspace_ref(reference: &str) -> Result<String> {
    if looks_like_uuid(reference) {
        let _detail = get_workspace(reference)?;
        return Ok(reference.to_string());
    }

    if let Some((repo_name, dir_name)) = reference.split_once('/') {
        let records = load_workspace_records()?;
        let matches: Vec<_> = records
            .into_iter()
            .filter(|r| {
                r.repo_name.eq_ignore_ascii_case(repo_name)
                    && r.directory_name.eq_ignore_ascii_case(dir_name)
                    && r.state != "archived"
            })
            .collect();

        match matches.len() {
            0 => bail!("No workspace found matching '{reference}'"),
            1 => return Ok(matches.into_iter().next().unwrap().id),
            n => bail!("Ambiguous ref '{reference}' matches {n} workspaces. Use a UUID instead."),
        }
    }

    bail!("Invalid workspace ref '{reference}'. Use a UUID or repo-name/directory-name format.")
}

fn looks_like_uuid(s: &str) -> bool {
    s.len() == 36 && s.chars().filter(|c| *c == '-').count() == 4
}

// ---------------------------------------------------------------------------
// Agent streaming — `helmor send`
// ---------------------------------------------------------------------------

pub struct SendMessageParams {
    pub workspace_ref: String,
    pub session_id: Option<String>,
    pub prompt: String,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResult {
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub persisted: bool,
}

/// Send a prompt to an AI agent. When the Helmor desktop app is running,
/// the message is queued as a pending CLI send so the app's shared sidecar
/// handles it — this gives the frontend live streaming updates. When the
/// app is not running, falls back to creating an independent sidecar.
pub fn send_message(
    params: SendMessageParams,
    on_event: &mut dyn FnMut(&crate::agents::AgentStreamEvent),
) -> Result<SendMessageResult> {
    use crate::agents::AgentStreamEvent;
    use crate::pipeline::PipelineEmit;

    // 1. Resolve workspace + working directory
    let workspace_id = resolve_workspace_ref(&params.workspace_ref)?;
    let detail = get_workspace(&workspace_id)?;
    let cwd = detail
        .root_path
        .as_deref()
        .context("Workspace has no root_path")?
        .to_string();

    // 2. Resolve session
    let session_id = match params.session_id {
        Some(sid) => sid,
        None => match detail.active_session_id {
            Some(sid) => sid,
            None => {
                create_session(
                    &workspace_id,
                    None,
                    params
                        .permission_mode
                        .as_deref()
                        .filter(|mode| *mode == "plan"),
                )?
                .session_id
            }
        },
    };

    // 3. Resolve model
    let model_id = params.model.as_deref().unwrap_or("opus-1m");
    let model = crate::agents::find_model_definition(model_id)
        .with_context(|| format!("Unknown model: {model_id}"))?;

    // ── App delegation ──────────────────────────────────────────────
    // When the desktop app is running, queue the prompt as a pending
    // send and return immediately. The app's focus handler picks it up
    // and streams through its shared sidecar so the frontend sees live
    // updates. The CLI prints a short confirmation instead of streaming.
    if is_app_running() {
        // Persist user message so the app's conversation container
        // shows the optimistic user bubble right away.
        let conn = crate::models::db::open_connection(true)?;
        let timestamp = crate::models::db::current_timestamp()?;
        let user_msg_id = Uuid::new_v4().to_string();
        let turn_id = Uuid::new_v4().to_string();
        let user_content = serde_json::json!({
            "type": "user_prompt",
            "text": params.prompt,
        })
        .to_string();
        conn.execute(
            r#"INSERT INTO session_messages
               (id, session_id, role, content, created_at, sent_at, model, turn_id, is_resumable_message)
               VALUES (?1, ?2, 'user', ?3, ?4, ?4, ?5, ?6, 0)"#,
            params![user_msg_id, session_id, user_content, timestamp, model.id, turn_id],
        )?;

        insert_pending_cli_send(
            &workspace_id,
            &session_id,
            &params.prompt,
            Some(model_id),
            params.permission_mode.as_deref(),
        )?;

        // Emit a minimal "done" event so the CLI knows the handoff succeeded.
        on_event(&AgentStreamEvent::Done {
            persisted: true,
            session_id: Some(session_id.clone()),
            provider: model.provider.to_string(),
            model_id: model.id.to_string(),
            resolved_model: String::new(),
            working_directory: String::new(),
        });

        return Ok(SendMessageResult {
            session_id,
            provider: model.provider.to_string(),
            model: model.id.to_string(),
            persisted: true,
        });
    }

    // ── Standalone mode (app not running) ────────────────────────────
    // 4. Create sidecar
    let sidecar = crate::sidecar::ManagedSidecar::new();

    // 5. Build and send request
    let request_id = Uuid::new_v4().to_string();
    let sidecar_req = crate::sidecar::SidecarRequest {
        id: request_id.clone(),
        method: "sendMessage".to_string(),
        params: serde_json::json!({
            "sessionId": session_id,
            "prompt": params.prompt,
            "model": model.cli_model,
            "cwd": cwd,
            "provider": model.provider,
            "permissionMode": params.permission_mode.as_deref().unwrap_or("auto"),
        }),
    };

    let rx = sidecar.subscribe(&request_id);
    sidecar
        .send(&sidecar_req)
        .context("Failed to send request to sidecar")?;

    // 6. Persist user message + set session streaming
    let conn = crate::models::db::open_connection(true)?;
    let timestamp = crate::models::db::current_timestamp()?;
    let turn_id = Uuid::new_v4().to_string();
    let user_msg_id = Uuid::new_v4().to_string();

    let user_content = serde_json::json!({
        "type": "user_prompt",
        "text": params.prompt,
    })
    .to_string();

    conn.execute(
        "UPDATE sessions SET status = 'streaming', updated_at = ?1 WHERE id = ?2",
        params![timestamp, session_id],
    )?;
    conn.execute(
        r#"INSERT INTO session_messages
           (id, session_id, role, content, created_at, sent_at, model, turn_id, is_resumable_message)
           VALUES (?1, ?2, 'user', ?3, ?4, ?4, ?5, ?6, 0)"#,
        params![user_msg_id, session_id, user_content, timestamp, model.id, turn_id],
    )?;

    // 7. Event loop
    let mut pipeline = crate::pipeline::MessagePipeline::new(
        model.provider,
        model.cli_model,
        &request_id,
        &session_id,
    );
    let mut persisted_turn_count: usize = 0;
    let mut resolved_model = model.cli_model.to_string();
    let mut resolved_session_id: Option<String> = None;

    for event in rx.iter() {
        if let Some(sid) = event.session_id() {
            if resolved_session_id.is_none() {
                resolved_session_id = Some(sid.to_string());
                let _ = conn.execute(
                    "UPDATE sessions SET provider_session_id = ?2, agent_type = ?3 WHERE id = ?1",
                    params![session_id, sid, model.provider],
                );
            }
        }

        match event.event_type() {
            "end" | "aborted" => {
                let is_aborted = event.event_type() == "aborted";

                if is_aborted {
                    pipeline.accumulator.mark_pending_tools_aborted();
                }
                pipeline.accumulator.flush_pending();
                if is_aborted {
                    pipeline.materialize_partial();
                    pipeline.accumulator.append_aborted_notice();
                }

                // Persist remaining turns
                let model_str = pipeline.accumulator.resolved_model().to_string();
                while persisted_turn_count < pipeline.accumulator.turns_len() {
                    let turn = pipeline.accumulator.turn_at(persisted_turn_count);
                    if let Err(e) = persist_turn(&conn, &session_id, turn, &model_str, &turn_id) {
                        tracing::error!("Failed to persist turn: {e}");
                        break;
                    }
                    persisted_turn_count += 1;
                }

                let output = pipeline
                    .accumulator
                    .drain_output(resolved_session_id.as_deref());
                if !output.assistant_text.is_empty() {
                    resolved_model = output.resolved_model.clone();
                }

                let _ = finalize_session(
                    &conn,
                    &session_id,
                    model.id,
                    model.provider,
                    "idle",
                    params.permission_mode.as_deref(),
                );

                if is_aborted {
                    let final_messages = pipeline.finish();
                    on_event(&AgentStreamEvent::Update {
                        messages: final_messages,
                    });
                    let reason = event
                        .raw
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("user_requested")
                        .to_string();
                    on_event(&AgentStreamEvent::Aborted {
                        provider: model.provider.to_string(),
                        model_id: model.id.to_string(),
                        resolved_model: resolved_model.clone(),
                        session_id: resolved_session_id.clone(),
                        working_directory: cwd.clone(),
                        persisted: true,
                        reason,
                    });
                } else {
                    on_event(&AgentStreamEvent::Done {
                        provider: model.provider.to_string(),
                        model_id: model.id.to_string(),
                        resolved_model: resolved_model.clone(),
                        session_id: resolved_session_id.clone(),
                        working_directory: cwd.clone(),
                        persisted: true,
                    });
                }
                break;
            }

            "permissionRequest" => {
                let pid = event
                    .raw
                    .get("permissionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let approve = crate::sidecar::SidecarRequest {
                    id: Uuid::new_v4().to_string(),
                    method: "permissionResponse".to_string(),
                    params: serde_json::json!({
                        "permissionId": pid,
                        "behavior": "allow",
                    }),
                };
                let _ = sidecar.send(&approve);
            }

            "error" => {
                let msg = event
                    .raw
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown sidecar error")
                    .to_string();
                let _ = finalize_session(
                    &conn,
                    &session_id,
                    model.id,
                    model.provider,
                    "idle",
                    params.permission_mode.as_deref(),
                );
                on_event(&AgentStreamEvent::Error {
                    message: msg,
                    persisted: true,
                    internal: false,
                });
                break;
            }

            _ => {
                let line = serde_json::to_string(&event.raw).unwrap_or_default();
                if !line.is_empty() && line != "{}" {
                    let emit = pipeline.push_event(&event.raw, &line);

                    let model_str = pipeline.accumulator.resolved_model().to_string();
                    while persisted_turn_count < pipeline.accumulator.turns_len() {
                        let turn = pipeline.accumulator.turn_at(persisted_turn_count);
                        if let Err(e) = persist_turn(&conn, &session_id, turn, &model_str, &turn_id)
                        {
                            tracing::error!("Failed to persist turn: {e}");
                            break;
                        }
                        persisted_turn_count += 1;
                    }

                    match emit {
                        PipelineEmit::Full(messages) => {
                            on_event(&AgentStreamEvent::Update { messages });
                        }
                        PipelineEmit::Partial(message) => {
                            on_event(&AgentStreamEvent::StreamingPartial { message });
                        }
                        PipelineEmit::None => {}
                    }
                }
            }
        }
    }

    // 8. Cleanup
    sidecar.unsubscribe(&request_id);
    sidecar.shutdown(Duration::from_millis(500), Duration::from_secs(2));

    Ok(SendMessageResult {
        session_id,
        provider: model.provider.to_string(),
        model: resolved_model,
        persisted: true,
    })
}

fn persist_turn(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn: &crate::pipeline::types::CollectedTurn,
    model: &str,
    turn_id: &str,
) -> Result<()> {
    let now = crate::models::db::current_timestamp()?;
    let msg_id = turn.id.clone();
    conn.execute(
        r#"INSERT INTO session_messages
           (id, session_id, role, content, created_at, sent_at, model, turn_id, is_resumable_message)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, 0)"#,
        params![msg_id, session_id, turn.role, turn.content_json, now, model, turn_id],
    )?;
    Ok(())
}

fn finalize_session(
    conn: &rusqlite::Connection,
    session_id: &str,
    model_id: &str,
    provider: &str,
    status: &str,
    permission_mode: Option<&str>,
) -> Result<()> {
    let now = crate::models::db::current_timestamp()?;
    conn.execute(
        "UPDATE sessions SET status = ?2, model = ?3, agent_type = ?4, last_user_message_at = ?5, updated_at = ?5, permission_mode = COALESCE(?6, permission_mode) WHERE id = ?1",
        params![session_id, status, model_id, provider, now, permission_mode],
    )?;
    conn.execute(
        "UPDATE workspaces SET active_session_id = ?2 WHERE id = (SELECT workspace_id FROM sessions WHERE id = ?1)",
        params![session_id, session_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Pending CLI sends — CLI queues a prompt for the App to execute via its
// shared sidecar, so the frontend sees live streaming.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCliSend {
    pub id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub prompt: String,
    pub model_id: Option<String>,
    pub permission_mode: Option<String>,
    pub created_at: String,
}

/// Insert a pending send so the App's frontend can pick it up on focus.
pub fn insert_pending_cli_send(
    workspace_id: &str,
    session_id: &str,
    prompt: &str,
    model_id: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<String> {
    let conn = crate::models::db::open_connection(true)?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        r#"INSERT INTO pending_cli_sends (id, workspace_id, session_id, prompt, model_id, permission_mode)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
        params![id, workspace_id, session_id, prompt, model_id, permission_mode],
    )
    .context("Failed to insert pending CLI send")?;
    Ok(id)
}

/// Read and delete all pending sends in one atomic operation.
/// Returns them oldest-first so the App processes them in order.
pub fn drain_pending_cli_sends() -> Result<Vec<PendingCliSend>> {
    let conn = crate::models::db::open_connection(true)?;
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, session_id, prompt, model_id, permission_mode, created_at
         FROM pending_cli_sends ORDER BY datetime(created_at) ASC",
    )?;
    let rows: Vec<PendingCliSend> = stmt
        .query_map([], |row| {
            Ok(PendingCliSend {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                session_id: row.get(2)?,
                prompt: row.get(3)?,
                model_id: row.get(4)?,
                permission_mode: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("Failed to read pending CLI sends")?;

    if !rows.is_empty() {
        conn.execute("DELETE FROM pending_cli_sends", [])
            .context("Failed to delete pending CLI sends")?;
    }

    Ok(rows)
}

/// Check if the Helmor App is running by testing the MCP bridge port.
pub fn is_app_running() -> bool {
    is_port_listening(9223)
}

/// Return true iff a TCP listener is accepting connections on the given
/// loopback port right now. Factored out from `is_app_running` so tests can
/// exercise the probe against an ephemeral port instead of the hard-coded
/// MCP bridge port (which collides with a locally-running dev build).
fn is_port_listening(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(200),
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_dir::TEST_ENV_LOCK;
    use std::fs;
    use std::path::PathBuf;

    /// Helper: set HELMOR_DATA_DIR to a temp dir for tests that hit the DB.
    struct TestDataDir {
        root: PathBuf,
    }

    impl TestDataDir {
        fn new(name: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("helmor-test-{name}-{}", uuid::Uuid::new_v4()));
            std::env::set_var("HELMOR_DATA_DIR", root.display().to_string());
            crate::data_dir::ensure_directory_structure().unwrap();
            let db_path = crate::data_dir::db_path().unwrap();
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            crate::schema::ensure_schema(&conn).unwrap();
            Self { root }
        }
    }

    impl Drop for TestDataDir {
        fn drop(&mut self) {
            std::env::remove_var("HELMOR_DATA_DIR");
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn drain_returns_empty_when_no_pending_sends() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let _dir = TestDataDir::new("drain-empty");

        let sends = drain_pending_cli_sends().unwrap();
        assert!(sends.is_empty());
    }

    #[test]
    fn insert_and_drain_round_trip() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let _dir = TestDataDir::new("insert-drain");

        let id = insert_pending_cli_send(
            "ws-1",
            "sess-1",
            "fix the bug",
            Some("opus"),
            Some("default"),
        )
        .unwrap();
        assert!(!id.is_empty());

        let sends = drain_pending_cli_sends().unwrap();
        assert_eq!(sends.len(), 1);
        assert_eq!(sends[0].workspace_id, "ws-1");
        assert_eq!(sends[0].session_id, "sess-1");
        assert_eq!(sends[0].prompt, "fix the bug");
        assert_eq!(sends[0].model_id.as_deref(), Some("opus"));
        assert_eq!(sends[0].permission_mode.as_deref(), Some("default"));

        // Second drain should be empty — rows were deleted.
        let sends2 = drain_pending_cli_sends().unwrap();
        assert!(sends2.is_empty());
    }

    #[test]
    fn drain_returns_oldest_first() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let _dir = TestDataDir::new("drain-order");

        insert_pending_cli_send("ws-1", "sess-a", "first", None, None).unwrap();
        // Ensure different created_at by sleeping briefly
        std::thread::sleep(std::time::Duration::from_millis(50));
        insert_pending_cli_send("ws-1", "sess-b", "second", None, None).unwrap();

        let sends = drain_pending_cli_sends().unwrap();
        assert_eq!(sends.len(), 2);
        assert_eq!(sends[0].prompt, "first");
        assert_eq!(sends[1].prompt, "second");
    }

    #[test]
    fn insert_with_null_optional_fields() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let _dir = TestDataDir::new("null-fields");

        insert_pending_cli_send("ws-1", "sess-1", "hello", None, None).unwrap();

        let sends = drain_pending_cli_sends().unwrap();
        assert_eq!(sends.len(), 1);
        assert!(sends[0].model_id.is_none());
        assert!(sends[0].permission_mode.is_none());
    }

    #[test]
    fn create_session_persists_requested_plan_mode() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let _dir = TestDataDir::new("create-session-plan");

        let db_path = crate::data_dir::db_path().unwrap();
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO repos (id, name, root_path) VALUES ('r1', 'test-repo', '/tmp/test-repo')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status) VALUES ('w1', 'r1', 'test-dir', 'ready', 'in-progress')",
            [],
        )
        .unwrap();

        let response = create_session("w1", None, Some("plan")).unwrap();
        let permission_mode: String = conn
            .query_row(
                "SELECT permission_mode FROM sessions WHERE id = ?1",
                [response.session_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(permission_mode, "plan");
    }

    #[test]
    fn is_port_listening_returns_false_when_no_listener() {
        // Bind an ephemeral port, release it, then probe — nothing should
        // be listening on a port we just closed. This used to hard-code
        // 9223, which collides with any locally-running dev build.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!is_port_listening(port));
    }

    #[test]
    fn is_port_listening_returns_true_when_listener_exists() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_port_listening(port));
        drop(listener);
    }
}
