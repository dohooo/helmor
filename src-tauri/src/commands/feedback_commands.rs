use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle};

use crate::{
    agents::{AgentSendRequest, AgentStreamEvent},
    db,
    feedback::{self, github_rest},
    git_watcher,
    workspace_state::WorkspaceBranchIntent,
    workspace_status::WorkspaceStatus,
    workspaces,
};

use super::common::{run_blocking, CmdResult};

#[tauri::command]
pub async fn fork_helmor_upstream() -> CmdResult<github_rest::ForkResult> {
    run_blocking(github_rest::fork_helmor_upstream).await
}

#[tauri::command]
pub async fn create_helmor_issue(
    title: String,
    body: String,
) -> CmdResult<github_rest::IssueResult> {
    run_blocking(move || github_rest::create_helmor_issue(&title, &body)).await
}

#[tauri::command]
pub async fn find_existing_helmor_repo() -> CmdResult<Option<feedback::ExistingHelmorRepo>> {
    run_blocking(feedback::find_existing_helmor_repo).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmitRequest {
    pub repo_id: String,
    pub prompt: String,
    pub provider: String,
    pub model_id: String,
    pub effort_level: Option<String>,
    pub fast_mode: Option<bool>,
    pub permission_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmitResult {
    pub workspace_id: String,
    pub session_id: String,
}

/// Atomic "create workspace + send first prompt" for the feedback flow.
/// Collapses what would otherwise be three frontend-orchestrated IPCs
/// (`prepare_workspace_from_repo` → `finalize_workspace_from_repo` →
/// `send_agent_message_stream`) into one awaited call so the dialog can
/// hand off in a single transaction: workspace row + session created,
/// worktree on disk, sidecar already streaming. The frontend selects the
/// returned IDs and switches view — no `pendingCreatedWorkspaceSubmit`
/// queue, no race between selection and finalize completion.
///
/// Streaming events go to an internal sink because there is no frontend
/// `Channel` to deliver them to: the conversation surface for this brand-
/// new workspace hasn't mounted yet. The first turn re-renders from DB
/// rows + `ActiveStreamsChanged` invalidations once the surface mounts.
/// Subsequent turns use the normal composer flow with a frontend-owned
/// channel for live token streaming.
#[tauri::command]
pub async fn submit_feedback_workspace_and_prompt(
    app: AppHandle,
    sidecar: tauri::State<'_, crate::sidecar::ManagedSidecar>,
    request: FeedbackSubmitRequest,
) -> CmdResult<FeedbackSubmitResult> {
    // Phase 1: prepare DB row + initial session (fast, <20ms).
    let prepared = {
        let _lock = db::WORKSPACE_FS_MUTATION_LOCK.lock().await;
        let repo_id = request.repo_id.clone();
        run_blocking(move || {
            workspaces::prepare_workspace_from_repo_impl(
                &repo_id,
                None,
                WorkspaceBranchIntent::default(),
                WorkspaceStatus::default(),
            )
        })
        .await?
    };

    // Phase 2: materialise the worktree on disk (slow, ~200ms-2s).
    let finalized = {
        let ws_lock = db::workspace_fs_mutation_lock(&prepared.workspace_id);
        let _lock = ws_lock.lock().await;
        let ws_id = prepared.workspace_id.clone();
        run_blocking(move || workspaces::finalize_workspace_from_repo_impl(&ws_id)).await?
    };

    // Phase 3: spawn the agent stream. `start_agent_stream` validates the
    // request, kicks off `stream_via_sidecar`, and returns once the
    // sidecar request is dispatched — the event loop runs in a detached
    // background thread.
    let send_request = AgentSendRequest {
        provider: request.provider,
        model_id: request.model_id,
        prompt: request.prompt,
        prompt_prefix: None,
        session_id: None,
        helmor_session_id: Some(prepared.initial_session_id.clone()),
        working_directory: Some(finalized.working_directory),
        effort_level: request.effort_level,
        permission_mode: request.permission_mode,
        fast_mode: request.fast_mode,
        user_message_id: None,
        files: None,
        images: None,
    };
    let sink: Channel<AgentStreamEvent> = Channel::new(|_| Ok(()));
    crate::agents::start_agent_stream(&app, &sidecar, send_request, sink)?;

    // Same workspace-changed broadcast the prepare/finalize commands do —
    // keeps the sidebar, file watcher, and git widgets in sync.
    let app_for_notify = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            git_watcher::notify_workspace_changed(&app_for_notify);
        })
        .await;
    });

    Ok(FeedbackSubmitResult {
        workspace_id: prepared.workspace_id,
        session_id: prepared.initial_session_id,
    })
}
