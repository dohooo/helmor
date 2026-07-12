/**
 * R3-A wake-intent registry: the single source of truth classifying EVERY
 * frontend `invoke()` command by what it is allowed to cost when the transport
 * points at the team cloud sandbox.
 *
 * Failure polarity is the whole point: new code is born FREE. A command that
 * is not classified here fails `command-classes.test.ts` at PR time, and an
 * unclassified command that somehow reaches the wire is treated as PASSIVE
 * (never wakes, never renews). Spending money requires an explicit WAKE entry.
 *
 * Classes:
 * - LOCAL_ONLY     — always runs on THIS Mac's Tauri backend, even in team
 *                    mode (routing decision, see `LOCAL_ONLY_COMMANDS` use in
 *                    ipc.ts). Mirrors + supersedes the old LOCAL_ONLY_INVOKES.
 * - CONTROL_PLANE  — answered by the Worker/D1/TeamHub without the container
 *                    (team-mode branches in api.ts, D1 model-catalog cache,
 *                    the shared /v1/ws / /v1/stream event plane). Wire
 *                    behavior equals PASSIVE (no wake header); the class
 *                    exists so the audit surface stays honest.
 * - WAKE           — explicit "do work" actions allowed to cold-start the
 *                    container and renew its idle timer (X-Helmor-Wake-Intent).
 * - PASSIVE        — observation + micro-writes. Forwarded while the container
 *                    is awake (without renewing); answered with a typed
 *                    `ContainerAsleep` while it sleeps. Watching is free.
 */
export type CommandClass = "LOCAL_ONLY" | "CONTROL_PLANE" | "WAKE" | "PASSIVE";

export const COMMAND_CLASSES: Record<string, CommandClass> = {
	// ---------------------------------------------------------------------
	// LOCAL_ONLY — desktop-host commands (keep reasons in ipc.ts history;
	// the classification here is the routing source of truth).
	// ---------------------------------------------------------------------
	authorize_cloud_codex_identity: "LOCAL_ONLY",
	authorize_cloud_claude_identity: "LOCAL_ONLY",
	authorize_cloud_forge_identity: "LOCAL_ONLY",
	deploy_team_cloud: "LOCAL_ONLY",
	list_team_containers: "LOCAL_ONLY",
	delete_team_container: "LOCAL_ONLY",
	debug_list_terminal_buffers: "LOCAL_ONLY",
	debug_read_terminal_buffer: "LOCAL_ONLY",
	list_forge_accounts: "LOCAL_ONLY",
	cache_forge_avatar: "LOCAL_ONLY",
	save_pasted_image: "LOCAL_ONLY",
	convert_historical_records: "LOCAL_ONLY",
	read_query_cache: "LOCAL_ONLY",
	write_query_cache: "LOCAL_ONLY",
	delete_query_cache: "LOCAL_ONLY",
	get_local_llm_status: "LOCAL_ONLY",
	start_local_llm: "LOCAL_ONLY",
	stop_local_llm: "LOCAL_ONLY",
	list_local_llm_catalog: "LOCAL_ONLY",
	inspect_local_llm_model: "LOCAL_ONLY",
	detect_local_llm_hardware: "LOCAL_ONLY",
	list_local_llm_downloads: "LOCAL_ONLY",
	start_local_llm_download: "LOCAL_ONLY",
	cancel_local_llm_download: "LOCAL_ONLY",
	get_local_llm_endpoint: "LOCAL_ONLY",
	set_local_llm_context_override: "LOCAL_ONLY",
	activate_local_llm_model: "LOCAL_ONLY",
	inspect_local_llm_catalog_entry: "LOCAL_ONLY",
	pause_local_llm_download: "LOCAL_ONLY",
	subscribe_local_llm_downloads: "LOCAL_ONLY",
	// R3-A: editors are installed on THIS Mac — detecting them inside the
	// cloud container answered the wrong question (and woke the sandbox on
	// every boot). P1-2b delisted it from the companion dispatcher too.
	detect_installed_editors: "LOCAL_ONLY",
	// P1-2b: an arbitrary-absolute-path write whose safety model is the LOCAL
	// save dialog — and in team mode the user wants the download on THEIR Mac,
	// not inside the container. LOCAL_ONLY both closes the remote write and
	// makes "Download as CSV/Markdown" actually land locally. Delisted from
	// the companion dispatcher too (companion/rpc.rs).
	save_text_file_as: "LOCAL_ONLY",

	// DF-R6-D: desktop-host interactive-auth PTYs. Each runs a macOS-local
	// process whose effect exists only on THIS Mac — the `gh|glab auth login`
	// OAuth callback to localhost, `claude|codex login` driving the Mac browser
	// + desktop main window, and `security add-generic-password` writing the
	// macOS login keychain. Misclassified as WAKE/PASSIVE they routed to the team
	// container (spawn → "Unknown companion command"; the control verbs silently
	// no-op'd), so "Connect GitHub" couldn't start. In team mode they must run on
	// the local Tauri host, like the cloud-identity authorizers above. The spawn_*
	// verbs carry a Channel<ScriptEvent>; ipc.ts bridges the team-mode
	// CompanionChannel back to a native Channel so the PTY still streams. NB: the
	// workspace `terminal` / `repo_script` families deliberately stay WAKE — those
	// genuinely run inside the container where the workspace lives, so LOCAL_ONLY
	// would misroute container work to the desktop.
	spawn_forge_cli_auth_terminal: "LOCAL_ONLY",
	stop_forge_cli_auth_terminal: "LOCAL_ONLY",
	write_forge_cli_auth_terminal_stdin: "LOCAL_ONLY",
	resize_forge_cli_auth_terminal: "LOCAL_ONLY",
	spawn_agent_login_terminal: "LOCAL_ONLY",
	open_agent_login_terminal: "LOCAL_ONLY",
	stop_agent_login_terminal: "LOCAL_ONLY",
	write_agent_login_terminal_stdin: "LOCAL_ONLY",
	resize_agent_login_terminal: "LOCAL_ONLY",
	spawn_keychain_store_terminal: "LOCAL_ONLY",
	stop_keychain_store_terminal: "LOCAL_ONLY",
	write_keychain_store_terminal_stdin: "LOCAL_ONLY",
	resize_keychain_store_terminal: "LOCAL_ONLY",

	// ---------------------------------------------------------------------
	// CONTROL_PLANE — served without the container in team mode.
	// ---------------------------------------------------------------------
	list_agent_model_sections: "CONTROL_PLANE", // WP5 D1 catalog cache
	list_workspace_sessions: "CONTROL_PLANE", // /team/sessions D1 mirror
	list_session_thread_messages: "CONTROL_PLANE", // /team/messages D1 mirror
	subscribe_ui_mutations: "CONTROL_PLANE", // rides /v1/ws (team) or /v1/stream
	unsubscribe_ui_mutations: "CONTROL_PLANE",

	// ---------------------------------------------------------------------
	// WAKE — explicit whitelist: user-initiated work that is ALLOWED to
	// cold-start the container and renew its idle timer. Adding an entry
	// here is a product decision — "this action is worth waking the sandbox".
	// ---------------------------------------------------------------------
	// Agent turns + turn control
	send_agent_message_stream: "WAKE",
	steer_agent_stream: "WAKE",
	stop_agent_stream: "WAKE",
	respond_to_permission_request: "WAKE",
	respond_to_user_input: "WAKE",
	mutate_codex_goal: "WAKE",
	post_room_chat_message: "WAKE",
	// Git / change-request writes
	push_workspace_to_remote: "WAKE",
	merge_workspace_change_request: "WAKE",
	close_workspace_change_request: "WAKE",
	continue_workspace_from_target_branch: "WAKE",
	sync_workspace_with_target_branch: "WAKE",
	update_intended_target_branch: "WAKE",
	create_and_checkout_branch: "WAKE",
	// Freshness fetch fired by browsing (workspace switch / app focus) — pure
	// observation in spirit, so it must never wake or renew a sleeping
	// container (R2-F6). Awake: forwarded and the fetch rides for free.
	// Asleep: typed ContainerAsleep, swallowed by the fire-and-forget caller.
	trigger_workspace_fetch: "PASSIVE",
	stage_workspace_file: "WAKE",
	unstage_workspace_file: "WAKE",
	discard_workspace_file: "WAKE",
	write_editor_file: "WAKE",
	// Repository / workspace lifecycle
	add_repository_from_local_path: "WAKE",
	clone_repository_from_url: "WAKE",
	delete_repository: "WAKE",
	update_repository_remote: "WAKE",
	update_repository_default_branch: "WAKE",
	update_repository_branch_prefix: "WAKE",
	create_workspace_from_repo: "WAKE",
	prepare_workspace_from_repo: "WAKE",
	finalize_workspace_from_repo: "WAKE",
	prepare_chat_workspace: "WAKE",
	complete_workspace_setup: "WAKE",
	rename_workspace: "WAKE",
	rename_workspace_branch: "WAKE",
	set_workspace_status: "WAKE",
	set_workspace_active_run_action: "WAKE",
	set_workspace_linked_directories: "WAKE",
	move_local_workspace_to_worktree: "WAKE",
	permanently_delete_workspace: "WAKE",
	prepare_archive_workspace: "WAKE",
	validate_archive_workspace: "WAKE",
	start_archive_workspace: "WAKE",
	validate_restore_workspace: "WAKE",
	restore_workspace: "WAKE",
	cleanup_archived_workspaces: "WAKE",
	// Session lifecycle (structural writes; the read-state micro-writes are
	// PASSIVE + queued instead — see ipc.ts asleep queue)
	create_session: "WAKE",
	delete_session: "WAKE",
	rename_session: "WAKE",
	hide_session: "WAKE",
	unhide_session: "WAKE",
	convert_session_to_terminal: "WAKE",
	update_session_settings: "WAKE",
	// Terminals / scripts / interactive PTYs (their output stream carries the
	// wake intent, so an OPEN terminal keeps the container alive while bytes
	// flow — and stops the moment it is closed)
	spawn_terminal: "WAKE",
	stop_terminal: "WAKE",
	write_terminal_stdin: "WAKE",
	execute_repo_script: "WAKE",
	execute_repo_stop_command: "WAKE",
	stop_repo_script: "WAKE",
	write_repo_script_stdin: "WAKE",
	// NB: the forge_cli_auth / agent_login / keychain_store terminal families are
	// LOCAL_ONLY (desktop-host auth PTYs) — see the DF-R6-D block above.
	// Settings / config writes (explicit, rare)
	update_app_settings: "WAKE",
	update_repo_scripts: "WAKE",
	update_repo_preferences: "WAKE",
	update_repo_auto_run_setup: "WAKE",
	create_repo_run_action: "WAKE",
	update_repo_run_action: "WAKE",
	delete_repo_run_action: "WAKE",
	reorder_repo_run_actions: "WAKE",
	save_auto_close_action_kinds: "WAKE",
	save_auto_close_opt_in_asked: "WAKE",
	upsert_custom_provider: "WAKE",
	remove_custom_provider: "WAKE",
	fetch_provider_models: "WAKE",
	// Forge auth / bindings (explicit settings flows)
	retry_repo_forge_binding: "WAKE",
	backfill_forge_repo_bindings: "WAKE",
	invalidate_forge_caches: "WAKE",
	// Desktop-tooling installs (explicit buttons; remote routing is a
	// pre-existing quirk, classification just preserves today's behavior)
	install_cli: "WAKE",
	install_helmor_skills: "WAKE",
	install_downloaded_app_update: "WAKE",
	// Companion server management (explicit Settings actions)
	companion_enable: "WAKE",
	companion_disable: "WAKE",
	companion_pair_device: "WAKE",
	companion_revoke_device: "WAKE",
	companion_sign_in_cloudflare: "WAKE",
	companion_allocate_stable_url: "WAKE",
	companion_destroy_stable_url: "WAKE",
	// Slack explicit actions
	slack_import_from_desktop: "WAKE",
	slack_disconnect_workspace: "WAKE",
	slack_prepare_thread_context: "WAKE",
	// Helmor issue-reporting flow (explicit dialog)
	fork_helmor_upstream: "WAKE",
	create_helmor_issue: "WAKE",
	find_existing_helmor_repo: "WAKE",
	// Dev-tools
	dev_reset_all_data: "WAKE",

	// ---------------------------------------------------------------------
	// PASSIVE — observation is free. Reads return stale data while the
	// sandbox sleeps; micro-writes queue (see ipc.ts) instead of waking.
	// ---------------------------------------------------------------------
	// Workspaces / sidebar
	list_workspace_groups: "PASSIVE",
	list_archived_workspaces: "PASSIVE",
	get_workspace: "PASSIVE",
	get_workspace_forge: "PASSIVE",
	list_workspace_changes: "PASSIVE",
	list_workspace_files: "PASSIVE",
	list_workspace_linked_directories: "PASSIVE",
	list_workspace_candidate_directories: "PASSIVE",
	list_repositories: "PASSIVE",
	list_repo_remotes: "PASSIVE",
	get_repo_current_branch: "PASSIVE",
	get_workspace_git_action_status: "PASSIVE",
	// Sidebar micro-writes (asleep → queued, never wake)
	mark_session_read: "PASSIVE",
	mark_session_unread: "PASSIVE",
	mark_workspace_unread: "PASSIVE",
	pin_workspace: "PASSIVE",
	unpin_workspace: "PASSIVE",
	move_workspace_in_sidebar: "PASSIVE",
	move_repository_in_sidebar: "PASSIVE",
	// Sessions / threads
	list_hidden_sessions: "PASSIVE",
	list_session_drafts: "PASSIVE",
	set_session_draft: "PASSIVE",
	list_active_streams: "PASSIVE",
	subscribe_session_stream: "PASSIVE", // the watch pipe: zero renew by design
	unsubscribe_session_stream: "PASSIVE",
	get_session_context_usage: "PASSIVE",
	set_session_context_usage: "PASSIVE",
	get_live_context_usage: "PASSIVE",
	get_session_codex_goal: "PASSIVE",
	get_session_plan_state: "PASSIVE",
	generate_session_title: "PASSIVE", // best-effort, runs while a turn holds the container awake
	drain_pending_cli_sends: "PASSIVE",
	report_presence: "PASSIVE", // ephemeral: dropped (not queued) while asleep
	// Rate limits / usage
	get_claude_rate_limits: "PASSIVE",
	get_codex_rate_limits: "PASSIVE",
	// Branch pickers (explicit opens, but observation: stale list while
	// asleep; the checkout itself is WAKE)
	list_remote_branches: "PASSIVE",
	list_branches_for_local_picker: "PASSIVE",
	list_branches_for_workspace_picker: "PASSIVE",
	prefetch_remote_refs: "PASSIVE",
	// Forge reads
	check_workspace_forge_auth: "PASSIVE",
	get_workspace_account_profile: "PASSIVE",
	get_workspace_forge_action_status: "PASSIVE",
	get_workspace_forge_check_insert_text: "PASSIVE",
	refresh_workspace_change_request: "PASSIVE",
	list_forge_logins: "PASSIVE",
	list_forge_labels: "PASSIVE",
	list_inbox_items: "PASSIVE",
	list_inbox_kind_labels: "PASSIVE",
	get_inbox_item_detail: "PASSIVE",
	// Editor file reads
	read_editor_file: "PASSIVE",
	stat_editor_file: "PASSIVE",
	list_editor_files: "PASSIVE",
	read_file_at_ref: "PASSIVE",
	// Models / providers (reads)
	list_all_agent_model_sections: "PASSIVE",
	list_provider_capabilities: "PASSIVE",
	list_custom_providers: "PASSIVE",
	list_cursor_models: "PASSIVE",
	list_opencode_models: "PASSIVE",
	get_kimi_provider_config: "PASSIVE",
	// Agent / app status reads
	get_agent_login_status: "PASSIVE",
	get_agent_versions: "PASSIVE",
	get_cli_status: "PASSIVE",
	get_helmor_skills_status: "PASSIVE",
	get_helmor_components_update_check: "PASSIVE",
	recheck_helmor_components: "PASSIVE",
	get_app_update_status: "PASSIVE",
	check_for_app_update: "PASSIVE",
	get_app_settings: "PASSIVE",
	get_data_info: "PASSIVE",
	companion_status: "PASSIVE",
	companion_list_devices: "PASSIVE",
	// Slash commands
	list_slash_commands: "PASSIVE",
	prewarm_slash_commands_for_workspace: "PASSIVE",
	prewarm_slash_commands_for_repo: "PASSIVE",
	// Slack reads
	slack_list_workspaces: "PASSIVE",
	slack_list_inbox_items: "PASSIVE",
	slack_search_messages: "PASSIVE",
	slack_get_thread_detail: "PASSIVE",
	slack_list_emoji: "PASSIVE",
	// Misc reads / desktop-side conveniences (remote routing is a no-op or a
	// pre-existing quirk; never worth a wake)
	load_repo_scripts: "PASSIVE",
	load_repo_preferences: "PASSIVE",
	load_auto_close_action_kinds: "PASSIVE",
	load_auto_close_opt_in_asked: "PASSIVE",
	get_add_repository_defaults: "PASSIVE",
	set_terminal_session_busy: "PASSIVE",
	resize_terminal: "PASSIVE",
	resize_repo_script: "PASSIVE",
	open_file_in_editor: "PASSIVE",
	open_workspace_in_editor: "PASSIVE",
	open_workspace_in_finder: "PASSIVE",
	reveal_path_in_finder: "PASSIVE",
	reveal_workspace_in_main_window: "PASSIVE",
	show_image_in_finder: "PASSIVE",
	copy_image_to_clipboard: "PASSIVE",
	// Window / app chrome (desktop concerns; remote dispatch no-ops)
	toggle_quick_panel: "PASSIVE",
	hide_quick_panel: "PASSIVE",
	sync_global_hotkey: "PASSIVE",
	enter_onboarding_window_mode: "PASSIVE",
	exit_onboarding_window_mode: "PASSIVE",
	enter_mini_window_mode: "PASSIVE",
	exit_mini_window_mode: "PASSIVE",
	toggle_mini_window_mode: "PASSIVE",
	request_quit: "PASSIVE",
};

/** Commands that must run on the local Tauri host even in team mode. */
export const LOCAL_ONLY_COMMANDS: ReadonlySet<string> = new Set(
	Object.entries(COMMAND_CLASSES)
		.filter(([, cls]) => cls === "LOCAL_ONLY")
		.map(([cmd]) => cmd),
);

/** True when `cmd` is allowed to wake the container / renew its idle timer. */
export function isWakeCommand(cmd: string): boolean {
	return COMMAND_CLASSES[cmd] === "WAKE";
}
