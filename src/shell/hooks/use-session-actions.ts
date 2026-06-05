import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { seedNewSessionInCache } from "@/features/panel/session-cache";
import type { SessionCloseRequest } from "@/features/panel/use-confirm-session-close";
import {
	closeMainWindow,
	createSession,
	type WorkspaceDetail,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import { listen } from "@/lib/ipc";
import { helmorQueryKeys } from "@/lib/query-client";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import { isNewSession } from "@/lib/workspace-helpers";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import type { SelectionActions } from "@/shell/controllers/use-selection-controller";

/**
 * Session-level mutations AppShell exposes to keyboard shortcuts and the
 * conversation surface: resolve the currently-closeable session, close it
 * (through the shared confirm flow), and create a fresh session in the active
 * workspace. Also owns the `helmor://close-current-session` listener that the
 * menu's "Close Tab" item fires. Extracted verbatim from AppShell.
 *
 * Call this AFTER `useConfirmSessionClose` so its `requestClose` can be threaded
 * in as `requestCloseSession`; the close-session pivot `handleSelectSession`
 * stays in AppShell's orchestration layer and is passed in. The listen effect's
 * `disposed` / `unlisten` race-guard is preserved exactly. Dependency arrays
 * match the original inline callbacks.
 */
export function useSessionActions({
	queryClient,
	selectionActions,
	requestCloseSession,
	handleSelectSession,
	pushWorkspaceToast,
	workspaceViewMode,
}: {
	queryClient: QueryClient;
	selectionActions: SelectionActions;
	requestCloseSession: (request: SessionCloseRequest) => Promise<void>;
	handleSelectSession: (sessionId: string | null) => void;
	pushWorkspaceToast: PushWorkspaceToast;
	workspaceViewMode: string;
}) {
	const getCloseableCurrentSession = useCallback(() => {
		const snapshot = selectionActions.getSnapshot();
		if (snapshot.viewMode !== "conversation") {
			return null;
		}

		const workspaceId = snapshot.workspaceId;
		const sessionId = snapshot.sessionId;
		if (!workspaceId || !sessionId) {
			return null;
		}

		const workspace = queryClient.getQueryData<WorkspaceDetail | null>(
			helmorQueryKeys.workspaceDetail(workspaceId),
		);
		const sessions =
			queryClient.getQueryData<WorkspaceSessionSummary[]>(
				helmorQueryKeys.workspaceSessions(workspaceId),
			) ?? [];
		if (!workspace || !sessions.some((session) => session.id === sessionId)) {
			return null;
		}

		return {
			workspaceId,
			sessionId,
			workspace,
			sessions,
			session: sessions.find((candidate) => candidate.id === sessionId) ?? null,
		};
	}, [queryClient, selectionActions]);

	const handleCloseSelectedSession = useCallback(async () => {
		const currentSession = getCloseableCurrentSession();
		if (!currentSession?.session) {
			return;
		}

		const { workspaceId, sessionId, workspace, sessions, session } =
			currentSession;

		// Closing the last tab: if it's already an empty/untitled session,
		// close (hide) the window. Otherwise fall through to the normal close,
		// which hides this session and spawns a fresh untitled one in its place.
		if (sessions.length === 1 && isNewSession(session)) {
			await closeMainWindow();
			return;
		}

		await requestCloseSession({
			workspace,
			sessions,
			session,
			activateAdjacent: true,
			onSessionsChanged: () => {
				requestSidebarReconcile(queryClient);
				void Promise.all([
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
					}),
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
					}),
					queryClient.invalidateQueries({
						queryKey: [...helmorQueryKeys.sessionMessages(sessionId), "thread"],
					}),
				]);
			},
		});
	}, [getCloseableCurrentSession, queryClient, requestCloseSession]);

	const handleCreateSession = useCallback(async () => {
		const workspaceId = selectionActions.getSnapshot().workspaceId;
		if (!workspaceId) {
			return;
		}

		try {
			const { sessionId } = await createSession(workspaceId);
			const cachedWorkspace =
				queryClient.getQueryData<WorkspaceDetail | null>(
					helmorQueryKeys.workspaceDetail(workspaceId),
				) ?? null;
			seedNewSessionInCache({
				queryClient,
				workspaceId,
				sessionId,
				workspace: cachedWorkspace,
				existingSessions:
					queryClient.getQueryData<WorkspaceSessionSummary[]>(
						helmorQueryKeys.workspaceSessions(workspaceId),
					) ?? [],
			});
			handleSelectSession(sessionId);

			requestSidebarReconcile(queryClient);
			void Promise.all([
				...(cachedWorkspace
					? [
							queryClient.invalidateQueries({
								queryKey: helmorQueryKeys.repoScripts(
									cachedWorkspace.repoId,
									workspaceId,
								),
							}),
						]
					: []),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
				}),
			]);
		} catch (error) {
			pushWorkspaceToast(
				error instanceof Error ? error.message : String(error),
				"Unable to create session",
			);
		}
	}, [handleSelectSession, pushWorkspaceToast, queryClient]);

	useEffect(() => {
		if (workspaceViewMode !== "conversation") {
			return;
		}

		let disposed = false;
		let unlisten: (() => void) | undefined;

		void listen("helmor://close-current-session", () => {
			if (!getCloseableCurrentSession()) {
				return;
			}

			void handleCloseSelectedSession();
		}).then((fn) => {
			if (disposed) {
				fn();
				return;
			}
			unlisten = fn;
		});

		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [
		getCloseableCurrentSession,
		handleCloseSelectedSession,
		workspaceViewMode,
	]);

	return {
		getCloseableCurrentSession,
		handleCloseSelectedSession,
		handleCreateSession,
	};
}
