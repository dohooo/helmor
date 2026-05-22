/**
 * Session thread pagination store.
 *
 * Tracks per-session `{ hasMore, loadedTailLimit }` outside React Query so
 * the main `[...sessionMessages, "thread"]` cache value can stay a plain
 * `ThreadMessageLike[]` — every existing `setQueryData<ThreadMessageLike[]>`
 * call site (streaming tail writes, optimistic user bubble, new-session
 * seeds, panel/container tests) keeps working without a shape migration.
 *
 * Written by:
 *   - `sessionThreadMessagesQueryOptions`' queryFn after each fetch
 *   - `expandSessionThread` after each "Load earlier" step
 *
 * Read via `useSessionThreadPagination(sessionId)` (the only consumer is
 * the viewport's load-earlier affordance).
 */
import { create } from "zustand";

export type SessionThreadPaginationState = {
	/**
	 * `true` when more historical records exist beyond the loaded window.
	 * `false` once the load covers the full session.
	 */
	hasMore: boolean;
	/**
	 * The `tailLimit` that produced the currently-loaded window. `null`
	 * means "full load — no window". Used by `expandSessionThread` to
	 * decide the next step size.
	 */
	loadedTailLimit: number | null;
};

const DEFAULT_STATE: SessionThreadPaginationState = Object.freeze({
	hasMore: false,
	loadedTailLimit: null,
});

type SessionThreadPaginationStore = {
	bySessionId: Record<string, SessionThreadPaginationState>;
	setState: (sessionId: string, next: SessionThreadPaginationState) => void;
	clear: (sessionId: string) => void;
};

const useSessionThreadPaginationStore = create<SessionThreadPaginationStore>(
	(set) => ({
		bySessionId: {},
		setState: (sessionId, next) =>
			set((state) => {
				const prev = state.bySessionId[sessionId];
				if (
					prev &&
					prev.hasMore === next.hasMore &&
					prev.loadedTailLimit === next.loadedTailLimit
				) {
					return state;
				}
				return {
					bySessionId: { ...state.bySessionId, [sessionId]: next },
				};
			}),
		clear: (sessionId) =>
			set((state) => {
				if (!(sessionId in state.bySessionId)) return state;
				const stripped = { ...state.bySessionId };
				delete stripped[sessionId];
				return { bySessionId: stripped };
			}),
	}),
);

export function setSessionThreadPaginationState(
	sessionId: string,
	next: SessionThreadPaginationState,
) {
	useSessionThreadPaginationStore.getState().setState(sessionId, next);
}

export function getSessionThreadPaginationState(
	sessionId: string,
): SessionThreadPaginationState {
	return (
		useSessionThreadPaginationStore.getState().bySessionId[sessionId] ??
		DEFAULT_STATE
	);
}

export function clearSessionThreadPaginationState(sessionId: string) {
	useSessionThreadPaginationStore.getState().clear(sessionId);
}

/**
 * React hook — re-renders when the named session's pagination state
 * changes. Returns the default `{ hasMore: false, loadedTailLimit: null }`
 * for unknown sessions (matches a session that has never been loaded).
 */
export function useSessionThreadPagination(
	sessionId: string | null,
): SessionThreadPaginationState {
	return useSessionThreadPaginationStore((state) =>
		sessionId ? (state.bySessionId[sessionId] ?? DEFAULT_STATE) : DEFAULT_STATE,
	);
}
