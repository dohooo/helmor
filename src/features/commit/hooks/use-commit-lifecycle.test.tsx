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
		setWorkspaceManualStatus: apiMocks.setWorkspaceManualStatus,
	};
});

const EMPTY_GIT_ACTION_STATUS: WorkspaceGitActionStatus = {
	uncommittedCount: 0,
	conflictCount: 0,
	syncTargetBranch: "main",
	syncStatus: "upToDate",
	behindTargetCount: 0,
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
		apiMocks.setWorkspaceManualStatus.mockReset();

		apiMocks.createSession.mockResolvedValue({ sessionId: "session-action" });
		apiMocks.loadAutoCloseActionKinds.mockResolvedValue(["create-pr"]);
		apiMocks.setWorkspaceManualStatus.mockResolvedValue(undefined);
		apiMocks.lookupWorkspacePr.mockResolvedValue({
			number: 53,
			title: "Fix overflow",
			url: "https://github.com/example/repo/pull/53",
			state: "OPEN",
			isDraft: false,
			isMerged: false,
		} satisfies PullRequestInfo);
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
});
