//! Turn dispatch for automation runs.
//!
//! Shared by the scheduler tick and the "Run now" command. A run is a
//! completely normal agent turn started through
//! `agents::start_background_turn` (no-op IPC channel): persistence,
//! watcher fan-out, busy-locking, and shutdown handling are all the regular
//! streaming machinery. This module only resolves *where* the turn goes.

use anyhow::anyhow;
use tauri::AppHandle;

use crate::agents::AgentSendRequest;
use crate::models::automations::{AutomationRecord, RUNS_IN_CHAT, RUNS_IN_WORKSPACE};
use crate::models::sessions;

pub struct StartedRun {
    pub session_id: String,
}

pub enum RunError {
    /// The bound session already has a turn in flight (claim/dispatch raced a
    /// user send). The scheduler rolls the claim back and retries next tick.
    SessionBusy,
    /// The bound session/workspace no longer exists (or never resolved). The
    /// scheduler pauses the automation instead of retrying forever.
    TargetMissing(String),
    /// Anything else. Deliberately not retried — the next scheduled slot is
    /// the recovery path.
    Other(anyhow::Error),
}

/// Resolve the automation's target session and start a background turn with
/// its prompt. Returns once the sidecar accepted the turn (streaming
/// continues on the event-loop thread).
pub fn run_automation_now(
    app: &AppHandle,
    automation: &AutomationRecord,
) -> Result<StartedRun, RunError> {
    let (session_id, workspace_id, permission_mode) = resolve_target(automation)?;

    let workspace = crate::workspaces::get_workspace(&workspace_id)
        .map_err(|error| RunError::TargetMissing(format!("workspace {workspace_id}: {error:#}")))?;
    let root_path = workspace.root_path.ok_or_else(|| {
        RunError::TargetMissing(format!("workspace {workspace_id} has no root_path"))
    })?;

    // Model: session row > "default", with the session's agent_type as the
    // provider hint — same resolution as `helmor send` (service.rs).
    let (session_model, session_provider) =
        sessions::get_session_model_and_provider(&session_id).unwrap_or((None, None));
    let model_id = session_model.unwrap_or_else(|| "default".to_string());
    let model = crate::agents::resolve_model(&model_id, session_provider.as_deref());

    let request = AgentSendRequest {
        provider: model.provider.to_string(),
        model_id: model.id.to_string(),
        prompt: automation.prompt.clone(),
        prompt_prefix: None,
        session_id: None,
        helmor_session_id: Some(session_id.clone()),
        working_directory: Some(root_path),
        effort_level: None,
        permission_mode,
        fast_mode: None,
        user_message_id: None,
        files: None,
        images: None,
        source: Some("automation".to_string()),
    };

    crate::agents::start_background_turn(app, request).map_err(|error| {
        // CommandError exposes the chain via Debug; the busy rejection is the
        // one failure we must distinguish (roll back + retry next tick).
        let message = format!("{error:?}");
        if message.contains("still running for this session") {
            RunError::SessionBusy
        } else {
            RunError::Other(anyhow!(message))
        }
    })?;

    Ok(StartedRun { session_id })
}

/// (session_id, workspace_id, permission_mode override) for this run.
/// `chat` mode targets the bound session; `workspace` mode creates a fresh
/// session named after the automation.
fn resolve_target(
    automation: &AutomationRecord,
) -> Result<(String, String, Option<String>), RunError> {
    match automation.runs_in.as_str() {
        RUNS_IN_CHAT => {
            let session_id = automation.session_id.clone().ok_or_else(|| {
                RunError::TargetMissing("chat automation has no bound session".to_string())
            })?;
            let row = sessions::get_session_workspace_and_permission(&session_id)
                .map_err(RunError::Other)?
                .ok_or_else(|| {
                    RunError::TargetMissing(format!("bound session {session_id} no longer exists"))
                })?;
            let workspace_id = row.0.ok_or_else(|| {
                RunError::TargetMissing(format!("session {session_id} has no workspace"))
            })?;
            Ok((session_id, workspace_id, Some(row.1)))
        }
        RUNS_IN_WORKSPACE => {
            let workspace_id = automation.workspace_id.clone().ok_or_else(|| {
                RunError::TargetMissing("workspace automation has no bound workspace".to_string())
            })?;
            let created = sessions::create_session(
                &workspace_id,
                None,
                None,
                sessions::CreateSessionOverrides::default(),
            )
            .map_err(RunError::Other)?;
            // Best-effort: name the fresh session after the automation so the
            // sidebar reads "Target order monitor", not "Untitled".
            if let Err(error) = sessions::rename_session(&created.session_id, &automation.title) {
                tracing::warn!(
                    session_id = %created.session_id,
                    error = %format!("{error:#}"),
                    "automations: failed to title run session"
                );
            }
            Ok((created.session_id, workspace_id, None))
        }
        other => Err(RunError::TargetMissing(format!(
            "unknown runs_in value {other:?}"
        ))),
    }
}
