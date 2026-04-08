import { QueryClient, queryOptions } from "@tanstack/react-query";
import {
	type AgentProvider,
	DEFAULT_AGENT_MODEL_SECTIONS,
	DEFAULT_WORKSPACE_GROUPS,
	listRepositories,
	listSlashCommands,
	listWorkspaceChangesWithContent,
	loadAgentModelSections,
	loadArchivedWorkspaces,
	loadSessionAttachments,
	loadSessionThreadMessages,
	loadWorkspaceDetail,
	loadWorkspaceGroups,
	loadWorkspaceSessions,
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
		// An empty list is a sane fallback if discovery fails (the popup
		// just won't surface) — never block the composer on errors here.
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
