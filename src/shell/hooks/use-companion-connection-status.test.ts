import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionConnectionState } from "@/lib/ipc";
import { useCompanionConnectionStatus } from "./use-companion-connection-status";

// Drive the underlying transport store directly: a tiny in-memory external store
// that `useSyncExternalStore` can subscribe to, so flipping `state` re-renders
// the hook the same way the real `ipc.ts` store would.
const store = {
	state: "online" as CompanionConnectionState,
	listeners: new Set<() => void>(),
};

function setState(next: CompanionConnectionState) {
	store.state = next;
	for (const l of store.listeners) l();
}

vi.mock("@/lib/ipc", () => ({
	getCompanionConnectionState: () => store.state,
	subscribeCompanionConnection: (listener: () => void) => {
		store.listeners.add(listener);
		return () => store.listeners.delete(listener);
	},
}));

describe("useCompanionConnectionStatus", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		store.state = "online";
		store.listeners.clear();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("reports online/ok while connected and never escalates", () => {
		const { result } = renderHook(() => useCompanionConnectionStatus());
		expect(result.current).toEqual({ phase: "online" });

		// Time passing while healthy must never flip to disconnected.
		act(() => {
			vi.advanceTimersByTime(10 * 60_000);
		});
		expect(result.current).toEqual({ phase: "online" });
	});

	it("escalates non-online → disconnected past the cold-start ceiling, then online resets", () => {
		const { result } = renderHook(() => useCompanionConnectionStatus());

		act(() => setState("connecting"));
		expect(result.current).toEqual({ phase: "connecting" });

		// Just before the ceiling: still pending, not yet red.
		act(() => {
			vi.advanceTimersByTime(164_000);
		});
		expect(result.current).toEqual({ phase: "connecting" });

		// Cross the 165s ceiling: escalate to red.
		act(() => {
			vi.advanceTimersByTime(2_000);
		});
		expect(result.current).toEqual({ phase: "disconnected" });

		// Recovery clears the escalation immediately.
		act(() => setState("online"));
		expect(result.current).toEqual({ phase: "online" });
	});

	it("keeps the timer running across connecting → reconnecting (no reset)", () => {
		const { result } = renderHook(() => useCompanionConnectionStatus());

		act(() => setState("connecting"));
		act(() => {
			vi.advanceTimersByTime(160_000);
		});
		// Swap to reconnecting partway through — must NOT restart the countdown.
		act(() => setState("reconnecting"));
		expect(result.current).toEqual({ phase: "reconnecting" });

		// Only 5s more (165s total since first leaving online) → escalates. If the
		// timer had reset on the swap, this would still read pending.
		act(() => {
			vi.advanceTimersByTime(5_000);
		});
		expect(result.current).toEqual({ phase: "disconnected" });
	});

	it("returning online before the ceiling cancels the escalation", () => {
		const { result } = renderHook(() => useCompanionConnectionStatus());

		act(() => setState("reconnecting"));
		act(() => {
			vi.advanceTimersByTime(100_000);
		});
		act(() => setState("online"));
		expect(result.current).toEqual({ phase: "online" });

		// The previously-armed timer must be dead — advancing past the old deadline
		// must not retroactively flip to disconnected.
		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(result.current).toEqual({ phase: "online" });
	});
});
