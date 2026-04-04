mod agents;
mod models;
pub mod data_dir;
mod import;
mod schema;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(agents::RunningAgentProcesses {
            map: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
        .setup(|_app| {
            // Ensure data directory structure exists
            data_dir::ensure_directory_structure()
                .expect("Failed to create Helmor data directory");

            // Initialize database schema
            let db_path = data_dir::db_path()
                .expect("Failed to resolve database path");
            let connection = rusqlite::Connection::open(&db_path)
                .expect("Failed to open database");
            schema::ensure_schema(&connection)
                .expect("Failed to initialize database schema");

            eprintln!(
                "Helmor {} — data: {}",
                data_dir::data_mode_label(),
                db_path.display()
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agents::list_agent_model_sections,
            agents::send_agent_message,
            agents::send_agent_message_stream,
            models::archive_workspace,
            models::create_workspace_from_repo,
            models::get_add_repository_defaults,
            models::get_data_info,
            models::get_workspace,
            models::add_repository_from_local_path,
            models::list_archived_workspaces,
            models::list_repositories,
            models::list_session_attachments,
            models::list_session_messages,
            models::list_workspace_groups,
            models::list_workspace_sessions,
            models::mark_session_read,
            models::mark_workspace_read,
            models::mark_workspace_unread,
            models::restore_workspace,
            models::import_from_conductor,
            models::conductor_source_available
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
