use crate::feedback::{self, github_rest};

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
