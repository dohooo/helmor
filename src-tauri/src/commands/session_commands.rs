use anyhow::Context;

use crate::{db, pipeline, sessions};

use super::common::{run_blocking, CmdResult};

#[tauri::command]
pub async fn list_workspace_sessions(
    workspace_id: String,
) -> CmdResult<Vec<sessions::WorkspaceSessionSummary>> {
    run_blocking(move || sessions::list_workspace_sessions(&workspace_id)).await
}

#[tauri::command]
pub async fn list_session_thread_messages(
    session_id: String,
) -> CmdResult<Vec<pipeline::types::ThreadMessageLike>> {
    run_blocking(move || {
        let historical = sessions::list_session_historical_records(&session_id)?;
        Ok(pipeline::MessagePipeline::convert_historical(&historical))
    })
    .await
}

#[tauri::command]
pub async fn list_session_attachments(
    session_id: String,
) -> CmdResult<Vec<sessions::SessionAttachmentRecord>> {
    run_blocking(move || sessions::list_session_attachments(&session_id)).await
}

#[tauri::command]
pub async fn create_session(
    workspace_id: String,
    action_kind: Option<String>,
    permission_mode: Option<String>,
) -> CmdResult<sessions::CreateSessionResponse> {
    run_blocking(move || {
        sessions::create_session(
            &workspace_id,
            action_kind.as_deref(),
            permission_mode.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn rename_session(session_id: String, title: String) -> CmdResult<()> {
    run_blocking(move || sessions::rename_session(&session_id, &title)).await
}

#[tauri::command]
pub async fn hide_session(session_id: String) -> CmdResult<()> {
    run_blocking(move || sessions::hide_session(&session_id)).await
}

#[tauri::command]
pub async fn unhide_session(session_id: String) -> CmdResult<()> {
    run_blocking(move || sessions::unhide_session(&session_id)).await
}

#[tauri::command]
pub async fn delete_session(session_id: String) -> CmdResult<()> {
    run_blocking(move || sessions::delete_session(&session_id)).await
}

#[tauri::command]
pub async fn list_hidden_sessions(
    workspace_id: String,
) -> CmdResult<Vec<sessions::WorkspaceSessionSummary>> {
    run_blocking(move || sessions::list_hidden_sessions(&workspace_id)).await
}

#[tauri::command]
pub async fn mark_session_read(session_id: String) -> CmdResult<()> {
    let _lock = db::WORKSPACE_MUTATION_LOCK.lock().await;
    Ok(sessions::mark_session_read(&session_id)?)
}

#[tauri::command]
pub async fn update_session_settings(
    session_id: String,
    effort_level: Option<String>,
    permission_mode: Option<String>,
) -> CmdResult<()> {
    run_blocking(move || {
        let connection = db::open_connection(true)?;
        connection
            .execute(
                r#"
                UPDATE sessions SET
                  effort_level = COALESCE(?2, effort_level),
                  permission_mode = COALESCE(?3, permission_mode)
                WHERE id = ?1
                "#,
                rusqlite::params![session_id, effort_level, permission_mode],
            )
            .context("Failed to update session settings")?;
        Ok(())
    })
    .await
}
