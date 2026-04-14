import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { focusManager, QueryClient, queryOptions } from "@tanstack/react-query";
import {
	type AgentProvider,
	DEFAULT_AGENT_MODEL_SECTIONS,
	DEFAULT_WORKSPACE_GROUPS,
	listRepositories,
	listSlashCommands,
	listWorkspaceChangesWithContent,
	listWorkspaceFiles,
	loadAgentModelSections,
	loadArchivedWorkspaces,
	loadAutoCloseActionKinds,
	loadAutoCloseOptInAsked,
	loadSessionAttachments,
	loadSessionThreadMessages,
	loadWorkspaceDetail,
	loadWorkspaceGitActionStatus,
	loadWorkspaceGroups,
	loadWorkspacePrActionStatus,
	loadWorkspaceSessions,
	lookupWorkspacePr,
} from "./api";

const SESSION_STALE_TIME = 10 * 60_000;
const CHANGES_STALE_TIME = 3_000;
const CHANGES_REFETCH_INTERVAL = 10_000;
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
	sessionMessages: (sessionId: string) =>
		["sessionMessages", sessionId] as const,
	sessionAttachments: (sessionId: string) =>
		["sessionAttachments", sessionId] as const,
	workspaceChanges: (workspaceRootPath: string) =>
		["workspaceChanges", workspaceRootPath] as const,
	workspaceFiles: (workspaceRootPath: string) =>
		["workspaceFiles", workspaceRootPath] as const,
	workspacePr: (workspaceId: string) => ["workspacePr", workspaceId] as const,
	workspaceGitActionStatus: (workspaceId: string) =>
		["workspaceGitActionStatus", workspaceId] as const,
	workspacePrActionStatus: (workspaceId: string) =>
		["workspacePrActionStatus", workspaceId] as const,
	autoCloseActionKinds: ["autoCloseActionKinds"] as const,
	autoCloseOptInAsked: ["autoCloseOptInAsked"] as const,
	slashCommands: (
		provider: AgentProvider,
		workingDirectory: string | null,
		modelId: string | null,
	) =>
		["slashCommands", provider, workingDirectory ?? "", modelId ?? ""] as const,
};

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

export const helmorQueryPersister = createAsyncStoragePersister({
	storage: window.localStorage,
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
		initialData: DEFAULT_AGENT_MODEL_SECTIONS,
		initialDataUpdatedAt: 0,
		staleTime: 5 * 60_000,
	});
}

export function workspaceDetailQueryOptions(workspaceId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
		queryFn: () => loadWorkspaceDetail(workspaceId),
		staleTime: 0,
	});
}

export function workspaceSessionsQueryOptions(workspaceId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
		queryFn: () => loadWorkspaceSessions(workspaceId),
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

export function sessionAttachmentsQueryOptions(sessionId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.sessionAttachments(sessionId),
		queryFn: () => loadSessionAttachments(sessionId),
		gcTime: SESSION_GC_TIME,
		staleTime: 60_000,
	});
}

export function slashCommandsQueryOptions(
	provider: AgentProvider,
	workingDirectory: string | null,
	modelId: string | null,
) {
	return queryOptions({
		queryKey: helmorQueryKeys.slashCommands(
			provider,
			workingDirectory,
			modelId,
		),
		queryFn: () =>
			listSlashCommands({
				provider,
				workingDirectory,
				modelId,
			}),
		// Slash commands rarely change within a workspace; cache aggressively.
		staleTime: 5 * 60_000,
		gcTime: DEFAULT_GC_TIME,
		// The Rust backend always succeeds now (returns local skills from
		// disk even if the sidecar is unreachable), so retries are no longer
		// necessary. The background sidecar refresh handles recovery by
		// emitting a `slash-commands-refreshed` event which triggers a
		// query invalidation.
		retry: 0,
		// Refetch on mount so re-opening a workspace tab gets a fresh shot
		// at upgrading a partial cache to a complete one.
		refetchOnMount: "always",
	});
}

export function autoCloseActionKindsQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.autoCloseActionKinds,
		queryFn: loadAutoCloseActionKinds,
		initialData: [] as string[],
		initialDataUpdatedAt: 0,
		staleTime: 60_000,
	});
}

export function autoCloseOptInAskedQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.autoCloseOptInAsked,
		queryFn: loadAutoCloseOptInAsked,
		initialData: [] as string[],
		initialDataUpdatedAt: 0,
		staleTime: 60_000,
	});
}

/**
 * Current PR for a workspace's branch. Drives the commit button's resting
 * mode (create-pr → merge → merged) and the "Git · PR #xxx" header badge.
 * Polls every 60 s so the badge stays fresh even when the user leaves the
 * app open. Returns `null` when no PR is found or lookup is unavailable.
 */
export function workspacePrQueryOptions(workspaceId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspacePr(workspaceId),
		queryFn: () => lookupWorkspacePr(workspaceId),
		staleTime: 30_000,
		gcTime: DEFAULT_GC_TIME,
		refetchOnWindowFocus: true,
		refetchInterval: 60_000,
		retry: 0,
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

export function workspacePrActionStatusQueryOptions(workspaceId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspacePrActionStatus(workspaceId),
		queryFn: () => loadWorkspacePrActionStatus(workspaceId),
		staleTime: 30_000,
		gcTime: DEFAULT_GC_TIME,
		refetchInterval: 60_000,
		retry: 0,
	});
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
