import { getCurrentWindow } from "@tauri-apps/api/window";
import type { InspectorFileItem } from "./editor-session";
import { type ErrorCode, extractError } from "./errors";
// `invoke` / `Channel` / `listen` route through the transport shim so the same
// frontend works in the desktop Tauri webview AND when served to a phone
// browser by the companion server. See `src/lib/ipc.ts`.
import { Channel, closeChannel, invoke, listen, type UnlistenFn } from "./ipc";
import { setSessionThreadPaginationState } from "./session-thread-pagination";

export type GroupTone =
	| "pinned"
	| "chats"
	| "done"
	| "review"
	| "progress"
	| "backlog"
	| "canceled"
	| "ai-tasks";

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
 * (`src-tauri/src/workspace/status.rs`). Drives the sidebar status
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
	repoId?: string;
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
	/** Sparse sidebar order. Lower comes first; shared across every grouping
	 * mode (status / repo / pinned). */
	displayOrder?: number;
	/** Sparse order of this row's parent repo bucket. Used in repo grouping
	 * mode to sort buckets. Mirrors `repos.display_order`. */
	repoSidebarOrder?: number;
	/** ISO-8601 timestamp — most recent user message across all sessions
	 * in this workspace. Null when the workspace has no user messages yet. */
	lastUserMessageAt?: string | null;
	/** "manual" or "ai_triage". */
	kind?: string;
	/** True for an ai_triage row still awaiting the user's first send. */
	triagePrimingUnconsumed?: boolean;
	/** Originating triage platform for ai_triage rows: "github" | "gitlab" |
	 *  "slack" | "lark". Absent/null for manual workspaces. Drives the
	 *  source-logo badge shown on AI-proposed sidebar rows. */
	triageSourceType?: string | null;
	/** Stacked PRs: `id` of the workspace one layer below this in a PR stack
	 *  (its base). Absent/null for non-stacked rows. Drives sidebar stack
	 *  grouping — the sidebar nests a stack's members under their tip. */
	parentWorkspaceId?: string | null;
};

/** Per-row stacked-PR connector metadata, attached by the frontend
 *  projection (`nestStacks`) — never sent by the backend. Lets the row
 *  renderer draw the stack-link affordance. */
export type StackRowMeta = {
	/** `tip` = newest member (top of the stack, keeps its natural sort slot);
	 *  `root` = base-most visible member; `mid` = in between. */
	role: "tip" | "mid" | "root";
	/** 0 at the tip, increasing toward the base of the stack. */
	depth: number;
	/** Total number of members in this stack — used for the "k of N" tooltip. */
	stackSize: number;
	/** `id` of the stack's tip — the anchor every member is grouped under. */
	tipId: string;
};

export type WorkspaceGroup = {
	id: string;
	label: string;
	tone: GroupTone;
	rows: WorkspaceRow[];
	/** Frontend-only projection annotation (populated by `nestStacks`, absent
	 *  on backend payloads): stacked-PR connector metadata keyed by row id,
	 *  present only for rows that belong to a multi-member stack. */
	stackMeta?: ReadonlyMap<string, StackRowMeta>;
};

export type DataInfo = {
	dataMode: string;
	dataRoot: string;
	dbPath: string;
	archiveRoot: string;
};

export type AgentProvider = "claude" | "codex" | "cursor" | "opencode";

export type LocalLlmStatus = {
	enabled: boolean;
	runtimeFound: boolean;
	runtimePath?: string | null;
	starting: boolean;
	running: boolean;
	model: string;
	apiModel: string;
	contextSize: number;
	gpuLayers: number;
	reasoningMode: string;
	endpoint?: string | null;
	lastError?: string | null;
};

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

/** Wire strings the sidecars accept for permission mode. Helmor models
 *  permission as a binary: `plan` (read-only) or full access. */
export type PermissionModeLiteral = "plan" | "bypassPermissions";

/** Static capability table for a single provider. Mirrors the Rust
 *  `agents::provider_capabilities::ProviderCapabilities` shape so a
 *  cross-stack provider check is data-driven instead of a scattered
 *  `provider === "codex"` string compare. */
export type ProviderCapabilities = {
	provider: string;
	displayName: string;
	supportsPlanMode: boolean;
	supportsActiveGoal: boolean;
	supportsContextUsage: boolean;
	supportsSteer: boolean;
	supportsSlashCommands: boolean;
	requiresApiKey: boolean;
};

/** UTF-16 code-unit range of one pasted-text tag inside a prompt string. */
export type PastedTextRange = {
	start: number;
	end: number;
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
	/** UTF-16 ranges of pasted-text tag spans inside `prompt` (composer
	 *  badge pastes — see `locatePastedTextRanges`). Persisted with the
	 *  user_prompt so those spans render as tag chips; the agent still
	 *  receives the full prompt text. */
	pastedTexts?: PastedTextRange[] | null;
};

export type WorkspaceSummary = {
	id: string;
	title: string;
	directoryName: string;
	repoId: string;
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
	/** Sparse sidebar order. Mirrors `WorkspaceRow.displayOrder`; carried
	 * through the archived list so restore can predict the live-group
	 * position without waiting for refetch. */
	displayOrder?: number;
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
	/** Stacked-PR parent link. When set, the header renders a live
	 * "→ <parent title>" chip (click to navigate) instead of the raw
	 * target-branch picker. */
	parentWorkspaceId?: string | null;
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
	/** `RunAction.id` the user last picked from the Run-tab dropdown in
	 * this workspace. NULL means "use the first action" — either fresh,
	 * or because the previously-active action was deleted. */
	activeRunActionId?: string | null;
	/** True when this workspace was auto-spawned by triage and the user
	 * hasn't sent their first message yet. Drives the composer's
	 * Start / Dismiss quick-action row. */
	triagePrimingUnconsumed?: boolean;
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
	/** "gui" (SDK chat session) or "terminal" (live PTY in the message area).
	 * Optional for test mocks / optimistic rows; absent is treated as "gui". */
	sessionKind?: "gui" | "terminal";
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

/** Mirrors `workspace::archive::ArchiveOrigin`. `manual` drives the existing
 *  `pendingArchives` + `archiveGate` UI flow; `autoAfterMerge` has no
 *  optimistic state and needs the controller to reconcile + use a calmer
 *  failure toast on its own. */
export type ArchiveOrigin = "manual" | "autoAfterMerge";

export type ArchiveExecutionFailedPayload = {
	workspaceId: string;
	code: ErrorCode;
	message: string;
	origin: ArchiveOrigin;
};

export type ArchiveExecutionSucceededPayload = {
	workspaceId: string;
	origin: ArchiveOrigin;
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
	/** Echo of the branch-intent the workspace was created with. */
	branchIntent: WorkspaceBranchIntent;
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

/** Auth verdict for a workspace's bound forge account. Action points gate
 * on `"loggedOut"`; other states proceed. */
export type ForgeAuthState =
	| "loggedIn"
	| "loggedOut"
	| "indeterminate"
	| "notApplicable";

export async function checkWorkspaceForgeAuth(
	workspaceId: string,
): Promise<ForgeAuthState> {
	try {
		return await invoke<ForgeAuthState>("check_workspace_forge_auth", {
			workspaceId,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to check forge authentication."),
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

export type OsGlobalHotkeyId = "global.hotkey" | "quickPanel.hotkey";

export async function syncGlobalHotkey(
	id: OsGlobalHotkeyId,
	hotkey: string | null,
): Promise<void> {
	try {
		await invoke<void>("sync_global_hotkey", { id, hotkey });
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to set global hotkey."));
	}
}

export async function toggleQuickPanel(): Promise<void> {
	return invoke<void>("toggle_quick_panel");
}

export async function hideQuickPanel(): Promise<void> {
	return invoke<void>("hide_quick_panel");
}

export async function revealWorkspaceInMainWindow(
	workspaceId: string,
	sessionId: string | null,
): Promise<void> {
	return invoke<void>("reveal_workspace_in_main_window", {
		workspaceId,
		sessionId,
	});
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

/**
 * Combined snapshot for the Settings → General "Helmor components"
 * row. Pairs the live CLI / Skills status with whatever the per-version
 * silent startup check cached. `lastCheckedVersion === currentVersion`
 * means the silent pass finished cleanly for this build; mismatch (or
 * null) means it never completed and the panel should surface a nudge.
 */
export type HelmorComponentsUpdateCheck = {
	cli: CliStatus;
	skills: HelmorSkillsStatus;
	lastCheckedVersion: string | null;
	currentVersion: string;
	cliError: string | null;
	skillsError: string | null;
};

export async function getHelmorComponentsUpdateCheck(): Promise<HelmorComponentsUpdateCheck> {
	return await invoke<HelmorComponentsUpdateCheck>(
		"get_helmor_components_update_check",
	);
}

export async function recheckHelmorComponents(): Promise<HelmorComponentsUpdateCheck> {
	return await invoke<HelmorComponentsUpdateCheck>("recheck_helmor_components");
}

export async function enterOnboardingWindowMode(): Promise<void> {
	await invoke("enter_onboarding_window_mode");
}

export async function exitOnboardingWindowMode(): Promise<void> {
	await invoke("exit_onboarding_window_mode");
}

export async function enterMiniWindowMode(): Promise<void> {
	await invoke("enter_mini_window_mode");
}

export async function exitMiniWindowMode(): Promise<void> {
	await invoke("exit_mini_window_mode");
}

export async function toggleMiniWindowMode(): Promise<boolean> {
	return await invoke("toggle_mini_window_mode");
}

export type AgentLoginProvider = "claude" | "codex" | "cursor" | "opencode";

export type AgentLoginStatusResult = {
	claude: boolean;
	codex: boolean;
	cursor: boolean;
	opencode: boolean;
	codexProvider?: string | null;
	codexAuthMethod?: "login" | "apiKey" | string | null;
};

export async function getAgentLoginStatus(): Promise<AgentLoginStatusResult> {
	return await invoke<AgentLoginStatusResult>("get_agent_login_status");
}

// Cursor is an SDK (no versioned CLI), so it has no entry.
export type AgentVersionsResult = {
	claude: string | null;
	codex: string | null;
	opencode: string | null;
};

export async function getAgentVersions(): Promise<AgentVersionsResult> {
	return await invoke<AgentVersionsResult>("get_agent_versions");
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

// Close (hide) the main window. Routes through the Rust `CloseRequested`
// interceptor, which on macOS hides the window and keeps the app running in
// the Dock (reopened by clicking the Dock icon). Used by Cmd+W on the last
// tab and by Cmd+Shift+W.
export async function closeMainWindow(): Promise<void> {
	await getCurrentWindow().close();
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

/** Static provider-capability table. Backed by the Rust source of truth
 *  in `agents::provider_capabilities`; callers cache the result for the
 *  lifetime of the app and look up rows by `provider`. */
export async function loadProviderCapabilities(): Promise<
	ProviderCapabilities[]
> {
	return invoke<ProviderCapabilities[]>("list_provider_capabilities");
}

/** Local mirror of the Rust default table
 *  (`agents::provider_capabilities::capabilities_for_provider` over
 *  `KNOWN_PROVIDERS`). Used as `initialData` for the provider-capability
 *  query so that on a cold start — before the persisted cache or the
 *  `list_provider_capabilities` IPC has hydrated — consumers already read
 *  the correct flags (e.g. Codex `supportsActiveGoal === true`). An empty
 *  `[]` initialData would instead make Codex read `supportsActiveGoal ===
 *  false` and silently disable `/goal` interception + the stop-stream goal
 *  pause during that window. Keep this in lock-step with the Rust table;
 *  the live query reconciles any drift via a background refetch. */
export const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities[] = [
	{
		provider: "claude",
		displayName: "Claude",
		supportsPlanMode: true,
		supportsActiveGoal: false,
		supportsContextUsage: true,
		supportsSteer: true,
		supportsSlashCommands: true,
		requiresApiKey: false,
	},
	{
		provider: "codex",
		displayName: "Codex",
		supportsPlanMode: true,
		supportsActiveGoal: true,
		supportsContextUsage: true,
		supportsSteer: true,
		supportsSlashCommands: true,
		requiresApiKey: false,
	},
	{
		provider: "cursor",
		displayName: "Cursor",
		supportsPlanMode: true,
		supportsActiveGoal: false,
		supportsContextUsage: false,
		supportsSteer: false,
		supportsSlashCommands: true,
		requiresApiKey: true,
	},
	{
		provider: "opencode",
		displayName: "OpenCode",
		supportsPlanMode: true,
		supportsActiveGoal: false,
		supportsContextUsage: true,
		supportsSteer: true,
		supportsSlashCommands: true,
		requiresApiKey: false,
	},
];

/** Look up a single provider's capabilities from a previously-fetched
 *  table. Returns `null` when the provider id isn't represented — the
 *  composer treats that as "use Claude's safe defaults", matching the
 *  Rust helper's fallback. */
export function findProviderCapabilities(
	table: readonly ProviderCapabilities[],
	provider: string,
): ProviderCapabilities | null {
	return table.find((caps) => caps.provider === provider) ?? null;
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

export type OpencodeModelEntry = {
	// `<providerID>/<modelID>` slug — doubles as the cliModel.
	id: string;
	label: string;
	// Effort tiers (the model's `variants` keys). Empty ⟺ no effort switch.
	effortLevels?: string[];
};

// `forceReload` restarts the opencode server to pick up config changes.
export async function listOpencodeModels(
	forceReload = false,
): Promise<OpencodeModelEntry[]> {
	try {
		return await invoke<OpencodeModelEntry[]>("list_opencode_models", {
			forceReload,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to list opencode models."),
		);
	}
}

export type OpencodeCustomModel = {
	id: string;
	name: string;
	// Only set true when the upstream endpoint accepts a reasoning effort.
	reasoning: boolean;
};

export type OpencodeCustomProvider = {
	id: string;
	name: string;
	// `@ai-sdk/openai-compatible` (/v1/chat/completions) or `@ai-sdk/openai` (/v1/responses).
	npm: string;
	baseUrl: string;
	apiKey: string;
	headers: Record<string, string>;
	models: OpencodeCustomModel[];
};

export async function getOpencodeCustomProviders(): Promise<
	OpencodeCustomProvider[]
> {
	try {
		return await invoke<OpencodeCustomProvider[]>(
			"get_opencode_custom_providers",
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to read opencode config."),
		);
	}
}

// `preset` sets only `options.apiKey` (opencode fills npm/baseURL/models);
// non-preset writes the full custom block.
export async function upsertOpencodeCustomProvider(
	provider: OpencodeCustomProvider,
	preset: boolean,
): Promise<void> {
	try {
		await invoke("upsert_opencode_custom_provider", { provider, preset });
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to save opencode provider."),
		);
	}
}

export async function deleteOpencodeCustomProvider(id: string): Promise<void> {
	try {
		await invoke("delete_opencode_custom_provider", { id });
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to delete opencode provider."),
		);
	}
}

// ---------------------------------------------------------------------------
// Inbox (start-surface left sidebar)
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

/** One row of the start-page branch picker. */
export type BranchPickerEntry = {
	name: string;
	hasLocal: boolean;
	hasRemote: boolean;
};

/**
 * Merged local + remote branches with source flags so the picker can
 * show an icon and the pill can decide whether to prefix with `origin/`.
 * Pure local fs reads — no network.
 */
export async function listBranchesForWorkspacePicker(
	repoId: string,
): Promise<BranchPickerEntry[]> {
	try {
		return await invoke<BranchPickerEntry[]>(
			"list_branches_for_workspace_picker",
			{ repoId },
		);
	} catch (error) {
		console.warn("[helmor] listBranchesForWorkspacePicker failed:", error);
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

/**
 * How a workspace's filesystem is provisioned.
 * - `worktree`: a dedicated git worktree with its own auto-named branch.
 * - `local`: operates directly on the source repo's root path.
 * - `chat`: a scratch dir under `<data_dir>/chats/<YYYY-MM-DD>/<name>`
 *   with no git context. "Just Chat" mode from the start page.
 */
export type WorkspaceMode = "worktree" | "local" | "chat";

/** `from_branch`: fork off the picked base. `use_branch`: attach to it. */
export type WorkspaceBranchIntent = "from_branch" | "use_branch";

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

// ────────────────────────────────────────────────────────────────────────
// Slack context source (read-only v1).
//
// Wire shapes mirror `src-tauri/src/slack/types.rs` exactly. Auth is
// `slackImportFromDesktop` — we read the xoxc/xoxd pair out of the
// user's local Slack desktop install. All reads then go through the
// Slack Web API client in `src-tauri/src/slack/api.rs`.
//
// The frontend never sees the captured tokens; it only ever holds the
// non-secret workspace metadata (team id / name / domain / our user id).
// ────────────────────────────────────────────────────────────────────────

export type SlackWorkspace = {
	teamId: string;
	teamName: string;
	teamDomain: string;
	myUserId: string;
	addedAt: number;
};

export type SlackInboxItemKind = "mention" | "direct_message";

export type SlackInboxItem = {
	id: string;
	teamId: string;
	channelId: string;
	channelLabel: string;
	kind: SlackInboxItemKind;
	ts: string;
	threadTs: string | null;
	authorName: string;
	/** `image_72` from `users.info`. `null` when the user lookup misses
	 *  or the workspace strips profile images. UI falls back to initials. */
	authorAvatarUrl: string | null;
	textSnippet: string;
	tsMillis: number;
	permalink: string;
};

export type SlackInboxPage = {
	items: SlackInboxItem[];
	nextCursor: string | null;
};

export type SlackReactionSummary = {
	name: string;
	count: number;
};

/** Inline file attachment surfaced in the thread detail view. Preview
 *  URLs are pre-rewritten into our `slack-file://` custom protocol so
 *  the webview can fetch them through the workspace cookie proxy. */
export type SlackFileRef = {
	id: string;
	name: string;
	mimetype: string | null;
	/** Renderer hint. Drives whether we embed `<img>`, `<video>`, or a
	 *  download link. */
	category: "image" | "gif" | "video" | "audio" | "pdf" | "other";
	/** Inline thumbnail / static frame, sized for the detail panel.
	 *  `null` for categories we don't preview inline. */
	previewUrl: string | null;
	/** Full-resolution source for click-through or `<video>` playback.
	 *  Always lives on the `slack-file://` protocol. */
	sourceUrl: string | null;
	/** Slack web link — opens the file in the user's browser, useful for
	 *  PDFs and unsupported file types. */
	permalink: string | null;
	width: number | null;
	height: number | null;
};

export type SlackMessage = {
	ts: string;
	userId: string | null;
	authorName: string;
	authorAvatarUrl: string | null;
	text: string;
	tsMillis: number;
	reactions: SlackReactionSummary[];
	files: SlackFileRef[];
};

export type SlackThreadDetail = {
	teamId: string;
	channelId: string;
	channelLabel: string;
	isThread: boolean;
	messages: SlackMessage[];
	permalink: string;
};

export type SlackImportFailure = {
	teamId: string;
	teamName: string;
	reason: string;
};

export type SlackImportResult = {
	imported: SlackWorkspace[];
	failed: SlackImportFailure[];
	alreadyConnected: SlackWorkspace[];
};

/** Read the user's local Slack desktop session (currently wired on macOS) and
 *  import every workspace whose token still authenticates. Strictly
 *  better UX than the webview-based connect flow when it works because
 *  it reuses whatever auth state Slack desktop already negotiated —
 *  passkeys, SSO, admin-enforced 2FA all become non-issues. */
export async function slackImportFromDesktop(): Promise<SlackImportResult> {
	try {
		return await invoke<SlackImportResult>("slack_import_from_desktop");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Couldn't read Slack desktop session."),
		);
	}
}

export async function slackListWorkspaces(): Promise<SlackWorkspace[]> {
	try {
		return await invoke<SlackWorkspace[]>("slack_list_workspaces");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Couldn't load Slack workspaces."),
		);
	}
}

export async function slackDisconnectWorkspace(teamId: string): Promise<void> {
	try {
		await invoke<void>("slack_disconnect_workspace", { teamId });
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Couldn't disconnect Slack workspace."),
		);
	}
}

export async function slackListInboxItems(args: {
	teamId: string;
	cursor?: string | null;
	limit?: number;
}): Promise<SlackInboxPage> {
	try {
		return await invoke<SlackInboxPage>("slack_list_inbox_items", {
			teamId: args.teamId,
			cursor: args.cursor ?? null,
			limit: args.limit ?? 30,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Couldn't load Slack inbox items."),
		);
	}
}

/** Sort mode forwarded to Slack `search.messages`. Mirrors the backend
 *  `SlackSearchSort` enum — keep these two in lockstep. */
export type SlackSearchSort = "newest" | "relevance";

/** Run a free-text query against `search.messages` for one workspace.
 *  The query string is sent verbatim, so Slack search modifiers
 *  (`from:@alice`, `in:#chan`, `has:link`, `is:thread`, quoted phrases,
 *  `-` negation, `OR`, …) compose without us having to teach the UI
 *  about each one. Empty input short-circuits to zero results to avoid
 *  burning a request on a match-everything query. */
export async function slackSearchMessages(args: {
	teamId: string;
	query: string;
	sort?: SlackSearchSort;
	cursor?: string | null;
	limit?: number;
}): Promise<SlackInboxPage> {
	try {
		return await invoke<SlackInboxPage>("slack_search_messages", {
			teamId: args.teamId,
			query: args.query,
			sort: args.sort ?? "newest",
			cursor: args.cursor ?? null,
			limit: args.limit ?? 30,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Couldn't search Slack messages."),
		);
	}
}

export async function slackGetThreadDetail(args: {
	teamId: string;
	channelId: string;
	threadTs: string | null;
	anchorTs: string;
}): Promise<SlackThreadDetail> {
	try {
		return await invoke<SlackThreadDetail>("slack_get_thread_detail", {
			teamId: args.teamId,
			channelId: args.channelId,
			threadTs: args.threadTs,
			anchorTs: args.anchorTs,
		});
	} catch (error) {
		throw new Error(describeInvokeError(error, "Couldn't load Slack thread."));
	}
}

/** Progress events streamed back by `slackPrepareThreadContext`. */
export type SlackPrepareProgress =
	| { stage: "fetchingThread" }
	| { stage: "cachingFiles"; current: number; total: number };

export type SlackPreparedContext = {
	/** Final prompt-friendly string ready to inject into the composer
	 *  as a single `custom-tag`. Mentions each image / gif / video
	 *  poster file with a parallel `Attached as image (local path: …)`
	 *  hint — the actual pixels reach the agent through the image
	 *  attachments below, not via this text. */
	submitText: string;
	filesTotal: number;
	filesCached: number;
	/** Absolute local paths of every cached image / gif / video poster
	 *  in chronological message order, de-duped by Slack file id.
	 *  Frontend wraps each in a `kind: "image"` ComposerInsertItem so
	 *  the composer's existing pipeline carries them to the spawned
	 *  agent as vision input (Claude image block / Codex localImage
	 *  part) — agent sees pixels without invoking the Read tool. */
	imagePaths: string[];
};

/** Prepare a Slack thread for "Add to context" injection. Fetches the
 *  full thread, pre-warms the on-disk Slack file cache for every
 *  inline image/gif/video poster, then returns a formatted prompt
 *  string with absolute local paths embedded so the spawned coding
 *  agent can `Read` the files.
 *
 *  `onProgress` (when provided) receives streaming events: starting
 *  with `fetchingThread`, then a series of `cachingFiles` with
 *  monotonically increasing `current`, finishing with `done`. */
export async function slackPrepareThreadContext(args: {
	teamId: string;
	channelId: string;
	threadTs: string | null;
	anchorTs: string;
	onProgress?: (event: SlackPrepareProgress) => void;
}): Promise<SlackPreparedContext> {
	const progress = new Channel<SlackPrepareProgress>();
	if (args.onProgress) {
		progress.onmessage = args.onProgress;
	}
	try {
		return await invoke<SlackPreparedContext>("slack_prepare_thread_context", {
			progress,
			teamId: args.teamId,
			channelId: args.channelId,
			threadTs: args.threadTs,
			anchorTs: args.anchorTs,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Couldn't prepare Slack context."),
		);
	}
}

/** Workspace custom-emoji map (`name -> image url`). Built-in unicode
 *  emojis are not included here — those ship bundled with the frontend.
 *  Aliases are resolved server-side, so every returned value is a real
 *  image URL. */
export async function slackListEmoji(
	teamId: string,
): Promise<Record<string, string>> {
	try {
		return await invoke<Record<string, string>>("slack_list_emoji", {
			teamId,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Couldn't load Slack emoji catalogue."),
		);
	}
}

export type UiMutationEvent =
	| { type: "workspaceListChanged" }
	| { type: "workspaceChanged"; workspaceId: string }
	| { type: "sessionListChanged"; workspaceId: string }
	| { type: "contextUsageChanged"; sessionId: string }
	| { type: "codexGoalChanged"; sessionId: string }
	| { type: "sessionPlanChanged"; sessionId: string }
	| { type: "sessionMessagesAppended"; sessionId: string }
	| { type: "sessionTurnPersisted"; sessionId: string }
	| { type: "workspaceFilesChanged"; workspaceId: string }
	| { type: "workspaceGitStateChanged"; workspaceId: string }
	| { type: "workspaceForgeChanged"; workspaceId: string }
	| { type: "workspaceChangeRequestChanged"; workspaceId: string }
	| { type: "repositoryListChanged" }
	| { type: "repositoryChanged"; repoId: string }
	| { type: "repoRunActionsChanged"; repoId: string }
	| { type: "settingsChanged"; key: string | null }
	| {
			type: "pendingCliSendQueued";
			workspaceId: string;
			sessionId: string;
			prompt: string;
			modelId: string | null;
			permissionMode: string | null;
	  }
	| { type: "activeStreamsChanged" }
	| { type: "slackWorkspacesChanged" }
	| { type: "slackTokenInvalidated"; teamId: string }
	| { type: "triageConfigChanged" }
	| { type: "triageActiveStatusChanged" }
	| { type: "triageWorkspaceCreated"; workspaceId: string }
	| { type: "fastModeUnavailable"; sessionId: string; reason: string }
	| { type: "pairedDevicesChanged" }
	| { type: "terminalSessionIdle"; sessionId: string; workspaceId: string }
	| {
			type: "terminalPromptCaptured";
			sessionId: string;
			workspaceId: string;
			prompt: string;
	  }
	| {
			type: "workspaceRevealRequested";
			workspaceId: string;
			sessionId: string | null;
	  };

export type TriageConfig = {
	enabled: boolean;
	/** False = scheduler doesn't auto-fire; Run-now still works. */
	autoRun: boolean;
	systemPrompt: string;
	maxPerTick: number;
};

export type TriageCandidateRow = {
	id: string;
	source: string;
	sourceKind: string;
	sourceRef: string;
	sourceParent: string | null;
	sourceTime: string;
	sender: string | null;
	title: string | null;
	preview: string | null;
	externalUrl: string | null;
	payloadPath: string;
	payloadBytes: number;
	decision: string | null;
};

export async function listOpenTriageCandidates(
	limit = 20,
): Promise<TriageCandidateRow[]> {
	try {
		return await invoke<TriageCandidateRow[]>("list_open_triage_candidates", {
			limit,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load triage candidates."),
		);
	}
}

export async function countOpenTriageCandidates(): Promise<number> {
	try {
		return await invoke<number>("count_open_triage_candidates");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to count triage candidates."),
		);
	}
}

export async function readTriageCandidate(
	candidateId: string,
	grep?: string,
): Promise<string> {
	try {
		return await invoke<string>("read_triage_candidate", {
			candidateId,
			grep,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to read triage candidate."),
		);
	}
}

export async function recordTriageDecision(
	candidateId: string,
	decision: string,
	reason?: string,
): Promise<void> {
	try {
		await invoke<void>("record_triage_decision", {
			candidateId,
			decision,
			reason,
		});
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to record triage decision."),
		);
	}
}

export type TriageSourceHealthState =
	| "ok"
	| "notInstalled"
	| "notAuthed"
	| "notConfigured"
	| "degraded";

export type TriageSourceHealth = {
	source: string;
	displayName: string;
	state: TriageSourceHealthState;
	detail: string;
};

export async function getTriageSourceHealth(): Promise<TriageSourceHealth[]> {
	try {
		return await invoke<TriageSourceHealth[]>("get_triage_source_health");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load triage source health."),
		);
	}
}

export type LarkAuthAction = "install" | "signIn";

export async function spawnLarkCliAuthTerminal(
	action: LarkAuthAction,
	instanceId: string,
	onEvent: (event: ScriptEvent) => void,
): Promise<void> {
	const channel = new Channel<ScriptEvent>();
	channel.onmessage = onEvent;
	await invoke("spawn_lark_cli_auth_terminal", {
		action,
		instanceId,
		channel,
	});
}

export async function stopLarkCliAuthTerminal(
	action: LarkAuthAction,
	instanceId: string,
): Promise<boolean> {
	return invoke<boolean>("stop_lark_cli_auth_terminal", {
		action,
		instanceId,
	});
}

export async function writeLarkCliAuthTerminalStdin(
	action: LarkAuthAction,
	instanceId: string,
	data: string,
): Promise<boolean> {
	return invoke<boolean>("write_lark_cli_auth_terminal_stdin", {
		action,
		instanceId,
		data,
	});
}

export async function resizeLarkCliAuthTerminal(
	action: LarkAuthAction,
	instanceId: string,
	cols: number,
	rows: number,
): Promise<boolean> {
	return invoke<boolean>("resize_lark_cli_auth_terminal", {
		action,
		instanceId,
		cols,
		rows,
	});
}

export type TriageToolCallRecord = {
	at: string;
	tool: string;
	argsPreview: string;
};

export type TriageActiveStatus = {
	tickId: string;
	startedAt: string;
	turnCount: number;
	toolCount: number;
	lastToolName: string | null;
	lastUpdateAt: string;
	recentToolCalls: TriageToolCallRecord[];
	/** 1-indexed current batch; 0 = haven't started a batch yet. */
	batchIndex: number;
	/** Upper bound on batches this tick will run. */
	batchTotal: number;
};

export type TickOutcome =
	| { kind: "createdWorkspaces"; count: number }
	| { kind: "noActionableItems" }
	| { kind: "cancelled" }
	| { kind: "failed"; message: string };

export type LastTickOutcome = {
	at: string;
	tickId: string;
	outcome: TickOutcome;
	/** Agent's final assistant text, when present. */
	summary: string | null;
};

export type TriageStatus = {
	active: TriageActiveStatus | null;
	lastOutcome: LastTickOutcome | null;
};

export async function getTriageConfig(): Promise<TriageConfig> {
	try {
		return await invoke<TriageConfig>("get_triage_config");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load triage settings."),
		);
	}
}

export async function updateTriageConfig(config: TriageConfig): Promise<void> {
	try {
		await invoke<void>("update_triage_config", { config });
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to save triage settings."),
		);
	}
}

export async function getTriageActiveStatus(): Promise<TriageStatus> {
	try {
		return await invoke<TriageStatus>("get_triage_active_status");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load triage status."),
		);
	}
}

export async function triggerTriageTickNow(): Promise<string> {
	try {
		return await invoke<string>("trigger_triage_tick_now");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to trigger triage tick."),
		);
	}
}

export async function cancelTriageTick(): Promise<boolean> {
	try {
		return await invoke<boolean>("cancel_triage_tick");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to cancel triage tick."),
		);
	}
}

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
	const subscriptionId = crypto.randomUUID();
	const onEvent = new Channel<UiMutationEvent>();
	onEvent.onmessage = callback;
	await invoke("subscribe_ui_mutations", { subscriptionId, onEvent });
	return () => {
		onEvent.onmessage = () => {};
		closeChannel(onEvent);
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

export type SessionThreadMessagesPage = {
	messages: ThreadMessageLike[];
	hasMore: boolean;
};

/**
 * Default tail window for session message loads. Mirrored in
 * `query-client.ts` as `SESSION_THREAD_DEFAULT_TAIL_LIMIT` — keep in sync.
 */
export const DEFAULT_SESSION_THREAD_TAIL_LIMIT = 200;

/**
 * Raw page fetch — returns both messages and the `hasMore` flag.
 *
 * Lower-level than `loadSessionThreadMessages`. Used by the React Query
 * queryFn (which then updates the pagination store) and by the
 * "Load earlier" expand path (which needs `hasMore` after each fetch).
 */
export async function fetchSessionThreadMessagesPage(
	sessionId: string,
	options?: { tailLimit?: number | null },
): Promise<SessionThreadMessagesPage> {
	const tailLimit =
		options?.tailLimit === undefined
			? DEFAULT_SESSION_THREAD_TAIL_LIMIT
			: options.tailLimit;
	try {
		return await invoke<SessionThreadMessagesPage>(
			"list_session_thread_messages",
			{
				sessionId,
				tailLimit,
			},
		);
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to load session thread messages."),
		);
	}
}

/**
 * Load session messages as pipeline-rendered ThreadMessageLike[].
 *
 * Thin wrapper over `fetchSessionThreadMessagesPage` that drops
 * `hasMore` for callers wanting just the array. As a side effect this
 * also updates the pagination store so the React Query path (which
 * calls this for trivial mockability) keeps `hasMore` / `loadedTailLimit`
 * in sync with the cache.
 *
 * Pass `tailLimit: null` (e.g. full session export) to skip the store
 * update — that path lives under a different cache key and should not
 * stomp the live panel's pagination state.
 */
export async function loadSessionThreadMessages(
	sessionId: string,
	options?: { tailLimit?: number | null },
): Promise<ThreadMessageLike[]> {
	const page = await fetchSessionThreadMessagesPage(sessionId, options);
	if (options?.tailLimit !== null) {
		const tailLimit =
			options?.tailLimit === undefined
				? DEFAULT_SESSION_THREAD_TAIL_LIMIT
				: options.tailLimit;
		setSessionThreadPaginationState(sessionId, {
			hasMore: page.hasMore,
			loadedTailLimit: tailLimit,
		});
	}
	return page.messages;
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

export async function openFileInEditor(
	path: string,
	editor: string,
): Promise<void> {
	await invoke("open_file_in_editor", { path, editor });
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

export async function listWorkspaceChanges(
	workspaceRootPath: string,
	workspaceId?: string | null,
): Promise<InspectorFileItem[]> {
	try {
		return await invoke<InspectorFileItem[]>("list_workspace_changes", {
			workspaceRootPath,
			workspaceId: workspaceId ?? null,
		});
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

export type ActionStatusKind =
	| "success"
	| "skipped"
	| "pending"
	| "running"
	| "failure";
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
	mergeStateStatus?: string | null;
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

export interface CleanupArchivedFailure {
	workspaceId: string;
	title: string;
	message: string;
}

export interface CleanupArchivedWorkspacesResponse {
	deletedCount: number;
	failures: CleanupArchivedFailure[];
}

/**
 * Permanently delete every archived workspace, one at a time, through the
 * same backend path as `permanentlyDeleteWorkspace`. Resolves when the
 * whole run finishes; the run is backend-owned, so it completes even if
 * the caller unmounts mid-flight.
 */
export async function cleanupArchivedWorkspaces(): Promise<CleanupArchivedWorkspacesResponse> {
	return invoke<CleanupArchivedWorkspacesResponse>(
		"cleanup_archived_workspaces",
	);
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
 * `sourceBranch` is the fork base for `from_branch` (default) or the
 * branch to attach to for `use_branch` (required).
 */
export async function prepareWorkspaceFromRepo(
	repoId: string,
	sourceBranch?: string | null,
	mode?: WorkspaceMode | null,
	branchIntent?: WorkspaceBranchIntent | null,
	initialStatus?: WorkspaceStatus | null,
	/** Pre-allocated session UUID, so pre-submit paste-cache files
	 *  (`cache/paste/<seedSessionId>/`) end up owned by the new session.
	 *  Omit unless the caller is pre-allocating. */
	seedSessionId?: string | null,
): Promise<PrepareWorkspaceResponse> {
	return invoke<PrepareWorkspaceResponse>("prepare_workspace_from_repo", {
		repoId,
		sourceBranch: sourceBranch ?? null,
		mode: mode ?? null,
		branchIntent: branchIntent ?? null,
		initialStatus: initialStatus ?? null,
		seedSessionId: seedSessionId ?? null,
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

/**
 * One-shot creation of a Chat-mode workspace. Chat workspaces aren't
 * bound to any repo — they're a scratch dir under
 * `<data_dir>/chats/<YYYY-MM-DD>/new-chat[-N]` used as cwd for a plain
 * AI chat session. No `finalize_*` follow-up — the row is `ready`
 * immediately.
 */
export async function prepareChatWorkspace(
	initialStatus?: WorkspaceStatus | null,
	/** See `prepareWorkspaceFromRepo`'s `seedSessionId`. */
	seedSessionId?: string | null,
): Promise<PrepareWorkspaceResponse> {
	return invoke<PrepareWorkspaceResponse>("prepare_chat_workspace", {
		initialStatus: initialStatus ?? null,
		seedSessionId: seedSessionId ?? null,
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

/**
 * Sidebar drag drop. `targetGroupId` matches the frontend grouping ids:
 *   - `"pinned"`
 *   - a status lane: `"done"` / `"review"` / `"progress"` / `"backlog"` / `"canceled"`
 *   - a repo bucket: `"repo:<repoId>"`
 *
 * The backend rewrites status / pinned_at / display_order on a single row
 * in the common case; only the gap-exhausted fallback rebalances neighbours.
 */
export async function moveWorkspaceInSidebar(
	workspaceId: string,
	targetGroupId: string,
	beforeWorkspaceId: string | null,
): Promise<void> {
	return invoke<void>("move_workspace_in_sidebar", {
		workspaceId,
		targetGroupId,
		beforeWorkspaceId,
	});
}

/** Drag-reorder a repo bucket in the sidebar's repo grouping mode.
 *  `beforeRepoId === null` appends to the end. */
export async function moveRepositoryInSidebar(
	repoId: string,
	beforeRepoId: string | null,
): Promise<void> {
	return invoke<void>("move_repository_in_sidebar", {
		repoId,
		beforeRepoId,
	});
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
export type WorkflowAgentStatus = "running" | "done";
export type WorkflowAgentRow = {
	label: string;
	status: WorkflowAgentStatus;
	resultPreview?: string;
	/** Phase grouping back-refs, for the `workflow -> phase -> agent` drill-down. */
	phaseIndex?: number;
	phaseTitle?: string;
	/** Per-agent metrics surfaced in the agent detail view. */
	model?: string;
	tokens?: number;
	toolCalls?: number;
	durationMs?: number;
};
export type WorkflowStatus = "running" | "completed" | "failed" | "stopped";
/** A Claude Code "Dynamic Workflow" run — the `Workflow` tool call plus its
 *  aggregated `task_*` lifecycle, rendered as one evolving card. */
export type WorkflowPart = {
	type: "workflow";
	id: string;
	name: string;
	status: WorkflowStatus;
	agents?: WorkflowAgentRow[];
	totalTokens?: number;
	durationMs?: number;
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
/** A span of the user's prompt that entered the composer as a pasted-text
 *  tag badge. Renders as the same tag chip (hover previews the content);
 *  the text itself is still part of the prompt the agent received. */
export type PastedTextPart = {
	type: "pasted-text";
	id: string;
	text: string;
};
/** One option inside a `UserQuestionPart` question. */
export type UserQuestionOption = {
	label: string;
	description?: string | null;
	preview?: string | null;
};
export type UserQuestionItem = {
	question: string;
	header?: string | null;
	multiSelect?: boolean;
	options?: UserQuestionOption[];
	/** Whether a free-text "Other" answer is allowed (Codex `isOther`). */
	allowFreeText?: boolean;
};
export type UserQuestionStatus =
	| "pending"
	| "answered"
	| "declined"
	| "cancelled";
/**
 * Normalized agent→user question card — one shape for Claude
 * AskUserQuestion, Codex `requestUserInput` and OpenCode `question`.
 * `answers` maps question text → answer string (multi-select answers are
 * comma-joined labels; free-text answers pass through verbatim).
 */
export type UserQuestionPart = {
	type: "user-question";
	id: string;
	source: string;
	questions: UserQuestionItem[];
	answers?: Record<string, unknown>;
	status: UserQuestionStatus;
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
	| WorkflowPart
	| ImagePart
	| PromptSuggestionPart
	| FileMentionPart
	| PastedTextPart
	| PlanReviewPart
	| UserQuestionPart;

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
			 *  - `ask-user-question` → canonical question card (Claude AskUserQuestion,
			 *    Codex requestUserInput, OpenCode question — normalized by Rust's
			 *    `pipeline::user_question`, see `UserQuestionItem`)
			 *  - `form` → JSON-Schema form (MCP form elicitation)
			 *  - `url` → URL launcher (MCP url-mode elicitation)
			 *  See `pending-user-input.ts` for the typed payload union. */
			payload: Record<string, unknown>;
	  }
	| { kind: "planCaptured" }
	| { kind: "error"; message: string; persisted: boolean; internal: boolean };

/**
 * Save a pasted clipboard image (base64) under `cache/paste/<sessionId>/`
 * and return its absolute path. Callers without a real `sessions.id`
 * (StartPage composer) must pre-allocate a UUID and submit with the
 * same value so the bucket gets owned by the new session.
 */
export async function savePastedImage(
	data: string,
	mediaType: string,
	sessionId: string,
): Promise<string> {
	return invoke<string>("save_pasted_image", { data, mediaType, sessionId });
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

export async function getLocalLlmStatus(): Promise<LocalLlmStatus> {
	return await invoke<LocalLlmStatus>("get_local_llm_status");
}

export async function startLocalLlm(): Promise<LocalLlmStatus> {
	return await invoke<LocalLlmStatus>("start_local_llm");
}

export async function stopLocalLlm(): Promise<void> {
	await invoke("stop_local_llm");
}

export type LocalLlmCatalogEntry = {
	id: string;
	repo: string;
	/** Every GGUF file required to load the model. Single-file models
	 *  list one entry; multi-part shards (HF splits anything >50 GB)
	 *  list all parts in load order. The downloader fetches them all
	 *  and llama-server is pointed at part 1; it auto-discovers the
	 *  rest. */
	files: string[];
	label: string;
	quant: string;
	/** Main weights only. UI should add `mmprojBytes` for total footprint. */
	bytes: number;
	minRamGb: number;
	recommendedForGb: number;
	blurb: string;
	/** Which subsystem the entry belongs to. Always "llm" today; kept
	 *  as a discriminator so future entry kinds can land without
	 *  churning every consumer. */
	kind?: "llm";
	/** Vision projector file fetched alongside the main weights. Absent
	 *  on text-only entries. */
	mmprojFile?: string | null;
	/** Bytes of the mmproj file; 0 when none. */
	mmprojBytes?: number;
};

/** Main weights + vision projector. Use everywhere we show "size of this
 *  catalog entry" to the user (picker rows, delete dialog, download cap). */
export function localLlmEntryTotalBytes(entry: LocalLlmCatalogEntry): number {
	return entry.bytes + (entry.mmprojBytes ?? 0);
}

export async function listLocalLlmCatalog(): Promise<LocalLlmCatalogEntry[]> {
	return await invoke<LocalLlmCatalogEntry[]>("list_local_llm_catalog");
}

/** GGUF metadata snapshot for an arbitrary user-supplied `.gguf` file.
 *  Lets the panel render real context limits + KV cache estimates for
 *  Custom model paths (outside the curated catalog). When the file
 *  can't be parsed (corrupt header, unsupported arch) the IPC errors
 *  out and the UI falls back to a static "32K" hint. */
export type LocalLlmModelInspection = {
	architecture: string;
	name: string | null;
	contextLength: number;
	kvBytesPerToken: number;
	defaultContextTokens: number;
};

export async function inspectLocalLlmModel(
	path: string,
): Promise<LocalLlmModelInspection> {
	return await invoke<LocalLlmModelInspection>("inspect_local_llm_model", {
		path,
	});
}

/** Read real GGUF metadata for a downloaded catalog entry. Returns
 *  `null` when the file isn't on disk yet (panel falls back to the
 *  catalog estimate). Lets the context selector show the same numbers
 *  for catalog and custom models. */
export async function inspectLocalLlmCatalogEntry(
	entryId: string,
): Promise<LocalLlmModelInspection | null> {
	return await invoke<LocalLlmModelInspection | null>(
		"inspect_local_llm_catalog_entry",
		{ entryId },
	);
}

export type LocalLlmHardwareSnapshot = {
	cpuBrand: string;
	totalRamGb: number;
	osLabel: string;
	arch: string;
	/** Catalog entry id the hardware tier maps to. The panel paints a
	 *  "Recommended" badge on exactly this card. Null when the catalog
	 *  is empty or the OS is unsupported. */
	recommendedEntryId: string | null;
};

export async function detectLocalLlmHardware(): Promise<LocalLlmHardwareSnapshot> {
	return await invoke<LocalLlmHardwareSnapshot>("detect_local_llm_hardware");
}

export type LocalLlmDownloadState =
	| "not_downloaded"
	| "downloading"
	| "paused"
	| "downloaded"
	| "failed";

export type LocalLlmDownloadStatus = {
	entryId: string;
	state: LocalLlmDownloadState;
	downloaded: number;
	total: number;
	/** `false` when the model is `downloaded` but at least one optional
	 *  companion file (e.g. mmproj projector) is still missing on disk.
	 *  UI uses this to surface a top-up affordance without forcing a
	 *  Delete + redownload. Always `true` for entries with no optional
	 *  files. */
	optionalComplete: boolean;
	error?: string;
};

/** Streaming event from the bundled download worker. The `kind`
 *  discriminator matches the Rust enum variants. */
export type LocalLlmDownloadEvent =
	| { entryId: string; kind: "started"; total: number }
	| {
			entryId: string;
			kind: "progress";
			downloaded: number;
			total: number;
			bytesPerSec: number;
	  }
	| { entryId: string; kind: "paused"; downloaded: number; total: number }
	| { entryId: string; kind: "cancelled"; total: number }
	| {
			entryId: string;
			kind: "completed";
			downloaded: number;
			path: string;
			sha256Verified: boolean;
			optionalComplete: boolean;
	  }
	| {
			entryId: string;
			kind: "failed";
			error: string;
			retryable: boolean;
	  };

export async function subscribeLocalLlmDownloads(
	onEvent: Channel<LocalLlmDownloadEvent>,
): Promise<LocalLlmDownloadStatus[]> {
	return await invoke<LocalLlmDownloadStatus[]>(
		"subscribe_local_llm_downloads",
		{
			onEvent,
		},
	);
}

export async function listLocalLlmDownloads(): Promise<
	LocalLlmDownloadStatus[]
> {
	return await invoke<LocalLlmDownloadStatus[]>("list_local_llm_downloads");
}

export async function startLocalLlmDownload(entryId: string): Promise<void> {
	await invoke("start_local_llm_download", { entryId });
}

export async function pauseLocalLlmDownload(entryId: string): Promise<void> {
	await invoke("pause_local_llm_download", { entryId });
}

export async function cancelLocalLlmDownload(entryId: string): Promise<void> {
	await invoke("cancel_local_llm_download", { entryId });
}

export async function activateLocalLlmModel(
	entryId: string,
): Promise<LocalLlmStatus> {
	return await invoke<LocalLlmStatus>("activate_local_llm_model", { entryId });
}

export async function setLocalLlmContextOverride(
	entryId: string,
	contextTokens: number,
): Promise<LocalLlmStatus> {
	return await invoke<LocalLlmStatus>("set_local_llm_context_override", {
		entryId,
		contextTokens,
	});
}

/** Connection params for the running local LLM `llama-server`. Voice
 *  Pilot reads this to POST OpenAI-compatible chat completions with
 *  tool schemas directly to the user's configured local model. `null`
 *  while the server is stopped / starting / crashed. */
export type LocalLlmEndpoint = {
	url: string;
	token: string;
	apiModel: string;
};

export async function getLocalLlmEndpoint(): Promise<LocalLlmEndpoint | null> {
	return await invoke<LocalLlmEndpoint | null>("get_local_llm_endpoint");
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

/**
 * Attach a read-only *watcher* to a session's live agent stream.
 *
 * The client that called `startAgentMessageStream` renders the turn from its
 * own channel; this lets another client (a second window, or this same SPA
 * served to a phone via the mobile companion) mirror the SAME turn live. The
 * callback fires for every `AgentStreamEvent` the driver receives — feed them
 * through the same render pipeline. Works identically over native Tauri and the
 * companion HTTP/NDJSON transport. Returns an unlisten to detach.
 */
export async function subscribeSessionStream(
	sessionId: string,
	callback: (event: AgentStreamEvent) => void,
): Promise<UnlistenFn> {
	const subscriptionId = crypto.randomUUID();
	const onEvent = new Channel<AgentStreamEvent>();
	onEvent.onmessage = (event) => callback(event);
	await invoke("subscribe_session_stream", {
		sessionId,
		subscriptionId,
		onEvent,
	});
	return () => {
		onEvent.onmessage = () => {};
		// Abort the companion fetch so the server frees the watcher and the
		// browser releases the connection slot (no-op on native Tauri).
		closeChannel(onEvent);
		void invoke("unsubscribe_session_stream", { sessionId, subscriptionId });
	};
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
	meta?: Record<string, unknown> | null,
): Promise<void> {
	await invoke("respond_to_user_input", {
		request: {
			userInputId,
			action,
			content: content ?? null,
			meta: meta ?? null,
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
		/** Pre-allocated session UUID; see `prepareWorkspaceFromRepo`. */
		seedSessionId?: string | null;
		/** "terminal" creates a Terminal session (live PTY); defaults to "gui". */
		sessionKind?: "gui" | "terminal" | null;
		/** Pin agent_type at creation (Terminal preset CLI, e.g. "claude"). */
		agentType?: string | null;
	},
): Promise<CreateSessionResponse> {
	return invoke<CreateSessionResponse>("create_session", {
		workspaceId,
		actionKind: options?.actionKind ?? null,
		permissionMode: options?.permissionMode ?? null,
		model: options?.model ?? null,
		effortLevel: options?.effortLevel ?? null,
		fastMode: options?.fastMode ?? null,
		seedSessionId: options?.seedSessionId ?? null,
		sessionKind: options?.sessionKind ?? null,
		agentType: options?.agentType ?? null,
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
				request: {
					sessionId,
					userMessage,
					titleSeed: titleSeed ?? null,
				},
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

/** Provenance of the latest normalised plan projection. */
export type SessionPlanSource = "codex" | "exit_plan_mode";

/** Status of a single plan item, normalised away from provider quirks. */
export type SessionPlanItemStatus = "pending" | "inProgress" | "completed";

/** Status of the plan as a whole. Only `active` ships today; the union
 *  exists so future "completed" / "cancelled" states don't break callers. */
export type SessionPlanStatus = "active";

export type SessionPlanItem = {
	id: string;
	text: string;
	status: SessionPlanItemStatus;
};

export type SessionPlan = {
	items: SessionPlanItem[];
	currentItemId: string | null;
	allowedPrompts: string[];
	/** Markdown fallback present when the provider ships free-text plans
	 *  (currently Claude `ExitPlanMode`). `null` when the original
	 *  payload was already structured (Codex `turn/plan/updated`). */
	rawText: string | null;
	rawSource: string;
};

export type SessionPlanState = {
	sessionId: string;
	source: SessionPlanSource;
	sourceMessageId: string | null;
	plan: SessionPlan;
	status: SessionPlanStatus;
	updatedAt: string;
};

/** Latest persisted plan projection for a session. `null` means the
 *  session has never carried a plan (or the stored row failed
 *  validation — the loader degrades gracefully so the pinned-plan UI
 *  doesn't need to handle a hard error path). */
export async function getSessionPlanState(
	sessionId: string,
): Promise<SessionPlanState | null> {
	return invoke<SessionPlanState | null>("get_session_plan_state", {
		sessionId,
	});
}

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

/** Convert a GUI session into a Terminal session in place (one-way). Works on
 * empty and populated sessions alike — a session that already ran a turn resumes
 * by its provider session id in the TUI so the same conversation continues. */
export async function convertSessionToTerminal(
	sessionId: string,
	agentType: string,
): Promise<void> {
	await invoke("convert_session_to_terminal", { sessionId, agentType });
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

/**
 * One named run script for a repository. Multiple actions can be defined
 * per repo (e.g. "Dev server", "Tests"); each gets its own dropdown entry
 * and PTY lifecycle. `fromProject` is true when the entry comes from a
 * `helmor.json` declaration — the settings UI renders it read-only.
 *
 * `stopCommand`: optional cleanup shell snippet. When set, clicking Stop
 * runs this to completion (same env + cwd as `command`) before helmor
 * signals the main process. Second Stop click short-circuits to SIGKILL.
 */
export type RunAction = {
	id: string;
	name: string;
	command: string;
	mode: RunScriptMode;
	fromProject: boolean;
	stopCommand?: string;
};

export type RepoScripts = {
	setupScript?: string | null;
	archiveScript?: string | null;
	setupFromProject: boolean;
	/** True when ANY run action was declared in `helmor.json`. */
	runFromProject: boolean;
	archiveFromProject: boolean;
	/** Auto-run the setup script on workspace creation. Defaults to true. */
	autoRunSetup: boolean;
	/** All run actions for this repo, in display order. */
	runActions: RunAction[];
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
	/** Backend started running the configured `stopCommand`. Frontends
	 * flip the Stop button to "Force Stop" until `exited` fires. */
	| { type: "stopping" }
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
	archiveScript: string | null,
): Promise<void> {
	await invoke("update_repo_scripts", {
		repoId,
		setupScript,
		archiveScript,
	});
}

export async function updateRepoAutoRunSetup(
	repoId: string,
	enabled: boolean,
): Promise<void> {
	await invoke("update_repo_auto_run_setup", { repoId, enabled });
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

/**
 * `actionId` is required when `scriptType === "run"` (each named run
 * action has its own PTY lifecycle). For setup / archive scripts it's
 * ignored — they remain single per repo. The backend will fall back to
 * the first run action when no id is supplied, only to keep older
 * callers compiling; new code should always pass one explicitly.
 */
export async function executeRepoScript(
	repoId: string,
	scriptType: "setup" | "run",
	onEvent: (event: ScriptEvent) => void,
	workspaceId?: string | null,
	actionId?: string | null,
): Promise<void> {
	const channel = new Channel<ScriptEvent>();
	channel.onmessage = onEvent;
	await invoke("execute_repo_script", {
		repoId,
		scriptType,
		workspaceId: workspaceId ?? null,
		actionId: actionId ?? null,
		channel,
	});
}

export async function stopRepoScript(
	repoId: string,
	scriptType: "setup" | "run",
	workspaceId?: string | null,
	actionId?: string | null,
): Promise<boolean> {
	return invoke<boolean>("stop_repo_script", {
		repoId,
		scriptType,
		workspaceId: workspaceId ?? null,
		actionId: actionId ?? null,
	});
}

/**
 * Run a run action's configured `stopCommand` as a standalone script —
 * no preceding main process to terminate. Drives the inspector's
 * "Cleanup" button, which the user clicks after a start exited (cleanly
 * or otherwise) to tear down side effects (docker containers, daemons)
 * that the start spawned but didn't clean up itself.
 *
 * Output streams through the same channel shape as `executeRepoScript`,
 * so the Run tab's terminal naturally shows cleanup output.
 */
export async function executeRepoStopCommand(
	repoId: string,
	workspaceId: string,
	actionId: string,
	onEvent: (event: ScriptEvent) => void,
): Promise<void> {
	const channel = new Channel<ScriptEvent>();
	channel.onmessage = onEvent;
	await invoke("execute_repo_stop_command", {
		repoId,
		workspaceId,
		actionId,
		channel,
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
	actionId?: string | null,
): Promise<boolean> {
	return invoke<boolean>("write_repo_script_stdin", {
		repoId,
		scriptType,
		workspaceId: workspaceId ?? null,
		actionId: actionId ?? null,
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
	actionId?: string | null,
): Promise<boolean> {
	return invoke<boolean>("resize_repo_script", {
		repoId,
		scriptType,
		workspaceId: workspaceId ?? null,
		actionId: actionId ?? null,
		cols,
		rows,
	});
}

// ---- Run actions CRUD ----

export async function createRepoRunAction(
	repoId: string,
	name: string,
	command: string,
	mode: RunScriptMode,
	stopCommand?: string | null,
): Promise<RunAction> {
	return invoke<RunAction>("create_repo_run_action", {
		repoId,
		name,
		command,
		mode,
		stopCommand: stopCommand ?? null,
	});
}

export async function updateRepoRunAction(
	repoId: string,
	actionId: string,
	name: string,
	command: string,
	mode: RunScriptMode,
	stopCommand?: string | null,
): Promise<void> {
	await invoke("update_repo_run_action", {
		repoId,
		actionId,
		name,
		command,
		mode,
		stopCommand: stopCommand ?? null,
	});
}

export async function deleteRepoRunAction(
	repoId: string,
	actionId: string,
): Promise<void> {
	await invoke("delete_repo_run_action", { repoId, actionId });
}

export async function reorderRepoRunActions(
	repoId: string,
	orderedIds: string[],
): Promise<void> {
	await invoke("reorder_repo_run_actions", { repoId, orderedIds });
}

export async function setWorkspaceActiveRunAction(
	workspaceId: string,
	actionId: string | null,
): Promise<void> {
	await invoke("set_workspace_active_run_action", {
		workspaceId,
		actionId,
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
	bootCommand?: string | null,
	agentKind?: string | null,
	fastMode?: boolean,
	initialCols?: number | null,
	initialRows?: number | null,
): Promise<void> {
	const channel = new Channel<ScriptEvent>();
	channel.onmessage = onEvent;
	await invoke("spawn_terminal", {
		repoId,
		workspaceId,
		instanceId,
		agentKind: agentKind ?? null,
		bootCommand: bootCommand ?? null,
		fastMode: fastMode ?? null,
		initialCols: initialCols ?? null,
		initialRows: initialRows ?? null,
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

/** Mirror a Terminal session's working/idle state into the active-stream
 * registry (drives the sidebar spinner + completion notification). */
export async function setTerminalSessionBusy(
	sessionId: string,
	workspaceId: string,
	busy: boolean,
	provider?: string | null,
): Promise<void> {
	await invoke("set_terminal_session_busy", {
		sessionId,
		workspaceId,
		busy,
		provider: provider ?? null,
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

// ---------------------------------------------------------------------------
// Feedback / "Quick fix" contribution flow
// ---------------------------------------------------------------------------

export type ForkResult = {
	owner: string;
	repo: string;
	cloneUrl: string;
	htmlUrl: string;
};

export type ExistingHelmorRepo = {
	repoId: string;
	repoName: string;
};

export async function forkHelmorUpstream(): Promise<ForkResult> {
	return invoke<ForkResult>("fork_helmor_upstream");
}

export type IssueResult = {
	url: string;
	number: number;
};

export async function createHelmorIssue(
	title: string,
	body: string,
): Promise<IssueResult> {
	return invoke<IssueResult>("create_helmor_issue", { title, body });
}

export async function findExistingHelmorRepo(): Promise<ExistingHelmorRepo | null> {
	return invoke<ExistingHelmorRepo | null>("find_existing_helmor_repo");
}

function describeInvokeError(error: unknown, fallback: string): string {
	return extractError(error, fallback).message;
}

// --- Mobile browser companion ----------------------------------------------

/** Companion server + tunnel status. */
export type CompanionStatus = {
	running: boolean;
	/** Loopback address the server is bound to (`127.0.0.1:<port>`). */
	addr: string | null;
	/** Public tunnel URL, when a tunnel is up. */
	publicUrl: string | null;
	/** `"named"` (stable URL), `"quick"` (ephemeral), or `"none"`. */
	mode: "named" | "quick" | "none";
	/** Provisioned stable hostname, if any — independent of running state. */
	stableHost: string | null;
	/** Whether the user has signed in to Cloudflare. */
	signedIn: boolean;
};

/** One-time payload returned when pairing a device. The phone scans `url`. */
export type CompanionPairingPayload = {
	deviceId: string;
	label: string;
	/** Plaintext PAT — shown once, never persisted in plaintext. */
	pat: string;
	/** Full pairing URL to encode as a QR: `<origin>/#pair=<pat>`. */
	url: string;
};

/** A paired phone (active, non-revoked). */
export type PairedDevice = {
	id: string;
	label: string;
	createdAt: string;
	lastSeenAt: string | null;
};

export async function getCompanionStatus(): Promise<CompanionStatus> {
	return invoke<CompanionStatus>("companion_status");
}

export async function enableCompanion(): Promise<CompanionStatus> {
	try {
		return await invoke<CompanionStatus>("companion_enable");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to enable the mobile companion."),
		);
	}
}

export async function disableCompanion(): Promise<void> {
	await invoke<void>("companion_disable");
}

export async function pairCompanionDevice(
	label: string,
): Promise<CompanionPairingPayload> {
	try {
		return await invoke<CompanionPairingPayload>("companion_pair_device", {
			label,
		});
	} catch (error) {
		throw new Error(describeInvokeError(error, "Unable to pair device."));
	}
}

export async function listPairedDevices(): Promise<PairedDevice[]> {
	return (await invoke<PairedDevice[]>("companion_list_devices")) ?? [];
}

export async function revokePairedDevice(deviceId: string): Promise<void> {
	await invoke<void>("companion_revoke_device", { deviceId });
}

/** Open the Cloudflare sign-in flow (browser). Resolves once cert.pem lands. */
export async function signInCloudflare(): Promise<void> {
	try {
		await invoke<void>("companion_sign_in_cloudflare");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Cloudflare sign-in did not complete."),
		);
	}
}

/** Provision a permanent remote-*.helmor.ai URL and bring it up. */
export async function allocateStableUrl(): Promise<CompanionStatus> {
	try {
		return await invoke<CompanionStatus>("companion_allocate_stable_url");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to allocate a stable URL."),
		);
	}
}

/** Forget the permanent URL (revoke hostname + tear down). */
export async function destroyStableUrl(): Promise<CompanionStatus> {
	try {
		return await invoke<CompanionStatus>("companion_destroy_stable_url");
	} catch (error) {
		throw new Error(
			describeInvokeError(error, "Unable to forget the stable URL."),
		);
	}
}
