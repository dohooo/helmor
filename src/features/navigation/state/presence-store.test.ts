import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMutationEvent } from "@/lib/api";
import {
	_resetForTesting,
	PRESENCE_TTL_MS,
	usePresenceForWorkspace,
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
	_resetForTesting();
});

afterEach(() => {
	vi.restoreAllMocks();
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

	it("treats an entry past PRESENCE_TTL_MS as absent (read-time TTL)", () => {
		vi.spyOn(Date, "now").mockReturnValue(10_000);
		usePresenceStore
			.getState()
			.applyPresence(event({ activity: "typing", ts: 10_000 }));

		const { result, rerender } = renderHook(() =>
			usePresenceForWorkspace("ws1"),
		);
		expect(result.current).toEqual({ memberId: "1", activity: "typing" });

		// Advance the clock past the TTL — the same entry now reads as expired.
		vi.spyOn(Date, "now").mockReturnValue(10_000 + PRESENCE_TTL_MS + 1);
		rerender();
		expect(result.current).toBeNull();
	});
});
