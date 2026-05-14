import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeActionStatus } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { renderWithProviders } from "@/test/render-with-providers";
import { useRefreshForgeOnWorkspaceSwitch } from "./use-refresh-forge-on-switch";

function Harness({ workspaceId }: { workspaceId: string | null }) {
	useRefreshForgeOnWorkspaceSwitch(workspaceId);
	return null;
}

function makeStatus(
	overrides: Partial<ForgeActionStatus> = {},
): ForgeActionStatus {
	return {
		changeRequest: {
			url: "https://example.com/pr/1",
			number: 1,
			state: "OPEN",
			title: "PR",
			isMerged: false,
		},
		reviewDecision: null,
		mergeable: "MERGEABLE",
		deployments: [],
		checks: [],
		remoteState: "ok",
		message: null,
		...overrides,
	};
}

describe("useRefreshForgeOnWorkspaceSwitch", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		cleanup();
	});

	it("invalidates when cached checks are still running", () => {
		const { queryClient } = renderWithProviders(<Harness workspaceId={null} />);
		const key = helmorQueryKeys.workspaceForgeActionStatus("ws-1");
		queryClient.setQueryData<ForgeActionStatus>(
			key,
			makeStatus({
				checks: [
					{
						id: "c",
						name: "build",
						provider: "github",
						status: "running",
					},
				],
			}),
		);
		const spy = vi.spyOn(queryClient, "invalidateQueries");

		renderWithProviders(<Harness workspaceId="ws-1" />, { queryClient });
		// Switch into ws-1 → debounce timer scheduled.
		expect(spy).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(150);
		});
		expect(spy).toHaveBeenCalledWith({ queryKey: key });
	});

	it("does NOT invalidate when there is no cached status", () => {
		const { queryClient } = renderWithProviders(<Harness workspaceId={null} />);
		const spy = vi.spyOn(queryClient, "invalidateQueries");

		renderWithProviders(<Harness workspaceId="ws-1" />, { queryClient });
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(spy).not.toHaveBeenCalled();
	});

	it("does NOT invalidate when PR is merged", () => {
		const { queryClient } = renderWithProviders(<Harness workspaceId={null} />);
		queryClient.setQueryData<ForgeActionStatus>(
			helmorQueryKeys.workspaceForgeActionStatus("ws-1"),
			makeStatus({
				changeRequest: {
					url: "https://example.com/pr/1",
					number: 1,
					state: "MERGED",
					title: "PR",
					isMerged: true,
				},
			}),
		);
		const spy = vi.spyOn(queryClient, "invalidateQueries");

		renderWithProviders(<Harness workspaceId="ws-1" />, { queryClient });
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(spy).not.toHaveBeenCalled();
	});

	it("does NOT invalidate when all checks have succeeded", () => {
		const { queryClient } = renderWithProviders(<Harness workspaceId={null} />);
		queryClient.setQueryData<ForgeActionStatus>(
			helmorQueryKeys.workspaceForgeActionStatus("ws-1"),
			makeStatus({
				checks: [
					{
						id: "c",
						name: "build",
						provider: "github",
						status: "success",
					},
				],
			}),
		);
		const spy = vi.spyOn(queryClient, "invalidateQueries");

		renderWithProviders(<Harness workspaceId="ws-1" />, { queryClient });
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(spy).not.toHaveBeenCalled();
	});

	it("debounces rapid workspace switches", () => {
		const { queryClient } = renderWithProviders(<Harness workspaceId={null} />);
		queryClient.setQueryData<ForgeActionStatus>(
			helmorQueryKeys.workspaceForgeActionStatus("ws-1"),
			makeStatus({
				checks: [
					{ id: "c1", name: "a", provider: "github", status: "running" },
				],
			}),
		);
		queryClient.setQueryData<ForgeActionStatus>(
			helmorQueryKeys.workspaceForgeActionStatus("ws-2"),
			makeStatus({
				checks: [
					{ id: "c2", name: "a", provider: "github", status: "running" },
				],
			}),
		);
		const spy = vi.spyOn(queryClient, "invalidateQueries");

		const { rerender } = renderWithProviders(<Harness workspaceId="ws-1" />, {
			queryClient,
		});
		// Switch immediately to ws-2 before the 150ms debounce elapses.
		act(() => {
			vi.advanceTimersByTime(50);
		});
		rerender(<Harness workspaceId="ws-2" />);
		act(() => {
			vi.advanceTimersByTime(150);
		});
		// ws-1's invalidate should have been cancelled by the cleanup.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.workspaceForgeActionStatus("ws-2"),
		});
	});
});
