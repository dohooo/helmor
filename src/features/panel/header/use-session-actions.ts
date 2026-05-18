// Session CRUD for the panel header tabs: create, hide, rename, delete
// (the last two land on hidden sessions in the History dropdown). Owns the
// in-place rename input state too. The hide flow defers to
// `onRequestCloseSession` when provided so the running-session confirm
// dialog can intercept.
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { clearPersistedDraft } from "@/features/composer/draft-storage";
import {
	type AgentProvider,
	createSession,
	deleteSession,
	renameSession,
	type WorkspaceDetail,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { seedNewSessionInCache } from "../session-cache";
import { closeWorkspaceSession } from "../session-close";
import type { SessionCloseRequest } from "../use-confirm-session-close";

function displaySessionTitle(session: WorkspaceSessionSummary): string {
	return session.title ?? "Untitled";
}

export type SessionActionsController = {
	editingSessionId: string | null;
	editingTitle: string;
	setEditingTitle(value: string): void;
	createSession(): Promise<void>;
	hideSession(sessionId: string, event: React.MouseEvent): Promise<void>;
	deleteHiddenSession(sessionId: string): Promise<void>;
	startRename(session: WorkspaceSessionSummary, event: React.MouseEvent): void;
	commitRename(): Promise<void>;
	cancelRename(): void;
};

export function useSessionActions({
	workspace,
	sessions,
	selectedSessionId,
	sessionDisplayProviders,
	queryClient,
	pushToast,
	onSelectSession,
	onSessionsChanged,
	onSessionRenamed,
	onRequestCloseSession,
	onAfterDelete,
}: {
	workspace: WorkspaceDetail | null;
	sessions: WorkspaceSessionSummary[];
	selectedSessionId: string | null;
	sessionDisplayProviders?: Record<string, AgentProvider>;
	queryClient: QueryClient;
	pushToast: PushWorkspaceToast;
	onSelectSession?: (sessionId: string) => void;
	onSessionsChanged?: () => void;
	onSessionRenamed?: (sessionId: string, title: string) => void;
	onRequestCloseSession?: (request: SessionCloseRequest) => void;
	onAfterDelete?: (sessionId: string) => void;
}): SessionActionsController {
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState("");

	const createSessionAction = useCallback(async () => {
		if (!workspace) return;
		try {
			const result = await createSession(workspace.id);
			seedNewSessionInCache({
				queryClient,
				workspaceId: workspace.id,
				sessionId: result.sessionId,
				workspace,
				existingSessions: sessions,
				createdAt: new Date().toISOString(),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.repoScripts(workspace.repoId, workspace.id),
			});
			onSessionsChanged?.();
			onSelectSession?.(result.sessionId);
		} catch (error) {
			console.error("Failed to create session:", error);
		}
	}, [onSelectSession, onSessionsChanged, queryClient, sessions, workspace]);

	const hideSession = useCallback(
		async (sessionId: string, event: React.MouseEvent) => {
			event.stopPropagation();
			if (!workspace) return;
			const targetSession =
				sessions.find((session) => session.id === sessionId) ?? null;
			if (!targetSession) return;

			// When the caller provided a shared confirm-close hook
			// (`onRequestCloseSession`), delegate — it handles the running-
			// session confirmation dialog itself. Otherwise fall back to an
			// unconditional close.
			if (onRequestCloseSession) {
				onRequestCloseSession({
					workspace,
					sessions,
					session: targetSession,
					activateAdjacent: targetSession.id === selectedSessionId,
					provider: sessionDisplayProviders?.[targetSession.id] ?? null,
					onSessionsChanged,
				});
				return;
			}

			await closeWorkspaceSession({
				queryClient,
				workspace,
				sessions,
				sessionId,
				activateAdjacent: sessionId === selectedSessionId,
				onSelectSession,
				onSessionsChanged,
				pushToast,
			});
		},
		[
			onRequestCloseSession,
			onSelectSession,
			onSessionsChanged,
			pushToast,
			queryClient,
			selectedSessionId,
			sessionDisplayProviders,
			sessions,
			workspace,
		],
	);

	const deleteHiddenSession = useCallback(
		async (sessionId: string) => {
			await deleteSession(sessionId);
			clearPersistedDraft(`session:${sessionId}`);
			onAfterDelete?.(sessionId);
			onSessionsChanged?.();
		},
		[onAfterDelete, onSessionsChanged],
	);

	const startRename = useCallback(
		(session: WorkspaceSessionSummary, event: React.MouseEvent) => {
			event.stopPropagation();
			setEditingSessionId(session.id);
			setEditingTitle(displaySessionTitle(session));
		},
		[],
	);

	const commitRename = useCallback(async () => {
		if (!editingSessionId) return;
		const trimmed = editingTitle.trim();
		if (trimmed) {
			await renameSession(editingSessionId, trimmed);
			onSessionRenamed?.(editingSessionId, trimmed);
		}
		setEditingSessionId(null);
		setEditingTitle("");
	}, [editingSessionId, editingTitle, onSessionRenamed]);

	const cancelRename = useCallback(() => {
		setEditingSessionId(null);
		setEditingTitle("");
	}, []);

	return {
		editingSessionId,
		editingTitle,
		setEditingTitle,
		createSession: createSessionAction,
		hideSession,
		deleteHiddenSession,
		startRename,
		commitRename,
		cancelRename,
	};
}
