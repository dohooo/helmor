import type { QueryClient } from "@tanstack/react-query";
import type { WorkspaceDetail, WorkspaceSessionSummary } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";

export function buildOptimisticSession(
	workspaceId: string,
	sessionId: string,
	createdAt: string,
): WorkspaceSessionSummary {
	return {
		id: sessionId,
		workspaceId,
		title: "Untitled",
		agentType: null,
		status: "idle",
		model: null,
		permissionMode: "default",
		providerSessionId: null,
		effortLevel: null,
		unreadCount: 0,
		contextTokenCount: 0,
		contextUsedPercent: null,
		thinkingEnabled: true,
		fastMode: false,
		agentPersonality: null,
		createdAt,
		updatedAt: createdAt,
		lastUserMessageAt: null,
		resumeSessionAt: null,
		isHidden: false,
		isCompacting: false,
		actionKind: null,
		active: true,
	};
}

type SeedNewSessionInCacheOptions = {
	queryClient: QueryClient;
	workspaceId: string;
	sessionId: string;
	workspace?: WorkspaceDetail | null;
	existingSessions?: WorkspaceSessionSummary[];
	createdAt?: string;
};

export function seedNewSessionInCache({
	queryClient,
	workspaceId,
	sessionId,
	workspace = null,
	existingSessions,
	createdAt = new Date().toISOString(),
}: SeedNewSessionInCacheOptions): WorkspaceSessionSummary {
	const optimisticSession = buildOptimisticSession(
		workspaceId,
		sessionId,
		createdAt,
	);

	queryClient.setQueryData(
		helmorQueryKeys.workspaceDetail(workspaceId),
		(current: WorkspaceDetail | null | undefined) => {
			const base = current ?? workspace;
			if (!base) {
				return current;
			}

			return {
				...base,
				activeSessionId: sessionId,
				activeSessionTitle: "Untitled",
				activeSessionAgentType: null,
				activeSessionStatus: "idle",
				sessionCount:
					base.activeSessionId === sessionId
						? base.sessionCount
						: base.sessionCount + 1,
			};
		},
	);
	queryClient.setQueryData(
		helmorQueryKeys.workspaceSessions(workspaceId),
		(current: WorkspaceSessionSummary[] | undefined) => {
			const resolvedSessions = current ?? existingSessions ?? [];
			if (resolvedSessions.some((session) => session.id === sessionId)) {
				return resolvedSessions.map((session) => ({
					...session,
					active: session.id === sessionId,
				}));
			}

			return [
				...resolvedSessions.map((session) => ({
					...session,
					active: false,
				})),
				optimisticSession,
			];
		},
	);
	queryClient.setQueryData(
		[...helmorQueryKeys.sessionMessages(sessionId), "thread"],
		[],
	);

	return optimisticSession;
}
