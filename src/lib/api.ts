import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type GroupTone = "done" | "review" | "progress" | "backlog" | "canceled";

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
	codexThinkingLevel?: string | null;
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

type BrowserFixtureName = "workspace-cache";

type BrowserFixtureStats = {
	activeFixture: BrowserFixtureName;
	callCounts: Record<string, number>;
};

declare global {
	interface Window {
		__HELMOR_DEV_FIXTURE_STATS__?: BrowserFixtureStats;
	}
}

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

const DEFAULT_WORKSPACE_GROUPS: WorkspaceGroup[] = [
	{
		id: "done",
		label: "Done",
		tone: "done",
		rows: [
			{
				id: "task-detail",
				title: "feat: task detail window with e...",
				repoInitials: "F",
			},
		],
	},
	{
		id: "review",
		label: "In review",
		tone: "review",
		rows: [
			{
				id: "coda-publish",
				title: "feat: add Coda publish function...",
				repoInitials: "F",
			},
			{
				id: "marketing-site",
				title: "Implement new marketing site ...",
				repoInitials: "I",
			},
			{
				id: "gitlab-publish",
				title: "feat: add GitLab publish suppor...",
				repoInitials: "F",
			},
		],
	},
	{
		id: "progress",
		label: "In progress",
		tone: "progress",
		rows: [
			{
				id: "cambridge",
				title: "Cambridge",
				repoInitials: "C",
			},
			{
				id: "project-paths",
				title: "Show project paths",
				repoInitials: "S",
				hasUnread: true,
			},
			{
				id: "mermaid",
				title: "Investigate mermaid confluence",
				repoInitials: "I",
			},
			{
				id: "seo",
				title: "Feat seo optimization",
				repoInitials: "F",
			},
			{
				id: "autoresearch",
				title: "Explore autoresearch",
				repoInitials: "E",
			},
			{
				id: "chat-list",
				title: "Fix chat list pending",
				repoInitials: "F",
			},
			{
				id: "doc-sync",
				title: "Investigate doc sync",
				repoInitials: "I",
			},
		],
	},
	{
		id: "backlog",
		label: "Backlog",
		tone: "backlog",
		rows: [],
	},
	{
		id: "canceled",
		label: "Canceled",
		tone: "canceled",
		rows: [],
	},
];

const DEFAULT_REPOSITORIES: RepositoryCreateOption[] = [];
const DEFAULT_ADD_REPOSITORY_DEFAULTS: AddRepositoryDefaults = {
	lastCloneDirectory: null,
};

const BROWSER_FIXTURE_WORKSPACE_GROUPS: WorkspaceGroup[] = [
	{
		id: "progress",
		label: "In progress",
		tone: "progress",
		rows: [
			{
				id: "fixture-alpha",
				title: "Fixture Alpha",
				repoName: "helmor-fixtures",
				repoInitials: "HF",
				state: "ready",
				activeSessionId: "fixture-alpha-session-1",
				activeSessionTitle: "Alpha planning",
				activeSessionAgentType: "claude",
				activeSessionStatus: "idle",
				sessionCount: 2,
				messageCount: 6,
				attachmentCount: 0,
			},
			{
				id: "fixture-beta",
				title: "Fixture Beta",
				repoName: "helmor-fixtures",
				repoInitials: "HF",
				state: "ready",
				activeSessionId: "fixture-beta-session-1",
				activeSessionTitle: "Beta launch",
				activeSessionAgentType: "codex",
				activeSessionStatus: "idle",
				sessionCount: 2,
				messageCount: 8,
				attachmentCount: 0,
			},
		],
	},
];

const BROWSER_FIXTURE_WORKSPACE_DETAILS: Record<string, WorkspaceDetail> = {
	"fixture-alpha": {
		id: "fixture-alpha",
		title: "Fixture Alpha",
		repoId: "repo-fixture",
		repoName: "helmor-fixtures",
		repoInitials: "HF",
		remoteUrl: "https://example.com/helmor-fixtures.git",
		defaultBranch: "main",
		rootPath: "/tmp/helmor-fixtures/alpha",
		directoryName: "fixture-alpha",
		state: "ready",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "progress",
		manualStatus: null,
		activeSessionId: "fixture-alpha-session-1",
		activeSessionTitle: "Alpha planning",
		activeSessionAgentType: "claude",
		activeSessionStatus: "idle",
		branch: "main",
		initializationParentBranch: "main",
		intendedTargetBranch: "main",
		notes: null,
		pinnedAt: null,
		prTitle: null,
		prDescription: null,
		archiveCommit: null,
		sessionCount: 2,
		messageCount: 6,
		attachmentCount: 0,
	},
	"fixture-beta": {
		id: "fixture-beta",
		title: "Fixture Beta",
		repoId: "repo-fixture",
		repoName: "helmor-fixtures",
		repoInitials: "HF",
		remoteUrl: "https://example.com/helmor-fixtures.git",
		defaultBranch: "release",
		rootPath: "/tmp/helmor-fixtures/beta",
		directoryName: "fixture-beta",
		state: "ready",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "progress",
		manualStatus: null,
		activeSessionId: "fixture-beta-session-1",
		activeSessionTitle: "Beta launch",
		activeSessionAgentType: "codex",
		activeSessionStatus: "idle",
		branch: "release",
		initializationParentBranch: "main",
		intendedTargetBranch: "main",
		notes: null,
		pinnedAt: null,
		prTitle: null,
		prDescription: null,
		archiveCommit: null,
		sessionCount: 2,
		messageCount: 8,
		attachmentCount: 0,
	},
};

const BROWSER_FIXTURE_WORKSPACE_SESSIONS: Record<
	string,
	WorkspaceSessionSummary[]
> = {
	"fixture-alpha": [
		{
			id: "fixture-alpha-session-1",
			workspaceId: "fixture-alpha",
			title: "Alpha planning",
			agentType: "claude",
			status: "idle",
			model: "opus-1m",
			permissionMode: "default",
			providerSessionId: null,
			unreadCount: 0,
			contextTokenCount: 1200,
			contextUsedPercent: 18,
			thinkingEnabled: true,
			codexThinkingLevel: null,
			fastMode: false,
			agentPersonality: null,
			createdAt: "2026-04-05T01:00:00Z",
			updatedAt: "2026-04-05T01:00:00Z",
			lastUserMessageAt: "2026-04-05T01:05:00Z",
			resumeSessionAt: null,
			isHidden: false,
			isCompacting: false,
			active: true,
		},
		{
			id: "fixture-alpha-session-2",
			workspaceId: "fixture-alpha",
			title: "Alpha review",
			agentType: "claude",
			status: "idle",
			model: "opus-1m",
			permissionMode: "default",
			providerSessionId: null,
			unreadCount: 0,
			contextTokenCount: 980,
			contextUsedPercent: 14,
			thinkingEnabled: true,
			codexThinkingLevel: null,
			fastMode: false,
			agentPersonality: null,
			createdAt: "2026-04-05T01:10:00Z",
			updatedAt: "2026-04-05T01:10:00Z",
			lastUserMessageAt: "2026-04-05T01:12:00Z",
			resumeSessionAt: null,
			isHidden: false,
			isCompacting: false,
			active: false,
		},
	],
	"fixture-beta": [
		{
			id: "fixture-beta-session-1",
			workspaceId: "fixture-beta",
			title: "Beta launch",
			agentType: "codex",
			status: "idle",
			model: "gpt-5.4",
			permissionMode: "default",
			providerSessionId: null,
			unreadCount: 0,
			contextTokenCount: 1340,
			contextUsedPercent: 21,
			thinkingEnabled: true,
			codexThinkingLevel: "high",
			fastMode: true,
			agentPersonality: null,
			createdAt: "2026-04-05T02:00:00Z",
			updatedAt: "2026-04-05T02:00:00Z",
			lastUserMessageAt: "2026-04-05T02:05:00Z",
			resumeSessionAt: null,
			isHidden: false,
			isCompacting: false,
			active: true,
		},
		{
			id: "fixture-beta-session-2",
			workspaceId: "fixture-beta",
			title: "Beta bugfixes",
			agentType: "codex",
			status: "idle",
			model: "gpt-5.4",
			permissionMode: "default",
			providerSessionId: null,
			unreadCount: 0,
			contextTokenCount: 860,
			contextUsedPercent: 11,
			thinkingEnabled: true,
			codexThinkingLevel: "medium",
			fastMode: false,
			agentPersonality: null,
			createdAt: "2026-04-05T02:10:00Z",
			updatedAt: "2026-04-05T02:10:00Z",
			lastUserMessageAt: "2026-04-05T02:14:00Z",
			resumeSessionAt: null,
			isHidden: false,
			isCompacting: false,
			active: false,
		},
	],
};

const BROWSER_FIXTURE_MESSAGES: Record<string, SessionMessageRecord[]> = {
	"fixture-alpha-session-1": [
		createFixtureMessage(
			"fixture-alpha-session-1-user-1",
			"fixture-alpha-session-1",
			"user",
			"Summarize the current alpha launch blockers.",
			"2026-04-05T01:00:10Z",
			"opus-1m",
		),
		createFixtureMessage(
			"fixture-alpha-session-1-assistant-1",
			"fixture-alpha-session-1",
			"assistant",
			"There are three blockers: caching semantics, refresh overlay timing, and sidebar selection reconciliation.",
			"2026-04-05T01:00:20Z",
			"opus-1m",
		),
	],
	"fixture-alpha-session-2": [
		createFixtureMessage(
			"fixture-alpha-session-2-user-1",
			"fixture-alpha-session-2",
			"user",
			"Review the previous patch and identify regressions.",
			"2026-04-05T01:10:10Z",
			"opus-1m",
		),
		createFixtureMessage(
			"fixture-alpha-session-2-assistant-1",
			"fixture-alpha-session-2",
			"assistant",
			"The main regression is that session pending state never settles after workspace switches.",
			"2026-04-05T01:10:22Z",
			"opus-1m",
		),
	],
	"fixture-beta-session-1": [
		createFixtureMessage(
			"fixture-beta-session-1-user-1",
			"fixture-beta-session-1",
			"user",
			"Prepare the beta workspace for release validation.",
			"2026-04-05T02:00:05Z",
			"gpt-5.4",
		),
		createFixtureMessage(
			"fixture-beta-session-1-assistant-1",
			"fixture-beta-session-1",
			"assistant",
			"I have prepared the release checklist, smoke tests, and a rollback plan.",
			"2026-04-05T02:00:19Z",
			"gpt-5.4",
		),
	],
	"fixture-beta-session-2": [
		createFixtureMessage(
			"fixture-beta-session-2-user-1",
			"fixture-beta-session-2",
			"user",
			"Track the beta bugfixes and cache-related UX issues.",
			"2026-04-05T02:10:08Z",
			"gpt-5.4",
		),
		createFixtureMessage(
			"fixture-beta-session-2-assistant-1",
			"fixture-beta-session-2",
			"assistant",
			"The cache should keep already viewed workspaces and sessions hot so revisits avoid cold skeletons.",
			"2026-04-05T02:10:21Z",
			"gpt-5.4",
		),
	],
};

const BROWSER_FIXTURE_ARCHIVED_WORKSPACES: WorkspaceSummary[] = [];
const browserFixtureSeenKeys = new Set<string>();
const browserFixtureCallCounts = new Map<string, number>();

const DEFAULT_ARCHIVED_WORKSPACES: WorkspaceSummary[] = [
	{
		id: "archived-coda-publish",
		title: "feat: add Coda publish function...",
		directoryName: "coda-publish",
		repoName: "sample",
		state: "archived",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "done",
	},
	{
		id: "archived-marketing-site",
		title: "Implement new marketing site ...",
		directoryName: "marketing-site",
		repoName: "sample",
		state: "archived",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "review",
	},
	{
		id: "archived-gitlab-publish",
		title: "feat: add GitLab publish suppor...",
		directoryName: "gitlab-publish",
		repoName: "sample",
		state: "archived",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "review",
	},
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

function createFixtureMessage(
	id: string,
	sessionId: string,
	role: string,
	content: string,
	createdAt: string,
	model: string,
): SessionMessageRecord {
	return {
		id,
		sessionId,
		role,
		content,
		contentIsJson: false,
		createdAt,
		sentAt: createdAt,
		cancelledAt: null,
		model,
		sdkMessageId: null,
		lastAssistantMessageId: null,
		turnId: null,
		isResumableMessage: null,
		attachmentCount: 0,
	};
}

function cloneFixtureValue<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function getBrowserFixtureName(): BrowserFixtureName | null {
	if (typeof window === "undefined") {
		return null;
	}

	const params = new URLSearchParams(window.location.search);
	const fixtureName = params.get("fixture");
	return fixtureName === "workspace-cache" ? fixtureName : null;
}

function getBrowserFixtureFirstLoadDelayMs() {
	if (typeof window === "undefined") {
		return 380;
	}

	const params = new URLSearchParams(window.location.search);
	const rawDelay = params.get("fixtureDelayMs");
	if (!rawDelay) {
		return 380;
	}

	const parsedDelay = Number.parseInt(rawDelay, 10);
	if (!Number.isFinite(parsedDelay) || parsedDelay < 0) {
		return 380;
	}

	return parsedDelay;
}

function recordBrowserFixtureCall(cacheKey: string) {
	const activeFixture = getBrowserFixtureName();
	if (!activeFixture || typeof window === "undefined") {
		return;
	}

	const nextCount = (browserFixtureCallCounts.get(cacheKey) ?? 0) + 1;
	browserFixtureCallCounts.set(cacheKey, nextCount);
	window.__HELMOR_DEV_FIXTURE_STATS__ = {
		activeFixture,
		callCounts: Object.fromEntries(browserFixtureCallCounts.entries()),
	};
}

async function resolveBrowserFixtureValue<T>(
	cacheKey: string,
	value: T | null | undefined,
): Promise<T | null | undefined> {
	const activeFixture = getBrowserFixtureName();
	if (!activeFixture) {
		return undefined;
	}

	recordBrowserFixtureCall(cacheKey);
	const firstLoad = !browserFixtureSeenKeys.has(cacheKey);
	browserFixtureSeenKeys.add(cacheKey);
	const delayMs = firstLoad ? getBrowserFixtureFirstLoadDelayMs() : 40;

	if (delayMs > 0) {
		await new Promise((resolve) => window.setTimeout(resolve, delayMs));
	}

	if (value === undefined) {
		return undefined;
	}

	if (value === null) {
		return null;
	}

	return cloneFixtureValue(value);
}

export function hasTauriRuntime(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function getTauriInvoke(): Promise<TauriInvoke | null> {
	if (!hasTauriRuntime()) {
		return null;
	}

	return invoke as TauriInvoke;
}

export async function loadWorkspaceGroups(): Promise<WorkspaceGroup[]> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		const fixtureGroups = await resolveBrowserFixtureValue(
			"workspaceGroups",
			BROWSER_FIXTURE_WORKSPACE_GROUPS,
		);
		if (fixtureGroups) {
			return fixtureGroups;
		}

		return DEFAULT_WORKSPACE_GROUPS;
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
		return null;
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
		const fixtureArchived = await resolveBrowserFixtureValue(
			"archivedWorkspaces",
			BROWSER_FIXTURE_ARCHIVED_WORKSPACES,
		);
		if (fixtureArchived) {
			return fixtureArchived;
		}

		return DEFAULT_ARCHIVED_WORKSPACES;
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
		const fixtureRepositories = await resolveBrowserFixtureValue(
			"repositories",
			DEFAULT_REPOSITORIES,
		);
		if (fixtureRepositories) {
			return fixtureRepositories;
		}

		return DEFAULT_REPOSITORIES;
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
		const fixtureModels = await resolveBrowserFixtureValue(
			"agentModelSections",
			DEFAULT_AGENT_MODEL_SECTIONS,
		);
		if (fixtureModels) {
			return fixtureModels;
		}

		return DEFAULT_AGENT_MODEL_SECTIONS;
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
		const fixtureDetail = await resolveBrowserFixtureValue(
			`workspaceDetail:${workspaceId}`,
			BROWSER_FIXTURE_WORKSPACE_DETAILS[workspaceId] ?? null,
		);
		if (fixtureDetail !== undefined) {
			return fixtureDetail;
		}

		return null;
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
		throw new Error(
			"Target branch update is only available in the Tauri desktop runtime.",
		);
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
		const fixtureSessions = await resolveBrowserFixtureValue(
			`workspaceSessions:${workspaceId}`,
			BROWSER_FIXTURE_WORKSPACE_SESSIONS[workspaceId] ?? [],
		);
		if (fixtureSessions) {
			return fixtureSessions;
		}

		return [];
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
		const fixtureMessages = await resolveBrowserFixtureValue(
			`sessionMessages:${sessionId}`,
			BROWSER_FIXTURE_MESSAGES[sessionId] ?? [],
		);
		if (fixtureMessages) {
			return fixtureMessages;
		}

		return [];
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
		const fixtureAttachments = await resolveBrowserFixtureValue(
			`sessionAttachments:${sessionId}`,
			[],
		);
		if (fixtureAttachments) {
			return fixtureAttachments;
		}

		return [];
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
		throw new Error(
			"Workspace restore is only available in the Tauri desktop runtime.",
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
		throw new Error(
			"Workspace archive is only available in the Tauri desktop runtime.",
		);
	}

	return invoke<ArchiveWorkspaceResponse>("archive_workspace", {
		workspaceId,
	});
}

export async function createWorkspaceFromRepo(
	repoId: string,
): Promise<CreateWorkspaceResponse> {
	const invoke = await getTauriInvoke();

	if (!invoke) {
		throw new Error(
			"Workspace creation is only available in the Tauri desktop runtime.",
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
			"Repository add is only available in the Tauri desktop runtime.",
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
		throw new Error(
			"Session read tracking is only available in the Tauri desktop runtime.",
		);
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
		throw new Error(
			"Workspace read tracking is only available in the Tauri desktop runtime.",
		);
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
		throw new Error(
			"Workspace unread tracking is only available in the Tauri desktop runtime.",
		);
	}

	return invoke<MarkWorkspaceReadResponse>("mark_workspace_unread", {
		workspaceId,
	});
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
		throw new Error(
			"Streaming is only available in the Tauri desktop runtime.",
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
	return listen<AgentStreamEvent>(`agent-stream:${streamId}`, (tauriEvent) => {
		callback(tauriEvent.payload);
	});
}

export async function stopAgentStream(
	sessionId: string,
	provider?: string,
): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) return;
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
	if (!inv)
		throw new Error("Session creation requires the Tauri desktop runtime.");
	return inv<CreateSessionResponse>("create_session", { workspaceId });
}

export async function renameSession(
	sessionId: string,
	title: string,
): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) return;
	await inv("rename_session", { sessionId, title });
}

export async function hideSession(sessionId: string): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) return;
	await inv("hide_session", { sessionId });
}

export async function unhideSession(sessionId: string): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) return;
	await inv("unhide_session", { sessionId });
}

export async function deleteSession(sessionId: string): Promise<void> {
	const inv = await getTauriInvoke();
	if (!inv) return;
	await inv("delete_session", { sessionId });
}

export async function loadHiddenSessions(
	workspaceId: string,
): Promise<WorkspaceSessionSummary[]> {
	const inv = await getTauriInvoke();
	if (!inv) return [];
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
