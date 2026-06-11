import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type {
	WorkspaceGroup,
	WorkspaceRow,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import type { SelectionActions } from "@/shell/controllers/use-selection-controller";
import { findAdjacentSessionId, findAdjacentWorkspaceId } from "@/shell/layout";

/**
 * Keyboard navigation between sessions (within the active workspace) and
 * between workspaces. Extracted verbatim from AppShell (Phase 2 split).
 *
 * Both handlers read the live selection through `selectionActions.getSnapshot()`
 * (never a render-time snapshot) so a rapid sequence of hotkey taps always
 * steps off the most recently committed selection. The pivot setters
 * `handleSelectWorkspace` / `handleSelectSession` stay in AppShell's
 * orchestration layer and are threaded in; this hook never owns them.
 * Dependency arrays are preserved exactly as the original inline callbacks.
 */
export function useWorkspaceNavigation({
	queryClient,
	selectionActions,
	workspaceGroups,
	archivedRows,
	handleSelectWorkspace,
	handleSelectSession,
}: {
	queryClient: QueryClient;
	selectionActions: SelectionActions;
	workspaceGroups: WorkspaceGroup[];
	archivedRows: WorkspaceRow[];
	handleSelectWorkspace: (workspaceId: string | null) => void;
	handleSelectSession: (sessionId: string | null) => void;
}) {
	const handleNavigateSessions = useCallback(
		(offset: -1 | 1) => {
			const snapshot = selectionActions.getSnapshot();
			const workspaceId = snapshot.workspaceId;
			if (!workspaceId) return;
			const workspaceSessions =
				queryClient.getQueryData<WorkspaceSessionSummary[]>(
					helmorQueryKeys.workspaceSessions(workspaceId),
				) ?? [];
			const nextSessionId = findAdjacentSessionId(
				workspaceSessions,
				snapshot.sessionId,
				offset,
			);
			if (!nextSessionId) return;
			handleSelectSession(nextSessionId);
		},
		[handleSelectSession, queryClient, selectionActions],
	);

	const handleNavigateWorkspaces = useCallback(
		(offset: -1 | 1) => {
			const snapshot = selectionActions.getSnapshot();
			const nextWorkspaceId = findAdjacentWorkspaceId(
				workspaceGroups,
				archivedRows,
				snapshot.workspaceId,
				offset,
			);
			if (!nextWorkspaceId) return;
			handleSelectWorkspace(nextWorkspaceId);
		},
		[archivedRows, handleSelectWorkspace, selectionActions, workspaceGroups],
	);

	return { handleNavigateSessions, handleNavigateWorkspaces };
}
