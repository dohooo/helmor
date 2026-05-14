import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMutationEvent } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	holdSidebarMutation,
	resetSidebarMutationGate,
} from "@/lib/sidebar-mutation-gate";
import { useUiSyncBridge } from "./use-ui-sync-bridge";

const apiMocks = vi.hoisted(() => ({
	subscribeUiMutations: vi.fn(),
	unlistenUiMutations: vi.fn(),
}));

let capturedSubscription: ((event: UiMutationEvent) => void) | null = null;

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		subscribeUiMutations: apiMocks.subscribeUiMutations.mockImplementation(
			async (callback: (event: UiMutationEvent) => void) => {
				capturedSubscription = callback;
				return apiMocks.unlistenUiMutations;
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
		apiMocks.unlistenUiMutations.mockClear();
		resetSidebarMutationGate();
	});

	afterEach(() => {
		resetSidebarMutationGate();
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

	describe("sidebar-list invalidate is gated", () => {
		// These tests pin down the cross-component contract that wired up
		// the unarchive-flicker bug: every backend event that fans out to
		// `workspaceGroups` / `archivedWorkspaces` MUST go through the
		// gate, so a mid-flight optimistic mutation isn't clobbered by a
		// concurrent server-event refetch. The implementation does this
		// via `requestSidebarReconcile`; these tests catch any future
		// regression that smuggles a direct `invalidateQueries` past it.
		function fireAndAssertSidebarGated(
			event: UiMutationEvent,
			invalidateSpy: ReturnType<typeof vi.spyOn>,
		) {
			act(() => {
				capturedSubscription?.(event);
			});
			const sidebarKeys = [
				helmorQueryKeys.workspaceGroups,
				helmorQueryKeys.archivedWorkspaces,
			];
			for (const call of invalidateSpy.mock.calls) {
				const arg = call[0] as { queryKey?: unknown } | undefined;
				if (!arg || !("queryKey" in arg)) continue;
				const key = arg.queryKey;
				for (const sidebarKey of sidebarKeys) {
					expect(
						JSON.stringify(key),
						`event ${event.type} invalidated ${JSON.stringify(key)} while gate held`,
					).not.toBe(JSON.stringify(sidebarKey));
				}
			}
		}

		it("workspaceListChanged skips sidebar invalidate while gate is held", async () => {
			const queryClient = makeClient();
			const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

			renderHook(() =>
				useUiSyncBridge({
					queryClient,
					processPendingCliSends: vi.fn(),
					reloadSettings: vi.fn(),
				}),
			);

			holdSidebarMutation(queryClient);
			fireAndAssertSidebarGated(
				{ type: "workspaceListChanged" },
				invalidateQueries,
			);
		});

		it("workspaceChanged skips sidebar invalidate while gate is held", () => {
			const queryClient = makeClient();
			const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

			renderHook(() =>
				useUiSyncBridge({
					queryClient,
					processPendingCliSends: vi.fn(),
					reloadSettings: vi.fn(),
				}),
			);

			holdSidebarMutation(queryClient);
			fireAndAssertSidebarGated(
				{ type: "workspaceChanged", workspaceId: "workspace-1" },
				invalidateQueries,
			);
		});

		it("sessionListChanged skips sidebar invalidate while gate is held", () => {
			const queryClient = makeClient();
			const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

			renderHook(() =>
				useUiSyncBridge({
					queryClient,
					processPendingCliSends: vi.fn(),
					reloadSettings: vi.fn(),
				}),
			);

			holdSidebarMutation(queryClient);
			fireAndAssertSidebarGated(
				{ type: "sessionListChanged", workspaceId: "workspace-1" },
				invalidateQueries,
			);
		});

		it("workspaceGitStateChanged skips sidebar invalidate while gate is held (the unarchive-flicker case)", () => {
			const queryClient = makeClient();
			const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

			renderHook(() =>
				useUiSyncBridge({
					queryClient,
					processPendingCliSends: vi.fn(),
					reloadSettings: vi.fn(),
				}),
			);

			holdSidebarMutation(queryClient);
			fireAndAssertSidebarGated(
				{ type: "workspaceGitStateChanged", workspaceId: "workspace-1" },
				invalidateQueries,
			);
		});

		it("workspaceChangeRequestChanged skips sidebar invalidate while gate is held", () => {
			const queryClient = makeClient();
			const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

			renderHook(() =>
				useUiSyncBridge({
					queryClient,
					processPendingCliSends: vi.fn(),
					reloadSettings: vi.fn(),
				}),
			);

			holdSidebarMutation(queryClient);
			fireAndAssertSidebarGated(
				{ type: "workspaceChangeRequestChanged", workspaceId: "workspace-1" },
				invalidateQueries,
			);
		});

		it("repositoryChanged skips sidebar invalidate while gate is held", () => {
			const queryClient = makeClient();
			const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

			renderHook(() =>
				useUiSyncBridge({
					queryClient,
					processPendingCliSends: vi.fn(),
					reloadSettings: vi.fn(),
				}),
			);

			holdSidebarMutation(queryClient);
			fireAndAssertSidebarGated(
				{ type: "repositoryChanged", repoId: "repo-1" },
				invalidateQueries,
			);
		});

		it("non-sidebar invalidates still fire while gate is held (e.g. workspaceDetail)", () => {
			// Sanity check: gating sidebar lists must NOT silence the
			// rest of the bridge. workspaceDetail / repoScripts etc.
			// still need to react to backend changes during a mutation.
			const queryClient = makeClient();
			const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

			renderHook(() =>
				useUiSyncBridge({
					queryClient,
					processPendingCliSends: vi.fn(),
					reloadSettings: vi.fn(),
				}),
			);

			holdSidebarMutation(queryClient);
			act(() => {
				capturedSubscription?.({
					type: "workspaceGitStateChanged",
					workspaceId: "workspace-1",
				});
			});
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceDetail("workspace-1"),
			});
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceGitActionStatus("workspace-1"),
			});
		});

		it("releasing the gate lets the next event reconcile sidebar lists", () => {
			const queryClient = makeClient();
			const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

			renderHook(() =>
				useUiSyncBridge({
					queryClient,
					processPendingCliSends: vi.fn(),
					reloadSettings: vi.fn(),
				}),
			);

			const release = holdSidebarMutation(queryClient);
			act(() => {
				capturedSubscription?.({ type: "workspaceListChanged" });
			});
			// During the hold: no sidebar invalidate.
			expect(invalidateQueries).not.toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceGroups,
			});

			release();
			// `release` itself reconciles; that single pair is the
			// post-mutation flush.
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.archivedWorkspaces,
			});

			// And a fresh event after the gate clears flows through.
			invalidateQueries.mockClear();
			act(() => {
				capturedSubscription?.({ type: "workspaceListChanged" });
			});
			expect(invalidateQueries).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
		});
	});

	it("unsubscribes from backend mutations on unmount", async () => {
		const queryClient = makeClient();

		const { unmount } = renderHook(() =>
			useUiSyncBridge({
				queryClient,
				processPendingCliSends: vi.fn(),
				reloadSettings: vi.fn(),
			}),
		);

		await waitFor(() => {
			expect(apiMocks.subscribeUiMutations).toHaveBeenCalledOnce();
		});

		unmount();

		expect(apiMocks.unlistenUiMutations).toHaveBeenCalledOnce();
	});
});
