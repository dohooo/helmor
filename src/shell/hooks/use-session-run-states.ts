import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { PendingCreatedWorkspaceSubmit } from "@/features/conversation";
import { activeStreamsQueryOptions } from "@/lib/query-client";
import {
	buildSessionRunStates,
	deriveBusySessionIds,
	deriveBusyWorkspaceIds,
	deriveStoppableSessionIds,
	type SessionRunState,
} from "@/lib/session-run-state";
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
