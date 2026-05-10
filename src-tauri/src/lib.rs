pub mod agents;
pub mod cli;
pub(crate) mod commands;
pub mod data_dir;
pub mod error;
pub mod forge;
pub mod git;
pub mod global_hotkey;
pub mod image_store;
mod import;
pub mod logging;
pub mod mcp;
pub mod models;
pub mod pipeline;
pub mod rate_limits;
pub mod schema;
pub mod service;
mod shell_env;
pub mod sidecar;
mod system_limits;
pub mod ui_sync;
pub mod updater;
pub mod workspace;

#[cfg(test)]
pub(crate) mod testkit;

pub use forge as forge_ops;
pub use forge::github as github_pr;
pub use git::ops as git_ops;
pub use git::watcher as git_watcher;
pub use models::db;
pub use models::repos;
pub use models::sessions;
pub use models::settings;
pub use workspace::files as editor_files;
pub use workspace::helpers;
pub use workspace::pr_sync as workspace_pr_sync;
pub use workspace::state as workspace_state;
pub use workspace::status as workspace_status;
pub use workspace::workspaces;

use tauri::{Emitter, Manager};

/// Initialise the database schema (call once at startup).
pub fn schema_init(conn: &rusqlite::Connection) {
    db::init_connection(conn, true).expect("Failed to apply PRAGMA init");
    schema::ensure_schema(conn).expect("Failed to initialize database schema");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    system_limits::raise_nofile_soft_limit();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    let app = builder
        .manage(sidecar::ManagedSidecar::new())
        .manage(agents::ActiveStreams::new())
        .manage(agents::SlashCommandCache::new())
        .manage(workspace::archive::ArchiveJobManager::new())
        .manage(git_watcher::GitWatcherManager::new())
        .manage(workspace::scripts::ScriptProcessManager::new())
        .manage(ui_sync::UiSyncManager::new())
        .manage(global_hotkey::GlobalHotkeyState::default())
        .manage(commands::forge_commands::ForgeAuthEdgeStore::default())
        .setup(|app| {
            // Ensure data directory structure exists
            data_dir::ensure_directory_structure()?;

            // Initialize structured logging (must come before any tracing macro call).
            // Logs live in `<data_dir>/logs/{rust,sidecar}.jsonl` with a `.1` backup;
            // the size-ring appender bounds disk use without a cleanup pass.
            let logs_dir = data_dir::logs_dir()?;
            logging::init(&logs_dir)?;

            // Initialize database schema. We apply the same PRAGMA init as
            // the pools to get WAL mode persisted to the file before any
            // pool connection opens.
            let db_path = data_dir::db_path()?;
            let connection = rusqlite::Connection::open(&db_path)?;
            db::init_connection(&connection, true)?;
            schema::ensure_schema(&connection)?;
            drop(connection);

            // Build read/write connection pools (must happen after schema).
            db::init_pools()?;

            tracing::info!(
                mode = data_dir::data_mode_label(),
                data = %db_path.display(),
                "Helmor started"
            );

            // Sweep `.trash-*` dirs left over from a prior run (worker killed
            // mid-cleanup, OS crash). Hands them to the global serial queue so
            // the slow recursive deletes happen one at a time in the
            // background. Spawned so a slow `read_dir` can't stall startup.
            if let Ok(workspaces_root) = data_dir::workspaces_dir() {
                std::thread::Builder::new()
                    .name("helmor-trash-sweep".into())
                    .spawn(move || {
                        git::trash::sweep_workspaces_root(&workspaces_root);
                    })
                    .ok();
            }

            // Reconcile workspaces whose directory was deleted outside the
            // app: degrade them to `archived` so chat history is preserved
            // (users can find the messages in the archive list and choose
            // to Permanently Delete there). Never auto-destroys data.
            match workspace::workspaces::purge_orphaned_workspaces() {
                Ok(0) => {}
                Ok(n) => tracing::info!(
                    count = n,
                    "Degraded orphaned workspaces to archived (chat history preserved)"
                ),
                Err(e) => tracing::warn!("Failed to reconcile orphaned workspaces: {e:#}"),
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

            forge::init_bundled_cli_paths();

            // Background backfill: re-run auto-bind for repos whose
            // forge_login is still NULL. Covers (a) repos added before
            // the multi-account migration shipped, and (b) repos whose
            // initial bind found no candidate but the user has since
            // run `gh/glab auth login`. Spawned blocking so the CLI
            // probes don't stall the UI thread.
            let backfill_handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                match forge::accounts::backfill_unbound_repos() {
                    Ok(summary) if summary.bound > 0 => {
                        tracing::info!(
                            examined = summary.examined,
                            bound = summary.bound,
                            "Forge binding backfill bound new repos"
                        );
                        ui_sync::publish(
                            &backfill_handle,
                            ui_sync::UiMutationEvent::RepositoryListChanged,
                        );
                    }
                    Ok(summary) => {
                        tracing::debug!(
                            examined = summary.examined,
                            "Forge binding backfill found nothing to bind"
                        );
                    }
                    Err(error) => {
                        tracing::warn!(
                            error = %format!("{error:#}"),
                            "Forge binding backfill failed"
                        );
                    }
                }
            });

            updater::configure()?;
            updater::spawn_startup_check(app.handle().clone());
            updater::spawn_interval_worker(app.handle().clone());

            agents::prewarm_slash_command_cache(app.handle());
            if let Err(error) = global_hotkey::sync_from_settings(app.handle()) {
                tracing::warn!(
                    error = %format!("{error:#}"),
                    "Failed to register startup global hotkey",
                );
            }

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

            if let Err(error) = ui_sync::start_listener(app.handle().clone()) {
                tracing::error!(error = %error, "Failed to start UI sync listener");
            }

            // On macOS, the default app-menu Quit item goes straight to
            // NSApplication.terminate:, which bypasses our event loop.
            // Install a custom menu so Cmd+Q flows through the same
            // confirmation dialog as the close button.
            #[cfg(target_os = "macos")]
            install_macos_menu(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agents::list_agent_model_sections,
            agents::list_cursor_models,
            agents::send_agent_message_stream,
            agents::stop_agent_stream,
            agents::list_active_streams,
            agents::steer_agent_stream,
            agents::respond_to_permission_request,
            agents::respond_to_user_input,
            agents::generate_session_title,
            agents::list_slash_commands,
            agents::prewarm_slash_commands_for_workspace,
            agents::prewarm_slash_commands_for_repo,
            commands::workspace_commands::prepare_archive_workspace,
            commands::workspace_commands::start_archive_workspace,
            commands::workspace_commands::validate_archive_workspace,
            commands::workspace_commands::validate_restore_workspace,
            commands::workspace_commands::complete_workspace_setup,
            commands::workspace_commands::create_workspace_from_repo,
            commands::workspace_commands::prepare_workspace_from_repo,
            commands::workspace_commands::finalize_workspace_from_repo,
            commands::repository_commands::get_add_repository_defaults,
            commands::settings_commands::get_app_settings,
            commands::settings_commands::get_claude_rate_limits,
            commands::settings_commands::get_codex_rate_limits,
            commands::system_commands::get_cli_status,
            commands::system_commands::get_data_info,
            commands::system_commands::get_agent_login_status,
            commands::system_commands::get_helmor_skills_status,
            commands::system_commands::install_cli,
            commands::system_commands::read_query_cache,
            commands::system_commands::write_query_cache,
            commands::system_commands::delete_query_cache,
            commands::system_commands::install_helmor_skills,
            commands::system_commands::enter_onboarding_window_mode,
            commands::system_commands::exit_onboarding_window_mode,
            commands::system_commands::open_agent_login_terminal,
            commands::system_commands::spawn_agent_login_terminal,
            commands::system_commands::stop_agent_login_terminal,
            commands::system_commands::write_agent_login_terminal_stdin,
            commands::system_commands::resize_agent_login_terminal,
            commands::forge_commands::get_workspace_forge,
            commands::forge_commands::list_forge_accounts,
            commands::forge_commands::list_inbox_items,
            commands::forge_commands::list_inbox_kind_labels,
            commands::forge_commands::list_forge_labels,
            commands::forge_commands::get_inbox_item_detail,
            commands::forge_commands::get_workspace_account_profile,
            commands::forge_commands::cache_forge_avatar,
            commands::forge_commands::list_forge_logins,
            commands::forge_commands::backfill_forge_repo_bindings,
            commands::forge_commands::spawn_forge_cli_auth_terminal,
            commands::forge_commands::stop_forge_cli_auth_terminal,
            commands::forge_commands::invalidate_forge_caches,
            commands::forge_commands::write_forge_cli_auth_terminal_stdin,
            commands::forge_commands::resize_forge_cli_auth_terminal,
            commands::forge_commands::refresh_workspace_change_request,
            commands::forge_commands::get_workspace_forge_action_status,
            commands::forge_commands::get_workspace_forge_check_insert_text,
            commands::forge_commands::merge_workspace_change_request,
            commands::forge_commands::close_workspace_change_request,
            commands::workspace_commands::get_workspace,
            commands::repository_commands::add_repository_from_local_path,
            commands::repository_commands::clone_repository_from_url,
            commands::workspace_commands::list_archived_workspaces,
            commands::repository_commands::list_repositories,
            commands::repository_commands::update_repository_default_branch,
            commands::repository_commands::update_repository_branch_prefix,
            commands::repository_commands::update_repository_remote,
            commands::repository_commands::list_repo_remotes,
            commands::repository_commands::load_repo_scripts,
            commands::repository_commands::load_repo_preferences,
            commands::repository_commands::update_repo_scripts,
            commands::repository_commands::update_repo_auto_run_setup,
            commands::repository_commands::update_repo_run_script_mode,
            commands::repository_commands::update_repo_preferences,
            commands::repository_commands::delete_repository,
            commands::repository_commands::retry_repo_forge_binding,
            commands::script_commands::execute_repo_script,
            commands::script_commands::stop_repo_script,
            commands::script_commands::write_repo_script_stdin,
            commands::script_commands::resize_repo_script,
            commands::terminal_commands::spawn_terminal,
            commands::terminal_commands::stop_terminal,
            commands::terminal_commands::write_terminal_stdin,
            commands::terminal_commands::resize_terminal,
            commands::session_commands::list_session_thread_messages,
            commands::workspace_commands::list_workspace_groups,
            commands::session_commands::list_workspace_sessions,
            commands::session_commands::create_session,
            commands::session_commands::rename_session,
            commands::session_commands::hide_session,
            commands::session_commands::unhide_session,
            commands::session_commands::delete_session,
            commands::session_commands::list_hidden_sessions,
            commands::session_commands::get_session_context_usage,
            commands::session_commands::set_session_context_usage,
            commands::session_commands::get_session_codex_goal,
            commands::session_commands::mutate_codex_goal,
            commands::session_commands::list_session_drafts,
            commands::session_commands::set_session_draft,
            commands::session_commands::get_live_context_usage,
            commands::session_commands::mark_session_read,
            commands::session_commands::mark_session_unread,
            commands::workspace_commands::list_remote_branches,
            commands::workspace_commands::list_branches_for_local_picker,
            commands::workspace_commands::get_repo_current_branch,
            commands::workspace_commands::create_and_checkout_branch,
            commands::workspace_commands::move_local_workspace_to_worktree,
            commands::workspace_commands::rename_workspace_branch,
            commands::workspace_commands::update_intended_target_branch,
            commands::workspace_commands::prefetch_remote_refs,
            commands::workspace_commands::push_workspace_to_remote,
            commands::workspace_commands::continue_workspace_from_target_branch,
            commands::workspace_commands::sync_workspace_with_target_branch,
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
            commands::system_commands::drain_pending_cli_sends,
            commands::editor_commands::read_editor_file,
            commands::editor_commands::read_file_at_ref,
            commands::workspace_commands::set_workspace_status,
            commands::workspace_commands::list_workspace_linked_directories,
            commands::workspace_commands::set_workspace_linked_directories,
            commands::workspace_commands::list_workspace_candidate_directories,
            commands::workspace_commands::trigger_workspace_fetch,
            commands::editors::detect_installed_editors,
            commands::editors::open_workspace_in_editor,
            commands::editors::open_workspace_in_finder,
            commands::workspace_commands::permanently_delete_workspace,
            commands::workspace_commands::restore_workspace,
            commands::editor_commands::stat_editor_file,
            commands::conductor_commands::conductor_source_available,
            commands::conductor_commands::list_conductor_repos,
            commands::conductor_commands::list_conductor_workspaces,
            commands::conductor_commands::import_conductor_workspaces,
            commands::system_commands::save_pasted_image,
            commands::system_commands::save_text_file_as,
            commands::system_commands::show_image_in_finder,
            commands::system_commands::reveal_path_in_finder,
            commands::system_commands::copy_image_to_clipboard,
            commands::system_commands::request_quit,
            commands::system_commands::dev_reset_all_data,
            commands::settings_commands::update_app_settings,
            commands::session_commands::update_session_settings,
            commands::settings_commands::load_auto_close_action_kinds,
            commands::settings_commands::save_auto_close_action_kinds,
            commands::settings_commands::load_auto_close_opt_in_asked,
            commands::settings_commands::save_auto_close_opt_in_asked,
            global_hotkey::sync_global_hotkey,
            ui_sync::subscribe_ui_mutations,
            ui_sync::unsubscribe_ui_mutations,
            commands::updater_commands::get_app_update_status,
            commands::updater_commands::check_for_app_update,
            commands::updater_commands::install_downloaded_app_update,
            commands::editor_commands::write_editor_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Every user-initiated app-exit path is intercepted here and routed
    // through a single `helmor://quit-requested` event. The frontend's
    // QuitConfirmDialog listens for that event, checks for in-flight
    // tasks, and calls back into the `request_quit` IPC command — which
    // cleans up (stops git watchers, SIGTERM's the sidecar) and then
    // invokes `app.exit(0)`.
    //
    //   Source                                  | Rust branch
    //   ----------------------------------------|-------------------------
    //   Red close button / Cmd+W (main window)  | WindowEvent::CloseRequested
    //   Cmd+Q, app-menu Quit (macOS)            | on_menu_event helmor-quit
    //   Dock Quit / system shutdown / SIGINT    | RunEvent::ExitRequested { code: None }
    //   Our own request_quit -> app.exit(0)     | ExitRequested { code: Some(_) }  (passthrough)
    //
    // Note: the `ExitRequested { code: None }` branch is a pure safety
    // net for non-frontend-driven exits. The custom macOS menu above
    // means Cmd+Q never actually takes this path; it exists so a
    // Dock-menu Quit or unexpected OS-level exit can't slip through
    // without confirmation on macOS.
    app.run(|app_handle, event| match event {
        tauri::RunEvent::Resumed => {
            updater::maybe_trigger_on_resume(app_handle.clone());
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Focused(true),
            ..
        } if label == "main" => {
            updater::maybe_trigger_on_focus(app_handle.clone());
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            api.prevent_close();
            emit_quit_requested(app_handle);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            api.prevent_exit();
            emit_quit_requested(app_handle);
        }
        // Install pending update on the way out so the next launch is the
        // new version. By this point `request_quit` has stopped watchers
        // and torn down the sidecar, so blocking briefly here is safe.
        tauri::RunEvent::Exit => {
            updater::install_pending_on_exit_blocking();
        }
        _ => {}
    });
}

// Route a user-initiated exit through the frontend quit-confirm flow.
// If the emit fails the webview is almost certainly gone, so falling
// back to a direct exit is safer than leaving the process hanging with
// no UI and no way to quit.
fn emit_quit_requested(app_handle: &tauri::AppHandle) {
    if let Err(e) = app_handle.emit("helmor://quit-requested", ()) {
        tracing::warn!(
            error = %e,
            "Failed to emit quit-requested event; exiting directly",
        );
        app_handle.exit(0);
    }
}

const HELMOR_QUIT_MENU_ID: &str = "helmor-quit";
const HELMOR_CLOSE_CURRENT_SESSION_MENU_ID: &str = "helmor-close-current-session";

#[cfg(target_os = "macos")]
fn install_macos_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let close_current_session_item = MenuItemBuilder::with_id(
        HELMOR_CLOSE_CURRENT_SESSION_MENU_ID,
        "Close Current Session",
    )
    .accelerator("Cmd+W")
    .build(app)?;

    let quit_item = MenuItemBuilder::with_id(HELMOR_QUIT_MENU_ID, "Quit Helmor")
        .accelerator("Cmd+Q")
        .build(app)?;

    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("Helmor"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .build();

    let app_submenu = SubmenuBuilder::new(app, "Helmor")
        .about(Some(about_metadata))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit_item)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&close_current_session_item)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_submenu, &edit_submenu, &window_submenu])
        .build()?;

    app.set_menu(menu)?;

    let handle = app.clone();
    app.on_menu_event(move |_, event| match event.id().0.as_str() {
        HELMOR_QUIT_MENU_ID => emit_quit_requested(&handle),
        HELMOR_CLOSE_CURRENT_SESSION_MENU_ID => emit_close_current_session_requested(&handle),
        _ => {}
    });

    Ok(())
}

fn emit_close_current_session_requested(app_handle: &tauri::AppHandle) {
    if let Err(e) = app_handle.emit("helmor://close-current-session", ()) {
        tracing::warn!(error = %e, "Failed to emit close-current-session event");
    }
}
