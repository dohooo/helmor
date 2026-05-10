import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { InspectorFileItem } from "./editor-session";
import { type ErrorCode, extractError } from "./errors";

export type GroupTone =
	| "pinned"
	| "done"
	| "review"
	| "progress"
	| "backlog"
	| "canceled";

/**
 * Mirror of the Rust `WorkspaceState` enum (`src-tauri/src/workspace/state.rs`).
 * Kept as a string literal union so existing `ws.state === "archived"` checks
 * keep working without runtime changes.
 */
export type WorkspaceState =
	| "initializing"
	| "setup_pending"
	| "ready"
	| "archived";

/**
 * Mirror of the Rust `WorkspaceStatus` enum
 * (`src-tauri/src/workspace/status.rs`). Drives the sidebar kanban
 * lanes and PR-driven auto-status transitions.
 */
export type WorkspaceStatus =
	| "in-progress"
	| "done"
	| "review"
	| "backlog"
	| "canceled";

/**
 * Mirror of the Rust `PrSyncState` enum
 * (`src-tauri/src/workspace/pr_sync.rs`). Cached on the workspace row so the
 * inspector can render the PR badge optimistically before the live forge
 * query returns.
 */
export type PrSyncState = "none" | "open" | "closed" | "merged";

/**
 * Mirror of the Rust `ActionKind` enum
 * (`src-tauri/src/agents/action_kind.rs`). Non-null when the session was
 * created as a one-off "action" dispatch from the inspector commit button.
 */
export type ActionKind =
	| "create-pr"
	| "review"
	| "commit-and-push"
	| "push"
	| "fix"
	| "resolve-conflicts"
	| "merge"
	| "open-pr"
	| "merged"
	| "closed";

export type WorkspaceRow = {
	id: string;
	title: string;
	avatar?: string;
	directoryName?: string;
	repoName?: string;
	repoIconSrc?: string | null;
	repoInitials?: string | null;
	state?: WorkspaceState;
	mode?: WorkspaceMode;
	hasUnread?: boolean;
	workspaceUnread?: number;
	unreadSessionCount?: number;
	status?: WorkspaceStatus;
	branch?: string | null;
	activeSessionId?: string | null;
	activeSessionTitle?: string | null;
	activeSessionAgentType?: string | null;
	activeSessionStatus?: string | null;
	/** "Primary" conversation = the non-hidden, non-action session in this
	 * workspace with the most messages (ties broken by recency). The
	 * meaningful long-running chat — distinct from `activeSession*` which
	 * may be a transient one-off action like create-pr. */
	primarySessionId?: string | null;
	primarySessionTitle?: string | null;
	primarySessionAgentType?: string | null;
	prTitle?: string | null;
	prSyncState?: PrSyncState;
	prUrl?: string | null;
	pinnedAt?: string | null;
	sessionCount?: number;
	messageCount?: number;
	/** ISO-8601 timestamp — present for rows coming from the backend; absent
	 * for ad-hoc optimistic rows that haven't been given one. */
	createdAt?: string;
	/** ISO-8601 timestamp — last DB-recorded change to the workspace. */
	updatedAt?: string;
	/** ISO-8601 timestamp — most recent user message across all sessions
	 * in this workspace. Null when the workspace has no user messages yet. */
	lastUserMessageAt?: string | null;
};

export type WorkspaceGroup = {
	id: string;
	label: string;
	tone: GroupTone;
	rows: WorkspaceRow[];
};

export type DataInfo = {
	dataMode: string;
	dataRoot: string;
	dbPath: string;
	archiveRoot: string;
};

export type AgentProvider = "claude" | "codex" | "cursor";

export type AgentModelOption = {
	id: string;
	provider: AgentProvider;
	label: string;
	cliModel: string;
	providerKey?: string | null;
	effortLevels?: string[];
	supportsFastMode?: boolean;
	supportsContextUsage?: boolean;
};

export type AgentModelSectionStatus = "ready" | "unavailable" | "error";

export type AgentModelSection = {
	id: string;
	label: string;
	status?: AgentModelSectionStatus;
	options: AgentModelOption[];
};

export type AgentSendRequest = {
	provider: AgentProvider;
	modelId: string;
	prompt: string;
	/** Hidden preamble prepended to `prompt` only on the wire to the agent
	 *  (e.g. the user's "general preferences"). Persisted user-prompt
	 *  content keeps `prompt` only — the prefix never enters the DB or
	 *  the chat bubble. */
	promptPrefix?: string | null;
	sessionId?: string | null;
	helmorSessionId?: string | null;
	workingDirectory?: string | null;
	effortLevel?: string | null;
	permissionMode?: string | null;
	fastMode?: boolean | null;
	userMessageId?: string | null;
	/** Workspace-relative paths from the @-mention picker. */
	files?: string[] | null;
	/** Image attachment paths from the composer (drag-and-drop or
	 *  paste). Travels alongside `prompt` so the sidecar can lift the
	 *  matching `@<path>` substrings out as image attachments without
	 *  re-parsing the text — paths may contain whitespace. */
	images?: string[] | null;
};

export type WorkspaceSummary = {
	id: string;
	title: string;
	directoryName: string;
	repoName: string;
	repoIconSrc?: string | null;
	repoInitials?: string | null;
	state: WorkspaceState;
	mode?: WorkspaceMode;
	hasUnread: boolean;
	workspaceUnread: number;
	unreadSessionCount: number;
	status: WorkspaceStatus;
	branch?: string | null;
	activeSessionId?: string | null;
	activeSessionTitle?: string | null;
	activeSessionAgentType?: string | null;
	activeSessionStatus?: string | null;
	primarySessionId?: string | null;
	primarySessionTitle?: string | null;
	primarySessionAgentType?: string | null;
	prTitle?: string | null;
	prSyncState?: PrSyncState;
	prUrl?: string | null;
	pinnedAt?: string | null;
	sessionCount?: number;
	messageCount?: number;
	createdAt: string;
	updatedAt?: string;
	lastUserMessageAt?: string | null;
};

export type BranchPrefixType = "username" | "custom" | "none";

export type RepositoryCreateOption = {
	id: string;
	name: string;
	remote?: string | null;
	remoteUrl?: string | null;
	defaultBranch?: string | null;
	/** Per-repo branch prefix mode. NULL is treated as "github" by the
	 * backend resolver — keeps legacy rows behaving as before. */
	branchPrefixType?: BranchPrefixType | null;
	branchPrefixCustom?: string | null;
	forgeProvider?: ForgeProvider | null;
	/** gh/glab account login bound to this repo, or null when none had
	 * access at add-time. UI shows a "Connect" prompt when null. */
	forgeLogin?: string | null;
	repoIconSrc?: string | null;
	repoInitials?: string | null;
};

export type AddRepositoryDefaults = {
	lastCloneDirectory?: string | null;
};

/** A single gh / glab account with display profile attached. Listed
 * by `listForgeAccounts` for the Settings → Account panel. */
export type ForgeAccount = {
	provider: ForgeProvider;
	host: string;
	login: string;
	name?: string | null;
	avatarUrl?: string | null;
	email?: string | null;
	/** True for the gh account currently marked active by `gh auth
	 * switch`. Always true for GitLab (one account per host). */
	active: boolean;
};

export type ForgeProvider = "github" | "gitlab" | "unknown";

export type ForgeLabels = {
	providerName: string;
	cliName: string;
	changeRequestName: string;
	changeRequestFullName: string;
	connectAction: string;
};

export type ForgeDetectionSignal = {
	/** Layer that produced this signal (wellKnownHost, hostPattern, urlPath, repoFile, httpProbe, cliProbe). */
	layer: string;
	/** Short human-readable explanation shown in the UI tooltip. */
	detail: string;
};

export type ForgeDetection = {
	provider: ForgeProvider;
	host?: string | null;
	namespace?: string | null;
	repo?: string | null;
	remoteUrl?: string | null;
	labels: ForgeLabels;
	/**
	 * Signals that caused the current provider classification. Empty when
	 * the provider is `unknown` or when the result came from the cached
	 * `forge_provider` column (stored at repo-creation time).
	 */
	detectionSignals: ForgeDetectionSignal[];
};

export type AddRepositoryResponse = {
	repositoryId: string;
	createdRepository: boolean;
	/**
	 * `string` only when the repo was already in the DB and has a visible
	 * workspace — UI focuses it. `null` for newly-added repos and re-adds
	 * with only archived workspaces — UI lands on the start page with this
	 * repo selected.
	 */
	selectedWorkspaceId: string | null;
};

export type WorkspaceDetail = {
	id: string;
	title: string;
	repoId: string;
	repoName: string;
	repoIconSrc?: string | null;
	repoInitials?: string | null;
	remote?: string | null;
	remoteUrl?: string | null;
	defaultBranch?: string | null;
	rootPath?: string | null;
	directoryName: string;
	state: WorkspaceState;
	hasUnread: boolean;
	workspaceUnread: number;
	unreadSessionCount: number;
	status: WorkspaceStatus;
	activeSessionId?: string | null;
	activeSessionTitle?: string | null;
	activeSessionAgentType?: string | null;
	activeSessionStatus?: string | null;
	branch?: string | null;
	initializationParentBranch?: string | null;
	intendedTargetBranch?: string | null;
	mode: WorkspaceMode;
	pinnedAt?: string | null;
	prTitle?: string | null;
	prSyncState?: PrSyncState;
	prUrl?: string | null;
	archiveCommit?: string | null;
	sessionCount: number;
	messageCount: number;
	forgeProvider?: ForgeProvider | null;
	/** gh/glab account login bound to the parent repo. NULL means no
	 * account is bound — UI shows the "Connect" prompt. */
	forgeLogin?: string | null;
	/** Set when this workspace's setup script last finished with exit
	 * code 0. NULL means never run (or skipped because the repo had no
	 * setup script). Drives the inspector's Setup tab "ran in another
	 * session" notice and the default-tab heuristic on workspace switch. */
	setupCompletedAt?: string | null;
};

export type WorkspaceSessionSummary = {
	id: string;
	workspaceId: string;
	title: string;
	agentType?: string | null;
	status: string;
	model?: string | null;
	permissionMode: string;
	providerSessionId?: string | null;
	effortLevel?: string | null;
	unreadCount: number;
	fastMode: boolean;
	createdAt: string;
	updatedAt: string;
	lastUserMessageAt?: string | null;
	isHidden: boolean;
	/** Set when the session was created as a one-off dispatch from the
	 * inspector commit button (e.g. "create-pr", "commit-and-push"). Drives
	 * post-stream verifiers and auto-close behavior. */
	actionKind?: ActionKind | null;
	active: boolean;
};

export type RestoreWorkspaceResponse = {
	restoredWorkspaceId: string;
	restoredState: WorkspaceState;
	selectedWorkspaceId: string;
	/** Set when the originally archived branch was already taken at restore
	 * time and the workspace was checked out on a `-vN`-suffixed branch
	 * instead. The frontend uses this to surface an informational toast so
	 * the rename never happens silently. */
	branchRename: { original: string; actual: string } | null;
	restoredFromTargetBranch: string | null;
};

export type ArchiveWorkspaceResponse = {
	archivedWorkspaceId: string;
	archivedState: WorkspaceState;
};

export type PrepareArchiveWorkspaceResponse = {
	workspaceId: string;
};

export type ArchiveExecutionFailedPayload = {
	workspaceId: string;
	code: ErrorCode;
	message: string;
};

export type ArchiveExecutionSucceededPayload = {
	workspaceId: string;
};

export type CreateWorkspaceResponse = {
	createdWorkspaceId: string;
	selectedWorkspaceId: string;
	initialSessionId: string;
	createdState: WorkspaceState;
	directoryName: string;
	branch: string;
};

export type PrepareWorkspaceResponse = {
	workspaceId: string;
	initialSessionId: string;
	repoId: string;
	repoName: string;
	directoryName: string;
	branch: string;
	defaultBranch: string;
	state: WorkspaceState;
	repoScripts: RepoScripts;
	/** CWD the agent CLI must run in. Local mode: filled with `repo.root_path`
	 *  immediately. Worktree mode: null until finalize materialises the
	 *  worktree — callers MUST then read `FinalizeWorkspaceResponse.workingDirectory`. */
	workingDirectory: string | null;
};

export type FinalizeWorkspaceResponse = {
	workspaceId: string;
	finalState: WorkspaceState;
	/** CWD the agent CLI must run in. Always populated when finalize succeeds. */
	workingDirectory: string;
};

export type MarkWorkspaceReadResponse = undefined;

export type EditorFileReadResponse = {
	path: string;
	content: string;
	mtimeMs: number;
};

export type EditorFileWriteResponse = {
	path: string;
	mtimeMs: number;
};

export type EditorFileStatResponse = {
	path: string;
	exists: boolean;
	isFile: boolean;
	mtimeMs: number | null;
	size: number | null;
};

export type EditorFilePrefetchItem = {
	absolutePath: string;
	content: string;
};

export type EditorFilesWithContentResponse = {
	items: InspectorFileItem[];
	prefetched: EditorFilePrefetchItem[];
};

export type AppUpdateStage =
	| "disabled"
	| "idle"
	| "checking"
	| "downloading"
	| "downloaded"
	| "installing"
	| "error";

export type AppUpdateInfo = {
	currentVersion: string;
	version: string;
	body?: string | null;
	date?: string | null;
	releaseUrl: string;
};

export type AppUpdateProgress = {
	downloaded: number;
	total?: number | null;
};

export type AppUpdateStatus = {
	stage: AppUpdateStage;
	configured: boolean;
	autoUpdateEnabled: boolean;
	update?: AppUpdateInfo | null;
	lastError?: string | null;
	lastAttemptAt?: string | null;
	downloadedAt?: string | null;
	progress?: AppUpdateProgress | null;
};

const DEFAULT_WORKSPACE_GROUPS: WorkspaceGroup[] = [
	{ id: "done", label: "Done", tone: "done", rows: [] },
	{ id: "review", label: "In review", tone: "review", rows: [] },
	{ id: "progress", label: "In progress", tone: "progress", rows: [] },
	{ id: "backlog", label: "Backlog", tone: "backlog", rows: [] },
	{ id: "canceled", label: "Canceled", tone: "canceled", rows: [] },
];

export async function loadWorkspaceGroups(): Promise<WorkspaceGroup[]> {
	try {
		return await invoke<WorkspaceGroup[]>("list_workspace_groups");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load workspace groups."),
		);
	}
}

/**
 * Re-run the per-repo forge auto-bind. Frontend calls this after the
 * user finishes a `gh auth login` / `glab auth login` flow so the repo
 * picks up the new account without an app restart. Returns the bound
 * login (or `null` when no logged-in account had access).
 */
export async function retryRepoForgeBinding(
	repoId: string,
): Promise<string | null> {
	return invoke<string | null>("retry_repo_forge_binding", { repoId });
}

export async function getWorkspaceForge(
	workspaceId: string,
): Promise<ForgeDetection> {
	try {
		return await invoke<ForgeDetection>("get_workspace_forge", { workspaceId });
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load workspace forge."),
		);
	}
}

/** Enumerate all gh accounts plus one glab account per known host.
 * `gitlabHosts` is the list of GitLab hosts to probe (gathered from the
 * repos table — we don't shell out to glab for hosts the user isn't
 * actively using). */
export async function listForgeAccounts(
	gitlabHosts: string[],
): Promise<ForgeAccount[]> {
	try {
		return await invoke<ForgeAccount[]>("list_forge_accounts", {
			gitlabHosts,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to list forge accounts."),
		);
	}
}

/** Spot-fetch the gh/glab account bound to a workspace's parent repo,
 * with display profile (avatar / name / email). Returns null when the
 * repo has no resolvable forge account. Backed by the same per-process
 * cache that `listForgeAccounts` populates. */
export async function getWorkspaceAccountProfile(
	workspaceId: string,
): Promise<ForgeAccount | null> {
	try {
		return await invoke<ForgeAccount | null>("get_workspace_account_profile", {
			workspaceId,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load workspace account profile."),
		);
	}
}

/** Download a forge avatar URL into the local on-disk cache and return
 * the absolute filesystem path. Idempotent: repeated calls with the
 * same URL hit the cache. Pair with `convertFileSrc` to render via the
 * `asset://` protocol so page navigations don't re-fetch + re-decode. */
export async function cacheForgeAvatar(url: string): Promise<string> {
	try {
		return await invoke<string>("cache_forge_avatar", { url });
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to cache avatar."));
	}
}

/** Lightweight login-only enumeration for `(provider, host)`. Used by
 * the auth-terminal completion poll: take a snapshot before opening the
 * terminal, then poll until the set grows. Skips the per-account
 * profile fetch that `listForgeAccounts` does, so the poll loop stays
 * cheap. */
export async function listForgeLogins(
	provider: ForgeProvider,
	host: string,
	options: { forceRefresh?: boolean } = {},
): Promise<string[]> {
	try {
		return await invoke<string[]>("list_forge_logins", {
			provider,
			host,
			forceRefresh: options.forceRefresh ?? false,
		});
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to list forge logins."));
	}
}

/** Re-run auto-bind for every repo whose `forge_login` is still NULL.
 * Triggered after Settings → Account adds a fresh CLI login so legacy
 * repos pick up the new credentials without an app restart. Returns the
 * count of repos that ended up newly bound on this sweep. */
export async function backfillForgeRepoBindings(): Promise<number> {
	try {
		return await invoke<number>("backfill_forge_repo_bindings");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to backfill forge bindings."),
		);
	}
}

export async function spawnForgeCliAuthTerminal(
	provider: ForgeProvider,
	host: string | null,
	instanceId: string,
	onEvent: (event: ScriptEvent) => void,
): Promise<void> {
	const channel = new Channel<ScriptEvent>();
	channel.onmessage = onEvent;
	await invoke("spawn_forge_cli_auth_terminal", {
		provider,
		host,
		instanceId,
		channel,
	});
}

export async function stopForgeCliAuthTerminal(
	provider: ForgeProvider,
	host: string | null,
	instanceId: string,
): Promise<boolean> {
	return invoke<boolean>("stop_forge_cli_auth_terminal", {
		provider,
		host,
		instanceId,
	});
}

/** Drop the per-process forge caches (login enumeration, status pairs,
 * profile) for `(provider, host)` so the very next `listForgeLogins`
 * poll bypasses the rate-limiter cache. Call this immediately after
 * the auth terminal exits. */
export async function invalidateForgeCaches(
	provider: ForgeProvider,
	host: string | null,
): Promise<void> {
	try {
		await invoke<void>("invalidate_forge_caches", { provider, host });
	} catch {
		// Best-effort: stale cache only delays detection by the cache TTL.
	}
}

export async function writeForgeCliAuthTerminalStdin(
	provider: ForgeProvider,
	host: string | null,
	instanceId: string,
	data: string,
): Promise<boolean> {
	return invoke<boolean>("write_forge_cli_auth_terminal_stdin", {
		provider,
		host,
		instanceId,
		data,
	});
}

export async function resizeForgeCliAuthTerminal(
	provider: ForgeProvider,
	host: string | null,
	instanceId: string,
	cols: number,
	rows: number,
): Promise<boolean> {
	return invoke<boolean>("resize_forge_cli_auth_terminal", {
		provider,
		host,
		instanceId,
		cols,
		rows,
	});
}

export async function loadDataInfo(): Promise<DataInfo | null> {
	try {
		return await invoke<DataInfo>("get_data_info");
	} catch {
		return null;
	}
}

export type CliStatus = {
	installed: boolean;
	installPath: string | null;
	buildMode: string;
	installState: "missing" | "managed" | "stale";
};

export async function getCliStatus(): Promise<CliStatus> {
	return await invoke<CliStatus>("get_cli_status");
}

export type HelmorSkillsStatus = {
	installed: boolean;
	claude: boolean;
	codex: boolean;
	command: string;
};

export async function getHelmorSkillsStatus(): Promise<HelmorSkillsStatus> {
	try {
		return await invoke<HelmorSkillsStatus>("get_helmor_skills_status");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load Helmor skills status."),
		);
	}
}

export async function getAppUpdateStatus(): Promise<AppUpdateStatus> {
	return invoke<AppUpdateStatus>("get_app_update_status");
}

export async function checkForAppUpdate(
	force = false,
): Promise<AppUpdateStatus> {
	return invoke<AppUpdateStatus>("check_for_app_update", { force });
}

export async function installDownloadedAppUpdate(): Promise<AppUpdateStatus> {
	return invoke<AppUpdateStatus>("install_downloaded_app_update");
}

export async function syncGlobalHotkey(hotkey: string | null): Promise<void> {
	try {
		await invoke<void>("sync_global_hotkey", { hotkey });
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to set global hotkey."));
	}
}

export async function listenAppUpdateStatus(
	callback: (payload: AppUpdateStatus) => void,
): Promise<UnlistenFn> {
	return listen<AppUpdateStatus>("app-update-status", (event) =>
		callback(event.payload),
	);
}

export async function installCli(): Promise<CliStatus> {
	return await invoke<CliStatus>("install_cli");
}

export async function installHelmorSkills(): Promise<HelmorSkillsStatus> {
	try {
		return await invoke<HelmorSkillsStatus>("install_helmor_skills");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to install Helmor skills."),
		);
	}
}

export async function enterOnboardingWindowMode(): Promise<void> {
	await invoke("enter_onboarding_window_mode");
}

export async function exitOnboardingWindowMode(): Promise<void> {
	await invoke("exit_onboarding_window_mode");
}

export type AgentLoginProvider = "claude" | "codex" | "cursor";

export type AgentLoginStatusResult = {
	claude: boolean;
	codex: boolean;
	cursor: boolean;
};

export async function getAgentLoginStatus(): Promise<AgentLoginStatusResult> {
	return await invoke<AgentLoginStatusResult>("get_agent_login_status");
}

export async function openAgentLoginTerminal(
	provider: AgentLoginProvider,
): Promise<void> {
	await invoke("open_agent_login_terminal", { provider });
}

export async function spawnAgentLoginTerminal(
	provider: AgentLoginProvider,
	instanceId: string,
	onEvent: (event: ScriptEvent) => void,
): Promise<void> {
	const channel = new Channel<ScriptEvent>();
	channel.onmessage = onEvent;
	await invoke("spawn_agent_login_terminal", {
		provider,
		instanceId,
		channel,
	});
}

export async function stopAgentLoginTerminal(
	provider: AgentLoginProvider,
	instanceId: string,
): Promise<boolean> {
	return invoke<boolean>("stop_agent_login_terminal", {
		provider,
		instanceId,
	});
}

export async function writeAgentLoginTerminalStdin(
	provider: AgentLoginProvider,
	instanceId: string,
	data: string,
): Promise<boolean> {
	return invoke<boolean>("write_agent_login_terminal_stdin", {
		provider,
		instanceId,
		data,
	});
}

export async function resizeAgentLoginTerminal(
	provider: AgentLoginProvider,
	instanceId: string,
	cols: number,
	rows: number,
): Promise<boolean> {
	return invoke<boolean>("resize_agent_login_terminal", {
		provider,
		instanceId,
		cols,
		rows,
	});
}

export type DevResetResult = {
	reposDeleted: number;
	workspacesDeleted: number;
	sessionsDeleted: number;
	messagesDeleted: number;
	directoriesRemoved: string[];
};

export async function requestQuit(force: boolean): Promise<void> {
	return await invoke("request_quit", { force });
}

export async function devResetAllData(): Promise<DevResetResult> {
	return await invoke<DevResetResult>("dev_reset_all_data");
}

export async function loadArchivedWorkspaces(): Promise<WorkspaceSummary[]> {
	try {
		return await invoke<WorkspaceSummary[]>("list_archived_workspaces");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load archived workspaces."),
		);
	}
}

export async function listRepositories(): Promise<RepositoryCreateOption[]> {
	try {
		return await invoke<RepositoryCreateOption[]>("list_repositories");
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to load repositories."));
	}
}

export async function deleteRepository(repoId: string): Promise<void> {
	await invoke<void>("delete_repository", { repoId });
}

export type UpdateRepositoryRemoteResponse = {
	orphanedWorkspaceCount: number;
};

export async function updateRepositoryRemote(
	repoId: string,
	remote: string,
): Promise<UpdateRepositoryRemoteResponse> {
	return invoke<UpdateRepositoryRemoteResponse>("update_repository_remote", {
		repoId,
		remote,
	});
}

export async function listRepoRemotes(repoId: string): Promise<string[]> {
	try {
		return await invoke<string[]>("list_repo_remotes", { repoId });
	} catch {
		return [];
	}
}

export async function updateRepositoryDefaultBranch(
	repoId: string,
	defaultBranch: string,
): Promise<void> {
	await invoke<void>("update_repository_default_branch", {
		repoId,
		defaultBranch,
	});
}

export async function updateRepositoryBranchPrefix(
	repoId: string,
	branchPrefixType: BranchPrefixType | null,
	branchPrefixCustom: string | null,
): Promise<void> {
	await invoke<void>("update_repository_branch_prefix", {
		repoId,
		branchPrefixType,
		branchPrefixCustom,
	});
}

export async function loadAddRepositoryDefaults(): Promise<AddRepositoryDefaults> {
	try {
		return await invoke<AddRepositoryDefaults>("get_add_repository_defaults");
	} catch {
		return { lastCloneDirectory: null };
	}
}

export async function loadAgentModelSections(): Promise<AgentModelSection[]> {
	try {
		return await invoke<AgentModelSection[]>("list_agent_model_sections");
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to load agent models."));
	}
}

export type CursorModelParameterValue = {
	value: string;
	displayName?: string;
};

export type CursorModelParameter = {
	id: string;
	displayName?: string;
	values: CursorModelParameterValue[];
};

export type CursorModelEntry = {
	id: string;
	label: string;
	/** Raw `parameters[]` — persisted into `cursorProvider.cachedModels`. */
	parameters?: CursorModelParameter[];
};

/// Live `Cursor.models.list` via sidecar. Optional `apiKey` overrides
/// the stored key for one-off probes (e.g. onboarding validation).
export async function listCursorModels(
	apiKey?: string,
): Promise<CursorModelEntry[]> {
	try {
		return await invoke<CursorModelEntry[]>("list_cursor_models", {
			apiKey: apiKey ?? null,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to list Cursor models."),
		);
	}
}

// ---------------------------------------------------------------------------
// Inbox (kanban-mode left sidebar)
// ---------------------------------------------------------------------------

export type InboxItemSource =
	| "github_issue"
	| "github_pr"
	| "github_discussion"
	| "gitlab_issue"
	| "gitlab_mr";

export type InboxItemStateTone =
	| "open"
	| "closed"
	| "merged"
	| "draft"
	| "answered"
	| "unanswered"
	| "urgent"
	| "neutral";

export type InboxItem = {
	id: string;
	source: InboxItemSource;
	externalId: string;
	externalUrl: string;
	title: string;
	subtitle?: string | null;
	state?: { label: string; tone: InboxItemStateTone } | null;
	lastActivityAt: number;
};

export type InboxItemDetailRef = {
	provider: Extract<ForgeProvider, "github" | "gitlab">;
	login: string;
	/** Host the item lives on. Critical for self-hosted GitLab where a
	 *  login may have accounts on multiple instances — without this the
	 *  detail call could route to the wrong host and 404. */
	host?: string | null;
	source: InboxItemSource;
	externalId: string;
};

export type GitHubIssueDetail = {
	externalId: string;
	title: string;
	body?: string | null;
	url: string;
	state: string;
	stateReason?: string | null;
	authorLogin?: string | null;
	createdAt?: string | null;
	updatedAt?: string | null;
	closedAt?: string | null;
};

export type GitHubPullRequestDetail = {
	externalId: string;
	title: string;
	body?: string | null;
	url: string;
	state: string;
	merged: boolean;
	draft: boolean;
	authorLogin?: string | null;
	baseRefName?: string | null;
	headRefName?: string | null;
	createdAt?: string | null;
	updatedAt?: string | null;
};

export type GitHubDiscussionDetail = {
	externalId: string;
	title: string;
	body?: string | null;
	url: string;
	answered?: boolean | null;
	authorLogin?: string | null;
	categoryName?: string | null;
	categoryEmoji?: string | null;
	createdAt?: string | null;
	updatedAt?: string | null;
};

export type GitLabIssueDetail = {
	externalId: string;
	title: string;
	body?: string | null;
	url: string;
	state: string;
	authorLogin?: string | null;
	createdAt?: string | null;
	updatedAt?: string | null;
	closedAt?: string | null;
};

export type GitLabMergeRequestDetail = {
	externalId: string;
	title: string;
	body?: string | null;
	url: string;
	state: string;
	merged: boolean;
	draft: boolean;
	authorLogin?: string | null;
	sourceBranch?: string | null;
	targetBranch?: string | null;
	createdAt?: string | null;
	updatedAt?: string | null;
};

export type InboxItemDetail =
	| { type: "github_issue"; data: GitHubIssueDetail }
	| { type: "github_pr"; data: GitHubPullRequestDetail }
	| { type: "github_discussion"; data: GitHubDiscussionDetail }
	| { type: "gitlab_issue"; data: GitLabIssueDetail }
	| { type: "gitlab_mr"; data: GitLabMergeRequestDetail };

export type InboxPage = {
	items: InboxItem[];
	/** Opaque cursor — pass back verbatim to fetch the next page. `null`
	 * when there are no more pages from any enabled source. */
	nextCursor: string | null;
};

/** Sub-tab the inbox is showing. The Tauri command takes one kind per
 *  call; the frontend maps each tab onto a separate React-Query so
 *  switching tabs reuses the prior cached pages. */
export type InboxKind = "issues" | "prs" | "discussions";

export type InboxStateFilter =
	| "open"
	| "closed"
	| "merged"
	| "all"
	| "answered"
	| "unanswered";

export type InboxScopeFilter =
	| "involves"
	| "assigned"
	| "mentioned"
	| "created"
	| "author"
	| "assignee"
	| "mentions"
	| "reviewRequested"
	| "reviewedBy"
	| "all";

export type InboxSortFilter = "updated" | "created" | "comments";
export type InboxDraftFilter = "exclude" | "include" | "only";

export type InboxFilters = {
	query?: string | null;
	state?: InboxStateFilter | null;
	scope?: InboxScopeFilter[] | null;
	sort?: InboxSortFilter | null;
	draft?: InboxDraftFilter | null;
	labels?: string | null;
};

/** Repo-scoped label, shared between GitHub and GitLab — both forges
 *  expose `(name, color, description)` triples on their labels API. */
export type ForgeLabelOption = {
	name: string;
	color?: string | null;
	description?: string | null;
};

/** Union of labels visible across the given repositories. Powers the
 *  Settings → Context labels multi-select. `host` is required for
 *  self-hosted GitLab; ignored by GitHub today. */
export async function listForgeLabels(args: {
	provider: ForgeProvider;
	login: string;
	host?: string | null;
	repos: string[];
}): Promise<ForgeLabelOption[]> {
	try {
		return await invoke<ForgeLabelOption[]>("list_forge_labels", {
			provider: args.provider,
			login: args.login,
			host: args.host ?? null,
			repos: args.repos,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load repository labels."),
		);
	}
}

export async function listInboxItems(args: {
	provider: ForgeProvider;
	/** Sub-tab kind. Pass one at a time — the backend dispatches via
	 *  per-kind trait methods. Asking GitLab for "discussions" panics
	 *  via Rust's `unimplemented!()` (it's a router bug); callers must
	 *  consult `listSupportedInboxKinds(provider)` first. */
	kind: InboxKind;
	login: string;
	/** Host the API call should target. Required for self-hosted GitLab
	 *  to avoid querying `gitlab.com` for projects that live elsewhere.
	 *  When `null`, the backend falls back to the login's home host
	 *  (correct for the single-host "involves @me" global feed). */
	host?: string | null;
	cursor?: string | null;
	limit?: number;
	/** `owner/name` (GitHub) or `group/.../project` (GitLab) — scopes
	 *  the query to one repo on the backend. */
	repo?: string | null;
	filters?: InboxFilters | null;
}): Promise<InboxPage> {
	try {
		return await invoke<InboxPage>("list_inbox_items", {
			provider: args.provider,
			kind: args.kind,
			login: args.login,
			host: args.host ?? null,
			cursor: args.cursor ?? null,
			limit: args.limit ?? 20,
			repo: args.repo ?? null,
			filters: args.filters ?? null,
		});
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to load inbox items."));
	}
}

/** User-facing labels for one inbox kind, scoped to a forge.
 *
 *  All inbox copy that differs between GitHub and GitLab ("PR" vs
 *  "MR", "Pull requests" vs "Merge requests", GitHub-only Discussions
 *  entry, …) lives in these structs on the backend. The frontend
 *  renders strings from the fields directly — no provider-branched
 *  copy in TypeScript. */
export type InboxKindLabels = {
	kind: InboxKind;
	/** Short title-cased form for sub-tab dropdown items
	 *  ("Issues", "PRs", "MRs", "Discussions"). */
	short: string;
	/** Title-cased plural for empty-state titles and section headers
	 *  ("Issues", "Pull requests", "Merge requests", "Discussions"). */
	plural: string;
	/** Lowercase singular for inline mentions ("issue", "pull request",
	 *  "merge request", "discussion"). */
	singular: string;
};

/** Inbox kinds the forge supports + their labels. The set is also the
 *  capability gate — kinds NOT in the response don't have a backend
 *  implementation (e.g. GitLab omits Discussions because GitLab has no
 *  equivalent feature, and `listInboxItems(gitlab, discussions)` would
 *  panic via `unimplemented!()`). */
export async function listInboxKindLabels(
	provider: ForgeProvider,
): Promise<InboxKindLabels[]> {
	try {
		return await invoke<InboxKindLabels[]>("list_inbox_kind_labels", {
			provider,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load inbox kind labels."),
		);
	}
}

export async function getInboxItemDetail(
	ref: InboxItemDetailRef,
): Promise<InboxItemDetail | null> {
	try {
		return await invoke<InboxItemDetail | null>("get_inbox_item_detail", {
			provider: ref.provider,
			login: ref.login,
			host: ref.host ?? null,
			source: ref.source,
			externalId: ref.externalId,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load inbox item details."),
		);
	}
}

export type SlashCommandEntry = {
	name: string;
	description: string;
	argumentHint?: string | null;
	providers?: AgentProvider[] | null;
	/**
	 * - `builtin` / `skill`: command is forwarded to the agent SDK as text.
	 * - `client-action`: selecting the entry runs a host-app handler instead
	 *   of inserting `/<name>` into the prompt (e.g. `/add-dir` opens the
	 *   link-directories dialog).
	 */
	source: "builtin" | "skill" | "client-action";
};

export type SlashCommandsResponse = {
	commands: SlashCommandEntry[];
};

/**
 * Fetch the slash commands the composer popup should display for the given
 * provider + workspace.
 *
 * The Rust backend returns local skills instantly from a disk scan and
 * refreshes the backend cache from the sidecar in the background.
 */
export async function listSlashCommands(input: {
	provider: AgentProvider;
	workingDirectory?: string | null;
	repoId?: string | null;
	workspaceId?: string | null;
}): Promise<SlashCommandsResponse> {
	try {
		return await invoke<SlashCommandsResponse>("list_slash_commands", {
			request: {
				provider: input.provider,
				workingDirectory: input.workingDirectory ?? null,
				repoId: input.repoId ?? null,
				workspaceId: input.workspaceId ?? null,
			},
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load slash commands."),
		);
	}
}

/** Fire-and-forget: prewarm the backend slash-command cache for a workspace. */
export async function prewarmSlashCommandsForWorkspace(
	workspaceId: string,
): Promise<void> {
	try {
		await invoke<void>("prewarm_slash_commands_for_workspace", {
			workspaceId,
		});
	} catch {
		// Best-effort; cache will still be populated lazily on first /.
	}
}

/** Fire-and-forget: prewarm the slash-command cache for a repo (start page). */
export async function prewarmSlashCommandsForRepo(
	repoId: string,
): Promise<void> {
	try {
		await invoke<void>("prewarm_slash_commands_for_repo", {
			repoId,
		});
	} catch {
		// Best-effort; cache will still be populated lazily on first /.
	}
}

export async function loadWorkspaceDetail(
	workspaceId: string,
): Promise<WorkspaceDetail | null> {
	try {
		return await invoke<WorkspaceDetail>("get_workspace", { workspaceId });
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load workspace detail."),
		);
	}
}

export async function listRemoteBranches(opts: {
	workspaceId?: string;
	repoId?: string;
}): Promise<string[]> {
	try {
		return await invoke<string[]>("list_remote_branches", opts);
	} catch (error) {
		console.warn("[helmor] listRemoteBranches failed:", error);
		return [];
	}
}

/**
 * Current HEAD branch of the repo's local working directory. Used by
 * the start page in local mode to default the picker to the branch
 * the user is currently on. `null` when the repo path is missing or
 * HEAD is detached.
 */
export async function getRepoCurrentBranch(
	repoId: string,
): Promise<string | null> {
	try {
		return await invoke<string | null>("get_repo_current_branch", {
			repoId,
		});
	} catch (error) {
		console.warn("[helmor] getRepoCurrentBranch failed:", error);
		return null;
	}
}

/**
 * Merged local + remote branches for the local-mode start picker.
 * Deduped by name, alphabetical. Worktree mode still uses
 * `listRemoteBranches` (remote-only).
 */
export async function listBranchesForLocalPicker(
	repoId: string,
): Promise<string[]> {
	try {
		return await invoke<string[]>("list_branches_for_local_picker", {
			repoId,
		});
	} catch (error) {
		console.warn("[helmor] listBranchesForLocalPicker failed:", error);
		return [];
	}
}

/**
 * `git checkout -b <branch>` against the repo's source path. Caller is
 * responsible for refreshing whatever query feeds the branch picker.
 */
export async function createAndCheckoutBranch(
	repoId: string,
	branch: string,
): Promise<void> {
	await invoke("create_and_checkout_branch", { repoId, branch });
}

export type MoveLocalToWorktreeResponse = {
	workspaceId: string;
	directoryName: string;
	branch: string;
	state: WorkspaceState;
};

/**
 * Move a local-mode workspace into a fresh worktree (relocation, not a
 * clone — the workspace's mode flips Local → Worktree, same id). The
 * new worktree gets an auto-named branch with the local repo's
 * current state (tracked + untracked) carried over. The local repo
 * itself is not modified.
 */
export async function moveLocalWorkspaceToWorktree(
	workspaceId: string,
): Promise<MoveLocalToWorktreeResponse> {
	return invoke<MoveLocalToWorktreeResponse>(
		"move_local_workspace_to_worktree",
		{ workspaceId },
	);
}

/** How a workspace's filesystem is provisioned. */
export type WorkspaceMode = "worktree" | "local";

export type UpdateIntendedTargetBranchResponse = {
	/** True if the workspace's local branch was hard-reset to origin/<target>. */
	reset: boolean;
	targetBranch: string;
};

export async function updateIntendedTargetBranch(
	workspaceId: string,
	targetBranch: string,
): Promise<UpdateIntendedTargetBranchResponse> {
	return invoke<UpdateIntendedTargetBranchResponse>(
		"update_intended_target_branch",
		{
			workspaceId,
			targetBranch,
		},
	);
}

// --- Linked directories (/add-dir) ---

/**
 * Read the workspace's `/add-dir` list. Empty array when the user hasn't
 * linked anything yet.
 */
export async function listWorkspaceLinkedDirectories(
	workspaceId: string,
): Promise<string[]> {
	try {
		return await invoke<string[]>("list_workspace_linked_directories", {
			workspaceId,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load linked directories."),
		);
	}
}

/**
 * Persist the workspace's linked directories. The backend trims + dedupes
 * and returns the canonical list that was actually written — callers
 * should prefer the returned list over their local state.
 */
export async function setWorkspaceLinkedDirectories(
	workspaceId: string,
	directories: string[],
): Promise<string[]> {
	try {
		return await invoke<string[]>("set_workspace_linked_directories", {
			workspaceId,
			directories,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to save linked directories."),
		);
	}
}

/** Candidate entry shown in the `/add-dir` popup's quick-pick list. */
export type CandidateDirectory = {
	workspaceId: string;
	/** Human-readable workspace title, matches the sidebar row's label. */
	title: string;
	repoName: string;
	/** URL to the repo's icon (same source the sidebar avatar uses). */
	repoIconSrc: string | null;
	/** 2-char repo initials fallback when no icon is available. */
	repoInitials: string;
	branch: string | null;
	absolutePath: string;
};

/**
 * Every ready workspace (all repos, minus the currently-active one) as
 * suggestions for `/add-dir`. Empty array is valid — the picker still
 * offers Browse... as an escape hatch.
 */
export async function listWorkspaceCandidateDirectories(input: {
	excludeWorkspaceId?: string | null;
}): Promise<CandidateDirectory[]> {
	try {
		return await invoke<CandidateDirectory[]>(
			"list_workspace_candidate_directories",
			{ excludeWorkspaceId: input.excludeWorkspaceId ?? null },
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load workspace suggestions."),
		);
	}
}

// -- Git watcher events --

export type GitBranchChangedPayload = {
	workspaceId: string;
	oldBranch: string | null;
	newBranch: string | null;
};

export type GitRefsChangedPayload = {
	workspaceId: string;
};

export type UiMutationEvent =
	| { type: "workspaceListChanged" }
	| { type: "workspaceChanged"; workspaceId: string }
	| { type: "sessionListChanged"; workspaceId: string }
	| { type: "contextUsageChanged"; sessionId: string }
	| { type: "codexGoalChanged"; sessionId: string }
	| { type: "sessionMessagesAppended"; sessionId: string }
	| { type: "workspaceFilesChanged"; workspaceId: string }
	| { type: "workspaceGitStateChanged"; workspaceId: string }
	| { type: "workspaceForgeChanged"; workspaceId: string }
	| { type: "workspaceChangeRequestChanged"; workspaceId: string }
	| { type: "repositoryListChanged" }
	| { type: "repositoryChanged"; repoId: string }
	| { type: "settingsChanged"; key: string | null }
	| {
			type: "pendingCliSendQueued";
			workspaceId: string;
			sessionId: string;
			prompt: string;
			modelId: string | null;
			permissionMode: string | null;
	  }
	| { type: "activeStreamsChanged" };

export async function listenGitBranchChanged(
	callback: (payload: GitBranchChangedPayload) => void,
): Promise<UnlistenFn> {
	return listen<GitBranchChangedPayload>("git-branch-changed", (event) =>
		callback(event.payload),
	);
}

export async function listenGitRefsChanged(
	callback: (payload: GitRefsChangedPayload) => void,
): Promise<UnlistenFn> {
	return listen<GitRefsChangedPayload>("git-refs-changed", (event) =>
		callback(event.payload),
	);
}

export async function subscribeUiMutations(
	callback: (event: UiMutationEvent) => void,
): Promise<UnlistenFn> {
	const { Channel } = await import("@tauri-apps/api/core");
	const subscriptionId = crypto.randomUUID();
	const onEvent = new Channel<UiMutationEvent>();
	onEvent.onmessage = callback;
	await invoke("subscribe_ui_mutations", { subscriptionId, onEvent });
	return () => {
		onEvent.onmessage = () => {};
		void invoke("unsubscribe_ui_mutations", { subscriptionId });
	};
}

export type PrefetchRemoteRefsResponse = {
	/** True if a fetch was performed; false if the call was rate-limited. */
	fetched: boolean;
};

export async function prefetchRemoteRefs(opts: {
	workspaceId?: string;
	repoId?: string;
}): Promise<PrefetchRemoteRefsResponse> {
	return invoke<PrefetchRemoteRefsResponse>("prefetch_remote_refs", opts);
}

export async function loadWorkspaceSessions(
	workspaceId: string,
): Promise<WorkspaceSessionSummary[]> {
	try {
		return await invoke<WorkspaceSessionSummary[]>("list_workspace_sessions", {
			workspaceId,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load workspace sessions."),
		);
	}
}

/**
 * Load session messages as pipeline-rendered ThreadMessageLike[].
 * The frontend can render these directly without any conversion.
 */
export async function loadSessionThreadMessages(
	sessionId: string,
): Promise<ThreadMessageLike[]> {
	try {
		return await invoke<ThreadMessageLike[]>("list_session_thread_messages", {
			sessionId,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load session thread messages."),
		);
	}
}

export async function restoreWorkspace(
	workspaceId: string,
	targetBranchOverride?: string,
): Promise<RestoreWorkspaceResponse> {
	return invoke<RestoreWorkspaceResponse>("restore_workspace", {
		workspaceId,
		targetBranchOverride,
	});
}

export type TargetBranchConflict = {
	currentBranch: string;
	suggestedBranch: string;
	remote: string;
};

export type ValidateRestoreResponse = {
	targetBranchConflict?: TargetBranchConflict | null;
};

export async function validateRestoreWorkspace(
	workspaceId: string,
): Promise<ValidateRestoreResponse> {
	return invoke<ValidateRestoreResponse>("validate_restore_workspace", {
		workspaceId,
	});
}

export async function prepareArchiveWorkspace(
	workspaceId: string,
): Promise<PrepareArchiveWorkspaceResponse> {
	return invoke<PrepareArchiveWorkspaceResponse>("prepare_archive_workspace", {
		workspaceId,
	});
}

export async function startArchiveWorkspace(
	workspaceId: string,
): Promise<void> {
	await invoke<void>("start_archive_workspace", { workspaceId });
}

export async function validateArchiveWorkspace(
	workspaceId: string,
): Promise<PrepareArchiveWorkspaceResponse> {
	return invoke<PrepareArchiveWorkspaceResponse>("validate_archive_workspace", {
		workspaceId,
	});
}

export async function listenArchiveExecutionFailed(
	callback: (payload: ArchiveExecutionFailedPayload) => void,
): Promise<UnlistenFn> {
	return listen<ArchiveExecutionFailedPayload>(
		"archive-execution-failed",
		(event) => callback(event.payload),
	);
}

export async function listenArchiveExecutionSucceeded(
	callback: (payload: ArchiveExecutionSucceededPayload) => void,
): Promise<UnlistenFn> {
	return listen<ArchiveExecutionSucceededPayload>(
		"archive-execution-succeeded",
		(event) => callback(event.payload),
	);
}

export type DetectedEditor = {
	id: string;
	name: string;
	path: string;
};

export async function detectInstalledEditors(): Promise<DetectedEditor[]> {
	try {
		return (await invoke<DetectedEditor[]>("detect_installed_editors")) ?? [];
	} catch {
		return [];
	}
}

export async function openWorkspaceInEditor(
	workspaceId: string,
	editor: string,
): Promise<void> {
	await invoke("open_workspace_in_editor", { workspaceId, editor });
}

export async function openWorkspaceInFinder(
	workspaceId: string,
): Promise<void> {
	await invoke("open_workspace_in_finder", { workspaceId });
}

export async function readEditorFile(
	path: string,
): Promise<EditorFileReadResponse> {
	try {
		return await invoke<EditorFileReadResponse>("read_editor_file", { path });
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to open the selected file."),
		);
	}
}

export function triggerWorkspaceFetch(workspaceId: string): void {
	void invoke("trigger_workspace_fetch", { workspaceId });
}

export async function readFileAtRef(
	workspaceRootPath: string,
	filePath: string,
	gitRef: string,
): Promise<string | null> {
	return await invoke<string | null>("read_file_at_ref", {
		workspaceRootPath,
		filePath,
		gitRef,
	});
}

export async function writeEditorFile(
	path: string,
	content: string,
): Promise<EditorFileWriteResponse> {
	try {
		return await invoke<EditorFileWriteResponse>("write_editor_file", {
			path,
			content,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to save the selected file."),
		);
	}
}

export async function statEditorFile(
	path: string,
): Promise<EditorFileStatResponse> {
	try {
		return await invoke<EditorFileStatResponse>("stat_editor_file", { path });
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to inspect the selected file."),
		);
	}
}

export async function listEditorFiles(
	workspaceRootPath: string,
): Promise<InspectorFileItem[]> {
	try {
		return await invoke<InspectorFileItem[]>("list_editor_files", {
			workspaceRootPath,
		});
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to list editor files."));
	}
}

/**
 * Full workspace file listing for the @-mention picker. Walks the same skip
 * rules as `listEditorFiles` but without the 24-file cap. The result is
 * cached per workspace root via React Query and fuzzy-filtered in the frontend
 * as the user types.
 */
export async function listWorkspaceFiles(
	workspaceRootPath: string,
): Promise<InspectorFileItem[]> {
	try {
		return await invoke<InspectorFileItem[]>("list_workspace_files", {
			workspaceRootPath,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to list workspace files."),
		);
	}
}

export async function listEditorFilesWithContent(
	workspaceRootPath: string,
): Promise<EditorFilesWithContentResponse> {
	try {
		return await invoke<EditorFilesWithContentResponse>(
			"list_editor_files_with_content",
			{ workspaceRootPath },
		);
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to list editor files."));
	}
}

export async function listWorkspaceChangesWithContent(
	workspaceRootPath: string,
): Promise<EditorFilesWithContentResponse> {
	try {
		return await invoke<EditorFilesWithContentResponse>(
			"list_workspace_changes_with_content",
			{ workspaceRootPath },
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to list workspace changes."),
		);
	}
}

export async function discardWorkspaceFile(
	workspaceRootPath: string,
	relativePath: string,
): Promise<void> {
	try {
		await invoke<void>("discard_workspace_file", {
			workspaceRootPath,
			relativePath,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to discard workspace file."),
		);
	}
}

export async function stageWorkspaceFile(
	workspaceRootPath: string,
	relativePath: string,
): Promise<void> {
	try {
		await invoke<void>("stage_workspace_file", {
			workspaceRootPath,
			relativePath,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to stage workspace file."),
		);
	}
}

export async function unstageWorkspaceFile(
	workspaceRootPath: string,
	relativePath: string,
): Promise<void> {
	try {
		await invoke<void>("unstage_workspace_file", {
			workspaceRootPath,
			relativePath,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to unstage workspace file."),
		);
	}
}

export type ChangeRequestInfo = {
	url: string;
	number: number;
	state: "OPEN" | "CLOSED" | "MERGED" | string;
	title: string;
	isMerged: boolean;
};

export type ActionStatusKind = "success" | "pending" | "running" | "failure";
export type ActionProvider = "github" | "gitlab" | "vercel" | "unknown";
export type WorkspaceGitSyncStatus = "upToDate" | "behind" | "unknown";
export type WorkspacePushStatus = "published" | "unpublished" | "unknown";

export type WorkspaceGitActionStatus = {
	uncommittedCount: number;
	conflictCount: number;
	syncTargetBranch?: string | null;
	syncStatus: WorkspaceGitSyncStatus;
	behindTargetCount: number;
	remoteTrackingRef?: string | null;
	aheadOfRemoteCount: number;
	/** Commits this branch has on top of its target branch's remote ref
	 *  (e.g. `origin/main`). Stays accurate for unpublished branches —
	 *  unlike `aheadOfRemoteCount`, which reads as 0 without an upstream. */
	aheadOfTargetCount: number;
	pushStatus?: WorkspacePushStatus;
};

export type SyncWorkspaceTargetOutcome =
	| "updated"
	| "alreadyUpToDate"
	| "conflict"
	| "stashPopConflict";

export type SyncWorkspaceTargetResponse = {
	outcome: SyncWorkspaceTargetOutcome;
	targetBranch: string;
	conflictedFiles: string[];
};

export type PushWorkspaceToRemoteResponse = {
	targetRef: string;
	headCommit: string;
};

export type ContinueWorkspaceResponse = {
	branch: string;
	targetBranch: string;
	startPoint: string;
};

export type ForgeActionItem = {
	id: string;
	name: string;
	provider: ActionProvider;
	status: ActionStatusKind;
	duration?: string | null;
	url?: string | null;
};

export type ForgeActionStatus = {
	changeRequest: ChangeRequestInfo | null;
	reviewDecision?: string | null;
	mergeable?: string | null;
	deployments: ForgeActionItem[];
	checks: ForgeActionItem[];
	remoteState: "ok" | "noPr" | "unauthenticated" | "unavailable" | "error";
	message?: string | null;
};

export async function refreshWorkspaceChangeRequest(
	workspaceId: string,
): Promise<ChangeRequestInfo | null> {
	try {
		const result = await invoke<ChangeRequestInfo | null>(
			"refresh_workspace_change_request",
			{ workspaceId },
		);
		return result ?? null;
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to refresh change request."),
		);
	}
}

export async function loadWorkspaceGitActionStatus(
	workspaceId: string,
): Promise<WorkspaceGitActionStatus> {
	try {
		return await invoke<WorkspaceGitActionStatus>(
			"get_workspace_git_action_status",
			{ workspaceId },
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load workspace Git status."),
		);
	}
}

export async function syncWorkspaceWithTargetBranch(
	workspaceId: string,
): Promise<SyncWorkspaceTargetResponse> {
	try {
		return await invoke<SyncWorkspaceTargetResponse>(
			"sync_workspace_with_target_branch",
			{ workspaceId },
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to pull target branch updates."),
		);
	}
}

export async function pushWorkspaceToRemote(
	workspaceId: string,
): Promise<PushWorkspaceToRemoteResponse> {
	try {
		return await invoke<PushWorkspaceToRemoteResponse>(
			"push_workspace_to_remote",
			{ workspaceId },
		);
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to push branch."));
	}
}

export async function loadWorkspaceForgeActionStatus(
	workspaceId: string,
): Promise<ForgeActionStatus> {
	try {
		return await invoke<ForgeActionStatus>(
			"get_workspace_forge_action_status",
			{ workspaceId },
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load workspace forge status."),
		);
	}
}

export async function getWorkspaceForgeCheckInsertText(
	workspaceId: string,
	itemId: string,
): Promise<string> {
	try {
		return await invoke<string>("get_workspace_forge_check_insert_text", {
			workspaceId,
			itemId,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load check details."),
		);
	}
}

export async function mergeWorkspaceChangeRequest(
	workspaceId: string,
): Promise<ChangeRequestInfo | null> {
	try {
		return (
			(await invoke<ChangeRequestInfo | null>(
				"merge_workspace_change_request",
				{ workspaceId },
			)) ?? null
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to merge change request."),
		);
	}
}

export async function closeWorkspaceChangeRequest(
	workspaceId: string,
): Promise<ChangeRequestInfo | null> {
	try {
		return (
			(await invoke<ChangeRequestInfo | null>(
				"close_workspace_change_request",
				{ workspaceId },
			)) ?? null
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to close change request."),
		);
	}
}

export async function continueWorkspaceFromTargetBranch(
	workspaceId: string,
): Promise<ContinueWorkspaceResponse> {
	try {
		return await invoke<ContinueWorkspaceResponse>(
			"continue_workspace_from_target_branch",
			{ workspaceId },
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to continue workspace."),
		);
	}
}

// ---------------------------------------------------------------------------
// Pending CLI sends
// ---------------------------------------------------------------------------

export type PendingCliSend = {
	id: string;
	workspaceId: string;
	sessionId: string;
	prompt: string;
	modelId: string | null;
	permissionMode: string | null;
	createdAt: string;
};

/**
 * Atomically read and delete all pending CLI sends. Called on window focus
 * so the App can stream prompts that `helmor send` queued while the CLI
 * detected the App was running.
 */
export async function drainPendingCliSends(): Promise<PendingCliSend[]> {
	return invoke<PendingCliSend[]>("drain_pending_cli_sends");
}

export async function permanentlyDeleteWorkspace(
	workspaceId: string,
): Promise<void> {
	await invoke("permanently_delete_workspace", { workspaceId });
}

/**
 * List of action kinds the user has opted-in to auto-close. Action sessions
 * whose `actionKind` appears in this list are hidden automatically after
 * their verifier reports success.
 */
export async function loadAutoCloseActionKinds(): Promise<ActionKind[]> {
	try {
		return await invoke<ActionKind[]>("load_auto_close_action_kinds");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load auto-close settings."),
		);
	}
}

export async function saveAutoCloseActionKinds(
	kinds: ActionKind[],
): Promise<void> {
	try {
		await invoke<void>("save_auto_close_action_kinds", { kinds });
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to save auto-close settings."),
		);
	}
}

/**
 * Action kinds for which the first-time auto-close opt-in toast has already
 * been shown (whether or not the user opted in). Used to suppress repeat
 * prompts — separate from `loadAutoCloseActionKinds` so "dismissed" and
 * "enabled" are distinct states.
 */
export async function loadAutoCloseOptInAsked(): Promise<ActionKind[]> {
	try {
		return await invoke<ActionKind[]>("load_auto_close_opt_in_asked");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load auto-close opt-in history."),
		);
	}
}

export async function saveAutoCloseOptInAsked(
	kinds: ActionKind[],
): Promise<void> {
	try {
		await invoke<void>("save_auto_close_opt_in_asked", { kinds });
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to save auto-close opt-in history."),
		);
	}
}

export async function updateSessionSettings(
	sessionId: string,
	settings: {
		model?: string;
		effortLevel?: string;
		permissionMode?: string;
		fastMode?: boolean;
	},
): Promise<void> {
	await invoke("update_session_settings", {
		sessionId,
		model: settings.model ?? null,
		effortLevel: settings.effortLevel ?? null,
		permissionMode: settings.permissionMode ?? null,
		fastMode: settings.fastMode ?? null,
	});
}

export async function createWorkspaceFromRepo(
	repoId: string,
): Promise<CreateWorkspaceResponse> {
	return invoke<CreateWorkspaceResponse>("create_workspace_from_repo", {
		repoId,
	});
}

/**
 * Phase 1 of workspace creation. Fast (<20ms): validates the repo,
 * allocates a unique directory, computes the branch name, generates the
 * workspace + session UUIDs, inserts the `initializing` DB row + initial
 * session, and returns all metadata plus repo-level scripts. The
 * frontend paints with this response immediately — no placeholders.
 *
 * `sourceBranch` (optional): branch to branch the new workspace from. When
 * omitted, the repo's default branch is used. The kanban "create" flow
 * forwards the user's branch picker selection here.
 */
export async function prepareWorkspaceFromRepo(
	repoId: string,
	sourceBranch?: string | null,
	mode?: WorkspaceMode | null,
): Promise<PrepareWorkspaceResponse> {
	return invoke<PrepareWorkspaceResponse>("prepare_workspace_from_repo", {
		repoId,
		sourceBranch: sourceBranch ?? null,
		mode: mode ?? null,
	});
}

/**
 * Phase 2 of workspace creation. Slow (~200ms-2s): creates the git
 * worktree, probes `helmor.json`, and flips the
 * workspace row from `initializing` to `ready` / `setup_pending`. On
 * failure, the workspace row is cleaned up automatically.
 */
export async function finalizeWorkspaceFromRepo(
	workspaceId: string,
): Promise<FinalizeWorkspaceResponse> {
	return invoke<FinalizeWorkspaceResponse>("finalize_workspace_from_repo", {
		workspaceId,
	});
}

export async function completeWorkspaceSetup(
	workspaceId: string,
): Promise<void> {
	return invoke("complete_workspace_setup", { workspaceId });
}

export async function addRepositoryFromLocalPath(
	folderPath: string,
): Promise<AddRepositoryResponse> {
	return invoke<AddRepositoryResponse>("add_repository_from_local_path", {
		folderPath,
	});
}

export async function cloneRepositoryFromUrl(args: {
	gitUrl: string;
	cloneDirectory: string;
}): Promise<AddRepositoryResponse> {
	return invoke<AddRepositoryResponse>("clone_repository_from_url", args);
}

export async function markSessionRead(
	sessionId: string,
): Promise<MarkWorkspaceReadResponse> {
	return invoke<MarkWorkspaceReadResponse>("mark_session_read", {
		sessionId,
	});
}

export async function markSessionUnread(
	sessionId: string,
): Promise<MarkWorkspaceReadResponse> {
	return invoke<MarkWorkspaceReadResponse>("mark_session_unread", {
		sessionId,
	});
}

export async function markWorkspaceUnread(
	workspaceId: string,
): Promise<MarkWorkspaceReadResponse> {
	return invoke<MarkWorkspaceReadResponse>("mark_workspace_unread", {
		workspaceId,
	});
}

export async function pinWorkspace(workspaceId: string): Promise<void> {
	return invoke<void>("pin_workspace", { workspaceId });
}

export async function unpinWorkspace(workspaceId: string): Promise<void> {
	return invoke<void>("unpin_workspace", { workspaceId });
}

export async function setWorkspaceStatus(
	workspaceId: string,
	status: WorkspaceStatus,
): Promise<void> {
	return invoke<void>("set_workspace_status", { workspaceId, status });
}

// ---------------------------------------------------------------------------
// Streaming agent API
// ---------------------------------------------------------------------------

export type AgentStreamStartResponse = {
	streamId: string;
};

// ---------------------------------------------------------------------------
// Pipeline output types — match Rust pipeline::types serde output exactly
// ---------------------------------------------------------------------------

export type StreamingStatus =
	| "pending"
	| "streaming_input"
	| "running"
	| "done"
	| "error";

// Every part carries a stable `id` used as its React key. The Rust side
// mints it at the earliest sighting of the block (accumulator's
// `content_block_start` for Claude, `item.started` for Codex), serializes
// it as `__part_id` in the block JSON, and the adapter reads it back onto
// the typed part. `ToolCallPart` reuses its `toolCallId` (no separate `id`
// field — `tool-call.tsx` already keys on `toolCallId`); every other
// variant has its own `id`.
export type TextPart = { type: "text"; id: string; text: string };
export type ReasoningPart = {
	type: "reasoning";
	id: string;
	text: string;
	/**
	 * Live-streaming state. `true` = actively generating, `false` = just
	 * finished in the current live session (pipeline only sets this during
	 * streaming, never persists it), `undefined` = historical / unknown.
	 */
	streaming?: boolean;
	/** Backend-measured elapsed time for a completed reasoning block. */
	durationMs?: number;
};
export type ToolCallPart = {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	argsText: string;
	result?: unknown;
	isError?: boolean;
	streamingStatus?: StreamingStatus;
	/**
	 * Sub-agent work folded in by the Rust pipeline's grouping pass for
	 * `Task` / `Agent` tool calls. Empty / absent for normal tool calls
	 * (the Rust serializer skips it when empty).
	 */
	children?: ExtendedMessagePart[];
};
export type NoticeSeverity = "info" | "warning" | "error";
export type SystemNoticePart = {
	type: "system-notice";
	id: string;
	severity: NoticeSeverity;
	label: string;
	body?: string;
};
export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoItem = { text: string; status: TodoStatus };
export type TodoListPart = {
	type: "todo-list";
	id: string;
	items: TodoItem[];
};
export type ImageSource =
	| { kind: "base64"; data: string }
	| { kind: "url"; url: string }
	| { kind: "file"; path: string };
export type ImagePart = {
	type: "image";
	id: string;
	source: ImageSource;
	mediaType?: string;
};
export type PromptSuggestionPart = {
	type: "prompt-suggestion";
	id: string;
	text: string;
};
export type FileMentionPart = {
	type: "file-mention";
	id: string;
	path: string;
};
export type PlanReviewAllowedPrompt = {
	tool: string;
	prompt: string;
};
export type PlanReviewPart = {
	type: "plan-review";
	toolUseId: string;
	toolName: string;
	plan?: string | null;
	planFilePath?: string | null;
	allowedPrompts?: PlanReviewAllowedPrompt[];
};
export type MessagePart =
	| TextPart
	| ReasoningPart
	| ToolCallPart
	| SystemNoticePart
	| TodoListPart
	| ImagePart
	| PromptSuggestionPart
	| FileMentionPart
	| PlanReviewPart;

export type CollapsedGroupPart = {
	type: "collapsed-group";
	/** `group:{firstToolId}` — stable across streaming as tools accumulate. */
	id: string;
	category: "search" | "read" | "shell" | "mixed";
	tools: ToolCallPart[];
	active: boolean;
	summary: string;
};

/** Stable React key for any `ExtendedMessagePart`. Hides the fact that
 *  `ToolCallPart` uses `toolCallId` while other variants use `id`. */
export function partKey(part: ExtendedMessagePart): string {
	if (part.type === "tool-call") return part.toolCallId;
	if (part.type === "plan-review") return part.toolUseId;
	return part.id;
}

export type ExtendedMessagePart = MessagePart | CollapsedGroupPart;

/**
 * Mirror of the Rust `MessageRole` enum
 * (`src-tauri/src/pipeline/types.rs`). `"error"` exists in the DB but the
 * adapter rewrites error rows into `"system"` thread messages at render
 * time, so frontend components never observe it in practice.
 */
export type MessageRole = "assistant" | "system" | "user" | "error";

export type ThreadMessageLike = {
	role: MessageRole;
	id?: string;
	createdAt?: string;
	content: ExtendedMessagePart[];
	status?: { type: string; reason?: string };
	streaming?: boolean;
};

// ---------------------------------------------------------------------------
// Agent stream events
// ---------------------------------------------------------------------------

export type AgentStreamEvent =
	| {
			kind: "update";
			messages: ThreadMessageLike[];
	  }
	| {
			kind: "streamingPartial";
			message: ThreadMessageLike;
	  }
	| {
			kind: "done";
			provider: AgentProvider;
			modelId: string;
			resolvedModel: string;
			sessionId?: string | null;
			workingDirectory: string;
			persisted: boolean;
	  }
	| {
			kind: "aborted";
			provider: AgentProvider;
			modelId: string;
			resolvedModel: string;
			sessionId?: string | null;
			workingDirectory: string;
			persisted: boolean;
			reason: string;
	  }
	| {
			kind: "permissionRequest";
			permissionId: string;
			toolName: string;
			toolInput: Record<string, unknown>;
			title?: string | null;
			description?: string | null;
	  }
	| {
			kind: "userInputRequest";
			provider: AgentProvider;
			modelId: string;
			resolvedModel: string;
			sessionId?: string | null;
			workingDirectory: string;
			permissionMode?: string | null;
			userInputId: string;
			source: string;
			message: string;
			/** Discriminated by `payload.kind`:
			 *  - `ask-user-question` → Claude AskUserQuestion (raw multi-question / option / preview shape)
			 *  - `form` → JSON-Schema form (MCP form elicitation or Codex's synthesized form)
			 *  - `url` → URL launcher (MCP url-mode elicitation)
			 *  See `pending-user-input.ts` for the typed payload union. */
			payload: Record<string, unknown>;
	  }
	| { kind: "planCaptured" }
	| { kind: "error"; message: string; persisted: boolean; internal: boolean };

/**
 * Save a pasted clipboard image (base64) to a temp file and return its path.
 */
export async function savePastedImage(
	data: string,
	mediaType: string,
): Promise<string> {
	return invoke<string>("save_pasted_image", { data, mediaType });
}

/**
 * Write a UTF-8 string to an absolute path the user just picked from the
 * `plugin-dialog` Save dialog. Used by the chat-view table-download menu
 * (streamdown's built-in download relies on a synthetic `<a download>` click
 * that Tauri's webview ignores).
 */
export async function saveTextFileAs(
	path: string,
	contents: string,
): Promise<void> {
	await invoke("save_text_file_as", { path, contents });
}

export async function showImageInFinder(path: string): Promise<void> {
	await invoke("show_image_in_finder", { path });
}

export async function revealPathInFinder(path: string): Promise<void> {
	await invoke("reveal_path_in_finder", { path });
}

export async function copyImageToClipboard(path: string): Promise<void> {
	await invoke("copy_image_to_clipboard", { path });
}

/**
 * Start an agent message stream.
 *
 * Uses `ipc::Channel<T>` for point-to-point streaming so events emitted by
 * the backend are guaranteed to reach us (no race between `invoke` and a
 * global event listener).
 *
 * The returned promise resolves when the stream has been successfully handed
 * off. The callback continues to fire until a `done` or `error` event arrives.
 */
export async function startAgentMessageStream(
	request: AgentSendRequest,
	callback: (event: AgentStreamEvent) => void,
): Promise<void> {
	const { Channel } = await import("@tauri-apps/api/core");
	const onEvent = new Channel<AgentStreamEvent>();
	onEvent.onmessage = (event) => callback(event);
	await invoke("send_agent_message_stream", { request, onEvent });
}

export async function stopAgentStream(
	sessionId: string,
	provider?: string,
): Promise<void> {
	await invoke("stop_agent_stream", {
		request: { sessionId, provider: provider ?? null },
	});
}

/** UI projection of a registered, in-flight agent stream. Mirror of
 *  `agents::streaming::ActiveStreamSummary` on the Rust side. */
export type ActiveStreamSummary = {
	sessionId: string;
	workspaceId: string | null;
	provider: string;
};

/** Snapshot of currently in-flight agent streams. The frontend derives
 *  `busy / stoppable / busy-workspace` Sets from this list. Refetched
 *  whenever a `UiMutationEvent::ActiveStreamsChanged` lands via the
 *  ui-sync bridge. */
export async function listActiveStreams(): Promise<ActiveStreamSummary[]> {
	return await invoke<ActiveStreamSummary[]>("list_active_streams");
}

export type AgentSteerRequest = {
	sessionId: string;
	provider?: string;
	prompt: string;
	files?: string[];
	/** Image attachment paths — see `AgentSendRequest.images`. */
	images?: string[];
};

export type AgentSteerResponse = {
	accepted: boolean;
	reason?: string;
};

/**
 * Inject an additional user message into an in-flight agent turn.
 *
 * On `{ accepted: true }` the sidecar has confirmed provider acceptance
 * AND emitted a `user_prompt` passthrough event into the active stream,
 * which the accumulator places at the current streaming position and
 * `persist_turn_message` writes to the DB — no separate persistence path.
 *
 * On `{ accepted: false }` (turn already completed, provider rejected,
 * RPC timeout), the pipeline is untouched. Callers should surface the
 * rejection reason and restore the composer draft so the user can resend
 * — do NOT silently auto-open a fresh `startAgentMessageStream`.
 */
export async function steerAgentStream(
	request: AgentSteerRequest,
): Promise<AgentSteerResponse> {
	return await invoke<AgentSteerResponse>("steer_agent_stream", { request });
}

export async function respondToPermissionRequest(
	permissionId: string,
	behavior: "allow" | "deny",
	options?: {
		updatedPermissions?: unknown[];
		message?: string;
	},
): Promise<void> {
	await invoke("respond_to_permission_request", {
		request: {
			permissionId,
			behavior,
			updatedPermissions: options?.updatedPermissions ?? null,
			message: options?.message ?? null,
		},
	});
}

/**
 * Resolve a parked unified `userInputRequest`. The sidecar's pending
 * resolver closure (`canUseTool` for AskUserQuestion, `onElicitation`
 * for MCP, Codex's `requestUserInput` JSON-RPC handler) translates
 * this generic resolution into the matching SDK-specific shape.
 *
 * - `submit` → frontend produced a content payload (matched to whatever
 *   the matching renderer asks for: AUQ updatedInput, schema content
 *   map, or `{}` for url-mode).
 * - `decline` → user explicitly rejected; sidecar surfaces this as the
 *   provider's matching "deny" signal.
 * - `cancel` → user dismissed without answering; treated as cancel by
 *   each provider.
 */
export async function respondToUserInput(
	userInputId: string,
	action: "submit" | "decline" | "cancel",
	content?: Record<string, unknown> | null,
): Promise<void> {
	await invoke("respond_to_user_input", {
		request: {
			userInputId,
			action,
			content: content ?? null,
		},
	});
}

// ---------------------------------------------------------------------------
// Conductor import
// ---------------------------------------------------------------------------

export type ConductorRepo = {
	id: string;
	name: string;
	remoteUrl: string | null;
	workspaceCount: number;
	alreadyImportedCount: number;
};

export type ConductorWorkspace = {
	id: string;
	directoryName: string;
	state: string;
	branch: string | null;
	status: string | null;
	prTitle: string | null;
	sessionCount: number;
	messageCount: number;
	alreadyImported: boolean;
	iconSrc: string | null;
};

export type ImportWorkspacesResult = {
	success: boolean;
	importedCount: number;
	skippedCount: number;
	errors: string[];
};

export async function isConductorAvailable(): Promise<boolean> {
	try {
		return await invoke<boolean>("conductor_source_available");
	} catch {
		return false;
	}
}

export async function listConductorRepos(): Promise<ConductorRepo[]> {
	return invoke<ConductorRepo[]>("list_conductor_repos");
}

export async function listConductorWorkspaces(
	repoId: string,
): Promise<ConductorWorkspace[]> {
	return invoke<ConductorWorkspace[]>("list_conductor_workspaces", { repoId });
}

export async function importConductorWorkspaces(
	workspaceIds: string[],
): Promise<ImportWorkspacesResult> {
	return invoke<ImportWorkspacesResult>("import_conductor_workspaces", {
		workspaceIds,
	});
}

// ---------------------------------------------------------------------------
// Session hide / delete
// ---------------------------------------------------------------------------

export type CreateSessionResponse = {
	sessionId: string;
};

export async function createSession(
	workspaceId: string,
	options?: {
		actionKind?: ActionKind | null;
		permissionMode?: string | null;
		/** Pin the session row's `model` at creation. Inspector helpers
		 *  (Create PR/MR, Review) push the user's configured model here so
		 *  the composer reads it off the row instead of falling back to
		 *  settings.defaultModelId. Leave null for the default flow. */
		model?: string | null;
		/** Pin `effort_level` at creation; null falls back to the user
		 *  setting on the backend. */
		effortLevel?: string | null;
		/** Pin `fast_mode` at creation; null/undefined defaults to false. */
		fastMode?: boolean | null;
	},
): Promise<CreateSessionResponse> {
	return invoke<CreateSessionResponse>("create_session", {
		workspaceId,
		actionKind: options?.actionKind ?? null,
		permissionMode: options?.permissionMode ?? null,
		model: options?.model ?? null,
		effortLevel: options?.effortLevel ?? null,
		fastMode: options?.fastMode ?? null,
	});
}

export async function renameSession(
	sessionId: string,
	title: string,
): Promise<void> {
	await invoke("rename_session", { sessionId, title });
}

export async function renameWorkspaceBranch(
	workspaceId: string,
	newBranch: string,
): Promise<void> {
	await invoke("rename_workspace_branch", { workspaceId, newBranch });
}

export type GenerateSessionTitleResponse = {
	title: string | null;
	branchRenamed: boolean;
	skipped: boolean;
};

/**
 * Ask the backend to perform one best-effort naming pass for a session based
 * on the user's message. It may update the session title, workspace branch,
 * both, or neither.
 */
export async function generateSessionTitle(
	sessionId: string,
	userMessage: string,
	titleSeed?: string | null,
): Promise<GenerateSessionTitleResponse | null> {
	try {
		return await invoke<GenerateSessionTitleResponse>(
			"generate_session_title",
			{
				request: { sessionId, userMessage, titleSeed: titleSeed ?? null },
			},
		);
	} catch (error) {
		// Title generation is best-effort — don't propagate errors
		console.warn("[generateSessionTitle] Failed:", error);
		return null;
	}
}

export async function hideSession(sessionId: string): Promise<void> {
	await invoke("hide_session", { sessionId });
}

/** Read the opaque context-usage JSON for one session. Null when nothing
 *  has been recorded yet (e.g. fresh session pre first turn). */
export async function getSessionContextUsage(
	sessionId: string,
): Promise<string | null> {
	return await invoke<string | null>("get_session_context_usage", {
		sessionId,
	});
}

/** Frontend-driven write of `context_usage_meta`. Used after a
 *  trustworthy Claude hover-time live fetch so the persisted baseline
 *  catches up without waiting for the next turn end. The backend
 *  broadcasts `ContextUsageChanged`, so other observers refresh too. */
export async function setSessionContextUsage(
	sessionId: string,
	meta: string,
): Promise<void> {
	await invoke<void>("set_session_context_usage", { sessionId, meta });
}

/** Active Codex `/goal` payload as JSON. Null when no goal is set. */
export type CodexGoalState = {
	threadId: string;
	objective: string;
	status: "active" | "paused" | "budgetLimited" | "complete";
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
};

/** Read the active Codex `/goal` for one session. Null when no goal. */
export async function getSessionCodexGoal(
	sessionId: string,
): Promise<CodexGoalState | null> {
	const raw = await invoke<string | null>("get_session_codex_goal", {
		sessionId,
	});
	if (!raw) return null;
	try {
		return JSON.parse(raw) as CodexGoalState;
	} catch {
		return null;
	}
}

/** Out-of-band Codex `/goal` lifecycle control. `pause` is fired by the
 *  Composer Stop button (so abort doesn't get re-spawned by codex's
 *  continuation loop); `clear` is the banner's Clear button. Resume is
 *  intentionally NOT here — it goes through `/goal resume` on the
 *  sendMessage path so the resulting stream subscription catches the
 *  goal-continuation turn codex auto-spawns. */
export async function mutateCodexGoal(
	sessionId: string,
	action: "pause" | "clear",
): Promise<void> {
	await invoke("mutate_codex_goal", { sessionId, action });
}

/** One row of `listSessionDrafts`. `draftState` is opaque JSON (Lexical
 *  SerializedEditorState) — frontend parses on read. */
export type SessionDraftRow = {
	sessionId: string;
	draftState: string;
};

/** Bulk-load every persisted composer draft. Called once at app boot
 *  to hydrate the in-memory draft cache that backs the synchronous
 *  `loadPersistedDraft` API. */
export async function listSessionDrafts(): Promise<SessionDraftRow[]> {
	return await invoke<SessionDraftRow[]>("list_session_drafts");
}

/** Persist (or clear) a session's composer draft. Pass `null` to clear. */
export async function setSessionDraft(
	sessionId: string,
	draftState: string | null,
): Promise<void> {
	await invoke<void>("set_session_draft", {
		sessionId,
		draftState,
	});
}

/** Read the account-global Codex rate-limit snapshot. Null until Codex has
 *  emitted at least one `account/rateLimits/updated` notification. */
export async function getCodexRateLimits(): Promise<string | null> {
	return await invoke<string | null>("get_codex_rate_limits");
}

/** Read the account-global Claude rate-limit snapshot. The string is
 *  the raw Anthropic `/api/oauth/usage` response body — parsed on the
 *  frontend via `parseClaudeRateLimits`. Null when no fetch has ever
 *  succeeded (no cache, latest fetch failed). */
export async function getClaudeRateLimits(): Promise<string | null> {
	return await invoke<string | null>("get_claude_rate_limits");
}

/** Live Claude-only context-usage fetch for the hover popover. Pure
 *  passthrough to the sidecar — no DB read. `model` is required because
 *  the sidecar stamps it into the returned rich meta (used for the
 *  model-match check in the ring). Returns slim JSON (never null;
 *  errors throw). */
export async function getLiveContextUsage(params: {
	sessionId: string;
	providerSessionId: string | null;
	model: string;
	cwd: string | null;
}): Promise<string> {
	return await invoke<string>("get_live_context_usage", {
		request: {
			sessionId: params.sessionId,
			providerSessionId: params.providerSessionId,
			model: params.model,
			cwd: params.cwd,
		},
	});
}

export async function unhideSession(sessionId: string): Promise<void> {
	await invoke("unhide_session", { sessionId });
}

export async function deleteSession(sessionId: string): Promise<void> {
	await invoke("delete_session", { sessionId });
}

export async function loadHiddenSessions(
	workspaceId: string,
): Promise<WorkspaceSessionSummary[]> {
	try {
		return await invoke<WorkspaceSessionSummary[]>("list_hidden_sessions", {
			workspaceId,
		});
	} catch {
		return [];
	}
}

// ---- Repository scripts ----

export type RunScriptMode = "concurrent" | "non-concurrent";

export type RepoScripts = {
	setupScript?: string | null;
	runScript?: string | null;
	archiveScript?: string | null;
	setupFromProject: boolean;
	runFromProject: boolean;
	archiveFromProject: boolean;
	/** Auto-run the setup script on workspace creation. Defaults to true. */
	autoRunSetup: boolean;
	/**
	 * "non-concurrent" makes a new run stop any other run script in the
	 * same repo first — useful when the script binds a fixed port.
	 * Defaults to "concurrent".
	 */
	runScriptMode: RunScriptMode;
};

export type RepoPreferences = {
	createPr?: string | null;
	review?: string | null;
	fixErrors?: string | null;
	resolveConflicts?: string | null;
	branchRename?: string | null;
	general?: string | null;
};

export type ScriptEvent =
	| { type: "started"; pid: number; command: string }
	| { type: "stdout"; data: string }
	| { type: "stderr"; data: string }
	| { type: "exited"; code: number | null }
	| { type: "error"; message: string };

/**
 * Resolve repo scripts using a fixed priority (enforced in Rust):
 *   1. Workspace worktree `helmor.json` (when `workspaceId` is given AND
 *      the worktree exists on disk)
 *   2. Source repo root `helmor.json` (fallback for any missing workspace
 *      / worktree — archived, broken, or caller with no workspace context)
 *   3. DB-level override (Settings UI edit)
 *
 * Pass `workspaceId` when you have a specific workspace context (runtime
 * panel, inspector, script execution, archive hook). Omit for contexts
 * that only care about the repo's defaults (Settings page editing a repo
 * that isn't the current workspace's repo).
 */
export async function loadRepoScripts(
	repoId: string,
	workspaceId?: string | null,
): Promise<RepoScripts> {
	return invoke<RepoScripts>("load_repo_scripts", {
		repoId,
		workspaceId: workspaceId ?? null,
	});
}

export async function updateRepoScripts(
	repoId: string,
	setupScript: string | null,
	runScript: string | null,
	archiveScript: string | null,
): Promise<void> {
	await invoke("update_repo_scripts", {
		repoId,
		setupScript,
		runScript,
		archiveScript,
	});
}

export async function updateRepoAutoRunSetup(
	repoId: string,
	enabled: boolean,
): Promise<void> {
	await invoke("update_repo_auto_run_setup", { repoId, enabled });
}

export async function updateRepoRunScriptMode(
	repoId: string,
	mode: RunScriptMode,
): Promise<void> {
	await invoke("update_repo_run_script_mode", { repoId, mode });
}

export async function loadRepoPreferences(
	repoId: string,
): Promise<RepoPreferences> {
	return invoke<RepoPreferences>("load_repo_preferences", {
		repoId,
	});
}

export async function updateRepoPreferences(
	repoId: string,
	preferences: RepoPreferences,
): Promise<void> {
	await invoke("update_repo_preferences", {
		repoId,
		preferences,
	});
}

export async function executeRepoScript(
	repoId: string,
	scriptType: "setup" | "run",
	onEvent: (event: ScriptEvent) => void,
	workspaceId?: string | null,
): Promise<void> {
	const channel = new Channel<ScriptEvent>();
	channel.onmessage = onEvent;
	await invoke("execute_repo_script", {
		repoId,
		scriptType,
		workspaceId: workspaceId ?? null,
		channel,
	});
}

export async function stopRepoScript(
	repoId: string,
	scriptType: "setup" | "run",
	workspaceId?: string | null,
): Promise<boolean> {
	return invoke<boolean>("stop_repo_script", {
		repoId,
		scriptType,
		workspaceId: workspaceId ?? null,
	});
}

/**
 * Send raw bytes to a running script's PTY master. The kernel's tty line
 * discipline translates `\x03` into SIGINT for the foreground process group,
 * so passing `\x03` here is how Ctrl+C in the terminal tab actually kills
 * the running process.
 *
 * Returns `true` if the script was live and received the bytes, `false` if
 * no live script matches the key (caller can ignore).
 */
export async function writeRepoScriptStdin(
	repoId: string,
	scriptType: "setup" | "run",
	workspaceId: string | null,
	data: string,
): Promise<boolean> {
	return invoke<boolean>("write_repo_script_stdin", {
		repoId,
		scriptType,
		workspaceId: workspaceId ?? null,
		data,
	});
}

/**
 * Tell the PTY about a new terminal size. The kernel delivers SIGWINCH to
 * the foreground process group so interactive tools re-layout.
 */
export async function resizeRepoScript(
	repoId: string,
	scriptType: "setup" | "run",
	workspaceId: string | null,
	cols: number,
	rows: number,
): Promise<boolean> {
	return invoke<boolean>("resize_repo_script", {
		repoId,
		scriptType,
		workspaceId: workspaceId ?? null,
		cols,
		rows,
	});
}

/**
 * Spawn a blank interactive `$SHELL -i -l` on a fresh PTY in the workspace
 * directory. Each Terminal sub-tab in the Inspector is one of these.
 *
 * `instanceId` distinguishes concurrent terminals within the same workspace;
 * the backend keys its `ScriptProcessManager` on `(repoId, "terminal:<instanceId>",
 * workspaceId)`, so spawning twice with the same `instanceId` would replace
 * the previous shell — callers must mint a fresh UUID per sub-tab.
 *
 * Nothing is persisted: closing the app discards every sub-tab and its
 * output. Cross-tab / cross-workspace survival is in-memory only.
 */
export async function spawnTerminal(
	repoId: string,
	workspaceId: string,
	instanceId: string,
	onEvent: (event: ScriptEvent) => void,
): Promise<void> {
	const channel = new Channel<ScriptEvent>();
	channel.onmessage = onEvent;
	await invoke("spawn_terminal", {
		repoId,
		workspaceId,
		instanceId,
		channel,
	});
}

export async function stopTerminal(
	repoId: string,
	workspaceId: string,
	instanceId: string,
): Promise<boolean> {
	return invoke<boolean>("stop_terminal", {
		repoId,
		workspaceId,
		instanceId,
	});
}

export async function writeTerminalStdin(
	repoId: string,
	workspaceId: string,
	instanceId: string,
	data: string,
): Promise<boolean> {
	return invoke<boolean>("write_terminal_stdin", {
		repoId,
		workspaceId,
		instanceId,
		data,
	});
}

export async function resizeTerminal(
	repoId: string,
	workspaceId: string,
	instanceId: string,
	cols: number,
	rows: number,
): Promise<boolean> {
	return invoke<boolean>("resize_terminal", {
		repoId,
		workspaceId,
		instanceId,
		cols,
		rows,
	});
}

export { DEFAULT_WORKSPACE_GROUPS };

function describeInvokeError(error: unknown, fallback: string): string {
	return extractError(error, fallback).message;
}
