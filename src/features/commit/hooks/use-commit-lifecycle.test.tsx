import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ChangeRequestInfo,
	ForgeActionStatus,
	WorkspaceDetail,
	WorkspaceGitActionStatus,
	WorkspaceGroup,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { useWorkspaceCommitLifecycle } from "./use-commit-lifecycle";

const apiMocks = vi.hoisted(() => ({
	closeWorkspaceChangeRequest: vi.fn(),
	createSession: vi.fn(),
	hideSession: vi.fn(),
	loadRepoPreferences: vi.fn(),
	loadAutoCloseActionKinds: vi.fn(),
	refreshWorkspaceChangeRequest: vi.fn(),
	mergeWorkspaceChangeRequest: vi.fn(),
	pushWorkspaceToRemote: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		closeWorkspaceChangeRequest: apiMocks.closeWorkspaceChangeRequest,
		createSession: apiMocks.createSession,
		hideSession: apiMocks.hideSession,
		loadRepoPreferences: apiMocks.loadRepoPreferences,
		loadAutoCloseActionKinds: apiMocks.loadAutoCloseActionKinds,
		refreshWorkspaceChangeRequest: apiMocks.refreshWorkspaceChangeRequest,
		mergeWorkspaceChangeRequest: apiMocks.mergeWorkspaceChangeRequest,
		pushWorkspaceToRemote: apiMocks.pushWorkspaceToRemote,
	};
});

const EMPTY_GIT_ACTION_STATUS: WorkspaceGitActionStatus = {
	uncommittedCount: 0,
	conflictCount: 0,
	syncTargetBranch: "main",
	syncStatus: "upToDate",
	behindTargetCount: 0,
	remoteTrackingRef: null,
	aheadOfRemoteCount: 0,
	aheadOfTargetCount: 0,
	pushStatus: "unknown",
};

const EMPTY_FORGE_ACTION_STATUS: ForgeActionStatus = {
	changeRequest: null,
	reviewDecision: null,
	mergeable: null,
	deployments: [],
	checks: [],
	remoteState: "unavailable",
	message: null,
};

function createWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
	};
}

describe("useWorkspaceCommitLifecycle", () => {
	beforeEach(() => {
		apiMocks.closeWorkspaceChangeRequest.mockReset();
		apiMocks.createSession.mockReset();
		apiMocks.hideSession.mockReset();
		apiMocks.loadRepoPreferences.mockReset();
		apiMocks.loadAutoCloseActionKinds.mockReset();
		apiMocks.refreshWorkspaceChangeRequest.mockReset();
		apiMocks.mergeWorkspaceChangeRequest.mockReset();
		apiMocks.pushWorkspaceToRemote.mockReset();

		apiMocks.createSession.mockResolvedValue({ sessionId: "session-action" });
		apiMocks.loadRepoPreferences.mockResolvedValue({});
		apiMocks.loadAutoCloseActionKinds.mockResolvedValue(["create-pr"]);
		apiMocks.refreshWorkspaceChangeRequest.mockResolvedValue({
			number: 53,
			title: "Fix overflow",
			url: "https://github.com/example/repo/pull/53",
			state: "OPEN",
			isMerged: false,
		} satisfies ChangeRequestInfo);
		apiMocks.pushWorkspaceToRemote.mockResolvedValue({
			targetRef: "origin/feature/test",
			headCommit: "abc123",
		});
		apiMocks.hideSession.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("verifies and auto-closes an action session once it has completed", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
				},
			},
		});
		const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");
		queryClient.setQueryData<WorkspaceDetail | null>(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			{
				id: "workspace-1",
				activeSessionId: "session-after-close",
				status: "in-progress",
			} as unknown as WorkspaceDetail,
		);
		// Seed the sidebar so we can assert the optimistic move to "review".
		queryClient.setQueryData<WorkspaceGroup[]>(
			helmorQueryKeys.workspaceGroups,
			[
				{
					id: "progress",
					label: "In progress",
					tone: "progress",
					rows: [
						{
							id: "workspace-1",
							title: "Workspace 1",
							status: "in-progress",
							createdAt: "2024-04-01T00:00:00Z",
						},
					],
				},
				{
					id: "review",
					label: "In review",
					tone: "review",
					rows: [],
				},
			] as WorkspaceGroup[],
		);

		const selectedWorkspaceIdRef = { current: "workspace-1" };
		const onSelectSession = vi.fn();

		const { result, rerender } = renderHook(
			({
				completedSessionIds,
				interactionRequiredSessionIds,
				sendingSessionIds,
			}: {
				completedSessionIds: Set<string>;
				interactionRequiredSessionIds: Set<string>;
				sendingSessionIds: Set<string>;
			}) =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: "workspace-1",
					selectedWorkspaceIdRef,
					selectedRepoId: "repo-1",
					selectedWorkspaceTargetBranch: "main",
					changeRequest: null,
					forgeActionStatus: EMPTY_FORGE_ACTION_STATUS,
					workspaceGitActionStatus: EMPTY_GIT_ACTION_STATUS,
					completedSessionIds,
					interactionRequiredSessionIds,
					sendingSessionIds,
					onSelectSession,
				}),
			{
				initialProps: {
					completedSessionIds: new Set<string>(),
					interactionRequiredSessionIds: new Set<string>(),
					sendingSessionIds: new Set<string>(),
				},
				wrapper: createWrapper(queryClient),
			},
		);

		await act(async () => {
			await result.current.handleInspectorCommitAction("create-pr");
		});

		expect(apiMocks.createSession).toHaveBeenCalledWith("workspace-1", {
			actionKind: "create-pr",
		});
		expect(result.current.pendingPromptForSession).toMatchObject({
			sessionId: "session-action",
		});
		expect(onSelectSession).toHaveBeenCalledWith("session-action");

		act(() => {
			result.current.handlePendingPromptConsumed();
		});

		rerender({
			completedSessionIds: new Set<string>(),
			interactionRequiredSessionIds: new Set<string>(),
			sendingSessionIds: new Set(["session-action"]),
		});

		rerender({
			completedSessionIds: new Set(["session-action"]),
			interactionRequiredSessionIds: new Set<string>(),
			sendingSessionIds: new Set<string>(),
		});

		await waitFor(() => {
			expect(apiMocks.refreshWorkspaceChangeRequest).toHaveBeenCalledWith(
				"workspace-1",
			);
		});
		await waitFor(() => {
			// `workspaceChangeRequest` should be seeded directly via setQueryData
			// from the awaited refresh result, not invalidated (which would
			// trigger a duplicate `gh pr view`).
			const cached = queryClient.getQueryData<ChangeRequestInfo | null>(
				helmorQueryKeys.workspaceChangeRequest("workspace-1"),
			);
			expect(cached).toMatchObject({ state: "OPEN", number: 53 });
		});
		expect(invalidateQueriesSpy).not.toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.workspaceChangeRequest("workspace-1"),
		});
		await waitFor(() => {
			expect(invalidateQueriesSpy).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceForgeActionStatus("workspace-1"),
			});
		});
		// Optimistic group + detail moves: workspace-1 should now sit in the
		// "review" lane and its detail.status should be "review", before the
		// event-driven invalidation has had a chance to refetch.
		await waitFor(() => {
			const groups = queryClient.getQueryData<WorkspaceGroup[]>(
				helmorQueryKeys.workspaceGroups,
			);
			const reviewIds = groups
				?.find((g) => g.id === "review")
				?.rows.map((r) => r.id);
			const progressIds = groups
				?.find((g) => g.id === "progress")
				?.rows.map((r) => r.id);
			expect(reviewIds).toContain("workspace-1");
			expect(progressIds).not.toContain("workspace-1");
		});
		await waitFor(() => {
			const detail = queryClient.getQueryData<WorkspaceDetail | null>(
				helmorQueryKeys.workspaceDetail("workspace-1"),
			);
			expect(detail?.status).toBe("review");
		});
		await waitFor(() => {
			expect(apiMocks.hideSession).toHaveBeenCalledWith("session-action");
		});
		await waitFor(() => {
			expect(onSelectSession).toHaveBeenCalledWith("session-after-close");
		});
	});

	it("clears the lifecycle when the tracked action session is aborted", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const selectedWorkspaceIdRef = { current: "workspace-1" };
		const onSelectSession = vi.fn();

		const { result, rerender } = renderHook(
			({
				completedSessionIds,
				abortedSessionIds,
				sendingSessionIds,
			}: {
				completedSessionIds: Set<string>;
				abortedSessionIds: Set<string>;
				sendingSessionIds: Set<string>;
			}) =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: "workspace-1",
					selectedWorkspaceIdRef,
					selectedRepoId: "repo-1",
					selectedWorkspaceTargetBranch: "main",
					changeRequest: null,
					forgeActionStatus: EMPTY_FORGE_ACTION_STATUS,
					workspaceGitActionStatus: EMPTY_GIT_ACTION_STATUS,
					completedSessionIds,
					abortedSessionIds,
					interactionRequiredSessionIds: new Set<string>(),
					sendingSessionIds,
					onSelectSession,
				}),
			{
				initialProps: {
					completedSessionIds: new Set<string>(),
					abortedSessionIds: new Set<string>(),
					sendingSessionIds: new Set<string>(),
				},
				wrapper: createWrapper(queryClient),
			},
		);

		await act(async () => {
			await result.current.handleInspectorCommitAction("create-pr");
		});

		expect(result.current.commitButtonState).toBe("busy");

		act(() => {
			result.current.handlePendingPromptConsumed();
		});

		// Session starts streaming.
		rerender({
			completedSessionIds: new Set<string>(),
			abortedSessionIds: new Set<string>(),
			sendingSessionIds: new Set(["session-action"]),
		});

		// User aborts: session leaves sendingSessionIds and enters
		// abortedSessionIds without ever reaching completedSessionIds.
		rerender({
			completedSessionIds: new Set<string>(),
			abortedSessionIds: new Set(["session-action"]),
			sendingSessionIds: new Set<string>(),
		});

		await waitFor(() => {
			expect(result.current.commitButtonState).toBe("idle");
		});
		expect(apiMocks.refreshWorkspaceChangeRequest).not.toHaveBeenCalled();
	});

	it("pushes directly without creating an action session", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
				},
			},
		});
		const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");
		const onSelectSession = vi.fn();
		const pushToast = vi.fn();

		const { result } = renderHook(
			() =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: "workspace-1",
					selectedWorkspaceIdRef: { current: "workspace-1" },
					selectedRepoId: "repo-1",
					changeRequest: null,
					forgeActionStatus: EMPTY_FORGE_ACTION_STATUS,
					workspaceGitActionStatus: {
						...EMPTY_GIT_ACTION_STATUS,
						pushStatus: "unpublished",
					},
					completedSessionIds: new Set<string>(),
					interactionRequiredSessionIds: new Set<string>(),
					sendingSessionIds: new Set<string>(),
					onSelectSession,
					pushToast,
				}),
			{
				wrapper: createWrapper(queryClient),
			},
		);

		await act(async () => {
			await result.current.handleInspectorCommitAction("push");
		});

		expect(apiMocks.pushWorkspaceToRemote).toHaveBeenCalledWith("workspace-1");
		expect(apiMocks.createSession).not.toHaveBeenCalled();
		expect(result.current.pendingPromptForSession).toBeNull();
		expect(onSelectSession).not.toHaveBeenCalled();

		await waitFor(() => {
			expect(invalidateQueriesSpy).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceGitActionStatus("workspace-1"),
			});
			expect(invalidateQueriesSpy).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceForgeActionStatus("workspace-1"),
			});
			expect(invalidateQueriesSpy).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceDetail("workspace-1"),
			});
			expect(invalidateQueriesSpy).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
			expect(invalidateQueriesSpy).toHaveBeenCalledWith({
				queryKey: ["workspaceChanges"],
			});
		});
		// Push doesn't change PR state — no workspaceChangeRequest invalidation
		// (which would trigger a redundant `gh pr view`).
		expect(invalidateQueriesSpy).not.toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.workspaceChangeRequest("workspace-1"),
		});
		expect(pushToast).not.toHaveBeenCalled();
	});

	it("shows a destructive workspace toast when push fails", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
				},
			},
		});
		const pushToast = vi.fn();
		apiMocks.pushWorkspaceToRemote.mockRejectedValueOnce(
			new Error(
				"Cannot push branch while the workspace has uncommitted changes",
			),
		);

		const { result } = renderHook(
			() =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: "workspace-1",
					selectedWorkspaceIdRef: { current: "workspace-1" },
					selectedRepoId: "repo-1",
					changeRequest: null,
					forgeActionStatus: EMPTY_FORGE_ACTION_STATUS,
					workspaceGitActionStatus: {
						...EMPTY_GIT_ACTION_STATUS,
						pushStatus: "unpublished",
					},
					completedSessionIds: new Set<string>(),
					interactionRequiredSessionIds: new Set<string>(),
					sendingSessionIds: new Set<string>(),
					onSelectSession: vi.fn(),
					pushToast,
				}),
			{
				wrapper: createWrapper(queryClient),
			},
		);

		await act(async () => {
			await result.current.handleInspectorCommitAction("push");
		});

		expect(pushToast).toHaveBeenCalledWith(
			"Cannot push branch while the workspace has uncommitted changes",
			"Push failed",
			"destructive",
		);
	});

	it("shows a destructive workspace toast when an action session fails to start", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
				},
			},
		});
		const pushToast = vi.fn();
		apiMocks.createSession.mockRejectedValueOnce(
			new Error("Unable to create action session"),
		);

		const { result } = renderHook(
			() =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: "workspace-1",
					selectedWorkspaceIdRef: { current: "workspace-1" },
					selectedRepoId: "repo-1",
					changeRequest: null,
					forgeActionStatus: EMPTY_FORGE_ACTION_STATUS,
					workspaceGitActionStatus: EMPTY_GIT_ACTION_STATUS,
					completedSessionIds: new Set<string>(),
					interactionRequiredSessionIds: new Set<string>(),
					sendingSessionIds: new Set<string>(),
					onSelectSession: vi.fn(),
					pushToast,
				}),
			{
				wrapper: createWrapper(queryClient),
			},
		);

		await act(async () => {
			await result.current.handleInspectorCommitAction("create-pr");
		});

		expect(pushToast).toHaveBeenCalledWith(
			"Unable to create action session",
			"Create PR failed",
			"destructive",
		);
	});

	it("optimistically moves the workspace to the done lane when merge is clicked", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData<ChangeRequestInfo | null>(
			helmorQueryKeys.workspaceChangeRequest("workspace-1"),
			{
				number: 53,
				title: "Fix overflow",
				url: "https://github.com/example/repo/pull/53",
				state: "OPEN",
				isMerged: false,
			},
		);
		queryClient.setQueryData<WorkspaceDetail | null>(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			{
				id: "workspace-1",
				status: "review",
			} as unknown as WorkspaceDetail,
		);
		queryClient.setQueryData<WorkspaceGroup[]>(
			helmorQueryKeys.workspaceGroups,
			[
				{
					id: "review",
					label: "In review",
					tone: "review",
					rows: [
						{
							id: "workspace-1",
							title: "W1",
							status: "review",
							createdAt: "2024-04-01T00:00:00Z",
						},
					],
				},
				{ id: "done", label: "Done", tone: "done", rows: [] },
			] as WorkspaceGroup[],
		);

		// Slow-resolve so we can observe the optimistic state before the
		// promise settles.
		let resolveMerge: (value: ChangeRequestInfo) => void = () => {};
		apiMocks.mergeWorkspaceChangeRequest.mockImplementationOnce(
			() =>
				new Promise<ChangeRequestInfo>((resolve) => {
					resolveMerge = resolve;
				}),
		);

		const { result } = renderHook(
			() =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: "workspace-1",
					selectedWorkspaceIdRef: { current: "workspace-1" },
					selectedRepoId: "repo-1",
					changeRequest: {
						number: 53,
						title: "Fix overflow",
						url: "https://github.com/example/repo/pull/53",
						state: "OPEN",
						isMerged: false,
					},
					forgeActionStatus: {
						...EMPTY_FORGE_ACTION_STATUS,
						mergeable: "MERGEABLE",
					},
					workspaceGitActionStatus: EMPTY_GIT_ACTION_STATUS,
					completedSessionIds: new Set<string>(),
					interactionRequiredSessionIds: new Set<string>(),
					sendingSessionIds: new Set<string>(),
					onSelectSession: vi.fn(),
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await act(async () => {
			await result.current.handleInspectorCommitAction("merge");
		});

		// Optimistic move happens synchronously in handleInspectorCommitAction.
		const groups = queryClient.getQueryData<WorkspaceGroup[]>(
			helmorQueryKeys.workspaceGroups,
		);
		expect(groups?.find((g) => g.id === "done")?.rows.map((r) => r.id)).toEqual(
			["workspace-1"],
		);
		expect(
			groups?.find((g) => g.id === "review")?.rows.map((r) => r.id),
		).toEqual([]);
		expect(
			queryClient.getQueryData<WorkspaceDetail | null>(
				helmorQueryKeys.workspaceDetail("workspace-1"),
			)?.status,
		).toBe("done");
		expect(
			queryClient.getQueryData<ChangeRequestInfo | null>(
				helmorQueryKeys.workspaceChangeRequest("workspace-1"),
			),
		).toMatchObject({ state: "MERGED", isMerged: true });

		// Resolve the in-flight merge so the test's hooks settle cleanly.
		await act(async () => {
			resolveMerge({
				number: 53,
				title: "Fix overflow",
				url: "https://github.com/example/repo/pull/53",
				state: "MERGED",
				isMerged: true,
			});
			await Promise.resolve();
		});
	});

	it("rolls back optimistic group + detail moves when merge fails", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const initialDetail = {
			id: "workspace-1",
			status: "review",
		} as unknown as WorkspaceDetail;
		const initialGroups = [
			{
				id: "review",
				label: "In review",
				tone: "review",
				rows: [
					{
						id: "workspace-1",
						title: "W1",
						status: "review",
						createdAt: "2024-04-01T00:00:00Z",
					},
				],
			},
			{ id: "done", label: "Done", tone: "done", rows: [] },
		] as WorkspaceGroup[];
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			initialDetail,
		);
		queryClient.setQueryData(helmorQueryKeys.workspaceGroups, initialGroups);

		apiMocks.mergeWorkspaceChangeRequest.mockRejectedValueOnce(
			new Error("GitHub merge failed"),
		);

		const { result } = renderHook(
			() =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: "workspace-1",
					selectedWorkspaceIdRef: { current: "workspace-1" },
					selectedRepoId: "repo-1",
					changeRequest: {
						number: 53,
						title: "Fix overflow",
						url: "https://github.com/example/repo/pull/53",
						state: "OPEN",
						isMerged: false,
					},
					forgeActionStatus: {
						...EMPTY_FORGE_ACTION_STATUS,
						mergeable: "MERGEABLE",
					},
					workspaceGitActionStatus: EMPTY_GIT_ACTION_STATUS,
					completedSessionIds: new Set<string>(),
					interactionRequiredSessionIds: new Set<string>(),
					sendingSessionIds: new Set<string>(),
					onSelectSession: vi.fn(),
					pushToast: vi.fn(),
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await act(async () => {
			await result.current.handleInspectorCommitAction("merge");
		});

		await waitFor(() => {
			const groups = queryClient.getQueryData<WorkspaceGroup[]>(
				helmorQueryKeys.workspaceGroups,
			);
			expect(
				groups?.find((g) => g.id === "review")?.rows.map((r) => r.id),
			).toEqual(["workspace-1"]);
			expect(
				groups?.find((g) => g.id === "done")?.rows.map((r) => r.id),
			).toEqual([]);
		});
		expect(
			queryClient.getQueryData<WorkspaceDetail | null>(
				helmorQueryKeys.workspaceDetail("workspace-1"),
			)?.status,
		).toBe("review");
	});

	it("queues a review prompt with the configured modelId when handleInspectorReviewAction runs", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const onSelectSession = vi.fn();

		const { result } = renderHook(
			() =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: "workspace-1",
					selectedWorkspaceIdRef: { current: "workspace-1" },
					selectedRepoId: "repo-1",
					selectedWorkspaceTargetBranch: "main",
					changeRequest: {
						number: 99,
						title: "Add Review PR button",
						url: "https://github.com/example/repo/pull/99",
						state: "OPEN",
						isMerged: false,
					},
					forgeActionStatus: EMPTY_FORGE_ACTION_STATUS,
					workspaceGitActionStatus: EMPTY_GIT_ACTION_STATUS,
					completedSessionIds: new Set<string>(),
					interactionRequiredSessionIds: new Set<string>(),
					sendingSessionIds: new Set<string>(),
					onSelectSession,
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await act(async () => {
			await result.current.handleInspectorReviewAction({
				modelId: "review-model",
			});
		});

		// Review is an action session ("auto-created", fixed title), but it
		// opts out of auto-hide via `isAutoHideableActionKind`.
		expect(apiMocks.createSession).toHaveBeenCalledWith("workspace-1", {
			actionKind: "review",
		});
		expect(result.current.pendingPromptForSession).toMatchObject({
			sessionId: "session-action",
			modelId: "review-model",
		});
		// New review prompt diffs against the target ref, no PR/MR machinery.
		expect(result.current.pendingPromptForSession?.prompt ?? "").toContain(
			"Review the changes on this branch relative to `origin/main`",
		);
		expect(onSelectSession).toHaveBeenCalledWith("session-action");
	});

	it("forwards a null modelId untouched (composer falls back to the workspace default)", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(
			() =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: "workspace-1",
					selectedWorkspaceIdRef: { current: "workspace-1" },
					selectedRepoId: "repo-1",
					selectedWorkspaceTargetBranch: "main",
					changeRequest: null,
					forgeActionStatus: EMPTY_FORGE_ACTION_STATUS,
					workspaceGitActionStatus: EMPTY_GIT_ACTION_STATUS,
					completedSessionIds: new Set<string>(),
					interactionRequiredSessionIds: new Set<string>(),
					sendingSessionIds: new Set<string>(),
					onSelectSession: vi.fn(),
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await act(async () => {
			await result.current.handleInspectorReviewAction({ modelId: null });
		});

		expect(result.current.pendingPromptForSession).toMatchObject({
			sessionId: "session-action",
			modelId: null,
		});
	});

	it("ignores handleInspectorReviewAction when no workspace is selected", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const onSelectSession = vi.fn();

		const { result } = renderHook(
			() =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: null,
					selectedWorkspaceIdRef: { current: null },
					selectedRepoId: null,
					changeRequest: null,
					forgeActionStatus: EMPTY_FORGE_ACTION_STATUS,
					workspaceGitActionStatus: EMPTY_GIT_ACTION_STATUS,
					completedSessionIds: new Set<string>(),
					interactionRequiredSessionIds: new Set<string>(),
					sendingSessionIds: new Set<string>(),
					onSelectSession,
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await act(async () => {
			await result.current.handleInspectorReviewAction({
				modelId: "review-model",
			});
		});

		expect(apiMocks.createSession).not.toHaveBeenCalled();
		expect(onSelectSession).not.toHaveBeenCalled();
		expect(result.current.pendingPromptForSession).toBeNull();
	});

	it("shows a destructive workspace toast when merge fails", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
				},
			},
		});
		const pushToast = vi.fn();
		apiMocks.mergeWorkspaceChangeRequest.mockRejectedValueOnce(
			new Error("GitHub merge failed"),
		);

		const { result } = renderHook(
			() =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: "workspace-1",
					selectedWorkspaceIdRef: { current: "workspace-1" },
					selectedRepoId: "repo-1",
					changeRequest: {
						number: 53,
						title: "Fix overflow",
						url: "https://github.com/example/repo/pull/53",
						state: "OPEN",
						isMerged: false,
					},
					forgeActionStatus: {
						...EMPTY_FORGE_ACTION_STATUS,
						mergeable: "MERGEABLE",
					},
					workspaceGitActionStatus: EMPTY_GIT_ACTION_STATUS,
					completedSessionIds: new Set<string>(),
					interactionRequiredSessionIds: new Set<string>(),
					sendingSessionIds: new Set<string>(),
					onSelectSession: vi.fn(),
					pushToast,
				}),
			{
				wrapper: createWrapper(queryClient),
			},
		);

		await act(async () => {
			await result.current.handleInspectorCommitAction("merge");
		});

		await waitFor(() => {
			expect(pushToast).toHaveBeenCalledWith(
				"GitHub merge failed",
				"Merge failed",
				"destructive",
			);
		});
	});
});
