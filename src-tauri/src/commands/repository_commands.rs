use tauri::AppHandle;

use crate::{db, forge, git_watcher, repos, settings};

use super::common::{run_blocking, CmdResult};

#[tauri::command]
pub async fn list_repositories() -> CmdResult<Vec<repos::RepositoryCreateOption>> {
    run_blocking(repos::list_repositories).await
}

#[tauri::command]
pub async fn get_add_repository_defaults() -> CmdResult<repos::AddRepositoryDefaults> {
    run_blocking(|| {
        Ok(repos::AddRepositoryDefaults {
            last_clone_directory: settings::load_setting_value("last_clone_directory")?,
        })
    })
    .await
}

#[tauri::command]
pub async fn add_repository_from_local_path(
    folder_path: String,
) -> CmdResult<repos::AddRepositoryResponse> {
    let _lock = db::WORKSPACE_FS_MUTATION_LOCK.lock().await;
    run_blocking(move || repos::add_repository_from_local_path(&folder_path)).await
}

#[tauri::command]
pub async fn clone_repository_from_url(
    git_url: String,
    clone_directory: String,
) -> CmdResult<repos::AddRepositoryResponse> {
    let _lock = db::WORKSPACE_FS_MUTATION_LOCK.lock().await;
    run_blocking(move || repos::clone_repository_from_url(&git_url, &clone_directory)).await
}

#[tauri::command]
pub async fn update_repository_default_branch(
    app: AppHandle,
    repo_id: String,
    default_branch: String,
) -> CmdResult<()> {
    run_blocking(move || repos::update_repository_default_branch(&repo_id, &default_branch))
        .await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn update_repository_branch_prefix(
    repo_id: String,
    branch_prefix_type: Option<crate::settings::BranchPrefixType>,
    branch_prefix_custom: Option<String>,
) -> CmdResult<()> {
    run_blocking(move || {
        repos::update_repository_branch_prefix(
            &repo_id,
            branch_prefix_type,
            branch_prefix_custom.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn update_repository_remote(
    app: AppHandle,
    repo_id: String,
    remote: String,
) -> CmdResult<repos::UpdateRepositoryRemoteResponse> {
    let result = run_blocking(move || repos::update_repository_remote(&repo_id, &remote)).await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(result)
}

#[tauri::command]
pub async fn list_repo_remotes(repo_id: String) -> CmdResult<Vec<String>> {
    run_blocking(move || repos::list_repo_remotes(&repo_id)).await
}

#[tauri::command]
pub async fn load_repo_scripts(
    repo_id: String,
    workspace_id: Option<String>,
) -> CmdResult<repos::RepoScripts> {
    run_blocking(move || repos::load_repo_scripts(&repo_id, workspace_id.as_deref())).await
}

#[tauri::command]
pub async fn load_repo_preferences(repo_id: String) -> CmdResult<repos::RepoPreferences> {
    run_blocking(move || repos::load_repo_preferences(&repo_id)).await
}

#[tauri::command]
pub async fn update_repo_scripts(
    repo_id: String,
    setup_script: Option<String>,
    run_script: Option<String>,
    archive_script: Option<String>,
) -> CmdResult<()> {
    run_blocking(move || {
        repos::update_repo_scripts(
            &repo_id,
            setup_script.as_deref(),
            run_script.as_deref(),
            archive_script.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn update_repo_auto_run_setup(repo_id: String, enabled: bool) -> CmdResult<()> {
    run_blocking(move || repos::update_repo_auto_run_setup(&repo_id, enabled)).await
}

#[tauri::command]
pub async fn update_repo_run_script_mode(repo_id: String, mode: String) -> CmdResult<()> {
    run_blocking(move || repos::update_repo_run_script_mode(&repo_id, &mode)).await
}

#[tauri::command]
pub async fn update_repo_preferences(
    repo_id: String,
    preferences: repos::RepoPreferences,
) -> CmdResult<()> {
    run_blocking(move || repos::update_repo_preferences(&repo_id, &preferences)).await
}

#[tauri::command]
pub async fn delete_repository(repo_id: String) -> CmdResult<()> {
    let _lock = db::WORKSPACE_FS_MUTATION_LOCK.lock().await;
    run_blocking(move || repos::delete_repository_cascade(&repo_id)).await
}

/// Re-run forge auto-bind for a repo. Frontend calls this after the user
/// completes a `gh auth login` / `glab auth login` flow so the repo
/// picks up the freshly-added account without an app restart. Returns
/// the bound login (or `None` when no logged-in account had access).
#[tauri::command]
pub async fn retry_repo_forge_binding(
    app: AppHandle,
    repo_id: String,
) -> CmdResult<Option<String>> {
    let bound = run_blocking(move || forge::accounts::auto_bind_repo_account(&repo_id)).await?;
    git_watcher::notify_workspace_changed(&app);
    Ok(bound)
}
