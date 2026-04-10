pub mod agents;
pub mod data_dir;
pub mod error;
mod import;
pub mod mcp;
mod models;
pub mod pipeline;
mod schema;
pub mod service;
pub mod sidecar;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::path::BaseDirectory;
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

/// Resolve bundled Claude Code / Codex CLI resource paths (as declared in
/// `tauri.conf.json > bundle.resources`) and set them as env vars so the
/// sidecar subprocess inherits them on spawn.
///
/// This runs unconditionally in `setup`, but is a no-op in dev because the
/// `vendor/` resource layout only exists inside bundled `.app` / installer
/// builds. When the resolved path is missing we leave the env var unset and
/// the sidecar falls back to its own `node_modules` lookup.
fn export_bundled_agent_paths(handle: &tauri::AppHandle) {
    let cli_js = handle
        .path()
        .resolve("vendor/claude-code/cli.js", BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file());
    if let Some(path) = cli_js {
        eprintln!(
            "[setup] Claude Code CLI → {} (bundled resource)",
            path.display()
        );
        // SAFETY: set_var is `unsafe` in Rust 2024 editions; we're in setup
        // before any threads spawn that would race with env reads.
        unsafe {
            std::env::set_var("HELMOR_CLAUDE_CODE_CLI_PATH", path);
        }
    }

    let codex_bin_name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let codex_bin = handle
        .path()
        .resolve(
            format!("vendor/codex/{codex_bin_name}"),
            BaseDirectory::Resource,
        )
        .ok()
        .filter(|p| p.is_file());
    if let Some(path) = codex_bin {
        eprintln!("[setup] Codex CLI → {} (bundled resource)", path.display());
        unsafe {
            std::env::set_var("HELMOR_CODEX_BIN_PATH", path);
        }
    }

    // Bundled bun — the JS runtime the Claude Agent SDK spawns cli.js through.
    // Without this the SDK does `spawn("bun", ...)` which fails inside a
    // Finder-launched `.app` bundle (PATH = /usr/bin:/bin:/usr/sbin:/sbin).
    let bun_bin_name = if cfg!(windows) { "bun.exe" } else { "bun" };
    let bun_bin = handle
        .path()
        .resolve(
            format!("vendor/bun/{bun_bin_name}"),
            BaseDirectory::Resource,
        )
        .ok()
        .filter(|p| p.is_file());
    if let Some(path) = bun_bin {
        eprintln!(
            "[setup] bun runtime → {} (bundled resource)",
            path.display()
        );
        unsafe {
            std::env::set_var("HELMOR_BUN_PATH", path);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    let app = builder
        .manage(models::auth::GithubIdentityFlowRuntime::default())
        .manage(sidecar::ManagedSidecar::new())
        .manage(agents::ActiveStreams::new())
        .setup(|app| {
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

            // Resolve bundled Claude Code + Codex CLI resources and publish
            // them to the sidecar via env vars before it ever spawns. The
            // sidecar reads `HELMOR_CLAUDE_CODE_CLI_PATH` /
            // `HELMOR_CODEX_BIN_PATH` at module load and passes them through
            // to the SDKs' explicit path options.
            //
            // In dev (no `bundle.resources` in play) `resolve(..., Resource)`
            // returns a path that doesn't exist — skip silently so the
            // sidecar falls back to its own `createRequire` / SDK lookup
            // against `node_modules`.
            export_bundled_agent_paths(app.handle());

            // OAuth callback is now handled by a one-shot localhost HTTP
            // server spun up inside `start_github_oauth_redirect`, so no
            // deep-link `on_open_url` handler is needed here.

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agents::list_agent_model_sections,
            agents::send_agent_message_stream,
            agents::stop_agent_stream,
            agents::respond_to_permission_request,
            agents::generate_session_title,
            agents::list_slash_commands,
            models::archive_workspace,
            models::validate_archive_workspace,
            models::validate_restore_workspace,
            models::cancel_github_identity_connect,
            models::create_workspace_from_repo,
            models::disconnect_github_identity,
            models::get_add_repository_defaults,
            models::get_app_settings,
            models::get_cli_status,
            models::get_data_info,
            models::install_cli,
            models::get_github_cli_status,
            models::get_github_cli_user,
            models::get_github_identity_session,
            models::get_workspace,
            models::add_repository_from_local_path,
            models::list_github_accessible_repositories,
            models::list_archived_workspaces,
            models::list_repositories,
            models::update_repository_default_branch,
            models::update_repository_remote,
            models::list_repo_remotes,
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
            models::rename_workspace_branch,
            models::update_intended_target_branch,
            models::prefetch_remote_refs,
            models::mark_workspace_read,
            models::mark_workspace_unread,
            models::pin_workspace,
            models::unpin_workspace,
            models::list_editor_files,
            models::list_editor_files_with_content,
            models::list_workspace_files,
            models::list_workspace_changes,
            models::list_workspace_changes_with_content,
            models::discard_workspace_file,
            models::stage_workspace_file,
            models::unstage_workspace_file,
            models::get_workspace_git_action_status,
            models::lookup_workspace_pr,
            models::get_workspace_pr_action_status,
            models::get_workspace_pr_check_insert_text,
            models::merge_workspace_pr,
            models::close_workspace_pr,
            models::drain_pending_cli_sends,
            models::read_editor_file,
            models::set_workspace_manual_status,
            models::detect_installed_editors,
            models::open_workspace_in_editor,
            models::permanently_delete_workspace,
            models::restore_workspace,
            models::stat_editor_file,
            models::start_github_identity_connect,
            models::start_github_oauth_redirect,
            models::conductor_source_available,
            models::list_conductor_repos,
            models::list_conductor_workspaces,
            models::import_conductor_workspaces,
            models::save_pasted_image,
            models::update_app_settings,
            models::update_session_settings,
            models::load_auto_close_action_kinds,
            models::save_auto_close_action_kinds,
            models::load_auto_close_opt_in_asked,
            models::save_auto_close_opt_in_asked,
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
            // No active streams, but still shut down the sidecar cooperatively
            // so Bun and any child CLIs get a chance to exit cleanly instead of
            // being SIGKILL'd by the Drop impl.
            let sidecar = app_handle.state::<sidecar::ManagedSidecar>();
            sidecar.shutdown(
                std::time::Duration::from_millis(500),
                std::time::Duration::from_millis(200),
            );
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
                // We're on a worker thread now, so the blocking helpers are
                // safe to call.
                let sidecar = app_handle_clone.state::<sidecar::ManagedSidecar>();
                let active = app_handle_clone.state::<agents::ActiveStreams>();
                agents::abort_all_active_streams_blocking(
                    &sidecar,
                    &active,
                    std::time::Duration::from_millis(1500),
                );
                // Cooperative sidecar teardown — let bun close every live
                // SDK Query so the spawned claude-code / codex CLIs get a
                // chance to exit on their own. Ladder: shutdown RPC (2s) →
                // SIGTERM (500ms) → SIGKILL via Drop.
                sidecar.shutdown(
                    std::time::Duration::from_millis(2000),
                    std::time::Duration::from_millis(500),
                );
                SHUTDOWN_CONFIRMED.store(true, Ordering::Release);
                eprintln!("[shutdown] Cleanup done, calling exit(0)");
                app_handle_clone.exit(0);
            });
    });
}
