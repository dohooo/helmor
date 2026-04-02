mod agents;
mod conductor;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            agents::list_agent_model_sections,
            agents::send_agent_message,
            conductor::get_conductor_fixture_info,
            conductor::get_workspace,
            conductor::list_archived_workspaces,
            conductor::list_session_attachments,
            conductor::list_session_messages,
            conductor::list_workspace_groups,
            conductor::list_workspace_sessions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
