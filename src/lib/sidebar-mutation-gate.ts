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
//      through `requestSidebarReconcile`. This is enforced by
//      `scripts/check-sidebar-invalidate.ts`, wired into `bun run lint`.
let pending = 0;

/**
 * Acquire the gate before any optimistic write to sidebar lists. Pair
 * with `endSidebarMutation`. Prefer `holdSidebarMutation` (returns a
 * disposable) which can't leak the counter on early returns / throws.
 */
export function beginSidebarMutation(): void {
	pending += 1;
}

/**
 * Release the gate. When `queryClient` is supplied and the counter
 * reaches zero, sidebar lists are reconciled with the server (a single
 * pair of invalidates against `workspaceGroups` + `archivedWorkspaces`).
 *
 * The `queryClient` parameter is optional only for the deprecated
 * no-arg shape during the migration; new code MUST pass it so
 * reconcile happens automatically. Prefer `holdSidebarMutation` which
 * handles both sides of the pairing.
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
 */
export function createScopedSidebarGate(queryClient: QueryClient): {
	begin: (id: string) => void;
	end: (id: string) => void;
} {
	const active = new Set<string>();
	return {
		begin(id) {
			if (active.has(id)) return;
			active.add(id);
			beginSidebarMutation();
		},
		end(id) {
			if (!active.delete(id)) return;
			endSidebarMutation(queryClient);
		},
	};
}

/**
 * The ONLY way for non-mutation-owner code to invalidate sidebar
 * lists. Skips while a mutation is in flight; reconciles otherwise.
 *
 * Direct `queryClient.invalidateQueries({queryKey: workspaceGroups |
 * archivedWorkspaces})` in business code would race with optimistic
 * state during a mutation — `scripts/check-sidebar-invalidate.ts`
 * enforces this at lint time.
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
