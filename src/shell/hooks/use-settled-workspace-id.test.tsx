import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDetail } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { useSettledWorkspaceId } from "./use-settled-workspace-id";

// Locks the single-switch-preserving contract of the rapid-switch settle gate:
// warm/null targets resolve in the SAME render (no lag, no extra delay), cold
// targets defer to a trailing window that a held burst keeps resetting.

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

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useSettledWorkspaceId", () => {
	it("returns null instantly (Start surface)", () => {
		const queryClient = new QueryClient();
		const { result } = renderHook(() => useSettledWorkspaceId(null), {
			wrapper: wrapper(queryClient),
		});
		expect(result.current).toBeNull();
	});

	it("snaps to a WARM target in the same render (no debounce)", () => {
		const queryClient = new QueryClient();
		seedDetail(queryClient, "ws-A");
		seedDetail(queryClient, "ws-B");
		const { result, rerender } = renderHook(
			({ id }: { id: string | null }) => useSettledWorkspaceId(id),
			{ wrapper: wrapper(queryClient), initialProps: { id: "ws-A" } },
		);
		expect(result.current).toBe("ws-A");

		// Warm switch: resolves immediately, before any timer could fire.
		rerender({ id: "ws-B" });
		expect(result.current).toBe("ws-B");
	});

	it("defers a COLD target until the trailing window elapses", () => {
		const queryClient = new QueryClient();
		seedDetail(queryClient, "ws-A");
		const { result, rerender } = renderHook(
			({ id }: { id: string | null }) => useSettledWorkspaceId(id),
			{ wrapper: wrapper(queryClient), initialProps: { id: "ws-A" } },
		);
		expect(result.current).toBe("ws-A");

		// Cold switch (ws-COLD has no cached detail): keeps showing the prior id.
		rerender({ id: "ws-COLD" });
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
		const { result, rerender } = renderHook(
			({ id }: { id: string | null }) => useSettledWorkspaceId(id),
			{ wrapper: wrapper(queryClient), initialProps: { id: "ws-A" } },
		);

		// Three cold switches in quick succession, each before the window elapses.
		rerender({ id: "ws-C1" });
		act(() => {
			vi.advanceTimersByTime(COLD_DELAY_MS - 20);
		});
		rerender({ id: "ws-C2" });
		act(() => {
			vi.advanceTimersByTime(COLD_DELAY_MS - 20);
		});
		rerender({ id: "ws-C3" });
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
		const { result, rerender } = renderHook(
			({ id }: { id: string | null }) => useSettledWorkspaceId(id),
			{ wrapper: wrapper(queryClient), initialProps: { id: "ws-A" } },
		);

		rerender({ id: "ws-D" });
		expect(result.current).toBe("ws-A"); // cold, deferred

		// Conversation prefetch populates ws-D's detail before the timer fires; the
		// next render (e.g. displayed* advancing) sees it warm and settles at once.
		seedDetail(queryClient, "ws-D");
		rerender({ id: "ws-D" });
		expect(result.current).toBe("ws-D");
	});
});
