mod agents;
mod conductor;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(agents::RunningAgentProcesses {
            map: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            agents::list_agent_model_sections,
            agents::send_agent_message,
            agents::send_agent_message_stream,
            conductor::archive_fixture_workspace,
            conductor::create_fixture_workspace_from_repo,
            conductor::get_fixture_add_repository_defaults,
            conductor::get_conductor_fixture_info,
            conductor::get_workspace,
            conductor::add_fixture_repository_from_local_path,
            conductor::list_archived_workspaces,
            conductor::list_fixture_repositories,
            conductor::list_session_attachments,
            conductor::list_session_messages,
            conductor::list_workspace_groups,
            conductor::list_workspace_sessions,
            conductor::mark_fixture_session_read,
            conductor::mark_fixture_workspace_read,
            conductor::mark_fixture_workspace_unread,
            conductor::restore_fixture_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
