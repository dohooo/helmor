import type { QueryClient } from "@tanstack/react-query";
import { clearPersistedDraft } from "@/features/composer/draft-storage";
import {
	createSession,
	deleteSession,
	hideSession,
	type WorkspaceDetail,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { isNewSession } from "@/lib/workspace-helpers";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { buildOptimisticSession } from "./session-cache";

type CloseWorkspaceSessionOptions = {
	queryClient: QueryClient;
	workspace: WorkspaceDetail;
	sessions: WorkspaceSessionSummary[];
	sessionId: string;
	activateAdjacent?: boolean;
	onSelectSession?: (sessionId: string) => void;
	onSessionsChanged?: () => void;
	// Fires after a non-empty session is hidden (recoverable). Empty sessions
	// are deleted outright, so this callback is not invoked for them.
	onSessionHidden?: (sessionId: string, workspaceId: string) => void;
	pushToast?: PushWorkspaceToast;
};

function findAdjacentSessionId(
	sessions: WorkspaceSessionSummary[],
	sessionId: string,
) {
	const index = sessions.findIndex((session) => session.id === sessionId);
	if (index === -1) {
		return null;
	}

	return sessions[index + 1]?.id ?? sessions[index - 1]?.id ?? null;
}

export async function closeWorkspaceSession({
	queryClient,
	workspace,
	sessions,
	sessionId,
	activateAdjacent = false,
	onSelectSession,
	onSessionsChanged,
	onSessionHidden,
	pushToast,
}: CloseWorkspaceSessionOptions): Promise<boolean> {
	const targetSession =
		sessions.find((session) => session.id === sessionId) ?? null;
	if (!targetSession) {
		return false;
	}

	const isEmptySession = isNewSession(targetSession);
	const isClosingLastVisibleSession = sessions.length === 1;
	const adjacentSessionId = activateAdjacent
		? findAdjacentSessionId(sessions, sessionId)
		: null;

	try {
		if (isClosingLastVisibleSession) {
			const { sessionId: replacementSessionId } = await createSession(
				workspace.id,
			);
			const now = new Date().toISOString();
			const optimisticSession = buildOptimisticSession(
				workspace.id,
				replacementSessionId,
				now,
			);
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.repoScripts(workspace.repoId, workspace.id),
			});

			queryClient.setQueryData(
				helmorQueryKeys.workspaceDetail(workspace.id),
				(current: WorkspaceDetail | null | undefined) => {
					const base = current ?? workspace;
					if (!base) {
						return base;
					}

					return {
						...base,
						activeSessionId: replacementSessionId,
						activeSessionTitle: "Untitled",
						activeSessionAgentType: null,
						activeSessionStatus: "idle",
						sessionCount: Math.max(1, base.sessionCount),
					};
				},
			);
			queryClient.setQueryData(
				helmorQueryKeys.workspaceSessions(workspace.id),
				() => [optimisticSession],
			);
			queryClient.setQueryData(
				[...helmorQueryKeys.sessionMessages(replacementSessionId), "thread"],
				[],
			);

			onSelectSession?.(replacementSessionId);
		}

		// New sessions (never had any messages) are deleted outright instead of
		// being hidden, so they don't clutter the history list.
		if (isEmptySession) {
			await deleteSession(sessionId);
			clearPersistedDraft(`session:${sessionId}`);
		} else {
			await hideSession(sessionId);
			onSessionHidden?.(sessionId, workspace.id);
		}

		if (adjacentSessionId) {
			const adjacentSession =
				sessions.find((session) => session.id === adjacentSessionId) ?? null;

			queryClient.setQueryData(
				helmorQueryKeys.workspaceDetail(workspace.id),
				(current: WorkspaceDetail | null | undefined) => {
					const base = current ?? workspace;
					if (!base) {
						return base;
					}

					return {
						...base,
						activeSessionId: adjacentSessionId,
						activeSessionTitle: adjacentSession?.title ?? "Untitled",
						activeSessionAgentType: adjacentSession?.agentType ?? null,
						activeSessionStatus: adjacentSession?.status ?? "idle",
						sessionCount: Math.max(0, base.sessionCount - 1),
					};
				},
			);
			queryClient.setQueryData(
				helmorQueryKeys.workspaceSessions(workspace.id),
				(current: WorkspaceSessionSummary[] | undefined) =>
					(current ?? sessions)
						.filter((session) => session.id !== sessionId)
						.map((session) => ({
							...session,
							active: session.id === adjacentSessionId,
						})),
			);
			onSelectSession?.(adjacentSessionId);
		}

		onSessionsChanged?.();
		return true;
	} catch (error) {
		console.error("Failed to close session:", error);
		onSessionsChanged?.();
		pushToast?.(
			error instanceof Error ? error.message : String(error),
			"Unable to close session",
			"destructive",
		);
		return false;
	}
}
