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
 * Mirror of the Rust `DerivedStatus` enum
 * (`src-tauri/src/workspace/derived_status.rs`). Drives the sidebar kanban
 * lanes and PR-driven auto-status transitions.
 */
export type DerivedStatus =
	| "in-progress"
	| "done"
	| "review"
	| "backlog"
	| "canceled";

/**
 * Mirror of the Rust `ActionKind` enum
 * (`src-tauri/src/agents/action_kind.rs`). Non-null when the session was
 * created as a one-off "action" dispatch from the inspector commit button.
 */
export type ActionKind =
	| "create-pr"
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
	hasUnread?: boolean;
	workspaceUnread?: number;
	unreadSessionCount?: number;
	derivedStatus?: DerivedStatus;
	manualStatus?: DerivedStatus | null;
	branch?: string | null;
	activeSessionId?: string | null;
	activeSessionTitle?: string | null;
	activeSessionAgentType?: string | null;
	activeSessionStatus?: string | null;
	prTitle?: string | null;
	pinnedAt?: string | null;
	sessionCount?: number;
	messageCount?: number;
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

export type AgentProvider = "claude" | "codex";

export type AgentModelOption = {
	id: string;
	provider: AgentProvider;
	label: string;
	cliModel: string;
	effortLevels?: string[];
	supportsFastMode?: boolean;
};

export type AgentModelSectionStatus = "ready" | "unavailable" | "error";

export type AgentModelSection = {
	id: AgentProvider;
	label: string;
	status?: AgentModelSectionStatus;
	options: AgentModelOption[];
};

export type AgentSendRequest = {
	provider: AgentProvider;
	modelId: string;
	prompt: string;
	resumeOnly?: boolean | null;
	sessionId?: string | null;
	helmorSessionId?: string | null;
	workingDirectory?: string | null;
	effortLevel?: string | null;
	permissionMode?: string | null;
	fastMode?: boolean | null;
	userMessageId?: string | null;
	/** Workspace-relative paths from the @-mention picker. */
	files?: string[] | null;
};

export type WorkspaceSummary = {
	id: string;
	title: string;
	directoryName: string;
	repoName: string;
	repoIconSrc?: string | null;
	repoInitials?: string | null;
	state: WorkspaceState;
	hasUnread: boolean;
	workspaceUnread: number;
	unreadSessionCount: number;
	derivedStatus: DerivedStatus;
	manualStatus?: DerivedStatus | null;
	branch?: string | null;
	activeSessionId?: string | null;
	activeSessionTitle?: string | null;
	activeSessionAgentType?: string | null;
	activeSessionStatus?: string | null;
	prTitle?: string | null;
	sessionCount?: number;
	messageCount?: number;
};

export type RepositoryCreateOption = {
	id: string;
	name: string;
	remote?: string | null;
	defaultBranch?: string | null;
	repoIconSrc?: string | null;
	repoInitials?: string | null;
};

export type AddRepositoryDefaults = {
	lastCloneDirectory?: string | null;
};

export type GithubIdentitySession = {
	provider: string;
	githubUserId: number;
	login: string;
	name?: string | null;
	avatarUrl?: string | null;
	primaryEmail?: string | null;
	tokenExpiresAt?: string | null;
	refreshTokenExpiresAt?: string | null;
};

export type GithubIdentitySnapshot =
	| { status: "connected"; session: GithubIdentitySession }
	| { status: "disconnected" }
	| { status: "unconfigured"; message: string }
	| { status: "error"; message: string };

export type GithubIdentityDeviceFlowStart = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string | null;
	expiresAt: string;
	intervalSeconds: number;
};

export type GithubCliStatus =
	| {
			status: "ready";
			host: string;
			login: string;
			version: string;
			message: string;
	  }
	| {
			status: "unauthenticated";
			host: string;
			version?: string | null;
			message: string;
	  }
	| { status: "unavailable"; host: string; message: string }
	| {
			status: "error";
			host: string;
			version?: string | null;
			message: string;
	  };

export type GithubCliUser = {
	login: string;
	id: number;
	name?: string | null;
	avatarUrl?: string | null;
	email?: string | null;
};

export type GithubRepositorySummary = {
	id: number;
	name: string;
	fullName: string;
	ownerLogin: string;
	private: boolean;
	defaultBranch?: string | null;
	htmlUrl: string;
	updatedAt?: string | null;
	pushedAt?: string | null;
};

export type AddRepositoryResponse = {
	repositoryId: string;
	createdRepository: boolean;
	selectedWorkspaceId: string;
	createdWorkspaceId?: string | null;
	createdWorkspaceState: WorkspaceState;
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
	derivedStatus: DerivedStatus;
	manualStatus?: DerivedStatus | null;
	activeSessionId?: string | null;
	activeSessionTitle?: string | null;
	activeSessionAgentType?: string | null;
	activeSessionStatus?: string | null;
	branch?: string | null;
	initializationParentBranch?: string | null;
	intendedTargetBranch?: string | null;
	pinnedAt?: string | null;
	prTitle?: string | null;
	archiveCommit?: string | null;
	sessionCount: number;
	messageCount: number;
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
};

export type FinalizeWorkspaceResponse = {
	workspaceId: string;
	finalState: WorkspaceState;
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

export type AppUpdateStatus = {
	stage: AppUpdateStage;
	configured: boolean;
	autoUpdateEnabled: boolean;
	update?: AppUpdateInfo | null;
	lastError?: string | null;
	lastAttemptAt?: string | null;
	downloadedAt?: string | null;
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

export async function loadGithubIdentitySession(): Promise<GithubIdentitySnapshot> {
	try {
		return await invoke<GithubIdentitySnapshot>("get_github_identity_session");
	} catch (error) {
		return {
			status: "error",
			message: describeInvokeError(
				error,
				"Unable to load GitHub account state.",
			),
		};
	}
}

export async function startGithubIdentityConnect(): Promise<GithubIdentityDeviceFlowStart> {
	return invoke<GithubIdentityDeviceFlowStart>("start_github_identity_connect");
}

export async function cancelGithubIdentityConnect(): Promise<void> {
	await invoke("cancel_github_identity_connect");
}

export async function disconnectGithubIdentity(): Promise<void> {
	await invoke("disconnect_github_identity");
}

export async function listenGithubIdentityChanged(
	callback: (snapshot: GithubIdentitySnapshot) => void,
): Promise<UnlistenFn> {
	return listen<GithubIdentitySnapshot>(
		"github-identity-changed",
		(tauriEvent) => {
			callback(tauriEvent.payload);
		},
	);
}

export async function loadGithubCliStatus(): Promise<GithubCliStatus> {
	try {
		return await invoke<GithubCliStatus>("get_github_cli_status");
	} catch (error) {
		return {
			status: "error",
			host: "github.com",
			message: describeInvokeError(error, "Unable to load GitHub CLI state."),
		};
	}
}

export async function loadGithubCliUser(): Promise<GithubCliUser | null> {
	try {
		return await invoke<GithubCliUser | null>("get_github_cli_user");
	} catch {
		return null;
	}
}

export async function listGithubAccessibleRepositories(): Promise<
	GithubRepositorySummary[]
> {
	try {
		return await invoke<GithubRepositorySummary[]>(
			"list_github_accessible_repositories",
		);
	} catch {
		return [];
	}
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

export type SlashCommandEntry = {
	name: string;
	description: string;
	argumentHint?: string | null;
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
	} catch {
		return [];
	}
}

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
	| { type: "workspaceFilesChanged"; workspaceId: string }
	| { type: "workspaceGitStateChanged"; workspaceId: string }
	| { type: "workspacePrChanged"; workspaceId: string }
	| { type: "repositoryListChanged" }
	| { type: "repositoryChanged"; repoId: string }
	| { type: "settingsChanged"; key: string | null }
	| { type: "githubIdentityChanged" }
	| {
			type: "pendingCliSendQueued";
			workspaceId: string;
			sessionId: string;
			prompt: string;
			modelId: string | null;
			permissionMode: string | null;
	  };

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
): Promise<void> {
	const { Channel } = await import("@tauri-apps/api/core");
	const onEvent = new Channel<UiMutationEvent>();
	onEvent.onmessage = callback;
	await invoke("subscribe_ui_mutations", { onEvent });
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

export type PullRequestInfo = {
	url: string;
	number: number;
	state: "OPEN" | "CLOSED" | "MERGED" | string;
	title: string;
	isMerged: boolean;
};

export type ActionStatusKind = "success" | "pending" | "running" | "failure";
export type ActionProvider = "github" | "vercel" | "unknown";
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
	pushStatus?: WorkspacePushStatus;
};

export type SyncWorkspaceTargetOutcome =
	| "updated"
	| "alreadyUpToDate"
	| "conflict"
	| "dirtyWorktree";

export type SyncWorkspaceTargetResponse = {
	outcome: SyncWorkspaceTargetOutcome;
	targetBranch: string;
	conflictedFiles: string[];
};

export type PushWorkspaceToRemoteResponse = {
	targetRef: string;
	headCommit: string;
};

export type WorkspacePrActionItem = {
	id: string;
	name: string;
	provider: ActionProvider;
	status: ActionStatusKind;
	duration?: string | null;
	url?: string | null;
};

export type WorkspacePrActionStatus = {
	pr: PullRequestInfo | null;
	reviewDecision?: string | null;
	mergeable?: string | null;
	deployments: WorkspacePrActionItem[];
	checks: WorkspacePrActionItem[];
	remoteState: "ok" | "noPr" | "unavailable" | "error";
	message?: string | null;
};

/**
 * Look up the most recent pull request on GitHub whose head ref matches the
 * workspace's current branch. Returns `null` when there's no matching PR, the
 * workspace has no github.com remote, the user isn't connected to GitHub, or
 * the stored access token has been revoked. Only throws for unexpected
 * transport / parse failures.
 */
export async function lookupWorkspacePr(
	workspaceId: string,
): Promise<PullRequestInfo | null> {
	try {
		const result = await invoke<PullRequestInfo | null>("lookup_workspace_pr", {
			workspaceId,
		});
		return result ?? null;
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to look up workspace PR."),
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

export async function loadWorkspacePrActionStatus(
	workspaceId: string,
): Promise<WorkspacePrActionStatus> {
	try {
		return await invoke<WorkspacePrActionStatus>(
			"get_workspace_pr_action_status",
			{ workspaceId },
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load workspace PR status."),
		);
	}
}

export async function getWorkspacePrCheckInsertText(
	workspaceId: string,
	itemId: string,
): Promise<string> {
	try {
		return await invoke<string>("get_workspace_pr_check_insert_text", {
			workspaceId,
			itemId,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load check details."),
		);
	}
}

/**
 * Merge the workspace's open PR via GitHub GraphQL `mergePullRequest`.
 * Returns the refreshed PR info on success, `null` if no PR / not connected.
 */
export async function mergeWorkspacePr(
	workspaceId: string,
): Promise<PullRequestInfo | null> {
	try {
		return (
			(await invoke<PullRequestInfo | null>("merge_workspace_pr", {
				workspaceId,
			})) ?? null
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to merge workspace PR."),
		);
	}
}

/**
 * Close the workspace's open PR via GitHub GraphQL `closePullRequest`.
 * Returns the refreshed PR info on success, `null` if no PR / not connected.
 */
export async function closeWorkspacePr(
	workspaceId: string,
): Promise<PullRequestInfo | null> {
	try {
		return (
			(await invoke<PullRequestInfo | null>("close_workspace_pr", {
				workspaceId,
			})) ?? null
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to close workspace PR."),
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
	},
): Promise<void> {
	await invoke("update_session_settings", {
		sessionId,
		model: settings.model ?? null,
		effortLevel: settings.effortLevel ?? null,
		permissionMode: settings.permissionMode ?? null,
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
 */
export async function prepareWorkspaceFromRepo(
	repoId: string,
): Promise<PrepareWorkspaceResponse> {
	return invoke<PrepareWorkspaceResponse>("prepare_workspace_from_repo", {
		repoId,
	});
}

/**
 * Phase 2 of workspace creation. Slow (~200ms-2s): creates the git
 * worktree, scaffolds `.context`, probes `helmor.json`, and flips the
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

export async function setWorkspaceManualStatus(
	workspaceId: string,
	status: DerivedStatus | null,
): Promise<void> {
	return invoke<void>("set_workspace_manual_status", { workspaceId, status });
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
	| { kind: "url"; url: string };
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
			kind: "deferredToolUse";
			provider: AgentProvider;
			modelId: string;
			resolvedModel: string;
			sessionId?: string | null;
			workingDirectory: string;
			permissionMode?: string | null;
			toolUseId: string;
			toolName: string;
			toolInput: Record<string, unknown>;
	  }
	| {
			kind: "elicitationRequest";
			provider: AgentProvider;
			modelId: string;
			resolvedModel: string;
			sessionId?: string | null;
			workingDirectory: string;
			elicitationId?: string | null;
			serverName: string;
			message: string;
			mode?: string | null;
			url?: string | null;
			requestedSchema?: Record<string, unknown> | null;
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

export type AgentSteerRequest = {
	sessionId: string;
	provider?: string;
	prompt: string;
	files?: string[];
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

export async function respondToDeferredTool(
	toolUseId: string,
	behavior: "allow" | "deny",
	options?: {
		reason?: string | null;
		updatedInput?: Record<string, unknown> | null;
	},
): Promise<void> {
	await invoke("respond_to_deferred_tool", {
		request: {
			toolUseId,
			behavior,
			reason: options?.reason ?? null,
			updatedInput: options?.updatedInput ?? null,
		},
	});
}

export async function respondToElicitationRequest(
	elicitationId: string,
	action: "accept" | "decline" | "cancel",
	content?: Record<string, unknown> | null,
): Promise<void> {
	await invoke("respond_to_elicitation_request", {
		request: {
			elicitationId,
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
	derivedStatus: string | null;
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
	},
): Promise<CreateSessionResponse> {
	return invoke<CreateSessionResponse>("create_session", {
		workspaceId,
		actionKind: options?.actionKind ?? null,
		permissionMode: options?.permissionMode ?? null,
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

export type RepoScripts = {
	setupScript?: string | null;
	runScript?: string | null;
	archiveScript?: string | null;
	setupFromProject: boolean;
	runFromProject: boolean;
	archiveFromProject: boolean;
};

export type RepoPreferences = {
	createPr?: string | null;
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

export { DEFAULT_WORKSPACE_GROUPS };

// ---------------------------------------------------------------------------
// Feedback / "Quick fix" contribution flow
// ---------------------------------------------------------------------------

export type ForkResult = {
	owner: string;
	repo: string;
	cloneUrl: string;
	htmlUrl: string;
};

export type IssueResult = {
	url: string;
	number: number;
};

export type ExistingHelmorWorkspace = {
	workspaceId: string;
	repoId: string;
	repoName: string;
	branch: string | null;
};

export async function forkHelmorUpstream(): Promise<ForkResult> {
	return invoke<ForkResult>("fork_helmor_upstream");
}

export async function createHelmorIssue(
	title: string,
	body: string,
): Promise<IssueResult> {
	return invoke<IssueResult>("create_helmor_issue", { title, body });
}

export async function findExistingHelmorWorkspace(): Promise<ExistingHelmorWorkspace | null> {
	return invoke<ExistingHelmorWorkspace | null>(
		"find_existing_helmor_workspace",
	);
}

function describeInvokeError(error: unknown, fallback: string): string {
	return extractError(error, fallback).message;
}
