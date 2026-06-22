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
 * How long a presence entry stays "live" without a refresh. Read-time only —
 * the selector treats an entry older than this as absent. No timers: a stale
 * entry simply stops being reported once the reporter goes quiet (the typing
 * debounce re-stamps `ts` well inside this window while editing continues).
 */
export const PRESENCE_TTL_MS = 10_000;

export type PresenceEntry = {
	memberId: string;
	activity: "typing" | "working";
	ts: number;
};

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

export const usePresenceStore = create<PresenceStore>((set) => ({
	byWorkspace: {},

	applyPresence: (event) =>
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
		}),
}));

/**
 * Selector-subscribe to a single workspace's live presence. Applies the
 * read-time TTL so an expired entry resolves to `null` without any timer.
 * Returns `null` when absent or expired.
 */
export function usePresenceForWorkspace(
	workspaceId: string,
): { memberId: string; activity: "typing" | "working" } | null {
	const entry = usePresenceStore((state) => state.byWorkspace[workspaceId]);
	if (!entry) return null;
	if (Date.now() - entry.ts > PRESENCE_TTL_MS) return null;
	return { memberId: entry.memberId, activity: entry.activity };
}

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

/** Reset all state. Test-only. */
export function _resetForTesting() {
	usePresenceStore.setState({ byWorkspace: {} });
}
