use crate::{db, repos, settings};

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
    repo_id: String,
    default_branch: String,
) -> CmdResult<()> {
    run_blocking(move || repos::update_repository_default_branch(&repo_id, &default_branch)).await
}

#[tauri::command]
pub async fn update_repository_remote(
    repo_id: String,
    remote: String,
) -> CmdResult<repos::UpdateRepositoryRemoteResponse> {
    run_blocking(move || repos::update_repository_remote(&repo_id, &remote)).await
}

#[tauri::command]
pub async fn list_repo_remotes(repo_id: String) -> CmdResult<Vec<String>> {
    run_blocking(move || repos::list_repo_remotes(&repo_id)).await
}
