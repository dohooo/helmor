import type { QueryClient } from "@tanstack/react-query";
import { helmorQueryKeys } from "./query-client";

// Module-level counter shared across the app. Any code path about to
// mutate the sidebar lists (archive, restore, create, delete, pin,
// commit, …) wraps the async work in begin/end. While the counter is
// non-zero, concurrent invalidate callers (mark-read, git watcher
// events, ui-sync-bridge fan-out, …) skip refetching workspaceGroups /
// archivedWorkspaces — refetching mid-mutation would overwrite the
// optimistic cache with a stale server snapshot and flicker the row
// back to its pre-mutation position before settling.
//
// Two invariants keep this safe:
//   1) The gate's clients honor begin/end pairing (`holdSidebarMutation`
//      and `createScopedSidebarGate` produce idempotent releasers so
//      double-end is a no-op, and tests in `sidebar-mutation-gate.test`
//      cover the leak / nesting cases).
//   2) NO business code calls `queryClient.invalidateQueries({queryKey:
//      workspaceGroups | archivedWorkspaces})` directly. Everyone routes
//      through `requestSidebarReconcile`. This contract is upheld by
//      convention — reviewers should reject any direct invalidate of
//      the sidebar lists outside this file.
let pending = 0;

/**
 * @internal — primitive used by `holdSidebarMutation` and
 * `createScopedSidebarGate`, and by gate tests. Production code MUST
 * NOT call this directly; use `holdSidebarMutation` so begin/end
 * pairing is enforced even on early returns / throws.
 */
export function beginSidebarMutation(): void {
	pending += 1;
}

/**
 * @internal — see `beginSidebarMutation`. When `queryClient` is
 * supplied and the counter reaches zero, sidebar lists are reconciled
 * (a single pair of invalidates against `workspaceGroups` +
 * `archivedWorkspaces`). The no-arg shape exists only so the counter
 * can be decremented in test scenarios that don't care about
 * reconcile.
 */
export function endSidebarMutation(queryClient?: QueryClient): void {
	pending = Math.max(0, pending - 1);
	if (queryClient && pending === 0) {
		reconcileSidebarListsInternal(queryClient);
	}
}

/**
 * Acquire the gate and return a release function. The releaser is
 * idempotent — calling it twice still decrements the counter only
 * once. Designed for try/finally:
 *
 *     const release = holdSidebarMutation(queryClient);
 *     try { await mutate(); } finally { release(); }
 */
export function holdSidebarMutation(queryClient: QueryClient): () => void {
	beginSidebarMutation();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		endSidebarMutation(queryClient);
	};
}

/**
 * Per-id scoped gate. Used by fire-and-forget worker flows (archive,
 * etc.) where `begin` happens on the IPC start and `end` waits for a
 * backend event correlating back to the same id — duplicate events or
 * end-before-begin must be safe.
 *
 * Always call `disposeAll()` from the owner's cleanup path (React
 * `useEffect` return / unmount) so an in-flight mutation can't leak
 * the module-level counter if the owner goes away before its backend
 * event arrives. After dispose the gate is unusable.
 */
export function createScopedSidebarGate(queryClient: QueryClient): {
	begin: (id: string) => void;
	end: (id: string) => void;
	disposeAll: () => void;
} {
	const active = new Set<string>();
	let disposed = false;
	return {
		begin(id) {
			if (disposed) return;
			if (active.has(id)) return;
			active.add(id);
			beginSidebarMutation();
		},
		end(id) {
			if (disposed) return;
			if (!active.delete(id)) return;
			endSidebarMutation(queryClient);
		},
		disposeAll() {
			if (disposed) return;
			disposed = true;
			// Release every outstanding hold the gate owns. The
			// reconcile at counter==0 fires through the final
			// `endSidebarMutation` call, exactly once.
			for (const _ of active) {
				endSidebarMutation(queryClient);
			}
			active.clear();
		},
	};
}

/**
 * The ONLY way for non-mutation-owner code to invalidate sidebar
 * lists. Skips while a mutation is in flight; reconciles otherwise.
 *
 * Direct `queryClient.invalidateQueries({queryKey: workspaceGroups |
 * archivedWorkspaces})` in business code would race with optimistic
 * state during a mutation. Don't do that — call this function instead.
 */
export function requestSidebarReconcile(queryClient: QueryClient): void {
	if (pending > 0) return;
	reconcileSidebarListsInternal(queryClient);
}

function reconcileSidebarListsInternal(queryClient: QueryClient): void {
	void queryClient.invalidateQueries({
		queryKey: helmorQueryKeys.workspaceGroups,
	});
	void queryClient.invalidateQueries({
		queryKey: helmorQueryKeys.archivedWorkspaces,
	});
}

/** Test-only: zero the counter between cases so leaked mutations from
 * one test don't gate flushes in the next. */
export function resetSidebarMutationGate(): void {
	pending = 0;
}

/** Test-only: introspect the counter (for assertions on leak / nesting). */
export function isSidebarMutationInFlight(): boolean {
	return pending > 0;
}
