pub mod agents;
pub mod data_dir;
#[cfg(feature = "dev-server")]
pub mod dev_api;
pub mod error;
mod import;
mod models;
pub mod pipeline;
mod schema;
pub mod sidecar;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

/// Set once the user has confirmed quitting. Short-circuits the
/// `CloseRequested` handler on the second pass so it skips the dialog.
static SHUTDOWN_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// Set while the shutdown confirmation dialog is on screen. Prevents
/// stacking duplicates from rapid-fire `CloseRequested` events.
static SHUTDOWN_DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

/// Initialise the database schema (call once at startup).
pub fn schema_init(conn: &rusqlite::Connection) {
    schema::ensure_schema(conn).expect("Failed to initialize database schema");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(models::auth::GithubIdentityFlowRuntime::default())
        .manage(sidecar::ManagedSidecar::new())
        .manage(agents::ActiveStreams::new())
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
            models::list_session_thread_messages,
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
            models::pin_workspace,
            models::unpin_workspace,
            models::list_editor_files,
            models::list_editor_files_with_content,
            models::list_workspace_changes,
            models::list_workspace_changes_with_content,
            models::read_editor_file,
            models::set_workspace_manual_status,
            models::detect_installed_editors,
            models::open_workspace_in_editor,
            models::permanently_delete_workspace,
            models::restore_workspace,
            models::stat_editor_file,
            models::start_github_identity_connect,
            models::conductor_source_available,
            models::list_conductor_repos,
            models::list_conductor_workspaces,
            models::import_conductor_workspaces,
            models::save_pasted_image,
            models::update_app_settings,
            models::update_session_settings,
            models::write_editor_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Hook `WindowEvent::CloseRequested` — not `ExitRequested`, which only
    // fires after all windows are destroyed. The dialog is dispatched via
    // the async `show(callback)` form; `blocking_show()` would freeze the
    // app when called from the main thread.
    app.run(|app_handle, event| {
        let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } = &event
        else {
            return;
        };

        // Second pass after the user confirmed — don't re-prompt.
        if SHUTDOWN_CONFIRMED.load(Ordering::Acquire) {
            eprintln!("[shutdown] CloseRequested[{label}] — confirmed, letting through");
            return;
        }

        let active = app_handle.state::<agents::ActiveStreams>();
        let count = active.len();
        eprintln!("[shutdown] CloseRequested[{label}] — {count} active stream(s)");

        if count == 0 {
            // Fast path: nothing in flight, let the close proceed normally.
            return;
        }

        // Streams in flight — keep the window open and ask the user.
        api.prevent_close();

        // Guard against duplicate dialogs from rapid-fire CloseRequested
        // events (multiple windows, double Cmd+Q, etc.).
        if SHUTDOWN_DIALOG_OPEN.swap(true, Ordering::AcqRel) {
            eprintln!("[shutdown] Dialog already on screen, swallowing duplicate");
            return;
        }

        let app_handle_clone = app_handle.clone();
        let message = if count == 1 {
            "There is 1 task in progress. Quitting now will cancel it.".to_string()
        } else {
            format!("There are {count} tasks in progress. Quitting now will cancel them.")
        };

        eprintln!("[shutdown] Showing confirmation dialog");
        app_handle
            .dialog()
            .message(message)
            .title("Quit Helmor?")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Quit anyway".to_string(),
                "Cancel".to_string(),
            ))
            .show(move |confirmed| {
                SHUTDOWN_DIALOG_OPEN.store(false, Ordering::Release);

                if !confirmed {
                    eprintln!("[shutdown] User cancelled — staying running");
                    return;
                }

                eprintln!("[shutdown] User confirmed — aborting active streams");
                // We're on a worker thread now, so the blocking helper is
                // safe to call.
                let sidecar = app_handle_clone.state::<sidecar::ManagedSidecar>();
                let active = app_handle_clone.state::<agents::ActiveStreams>();
                agents::abort_all_active_streams_blocking(
                    &sidecar,
                    &active,
                    std::time::Duration::from_millis(1500),
                );
                SHUTDOWN_CONFIRMED.store(true, Ordering::Release);
                eprintln!("[shutdown] Cleanup done, calling exit(0)");
                app_handle_clone.exit(0);
            });
    });
}
