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
import { useSyncExternalStore } from "react";

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

const DEFAULT_STATE: SessionThreadPaginationState = {
	hasMore: false,
	loadedTailLimit: null,
};

const store = new Map<string, SessionThreadPaginationState>();
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) {
		listener();
	}
}

export function setSessionThreadPaginationState(
	sessionId: string,
	state: SessionThreadPaginationState,
) {
	const prev = store.get(sessionId);
	if (
		prev &&
		prev.hasMore === state.hasMore &&
		prev.loadedTailLimit === state.loadedTailLimit
	) {
		return;
	}
	store.set(sessionId, state);
	emit();
}

export function getSessionThreadPaginationState(
	sessionId: string,
): SessionThreadPaginationState {
	return store.get(sessionId) ?? DEFAULT_STATE;
}

export function clearSessionThreadPaginationState(sessionId: string) {
	if (!store.has(sessionId)) return;
	store.delete(sessionId);
	emit();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * React hook — re-renders when the named session's pagination state
 * changes. Returns the default `{ hasMore: false, loadedTailLimit: null }`
 * for unknown sessions (matches a session that has never been loaded).
 */
export function useSessionThreadPagination(
	sessionId: string | null,
): SessionThreadPaginationState {
	return useSyncExternalStore(
		subscribe,
		() => (sessionId ? (store.get(sessionId) ?? DEFAULT_STATE) : DEFAULT_STATE),
		() => DEFAULT_STATE,
	);
}
