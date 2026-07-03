import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHelmorQueryClient } from "@/lib/query-client";
import { useActiveStreamsReattach } from "./use-active-streams-reattach";

// The reattach effect reads connection state from `@/lib/ipc` (via
// `use-companion-connection-state`). Mock that module so a test can drive the
// state across renders; the real value is fed by the SSE loop, which doesn't run
// under jsdom.
const ipcState = {
	connection: "online" as "online" | "connecting" | "reconnecting",
};

vi.mock("@/lib/ipc", () => ({
	getCompanionConnectionState: () => ipcState.connection,
	// useSyncExternalStore re-reads the snapshot on every render, so a no-op
	// subscribe is enough — we drive transitions via rerender().
	subscribeCompanionConnection: () => () => {},
}));

describe("useActiveStreamsReattach", () => {
	beforeEach(() => {
		ipcState.connection = "online";
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function setup() {
		const queryClient = createHelmorQueryClient();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { rerender } = renderHook(() => useActiveStreamsReattach(), {
			wrapper,
		});
		return { invalidate, rerender };
	}

	it("re-fetches active streams on the reconnecting → online transition", () => {
		ipcState.connection = "reconnecting";
		const { invalidate, rerender } = setup();

		// Recovery: the SSE stream re-opened. The invalidate must fire so
		// `use-watch-session-stream` re-attaches to the R2-restored sandbox DB even
		// if the backend's `ActiveStreamsChanged` re-emit is missed.
		ipcState.connection = "online";
		rerender();

		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["activeStreams"] });
	});

	it("re-fetches active streams on the connecting → online transition (first connect after a switch)", () => {
		ipcState.connection = "connecting";
		const { invalidate, rerender } = setup();

		// First successful connect after switching into team mode must also
		// re-attach active streams (same path as a reconnect).
		ipcState.connection = "online";
		rerender();

		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["activeStreams"] });
	});

	it("does not invalidate while staying online (no spurious re-attach when healthy)", () => {
		ipcState.connection = "online";
		const { invalidate, rerender } = setup();

		rerender();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("re-syncs observed per-workspace queries on reconnect (narrowed predicate sweep, R2-B)", () => {
		ipcState.connection = "reconnecting";
		const { invalidate, rerender } = setup();

		ipcState.connection = "online";
		rerender();

		const predicateCall = invalidate.mock.calls.find(
			([arg]) =>
				typeof (arg as { predicate?: unknown })?.predicate === "function",
		);
		expect(predicateCall).toBeDefined();
		const predicate = (
			predicateCall?.[0] as unknown as {
				predicate: (q: {
					queryKey: unknown[];
					getObserversCount: () => number;
				}) => boolean;
			}
		).predicate;
		const observed = (key: unknown[]) => ({
			queryKey: key,
			getObserversCount: () => 1,
		});
		const unobserved = (key: unknown[]) => ({
			queryKey: key,
			getObserversCount: () => 0,
		});
		// Observed per-workspace state (= what's on screen) is swept…
		expect(predicate(observed(["workspaceDetail", "w1"]))).toBe(true);
		expect(predicate(observed(["sessionMessages", "s1"]))).toBe(true);
		// …an unobserved instance of the same root is NOT (it refetches on next
		// mount via ordinary staleness).
		expect(predicate(unobserved(["workspaceDetail", "w2"]))).toBe(false);
		// The sidebar lists are NOT part of the sweep — they go through the
		// gate-respecting requestSidebarReconcile instead.
		expect(predicate(observed(["workspaceGroups"]))).toBe(false);
		// A non-shared, per-session query must NOT be swept.
		expect(predicate(observed(["sessionContextUsage", "s1"]))).toBe(false);
	});

	it("reconciles the sidebar lists through the mutation gate, not a direct invalidate (R2-B)", async () => {
		const { beginSidebarMutation, endSidebarMutation } = await import(
			"@/lib/sidebar-mutation-gate"
		);
		ipcState.connection = "reconnecting";
		const { invalidate, rerender } = setup();

		// Hold the gate (a delete/archive is mid-flight) — the reconnect sweep
		// must NOT punch through with a workspaceGroups invalidate.
		beginSidebarMutation();
		try {
			ipcState.connection = "online";
			rerender();
			const sidebarInvalidate = invalidate.mock.calls.find(
				([arg]) =>
					JSON.stringify((arg as { queryKey?: unknown })?.queryKey) ===
					JSON.stringify(["workspaceGroups"]),
			);
			expect(sidebarInvalidate).toBeUndefined();
		} finally {
			endSidebarMutation();
		}
	});

	it("repositories stays a global re-sync (teammate repo-add during a drop)", () => {
		ipcState.connection = "reconnecting";
		const { invalidate, rerender } = setup();
		ipcState.connection = "online";
		rerender();
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["repositories"] });
	});
});
