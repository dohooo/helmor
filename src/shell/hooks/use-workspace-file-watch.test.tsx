import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	startWorkspaceWatch: vi.fn(),
	stopWorkspaceWatch: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		startWorkspaceWatch: apiMocks.startWorkspaceWatch,
		stopWorkspaceWatch: apiMocks.stopWorkspaceWatch,
	};
});

import { useWorkspaceFileWatch } from "./use-workspace-file-watch";

describe("useWorkspaceFileWatch", () => {
	beforeEach(() => {
		apiMocks.startWorkspaceWatch.mockReset();
		apiMocks.stopWorkspaceWatch.mockReset();
		apiMocks.startWorkspaceWatch.mockResolvedValue({
			workspaceId: "ws-1",
			kind: "local",
		});
		apiMocks.stopWorkspaceWatch.mockResolvedValue({ stopped: true });
		// Silence the hook's console.warn branches during tests —
		// we assert behaviour, not the log line.
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts a watch on mount with the workspace id + dir + runtime name", async () => {
		renderHook(() =>
			useWorkspaceFileWatch({
				workspaceId: "ws-1",
				workspaceDir: "/repo",
				runtimeName: null,
			}),
		);

		await waitFor(() => {
			expect(apiMocks.startWorkspaceWatch).toHaveBeenCalledWith({
				workspaceId: "ws-1",
				workspaceDir: "/repo",
				runtimeName: null,
			});
		});
	});

	it("forwards remote runtime names verbatim so the wire path picks them up", async () => {
		renderHook(() =>
			useWorkspaceFileWatch({
				workspaceId: "ws-2",
				workspaceDir: "/srv/repo",
				runtimeName: "dev.box",
			}),
		);

		await waitFor(() => {
			expect(apiMocks.startWorkspaceWatch).toHaveBeenCalledWith({
				workspaceId: "ws-2",
				workspaceDir: "/srv/repo",
				runtimeName: "dev.box",
			});
		});
	});

	it("skips the start call when workspaceId is missing", () => {
		renderHook(() =>
			useWorkspaceFileWatch({
				workspaceId: null,
				workspaceDir: "/repo",
				runtimeName: null,
			}),
		);
		expect(apiMocks.startWorkspaceWatch).not.toHaveBeenCalled();
	});

	it("skips the start call when workspaceDir is missing", () => {
		renderHook(() =>
			useWorkspaceFileWatch({
				workspaceId: "ws-1",
				workspaceDir: null,
				runtimeName: null,
			}),
		);
		expect(apiMocks.startWorkspaceWatch).not.toHaveBeenCalled();
	});

	it("stops the watch on unmount", async () => {
		const { unmount } = renderHook(() =>
			useWorkspaceFileWatch({
				workspaceId: "ws-1",
				workspaceDir: "/repo",
				runtimeName: null,
			}),
		);

		// Let the start resolve before unmount so `didStart` flips
		// to true and the cleanup path fires the stop call.
		await waitFor(() =>
			expect(apiMocks.startWorkspaceWatch).toHaveBeenCalledTimes(1),
		);
		unmount();

		await waitFor(() => {
			expect(apiMocks.stopWorkspaceWatch).toHaveBeenCalledWith("ws-1");
		});
	});

	it("does not call stop when start failed (no watcher to tear down)", async () => {
		apiMocks.startWorkspaceWatch.mockRejectedValueOnce(
			new Error("registry: runtime not found"),
		);
		const { unmount } = renderHook(() =>
			useWorkspaceFileWatch({
				workspaceId: "ws-broken",
				workspaceDir: "/repo",
				runtimeName: "ghost.box",
			}),
		);
		await waitFor(() =>
			expect(apiMocks.startWorkspaceWatch).toHaveBeenCalledTimes(1),
		);
		unmount();
		// Stop must not fire — we never had a live watcher and
		// calling stop with no registered watcher would just emit
		// stopped=false anyway.
		expect(apiMocks.stopWorkspaceWatch).not.toHaveBeenCalled();
	});

	it("re-watches when the workspace id changes", async () => {
		const { rerender } = renderHook(
			(args: {
				workspaceId: string;
				workspaceDir: string;
				runtimeName: string | null;
			}) => useWorkspaceFileWatch(args),
			{
				initialProps: {
					workspaceId: "ws-1",
					workspaceDir: "/r1",
					runtimeName: null,
				},
			},
		);
		await waitFor(() =>
			expect(apiMocks.startWorkspaceWatch).toHaveBeenCalledTimes(1),
		);

		rerender({ workspaceId: "ws-2", workspaceDir: "/r2", runtimeName: null });

		// Cleanup of the first watch fires → stop("ws-1"); start
		// fires again for the new id.
		await waitFor(() =>
			expect(apiMocks.stopWorkspaceWatch).toHaveBeenCalledWith("ws-1"),
		);
		await waitFor(() => {
			const calls = apiMocks.startWorkspaceWatch.mock.calls;
			expect(calls.at(-1)?.[0].workspaceId).toBe("ws-2");
		});
	});
});
