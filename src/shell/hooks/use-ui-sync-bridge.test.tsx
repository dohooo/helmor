import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMutationEvent } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { useUiSyncBridge } from "./use-ui-sync-bridge";

const apiMocks = vi.hoisted(() => ({
	subscribeUiMutations: vi.fn(),
}));

let capturedSubscription: ((event: UiMutationEvent) => void) | null = null;

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		subscribeUiMutations: apiMocks.subscribeUiMutations.mockImplementation(
			async (callback: (event: UiMutationEvent) => void) => {
				capturedSubscription = callback;
			},
		),
	};
});

function makeClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
}

describe("useUiSyncBridge", () => {
	beforeEach(() => {
		capturedSubscription = null;
		apiMocks.subscribeUiMutations.mockClear();
	});

	it("invalidates the expected query families for workspace git state changes", async () => {
		const queryClient = makeClient();
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

		renderHook(() =>
			useUiSyncBridge({
				queryClient,
				processPendingCliSends: vi.fn(),
				reloadSettings: vi.fn(),
			}),
		);

		expect(apiMocks.subscribeUiMutations).toHaveBeenCalledOnce();
		expect(capturedSubscription).not.toBeNull();

		act(() => {
			capturedSubscription?.({
				type: "workspaceGitStateChanged",
				workspaceId: "workspace-1",
			});
		});

		await waitFor(() => {
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceDetail("workspace-1"),
			});
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceGitActionStatus("workspace-1"),
			});
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceForgeActionStatus("workspace-1"),
			});
			expect(invalidateQueries).toHaveBeenCalledWith({
				predicate: expect.any(Function),
			});
		});
	});

	it("replays pending CLI sends immediately instead of waiting for focus", async () => {
		const queryClient = makeClient();
		const processPendingCliSends = vi.fn();

		renderHook(() =>
			useUiSyncBridge({
				queryClient,
				processPendingCliSends,
				reloadSettings: vi.fn(),
			}),
		);

		act(() => {
			capturedSubscription?.({
				type: "pendingCliSendQueued",
				workspaceId: "workspace-1",
				sessionId: "session-1",
				prompt: "hello",
				modelId: "gpt-5.4",
				permissionMode: "default",
			});
		});

		await waitFor(() => {
			expect(processPendingCliSends).toHaveBeenCalledOnce();
		});
	});

	it("invalidates forge detection when forge state changes", async () => {
		const queryClient = makeClient();
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

		renderHook(() =>
			useUiSyncBridge({
				queryClient,
				processPendingCliSends: vi.fn(),
				reloadSettings: vi.fn(),
			}),
		);

		act(() => {
			capturedSubscription?.({
				type: "workspaceForgeChanged",
				workspaceId: "workspace-1",
			});
		});

		await waitFor(() => {
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceForge("workspace-1"),
			});
		});
		// Settings → Account renders the per-account roster from this
		// cache; the bridge fans the same backend signal out so a fresh
		// auth flip detected elsewhere shows up there too.
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.forgeAccountsAll,
		});
	});

	it("invalidates baseline + rich on contextUsageChanged", async () => {
		const queryClient = makeClient();
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

		renderHook(() =>
			useUiSyncBridge({
				queryClient,
				processPendingCliSends: vi.fn(),
				reloadSettings: vi.fn(),
			}),
		);

		act(() => {
			capturedSubscription?.({
				type: "contextUsageChanged",
				sessionId: "session-7",
			});
		});

		await waitFor(() => {
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.sessionContextUsage("session-7"),
			});
		});
		// And a predicate-based invalidate for rich entries scoped to
		// this session (any providerSessionId / model).
		expect(invalidateQueries).toHaveBeenCalledWith(
			expect.objectContaining({ predicate: expect.any(Function) }),
		);
		expect(invalidateQueries).toHaveBeenCalledTimes(2);
	});

	it("reloads settings and refreshes auto-close queries on settings changes", async () => {
		const queryClient = makeClient();
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
		const reloadSettings = vi.fn();

		renderHook(() =>
			useUiSyncBridge({
				queryClient,
				processPendingCliSends: vi.fn(),
				reloadSettings,
			}),
		);

		act(() => {
			capturedSubscription?.({
				type: "settingsChanged",
				key: "auto_close_action_kinds",
			});
		});

		await waitFor(() => {
			expect(reloadSettings).not.toHaveBeenCalled();
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.autoCloseActionKinds,
			});
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.autoCloseOptInAsked,
			});
		});

		act(() => {
			capturedSubscription?.({
				type: "settingsChanged",
				key: "app.default_model_id",
			});
		});

		await waitFor(() => {
			expect(reloadSettings).toHaveBeenCalledOnce();
		});
	});
});
