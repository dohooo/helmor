/**
 * Room-presence store (typing-only this pass).
 *
 * Tracks which teammate is currently typing in a shared team workspace so the
 * sidebar row can show their avatar. The backend stamps a trusted `memberId`
 * + monotonic `ts` and broadcasts `roomPresenceChanged` over the shared
 * UI-sync stream; {@link usePresenceSubscription} feeds those events here.
 *
 * Keyed by `workspaceId`. Identity-stable updates (the state object is only
 * replaced when something actually changed) keep Zustand's selector re-render
 * fan-out scoped to the rows whose presence flipped.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { useTeamIdentity } from "@/features/team/use-team-identity";
import { subscribeUiMutations, type UiMutationEvent } from "@/lib/api";

/**
 * How long a presence entry stays "live" without a refresh. The backend
 * re-stamps an active peer (typing throttle) well inside this window; a peer
 * that goes quiet ages out via {@link isPresenceLive} + the prune timer.
 */
export const PRESENCE_TTL_MS = 10_000;

export type PresenceEntry = {
	memberId: string;
	activity: "typing" | "working";
	ts: number;
};

/**
 * A presence entry is live for the first {@link PRESENCE_TTL_MS} after its last
 * refresh. Pure, so the read path (the sidebar) and the prune timer below share
 * exactly one definition of "live" — strict `<` so an entry is already stale at
 * the instant the timer is scheduled to fire (no delay-0 reschedule loop).
 */
export function isPresenceLive(entry: PresenceEntry, nowMs: number): boolean {
	return nowMs - entry.ts < PRESENCE_TTL_MS;
}

type PresenceState = {
	byWorkspace: Record<string, PresenceEntry>;
};

type PresenceActions = {
	/**
	 * Fold a `roomPresenceChanged` event into the store. `idle` deletes the
	 * workspace entry; `typing` / `working` upsert it. Out-of-order events
	 * (a `ts` older than the stored one) are ignored. Returns the same state
	 * object when nothing changed so selectors bail on no-ops.
	 */
	applyPresence(event: RoomPresenceEvent): void;
};

export type PresenceStore = PresenceState & PresenceActions;

/** The `roomPresenceChanged` variant of {@link UiMutationEvent}. */
type RoomPresenceEvent = Extract<
	UiMutationEvent,
	{ type: "roomPresenceChanged" }
>;

/**
 * A single timer drops the soonest-expiring entry the moment it ages past the
 * TTL and re-renders the sidebar — so an idle peer's indicator clears even when
 * nothing else would re-render the row. It re-arms against the remaining
 * entries and stops once presence is empty (no polling, no `setInterval`).
 * Read-time {@link isPresenceLive} stays the value authority and covers the
 * instant before the timer fires (e.g. a throttled background timer).
 */
let pruneTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePrune(byWorkspace: Record<string, PresenceEntry>): void {
	if (pruneTimer !== null) {
		clearTimeout(pruneTimer);
		pruneTimer = null;
	}
	const entries = Object.values(byWorkspace);
	if (entries.length === 0) return;
	const soonest = Math.min(...entries.map((e) => e.ts)) + PRESENCE_TTL_MS;
	pruneTimer = setTimeout(
		() => {
			pruneTimer = null;
			const now = Date.now();
			const current = usePresenceStore.getState().byWorkspace;
			const live: Record<string, PresenceEntry> = {};
			for (const [id, entry] of Object.entries(current)) {
				if (isPresenceLive(entry, now)) live[id] = entry;
			}
			if (Object.keys(live).length !== Object.keys(current).length) {
				usePresenceStore.setState({ byWorkspace: live });
			}
			schedulePrune(live);
		},
		Math.max(0, soonest - Date.now()),
	);
}

export const usePresenceStore = create<PresenceStore>((set, get) => ({
	byWorkspace: {},

	applyPresence: (event) => {
		set((state) => {
			const current = state.byWorkspace[event.workspaceId];
			if (event.activity === "idle") {
				if (!current) return state;
				const next = { ...state.byWorkspace };
				delete next[event.workspaceId];
				return { byWorkspace: next };
			}
			// Out-of-order guard: never let an older event clobber a newer one.
			if (current && event.ts < current.ts) return state;
			return {
				byWorkspace: {
					...state.byWorkspace,
					[event.workspaceId]: {
						memberId: event.memberId,
						activity: event.activity,
						ts: event.ts,
					},
				},
			};
		});
		// Re-arm the expiry sweep against the new state.
		schedulePrune(get().byWorkspace);
	},
}));

/**
 * Headless subscription: opens ONE `roomPresenceChanged` listener and folds
 * each event into the store. Mount once (shell-level). Skips the local user's
 * OWN presence (the backend echoes it back) by comparing against the GitHub
 * numeric id the server stamps as `memberId` — same source as the team
 * identity. When the own id isn't resolvable yet, events still apply (a user
 * briefly seeing their own typing is cosmetic only).
 */
export function usePresenceSubscription(): void {
	const ownMemberId = useTeamIdentity().identity?.githubId ?? null;
	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;
		subscribeUiMutations((event) => {
			if (disposed || event.type !== "roomPresenceChanged") return;
			// Self-echo guard: never surface our own typing on our own sidebar.
			if (ownMemberId !== null && event.memberId === ownMemberId) return;
			usePresenceStore.getState().applyPresence(event);
		})
			.then((cleanup) => {
				if (disposed) cleanup();
				else unlisten = cleanup;
			})
			.catch((error) => {
				console.error("[presence] subscribe failed", error);
			});
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [ownMemberId]);
}

/** Reset all state + cancel the prune timer. Test-only. */
export function _resetForTesting() {
	if (pruneTimer !== null) {
		clearTimeout(pruneTimer);
		pruneTimer = null;
	}
	usePresenceStore.setState({ byWorkspace: {} });
}
