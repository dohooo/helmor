import { QueryClient, queryOptions } from "@tanstack/react-query";
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
	loadWorkspaceGroups,
	loadWorkspaceSessions,
	lookupWorkspacePr,
} from "./api";

const NAVIGATION_STALE_TIME = 15_000;
const WORKSPACE_STALE_TIME = 5 * 60_000;
const SESSION_STALE_TIME = 10 * 60_000;
const CHANGES_STALE_TIME = 3_000;
const CHANGES_REFETCH_INTERVAL = 10_000;
const DEFAULT_GC_TIME = 30 * 60_000;
const SESSION_GC_TIME = 60 * 60_000;

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
	return new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: DEFAULT_GC_TIME,
				refetchOnReconnect: false,
				refetchOnWindowFocus: false,
				retry: 1,
			},
		},
	});
}

export function workspaceGroupsQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceGroups,
		queryFn: loadWorkspaceGroups,
		initialData: DEFAULT_WORKSPACE_GROUPS,
		initialDataUpdatedAt: 0,
		staleTime: NAVIGATION_STALE_TIME,
	});
}

export function archivedWorkspacesQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.archivedWorkspaces,
		queryFn: loadArchivedWorkspaces,
		initialData: [],
		initialDataUpdatedAt: 0,
		staleTime: NAVIGATION_STALE_TIME,
	});
}

export function repositoriesQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.repositories,
		queryFn: listRepositories,
		initialData: [],
		initialDataUpdatedAt: 0,
		staleTime: 5 * 60_000,
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
		staleTime: WORKSPACE_STALE_TIME,
	});
}

export function workspaceSessionsQueryOptions(workspaceId: string) {
	return queryOptions({
		queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
		queryFn: () => loadWorkspaceSessions(workspaceId),
		staleTime: WORKSPACE_STALE_TIME,
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
		// Retry on transient sidecar failures (cold-start `claude-code`,
		// control-protocol timeouts). Without this a single timeout would
		// lock the popup empty until the staleTime window expires, which
		// the user perceives as "/ doesn't open the menu anymore". Errors
		// are surfaced through `isError` so the popup can show a retry
		// affordance instead of silently failing.
		retry: 2,
		retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 4_000),
		// Refetch on mount so re-opening a workspace tab gets a fresh shot
		// at recovery without waiting out staleTime.
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
