pub mod agents;
pub(crate) mod commands;
pub mod data_dir;
pub mod error;
pub mod git;
pub mod github;
mod import;
pub mod logging;
pub mod mcp;
pub mod models;
pub mod pipeline;
mod schema;
pub mod service;
mod shell_env;
pub mod sidecar;
pub mod updater;
pub mod workspace;

#[cfg(test)]
pub(crate) mod testkit;

pub use git::ops as git_ops;
pub use git::watcher as git_watcher;
pub use github::auth;
pub use github::cli as github_cli;
pub use github::graphql as github_graphql;
pub use models::db;
pub use models::repos;
pub use models::sessions;
pub use models::settings;
pub use workspace::derived_status as workspace_derived_status;
pub use workspace::files as editor_files;
pub use workspace::helpers;
pub use workspace::state as workspace_state;
pub use workspace::workspaces;

use tauri::Manager;

/// Initialise the database schema (call once at startup).
pub fn schema_init(conn: &rusqlite::Connection) {
    schema::ensure_schema(conn).expect("Failed to initialize database schema");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    let app = builder
        .manage(auth::GithubIdentityFlowRuntime::default())
        .manage(sidecar::ManagedSidecar::new())
        .manage(agents::ActiveStreams::new())
        .manage(agents::SlashCommandCache::new())
        .manage(workspace::archive::ArchiveJobManager::new())
        .manage(git_watcher::GitWatcherManager::new())
        .manage(workspace::scripts::ScriptProcessManager::new())
        .setup(|app| {
            // Ensure data directory structure exists
            data_dir::ensure_directory_structure()?;

            // Initialize structured logging (must come before any tracing macro call).
            // Logs live in `<data_dir>/logs/{rust,sidecar}.jsonl` with a `.1` backup;
            // the size-ring appender bounds disk use without a cleanup pass.
            let logs_dir = data_dir::logs_dir()?;
            logging::init(&logs_dir)?;

            // Initialize database schema
            let db_path = data_dir::db_path()?;
            let connection = rusqlite::Connection::open(&db_path)?;
            schema::ensure_schema(&connection)?;

            tracing::info!(
                mode = data_dir::data_mode_label(),
                data = %db_path.display(),
                "Helmor started"
            );

            // Purge workspaces whose directory was deleted outside the app.
            match workspace::workspaces::purge_orphaned_workspaces() {
                Ok(0) => {}
                Ok(n) => tracing::info!(count = n, "Purged orphaned workspaces"),
                Err(e) => tracing::warn!("Failed to purge orphaned workspaces: {e:#}"),
            }

            // Clear rows stuck in `initializing` state past the cutoff —
            // happens when the app is force-quit mid-create (Phase 2 never
            // gets to flip the state to ready/setup_pending). Five minutes
            // is well past the worst-case git worktree creation time.
            const INITIALIZING_ORPHAN_CUTOFF_SECONDS: i64 = 300;
            match workspace::workspaces::cleanup_orphaned_initializing_workspaces(
                INITIALIZING_ORPHAN_CUTOFF_SECONDS,
            ) {
                Ok(0) => {}
                Ok(n) => tracing::info!(count = n, "Cleaned up orphan initializing workspaces"),
                Err(e) => tracing::warn!("Failed to clean up initializing orphans: {e:#}"),
            }

            // On macOS, GUI-launched apps only see the minimal system PATH.
            // Capture the user's login-shell PATH (Homebrew, nvm, bun, cargo,
            // etc.) so every child process — sidecar, git, workspace scripts —
            // can find developer tools without manual PATH hacks.
            shell_env::inherit_login_shell_env();

            updater::configure()?;
            updater::spawn_startup_check(app.handle().clone());
            updater::spawn_interval_worker(app.handle().clone());

            agents::prewarm_slash_command_cache(app.handle());

            // Start git filesystem watchers for all ready workspaces.
            let watcher_handle = app.handle().clone();
            if let Err(error) = std::thread::Builder::new()
                .name("git-watcher-init".into())
                .spawn(move || {
                    let manager = watcher_handle.state::<git_watcher::GitWatcherManager>();
                    if let Err(e) = manager.sync_from_db(watcher_handle.clone()) {
                        tracing::error!("Failed to initialize git watchers: {e:#}");
                    }
                })
            {
                tracing::error!(error = %error, "Failed to spawn git watcher init thread");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agents::list_agent_model_sections,
            agents::send_agent_message_stream,
            agents::stop_agent_stream,
            agents::respond_to_permission_request,
            agents::respond_to_deferred_tool,
            agents::respond_to_elicitation_request,
            agents::generate_session_title,
            agents::list_slash_commands,
            agents::prewarm_slash_commands_for_workspace,
            commands::workspace_commands::prepare_archive_workspace,
            commands::workspace_commands::start_archive_workspace,
            commands::workspace_commands::validate_archive_workspace,
            commands::workspace_commands::validate_restore_workspace,
            commands::github_commands::cancel_github_identity_connect,
            commands::workspace_commands::complete_workspace_setup,
            commands::workspace_commands::create_workspace_from_repo,
            commands::workspace_commands::prepare_workspace_from_repo,
            commands::workspace_commands::finalize_workspace_from_repo,
            commands::github_commands::disconnect_github_identity,
            commands::repository_commands::get_add_repository_defaults,
            commands::settings_commands::get_app_settings,
            commands::system_commands::get_cli_status,
            commands::system_commands::get_data_info,
            commands::system_commands::install_cli,
            commands::github_commands::get_github_cli_status,
            commands::github_commands::get_github_cli_user,
            commands::github_commands::get_github_identity_session,
            commands::workspace_commands::get_workspace,
            commands::repository_commands::add_repository_from_local_path,
            commands::github_commands::list_github_accessible_repositories,
            commands::workspace_commands::list_archived_workspaces,
            commands::repository_commands::list_repositories,
            commands::repository_commands::update_repository_default_branch,
            commands::repository_commands::update_repository_remote,
            commands::repository_commands::list_repo_remotes,
            commands::repository_commands::load_repo_scripts,
            commands::repository_commands::update_repo_scripts,
            commands::repository_commands::delete_repository,
            commands::script_commands::execute_repo_script,
            commands::script_commands::stop_repo_script,
            commands::script_commands::write_repo_script_stdin,
            commands::script_commands::resize_repo_script,
            commands::session_commands::list_session_attachments,
            commands::session_commands::list_session_thread_messages,
            commands::workspace_commands::list_workspace_groups,
            commands::session_commands::list_workspace_sessions,
            commands::session_commands::create_session,
            commands::session_commands::rename_session,
            commands::session_commands::hide_session,
            commands::session_commands::unhide_session,
            commands::session_commands::delete_session,
            commands::session_commands::list_hidden_sessions,
            commands::session_commands::mark_session_read,
            commands::workspace_commands::list_remote_branches,
            commands::workspace_commands::rename_workspace_branch,
            commands::workspace_commands::update_intended_target_branch,
            commands::workspace_commands::prefetch_remote_refs,
            commands::workspace_commands::push_workspace_to_remote,
            commands::workspace_commands::sync_workspace_with_target_branch,
            commands::workspace_commands::mark_workspace_read,
            commands::workspace_commands::mark_workspace_unread,
            commands::workspace_commands::pin_workspace,
            commands::workspace_commands::unpin_workspace,
            commands::editor_commands::list_editor_files,
            commands::editor_commands::list_editor_files_with_content,
            commands::editor_commands::list_workspace_files,
            commands::editor_commands::list_workspace_changes,
            commands::editor_commands::list_workspace_changes_with_content,
            commands::editor_commands::discard_workspace_file,
            commands::editor_commands::stage_workspace_file,
            commands::editor_commands::unstage_workspace_file,
            commands::editor_commands::get_workspace_git_action_status,
            commands::github_commands::lookup_workspace_pr,
            commands::github_commands::get_workspace_pr_action_status,
            commands::github_commands::get_workspace_pr_check_insert_text,
            commands::github_commands::merge_workspace_pr,
            commands::github_commands::close_workspace_pr,
            commands::system_commands::drain_pending_cli_sends,
            commands::editor_commands::read_editor_file,
            commands::editor_commands::read_file_at_ref,
            commands::workspace_commands::set_workspace_manual_status,
            commands::workspace_commands::trigger_workspace_fetch,
            commands::editors::detect_installed_editors,
            commands::editors::open_workspace_in_editor,
            commands::workspace_commands::permanently_delete_workspace,
            commands::workspace_commands::restore_workspace,
            commands::editor_commands::stat_editor_file,
            commands::github_commands::start_github_identity_connect,
            commands::conductor_commands::conductor_source_available,
            commands::conductor_commands::list_conductor_repos,
            commands::conductor_commands::list_conductor_workspaces,
            commands::conductor_commands::import_conductor_workspaces,
            commands::system_commands::save_pasted_image,
            commands::system_commands::request_quit,
            commands::system_commands::dev_reset_all_data,
            commands::settings_commands::update_app_settings,
            commands::session_commands::update_session_settings,
            commands::settings_commands::load_auto_close_action_kinds,
            commands::settings_commands::save_auto_close_action_kinds,
            commands::settings_commands::load_auto_close_opt_in_asked,
            commands::settings_commands::save_auto_close_opt_in_asked,
            commands::updater_commands::get_app_update_status,
            commands::updater_commands::check_for_app_update,
            commands::updater_commands::install_downloaded_app_update,
            commands::editor_commands::write_editor_file,
            commands::claude_design_commands::open_claude_design_view,
            commands::claude_design_commands::set_claude_design_view_bounds,
            commands::claude_design_commands::hide_claude_design_view,
            commands::claude_design_commands::close_claude_design_view,
            commands::claude_design_commands::reload_claude_design_view,
            commands::claude_design_commands::import_claude_design_cookies
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // The frontend's onCloseRequested always calls preventDefault(), so
    // the JS layer never destroys the window on its own.  All quit logic
    // lives in the `request_quit` Tauri command (called from the frontend
    // quit-confirmation dialog).  Nothing to do here.
    app.run(|app_handle, event| match event {
        tauri::RunEvent::Resumed => {
            updater::maybe_trigger_on_resume(app_handle.clone());
        }
        tauri::RunEvent::WindowEvent { label, event, .. }
            if label == "main" && matches!(event, tauri::WindowEvent::Focused(true)) =>
        {
            updater::maybe_trigger_on_focus(app_handle.clone());
        }
        _ => {}
    });
}
