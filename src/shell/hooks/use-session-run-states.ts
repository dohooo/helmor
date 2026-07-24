import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { PendingCreatedWorkspaceSubmit } from "@/features/conversation";
import { activeStreamsQueryOptions, helmorQueryKeys } from "@/lib/query-client";
import {
	buildSessionRunStates,
	deriveBusySessionIds,
	deriveBusyWorkspaceIds,
	deriveStoppableSessionIds,
	type SessionRunState,
} from "@/lib/session-run-state";
import { isTeamModeActive } from "@/lib/team-mode";
import { EMPTY_ACTIVE_STREAMS } from "@/shell/constants";

/**
 * Source of truth for "which sessions are running": the Rust `ActiveStreams`
 * registry mirrored via React Query, with the StartPage's optimistic
 * "creating workspace" marker layered on top. Derives the busy/stoppable
 * session + workspace sets AppShell hands to the panel and sidebar.
 *
 * Extracted verbatim from AppShell (Phase 1 split). The `EMPTY_ACTIVE_STREAMS`
 * fallback and every memo's deps array are kept byte-for-byte, so the
 * referential-equality contract the `SessionRunStatesProvider` consumers depend
 * on is identical to the inline version.
 */
export function useSessionRunStates(
	pendingCreatedWorkspaceSubmit: PendingCreatedWorkspaceSubmit | null,
) {
	const activeStreamsQuery = useQuery(activeStreamsQueryOptions());
	// R2-E boot course-correction: team-mode activeStreams is event-driven and
	// never boot-fetched (a sleeping container has no turns to report). The one
	// gap is booting WHILE a teammate's turn is mid-flight — the D1 session
	// mirror marks that session `status: "running"`, so shortly after boot we
	// scan the cached session lists once and, on a hit, do a single refetch
	// (the container is provably awake — it's running the turn).
	const queryClient = useQueryClient();
	const bootCorrectedRef = useRef(false);
	useEffect(() => {
		if (bootCorrectedRef.current || !isTeamModeActive()) return;
		const timer = window.setTimeout(() => {
			if (bootCorrectedRef.current) return;
			bootCorrectedRef.current = true;
			const sessionLists = queryClient.getQueriesData<
				{ status?: string | null }[]
			>({ queryKey: ["workspaceSessions"] });
			const anyRunning = sessionLists.some(([, rows]) =>
				(rows ?? []).some((row) => row?.status === "running"),
			);
			if (anyRunning) {
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.activeStreams,
				});
			}
		}, 3_000);
		return () => window.clearTimeout(timer);
	}, [queryClient]);
	// Stable empty fallback so referential-equality consumers don't churn
	// on undefined-data ticks.
	const activeStreams = activeStreamsQuery.data ?? EMPTY_ACTIVE_STREAMS;
	const effectiveSessionRunStates = useMemo<
		ReadonlyMap<string, SessionRunState>
	>(
		() =>
			buildSessionRunStates(
				activeStreams,
				pendingCreatedWorkspaceSubmit
					? {
							sessionId: pendingCreatedWorkspaceSubmit.sessionId,
							workspaceId: pendingCreatedWorkspaceSubmit.workspaceId,
						}
					: null,
			),
		[activeStreams, pendingCreatedWorkspaceSubmit],
	);
	const effectiveBusySessionIds = useMemo(
		() => deriveBusySessionIds(effectiveSessionRunStates),
		[effectiveSessionRunStates],
	);
	const effectiveStoppableSessionIds = useMemo(
		() => deriveStoppableSessionIds(effectiveSessionRunStates),
		[effectiveSessionRunStates],
	);
	const effectiveBusyWorkspaceIds = useMemo(
		() => deriveBusyWorkspaceIds(effectiveSessionRunStates),
		[effectiveSessionRunStates],
	);
	return {
		activeStreams,
		effectiveSessionRunStates,
		effectiveBusySessionIds,
		effectiveStoppableSessionIds,
		effectiveBusyWorkspaceIds,
	};
}
