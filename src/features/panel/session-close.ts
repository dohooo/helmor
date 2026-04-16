import type { QueryClient } from "@tanstack/react-query";
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
	onSelectSession?: (sessionId: string) => void;
	onSessionsChanged?: () => void;
	pushToast?: PushWorkspaceToast;
};

export async function closeWorkspaceSession({
	queryClient,
	workspace,
	sessions,
	sessionId,
	onSelectSession,
	onSessionsChanged,
	pushToast,
}: CloseWorkspaceSessionOptions): Promise<boolean> {
	const targetSession =
		sessions.find((session) => session.id === sessionId) ?? null;
	if (!targetSession) {
		return false;
	}

	const isEmptySession = isNewSession(targetSession);
	const isClosingLastVisibleSession = sessions.length === 1;

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
		} else {
			await hideSession(sessionId);
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
