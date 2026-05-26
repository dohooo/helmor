//! Atomic creation of an AI-triage workspace + priming message.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::models::db;
use crate::workspace::branching as workspace_branching;
use crate::workspace::helpers as workspace_helpers;
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
    /// Short, human-readable label the agent generated for the workspace.
    /// Becomes the session title — what the user sees in the sidebar /
    /// thread header instead of "Untitled".
    pub title: String,
    /// Lowercase-hyphen slug for the git branch. Composed with the
    /// user's branch prefix at create time. Best-effort: if the slug
    /// collides with an existing branch we keep the auto-generated
    /// celestial-body name.
    pub branch_name: String,
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

    // Cross-tick dedup: if the same upstream source already maps to a
    // non-archived workspace, don't create a second one.
    if let Some(existing_id) =
        find_existing_triage_workspace(&params.source_type, &params.source_ref)?
    {
        bail!(
            "triage source already mapped to workspace {existing_id} ({}/{})",
            params.source_type,
            params.source_ref
        );
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
            "UPDATE workspaces
             SET kind = 'ai_triage',
                 triage_source_type = ?2,
                 triage_source_ref = ?3
             WHERE id = ?1",
            rusqlite::params![prepared.workspace_id, params.source_type, params.source_ref,],
        )
        .context("update workspaces.kind + triage source")?;
    }

    let title = params.title.trim();
    if !title.is_empty() {
        if let Err(error) =
            crate::models::sessions::rename_session(&prepared.initial_session_id, title)
        {
            tracing::warn!(
                error = %format!("{error:#}"),
                session_id = %prepared.initial_session_id,
                "triage: session rename failed; keeping default title"
            );
        }
    }

    let branch_slug = params.branch_name.trim();
    if !branch_slug.is_empty() {
        match crate::repos::load_repo_branch_prefix_settings(&params.repo_id) {
            Ok(branch_settings) => {
                let full_branch =
                    workspace_helpers::branch_name_for_directory(branch_slug, &branch_settings);
                if let Err(error) = workspace_branching::rename_workspace_branch(
                    &prepared.workspace_id,
                    &full_branch,
                ) {
                    tracing::warn!(
                        error = %format!("{error:#}"),
                        workspace_id = %prepared.workspace_id,
                        slug = branch_slug,
                        "triage: branch rename failed; keeping auto-generated name"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(
                    error = %format!("{error:#}"),
                    repo_id = %params.repo_id,
                    "triage: load branch settings failed; keeping auto-generated branch"
                );
            }
        }
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

/// Return the id of a non-archived triage workspace that already maps
/// to `(source_type, source_ref)`, or `None`.
fn find_existing_triage_workspace(source_type: &str, source_ref: &str) -> Result<Option<String>> {
    let conn = db::read_conn()?;
    let result = conn
        .query_row(
            "SELECT id FROM workspaces
             WHERE triage_source_type = ?1
               AND triage_source_ref = ?2
               AND state != 'archived'
             LIMIT 1",
            rusqlite::params![source_type, source_ref],
            |row| row.get::<_, String>(0),
        )
        .ok();
    Ok(result)
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
