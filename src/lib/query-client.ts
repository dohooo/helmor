import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { focusManager, QueryClient, queryOptions } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { ThreadMessageLike } from "./api";
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
	type ForgeProvider,
	fetchSessionThreadMessagesPage,
	getClaudeRateLimits,
	getCodexRateLimits,
	getLiveContextUsage,
	getSessionCodexGoal,
	getSessionContextUsage,
	getWorkspaceAccountProfile,
	getWorkspaceForge,
	listActiveStreams,
	listForgeAccounts,
	listForgeLabels,
	listInboxKindLabels,
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
import {
	getSessionThreadPaginationState,
	setSessionThreadPaginationState,
} from "./session-thread-pagination";

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
	inboxItemDetail: (
		provider: string,
		login: string,
		source: string,
		externalId: string,
	) => ["inboxItemDetail", provider, login, source, externalId] as const,
	forgeLabels: (
		provider: string,
		host: string,
		login: string,
		repos: string[],
	) => ["forgeLabels", provider, host, login, ...repos] as const,
	inboxKindLabels: (provider: string) => ["inboxKindLabels", provider] as const,
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
		repoId: string | null,
	) =>
		[
			"slashCommands",
			provider,
			workingDirectory ?? "",
			workspaceId ?? "",
			repoId ?? "",
		] as const,
	workspaceLinkedDirectories: (workspaceId: string) =>
		["workspaceLinkedDirectories", workspaceId] as const,
	workspaceCandidateDirectories: (excludeWorkspaceId: string | null) =>
		["workspaceCandidateDirectories", excludeWorkspaceId ?? ""] as const,
	activeStreams: ["activeStreams"] as const,
};

/** Persistence is opt-in per `queryOptions` via `meta: { persist: true }`.
 *  Bump this whenever the persist contract changes (e.g. new field shape)
 *  so existing users drop their stale on-disk cache instead of hydrating
 *  it. The `Register` augmentation in `react-query.d.ts` keeps the meta
 *  shape closed so typos fail at compile time. */
export const QUERY_CACHE_BUSTER = "v3-meta";

export const PERSIST_META = { persist: true } as const;

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
			dehydrate: {
				// Opt-in persistence: keep default's `status === "success"`
				// gate and require an explicit `meta: { persist: true }` on
				// the query. Default = in-memory only.
				shouldDehydrateQuery: (query) =>
					query.state.status === "success" && query.meta?.persist === true,
			},
		},
	});
}

/** AsyncStorage adapter backed by Tauri-managed files in the helmor data
 * dir. Replaces the prior `window.localStorage` backend so the React
 * Query persister isn't bound by the webview's ~5–10 MB quota. The
 * three helper IPC commands (`read_query_cache` / `write_query_cache` /
 * `delete_query_cache`) sit on top of `<data_dir>/query-cache/<key>.json`
 * with atomic-rename writes.
 *
 * The TanStack Query `AsyncStorage` interface only needs `getItem`,
 * `setItem`, `removeItem` — no `length` / `key()` / `clear()` like
 * `Storage`. Returning `null` for missing keys matches the localStorage
 * convention the persister was written against.
 *
 * Boot-time migration: if `localStorage` still has the legacy
 * `helmor-query-cache` blob from older versions, copy it into the new
 * file-backed location once and clear it from localStorage. Idempotent
 * — runs every boot, no-ops once the localStorage key is gone.
 */
const QUERY_CACHE_KEY = "helmor-query-cache";
let migrationPromise: Promise<void> | null = null;

async function migrateLegacyLocalStorageQueryCache(): Promise<void> {
	if (typeof window === "undefined") return;
	let legacy: string | null = null;
	try {
		legacy = window.localStorage.getItem(QUERY_CACHE_KEY);
	} catch {
		return;
	}
	if (!legacy) return;
	try {
		await invoke<void>("write_query_cache", {
			key: QUERY_CACHE_KEY,
			value: legacy,
		});
		try {
			window.localStorage.removeItem(QUERY_CACHE_KEY);
		} catch {
			/* keep going — DB has it */
		}
		console.info(
			`[helmor] migrated localStorage query cache (${(legacy.length / 1024).toFixed(1)} KB) into data dir`,
		);
	} catch (error) {
		console.error(
			"[helmor] failed to migrate legacy localStorage query cache",
			error,
		);
	}
}

function ensureQueryCacheMigration(): Promise<void> {
	if (!migrationPromise) {
		migrationPromise = migrateLegacyLocalStorageQueryCache();
	}
	return migrationPromise;
}

const tauriFsQueryCacheStorage = {
	getItem: async (key: string): Promise<string | null> => {
		await ensureQueryCacheMigration();
		try {
			const value = await invoke<string | null>("read_query_cache", { key });
			return value ?? null;
		} catch (error) {
			console.error(`[helmor] read_query_cache failed for "${key}"`, error);
			return null;
		}
	},
	setItem: async (key: string, value: string): Promise<void> => {
		try {
			await invoke<void>("write_query_cache", { key, value });
		} catch (error) {
			const sizeKb = (value.length / 1024).toFixed(1);
			console.error(
				`[helmor] write_query_cache failed for "${key}" (${sizeKb} KB)`,
				error,
			);
			throw error;
		}
	},
	removeItem: async (key: string): Promise<void> => {
		try {
			await invoke<void>("delete_query_cache", { key });
		} catch (error) {
			console.error(`[helmor] delete_query_cache failed for "${key}"`, error);
		}
	},
};

export const helmorQueryPersister = createAsyncStoragePersister({
	storage: tauriFsQueryCacheStorage,
	key: QUERY_CACHE_KEY,
});

export function workspaceGroupsQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceGroups,
		queryFn: loadWorkspaceGroups,
		initialData: DEFAULT_WORKSPACE_GROUPS,
		initialDataUpdatedAt: 0,
		staleTime: 0,
		meta: PERSIST_META,
	});
}

export function archivedWorkspacesQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.archivedWorkspaces,
		queryFn: loadArchivedWorkspaces,
		initialData: [],
		initialDataUpdatedAt: 0,
		staleTime: 0,
		meta: PERSIST_META,
	});
}

export function repositoriesQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.repositories,
		queryFn: listRepositories,
		initialData: [],
		initialDataUpdatedAt: 0,
		staleTime: 0,
		meta: PERSIST_META,
	});
}

/** Snapshot of in-flight agent streams (source of truth = Rust
 *  `ActiveStreams`). Drives abort-button visibility + busy badges; the
 *  ui-sync bridge invalidates this on `activeStreamsChanged`. NOT
 *  persisted — running streams are by definition tied to this app run,
 *  rehydrating stale state across restarts would mislead the UI. */
export function activeStreamsQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.activeStreams,
		queryFn: listActiveStreams,
		initialData: [],
		initialDataUpdatedAt: 0,
		staleTime: 0,
	});
}

/** Repo labels for the Settings → Context multi-select. Forge-aware:
 *  GitHub hits `gh api /repos/.../labels`; GitLab hits `glab api
 *  projects/.../labels`. Cached for 10 min — labels rarely churn. */
export function forgeLabelsQueryOptions(args: {
	provider: ForgeProvider;
	login: string;
	host: string | null;
	repos: string[];
}) {
	const sortedRepos = [...args.repos].sort();
	const host = args.host ?? "";
	return queryOptions({
		queryKey: helmorQueryKeys.forgeLabels(
			args.provider,
			host,
			args.login,
			sortedRepos,
		),
		queryFn: () =>
			listForgeLabels({
				provider: args.provider,
				login: args.login,
				host: args.host,
				repos: sortedRepos,
			}),
		initialData: [],
		initialDataUpdatedAt: 0,
		staleTime: 10 * 60_000,
		gcTime: 24 * 60 * 60_000,
	});
}

/// Inbox kind labels are static per provider (a given build's GitHub
/// labels never change at runtime), so the cache is effectively
/// permanent. We still go through the backend so frontend code is the
/// pure consumer — every "PR" / "MR" / "Pull requests" / "Merge
/// requests" string is owned by the Forge layer.
export function inboxKindLabelsQueryOptions(provider: ForgeProvider) {
	return queryOptions({
		queryKey: helmorQueryKeys.inboxKindLabels(provider),
		queryFn: () => listInboxKindLabels(provider),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});
}

export function agentModelSectionsQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.agentModelSections,
		queryFn: loadAgentModelSections,
		// Catalog is cheap (synchronous Rust read of static + settings).
		// `staleTime: 0` means every mount re-fetches; the persisted disk
		// cache still gives an instant first paint on app boot, but ANY
		// remount validates against the live catalog. This matters because
		// the catalog SHAPE can change across releases (e.g. cursor model
		// id namespacing) — a long staleTime + on-disk persistence
		// previously stuck users on a pre-upgrade shape until they
		// happened to invalidate the query manually.
		staleTime: 0,
		refetchOnWindowFocus: false,
		retry: false,
		meta: PERSIST_META,
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
		meta: PERSIST_META,
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
		meta: PERSIST_META,
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
		meta: PERSIST_META,
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

/**
 * Pipeline-rendered thread messages — ready for direct rendering.
 *
 * Defaults to tail-loading the most recent
 * `DEFAULT_SESSION_THREAD_TAIL_LIMIT` records for snappy switches on huge
 * sessions. Older messages are fetched on demand via `expandSessionThread`
 * — that path writes into this same cache key (manual `setQueryData`
 * prepend) so the streaming-tail / optimistic-user / setQueryData helpers
 * stay tail-unaware.
 *
 * Pagination metadata (`hasMore`, `loadedTailLimit`) flows through the
 * sibling `session-thread-pagination` store so the cache value can stay a
 * plain `ThreadMessageLike[]`.
 */
export function sessionThreadMessagesQueryOptions(sessionId: string) {
	return queryOptions({
		queryKey: [...helmorQueryKeys.sessionMessages(sessionId), "thread"],
		// `loadSessionThreadMessages` updates the pagination store as a
		// side effect — going through it (rather than the raw page fetch)
		// keeps existing test mocks (`apiMocks.loadSessionThreadMessages`)
		// working unchanged.
		queryFn: () => loadSessionThreadMessages(sessionId),
		gcTime: SESSION_GC_TIME,
		staleTime: SESSION_STALE_TIME,
	});
}

/**
 * Step size for each "Load earlier" click. Roughly doubles the loaded
 * window every two clicks (200 -> 400 -> 600 -> 800 -> 1000 -> jump-to-full).
 * The "jump to full" guard exists because for very large sessions the user
 * typically wants to stop adding tens of clicks and load the rest in one
 * step once they're scrolling deep into history.
 */
const EXPAND_STEP = 200;
const EXPAND_FULL_THRESHOLD = 1000;

/**
 * Fetch the next chunk of older messages and prepend them to the cached
 * thread. Idempotent — a no-op when `hasMore` is already false. Resolves
 * once the cache and pagination store are both updated.
 *
 * Strategy:
 *   - Reads the currently loaded tailLimit from the pagination store.
 *   - Fetches a trailing window of size `currentLimit + EXPAND_STEP` (or
 *     a full load past `EXPAND_FULL_THRESHOLD`).
 *   - Dedupes against the in-cache messages by id and prepends the
 *     new "head only" portion to the cached array. This preserves
 *     streaming-tail writes and optimistic user bubbles that the
 *     backend doesn't know about yet.
 */
export async function expandSessionThread(
	client: QueryClient,
	sessionId: string,
): Promise<void> {
	const { hasMore, loadedTailLimit } =
		getSessionThreadPaginationState(sessionId);
	if (!hasMore) return;

	const nextTailLimit: number | null = (() => {
		if (loadedTailLimit === null) return null;
		const proposed = loadedTailLimit + EXPAND_STEP;
		return proposed >= EXPAND_FULL_THRESHOLD ? null : proposed;
	})();

	const page = await fetchSessionThreadMessagesPage(sessionId, {
		tailLimit: nextTailLimit,
	});

	const cacheKey = [
		...helmorQueryKeys.sessionMessages(sessionId),
		"thread",
	] as const;
	client.setQueryData<ThreadMessageLike[]>(cacheKey, (prev) => {
		const previous = prev ?? [];
		if (previous.length === 0) {
			return page.messages;
		}
		// Keep every message currently in the cache (including streaming
		// tails / optimistic ids the server doesn't know about) and
		// prepend the newly-revealed older portion. Dedupe by id so we
		// don't double-render rows that overlap the window.
		const seenIds = new Set<string>();
		for (const msg of previous) {
			if (msg.id != null) seenIds.add(msg.id);
		}
		const head: ThreadMessageLike[] = [];
		for (const msg of page.messages) {
			if (msg.id != null && seenIds.has(msg.id)) {
				// Stop at the first overlap — everything from here to the
				// tail is already in `previous` in correct chronological
				// order. (`page.messages` is the trailing window from the
				// DB, so the overlap is contiguous at the boundary.)
				break;
			}
			head.push(msg);
		}
		if (head.length === 0) {
			return previous;
		}
		return [...head, ...previous];
	});

	setSessionThreadPaginationState(sessionId, {
		hasMore: page.hasMore,
		loadedTailLimit: nextTailLimit,
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
			repoId,
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
		meta: PERSIST_META,
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
		// `staleTime: Infinity` + focus/mount `"always"` baseline shared
		// with the other identity-info queries. CI-progress refetch on
		// workspace switch is nudged by `useRefreshForgeOnWorkspaceSwitch`
		// — a queryKey change goes through `setOptions` →
		// `shouldFetchOptionally`, which gates on `isStale` (Infinity
		// blocks it) and ignores `refetchOnMount` (that only fires on
		// cold-start `onSubscribe`).
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: DEFAULT_GC_TIME,
		refetchOnWindowFocus: "always",
		refetchOnMount: "always",
		refetchInterval: (query) =>
			forgeActionStatusRefetchInterval(query.state.data),
		retry: 0,
		meta: PERSIST_META,
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
