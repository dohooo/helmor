export type SessionRunPhase = "pendingFinalize" | "streaming";

export type SessionRunState = {
	sessionId: string;
	workspaceId: string | null;
	phase: SessionRunPhase;
	canStop: boolean;
};

export type SessionRunStateMap = Map<string, SessionRunState>;

export function nextSessionRunStates(
	current: ReadonlyMap<string, SessionRunState>,
	update: {
		sessionId: string;
		workspaceId: string | null;
		running: boolean;
	},
): SessionRunStateMap {
	const next = new Map(current);
	if (!update.running) {
		next.delete(update.sessionId);
		return next;
	}

	next.set(update.sessionId, {
		sessionId: update.sessionId,
		workspaceId: update.workspaceId,
		phase: "streaming",
		canStop: true,
	});
	return next;
}

export function withPendingFinalizeRunState(
	current: ReadonlyMap<string, SessionRunState>,
	pending: {
		sessionId: string;
		workspaceId: string;
	} | null,
): SessionRunStateMap {
	const next = new Map(current);
	if (!pending || next.has(pending.sessionId)) {
		return next;
	}

	next.set(pending.sessionId, {
		sessionId: pending.sessionId,
		workspaceId: pending.workspaceId,
		phase: "pendingFinalize",
		canStop: false,
	});
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
