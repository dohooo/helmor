import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { applyImmediateWorkspaceHighlight } from "@/features/navigation/immediate-highlight";
import type {
	WorkspaceGroup,
	WorkspaceRow,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	type ScheduledAfterPaint,
	scheduleAfterNextPaint,
} from "@/lib/schedule-after-paint";
import type { SelectionActions } from "@/shell/controllers/use-selection-controller";
import { findAdjacentSessionId, findAdjacentWorkspaceId } from "@/shell/layout";

type PendingWorkspaceNavigation = {
	/** Where the chain will land once the deferred commit runs. */
	targetWorkspaceId: string;
	/** Router value when the chain started — if it moves, another input
	 *  path navigated and the chain must drop instead of overriding it. */
	routerBaseWorkspaceId: string | null;
	scheduled: ScheduledAfterPaint;
};

/**
 * Keyboard navigation between sessions (within the active workspace) and
 * between workspaces. Extracted verbatim from AppShell (Phase 2 split).
 *
 * Session steps read the live selection through
 * `selectionActions.getSnapshot()` (never a render-time snapshot) so rapid
 * taps always step off the most recently committed selection.
 *
 * Workspace steps run two-track: the keydown task only moves the imperative
 * sidebar highlight (cheap — it paints on the very next frame), while the
 * router commit + displayed flip are deferred past that paint. Rapid taps
 * (and the held-key repeat loop) chain off the pending target rather than
 * the router, so a burst moves the highlight per step but commits only the
 * landing workspace.
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

	const pendingNavigationRef = useRef<PendingWorkspaceNavigation | null>(null);
	useEffect(
		() => () => {
			pendingNavigationRef.current?.scheduled.cancel();
			pendingNavigationRef.current = null;
		},
		[],
	);

	const handleNavigateWorkspaces = useCallback(
		(offset: -1 | 1) => {
			const snapshot = selectionActions.getSnapshot();
			const pending = pendingNavigationRef.current;
			// Chain off the pending target (not the router) so rapid taps and
			// the held-repeat loop step correctly before the deferred commit
			// has landed.
			const baseWorkspaceId =
				pending?.targetWorkspaceId ?? snapshot.workspaceId;
			const nextWorkspaceId = findAdjacentWorkspaceId(
				workspaceGroups,
				archivedRows,
				baseWorkspaceId,
				offset,
			);
			if (!nextWorkspaceId) return;
			// Move the sidebar highlight inside the keydown task — it is the
			// only work this task does, so it paints on the next frame.
			// Null-safe: no-ops when the sidebar pane isn't mounted.
			applyImmediateWorkspaceHighlight(
				document.querySelector("[data-helmor-sidebar-root]"),
				nextWorkspaceId,
			);
			pending?.scheduled.cancel();
			const routerBaseWorkspaceId =
				pending?.routerBaseWorkspaceId ?? snapshot.workspaceId;
			const scheduled = scheduleAfterNextPaint(() => {
				pendingNavigationRef.current = null;
				// Another input path (mouse, quick-switch) navigated while the
				// chain was pending — its intent wins; drop the keyboard chain.
				if (
					selectionActions.getSnapshot().workspaceId !== routerBaseWorkspaceId
				) {
					return;
				}
				handleSelectWorkspace(nextWorkspaceId);
			});
			pendingNavigationRef.current = {
				targetWorkspaceId: nextWorkspaceId,
				routerBaseWorkspaceId,
				scheduled,
			};
		},
		[archivedRows, handleSelectWorkspace, selectionActions, workspaceGroups],
	);

	return { handleNavigateSessions, handleNavigateWorkspaces };
}
