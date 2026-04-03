mod agents;
mod conductor;
pub mod data_dir;
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
            conductor::archive_workspace,
            conductor::create_workspace_from_repo,
            conductor::get_add_repository_defaults,
            conductor::get_data_info,
            conductor::get_workspace,
            conductor::add_repository_from_local_path,
            conductor::list_archived_workspaces,
            conductor::list_repositories,
            conductor::list_session_attachments,
            conductor::list_session_messages,
            conductor::list_workspace_groups,
            conductor::list_workspace_sessions,
            conductor::mark_session_read,
            conductor::mark_workspace_read,
            conductor::mark_workspace_unread,
            conductor::restore_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
