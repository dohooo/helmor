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

	it("re-syncs shared team-state queries on reconnect (predicate sweep)", () => {
		ipcState.connection = "reconnecting";
		const { invalidate, rerender } = setup();

		ipcState.connection = "online";
		rerender();

		// The remote /v1/stream replays nothing on reconnect, so we conservatively
		// invalidate shared-state roots a teammate could have mutated mid-drop.
		const predicateCall = invalidate.mock.calls.find(
			([arg]) =>
				typeof (arg as { predicate?: unknown })?.predicate === "function",
		);
		expect(predicateCall).toBeDefined();
		const predicate = (
			predicateCall?.[0] as unknown as {
				predicate: (q: { queryKey: unknown[] }) => boolean;
			}
		).predicate;
		expect(predicate({ queryKey: ["workspaceGroups"] })).toBe(true);
		expect(predicate({ queryKey: ["workspaceDetail", "w1"] })).toBe(true);
		// A non-shared, per-session query must NOT be swept.
		expect(predicate({ queryKey: ["sessionContextUsage", "s1"] })).toBe(false);
	});
});
