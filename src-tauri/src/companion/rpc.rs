//! HTTP RPC dispatch.
//!
//! Maps a command name + JSON args to the same `#[tauri::command]` functions the
//! desktop webview calls. Dispatch holds the concrete `AppHandle`, so commands
//! needing `State`/`AppHandle` work — the full surface, not just state-free
//! reads. `Channel`-based streaming stays in `stream.rs`. Reusing the command
//! functions verbatim is what keeps desktop and browser behaviour identical.
//!
//! The arm list is generated from a survey of every command the frontend
//! invokes (see `.agent-contexts/companion-rpc/`); regenerate after adding a
//! command the browser calls.

use futures::FutureExt;
use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

use super::server::Dispatcher;
use crate::commands as cmd;
use crate::error::CommandError;

/// Build the dispatcher bound to the concrete Tauri app. Type-erased so the
/// runtime-generic server holds a single entry point (mirrors
/// [`super::build_stream_starter`]).
pub fn build_dispatcher(app: tauri::AppHandle) -> Dispatcher {
    std::sync::Arc::new(move |command: String, args: Value| {
        let app = app.clone();
        async move { dispatch(&app, &command, args).await }.boxed()
    })
}

/// Dispatch a single RPC call. `args` is the parsed JSON request body (or
/// `Value::Null` when there is no body).
async fn dispatch(
    app: &tauri::AppHandle,
    command: &str,
    args: Value,
) -> Result<Value, CommandError> {
    match command {
        // Settings: redact credential-bearing keys before handing them to a
        // paired phone (it can't configure them and they'd otherwise sit in the
        // browser's localStorage / query cache in plaintext).
        "get_app_settings" => {
            let mut settings = cmd::settings_commands::get_app_settings().await?;
            settings.retain(|key, _| !is_secret_setting_key(key));
            to_value(settings)
        }
        // ============ generated: data + control commands ============
        "add_repository_from_local_path" => to_value(crate::commands::repository_commands::add_repository_from_local_path(arg_string(&args, "folderPath")?).await?),
        "backfill_forge_repo_bindings" => to_value(crate::commands::forge_commands::backfill_forge_repo_bindings(app.clone()).await?),
        "cache_forge_avatar" => to_value(crate::commands::forge_commands::cache_forge_avatar(arg_string(&args, "url")?).await?),
        "check_for_app_update" => to_value(crate::commands::updater_commands::check_for_app_update(app.clone(), arg_opt_bool(&args, "force")).await?),
        "cleanup_archived_workspaces" => to_value(crate::commands::workspace_commands::cleanup_archived_workspaces(app.clone()).await?),
        "clone_repository_from_url" => to_value(crate::commands::repository_commands::clone_repository_from_url(arg_string(&args, "gitUrl")?, arg_string(&args, "cloneDirectory")?).await?),
        "close_workspace_change_request" => to_value(crate::commands::forge_commands::close_workspace_change_request(arg_string(&args, "workspaceId")?, app.clone()).await?),
        "complete_workspace_setup" => {
            crate::commands::workspace_commands::complete_workspace_setup(app.clone(), arg_string(&args, "workspaceId")?).await?;
            Ok(Value::Null)
        }
        "continue_workspace_from_target_branch" => to_value(crate::commands::workspace_commands::continue_workspace_from_target_branch(app.clone(), arg_string(&args, "workspaceId")?).await?),
        "convert_session_to_terminal" => {
            crate::commands::terminal_commands::convert_session_to_terminal(arg_string(&args, "sessionId")?, arg_string(&args, "agentType")?).await?;
            Ok(Value::Null)
        }
        "create_and_checkout_branch" => {
            crate::commands::workspace_commands::create_and_checkout_branch(arg_string(&args, "repoId")?, arg_string(&args, "branch")?).await?;
            Ok(Value::Null)
        }
        "create_repo_run_action" => to_value(crate::commands::script_commands::create_repo_run_action(app.clone(), arg_string(&args, "repoId")?, arg_string(&args, "name")?, arg_string(&args, "command")?, arg_string(&args, "mode")?, arg_opt_string(&args, "stopCommand")).await?),
        "create_session" => to_value(crate::commands::session_commands::create_session(arg_string(&args, "workspaceId")?, arg_opt_json(&args, "actionKind")?, arg_opt_string(&args, "permissionMode"), arg_opt_string(&args, "model"), arg_opt_string(&args, "effortLevel"), arg_opt_bool(&args, "fastMode"), arg_opt_string(&args, "seedSessionId"), arg_opt_string(&args, "sessionKind"), arg_opt_string(&args, "agentType")).await?),
        "create_workspace_from_repo" => to_value(crate::commands::workspace_commands::create_workspace_from_repo(app.clone(), arg_string(&args, "repoId")?).await?),
        "delete_query_cache" => {
            crate::commands::system_commands::delete_query_cache(arg_string(&args, "key")?).await?;
            Ok(Value::Null)
        }
        "delete_repo_run_action" => {
            crate::commands::script_commands::delete_repo_run_action(app.clone(), arg_string(&args, "repoId")?, arg_string(&args, "actionId")?).await?;
            Ok(Value::Null)
        }
        "delete_repository" => {
            crate::commands::repository_commands::delete_repository(arg_string(&args, "repoId")?).await?;
            Ok(Value::Null)
        }
        "delete_session" => {
            crate::commands::session_commands::delete_session(arg_string(&args, "sessionId")?).await?;
            Ok(Value::Null)
        }
        "detect_installed_editors" => to_value(crate::commands::editors::detect_installed_editors().await?),
        "discard_workspace_file" => {
            crate::commands::editor_commands::discard_workspace_file(arg_string(&args, "workspaceRootPath")?, arg_string(&args, "relativePath")?).await?;
            Ok(Value::Null)
        }
        "drain_pending_cli_sends" => to_value(crate::commands::system_commands::drain_pending_cli_sends().await?),
        "finalize_workspace_from_repo" => to_value(crate::commands::workspace_commands::finalize_workspace_from_repo(app.clone(), arg_string(&args, "workspaceId")?).await?),
        "generate_session_title" => to_value(crate::agents::generate_session_title(app.clone(), app.state::<crate::sidecar::ManagedSidecar>(), arg_json(&args, "request")?).await?),
        "get_add_repository_defaults" => to_value(crate::commands::repository_commands::get_add_repository_defaults().await?),
        "get_agent_login_status" => to_value(crate::commands::system_commands::get_agent_login_status().await?),
        "get_agent_versions" => to_value(crate::commands::system_commands::get_agent_versions().await?),
        "get_app_update_status" => to_value(crate::commands::updater_commands::get_app_update_status(app.clone()).await?),
        "get_claude_rate_limits" => to_value(crate::commands::settings_commands::get_claude_rate_limits().await?),
        "get_cli_status" => to_value(crate::commands::system_commands::get_cli_status()?),
        "get_codex_rate_limits" => to_value(crate::commands::settings_commands::get_codex_rate_limits().await?),
        "get_data_info" => to_value(crate::commands::system_commands::get_data_info()?),
        "get_helmor_components_update_check" => to_value(crate::commands::system_commands::get_helmor_components_update_check().await?),
        "get_helmor_skills_status" => to_value(crate::commands::system_commands::get_helmor_skills_status().await?),
        "get_inbox_item_detail" => to_value(crate::commands::forge_commands::get_inbox_item_detail(arg_json(&args, "provider")?, arg_string(&args, "login")?, arg_opt_string(&args, "host"), arg_json(&args, "source")?, arg_string(&args, "externalId")?).await?),
        "get_kimi_provider_config" => to_value(crate::commands::kimi_provider_commands::get_kimi_provider_config().await?),
        "get_live_context_usage" => to_value(crate::commands::session_commands::get_live_context_usage(app.state::<crate::sidecar::ManagedSidecar>(), arg_json(&args, "request")?).await?),
        "get_repo_current_branch" => to_value(crate::commands::workspace_commands::get_repo_current_branch(arg_string(&args, "repoId")?).await?),
        "get_session_codex_goal" => to_value(crate::commands::session_commands::get_session_codex_goal(arg_string(&args, "sessionId")?).await?),
        "get_session_context_usage" => to_value(crate::commands::session_commands::get_session_context_usage(arg_string(&args, "sessionId")?).await?),
        "get_session_plan_state" => to_value(crate::commands::session_commands::get_session_plan_state(arg_string(&args, "sessionId")?).await?),
        "get_workspace" => to_value(crate::commands::workspace_commands::get_workspace(arg_string(&args, "workspaceId")?).await?),
        "get_workspace_account_profile" => to_value(crate::commands::forge_commands::get_workspace_account_profile(arg_string(&args, "workspaceId")?).await?),
        "get_workspace_forge" => to_value(crate::commands::forge_commands::get_workspace_forge(arg_string(&args, "workspaceId")?).await?),
        "get_workspace_forge_action_status" => to_value(crate::commands::forge_commands::get_workspace_forge_action_status(arg_string(&args, "workspaceId")?, app.clone(), app.state::<crate::commands::forge_commands::ForgeAuthEdgeStore>()).await?),
        "get_workspace_forge_check_insert_text" => to_value(crate::commands::forge_commands::get_workspace_forge_check_insert_text(arg_string(&args, "workspaceId")?, arg_string(&args, "itemId")?).await?),
        "get_workspace_git_action_status" => to_value(crate::commands::editor_commands::get_workspace_git_action_status(arg_string(&args, "workspaceId")?).await?),
        "hide_session" => {
            crate::commands::session_commands::hide_session(arg_string(&args, "sessionId")?).await?;
            Ok(Value::Null)
        }
        "install_downloaded_app_update" => to_value(crate::commands::updater_commands::install_downloaded_app_update(app.clone()).await?),
        "invalidate_forge_caches" => {
            crate::commands::forge_commands::invalidate_forge_caches(arg_json(&args, "provider")?, arg_opt_string(&args, "host")).await?;
            Ok(Value::Null)
        }
        "list_active_streams" => to_value(crate::agents::list_active_streams(app.state::<crate::agents::ActiveStreams>()).await?),
        "list_agent_model_sections" => to_value(crate::agents::list_agent_model_sections().await?),
        "list_all_agent_model_sections" => {
            to_value(crate::agents::list_all_agent_model_sections().await?)
        }
        "list_custom_providers" => to_value(
            crate::commands::provider_commands::list_custom_providers(arg_string(&args, "family")?)
                .await?,
        ),
        "upsert_custom_provider" => {
            crate::commands::provider_commands::upsert_custom_provider(
                arg_string(&args, "family")?,
                arg_json(&args, "provider")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "remove_custom_provider" => {
            crate::commands::provider_commands::remove_custom_provider(
                arg_string(&args, "family")?,
                arg_string(&args, "id")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "fetch_provider_models" => to_value(
            crate::commands::provider_commands::fetch_provider_models(
                arg_string(&args, "family")?,
                arg_string(&args, "baseUrl")?,
                arg_opt_string(&args, "apiKey").unwrap_or_default(),
                arg_opt_string(&args, "apiStyle"),
            )
            .await?,
        ),
        "list_archived_workspaces" => to_value(crate::commands::workspace_commands::list_archived_workspaces().await?),
        "list_branches_for_local_picker" => to_value(crate::commands::workspace_commands::list_branches_for_local_picker(arg_string(&args, "repoId")?).await?),
        "list_branches_for_workspace_picker" => to_value(crate::commands::workspace_commands::list_branches_for_workspace_picker(arg_string(&args, "repoId")?).await?),
        "list_cursor_models" => to_value(crate::agents::list_cursor_models(app.state::<crate::sidecar::ManagedSidecar>(), arg_opt_string(&args, "apiKey")).await?),
        "list_editor_files" => to_value(crate::commands::editor_commands::list_editor_files(arg_string(&args, "workspaceRootPath")?).await?),
        "list_forge_accounts" => to_value(crate::commands::forge_commands::list_forge_accounts(arg_json(&args, "gitlabHosts")?).await?),
        "check_workspace_forge_auth" => to_value(crate::commands::forge_commands::check_workspace_forge_auth(arg_string(&args, "workspaceId")?).await?),
        "list_forge_labels" => to_value(crate::commands::forge_commands::list_forge_labels(arg_json(&args, "provider")?, arg_string(&args, "login")?, arg_opt_string(&args, "host"), arg_json(&args, "repos")?).await?),
        "list_forge_logins" => to_value(crate::commands::forge_commands::list_forge_logins(arg_json(&args, "provider")?, arg_string(&args, "host")?, arg_opt_bool(&args, "forceRefresh")).await?),
        "list_hidden_sessions" => to_value(crate::commands::session_commands::list_hidden_sessions(arg_string(&args, "workspaceId")?).await?),
        "list_inbox_items" => to_value(crate::commands::forge_commands::list_inbox_items(arg_json(&args, "provider")?, arg_json(&args, "kind")?, arg_string(&args, "login")?, arg_opt_string(&args, "host"), arg_opt_string(&args, "cursor"), arg_opt_int(&args, "limit"), arg_opt_string(&args, "repo"), arg_opt_json(&args, "filters")?).await?),
        "list_inbox_kind_labels" => to_value(crate::commands::forge_commands::list_inbox_kind_labels(arg_json(&args, "provider")?).await?),
        "list_opencode_models" => to_value(crate::agents::list_opencode_models(app.state::<crate::sidecar::ManagedSidecar>(), None).await?),
        "list_provider_capabilities" => to_value(crate::agents::list_provider_capabilities().await?),
        "list_remote_branches" => to_value(crate::commands::workspace_commands::list_remote_branches(arg_opt_string(&args, "workspaceId"), arg_opt_string(&args, "repoId")).await?),
        "list_repo_remotes" => to_value(crate::commands::repository_commands::list_repo_remotes(arg_string(&args, "repoId")?).await?),
        "list_repositories" => to_value(crate::commands::repository_commands::list_repositories().await?),
        "list_session_drafts" => to_value(crate::commands::session_commands::list_session_drafts().await?),
        "list_session_thread_messages" => to_value(crate::commands::session_commands::list_session_thread_messages(arg_string(&args, "sessionId")?, arg_opt_int(&args, "tailLimit")).await?),
        "list_slash_commands" => to_value(crate::agents::list_slash_commands(app.clone(), app.state::<crate::sidecar::ManagedSidecar>(), app.state::<crate::agents::SlashCommandCache>(), arg_json(&args, "request")?).await?),
        "list_workspace_candidate_directories" => to_value(crate::commands::workspace_commands::list_workspace_candidate_directories(arg_opt_string(&args, "excludeWorkspaceId")).await?),
        "list_workspace_changes" => to_value(crate::commands::editor_commands::list_workspace_changes(arg_string(&args, "workspaceRootPath")?, arg_opt_string(&args, "workspaceId")).await?),
        "list_workspace_files" => to_value(crate::commands::editor_commands::list_workspace_files(arg_string(&args, "workspaceRootPath")?).await?),
        "list_workspace_groups" => to_value(crate::commands::workspace_commands::list_workspace_groups().await?),
        "list_workspace_linked_directories" => to_value(crate::commands::workspace_commands::list_workspace_linked_directories(arg_string(&args, "workspaceId")?).await?),
        "list_workspace_sessions" => to_value(crate::commands::session_commands::list_workspace_sessions(arg_string(&args, "workspaceId")?).await?),
        "load_auto_close_action_kinds" => to_value(crate::commands::settings_commands::load_auto_close_action_kinds().await?),
        "load_auto_close_opt_in_asked" => to_value(crate::commands::settings_commands::load_auto_close_opt_in_asked().await?),
        "load_repo_preferences" => to_value(crate::commands::repository_commands::load_repo_preferences(arg_string(&args, "repoId")?).await?),
        "load_repo_scripts" => to_value(crate::commands::repository_commands::load_repo_scripts(arg_string(&args, "repoId")?, arg_opt_string(&args, "workspaceId")).await?),
        "mark_session_read" => {
            crate::commands::session_commands::mark_session_read(arg_string(&args, "sessionId")?).await?;
            Ok(Value::Null)
        }
        "mark_session_unread" => {
            crate::commands::session_commands::mark_session_unread(arg_string(&args, "sessionId")?).await?;
            Ok(Value::Null)
        }
        "mark_workspace_unread" => {
            crate::commands::workspace_commands::mark_workspace_unread(arg_string(&args, "workspaceId")?).await?;
            Ok(Value::Null)
        }
        "merge_workspace_change_request" => to_value(crate::commands::forge_commands::merge_workspace_change_request(arg_string(&args, "workspaceId")?, app.clone()).await?),
        "move_local_workspace_to_worktree" => to_value(crate::commands::workspace_commands::move_local_workspace_to_worktree(app.clone(), arg_string(&args, "workspaceId")?).await?),
        "move_repository_in_sidebar" => {
            crate::commands::repository_commands::move_repository_in_sidebar(arg_string(&args, "repoId")?, arg_opt_string(&args, "beforeRepoId")).await?;
            Ok(Value::Null)
        }
        "move_workspace_in_sidebar" => {
            crate::commands::workspace_commands::move_workspace_in_sidebar(arg_string(&args, "workspaceId")?, arg_string(&args, "targetGroupId")?, arg_opt_string(&args, "beforeWorkspaceId")).await?;
            Ok(Value::Null)
        }
        "mutate_codex_goal" => {
            crate::commands::session_commands::mutate_codex_goal(app.clone(), app.state::<crate::sidecar::ManagedSidecar>(), arg_string(&args, "sessionId")?, arg_string(&args, "action")?).await?;
            Ok(Value::Null)
        }
        "permanently_delete_workspace" => {
            crate::commands::workspace_commands::permanently_delete_workspace(app.clone(), arg_string(&args, "workspaceId")?).await?;
            Ok(Value::Null)
        }
        "pin_workspace" => {
            crate::commands::workspace_commands::pin_workspace(arg_string(&args, "workspaceId")?).await?;
            Ok(Value::Null)
        }
        "prefetch_remote_refs" => to_value(crate::commands::workspace_commands::prefetch_remote_refs(arg_opt_string(&args, "workspaceId"), arg_opt_string(&args, "repoId")).await?),
        "prepare_archive_workspace" => to_value(crate::commands::workspace_commands::prepare_archive_workspace(app.clone(), arg_string(&args, "workspaceId")?).await?),
        "prepare_chat_workspace" => to_value(crate::commands::workspace_commands::prepare_chat_workspace(app.clone(), arg_opt_json(&args, "initialStatus")?, arg_opt_string(&args, "seedSessionId")).await?),
        "prepare_workspace_from_repo" => to_value(crate::commands::workspace_commands::prepare_workspace_from_repo(app.clone(), arg_string(&args, "repoId")?, arg_opt_string(&args, "sourceBranch"), arg_opt_json(&args, "mode")?, arg_opt_json(&args, "branchIntent")?, arg_opt_json(&args, "initialStatus")?, arg_opt_string(&args, "seedSessionId")).await?),
        "prewarm_slash_commands_for_repo" => {
            crate::agents::prewarm_slash_commands_for_repo(app.clone(), arg_string(&args, "repoId")?).await?;
            Ok(Value::Null)
        }
        "prewarm_slash_commands_for_workspace" => {
            crate::agents::prewarm_slash_commands_for_workspace(app.clone(), arg_string(&args, "workspaceId")?).await?;
            Ok(Value::Null)
        }
        "push_workspace_to_remote" => to_value(crate::commands::workspace_commands::push_workspace_to_remote(arg_string(&args, "workspaceId")?).await?),
        "read_editor_file" => to_value(crate::commands::editor_commands::read_editor_file(arg_string(&args, "path")?).await?),
        "read_file_at_ref" => to_value(crate::commands::editor_commands::read_file_at_ref(arg_string(&args, "workspaceRootPath")?, arg_string(&args, "filePath")?, arg_string(&args, "gitRef")?).await?),
        "read_query_cache" => to_value(crate::commands::system_commands::read_query_cache(arg_string(&args, "key")?).await?),
        "recheck_helmor_components" => to_value(crate::commands::system_commands::recheck_helmor_components().await?),
        "refresh_workspace_change_request" => to_value(crate::commands::forge_commands::refresh_workspace_change_request(arg_string(&args, "workspaceId")?, app.clone()).await?),
        "rename_session" => {
            crate::commands::session_commands::rename_session(arg_string(&args, "sessionId")?, arg_string(&args, "title")?).await?;
            Ok(Value::Null)
        }
        "rename_workspace_branch" => {
            crate::commands::workspace_commands::rename_workspace_branch(app.clone(), arg_string(&args, "workspaceId")?, arg_string(&args, "newBranch")?).await?;
            Ok(Value::Null)
        }
        "reorder_repo_run_actions" => {
            crate::commands::script_commands::reorder_repo_run_actions(app.clone(), arg_string(&args, "repoId")?, arg_json(&args, "orderedIds")?).await?;
            Ok(Value::Null)
        }
        "respond_to_permission_request" => {
            crate::agents::respond_to_permission_request(app.state::<crate::sidecar::ManagedSidecar>(), arg_json(&args, "request")?).await?;
            Ok(Value::Null)
        }
        "respond_to_user_input" => {
            crate::agents::respond_to_user_input(app.state::<crate::sidecar::ManagedSidecar>(), arg_json(&args, "request")?).await?;
            Ok(Value::Null)
        }
        "restore_workspace" => to_value(crate::commands::workspace_commands::restore_workspace(app.clone(), arg_string(&args, "workspaceId")?, arg_opt_string(&args, "targetBranchOverride")).await?),
        "retry_repo_forge_binding" => to_value(crate::commands::repository_commands::retry_repo_forge_binding(app.clone(), arg_string(&args, "repoId")?).await?),
        "save_auto_close_action_kinds" => {
            crate::commands::settings_commands::save_auto_close_action_kinds(arg_json(&args, "kinds")?).await?;
            Ok(Value::Null)
        }
        "save_auto_close_opt_in_asked" => {
            crate::commands::settings_commands::save_auto_close_opt_in_asked(arg_json(&args, "kinds")?).await?;
            Ok(Value::Null)
        }
        "save_pasted_image" => to_value(crate::commands::system_commands::save_pasted_image(arg_string(&args, "data")?, arg_string(&args, "mediaType")?, arg_string(&args, "sessionId")?).await?),
        "save_text_file_as" => {
            crate::commands::system_commands::save_text_file_as(arg_string(&args, "path")?, arg_string(&args, "contents")?).await?;
            Ok(Value::Null)
        }
        "set_session_context_usage" => {
            crate::commands::session_commands::set_session_context_usage(app.clone(), arg_string(&args, "sessionId")?, arg_string(&args, "meta")?).await?;
            Ok(Value::Null)
        }
        "set_session_draft" => {
            crate::commands::session_commands::set_session_draft(arg_string(&args, "sessionId")?, arg_opt_string(&args, "draftState")).await?;
            Ok(Value::Null)
        }
        "set_terminal_session_busy" => {
            crate::commands::terminal_commands::set_terminal_session_busy(
                app.clone(),
                arg_string(&args, "sessionId")?,
                arg_string(&args, "workspaceId")?,
                arg_opt_string(&args, "provider"),
                arg_bool(&args, "busy")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "set_workspace_active_run_action" => {
            crate::commands::script_commands::set_workspace_active_run_action(arg_string(&args, "workspaceId")?, arg_opt_string(&args, "actionId")).await?;
            Ok(Value::Null)
        }
        "set_workspace_linked_directories" => to_value(crate::commands::workspace_commands::set_workspace_linked_directories(app.clone(), arg_string(&args, "workspaceId")?, arg_json(&args, "directories")?).await?),
        "set_workspace_status" => {
            crate::commands::workspace_commands::set_workspace_status(arg_string(&args, "workspaceId")?, arg_json(&args, "status")?).await?;
            Ok(Value::Null)
        }
        "stage_workspace_file" => {
            crate::commands::editor_commands::stage_workspace_file(arg_string(&args, "workspaceRootPath")?, arg_string(&args, "relativePath")?).await?;
            Ok(Value::Null)
        }
        "start_archive_workspace" => {
            crate::commands::workspace_commands::start_archive_workspace(app.clone(), arg_string(&args, "workspaceId")?).await?;
            Ok(Value::Null)
        }
        "stat_editor_file" => to_value(crate::commands::editor_commands::stat_editor_file(arg_string(&args, "path")?).await?),
        "steer_agent_stream" => to_value(crate::agents::steer_agent_stream(app.clone(), app.state::<crate::sidecar::ManagedSidecar>(), arg_json(&args, "request")?).await?),
        "stop_agent_stream" => {
            crate::agents::stop_agent_stream(app.state::<crate::sidecar::ManagedSidecar>(), arg_json(&args, "request")?).await?;
            Ok(Value::Null)
        }
        "sync_workspace_with_target_branch" => to_value(crate::commands::workspace_commands::sync_workspace_with_target_branch(arg_string(&args, "workspaceId")?).await?),
        "trigger_workspace_fetch" => {
            crate::commands::workspace_commands::trigger_workspace_fetch(arg_string(&args, "workspaceId")?).await?;
            Ok(Value::Null)
        }
        "unhide_session" => {
            crate::commands::session_commands::unhide_session(arg_string(&args, "sessionId")?).await?;
            Ok(Value::Null)
        }
        "unpin_workspace" => {
            crate::commands::workspace_commands::unpin_workspace(arg_string(&args, "workspaceId")?).await?;
            Ok(Value::Null)
        }
        "unstage_workspace_file" => {
            crate::commands::editor_commands::unstage_workspace_file(arg_string(&args, "workspaceRootPath")?, arg_string(&args, "relativePath")?).await?;
            Ok(Value::Null)
        }
        // A watcher detaching. Deterministically drop the hub subscriber by id —
        // do NOT rely on the `/rpc-stream` disconnect being detected (a half-open
        // tunnel connection could otherwise keep a stale subscriber receiving
        // fan-out). The browser also aborts the stream fetch (see `closeChannel`
        // in ipc.ts); whichever lands first wins and the other no-ops.
        "unsubscribe_session_stream" => {
            crate::agents::unsubscribe_session_stream(
                app.state::<crate::agents::SessionStreamHub>(),
                arg_string(&args, "sessionId")?,
                arg_string(&args, "subscriptionId")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "update_app_settings" => {
            crate::commands::settings_commands::update_app_settings(app.state::<crate::sidecar::ManagedSidecar>(), arg_json(&args, "settingsMap")?).await?;
            Ok(Value::Null)
        }
        "update_intended_target_branch" => to_value(crate::commands::workspace_commands::update_intended_target_branch(app.clone(), arg_string(&args, "workspaceId")?, arg_string(&args, "targetBranch")?).await?),
        "update_repo_auto_run_setup" => {
            crate::commands::repository_commands::update_repo_auto_run_setup(arg_string(&args, "repoId")?, arg_bool(&args, "enabled")?).await?;
            Ok(Value::Null)
        }
        "update_repo_preferences" => {
            crate::commands::repository_commands::update_repo_preferences(arg_string(&args, "repoId")?, arg_json(&args, "preferences")?).await?;
            Ok(Value::Null)
        }
        "update_repo_run_action" => {
            crate::commands::script_commands::update_repo_run_action(app.clone(), arg_string(&args, "repoId")?, arg_string(&args, "actionId")?, arg_string(&args, "name")?, arg_string(&args, "command")?, arg_string(&args, "mode")?, arg_opt_string(&args, "stopCommand")).await?;
            Ok(Value::Null)
        }
        "update_repo_scripts" => {
            crate::commands::repository_commands::update_repo_scripts(arg_string(&args, "repoId")?, arg_opt_string(&args, "setupScript"), arg_opt_string(&args, "archiveScript")).await?;
            Ok(Value::Null)
        }
        "update_repository_branch_prefix" => {
            crate::commands::repository_commands::update_repository_branch_prefix(
                arg_string(&args, "repoId")?,
                arg_opt_json(&args, "branchPrefixType")?,
                arg_opt_string(&args, "branchPrefixCustom"),
            )
            .await?;
            Ok(Value::Null)
        }
        "update_repository_default_branch" => {
            crate::commands::repository_commands::update_repository_default_branch(app.clone(), arg_string(&args, "repoId")?, arg_string(&args, "defaultBranch")?).await?;
            Ok(Value::Null)
        }
        "update_repository_remote" => to_value(crate::commands::repository_commands::update_repository_remote(app.clone(), arg_string(&args, "repoId")?, arg_string(&args, "remote")?).await?),
        "update_session_settings" => {
            crate::commands::session_commands::update_session_settings(arg_string(&args, "sessionId")?, arg_opt_string(&args, "model"), arg_opt_string(&args, "effortLevel"), arg_opt_string(&args, "permissionMode"), arg_opt_bool(&args, "fastMode")).await?;
            Ok(Value::Null)
        }
        "validate_archive_workspace" => to_value(crate::commands::workspace_commands::validate_archive_workspace(arg_string(&args, "workspaceId")?).await?),
        "validate_restore_workspace" => to_value(crate::commands::workspace_commands::validate_restore_workspace(arg_string(&args, "workspaceId")?).await?),
        "write_editor_file" => to_value(crate::commands::editor_commands::write_editor_file(arg_string(&args, "path")?, arg_string(&args, "content")?).await?),
        "write_query_cache" => {
            crate::commands::system_commands::write_query_cache(arg_string(&args, "key")?, arg_string(&args, "value")?).await?;
            Ok(Value::Null)
        }

        // ============ data domains: slack / local-llm / feedback / conductor ============
        "activate_local_llm_model" => to_value(crate::commands::local_llm_commands::activate_local_llm_model(app.clone(), arg_string(&args, "entryId")?).await?),
        "cancel_local_llm_download" => {
            crate::commands::local_llm_commands::cancel_local_llm_download(app.state::<crate::downloads::DownloadsManager>(), arg_string(&args, "entryId")?).await?;
            Ok(Value::Null)
        }
        "conductor_source_available" => to_value(crate::commands::conductor_commands::conductor_source_available()),
        "create_helmor_issue" => to_value(crate::commands::feedback_commands::create_helmor_issue(arg_string(&args, "title")?, arg_string(&args, "body")?).await?),
        "detect_local_llm_hardware" => to_value(crate::commands::local_llm_commands::detect_local_llm_hardware().await?),
        "find_existing_helmor_repo" => to_value(crate::commands::feedback_commands::find_existing_helmor_repo().await?),
        "fork_helmor_upstream" => to_value(crate::commands::feedback_commands::fork_helmor_upstream().await?),
        "get_local_llm_endpoint" => to_value(crate::commands::local_llm_commands::get_local_llm_endpoint(app.state::<crate::local_llm::Manager>()).await?),
        "get_local_llm_status" => to_value(crate::commands::local_llm_commands::get_local_llm_status(app.state::<crate::local_llm::Manager>()).await?),
        "import_conductor_workspaces" => to_value(crate::commands::conductor_commands::import_conductor_workspaces(app.clone(), arg_json(&args, "workspaceIds")?).await?),
        "inspect_local_llm_catalog_entry" => to_value(crate::commands::local_llm_commands::inspect_local_llm_catalog_entry(arg_string(&args, "entryId")?).await?),
        "inspect_local_llm_model" => to_value(crate::commands::local_llm_commands::inspect_local_llm_model(arg_string(&args, "path")?).await?),
        "list_conductor_repos" => to_value(crate::commands::conductor_commands::list_conductor_repos().await?),
        "list_conductor_workspaces" => to_value(crate::commands::conductor_commands::list_conductor_workspaces(arg_string(&args, "repoId")?).await?),
        "list_local_llm_catalog" => to_value(crate::commands::local_llm_commands::list_local_llm_catalog().await?),
        "list_local_llm_downloads" => to_value(crate::commands::local_llm_commands::list_local_llm_downloads(app.state::<crate::downloads::DownloadsManager>()).await?),
        "pause_local_llm_download" => {
            crate::commands::local_llm_commands::pause_local_llm_download(app.state::<crate::downloads::DownloadsManager>(), arg_string(&args, "entryId")?).await?;
            Ok(Value::Null)
        }
        "set_local_llm_context_override" => to_value(crate::commands::local_llm_commands::set_local_llm_context_override(app.clone(), arg_string(&args, "entryId")?, arg_int(&args, "contextTokens")?).await?),
        "slack_disconnect_workspace" => {
            crate::commands::slack_commands::slack_disconnect_workspace(app.clone(), arg_string(&args, "teamId")?).await?;
            Ok(Value::Null)
        }
        "slack_get_thread_detail" => to_value(crate::commands::slack_commands::slack_get_thread_detail(app.clone(), arg_string(&args, "teamId")?, arg_string(&args, "channelId")?, arg_opt_string(&args, "threadTs"), arg_string(&args, "anchorTs")?).await?),
        "slack_import_from_desktop" => to_value(crate::commands::slack_commands::slack_import_from_desktop(app.clone()).await?),
        "slack_list_inbox_items" => to_value(crate::commands::slack_commands::slack_list_inbox_items(app.clone(), arg_string(&args, "teamId")?, arg_opt_string(&args, "cursor"), arg_opt_int(&args, "limit")).await?),
        "slack_list_workspaces" => to_value(crate::commands::slack_commands::slack_list_workspaces().await?),
        "slack_search_messages" => to_value(crate::commands::slack_commands::slack_search_messages(app.clone(), arg_string(&args, "teamId")?, arg_string(&args, "query")?, arg_opt_json(&args, "sort")?, arg_opt_string(&args, "cursor"), arg_opt_int(&args, "limit")).await?),
        "start_local_llm" => to_value(crate::commands::local_llm_commands::start_local_llm(app.clone()).await?),
        "start_local_llm_download" => {
            crate::commands::local_llm_commands::start_local_llm_download(app.clone(), arg_string(&args, "entryId")?).await?;
            Ok(Value::Null)
        }
        "stop_local_llm" => {
            crate::commands::local_llm_commands::stop_local_llm(app.clone()).await?;
            Ok(Value::Null)
        }

        // ============ desktop-only / destructive: no-op for a phone ============
        // Companion self-management: a paired browser does not administer the
        // companion server (enable/pair/sign-in happen on the desktop host).
        "companion_allocate_stable_url"
        |         "companion_destroy_stable_url"
        |         "companion_disable"
        |         "companion_enable"
        |         "companion_list_devices"
        |         "companion_pair_device"
        |         "companion_revoke_device"
        |         "companion_sign_in_cloudflare"
        |         "companion_status"
        // PTY control over HTTP is meaningless (no terminal on the phone); the
        // matching spawn_* commands carry a Channel and route to /rpc-stream.
        |         "resize_terminal"
        |         "stop_terminal"
        |         "write_terminal_stdin"
        // SSE drop already auto-unsubscribes; the explicit call is a redundant
        // best-effort cleanup.
        |         "unsubscribe_ui_mutations"
        |         "copy_image_to_clipboard"
        |         "dev_reset_all_data"
        |         "enter_mini_window_mode"
        |         "enter_onboarding_window_mode"
        |         "exit_mini_window_mode"
        |         "exit_onboarding_window_mode"
        |         "install_cli"
        |         "install_helmor_skills"
        |         "open_agent_login_terminal"
        |         "open_file_in_editor"
        |         "open_workspace_in_editor"
        |         "open_workspace_in_finder"
        |         "request_quit"
        |         "resize_agent_login_terminal"
        |         "resize_forge_cli_auth_terminal"
        |         "resize_repo_script"
        |         "reveal_path_in_finder"
        |         "show_image_in_finder"
        // Quick-panel window management exists only on the desktop host.
        |         "toggle_quick_panel"
        |         "hide_quick_panel"
        |         "reveal_workspace_in_main_window"
        |         "stop_agent_login_terminal"
        |         "stop_forge_cli_auth_terminal"
        |         "stop_repo_script"
        |         "sync_global_hotkey"
        |         "toggle_mini_window_mode"
        |         "write_agent_login_terminal_stdin"
        |         "write_forge_cli_auth_terminal_stdin"
        |         "write_repo_script_stdin" => Ok(Value::Null),

        other => Err(anyhow::anyhow!("Unknown companion command: {other}").into()),
    }
}

fn to_value<T: Serialize>(value: T) -> Result<Value, CommandError> {
    serde_json::to_value(value).map_err(|e| anyhow::anyhow!(e).into())
}

/// Extract a required string argument from the JSON body.
fn arg_string(args: &Value, key: &str) -> Result<String, CommandError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("Missing required argument: {key}").into())
}

/// Extract an optional string argument (absent or JSON `null` → `None`).
fn arg_opt_string(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Extract a required unsigned integer argument, coerced to the target width.
fn arg_int<T>(args: &Value, key: &str) -> Result<T, CommandError>
where
    T: TryFrom<u64>,
{
    let n = args
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("Missing required argument: {key}"))?;
    T::try_from(n).map_err(|_| anyhow::anyhow!("Argument {key} out of range").into())
}

/// Extract an optional unsigned integer argument, coerced to the target width.
fn arg_opt_int<T>(args: &Value, key: &str) -> Option<T>
where
    T: TryFrom<u64>,
{
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|n| T::try_from(n).ok())
}

/// Extract a required boolean argument.
fn arg_bool(args: &Value, key: &str) -> Result<bool, CommandError> {
    args.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow::anyhow!("Missing required argument: {key}").into())
}

/// Extract an optional boolean argument.
fn arg_opt_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

/// Deserialize a required JSON argument into `T` (for struct / `Vec` / enum args).
fn arg_json<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, CommandError> {
    let value = args
        .get(key)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Missing required argument: {key}"))?;
    serde_json::from_value(value).map_err(|e| anyhow::anyhow!("Invalid argument {key}: {e}").into())
}

/// Deserialize an optional JSON argument (absent or `null` → `None`).
fn arg_opt_json<T: serde::de::DeserializeOwned>(
    args: &Value,
    key: &str,
) -> Result<Option<T>, CommandError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|e| anyhow::anyhow!("Invalid argument {key}: {e}").into()),
    }
}

/// Whether a `settings` key carries a credential we must never hand to a paired
/// device. Matches an explicit list (keys whose JSON *value* embeds a secret)
/// plus a name pattern catching future `*api_key*` / `*token*` / `*secret*`
/// keys. Errs toward over-redaction — a paired phone configures none of these.
fn is_secret_setting_key(key: &str) -> bool {
    const EXPLICIT: &[&str] = &[
        "app.cursor_provider",         // { apiKey, ... }
        "app.claude_custom_providers", // [{ apiKey, ... }]
        "app.agent_proxy",             // proxy credentials
        "app.companion_stable_url",    // registry revocation secret
    ];
    if EXPLICIT.contains(&key) {
        return true;
    }
    let lower = key.to_ascii_lowercase();
    lower.contains("api_key") || lower.contains("token") || lower.contains("secret")
}

#[cfg(test)]
mod tests {
    use super::is_secret_setting_key;

    #[test]
    fn redacts_credential_keys() {
        for key in [
            "app.openai_realtime_api_key",
            "app.cursor_provider",
            "app.claude_custom_providers",
            "app.agent_proxy",
            "app.companion_stable_url",
            "app.some_future_token",
            "app.x_secret",
        ] {
            assert!(is_secret_setting_key(key), "{key} should be redacted");
        }
    }

    #[test]
    fn keeps_non_secret_keys() {
        for key in [
            "app.default_model_id",
            "app.onboarding_completed",
            "app.theme",
            "app.claude_rate_limits",
            "app.codex_rate_limits",
        ] {
            assert!(!is_secret_setting_key(key), "{key} should be kept");
        }
    }
}
