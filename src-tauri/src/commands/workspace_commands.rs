use tauri::{AppHandle, Manager};

use crate::{
    db, git_watcher, workspace_state::WorkspaceState, workspace_status::WorkspaceStatus, workspaces,
};

use super::common::{run_blocking, CmdResult};

fn notify_workspace_changed_in_background(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            git_watcher::notify_workspace_changed(&app);
        })
        .await;
    });
}

/// Phase 1: fast (<20ms) preparation. Inserts the DB row in `initializing`
/// state and returns the full metadata (directory name, branch, scripts,
/// generated workspace/session IDs) needed to paint the final UI. The
/// frontend should follow up with `finalize_workspace_from_repo` to kick
/// off the slow git worktree creation; UI remains visible during that
/// phase with state=initializing.
#[tauri::command]
pub async fn prepare_workspace_from_repo(
    app: AppHandle,
    repo_id: String,
    source_branch: Option<String>,
) -> CmdResult<workspaces::PrepareWorkspaceResponse> {
    let result = {
        let _lock = db::WORKSPACE_FS_MUTATION_LOCK.lock().await;
        run_blocking(move || {
            workspaces::prepare_workspace_from_repo_impl(&repo_id, source_branch.as_deref())
        })
        .await?
    };
    notify_workspace_changed_in_background(app);
    Ok(result)
}

/// Phase 2: slow (~200ms-2s) materialization. Creates the git worktree,
/// probes `helmor.json` for a setup script, and flips
/// the workspace row from `initializing` to `ready` / `setup_pending`. On
/// failure, the workspace + session rows are deleted and the worktree is
/// cleaned up so the user can retry.
#[tauri::command]
pub async fn finalize_workspace_from_repo(
    app: AppHandle,
    workspace_id: String,
) -> CmdResult<workspaces::FinalizeWorkspaceResponse> {
    let ws_lock = db::workspace_fs_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    let result = {
        let workspace_id = workspace_id.clone();
        run_blocking(move || workspaces::finalize_workspace_from_repo_impl(&workspace_id)).await?
    };
    notify_workspace_changed_in_background(app);
    Ok(result)
}

/// Legacy combined flow (prepare + finalize in a single call). Retained
/// for CLI / MCP / add-repository callers that don't benefit from the
/// two-phase UI split.
#[tauri::command]
pub async fn create_workspace_from_repo(
    app: AppHandle,
    repo_id: String,
) -> CmdResult<workspaces::CreateWorkspaceResponse> {
    let result = {
        let _lock = db::WORKSPACE_FS_MUTATION_LOCK.lock().await;
        run_blocking(move || workspaces::create_workspace_from_repo_impl(&repo_id)).await?
    };
    notify_workspace_changed_in_background(app);
    Ok(result)
}

/// Transition a workspace from "setup_pending" to "ready" (e.g. when no
/// setup script is configured but the workspace was created with that state).
#[tauri::command]
pub async fn complete_workspace_setup(app: AppHandle, workspace_id: String) -> CmdResult<()> {
    run_blocking(move || {
        let ts = crate::models::db::current_timestamp()?;
        crate::models::workspaces::update_workspace_state(&workspace_id, WorkspaceState::Ready, &ts)
    })
    .await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn list_workspace_groups() -> CmdResult<Vec<workspaces::WorkspaceSidebarGroup>> {
    run_blocking(workspaces::list_workspace_groups).await
}

#[tauri::command]
pub async fn list_archived_workspaces() -> CmdResult<Vec<workspaces::WorkspaceSummary>> {
    run_blocking(workspaces::list_archived_workspaces).await
}

#[tauri::command]
pub async fn get_workspace(workspace_id: String) -> CmdResult<workspaces::WorkspaceDetail> {
    run_blocking(move || workspaces::get_workspace(&workspace_id)).await
}

#[tauri::command]
pub async fn mark_workspace_unread(workspace_id: String) -> CmdResult<()> {
    run_blocking(move || workspaces::mark_workspace_unread(&workspace_id)).await
}

#[tauri::command]
pub async fn pin_workspace(workspace_id: String) -> CmdResult<()> {
    run_blocking(move || workspaces::pin_workspace(&workspace_id)).await
}

#[tauri::command]
pub async fn unpin_workspace(workspace_id: String) -> CmdResult<()> {
    run_blocking(move || workspaces::unpin_workspace(&workspace_id)).await
}

#[tauri::command]
pub async fn set_workspace_status(workspace_id: String, status: WorkspaceStatus) -> CmdResult<()> {
    run_blocking(move || workspaces::set_workspace_status(&workspace_id, status)).await
}

/// `/add-dir` feature: list the extra directories the user has linked to
/// this workspace. These are sent as `additionalDirectories` to the agent
/// SDKs on every turn.
#[tauri::command]
pub async fn list_workspace_linked_directories(workspace_id: String) -> CmdResult<Vec<String>> {
    run_blocking(move || workspaces::get_workspace_linked_directories(&workspace_id)).await
}

/// Replace the workspace's linked-directory list. Returns the normalized
/// list (trimmed + deduped) that was actually persisted.
#[tauri::command]
pub async fn set_workspace_linked_directories(
    app: AppHandle,
    workspace_id: String,
    directories: Vec<String>,
) -> CmdResult<Vec<String>> {
    let workspace_id_clone = workspace_id.clone();
    let result = run_blocking(move || {
        workspaces::set_workspace_linked_directories(&workspace_id_clone, directories)
    })
    .await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(result)
}

/// Candidate directories the `/add-dir` picker offers as quick-pick
/// suggestions: every ready workspace across every repo, minus the
/// currently-active one.
#[tauri::command]
pub async fn list_workspace_candidate_directories(
    exclude_workspace_id: Option<String>,
) -> CmdResult<Vec<workspaces::CandidateDirectory>> {
    run_blocking(move || workspaces::list_candidate_directories(exclude_workspace_id.as_deref()))
        .await
}

#[tauri::command]
pub async fn list_remote_branches(
    workspace_id: Option<String>,
    repo_id: Option<String>,
) -> CmdResult<Vec<String>> {
    run_blocking(move || {
        workspaces::list_remote_branches(workspace_id.as_deref(), repo_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn rename_workspace_branch(
    app: AppHandle,
    workspace_id: String,
    new_branch: String,
) -> CmdResult<()> {
    let ws_lock = db::workspace_fs_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    run_blocking(move || workspaces::rename_workspace_branch(&workspace_id, &new_branch)).await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn update_intended_target_branch(
    app: AppHandle,
    workspace_id: String,
    target_branch: String,
) -> CmdResult<workspaces::UpdateIntendedTargetBranchResponse> {
    let ws_lock = db::workspace_fs_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    let result = run_blocking(move || {
        workspaces::update_intended_target_branch(&workspace_id, &target_branch)
    })
    .await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(result)
}

/// Trigger an async background fetch for a workspace's target branch.
/// Returns immediately — the fetch runs in a detached thread.
#[tauri::command]
pub async fn trigger_workspace_fetch(workspace_id: String) -> CmdResult<()> {
    git_watcher::trigger_fetch_for_workspace(&workspace_id);
    Ok(())
}

#[tauri::command]
pub async fn prefetch_remote_refs(
    workspace_id: Option<String>,
    repo_id: Option<String>,
) -> CmdResult<workspaces::PrefetchRemoteRefsResponse> {
    run_blocking(move || {
        workspaces::prefetch_remote_refs(workspace_id.as_deref(), repo_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn sync_workspace_with_target_branch(
    workspace_id: String,
) -> CmdResult<workspaces::SyncWorkspaceTargetResponse> {
    let ws_lock = db::workspace_fs_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    run_blocking(move || workspaces::sync_workspace_with_target_branch(&workspace_id)).await
}

#[tauri::command]
pub async fn push_workspace_to_remote(
    workspace_id: String,
) -> CmdResult<workspaces::PushWorkspaceToRemoteResponse> {
    let ws_lock = db::workspace_fs_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    run_blocking(move || workspaces::push_workspace_to_remote(&workspace_id)).await
}

#[tauri::command]
pub async fn continue_workspace_from_target_branch(
    app: AppHandle,
    workspace_id: String,
) -> CmdResult<workspaces::ContinueWorkspaceResponse> {
    let ws_lock = db::workspace_fs_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    let result =
        run_blocking(move || workspaces::continue_workspace_from_target_branch(&workspace_id))
            .await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(result)
}

#[tauri::command]
pub async fn restore_workspace(
    app: AppHandle,
    workspace_id: String,
    target_branch_override: Option<String>,
) -> CmdResult<workspaces::RestoreWorkspaceResponse> {
    let ws_lock = db::workspace_fs_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    let result = run_blocking(move || {
        workspaces::restore_workspace_impl(&workspace_id, target_branch_override.as_deref())
    })
    .await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(result)
}

#[tauri::command]
pub async fn validate_restore_workspace(
    workspace_id: String,
) -> CmdResult<workspaces::ValidateRestoreResponse> {
    run_blocking(move || workspaces::validate_restore_workspace(&workspace_id)).await
}

#[tauri::command]
pub async fn prepare_archive_workspace(
    app: AppHandle,
    workspace_id: String,
) -> CmdResult<workspaces::PrepareArchiveWorkspaceResponse> {
    let app_handle = app.clone();
    run_blocking(move || {
        let manager = app_handle.state::<workspaces::ArchiveJobManager>();
        manager.prepare(&workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn start_archive_workspace(app: AppHandle, workspace_id: String) -> CmdResult<()> {
    workspaces::start_archive_workspace(&app, &workspace_id)?;
    Ok(())
}

#[tauri::command]
pub async fn validate_archive_workspace(
    workspace_id: String,
) -> CmdResult<workspaces::PrepareArchiveWorkspaceResponse> {
    run_blocking(move || {
        workspaces::validate_archive_workspace(&workspace_id)?;
        Ok(workspaces::PrepareArchiveWorkspaceResponse {
            workspace_id: workspace_id.clone(),
        })
    })
    .await
}

#[tauri::command]
pub async fn permanently_delete_workspace(app: AppHandle, workspace_id: String) -> CmdResult<()> {
    let ws_lock = db::workspace_fs_mutation_lock(&workspace_id);
    let _lock = ws_lock.lock().await;
    let manager = app.state::<git_watcher::GitWatcherManager>();
    manager.unwatch(&workspace_id);
    run_blocking(move || workspaces::permanently_delete_workspace(&workspace_id)).await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(())
}
