//! Public service facade for non-Tauri consumers (e.g. `helmorctl`).
//!
//! Re-exports domain types and functions from the private `models` module
//! so that `[[bin]]` targets can use them without making `models` public.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

// ---- Types ----

pub use crate::models::repos::{AddRepositoryResponse, RepositoryCreateOption};
pub use crate::models::sessions::{CreateSessionResponse, WorkspaceSessionSummary};
pub use crate::models::workspaces::{
    CreateWorkspaceResponse, WorkspaceDetail, WorkspaceSidebarGroup, WorkspaceSidebarRow,
};
pub use crate::models::DataInfo;

// ---- Domain functions ----

pub use crate::models::repos::{add_repository_from_local_path, list_repositories};
pub use crate::models::sessions::{create_session, list_workspace_sessions};
pub use crate::models::workspaces::{
    create_workspace_from_repo_impl, get_workspace, list_workspace_groups, load_workspace_records,
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

/// Send a prompt to an AI agent via the sidecar, stream results, and persist
/// to the database. Each invocation owns its own sidecar process.
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
            None => create_session(&workspace_id, None)?.session_id,
        },
    };

    // 3. Resolve model
    let model_id = params.model.as_deref().unwrap_or("opus-1m");
    let model = crate::agents::find_model_definition(model_id)
        .with_context(|| format!("Unknown model: {model_id}"))?;

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
                    pipeline.accumulator.append_aborted_notice();
                }

                // Persist remaining turns
                let model_str = pipeline.accumulator.resolved_model().to_string();
                while persisted_turn_count < pipeline.accumulator.turns_len() {
                    let turn = pipeline.accumulator.turn_at(persisted_turn_count);
                    if let Err(e) = persist_turn(&conn, &session_id, turn, &model_str, &turn_id) {
                        eprintln!("[helmor] Failed to persist turn: {e}");
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

                let _ = finalize_session(&conn, &session_id, model.id, model.provider, "idle");

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
                let _ = finalize_session(&conn, &session_id, model.id, model.provider, "idle");
                on_event(&AgentStreamEvent::Error {
                    message: msg,
                    persisted: true,
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
                            eprintln!("[helmor] Failed to persist turn: {e}");
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
    let msg_id = Uuid::new_v4().to_string();
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
) -> Result<()> {
    let now = crate::models::db::current_timestamp()?;
    conn.execute(
        "UPDATE sessions SET status = ?2, model = ?3, agent_type = ?4, last_user_message_at = ?5, updated_at = ?5 WHERE id = ?1",
        params![session_id, status, model_id, provider, now],
    )?;
    conn.execute(
        "UPDATE workspaces SET active_session_id = ?2 WHERE id = (SELECT workspace_id FROM sessions WHERE id = ?1)",
        params![session_id, session_id],
    )?;
    Ok(())
}
