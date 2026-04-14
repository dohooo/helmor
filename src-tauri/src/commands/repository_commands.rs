use tauri::AppHandle;

use crate::{db, git_watcher, repos, settings};

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
    let _lock = db::WORKSPACE_MUTATION_LOCK.lock().await;
    run_blocking(move || repos::add_repository_from_local_path(&folder_path)).await
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
pub async fn delete_repository(repo_id: String) -> CmdResult<()> {
    let _lock = db::WORKSPACE_MUTATION_LOCK.lock().await;
    run_blocking(move || repos::delete_repository_cascade(&repo_id)).await
}
