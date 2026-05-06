// Minimum set of IPC command responses needed to boot the Helmor React shell
// in a browser without a Rust backend.
//
// Mirrors the switch in src/test/setup.ts — keep them in sync when the boot
// path adds new `invoke` calls. E2E specs should extend via overrides, not
// edit this file.

export type InvokeHandler = (args?: unknown) => unknown | Promise<unknown>;

export const defaultInvokeHandlers: Record<string, InvokeHandler> = {
	list_repositories: () => [],
	list_workspace_groups: () => [],
	list_archived_workspaces: () => [],
	list_agent_model_sections: () => [],
	get_add_repository_defaults: () => ({ lastCloneDirectory: null }),
	get_data_info: () => null,
	get_cli_status: () => ({
		installed: false,
		installPath: null,
		buildMode: "development",
		installState: "missing",
	}),
	get_helmor_skills_status: () => ({
		installed: false,
		claude: false,
		codex: false,
		command:
			"npx --yes skills add dohooo/helmor/.codex/skills/helmor-cli -g -s helmor-cli -y --copy -a claude-code -a codex",
	}),
	get_app_settings: () => ({}),
	load_auto_close_action_kinds: () => [],
	load_auto_close_opt_in_asked: () => [],
	list_remote_branches: () => [],
	list_workspace_files: () => [],
	list_workspace_changes_with_content: () => ({ items: [], prefetched: [] }),
	list_slash_commands: () => [],
	list_github_labels: () => [],
	refresh_workspace_change_request: () => null,
	get_workspace_forge: () => ({
		provider: "unknown",
		host: null,
		namespace: null,
		repo: null,
		remoteUrl: null,
		labels: {
			providerName: "Forge",
			cliName: "CLI",
			changeRequestName: "PR",
			changeRequestFullName: "change request",
			connectAction: "Connect Forge",
		},
		detectionSignals: [],
	}),
	list_forge_logins: () => [],
	get_workspace_git_action_status: () => ({
		uncommittedCount: 0,
		conflictCount: 0,
		syncTargetBranch: null,
		syncStatus: "unknown",
		behindTargetCount: 0,
		aheadOfRemoteCount: 0,
		remoteTrackingRef: null,
		pushStatus: "unknown",
	}),
	get_workspace_forge_action_status: () => ({
		changeRequest: null,
		reviewDecision: null,
		mergeable: null,
		deployments: [],
		checks: [],
		remoteState: "unavailable",
		message: null,
	}),
	get_workspace_forge_check_insert_text: () => "",
	spawn_forge_cli_auth_terminal: () => undefined,
	stop_forge_cli_auth_terminal: () => false,
	write_forge_cli_auth_terminal_stdin: () => false,
	resize_forge_cli_auth_terminal: () => false,
	drain_pending_cli_sends: () => [],
	conductor_source_available: () => false,
	detect_installed_editors: () => [],
};

type Overrides = Record<string, InvokeHandler>;

declare global {
	interface Window {
		__HELMOR_E2E__?: {
			invokeOverrides?: Overrides;
		};
	}
}

export async function runInvoke(
	command: string,
	args?: unknown,
): Promise<unknown> {
	const overrides = globalThis.window?.__HELMOR_E2E__?.invokeOverrides;
	const handler = overrides?.[command] ?? defaultInvokeHandlers[command];
	if (!handler) {
		// Unknown commands are a common footgun — log once so devs notice
		// missing stubs instead of chasing a silent `undefined`.
		console.warn(`[helmor-e2e] unstubbed invoke: ${command}`, args);
		return undefined;
	}
	return await handler(args);
}
