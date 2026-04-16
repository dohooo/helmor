import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PullRequestInfo,
	WorkspaceGitActionStatus,
	WorkspacePrActionStatus,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { useWorkspaceCommitLifecycle } from "./use-commit-lifecycle";

const apiMocks = vi.hoisted(() => ({
	closeWorkspacePr: vi.fn(),
	createSession: vi.fn(),
	hideSession: vi.fn(),
	loadAutoCloseActionKinds: vi.fn(),
	lookupWorkspacePr: vi.fn(),
	mergeWorkspacePr: vi.fn(),
	pushWorkspaceToRemote: vi.fn(),
	setWorkspaceManualStatus: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		closeWorkspacePr: apiMocks.closeWorkspacePr,
		createSession: apiMocks.createSession,
		hideSession: apiMocks.hideSession,
		loadAutoCloseActionKinds: apiMocks.loadAutoCloseActionKinds,
		lookupWorkspacePr: apiMocks.lookupWorkspacePr,
		mergeWorkspacePr: apiMocks.mergeWorkspacePr,
		pushWorkspaceToRemote: apiMocks.pushWorkspaceToRemote,
		setWorkspaceManualStatus: apiMocks.setWorkspaceManualStatus,
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
	pushStatus: "unknown",
};

const EMPTY_PR_ACTION_STATUS: WorkspacePrActionStatus = {
	pr: null,
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
		apiMocks.closeWorkspacePr.mockReset();
		apiMocks.createSession.mockReset();
		apiMocks.hideSession.mockReset();
		apiMocks.loadAutoCloseActionKinds.mockReset();
		apiMocks.lookupWorkspacePr.mockReset();
		apiMocks.mergeWorkspacePr.mockReset();
		apiMocks.pushWorkspaceToRemote.mockReset();
		apiMocks.setWorkspaceManualStatus.mockReset();

		apiMocks.createSession.mockResolvedValue({ sessionId: "session-action" });
		apiMocks.loadAutoCloseActionKinds.mockResolvedValue(["create-pr"]);
		apiMocks.setWorkspaceManualStatus.mockResolvedValue(undefined);
		apiMocks.lookupWorkspacePr.mockResolvedValue({
			number: 53,
			title: "Fix overflow",
			url: "https://github.com/example/repo/pull/53",
			state: "OPEN",
			isMerged: false,
		} satisfies PullRequestInfo);
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
		queryClient.setQueryData(helmorQueryKeys.workspaceDetail("workspace-1"), {
			id: "workspace-1",
			activeSessionId: "session-after-close",
		});

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
					workspaceManualStatus: null,
					workspacePrInfo: null,
					workspacePrActionStatus: EMPTY_PR_ACTION_STATUS,
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
			expect(apiMocks.lookupWorkspacePr).toHaveBeenCalledWith("workspace-1");
		});
		await waitFor(() => {
			expect(invalidateQueriesSpy).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspacePr("workspace-1"),
			});
			expect(invalidateQueriesSpy).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspacePrActionStatus("workspace-1"),
			});
		});
		await waitFor(() => {
			expect(apiMocks.setWorkspaceManualStatus).toHaveBeenCalledWith(
				"workspace-1",
				"review",
			);
		});
		await waitFor(() => {
			expect(apiMocks.hideSession).toHaveBeenCalledWith("session-action");
		});
		await waitFor(() => {
			expect(onSelectSession).toHaveBeenCalledWith("session-after-close");
		});
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
					workspaceManualStatus: null,
					workspacePrInfo: null,
					workspacePrActionStatus: EMPTY_PR_ACTION_STATUS,
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
				queryKey: helmorQueryKeys.workspacePr("workspace-1"),
			});
			expect(invalidateQueriesSpy).toHaveBeenCalledWith({
				queryKey: helmorQueryKeys.workspacePrActionStatus("workspace-1"),
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
					workspaceManualStatus: null,
					workspacePrInfo: null,
					workspacePrActionStatus: EMPTY_PR_ACTION_STATUS,
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
					workspaceManualStatus: null,
					workspacePrInfo: null,
					workspacePrActionStatus: EMPTY_PR_ACTION_STATUS,
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

	it("shows a destructive workspace toast when merge fails", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
				},
			},
		});
		const pushToast = vi.fn();
		apiMocks.mergeWorkspacePr.mockRejectedValueOnce(
			new Error("GitHub merge failed"),
		);

		const { result } = renderHook(
			() =>
				useWorkspaceCommitLifecycle({
					queryClient,
					selectedWorkspaceId: "workspace-1",
					selectedWorkspaceIdRef: { current: "workspace-1" },
					workspaceManualStatus: null,
					workspacePrInfo: {
						number: 53,
						title: "Fix overflow",
						url: "https://github.com/example/repo/pull/53",
						state: "OPEN",
						isMerged: false,
					},
					workspacePrActionStatus: {
						...EMPTY_PR_ACTION_STATUS,
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
