import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDetail } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { useSettledWorkspaceId } from "./use-settled-workspace-id";

// Locks the single-switch-preserving contract of the rapid-switch settle gate:
// warm/null targets resolve in the SAME render (no lag, no extra delay), cold
// targets defer to a trailing window that a held burst keeps resetting. While
// the displayed paint track diverges from the router selection (a deferred or
// held workspace flip in flight) the gate holds the previous settled id so the
// inspector swaps in the same commit as the held content.

const COLD_DELAY_MS = 140;

function seedDetail(queryClient: QueryClient, workspaceId: string) {
	queryClient.setQueryData(helmorQueryKeys.workspaceDetail(workspaceId), {
		id: workspaceId,
	} as unknown as WorkspaceDetail);
}

function wrapper(queryClient: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

type HookProps = {
	id: string | null;
	displayedId: string | null;
};

function renderSettledHook(queryClient: QueryClient, initial: HookProps) {
	return renderHook(
		({ id, displayedId }: HookProps) => useSettledWorkspaceId(id, displayedId),
		{ wrapper: wrapper(queryClient), initialProps: initial },
	);
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useSettledWorkspaceId", () => {
	it("returns null instantly (Start surface)", () => {
		const queryClient = new QueryClient();
		const { result } = renderSettledHook(queryClient, {
			id: null,
			displayedId: null,
		});
		expect(result.current).toBeNull();
	});

	it("snaps to a WARM target in the same render (no debounce)", () => {
		const queryClient = new QueryClient();
		seedDetail(queryClient, "ws-A");
		seedDetail(queryClient, "ws-B");
		const { result, rerender } = renderSettledHook(queryClient, {
			id: "ws-A",
			displayedId: "ws-A",
		});
		expect(result.current).toBe("ws-A");

		// Warm switch: resolves immediately, before any timer could fire.
		rerender({ id: "ws-B", displayedId: "ws-B" });
		expect(result.current).toBe("ws-B");
	});

	it("defers a COLD target until the trailing window elapses", () => {
		const queryClient = new QueryClient();
		seedDetail(queryClient, "ws-A");
		const { result, rerender } = renderSettledHook(queryClient, {
			id: "ws-A",
			displayedId: "ws-A",
		});
		expect(result.current).toBe("ws-A");

		// Cold switch (ws-COLD has no cached detail): keeps showing the prior id.
		rerender({ id: "ws-COLD", displayedId: "ws-COLD" });
		expect(result.current).toBe("ws-A");

		// After the window, it settles on the cold id.
		act(() => {
			vi.advanceTimersByTime(COLD_DELAY_MS);
		});
		expect(result.current).toBe("ws-COLD");
	});

	it("a held burst only settles on the LAST workspace (timer resets)", () => {
		const queryClient = new QueryClient();
		seedDetail(queryClient, "ws-A");
		const { result, rerender } = renderSettledHook(queryClient, {
			id: "ws-A",
			displayedId: "ws-A",
		});

		// Three cold switches in quick succession, each before the window elapses.
		rerender({ id: "ws-C1", displayedId: "ws-C1" });
		act(() => {
			vi.advanceTimersByTime(COLD_DELAY_MS - 20);
		});
		rerender({ id: "ws-C2", displayedId: "ws-C2" });
		act(() => {
			vi.advanceTimersByTime(COLD_DELAY_MS - 20);
		});
		rerender({ id: "ws-C3", displayedId: "ws-C3" });
		// Still showing the original — no intermediate ever settled.
		expect(result.current).toBe("ws-A");

		// Once the burst stops, only the final cold id settles.
		act(() => {
			vi.advanceTimersByTime(COLD_DELAY_MS);
		});
		expect(result.current).toBe("ws-C3");
	});

	it("a cold target that warms mid-window resolves on the next render without waiting", () => {
		const queryClient = new QueryClient();
		seedDetail(queryClient, "ws-A");
		const { result, rerender } = renderSettledHook(queryClient, {
			id: "ws-A",
			displayedId: "ws-A",
		});

		rerender({ id: "ws-D", displayedId: "ws-D" });
		expect(result.current).toBe("ws-A"); // cold, deferred

		// Conversation prefetch populates ws-D's detail before the timer fires; the
		// next render (e.g. displayed* advancing) sees it warm and settles at once.
		seedDetail(queryClient, "ws-D");
		rerender({ id: "ws-D", displayedId: "ws-D" });
		expect(result.current).toBe("ws-D");
	});

	it("holds the previous settled id while selected/displayed diverge, even past the cold window", () => {
		const queryClient = new QueryClient();
		seedDetail(queryClient, "ws-A");
		const { result, rerender } = renderSettledHook(queryClient, {
			id: "ws-A",
			displayedId: "ws-A",
		});
		expect(result.current).toBe("ws-A");

		// Held cold flip: router points at ws-B, paint track still ws-A.
		rerender({ id: "ws-B", displayedId: "ws-A" });
		expect(result.current).toBe("ws-A");

		// The cold 140ms timer must not advance the settled id mid-hold.
		act(() => {
			vi.advanceTimersByTime(COLD_DELAY_MS * 2);
		});
		expect(result.current).toBe("ws-A");
	});

	it("holds during divergence even when the target is already warm (deferred warm flip)", () => {
		const queryClient = new QueryClient();
		seedDetail(queryClient, "ws-A");
		seedDetail(queryClient, "ws-B");
		const { result, rerender } = renderSettledHook(queryClient, {
			id: "ws-A",
			displayedId: "ws-A",
		});

		// One-frame deferred flip window: target warm, paint track still old.
		rerender({ id: "ws-B", displayedId: "ws-A" });
		expect(result.current).toBe("ws-A");

		// Convergence (the flip landed): warm target settles in the SAME render
		// — the inspector swaps in the same commit as the content.
		rerender({ id: "ws-B", displayedId: "ws-B" });
		expect(result.current).toBe("ws-B");
	});

	it("converging on a warm target after a held cold switch settles in the same render", () => {
		const queryClient = new QueryClient();
		seedDetail(queryClient, "ws-A");
		const { result, rerender } = renderSettledHook(queryClient, {
			id: "ws-A",
			displayedId: "ws-A",
		});

		rerender({ id: "ws-B", displayedId: "ws-A" });
		act(() => {
			vi.advanceTimersByTime(COLD_DELAY_MS * 2);
		});
		expect(result.current).toBe("ws-A");

		// The hold's prime resolved: detail is cached and the displayed flip
		// lands — settled advances in that same converged render.
		seedDetail(queryClient, "ws-B");
		rerender({ id: "ws-B", displayedId: "ws-B" });
		expect(result.current).toBe("ws-B");
	});

	it("converging while still cold falls back to the trailing window", () => {
		const queryClient = new QueryClient();
		seedDetail(queryClient, "ws-A");
		const { result, rerender } = renderSettledHook(queryClient, {
			id: "ws-A",
			displayedId: "ws-A",
		});

		rerender({ id: "ws-B", displayedId: "ws-A" });
		expect(result.current).toBe("ws-A");

		// Convergence with the detail still missing (the prime rejected and the
		// flip landed its bounded (target, null) fallback): the existing cold
		// trailing window applies from convergence.
		rerender({ id: "ws-B", displayedId: "ws-B" });
		expect(result.current).toBe("ws-A");
		act(() => {
			vi.advanceTimersByTime(COLD_DELAY_MS);
		});
		expect(result.current).toBe("ws-B");
	});
});
