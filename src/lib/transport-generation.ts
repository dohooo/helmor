/**
 * Transport generation counter.
 *
 * A monotonic integer bumped by {@link bumpTransportGeneration} whenever the IPC
 * transport is repointed in place (team ↔ local, with no `window.location.reload`
 * — see `switchTeamMode` in `team-mode.ts`). Components keyed on it (the
 * `PersistQueryClientProvider` + router subtree in `app-providers.tsx`) remount
 * cleanly against the new transport, and `useAppBootstrap` recreates the
 * QueryClient so no cross-backend data bleeds through.
 *
 * Kept in its OWN module — deliberately NOT in `ipc.ts` — to avoid a circular
 * import: `team-mode.ts` imports this (to bump it) and `ipc.ts` imports
 * `team-mode.ts`. Routing the bump through `ipc.ts` would close that loop.
 *
 * Idiom mirrors the `subscribeCompanionConnection` store in `ipc.ts`: a plain
 * module-scoped value + listener set, surfaced reactively via
 * `useSyncExternalStore`.
 */
import { useSyncExternalStore } from "react";

let generation = 0;
const listeners = new Set<() => void>();

/** Current transport generation. Starts at 0; increments on each in-place
 *  transport switch. */
export function getTransportGeneration(): number {
	return generation;
}

/** Bump the transport generation and notify subscribers. Called by
 *  `switchTeamMode` AFTER the transport has been repointed, so consumers
 *  remount against the already-updated transport. */
export function bumpTransportGeneration(): void {
	generation++;
	for (const listener of listeners) listener();
}

/** Subscribe to generation changes (for `useSyncExternalStore`). */
export function subscribeTransportGeneration(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Reactive transport generation, for keying a remount. */
export function useTransportGeneration(): number {
	return useSyncExternalStore(
		subscribeTransportGeneration,
		getTransportGeneration,
		getTransportGeneration,
	);
}
