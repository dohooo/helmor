import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMutationEvent } from "@/lib/api";
import {
	_resetForTesting,
	isPresenceLive,
	PRESENCE_TTL_MS,
	usePresenceStore,
} from "./presence-store";

type PresenceEvent = Extract<UiMutationEvent, { type: "roomPresenceChanged" }>;

function event(partial: Partial<PresenceEvent>): PresenceEvent {
	return {
		type: "roomPresenceChanged",
		memberId: "1",
		workspaceId: "ws1",
		sessionId: null,
		activity: "typing",
		ts: 1000,
		...partial,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	_resetForTesting();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("presence-store", () => {
	it("upserts a typing entry, then clears it on idle", () => {
		const { applyPresence } = usePresenceStore.getState();
		applyPresence(event({ activity: "typing", ts: 1000 }));
		expect(usePresenceStore.getState().byWorkspace.ws1).toEqual({
			memberId: "1",
			activity: "typing",
			ts: 1000,
		});

		applyPresence(event({ activity: "idle", ts: 2000 }));
		expect(usePresenceStore.getState().byWorkspace.ws1).toBeUndefined();
	});

	it("ignores an out-of-order (older ts) event", () => {
		const { applyPresence } = usePresenceStore.getState();
		applyPresence(event({ activity: "typing", ts: 5000 }));
		// Stale event from a different member at an earlier ts must not clobber.
		applyPresence(event({ memberId: "2", activity: "typing", ts: 4000 }));
		expect(usePresenceStore.getState().byWorkspace.ws1).toEqual({
			memberId: "1",
			activity: "typing",
			ts: 5000,
		});
	});

	it("isPresenceLive is live within the TTL and stale at the boundary", () => {
		const entry = { memberId: "1", activity: "typing", ts: 1000 } as const;
		expect(isPresenceLive(entry, 1000 + PRESENCE_TTL_MS - 1)).toBe(true);
		expect(isPresenceLive(entry, 1000 + PRESENCE_TTL_MS)).toBe(false);
	});

	it("prunes an aged-out entry on its own timer, with no other re-render", () => {
		const { applyPresence } = usePresenceStore.getState();
		applyPresence(event({ activity: "typing", ts: 1000 }));
		expect(usePresenceStore.getState().byWorkspace.ws1).toBeDefined();

		// Nothing else touches the store; the entry must disappear on its own once
		// it ages past the TTL (the fix for a stuck indicator in a quiet sidebar).
		vi.advanceTimersByTime(PRESENCE_TTL_MS);
		expect(usePresenceStore.getState().byWorkspace.ws1).toBeUndefined();
	});

	it("keeps a still-live entry while pruning an expired one", () => {
		const { applyPresence } = usePresenceStore.getState();
		applyPresence(event({ workspaceId: "ws1", ts: 1000 }));
		// A second workspace's typer refreshes 4s later.
		vi.advanceTimersByTime(4000);
		applyPresence(event({ workspaceId: "ws2", memberId: "2", ts: 5000 }));

		// At t=10000 ws1 has aged out (>= TTL) but ws2 (ts 5000) is still live.
		vi.advanceTimersByTime(PRESENCE_TTL_MS - 4000);
		expect(usePresenceStore.getState().byWorkspace.ws1).toBeUndefined();
		expect(usePresenceStore.getState().byWorkspace.ws2).toBeDefined();
	});
});
