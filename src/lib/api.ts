import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { InspectorFileItem } from "./editor-session";

export type GroupTone =
	| "pinned"
	| "done"
	| "review"
	| "progress"
	| "backlog"
	| "canceled";

export type WorkspaceRow = {
	id: string;
	title: string;
	avatar?: string;
	directoryName?: string;
	repoName?: string;
	repoIconSrc?: string | null;
	repoInitials?: string | null;
	state?: string;
	hasUnread?: boolean;
	workspaceUnread?: number;
	sessionUnreadTotal?: number;
	unreadSessionCount?: number;
	derivedStatus?: string;
	manualStatus?: string | null;
	branch?: string | null;
	activeSessionId?: string | null;
	activeSessionTitle?: string | null;
	activeSessionAgentType?: string | null;
	activeSessionStatus?: string | null;
	prTitle?: string | null;
	pinnedAt?: string | null;
	sessionCount?: number;
	messageCount?: number;
	attachmentCount?: number;
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
	badge?: string | null;
};

export type AgentModelSection = {
	id: AgentProvider;
	label: string;
	options: AgentModelOption[];
};

export type AgentSendRequest = {
	provider: AgentProvider;
	modelId: string;
	prompt: string;
	sessionId?: string | null;
	helmorSessionId?: string | null;
	workingDirectory?: string | null;
	effortLevel?: string | null;
	permissionMode?: string | null;
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
	state: string;
	hasUnread: boolean;
	workspaceUnread: number;
	sessionUnreadTotal: number;
	unreadSessionCount: number;
	derivedStatus: string;
	manualStatus?: string | null;
	branch?: string | null;
	activeSessionId?: string | null;
	activeSessionTitle?: string | null;
	activeSessionAgentType?: string | null;
	activeSessionStatus?: string | null;
	prTitle?: string | null;
	sessionCount?: number;
	messageCount?: number;
	attachmentCount?: number;
};

export type RepositoryCreateOption = {
	id: string;
	name: string;
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
	createdWorkspaceState: string;
};

export type WorkspaceDetail = {
	id: string;
	title: string;
	repoId: string;
	repoName: string;
	repoIconSrc?: string | null;
	repoInitials?: string | null;
	remoteUrl?: string | null;
	defaultBranch?: string | null;
	rootPath?: string | null;
	directoryName: string;
	state: string;
	hasUnread: boolean;
	workspaceUnread: number;
	sessionUnreadTotal: number;
	unreadSessionCount: number;
	derivedStatus: string;
	manualStatus?: string | null;
	activeSessionId?: string | null;
	activeSessionTitle?: string | null;
	activeSessionAgentType?: string | null;
	activeSessionStatus?: string | null;
	branch?: string | null;
	initializationParentBranch?: string | null;
	intendedTargetBranch?: string | null;
	notes?: string | null;
	pinnedAt?: string | null;
	prTitle?: string | null;
	prDescription?: string | null;
	archiveCommit?: string | null;
	sessionCount: number;
	messageCount: number;
	attachmentCount: number;
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
	contextTokenCount: number;
	contextUsedPercent?: number | null;
	thinkingEnabled: boolean;

	fastMode: boolean;
	agentPersonality?: string | null;
	createdAt: string;
	updatedAt: string;
	lastUserMessageAt?: string | null;
	resumeSessionAt?: string | null;
	isHidden: boolean;
	isCompacting: boolean;
	/** Set when the session was created as a one-off dispatch from the
	 * inspector commit button (e.g. "create-pr", "commit-and-push"). Drives
	 * post-stream verifiers and auto-close behavior. */
	actionKind?: string | null;
	active: boolean;
};

export type RestoreWorkspaceResponse = {
	restoredWorkspaceId: string;
	restoredState: string;
	selectedWorkspaceId: string;
	/** Set when the originally archived branch was already taken at restore
	 * time and the workspace was checked out on a `-vN`-suffixed branch
	 * instead. The frontend uses this to surface an informational toast so
	 * the rename never happens silently. */
	branchRename: { original: string; actual: string } | null;
};

export type ArchiveWorkspaceResponse = {
	archivedWorkspaceId: string;
	archivedState: string;
};

export type CreateWorkspaceResponse = {
	createdWorkspaceId: string;
	selectedWorkspaceId: string;
	createdState: string;
	directoryName: string;
	branch: string;
};

export type MarkWorkspaceReadResponse = undefined;

export type SessionAttachmentRecord = {
	id: string;
	sessionId: string;
	sessionMessageId?: string | null;
	attachmentType?: string | null;
	originalName?: string | null;
	path?: string | null;
	pathExists: boolean;
	isLoading: boolean;
	isDraft: boolean;
	createdAt: string;
};

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

const DEFAULT_WORKSPACE_GROUPS: WorkspaceGroup[] = [
	{ id: "done", label: "Done", tone: "done", rows: [] },
	{ id: "review", label: "In review", tone: "review", rows: [] },
	{ id: "progress", label: "In progress", tone: "progress", rows: [] },
	{ id: "backlog", label: "Backlog", tone: "backlog", rows: [] },
	{ id: "canceled", label: "Canceled", tone: "canceled", rows: [] },
];

const DEFAULT_AGENT_MODEL_SECTIONS: AgentModelSection[] = [
	{
		id: "claude",
		label: "Claude Code",
		options: [
			{
				id: "opus-1m",
				provider: "claude",
				label: "Opus 4.6 1M",
				cliModel: "opus[1m]",
				badge: "NEW",
			},
			{
				id: "opus",
				provider: "claude",
				label: "Opus 4.6",
				cliModel: "opus",
			},
			{
				id: "sonnet",
				provider: "claude",
				label: "Sonnet 4.6",
				cliModel: "sonnet",
			},
			{
				id: "haiku",
				provider: "claude",
				label: "Haiku 4.5",
				cliModel: "haiku",
			},
		],
	},
	{
		id: "codex",
		label: "Codex",
		options: [
			{
				id: "gpt-5.4",
				provider: "codex",
				label: "GPT-5.4",
				cliModel: "gpt-5.4",
				badge: "NEW",
			},
			{
				id: "gpt-5.4-mini",
				provider: "codex",
				label: "GPT-5.4-Mini",
				cliModel: "gpt-5.4-mini",
			},
			{
				id: "gpt-5.3-codex",
				provider: "codex",
				label: "GPT-5.3-Codex",
				cliModel: "gpt-5.3-codex",
			},
			{
				id: "gpt-5.2-codex",
				provider: "codex",
				label: "GPT-5.2-Codex",
				cliModel: "gpt-5.2-codex",
			},
			{
				id: "gpt-5.2",
				provider: "codex",
				label: "GPT-5.2",
				cliModel: "gpt-5.2",
			},
			{
				id: "gpt-5.1-codex-max",
				provider: "codex",
				label: "GPT-5.1-Codex-Max",
				cliModel: "gpt-5.1-codex-max",
			},
			{
				id: "gpt-5.1-codex-mini",
				provider: "codex",
				label: "GPT-5.1-Codex-Mini",
				cliModel: "gpt-5.1-codex-mini",
			},
		],
	},
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
	source: "builtin" | "skill";
};

/**
 * Fetch the slash commands the composer popup should display for the given
 * provider + workspace. The Rust side dispatches to the sidecar which uses
 * either the Claude SDK control protocol or a Codex skill-directory scan,
 * but the frontend gets the same shape either way.
 */
export async function listSlashCommands(input: {
	provider: AgentProvider;
	workingDirectory?: string | null;
	modelId?: string | null;
}): Promise<SlashCommandEntry[]> {
	try {
		return await invoke<SlashCommandEntry[]>("list_slash_commands", {
			request: {
				provider: input.provider,
				workingDirectory: input.workingDirectory ?? null,
				modelId: input.modelId ?? null,
			},
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load slash commands."),
		);
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

export async function listRemoteBranches(
	workspaceId: string,
): Promise<string[]> {
	try {
		return await invoke<string[]>("list_remote_branches", { workspaceId });
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

export type PrefetchWorkspaceRemoteRefsResponse = {
	/** True if a fetch was performed; false if the call was rate-limited. */
	fetched: boolean;
};

/**
 * Best-effort `git fetch --prune origin` for the workspace's repo. Rate-limited
 * to once every 10 seconds per workspace on the backend, so callers can fire
 * this freely (e.g. on dropdown open) without worrying about thrashing.
 */
export async function prefetchWorkspaceRemoteRefs(
	workspaceId: string,
): Promise<PrefetchWorkspaceRemoteRefsResponse> {
	return invoke<PrefetchWorkspaceRemoteRefsResponse>(
		"prefetch_workspace_remote_refs",
		{ workspaceId },
	);
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

export async function loadSessionAttachments(
	sessionId: string,
): Promise<SessionAttachmentRecord[]> {
	try {
		return await invoke<SessionAttachmentRecord[]>("list_session_attachments", {
			sessionId,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load session attachments."),
		);
	}
}

export async function restoreWorkspace(
	workspaceId: string,
): Promise<RestoreWorkspaceResponse> {
	return invoke<RestoreWorkspaceResponse>("restore_workspace", {
		workspaceId,
	});
}

/**
 * Read-only preflight: throws with the same error the slow `restoreWorkspace`
 * call would, so callers can validate cheaply BEFORE applying optimistic UI
 * updates. ~10-50ms (one DB read + a couple of `git rev-parse` calls).
 */
export async function validateRestoreWorkspace(
	workspaceId: string,
): Promise<void> {
	await invoke<void>("validate_restore_workspace", { workspaceId });
}

export async function archiveWorkspace(
	workspaceId: string,
): Promise<ArchiveWorkspaceResponse> {
	return invoke<ArchiveWorkspaceResponse>("archive_workspace", {
		workspaceId,
	});
}

/**
 * Read-only preflight for archive — see `validateRestoreWorkspace`.
 */
export async function validateArchiveWorkspace(
	workspaceId: string,
): Promise<void> {
	await invoke<void>("validate_archive_workspace", { workspaceId });
}

export type DetectedEditor = {
	id: string;
	name: string;
	path: string;
};

export async function detectInstalledEditors(): Promise<DetectedEditor[]> {
	try {
		return await invoke<DetectedEditor[]>("detect_installed_editors");
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
export async function loadAutoCloseActionKinds(): Promise<string[]> {
	try {
		return await invoke<string[]>("load_auto_close_action_kinds");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load auto-close settings."),
		);
	}
}

export async function saveAutoCloseActionKinds(kinds: string[]): Promise<void> {
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
export async function loadAutoCloseOptInAsked(): Promise<string[]> {
	try {
		return await invoke<string[]>("load_auto_close_opt_in_asked");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load auto-close opt-in history."),
		);
	}
}

export async function saveAutoCloseOptInAsked(kinds: string[]): Promise<void> {
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
	settings: { effortLevel?: string; permissionMode?: string },
): Promise<void> {
	await invoke("update_session_settings", {
		sessionId,
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

export async function addRepositoryFromLocalPath(
	folderPath: string,
): Promise<AddRepositoryResponse> {
	return invoke<AddRepositoryResponse>("add_repository_from_local_path", {
		folderPath,
	});
}

export async function markSessionRead(
	sessionId: string,
): Promise<MarkWorkspaceReadResponse> {
	return invoke<MarkWorkspaceReadResponse>("mark_session_read", {
		sessionId,
	});
}

export async function markWorkspaceRead(
	workspaceId: string,
): Promise<MarkWorkspaceReadResponse> {
	return invoke<MarkWorkspaceReadResponse>("mark_workspace_read", {
		workspaceId,
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
	status: string | null,
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

export type TextPart = { type: "text"; text: string };
export type ReasoningPart = {
	type: "reasoning";
	text: string;
	/** Per-part streaming state — only the active thinking block is streaming. */
	streaming?: boolean;
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
	severity: NoticeSeverity;
	label: string;
	body?: string;
};
export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoItem = { text: string; status: TodoStatus };
export type TodoListPart = {
	type: "todo-list";
	items: TodoItem[];
};
export type ImageSource =
	| { kind: "base64"; data: string }
	| { kind: "url"; url: string };
export type ImagePart = {
	type: "image";
	source: ImageSource;
	mediaType?: string;
};
export type PromptSuggestionPart = {
	type: "prompt-suggestion";
	text: string;
};
export type FileMentionPart = {
	type: "file-mention";
	path: string;
};
export type MessagePart =
	| TextPart
	| ReasoningPart
	| ToolCallPart
	| SystemNoticePart
	| TodoListPart
	| ImagePart
	| PromptSuggestionPart
	| FileMentionPart;

export type CollapsedGroupPart = {
	type: "collapsed-group";
	category: "search" | "read" | "mixed";
	tools: ToolCallPart[];
	active: boolean;
	summary: string;
};

export type ExtendedMessagePart = MessagePart | CollapsedGroupPart;

export type ThreadMessageLike = {
	role: "assistant" | "system" | "user";
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
	| { kind: "error"; message: string; persisted: boolean };

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
	actionKind?: string | null,
): Promise<CreateSessionResponse> {
	return invoke<CreateSessionResponse>("create_session", {
		workspaceId,
		actionKind: actionKind ?? null,
	});
}

export async function renameSession(
	sessionId: string,
	title: string,
): Promise<void> {
	await invoke("rename_session", { sessionId, title });
}

export type GenerateSessionTitleResponse = {
	title: string | null;
	skipped: boolean;
};

/**
 * Ask the backend to auto-generate a title for a session based on the user's
 * first message. No-ops if the session already has a non-"Untitled" title.
 */
export async function generateSessionTitle(
	sessionId: string,
	userMessage: string,
): Promise<GenerateSessionTitleResponse | null> {
	try {
		return await invoke<GenerateSessionTitleResponse>(
			"generate_session_title",
			{
				request: { sessionId, userMessage },
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

export { DEFAULT_AGENT_MODEL_SECTIONS, DEFAULT_WORKSPACE_GROUPS };

function describeInvokeError(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim()) {
		return error.message;
	}

	if (typeof error === "string" && error.trim()) {
		return error;
	}

	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string" &&
		error.message.trim()
	) {
		return error.message;
	}

	return fallback;
}
