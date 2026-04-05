mod agents;
pub mod data_dir;
pub mod error;
mod import;
mod models;
mod schema;
pub mod sidecar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(models::auth::GithubIdentityFlowRuntime::default())
        .manage(sidecar::ManagedSidecar::new())
        .setup(|_app| {
            // Ensure data directory structure exists
            data_dir::ensure_directory_structure().expect("Failed to create Helmor data directory");

            // Initialize database schema
            let db_path = data_dir::db_path().expect("Failed to resolve database path");
            let connection = rusqlite::Connection::open(&db_path).expect("Failed to open database");
            schema::ensure_schema(&connection).expect("Failed to initialize database schema");

            eprintln!(
                "Helmor {} — data: {}",
                data_dir::data_mode_label(),
                db_path.display()
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agents::list_agent_model_sections,
            agents::send_agent_message_stream,
            agents::stop_agent_stream,
            agents::generate_session_title,
            models::archive_workspace,
            models::cancel_github_identity_connect,
            models::create_workspace_from_repo,
            models::disconnect_github_identity,
            models::get_add_repository_defaults,
            models::get_app_settings,
            models::get_data_info,
            models::get_github_cli_status,
            models::get_github_cli_user,
            models::get_github_identity_session,
            models::get_workspace,
            models::add_repository_from_local_path,
            models::list_github_accessible_repositories,
            models::list_archived_workspaces,
            models::list_repositories,
            models::list_session_attachments,
            models::list_session_messages,
            models::list_workspace_groups,
            models::list_workspace_sessions,
            models::create_session,
            models::rename_session,
            models::hide_session,
            models::unhide_session,
            models::delete_session,
            models::list_hidden_sessions,
            models::mark_session_read,
            models::list_remote_branches,
            models::update_intended_target_branch,
            models::mark_workspace_read,
            models::mark_workspace_unread,
            models::detect_installed_editors,
            models::open_workspace_in_editor,
            models::permanently_delete_workspace,
            models::restore_workspace,
            models::start_github_identity_connect,
            models::conductor_source_available,
            models::list_conductor_repos,
            models::list_conductor_workspaces,
            models::import_conductor_workspaces,
            models::update_app_settings,
            models::update_session_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
