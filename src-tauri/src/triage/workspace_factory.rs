//! Atomic creation of an AI-triage workspace + priming message.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::models::db;
use crate::workspace::lifecycle as wlifecycle;
use crate::workspace_state::WorkspaceBranchIntent;
use crate::workspace_status::WorkspaceStatus;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiWorkspaceParams {
    pub source_type: String,
    pub source_ref: String,
    pub repo_id: String,
    pub plan_message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiWorkspaceResult {
    pub workspace_id: String,
    pub session_id: String,
}

pub fn create_ai_workspace(params: &CreateAiWorkspaceParams) -> Result<CreateAiWorkspaceResult> {
    if params.source_type.trim().is_empty() {
        bail!("source_type is empty");
    }
    if params.source_ref.trim().is_empty() {
        bail!("source_ref is empty");
    }
    if params.repo_id.trim().is_empty() {
        bail!("repo_id is empty");
    }

    let prepared = wlifecycle::prepare_workspace_from_repo_impl(
        &params.repo_id,
        None,
        WorkspaceBranchIntent::FromBranch,
        WorkspaceStatus::InProgress,
        None,
    )
    .context("prepare_workspace_from_repo")?;

    if let Err(error) = wlifecycle::finalize_workspace_from_repo_impl(&prepared.workspace_id) {
        let _ = cleanup_orphan_workspace(&prepared.workspace_id);
        return Err(error.context("finalize_workspace_from_repo"));
    }

    {
        let conn = db::write_conn()?;
        conn.execute(
            "UPDATE workspaces SET kind = 'ai_triage' WHERE id = ?1",
            rusqlite::params![prepared.workspace_id],
        )
        .context("update workspaces.kind")?;
    }

    let message_id = uuid::Uuid::new_v4().to_string();
    let content_json = json!({
        "type": "assistant",
        "message": {
            "content": [{ "type": "text", "text": params.plan_message }]
        }
    })
    .to_string();
    {
        let conn = db::write_conn()?;
        conn.execute(
            "INSERT INTO session_messages
                (id, session_id, role, content, sent_at, is_ai_priming)
             VALUES (?1, ?2, 'assistant', ?3, datetime('now'), 1)",
            rusqlite::params![message_id, prepared.initial_session_id, content_json],
        )
        .context("insert priming message")?;
    }

    Ok(CreateAiWorkspaceResult {
        workspace_id: prepared.workspace_id,
        session_id: prepared.initial_session_id,
    })
}

fn cleanup_orphan_workspace(workspace_id: &str) -> Result<()> {
    let conn = db::write_conn()?;
    conn.execute(
        "DELETE FROM session_messages
         WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
        rusqlite::params![workspace_id],
    )
    .ok();
    conn.execute(
        "DELETE FROM sessions WHERE workspace_id = ?1",
        rusqlite::params![workspace_id],
    )
    .ok();
    conn.execute(
        "DELETE FROM workspaces WHERE id = ?1",
        rusqlite::params![workspace_id],
    )
    .ok();
    Ok(())
}
