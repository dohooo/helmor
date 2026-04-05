import { QueryClient, queryOptions } from "@tanstack/react-query";
import {
	DEFAULT_AGENT_MODEL_SECTIONS,
	DEFAULT_WORKSPACE_GROUPS,
	listRepositories,
	loadAgentModelSections,
	loadArchivedWorkspaces,
	loadSessionAttachments,
	loadSessionMessages,
	loadWorkspaceDetail,
	loadWorkspaceGroups,
	loadWorkspaceSessions,
} from "./api";

const NAVIGATION_STALE_TIME = 15_000;
const WORKSPACE_STALE_TIME = 20_000;
const SESSION_STALE_TIME = 45_000;
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
	sessionMessages: (workspaceId: string, sessionId: string) =>
		["sessionMessages", workspaceId, sessionId] as const,
	sessionAttachments: (workspaceId: string, sessionId: string) =>
		["sessionAttachments", workspaceId, sessionId] as const,
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
		staleTime: NAVIGATION_STALE_TIME,
	});
}

export function archivedWorkspacesQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.archivedWorkspaces,
		queryFn: loadArchivedWorkspaces,
		initialData: [],
		staleTime: NAVIGATION_STALE_TIME,
	});
}

export function repositoriesQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.repositories,
		queryFn: listRepositories,
		initialData: [],
		staleTime: NAVIGATION_STALE_TIME,
	});
}

export function agentModelSectionsQueryOptions() {
	return queryOptions({
		queryKey: helmorQueryKeys.agentModelSections,
		queryFn: loadAgentModelSections,
		initialData: DEFAULT_AGENT_MODEL_SECTIONS,
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

export function sessionMessagesQueryOptions(
	workspaceId: string,
	sessionId: string,
) {
	return queryOptions({
		queryKey: helmorQueryKeys.sessionMessages(workspaceId, sessionId),
		queryFn: () => loadSessionMessages(sessionId),
		gcTime: SESSION_GC_TIME,
		staleTime: SESSION_STALE_TIME,
	});
}

export function sessionAttachmentsQueryOptions(
	workspaceId: string,
	sessionId: string,
) {
	return queryOptions({
		queryKey: helmorQueryKeys.sessionAttachments(workspaceId, sessionId),
		queryFn: () => loadSessionAttachments(sessionId),
		gcTime: SESSION_GC_TIME,
		staleTime: SESSION_STALE_TIME,
	});
}
