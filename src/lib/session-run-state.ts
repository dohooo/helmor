import type { ActiveStreamSummary } from "./api";

export type SessionRunPhase = "pendingFinalize" | "streaming";

export type SessionRunState = {
	sessionId: string;
	workspaceId: string | null;
	phase: SessionRunPhase;
	canStop: boolean;
};

export type SessionRunStateMap = Map<string, SessionRunState>;

/** Merge backend truth (`activeStreams`) with the StartPage optimistic
 *  "this session is being created" marker (`pending`). The pending
 *  finalize entry is busy-but-not-stoppable: the workspace doesn't exist
 *  yet so there's no stream to abort, but the panel header should still
 *  show a loading spinner for the optimistic user bubble.
 *
 *  Streaming wins over pending — once the real stream registers, the
 *  same sessionId flips to canStop=true. */
export function buildSessionRunStates(
	activeStreams: readonly ActiveStreamSummary[],
	pending: { sessionId: string; workspaceId: string } | null,
): SessionRunStateMap {
	const next: SessionRunStateMap = new Map();
	for (const stream of activeStreams) {
		next.set(stream.sessionId, {
			sessionId: stream.sessionId,
			workspaceId: stream.workspaceId,
			phase: "streaming",
			canStop: true,
		});
	}
	if (pending && !next.has(pending.sessionId)) {
		next.set(pending.sessionId, {
			sessionId: pending.sessionId,
			workspaceId: pending.workspaceId,
			phase: "pendingFinalize",
			canStop: false,
		});
	}
	return next;
}

export function deriveBusySessionIds(
	states: ReadonlyMap<string, SessionRunState>,
): Set<string> {
	return new Set(states.keys());
}

export function deriveStoppableSessionIds(
	states: ReadonlyMap<string, SessionRunState>,
): Set<string> {
	const ids = new Set<string>();
	for (const state of states.values()) {
		if (state.canStop) {
			ids.add(state.sessionId);
		}
	}
	return ids;
}

export function deriveBusyWorkspaceIds(
	states: ReadonlyMap<string, SessionRunState>,
): Set<string> {
	const ids = new Set<string>();
	for (const state of states.values()) {
		if (state.workspaceId) {
			ids.add(state.workspaceId);
		}
	}
	return ids;
}
