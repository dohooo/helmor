import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceGroup } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { useDockUnreadBadge } from "./use-dock-unread-badge";

// Captured at module scope so each test can reset call history without
// rebuilding the module mock (setup.ts does not stub setBadgeCount).
const setBadgeCount = vi.fn(async () => {});
const setBadgeLabel = vi.fn(async () => {});

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: vi.fn(() => ({
		setBadgeCount,
		setBadgeLabel,
		// Preserve the shape used by other app-wide consumers.
		onCloseRequested: vi.fn(async () => () => {}),
	})),
}));

// `workspaceGroupsQueryOptions` has staleTime: 0, so the query always triggers
// a background refetch on mount. Returning a never-settling promise keeps the
// seeded cache intact so `toHaveBeenLastCalledWith` can assert the steady
// state instead of the value React Query briefly held before the refetch.
vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		loadWorkspaceGroups: vi.fn(() => new Promise<WorkspaceGroup[]>(() => {})),
	};
});

function makeGroups(
	rows: Array<{
		workspaceUnread?: number;
		unreadSessionCount?: number;
	}>,
): WorkspaceGroup[] {
	return [
		{
			id: "progress",
			label: "In progress",
			tone: "progress",
			rows: rows.map((row, i) => ({
				id: `ws-${i}`,
				title: `Workspace ${i}`,
				state: "ready",
				status: "in-progress",
				...row,
			})),
		},
	];
}

function makeClient(groups?: WorkspaceGroup[]): QueryClient {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	if (groups !== undefined) {
		client.setQueryData(helmorQueryKeys.workspaceGroups, groups);
	}
	return client;
}

function wrapperFor(client: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
	};
}

describe("useDockUnreadBadge", () => {
	beforeEach(() => {
		setBadgeCount.mockClear();
		setBadgeLabel.mockClear();
	});

	it("clears the badge (passes undefined) when total is 0", async () => {
		renderHook(() => useDockUnreadBadge(), {
			wrapper: wrapperFor(
				makeClient(
					makeGroups([{ unreadSessionCount: 0 }, { unreadSessionCount: 0 }]),
				),
			),
		});
		await waitFor(() => {
			expect(setBadgeCount).toHaveBeenLastCalledWith(undefined);
		});
	});

	it("writes the summed unreadSessionCount across workspaces", async () => {
		renderHook(() => useDockUnreadBadge(), {
			wrapper: wrapperFor(
				makeClient(
					makeGroups([
						{ unreadSessionCount: 2 },
						{ unreadSessionCount: 3 },
						{ unreadSessionCount: 0 },
					]),
				),
			),
		});
		await waitFor(() => {
			expect(setBadgeCount).toHaveBeenLastCalledWith(5);
		});
	});

	it("ignores workspaceUnread because it is purely derived from sessions", async () => {
		renderHook(() => useDockUnreadBadge(), {
			wrapper: wrapperFor(
				makeClient(
					makeGroups([
						{ workspaceUnread: 1, unreadSessionCount: 0 },
						{ workspaceUnread: 1, unreadSessionCount: 0 },
					]),
				),
			),
		});
		await waitFor(() => {
			expect(setBadgeCount).toHaveBeenLastCalledWith(undefined);
		});
	});

	it("reacts to cache updates — the core reason this hook exists", async () => {
		const client = makeClient(makeGroups([{ unreadSessionCount: 2 }]));
		renderHook(() => useDockUnreadBadge(), { wrapper: wrapperFor(client) });

		// Initial steady state reflects the seeded cache.
		await waitFor(() => {
			expect(setBadgeCount).toHaveBeenLastCalledWith(2);
		});

		// Simulate a later mutation (e.g. user opens a workspace → optimistic
		// reset, or a refetch brings in new unread counts).
		act(() => {
			client.setQueryData(
				helmorQueryKeys.workspaceGroups,
				makeGroups([{ unreadSessionCount: 0 }, { unreadSessionCount: 4 }]),
			);
		});
		await waitFor(() => {
			expect(setBadgeCount).toHaveBeenLastCalledWith(4);
		});

		// Clearing all unread should drop back to the "no badge" sentinel.
		act(() => {
			client.setQueryData(
				helmorQueryKeys.workspaceGroups,
				makeGroups([{ unreadSessionCount: 0 }, { unreadSessionCount: 0 }]),
			);
		});
		await waitFor(() => {
			expect(setBadgeCount).toHaveBeenLastCalledWith(undefined);
		});
	});

	it("does not re-invoke setBadgeCount when the count is unchanged", async () => {
		const client = makeClient(makeGroups([{ unreadSessionCount: 3 }]));
		renderHook(() => useDockUnreadBadge(), { wrapper: wrapperFor(client) });
		await waitFor(() => {
			expect(setBadgeCount).toHaveBeenLastCalledWith(3);
		});
		const callsBefore = setBadgeCount.mock.calls.length;

		// New WorkspaceGroup object with the same total — the hook should not
		// redundantly hit the OS for an identical value.
		act(() => {
			client.setQueryData(
				helmorQueryKeys.workspaceGroups,
				makeGroups([{ unreadSessionCount: 1 }, { unreadSessionCount: 2 }]),
			);
		});
		// Give React Query + effects a chance to settle before asserting.
		await waitFor(() => {
			expect(client.getQueryData(helmorQueryKeys.workspaceGroups)).toEqual(
				makeGroups([{ unreadSessionCount: 1 }, { unreadSessionCount: 2 }]),
			);
		});
		expect(setBadgeCount.mock.calls.length).toBe(callsBefore);
	});

	it("swallows rejections from setBadgeCount so a failed OS call cannot crash the app", async () => {
		setBadgeCount.mockRejectedValueOnce(new Error("unsupported platform"));
		renderHook(() => useDockUnreadBadge(), {
			wrapper: wrapperFor(makeClient(makeGroups([{ unreadSessionCount: 1 }]))),
		});
		// If the rejection were not caught, vitest would flag an unhandled
		// rejection and fail the test run. Reaching the assertion is itself
		// evidence the swallow is in place.
		await waitFor(() => {
			expect(setBadgeCount).toHaveBeenLastCalledWith(1);
		});
		await waitFor(() => {
			expect(setBadgeLabel).toHaveBeenLastCalledWith("1");
		});
	});

	it("falls back to setBadgeLabel when setBadgeCount rejects", async () => {
		setBadgeCount.mockRejectedValueOnce(new Error("count badge unsupported"));
		renderHook(() => useDockUnreadBadge(), {
			wrapper: wrapperFor(makeClient(makeGroups([{ unreadSessionCount: 3 }]))),
		});
		await waitFor(() => {
			expect(setBadgeCount).toHaveBeenLastCalledWith(3);
		});
		await waitFor(() => {
			expect(setBadgeLabel).toHaveBeenLastCalledWith("3");
		});
	});

	it("tolerates a window handle that lacks setBadgeCount entirely — e.g. the E2E stub", async () => {
		// Reproduces the Playwright E2E harness where `@tauri-apps/api/window`
		// is aliased to a stub module that omits `setBadgeCount`. Without
		// defensive guarding, `win.setBadgeCount(...)` throws a synchronous
		// TypeError from inside the effect — React cannot catch that via
		// `.catch()` on the rejected promise chain, so it bubbles to React's
		// uncaught-effect-error reporter and tears down the parent subtree.
		// On CI this surfaced as "Workspace sidebar not found" in Playwright.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		vi.mocked(getCurrentWindow).mockReturnValueOnce({
			onCloseRequested: vi.fn(async () => () => {}),
			// Deliberately no setBadgeCount.
		} as unknown as ReturnType<typeof getCurrentWindow>);

		renderHook(() => useDockUnreadBadge(), {
			wrapper: wrapperFor(makeClient(makeGroups([{ unreadSessionCount: 3 }]))),
		});

		// Let the async effect queue drain so any uncaught error surfaces.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const loggedSetBadgeTypeError = errorSpy.mock.calls.some((call) =>
			call.some((arg) =>
				arg instanceof Error
					? arg.message.includes("setBadgeCount")
					: String(arg ?? "").includes("setBadgeCount"),
			),
		);
		expect(loggedSetBadgeTypeError).toBe(false);
		errorSpy.mockRestore();
	});
});
