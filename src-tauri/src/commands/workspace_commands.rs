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
/// `seed_session_id`: frontend-provided UUID for the initial session
/// row, so pre-submit paste-cache files (`cache/paste/<seed>/`) survive
/// submit. Backend mints one when absent.
#[tauri::command]
pub async fn prepare_workspace_from_repo(
    app: AppHandle,
    repo_id: String,
    source_branch: Option<String>,
    mode: Option<crate::workspace_state::WorkspaceMode>,
    branch_intent: Option<crate::workspace_state::WorkspaceBranchIntent>,
    initial_status: Option<WorkspaceStatus>,
    seed_session_id: Option<String>,
) -> CmdResult<workspaces::PrepareWorkspaceResponse> {
    let mode = mode.unwrap_or_default();
    let branch_intent = branch_intent.unwrap_or_default();
    let initial_status = initial_status.unwrap_or_default();
    let result = {
        let _lock = db::WORKSPACE_FS_MUTATION_LOCK.lock().await;
        run_blocking(move || match mode {
            crate::workspace_state::WorkspaceMode::Worktree => {
                workspaces::prepare_workspace_from_repo_impl(
                    &repo_id,
                    source_branch.as_deref(),
                    branch_intent,
                    initial_status,
                    seed_session_id.as_deref(),
                )
            }
            crate::workspace_state::WorkspaceMode::Local => {
                // Local mode ignores `branch_intent` (no separate worktree).
                workspaces::prepare_local_workspace_impl(
                    &repo_id,
                    source_branch.as_deref(),
                    initial_status,
                    seed_session_id.as_deref(),
                )
            }
            crate::workspace_state::WorkspaceMode::Chat => {
                // Chat workspaces don't bind to a repository; callers
                // should use `prepare_chat_workspace` directly.
                anyhow::bail!(
                    "Chat workspaces must be created via prepare_chat_workspace, not prepare_workspace_from_repo"
                )
            }
        })
        .await?
    };
    notify_workspace_changed_in_background(app);
    Ok(result)
}

/// One-shot creation of a Chat-mode workspace. Chat workspaces aren't
/// bound to any repository — they're a scratch directory under
/// `<data_dir>/chats/<YYYY-MM-DD>/new-chat[-N]` used as cwd for a plain
/// AI chat session. No git, no branch, no finalize phase.
/// `seed_session_id`: see `prepare_workspace_from_repo`.
#[tauri::command]
pub async fn prepare_chat_workspace(
    app: AppHandle,
    initial_status: Option<WorkspaceStatus>,
    seed_session_id: Option<String>,
) -> CmdResult<workspaces::PrepareWorkspaceResponse> {
    let initial_status = initial_status.unwrap_or_default();
    let result = {
        let _lock = db::WORKSPACE_FS_MUTATION_LOCK.lock().await;
        run_blocking(move || {
            workspaces::prepare_chat_workspace_impl(initial_status, seed_session_id.as_deref())
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

/// Move a local-mode workspace into a fresh worktree (relocation, not a
/// clone — the workspace's mode flips Local → Worktree). Snapshots the
/// local repo's current state (HEAD commit + tracked + untracked
/// changes) into the new worktree dir on a fresh auto-named branch.
/// The local repo itself is not modified.
#[tauri::command]
pub async fn move_local_workspace_to_worktree(
    app: AppHandle,
    workspace_id: String,
) -> CmdResult<workspaces::MoveLocalToWorktreeResponse> {
    let result = {
        let _lock = db::WORKSPACE_FS_MUTATION_LOCK.lock().await;
        run_blocking(move || workspaces::move_local_workspace_to_worktree_impl(&workspace_id))
            .await?
    };
    notify_workspace_changed_in_background(app);
    Ok(result)
}

/// Create a new local branch at the repo's current HEAD and switch to
/// it. Used by the start page's "Create and checkout new branch..."
/// picker action. `git checkout -b` doesn't require a clean working
/// tree — files carry over to the new branch unchanged.
#[tauri::command]
pub async fn create_and_checkout_branch(repo_id: String, branch: String) -> CmdResult<()> {
    run_blocking(move || -> anyhow::Result<()> {
        use anyhow::Context;
        let repo = crate::repos::load_repository_by_id(&repo_id)?
            .with_context(|| format!("Repository not found: {repo_id}"))?;
        let repo_root = std::path::PathBuf::from(repo.root_path.trim());
        crate::git_ops::ensure_git_repository(&repo_root)?;
        crate::git_ops::create_and_checkout_branch(&repo_root, &branch)
    })
    .await
}

/// Current local repo HEAD branch name. Used by the start page as
/// the local-mode picker's default selection (worktree mode uses the
/// repo's stored default branch instead). Returns `None` if the repo
/// is missing on disk or HEAD is detached — frontend then falls back
/// to the stored default.
#[tauri::command]
pub async fn get_repo_current_branch(repo_id: String) -> CmdResult<Option<String>> {
    run_blocking(move || -> anyhow::Result<Option<String>> {
        let Some(repo) = crate::repos::load_repository_by_id(&repo_id)? else {
            return Ok(None);
        };
        let repo_root = std::path::PathBuf::from(repo.root_path.trim());
        if !repo_root.is_dir() {
            return Ok(None);
        }
        Ok(crate::git_ops::current_branch_name(&repo_root).ok())
    })
    .await
}

/// Merged local + remote branches, deduped (by name), sorted. Used by
/// the local-mode start picker so users can pick from anything they
/// already have on disk OR any branch published on `origin`. Returns
/// an empty list if the repo path is missing — keeps the picker usable
/// even after the repo was moved.
#[tauri::command]
pub async fn list_branches_for_local_picker(repo_id: String) -> CmdResult<Vec<String>> {
    run_blocking(move || -> anyhow::Result<Vec<String>> {
        let Some(repo) = crate::repos::load_repository_by_id(&repo_id)? else {
            return Ok(Vec::new());
        };
        let repo_root = std::path::PathBuf::from(repo.root_path.trim());
        if !repo_root.is_dir() {
            return Ok(Vec::new());
        }
        let remote = repo.remote.unwrap_or_else(|| "origin".to_string());

        let mut seen = std::collections::BTreeSet::new();
        seen.extend(crate::git_ops::list_local_branches(&repo_root).unwrap_or_default());
        seen.extend(crate::git_ops::list_remote_branches(&repo_root, &remote).unwrap_or_default());
        Ok(seen.into_iter().collect())
    })
    .await
}

/// Same source as `list_branches_for_local_picker` (local + remote refs,
/// purely local fs reads) but returns where each branch lives so the
/// picker can show a source icon and the pill can decide whether to
/// prefix with `origin/`. Sorted by name.
#[tauri::command]
pub async fn list_branches_for_workspace_picker(
    repo_id: String,
) -> CmdResult<Vec<workspaces::BranchPickerEntry>> {
    run_blocking(
        move || -> anyhow::Result<Vec<workspaces::BranchPickerEntry>> {
            let Some(repo) = crate::repos::load_repository_by_id(&repo_id)? else {
                return Ok(Vec::new());
            };
            let repo_root = std::path::PathBuf::from(repo.root_path.trim());
            if !repo_root.is_dir() {
                return Ok(Vec::new());
            }
            let remote = repo.remote.unwrap_or_else(|| "origin".to_string());
            Ok(workspaces::list_branch_picker_entries(&repo_root, &remote))
        },
    )
    .await
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

/// Sidebar drag-and-drop entry point. `target_group_id` is a sidebar group
/// id from the frontend — `"pinned"`, a status lane (`"done"` / `"review"`
/// / `"progress"` / `"backlog"` / `"canceled"`), or a repo bucket
/// (`"repo:<repo_id>"`). The backend writes the corresponding `pinned_at`
/// / `status` mutation plus a single `display_order` cell, only falling
/// back to a full-group rebalance when the sparse gap runs out.
#[tauri::command]
pub async fn move_workspace_in_sidebar(
    workspace_id: String,
    target_group_id: String,
    before_workspace_id: Option<String>,
) -> CmdResult<()> {
    run_blocking(move || {
        workspaces::move_workspace_in_sidebar(
            &workspace_id,
            &target_group_id,
            before_workspace_id.as_deref(),
        )
    })
    .await
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
    workspaces::start_archive_workspace(&app, &workspace_id, workspaces::ArchiveOrigin::Manual)?;
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

/// Guards against a second cleanup run starting while one is in flight —
/// the deletes are idempotent but a concurrent run would misreport every
/// already-deleted workspace as a failure.
static ARCHIVE_CLEANUP_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Bulk-delete every archived workspace through the same per-workspace
/// path as `permanently_delete_workspace` (FS mutation lock, git unwatch,
/// DB transaction, leftover-dir removal). Deletions run strictly one at a
/// time; the command resolves only after the whole run finishes, but the
/// run itself is backend-owned — it completes even if the frontend stops
/// listening.
#[tauri::command]
pub async fn cleanup_archived_workspaces(
    app: AppHandle,
) -> CmdResult<workspaces::CleanupArchivedWorkspacesResponse> {
    use std::sync::atomic::Ordering;

    if ARCHIVE_CLEANUP_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(anyhow::anyhow!("Archive cleanup is already running").into());
    }
    let result = cleanup_archived_workspaces_inner(&app).await;
    ARCHIVE_CLEANUP_RUNNING.store(false, Ordering::SeqCst);
    result
}

async fn cleanup_archived_workspaces_inner(
    app: &AppHandle,
) -> CmdResult<workspaces::CleanupArchivedWorkspacesResponse> {
    let archived = run_blocking(workspaces::list_archived_workspaces).await?;
    let titles: std::collections::HashMap<String, String> = archived
        .iter()
        .map(|workspace| (workspace.id.clone(), workspace.title.clone()))
        .collect();
    let mut remaining: Vec<String> = archived.into_iter().map(|workspace| workspace.id).collect();
    let total = remaining.len();

    let mut deleted_count = 0usize;
    let failures: Vec<workspaces::CleanupArchivedFailure>;

    // Multi-pass: deleting a middle layer of a PR stack is blocked while
    // other workspaces are stacked on it, so a pass that made progress
    // earns the leftovers a retry (children get deleted first, then their
    // parents become deletable). Stops as soon as a full pass deletes
    // nothing — whatever is left is a genuine failure.
    loop {
        let mut failed_this_pass: Vec<(String, String)> = Vec::new();
        let mut progressed = false;

        for workspace_id in remaining.drain(..) {
            // Same per-workspace serialization as the single-delete
            // command: a concurrent restore of this workspace either
            // finishes first (then the still-archived re-check skips it)
            // or waits until the row is gone.
            let ws_lock = db::workspace_fs_mutation_lock(&workspace_id);
            let _lock = ws_lock.lock().await;
            app.state::<git_watcher::GitWatcherManager>()
                .unwatch(&workspace_id);

            let id_for_task = workspace_id.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                workspaces::delete_workspace_if_archived(&id_for_task)
            })
            .await;

            match result {
                Ok(Ok(true)) => {
                    deleted_count += 1;
                    progressed = true;
                    tracing::info!(
                        workspace_id,
                        deleted_count,
                        total,
                        "Archive cleanup: workspace deleted"
                    );
                    crate::ui_sync::publish(
                        app,
                        crate::ui_sync::UiMutationEvent::WorkspaceListChanged,
                    );
                }
                Ok(Ok(false)) => {
                    tracing::info!(
                        workspace_id,
                        "Archive cleanup: workspace no longer archived, skipping"
                    );
                }
                Ok(Err(error)) => {
                    tracing::warn!(
                        workspace_id,
                        error = %format!("{error:#}"),
                        "Archive cleanup: delete failed"
                    );
                    failed_this_pass.push((workspace_id, crate::error::outermost_message(&error)));
                }
                Err(error) => {
                    tracing::error!(workspace_id, %error, "Archive cleanup: delete task crashed");
                    failed_this_pass.push((workspace_id, error.to_string()));
                }
            }
        }

        if failed_this_pass.is_empty() || !progressed {
            failures = failed_this_pass
                .into_iter()
                .map(
                    |(workspace_id, message)| workspaces::CleanupArchivedFailure {
                        title: titles.get(&workspace_id).cloned().unwrap_or_default(),
                        workspace_id,
                        message,
                    },
                )
                .collect();
            break;
        }
        remaining = failed_this_pass.into_iter().map(|(id, _)| id).collect();
    }

    // Deleting rows only frees pages for reuse inside the SQLite file;
    // compact once at the end so the space actually goes back to the OS.
    // Best-effort — a busy vacuum must not turn a successful cleanup into
    // a failure.
    if deleted_count > 0 {
        let vacuum_started = std::time::Instant::now();
        match run_blocking(workspaces::vacuum_database).await {
            Ok(()) => tracing::info!(
                elapsed_ms = vacuum_started.elapsed().as_millis(),
                "Archive cleanup: database vacuum finished"
            ),
            Err(error) => tracing::warn!(?error, "Archive cleanup: database vacuum failed"),
        }
    }

    git_watcher::notify_workspace_changed(app);
    tracing::info!(
        deleted_count,
        failed = failures.len(),
        total,
        "Archive cleanup finished"
    );

    Ok(workspaces::CleanupArchivedWorkspacesResponse {
        deleted_count,
        failures,
    })
}
