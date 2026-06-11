import type { QueryClient } from "@tanstack/react-query";
import type { WorkspaceDetail, WorkspaceSessionSummary } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";

export function buildOptimisticSession(
	workspaceId: string,
	sessionId: string,
	createdAt: string,
	sessionKind: "gui" | "terminal" = "gui",
	agentType: string | null = null,
): WorkspaceSessionSummary {
	return {
		id: sessionId,
		workspaceId,
		title: sessionKind === "terminal" ? "Terminal" : "Untitled",
		agentType,
		status: "idle",
		model: null,
		permissionMode: "default",
		providerSessionId: null,
		effortLevel: null,
		unreadCount: 0,
		fastMode: false,
		createdAt,
		updatedAt: createdAt,
		lastUserMessageAt: null,
		isHidden: false,
		actionKind: null,
		sessionKind,
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
	sessionKind?: "gui" | "terminal";
	agentType?: string | null;
};

export function seedNewSessionInCache({
	queryClient,
	workspaceId,
	sessionId,
	workspace = null,
	existingSessions,
	createdAt = new Date().toISOString(),
	sessionKind = "gui",
	agentType = null,
}: SeedNewSessionInCacheOptions): WorkspaceSessionSummary {
	const optimisticSession = buildOptimisticSession(
		workspaceId,
		sessionId,
		createdAt,
		sessionKind,
		agentType,
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
				activeSessionTitle: optimisticSession.title,
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
