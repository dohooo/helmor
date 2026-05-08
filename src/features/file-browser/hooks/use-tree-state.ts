import { useCallback, useSyncExternalStore } from "react";

/**
 * Per-workspace expansion state for the file browser tree. Folders that the
 * user has expanded stay expanded across re-renders and across remounts of
 * the tree (e.g. switching tabs and back).
 *
 * State lives at module scope so it survives unmount/remount cycles; the
 * `workspaceId` keying keeps each workspace's expansion isolated.
 */
const expandedByWorkspace = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const EMPTY_SET: ReadonlySet<string> = new Set();

function subscribe(callback: () => void) {
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}

function emit() {
	for (const listener of listeners) listener();
}

function getSnapshot(workspaceId: string | null): ReadonlySet<string> {
	if (!workspaceId) return EMPTY_SET;
	return expandedByWorkspace.get(workspaceId) ?? EMPTY_SET;
}

export function useTreeState(workspaceId: string | null) {
	const expandedSet = useSyncExternalStore(
		subscribe,
		() => getSnapshot(workspaceId),
		() => getSnapshot(workspaceId),
	);

	const isExpanded = useCallback(
		(path: string) => expandedSet.has(path),
		[expandedSet],
	);

	const toggle = useCallback(
		(path: string) => {
			if (!workspaceId) return;
			const current = expandedByWorkspace.get(workspaceId) ?? new Set<string>();
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			expandedByWorkspace.set(workspaceId, next);
			emit();
		},
		[workspaceId],
	);

	return { isExpanded, toggle };
}
