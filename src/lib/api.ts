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
	active: boolean;
};

export type RestoreWorkspaceResponse = {
	restoredWorkspaceId: string;
	restoredState: string;
	selectedWorkspaceId: string;
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

export type SessionMessageRecord = {
	id: string;
	sessionId: string;
	role: string;
	content: string;
	contentIsJson: boolean;
	parsedContent?: unknown;
	createdAt: string;
	sentAt?: string | null;
	cancelledAt?: string | null;
	model?: string | null;
	sdkMessageId?: string | null;
	lastAssistantMessageId?: string | null;
	turnId?: string | null;
	isResumableMessage?: boolean | null;
	attachmentCount: number;
};

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

const DEFAULT_ADD_REPOSITORY_DEFAULTS: AddRepositoryDefaults = {
	lastCloneDirectory: null,
};

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
				id: "gpt-5.3-codex-spark",
				provider: "codex",
				label: "GPT-5.3-Codex-Spark",
				cliModel: "gpt-5.3-codex-spark",
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
		],
	},
];

type TauriInvoke = <T>(
	command: string,
	args?: Record<string, unknown>,
) => Promise<T>;

const BROWSER_FALLBACK_GITHUB_IDENTITY: GithubIdentitySnapshot = {
	status: "connected",
	session: {
		provider: "browser-dev",
		githubUserId: 0,
		login: "browser-dev",
		name: "Browser Dev",
		avatarUrl: null,
		primaryEmail: null,
		tokenExpiresAt: null,
		refreshTokenExpiresAt: null,
	},
};

const BROWSER_FALLBACK_GITHUB_CLI_STATUS: GithubCliStatus = {
	status: "ready",
	host: "github.com",
	login: "browser-dev",
	version: "browser-dev",
	message: "Browser development mode",
};

const BROWSER_FALLBACK_GITHUB_CLI_USER: GithubCliUser = {
	login: "browser-dev",
	id: 0,
	name: "Browser Dev",
	avatarUrl: null,
	email: null,
};

export function hasTauriRuntime(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function getTauriInvoke(): Promise<TauriInvoke | null> {
	if (!hasTauriRuntime()) {
		return null;
	}

	return invoke as TauriInvoke;
}

// ---------------------------------------------------------------------------
// Dev server fetch helper (used when Tauri runtime is absent)
// ---------------------------------------------------------------------------

async function devFetch<T>(
	endpoint: string,
	params?: Record<string, string>,
	options?: { method?: string; body?: unknown },
): Promise<T> {
	const url = new URL(`/api/${endpoint}`, window.location.origin);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, v);
		}
	}
	const init: RequestInit = {};
	if (options?.method) {
		init.method = options.method;
	}
	if (options?.body !== undefined) {
		init.headers = { "Content-Type": "application/json" };
		init.body = JSON.stringify(options.body);
	}
	const res = await fetch(url.toString(), init);
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Dev server error (${res.status}): ${body}`);
	}
	return res.json() as Promise<T>;
}

export async function loadWorkspaceGroups(): Promise<WorkspaceGroup[]> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return devFetch<WorkspaceGroup[]>("list_workspace_groups");
	}

	try {
		return await invoke<WorkspaceGroup[]>("list_workspace_groups");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load workspace groups."),
		);
	}
}

export async function loadGithubIdentitySession(): Promise<GithubIdentitySnapshot> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return BROWSER_FALLBACK_GITHUB_IDENTITY;
	}

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
	const invoke = await getTauriInvoke();

	if (!invoke) {
		throw new Error(
			"GitHub account connection is only available in the Tauri desktop runtime.",
		);
	}

	return invoke<GithubIdentityDeviceFlowStart>("start_github_identity_connect");
}

export async function cancelGithubIdentityConnect(): Promise<void> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return;
	}

	await invoke("cancel_github_identity_connect");
}

export async function disconnectGithubIdentity(): Promise<void> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return;
	}

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
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return BROWSER_FALLBACK_GITHUB_CLI_STATUS;
	}

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
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return BROWSER_FALLBACK_GITHUB_CLI_USER;
	}

	try {
		return await invoke<GithubCliUser | null>("get_github_cli_user");
	} catch {
		return null;
	}
}

export async function listGithubAccessibleRepositories(): Promise<
	GithubRepositorySummary[]
> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return [];
	}

	try {
		return await invoke<GithubRepositorySummary[]>(
			"list_github_accessible_repositories",
		);
	} catch {
		return [];
	}
}

export async function loadDataInfo(): Promise<DataInfo | null> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		try {
			return await devFetch<DataInfo>("get_data_info");
		} catch {
			return null;
		}
	}

	try {
		return await invoke<DataInfo>("get_data_info");
	} catch {
		return null;
	}
}

export async function loadArchivedWorkspaces(): Promise<WorkspaceSummary[]> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return devFetch<WorkspaceSummary[]>("list_archived_workspaces");
	}

	try {
		return await invoke<WorkspaceSummary[]>("list_archived_workspaces");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load archived workspaces."),
		);
	}
}

export async function listRepositories(): Promise<RepositoryCreateOption[]> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return devFetch<RepositoryCreateOption[]>("list_repositories");
	}

	try {
		return await invoke<RepositoryCreateOption[]>("list_repositories");
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to load repositories."));
	}
}

export async function loadAddRepositoryDefaults(): Promise<AddRepositoryDefaults> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return DEFAULT_ADD_REPOSITORY_DEFAULTS;
	}

	try {
		return await invoke<AddRepositoryDefaults>("get_add_repository_defaults");
	} catch {
		return DEFAULT_ADD_REPOSITORY_DEFAULTS;
	}
}

export async function loadAgentModelSections(): Promise<AgentModelSection[]> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return devFetch<AgentModelSection[]>("list_agent_model_sections");
	}

	try {
		return await invoke<AgentModelSection[]>("list_agent_model_sections");
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to load agent models."));
	}
}

export async function loadWorkspaceDetail(
	workspaceId: string,
): Promise<WorkspaceDetail | null> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return devFetch<WorkspaceDetail>("get_workspace", { id: workspaceId });
	}

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
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return [];
	}

	try {
		return await invoke<string[]>("list_remote_branches", { workspaceId });
	} catch {
		return [];
	}
}

export async function updateIntendedTargetBranch(
	workspaceId: string,
	targetBranch: string,
): Promise<void> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		await devFetch("update_intended_target_branch", undefined, {
			method: "POST",
			body: { workspaceId, targetBranch },
		});
		return;
	}

	return invoke<void>("update_intended_target_branch", {
		workspaceId,
		targetBranch,
	});
}

export async function loadWorkspaceSessions(
	workspaceId: string,
): Promise<WorkspaceSessionSummary[]> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return devFetch<WorkspaceSessionSummary[]>("list_workspace_sessions", {
			id: workspaceId,
		});
	}

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

export async function loadSessionMessages(
	sessionId: string,
): Promise<SessionMessageRecord[]> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return devFetch<SessionMessageRecord[]>("list_session_messages", {
			id: sessionId,
		});
	}

	try {
		return await invoke<SessionMessageRecord[]>("list_session_messages", {
			sessionId,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load session messages."),
		);
	}
}

export async function loadSessionAttachments(
	sessionId: string,
): Promise<SessionAttachmentRecord[]> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return devFetch<SessionAttachmentRecord[]>("list_session_attachments", {
			id: sessionId,
		});
	}

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
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return devFetch<RestoreWorkspaceResponse>(
			"restore_workspace",
			{ id: workspaceId },
			{ method: "POST" },
		);
	}

	return invoke<RestoreWorkspaceResponse>("restore_workspace", {
		workspaceId,
	});
}

export async function archiveWorkspace(
	workspaceId: string,
): Promise<ArchiveWorkspaceResponse> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return devFetch<ArchiveWorkspaceResponse>(
			"archive_workspace",
			{ id: workspaceId },
			{ method: "POST" },
		);
	}

	return invoke<ArchiveWorkspaceResponse>("archive_workspace", {
		workspaceId,
	});
}

export type DetectedEditor = {
	id: string;
	name: string;
	path: string;
};

export async function detectInstalledEditors(): Promise<DetectedEditor[]> {
	const invoke = await getTauriInvoke();
	if (!invoke) {
		try {
			return await devFetch<DetectedEditor[]>("detect_installed_editors");
		} catch {
			return [];
		}
	}
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
	const invoke = await getTauriInvoke();
	if (!invoke) return;
	await invoke("open_workspace_in_editor", { workspaceId, editor });
}

export async function readEditorFile(
	path: string,
): Promise<EditorFileReadResponse> {
	const inv = await getTauriInvoke();
	if (!inv) {
		return devFetch<EditorFileReadResponse>("read_editor_file", { path });
	}

	try {
		return await inv<EditorFileReadResponse>("read_editor_file", { path });
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
	const inv = await getTauriInvoke();
	if (!inv) {
		return devFetch<EditorFileWriteResponse>("write_editor_file", undefined, {
			method: "POST",
			body: { path, content },
		});
	}

	try {
		return await inv<EditorFileWriteResponse>("write_editor_file", {
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
	const inv = await getTauriInvoke();
	if (!inv) {
		return devFetch<EditorFileStatResponse>("stat_editor_file", { path });
	}

	try {
		return await inv<EditorFileStatResponse>("stat_editor_file", { path });
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to inspect the selected file."),
		);
	}
}

export async function listEditorFiles(
	workspaceRootPath: string,
): Promise<InspectorFileItem[]> {
	const inv = await getTauriInvoke();
	if (!inv) {
		return devFetch<InspectorFileItem[]>("list_editor_files", {
			root: workspaceRootPath,
		});
	}

	try {
		return await inv<InspectorFileItem[]>("list_editor_files", {
			workspaceRootPath,
		});
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to list editor files."));
	}
}

export async function listEditorFilesWithContent(
	workspaceRootPath: string,
): Promise<EditorFilesWithContentResponse> {
	const inv = await getTauriInvoke();
	if (!inv) {
		return devFetch<EditorFilesWithContentResponse>(
			"list_editor_files_with_content",
			{ root: workspaceRootPath },
		);
	}

	try {
		return await inv<EditorFilesWithContentResponse>(
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
	const inv = await getTauriInvoke();
	if (!inv) {
		return devFetch<EditorFilesWithContentResponse>(
			"list_workspace_changes_with_content",
			{ root: workspaceRootPath },
		);
	}

	try {
		return await inv<EditorFilesWithContentResponse>(
			"list_workspace_changes_with_content",
			{ workspaceRootPath },
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to list workspace changes."),
		);
	}
}

export async function permanentlyDeleteWorkspace(
	workspaceId: string,
): Promise<void> {
	const invoke = await getTauriInvoke();
	if (!invoke) {
		await devFetch(
			"permanently_delete_workspace",
			{ id: workspaceId },
			{ method: "POST" },
		);
		return;
	}
	await invoke("permanently_delete_workspace", { workspaceId });
}

export async function updateSessionSettings(
	sessionId: string,
	settings: { effortLevel?: string; permissionMode?: string },
): Promise<void> {
	const invoke = await getTauriInvoke();
	if (!invoke) {
		await devFetch("update_session_settings", undefined, {
			method: "POST",
			body: {
				sessionId,
				effortLevel: settings.effortLevel ?? null,
				permissionMode: settings.permissionMode ?? null,
			},
		});
		return;
	}
	await invoke("update_session_settings", {
		sessionId,
		effortLevel: settings.effortLevel ?? null,
		permissionMode: settings.permissionMode ?? null,
	});
}

export async function createWorkspaceFromRepo(
	repoId: string,
): Promise<CreateWorkspaceResponse> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		return devFetch<CreateWorkspaceResponse>(
			"create_workspace_from_repo",
			{ id: repoId },
			{ method: "POST" },
		);
	}

	return invoke<CreateWorkspaceResponse>("create_workspace_from_repo", {
		repoId,
	});
}

export async function addRepositoryFromLocalPath(
	folderPath: string,
): Promise<AddRepositoryResponse> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		throw new Error(
			"Repository add requires the Tauri desktop runtime (needs filesystem dialog).",
		);
	}

	return invoke<AddRepositoryResponse>("add_repository_from_local_path", {
		folderPath,
	});
}

export async function markSessionRead(
	sessionId: string,
): Promise<MarkWorkspaceReadResponse> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		await devFetch("mark_session_read", { id: sessionId }, { method: "POST" });
		return undefined;
	}

	return invoke<MarkWorkspaceReadResponse>("mark_session_read", {
		sessionId,
	});
}

export async function markWorkspaceRead(
	workspaceId: string,
): Promise<MarkWorkspaceReadResponse> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		await devFetch(
			"mark_workspace_read",
			{ id: workspaceId },
			{ method: "POST" },
		);
		return undefined;
	}

	return invoke<MarkWorkspaceReadResponse>("mark_workspace_read", {
		workspaceId,
	});
}

export async function markWorkspaceUnread(
	workspaceId: string,
): Promise<MarkWorkspaceReadResponse> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		await devFetch(
			"mark_workspace_unread",
			{ id: workspaceId },
			{ method: "POST" },
		);
		return undefined;
	}

	return invoke<MarkWorkspaceReadResponse>("mark_workspace_unread", {
		workspaceId,
	});
}

export async function pinWorkspace(workspaceId: string): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) {
		await devFetch("pin_workspace", { id: workspaceId }, { method: "POST" });
		return;
	}
	return inv<void>("pin_workspace", { workspaceId });
}

export async function unpinWorkspace(workspaceId: string): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) {
		await devFetch("unpin_workspace", { id: workspaceId }, { method: "POST" });
		return;
	}
	return inv<void>("unpin_workspace", { workspaceId });
}

export async function setWorkspaceManualStatus(
	workspaceId: string,
	status: string | null,
): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) {
		await devFetch("set_workspace_manual_status", undefined, {
			method: "POST",
			body: { workspaceId, status },
		});
		return;
	}
	return inv<void>("set_workspace_manual_status", { workspaceId, status });
}

// ---------------------------------------------------------------------------
// Streaming agent API
// ---------------------------------------------------------------------------

export type AgentStreamStartResponse = {
	streamId: string;
};

export type AgentStreamEvent =
	| { kind: "line"; line: string }
	| {
			kind: "done";
			provider: AgentProvider;
			modelId: string;
			resolvedModel: string;
			sessionId?: string | null;
			workingDirectory: string;
			persisted: boolean;
	  }
	| { kind: "error"; message: string };

export async function startAgentMessageStream(
	request: AgentSendRequest,
): Promise<AgentStreamStartResponse> {
	const inv = await getTauriInvoke();
	if (!inv) {
		return devFetch<AgentStreamStartResponse>(
			"send_agent_message_stream",
			undefined,
			{ method: "POST", body: { request } },
		);
	}
	return inv<AgentStreamStartResponse>("send_agent_message_stream", {
		request,
	});
}

export async function listenAgentStream(
	streamId: string,
	callback: (event: AgentStreamEvent) => void,
): Promise<UnlistenFn> {
	if (!hasTauriRuntime()) {
		// Browser mode: use SSE instead of Tauri event listener
		const url = new URL("/api/agent_stream_sse", window.location.origin);
		url.searchParams.set("streamId", streamId);
		const eventSource = new EventSource(url.toString());

		eventSource.onmessage = (msg) => {
			try {
				const event = JSON.parse(msg.data) as AgentStreamEvent;
				callback(event);
				// Close SSE on terminal events
				if (event.kind === "done" || event.kind === "error") {
					eventSource.close();
				}
			} catch {
				// Ignore unparseable SSE data
			}
		};

		eventSource.onerror = () => {
			eventSource.close();
		};

		// Return an unlisten function compatible with the Tauri API
		return () => {
			eventSource.close();
		};
	}

	return listen<AgentStreamEvent>(`agent-stream:${streamId}`, (tauriEvent) => {
		callback(tauriEvent.payload);
	});
}

export async function stopAgentStream(
	sessionId: string,
	provider?: string,
): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) {
		await devFetch("stop_agent_stream", undefined, {
			method: "POST",
			body: { request: { sessionId, provider: provider ?? null } },
		});
		return;
	}
	await inv("stop_agent_stream", {
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
	const inv = await getTauriInvoke();
	if (!inv) return false;
	try {
		return await inv<boolean>("conductor_source_available");
	} catch {
		return false;
	}
}

export async function listConductorRepos(): Promise<ConductorRepo[]> {
	const inv = await getTauriInvoke();
	if (!inv) return [];
	return inv<ConductorRepo[]>("list_conductor_repos");
}

export async function listConductorWorkspaces(
	repoId: string,
): Promise<ConductorWorkspace[]> {
	const inv = await getTauriInvoke();
	if (!inv) return [];
	return inv<ConductorWorkspace[]>("list_conductor_workspaces", { repoId });
}

export async function importConductorWorkspaces(
	workspaceIds: string[],
): Promise<ImportWorkspacesResult> {
	const inv = await getTauriInvoke();
	if (!inv) {
		throw new Error(
			"Conductor import is only available in the Tauri desktop runtime.",
		);
	}
	return inv<ImportWorkspacesResult>("import_conductor_workspaces", {
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
): Promise<CreateSessionResponse> {
	const inv = await getTauriInvoke();
	if (!inv) {
		return devFetch<CreateSessionResponse>(
			"create_session",
			{ id: workspaceId },
			{ method: "POST" },
		);
	}
	return inv<CreateSessionResponse>("create_session", { workspaceId });
}

export async function renameSession(
	sessionId: string,
	title: string,
): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) {
		await devFetch("rename_session", undefined, {
			method: "POST",
			body: { sessionId, title },
		});
		return;
	}
	await inv("rename_session", { sessionId, title });
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
	const inv = await getTauriInvoke();
	if (!inv) return null;
	try {
		return await inv<GenerateSessionTitleResponse>("generate_session_title", {
			request: { sessionId, userMessage },
		});
	} catch (error) {
		// Title generation is best-effort — don't propagate errors
		console.warn("[generateSessionTitle] Failed:", error);
		return null;
	}
}

export async function hideSession(sessionId: string): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) {
		await devFetch("hide_session", { id: sessionId }, { method: "POST" });
		return;
	}
	await inv("hide_session", { sessionId });
}

export async function unhideSession(sessionId: string): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) {
		await devFetch("unhide_session", { id: sessionId }, { method: "POST" });
		return;
	}
	await inv("unhide_session", { sessionId });
}

export async function deleteSession(sessionId: string): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) {
		await devFetch("delete_session", { id: sessionId }, { method: "POST" });
		return;
	}
	await inv("delete_session", { sessionId });
}

export async function loadHiddenSessions(
	workspaceId: string,
): Promise<WorkspaceSessionSummary[]> {
	const inv = await getTauriInvoke();
	if (!inv) {
		try {
			return await devFetch<WorkspaceSessionSummary[]>("list_hidden_sessions", {
				id: workspaceId,
			});
		} catch {
			return [];
		}
	}
	try {
		return await inv<WorkspaceSessionSummary[]>("list_hidden_sessions", {
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
