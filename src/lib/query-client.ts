import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { focusManager, QueryClient, queryOptions } from "@tanstack/react-query";
import {
	type ActionKind,
	type AgentProvider,
	type ChangeRequestInfo,
	DEFAULT_WORKSPACE_GROUPS,
	type DetectedEditor,
	detectInstalledEditors,
	type ForgeAccount,
	type ForgeActionStatus,
	type ForgeDetection,
	getClaudeRateLimits,
	getCodexRateLimits,
	getLiveContextUsage,
	getSessionCodexGoal,
	getSessionContextUsage,
	getWorkspaceAccountProfile,
	getWorkspaceForge,
	listForgeAccounts,
	listRepositories,
	listSlashCommands,
	listWorkspaceCandidateDirectories,
	listWorkspaceChangesWithContent,
	listWorkspaceFiles,
	listWorkspaceLinkedDirectories,
	loadAgentModelSections,
	loadArchivedWorkspaces,
	loadAutoCloseActionKinds,
	loadAutoCloseOptInAsked,
	loadSessionThreadMessages,
	loadWorkspaceDetail,
	loadWorkspaceForgeActionStatus,
	loadWorkspaceGitActionStatus,
	loadWorkspaceGroups,
	loadWorkspaceSessions,
	type PrSyncState,
	refreshWorkspaceChangeRequest,
} from "./api";
import { parsePrUrl } from "./pr-url";

const SESSION_STALE_TIME = 10 * 60_000;
const CHANGES_STALE_TIME = 3_000;
const CHANGES_REFETCH_INTERVAL = 10_000;
const WORKSPACE_FORGE_REFETCH_INTERVAL = 60_000;
const DEFAULT_GC_TIME = 30 * 60_000;
const SESSION_GC_TIME = 60 * 60_000;
const PERSIST_GC_TIME = 24 * 60 * 60_000; // 24h — persisted entries live this long

export const helmorQueryKeys = {
	workspaceGroups: ["workspaceGroups"] as const,
	archivedWorkspaces: ["archivedWorkspaces"] as const,
	repositories: ["repositories"] as const,
	agentModelSections: ["agentModelSections"] as const,
	workspaceDetail: (workspaceId: string) =>
		["workspaceDetail", workspaceId] as const,
	workspaceSessions: (workspaceId: string) =>
		["workspaceSessions", workspaceId] as const,
	sessionContextUsage: (sessionId: string) =>
		["sessionContextUsage", sessionId] as const,
	sessionCodexGoal: (sessionId: string) =>
		["sessionCodexGoal", sessionId] as const,
	codexRateLimits: ["codexRateLimits"] as const,
	claudeRateLimits: ["claudeRateLimits"] as const,
	claudeRichContextUsage: (
		sessionId: string,
		providerSessionId: string | null,
		model: string | null,
	) =>
		[
			"claudeRichContextUsage",
			sessionId,
			providerSessionId ?? "",
			model ?? "",
		] as const,
	sessionMessages: (sessionId: string) =>
		["sessionMessages", sessionId] as const,
	workspaceChanges: (workspaceRootPath: string) =>
		["workspaceChanges", workspaceRootPath] as const,
	workspaceFiles: (workspaceRootPath: string) =>
		["workspaceFiles", workspaceRootPath] as const,
	workspaceChangeRequest: (workspaceId: string) =>
		["workspaceChangeRequest", workspaceId] as const,
	workspaceForge: (workspaceId: string) =>
		["workspaceForge", workspaceId] as const,
	forgeAccounts: (gitlabHosts: string[]) =>
		["forgeAccounts", ...gitlabHosts] as const,
	forgeAccountsAll: ["forgeAccounts"] as const,
	workspaceAccountProfile: (workspaceId: string) =>
		["workspaceAccountProfile", workspaceId] as const,
	/// Lightweight per-host login set probe (no profile fetch). Used as
	/// the focus-driven auth liveness check: account / repo settings
	/// surfaces refetch this on window focus, and a delta in the set
	/// invalidates the heavyweight `forgeAccounts` cache.
	forgeLogins: (provider: string, host: string) =>
		["forgeLogins", provider, host] as const,
	workspaceGitActionStatus: (workspaceId: string) =>
		["workspaceGitActionStatus", workspaceId] as const,
	workspaceForgeActionStatus: (workspaceId: string) =>
		["workspaceForgeActionStatus", workspaceId] as const,
	repoScripts: (repoId: string, workspaceId: string | null) =>
		["repoScripts", repoId, workspaceId ?? ""] as const,
	repoPreferences: (repoId: string) => ["repoPreferences", repoId] as const,
	autoCloseActionKinds: ["autoCloseActionKinds"] as const,
	autoCloseOptInAsked: ["autoCloseOptInAsked"] as const,
	detectedEditors: ["detectedEditors"] as const,
	slashCommands: (
		provider: AgentProvider,
		workingDirectory: string | null,
		workspaceId: string | null,
	) =>
		[
			"slashCommands",
			provider,
			workingDirectory ?? "",
			workspaceId ?? "",
		] as const,
	workspaceLinkedDirectories: (workspaceId: string) =>
		["workspaceLinkedDirectories", workspaceId] as const,
	workspaceCandidateDirectories: (excludeWorkspaceId: string | null) =>
		["workspaceCandidateDirectories", excludeWorkspaceId ?? ""] as const,
};

export function isVolatileForgeQueryKey(queryKey: readonly unknown[]): boolean {
	const root = queryKey[0];
	return (
		root === "workspaceForge" ||
		root === "workspaceForgeActionStatus" ||
		root === "workspaceAccountProfile" ||
		root === "forgeLogins" ||
		root === "forgeAccounts"
	);
}

export function createHelmorQueryClient() {
	// Replace React Query's default focus listener (browser visibilitychange)
	// with Tauri's native window focus/blur events. This is the official
	// pattern for non-browser environments (cf. React Native AppState in
	// the TanStack Query docs). The focusManager calls `handleFocus(true)`
	// which triggers refetchOnWindowFocus for all queries, respecting each
	// query's own staleTime — local DB queries use staleTime: 0 so they
	// always refetch on focus, while remote GitHub queries keep their
	// staleTime: 30s to avoid hammering the API.
	focusManager.setEventListener((handleFocus) => {
		let unlistenFocus: (() => void) | undefined;
		let unlistenBlur: (() => void) | undefined;

		void import("@tauri-apps/api/event").then(({ listen }) => {
			void listen("tauri://focus", () => handleFocus(true)).then((fn) => {
				unlistenFocus = fn;
			});
			void listen("tauri://blur", () => handleFocus(false)).then((fn) => {
				unlistenBlur = fn;
			});
		});

		return () => {
			unlistenFocus?.();
			unlistenBlur?.();
		};
	});

	return new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: PERSIST_GC_TIME,
				refetchOnReconnect: false,
				refetchOnWindowFocus: true,
				retry: 1,
			},
		},
	});
}

// Surface persister write failures (quota exceeded, security errors) instead
// of letting them silently disable persistence.
const loggingLocalStorage: Storage = {
	get length() {
		return window.localStorage.length;
	},
	clear: () => window.localStorage.clear(),
	getItem: (k) => window.localStorage.getItem(k),
	key: (i) => window.localStorage.key(i),
	removeItem: (k) => window.localStorage.removeItem(k),
	setItem: (k, v) => {
		try {
			window.localStorage.setItem(k, v);
		} catch (error) {
			const sizeKb = (v.length / 1024).toFixed(1);
			console.error(
				`[helmor] localStorage.setItem failed for "${k}" (${sizeKb} KB)`,
				error,
			);
			throw error;
		}
	},
};

export const helmorQueryPersister = createAsyncStoragePersister({
	storage: loggingLocalStorage,
	key: "helmor-query-cache",
});

export function workspaceGroupsQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceGroups,
		queryFn: loadWorkspaceGroups,
		initialData: DEFAULT_WORKSPACE_GROUPS,
		initialDataUpdatedAt: 0,
		staleTime: 0,
	});
}

export function archivedWorkspacesQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.archivedWorkspaces,
		queryFn: loadArchivedWorkspaces,
		initialData: [],
		initialDataUpdatedAt: 0,
		staleTime: 0,
	});
}

export function repositoriesQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.repositories,
		queryFn: listRepositories,
		initialData: [],
		initialDataUpdatedAt: 0,
		staleTime: 0,
	});
}

export function agentModelSectionsQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.agentModelSections,
		queryFn: loadAgentModelSections,
		staleTime: Infinity,
		refetchOnWindowFocus: false,
		retry: false,
	});
}

export function workspaceDetailQueryOptions(workspaceId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
		queryFn: () => loadWorkspaceDetail(workspaceId),
		staleTime: 0,
	});
}

export function workspaceForgeQueryOptions(workspaceId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceForge(workspaceId),
		queryFn: () => getWorkspaceForge(workspaceId),
		// Same identity-info contract: cache forever, refetch on focus.
		// `refetchInterval` keeps the active workspace's chip in sync
		// with backend-side polling (e.g. CI status changes).
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: "always",
		refetchInterval: (query) => workspaceForgeRefetchInterval(query.state.data),
	});
}

/** Profile (login / name / email / avatarUrl / active) for the
 *  account bound to a workspace.
 *
 *  Cache strategy across **every identity-information query** in
 *  this file (this one + `forgeAccountsQueryOptions` +
 *  `workspaceForgeQueryOptions` + `workspaceForgeActionStatusQueryOptions`):
 *
 *    - `staleTime: Infinity` — once a value is in cache, never
 *      mark it stale on its own. We don't want a flicker every
 *      time some other component happens to mount.
 *    - `refetchOnWindowFocus: "always"` — but *do* re-check on
 *      window focus, every time. If the refetch fails (token
 *      revoked / account logged out elsewhere), React Query keeps
 *      the previous data + sets `error`; the consuming UI flips
 *      to "Connect" by reading the new state from the next
 *      successful response (the action-status backend returns
 *      `remoteState: "unauthenticated"` for invalid tokens).
 *
 *  Backend has matching throttles on the underlying CLI calls
 *  (`gh / glab auth status` and `gh / glab api user`) so a burst
 *  of refocuses doesn't fan out N CLI invocations.
 *
 *  Avatar *image bytes* are a separate concern and cached on disk
 *  by URL hash (`forge/avatar_cache.rs`); identity changes never
 *  imply a new image, and an unchanged URL reuses the cached file
 *  regardless of what this query returns. */
export function workspaceAccountProfileQueryOptions(
	workspaceId: string | null,
) {
	return queryOptions<ForgeAccount | null>({
		queryKey: workspaceId
			? helmorQueryKeys.workspaceAccountProfile(workspaceId)
			: ["workspaceAccountProfile", "__none__"],
		queryFn: () =>
			workspaceId
				? getWorkspaceAccountProfile(workspaceId)
				: Promise.resolve(null),
		enabled: workspaceId !== null,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: "always",
		refetchOnReconnect: true,
		retry: 0,
	});
}

export function forgeAccountsQueryOptions(gitlabHosts: string[]) {
	return queryOptions<ForgeAccount[]>({
		queryKey: helmorQueryKeys.forgeAccounts(gitlabHosts),
		queryFn: () => listForgeAccounts(gitlabHosts),
		// Same cache contract as `workspaceAccountProfileQueryOptions`:
		// cache forever, refetch on every window focus. Backend
		// throttles the underlying CLI calls.
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: "always",
	});
}

/**
 * Default `staleTime: 0` matches the panel's "always re-validate sessions"
 * expectation. Callers that *peek* at the cache (e.g. sidebar hover card)
 * can pass a small `staleTime` so re-mounts inside the same hover session
 * don't refire the IPC.
 */
export function workspaceSessionsQueryOptions(
	workspaceId: string,
	overrides: { staleTime?: number } = {},
) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
		queryFn: () => loadWorkspaceSessions(workspaceId),
		staleTime: overrides.staleTime ?? 0,
	});
}

/** Baseline context-usage cache. Event-driven: `contextUsageChanged`
 *  invalidates → observer refetches from DB. Same pattern as rate limits. */
export function sessionContextUsageQueryOptions(sessionId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.sessionContextUsage(sessionId),
		queryFn: () => getSessionContextUsage(sessionId),
		staleTime: 0,
	});
}

/** Active Codex `/goal` payload. Event-driven via `CodexGoalChanged`. */
export function sessionCodexGoalQueryOptions(sessionId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.sessionCodexGoal(sessionId),
		queryFn: () => getSessionCodexGoal(sessionId),
		staleTime: 0,
	});
}

const RATE_LIMITS_STALE_TIME = 2 * 60_000;

// 2 min interval + window-focus refetch + hover refetch. The Rust
// command's 30 s throttle is the hard ceiling — extra triggers just
// hit the cached body, so we can be eager here.
export function codexRateLimitsQueryOptions(enabled: boolean) {
	return queryOptions({
		queryKey: helmorQueryKeys.codexRateLimits,
		queryFn: getCodexRateLimits,
		staleTime: RATE_LIMITS_STALE_TIME,
		refetchInterval: enabled ? RATE_LIMITS_STALE_TIME : false,
		refetchOnWindowFocus: true,
		enabled,
	});
}
export function claudeRateLimitsQueryOptions(enabled: boolean) {
	return queryOptions({
		queryKey: helmorQueryKeys.claudeRateLimits,
		queryFn: getClaudeRateLimits,
		staleTime: RATE_LIMITS_STALE_TIME,
		refetchInterval: enabled ? RATE_LIMITS_STALE_TIME : false,
		refetchOnWindowFocus: true,
		enabled,
	});
}

/** Hover-triggered rich Claude context breakdown. `staleTime: Infinity`
 *  so cached categories survive session hops — SDK context doesn't
 *  mutate between turns, and `contextUsageChanged` invalidates on turn
 *  end to force a refetch the next time hover opens. */
export function claudeRichContextUsageQueryOptions(params: {
	sessionId: string;
	providerSessionId: string | null;
	model: string | null;
	cwd: string | null;
	enabled: boolean;
}) {
	return queryOptions({
		queryKey: helmorQueryKeys.claudeRichContextUsage(
			params.sessionId,
			params.providerSessionId,
			params.model,
		),
		queryFn: () =>
			getLiveContextUsage({
				sessionId: params.sessionId,
				providerSessionId: params.providerSessionId,
				// `enabled` gate ensures model is non-null before queryFn runs.
				model: params.model ?? "",
				cwd: params.cwd,
			}),
		staleTime: Number.POSITIVE_INFINITY,
		enabled: params.enabled,
	});
}

/** `/add-dir` linked directories, workspace-scoped. */
export function workspaceLinkedDirectoriesQueryOptions(workspaceId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceLinkedDirectories(workspaceId),
		queryFn: () => listWorkspaceLinkedDirectories(workspaceId),
		staleTime: 0,
	});
}

/**
 * Candidate directories shown as quick-pick suggestions in the /add-dir
 * popup. Staled quickly so newly-created workspaces show up on the next
 * popup open without a manual refresh.
 */
export function workspaceCandidateDirectoriesQueryOptions(
	excludeWorkspaceId: string | null,
) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceCandidateDirectories(excludeWorkspaceId),
		queryFn: () => listWorkspaceCandidateDirectories({ excludeWorkspaceId }),
		staleTime: 0,
	});
}

/** Pipeline-rendered thread messages — ready for direct rendering. */
export function sessionThreadMessagesQueryOptions(sessionId: string) {
	return queryOptions({
		queryKey: [...helmorQueryKeys.sessionMessages(sessionId), "thread"],
		queryFn: () => loadSessionThreadMessages(sessionId),
		gcTime: SESSION_GC_TIME,
		staleTime: SESSION_STALE_TIME,
	});
}

export function slashCommandsQueryOptions(
	provider: AgentProvider,
	workingDirectory: string | null,
	repoId: string | null,
	workspaceId: string | null,
) {
	return queryOptions({
		queryKey: helmorQueryKeys.slashCommands(
			provider,
			workingDirectory,
			workspaceId,
		),
		queryFn: () =>
			listSlashCommands({
				provider,
				workingDirectory,
				repoId,
				workspaceId,
			}),
		// The backend owns slash-command caching and background refresh. Keep
		// the frontend layer as a thin request shell only.
		staleTime: 0,
		gcTime: 0,
		retry: 0,
		refetchOnWindowFocus: false,
	});
}

export function autoCloseActionKindsQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.autoCloseActionKinds,
		queryFn: loadAutoCloseActionKinds,
		initialData: [] as ActionKind[],
		initialDataUpdatedAt: 0,
		staleTime: 60_000,
	});
}

export function autoCloseOptInAskedQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.autoCloseOptInAsked,
		queryFn: loadAutoCloseOptInAsked,
		initialData: [] as ActionKind[],
		initialDataUpdatedAt: 0,
		staleTime: 60_000,
	});
}

/**
 * Installed third-party editors (Cursor, VS Code, JetBrains, terminals, Git GUIs).
 * Detection is cheap but non-trivial — the Rust side stat()'s known app paths and
 * falls back to a single batched `mdfind` for apps in non-standard locations.
 * Cached for 60s so revisiting the dropdown does not re-scan; persisted across
 * app restarts via the localStorage persister so the button shows up instantly
 * on the next launch.
 */
export function detectedEditorsQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.detectedEditors,
		queryFn: detectInstalledEditors,
		initialData: [] as DetectedEditor[],
		initialDataUpdatedAt: 0,
		staleTime: 60_000,
		gcTime: PERSIST_GC_TIME,
	});
}

export function changeRequestRefetchInterval(
	data: ChangeRequestInfo | null | undefined,
): number {
	if (!data) return 60_000;
	if (data.isMerged || data.state === "MERGED" || data.state === "CLOSED") {
		return 300_000;
	}
	return 60_000;
}

export function forgeActionStatusRefetchInterval(
	data: ForgeActionStatus | undefined,
): number | false {
	if (!data) return 60_000;
	if (data.remoteState !== "ok") return 60_000;
	if (
		data.changeRequest?.isMerged ||
		data.changeRequest?.state === "MERGED" ||
		data.changeRequest?.state === "CLOSED"
	) {
		return false;
	}
	if (data.mergeable === "UNKNOWN") return 5_000;
	const hasRunningWork =
		data.checks.some((c) => c.status === "pending" || c.status === "running") ||
		data.deployments.some(
			(d) => d.status === "pending" || d.status === "running",
		);
	if (hasRunningWork) return 15_000;
	return 60_000;
}

/**
 * Persisted PR snapshot from the workspace row. Used as `placeholderData` so
 * the inspector renders the PR badge optimistically on first visit, before
 * the live forge query returns. Pass whichever of these you have — when the
 * URL is missing or unparseable, no placeholder is produced and the header
 * falls back to its empty state.
 */
export type WorkspaceChangeRequestSeed = {
	prSyncState?: PrSyncState | null;
	prUrl?: string | null;
	prTitle?: string | null;
};

function changeRequestPlaceholder(
	seed: WorkspaceChangeRequestSeed | undefined,
): ChangeRequestInfo | undefined {
	if (!seed) return undefined;
	const syncState = seed.prSyncState ?? "none";
	if (syncState === "none") return undefined;
	const parsed = parsePrUrl(seed.prUrl);
	if (!parsed) return undefined;
	return {
		url: seed.prUrl ?? "",
		number: parsed.number,
		state: syncState.toUpperCase(),
		title: seed.prTitle ?? "",
		isMerged: syncState === "merged",
	};
}

export function workspaceChangeRequestQueryOptions(
	workspaceId: string,
	seed?: WorkspaceChangeRequestSeed,
) {
	const placeholder = changeRequestPlaceholder(seed);
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceChangeRequest(workspaceId),
		queryFn: () => refreshWorkspaceChangeRequest(workspaceId),
		staleTime: 30_000,
		gcTime: DEFAULT_GC_TIME,
		refetchOnWindowFocus: true,
		refetchInterval: (query) => changeRequestRefetchInterval(query.state.data),
		retry: 0,
		// Identity-stable per (workspaceId, seed signature) so React Query
		// doesn't re-evaluate placeholderData on unrelated re-renders.
		placeholderData: placeholder,
	});
}

export function workspaceGitActionStatusQueryOptions(workspaceId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceGitActionStatus(workspaceId),
		queryFn: () => loadWorkspaceGitActionStatus(workspaceId),
		staleTime: CHANGES_STALE_TIME,
		gcTime: DEFAULT_GC_TIME,
		refetchOnWindowFocus: true,
		refetchInterval: 10_000,
		retry: 0,
	});
}

export function workspaceForgeActionStatusQueryOptions(workspaceId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceForgeActionStatus(workspaceId),
		queryFn: () => loadWorkspaceForgeActionStatus(workspaceId),
		// Same `staleTime: Infinity` + `refetchOnWindowFocus: "always"`
		// baseline as the other three identity-info queries.
		//
		// Unique to this query: `refetchOnMount: "always"`. Inspector's
		// `Connect` CTA reads `remoteState` from here, so the moment the
		// user switches workspaces we MUST re-probe the new workspace's
		// remote — otherwise the previously-visited workspace's stale
		// cache (with the same `staleTime: Infinity` rule) would render
		// the wrong CTA state until the next focus event. The cached
		// value still shows immediately (no loading flicker), only
		// `isFetching` flips while the background refetch lands.
		//
		// The other three queries intentionally don't get this: their
		// data either rarely changes (chip avatar, GitHub-vs-GitLab
		// label) or isn't workspace-scoped (Settings roster), so the
		// extra mount-time IPC isn't worth the cost.
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: DEFAULT_GC_TIME,
		refetchOnWindowFocus: "always",
		refetchOnMount: "always",
		refetchInterval: (query) =>
			forgeActionStatusRefetchInterval(query.state.data),
		retry: 0,
	});
}

export function workspaceForgeRefetchInterval(
	data: ForgeDetection | undefined,
): number | false {
	if (!data) return WORKSPACE_FORGE_REFETCH_INTERVAL;
	return data.provider === "github" || data.provider === "gitlab"
		? WORKSPACE_FORGE_REFETCH_INTERVAL
		: false;
}

export function workspaceChangesQueryOptions(workspaceRootPath: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceChanges(workspaceRootPath),
		queryFn: () => listWorkspaceChangesWithContent(workspaceRootPath),
		staleTime: CHANGES_STALE_TIME,
		refetchOnWindowFocus: true,
		refetchInterval: CHANGES_REFETCH_INTERVAL,
	});
}

/**
 * Full workspace file list for the @-mention picker. The popup is hidden
 * until this resolves; on error we fall back to an empty list and the
 * popup never opens (no UI breakage). Cached aggressively because the
 * walk is bounded but not free, and the file set rarely changes within
 * a single composer session.
 */
export function workspaceFilesQueryOptions(workspaceRootPath: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceFiles(workspaceRootPath),
		queryFn: () => listWorkspaceFiles(workspaceRootPath),
		staleTime: 60_000,
		gcTime: DEFAULT_GC_TIME,
		retry: 0,
	});
}
