import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	WorkspaceDetail,
	WorkspaceGroup,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { resetSidebarMutationGate } from "@/lib/sidebar-mutation-gate";
import { useReadStateController } from "./use-read-state-controller";

// markSession{Read,Unread} / unhideSession are the only real IPC calls
// the controller makes; everything else is React-Query cache hits. We
// stub them on a per-test basis so we can drive success / failure
// branches deterministically.
const apiMocks = vi.hoisted(() => ({
	markSessionRead: vi.fn(),
	markSessionUnread: vi.fn(),
	unhideSession: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		markSessionRead: apiMocks.markSessionRead,
		markSessionUnread: apiMocks.markSessionUnread,
		unhideSession: apiMocks.unhideSession,
	};
});

function makeSession(
	id: string,
	overrides: Partial<WorkspaceSessionSummary> = {},
): WorkspaceSessionSummary {
	return {
		id,
		workspaceId: "ws-1",
		title: `Session ${id}`,
		status: "idle",
		agentType: "claude-code",
		model: "claude-3-7-sonnet",
		unreadCount: 0,
		actionKind: null,
		lastUserMessageAt: null,
		permissionMode: "default",
		effortLevel: "high",
		fastMode: false,
		updatedAt: "2024-01-01T00:00:00Z",
		createdAt: "2024-01-01T00:00:00Z",
		isHidden: false,
		active: false,
		...overrides,
	};
}

function makeDetail(
	id: string,
	overrides: Partial<WorkspaceDetail> = {},
): WorkspaceDetail {
	return {
		id,
		title: `Workspace ${id}`,
		repoId: "repo-1",
		repoName: "helmor",
		repoInitials: "HE",
		repoIconSrc: null,
		remote: "origin",
		remoteUrl: null,
		defaultBranch: "main",
		rootPath: `/tmp/${id}`,
		directoryName: id,
		state: "ready",
		hasUnread: false,
		workspaceUnread: 0,
		unreadSessionCount: 0,
		status: "in-progress",
		activeSessionId: null,
		activeSessionTitle: null,
		activeSessionAgentType: null,
		activeSessionStatus: null,
		branch: `feature/${id}`,
		initializationParentBranch: "main",
		intendedTargetBranch: "main",
		mode: "worktree",
		pinnedAt: null,
		prTitle: null,
		archiveCommit: null,
		sessionCount: 0,
		messageCount: 0,
		...overrides,
	};
}

function makeGroups(rowOverrides: {
	id: string;
	hasUnread?: boolean;
	workspaceUnread?: number;
}): WorkspaceGroup[] {
	return [
		{
			id: "progress",
			label: "In progress",
			tone: "progress",
			rows: [
				{
					id: rowOverrides.id,
					title: `Workspace ${rowOverrides.id}`,
					repoName: "helmor",
					repoInitials: "HE",
					state: "ready",
					status: "in-progress",
					hasUnread: rowOverrides.hasUnread ?? false,
					workspaceUnread: rowOverrides.workspaceUnread ?? 0,
					unreadSessionCount: 0,
					activeSessionId: null,
					activeSessionTitle: null,
					activeSessionAgentType: null,
					activeSessionStatus: null,
					branch: "feature/x",
					prTitle: null,
					pinnedAt: null,
					sessionCount: 0,
					messageCount: 0,
				},
			],
		},
	];
}

function wrapper(queryClient: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

function seedCacheForWorkspace(
	queryClient: QueryClient,
	workspaceId: string,
	sessions: WorkspaceSessionSummary[],
	detailOverrides: Partial<WorkspaceDetail> = {},
) {
	queryClient.setQueryData<WorkspaceSessionSummary[]>(
		helmorQueryKeys.workspaceSessions(workspaceId),
		sessions,
	);
	queryClient.setQueryData<WorkspaceDetail>(
		helmorQueryKeys.workspaceDetail(workspaceId),
		makeDetail(workspaceId, {
			hasUnread: true,
			workspaceUnread: 1,
			unreadSessionCount: sessions.filter((s) => s.unreadCount > 0).length,
			...detailOverrides,
		}),
	);
	queryClient.setQueryData<WorkspaceGroup[]>(
		helmorQueryKeys.workspaceGroups,
		makeGroups({
			id: workspaceId,
			hasUnread: true,
			workspaceUnread: 1,
		}),
	);
}

function defaultDeps(
	queryClient: QueryClient,
	overrides: Partial<{
		displayedSessionId: string | null;
		reselectTick: number;
		selectedWorkspaceId: string | null;
		selectedSessionId: string | null;
	}> = {},
) {
	return {
		queryClient,
		notify: vi.fn(),
		pushToast: vi.fn(),
		displayedSessionId: overrides.displayedSessionId ?? "session-A",
		reselectTick: overrides.reselectTick ?? 0,
		getSelectedWorkspaceId: () => overrides.selectedWorkspaceId ?? "ws-1",
		getSelectedSessionId: () => overrides.selectedSessionId ?? "session-A",
		onReopenSelectWorkspace: vi.fn(),
		onReopenSelectSession: vi.fn(),
	};
}

describe("useReadStateController mark-read effect", () => {
	beforeEach(() => {
		resetSidebarMutationGate();
		vi.clearAllMocks();
		apiMocks.markSessionRead.mockResolvedValue(undefined);
		apiMocks.markSessionUnread.mockResolvedValue(undefined);
		apiMocks.unhideSession.mockResolvedValue(undefined);
	});

	afterEach(() => {
		resetSidebarMutationGate();
		vi.clearAllMocks();
	});

	it("optimistically zeros the displayed session's unread count and clears workspace unread when no others remain", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedCacheForWorkspace(queryClient, "ws-1", [
			makeSession("session-A", { unreadCount: 3 }),
		]);

		renderHook(() => useReadStateController(defaultDeps(queryClient)), {
			wrapper: wrapper(queryClient),
		});

		await waitFor(() =>
			expect(apiMocks.markSessionRead).toHaveBeenCalledWith("session-A"),
		);

		// Optimistic patches applied before the IPC resolved.
		const sessions = queryClient.getQueryData<WorkspaceSessionSummary[]>(
			helmorQueryKeys.workspaceSessions("ws-1"),
		);
		expect(sessions?.find((s) => s.id === "session-A")?.unreadCount).toBe(0);

		const detail = queryClient.getQueryData<WorkspaceDetail>(
			helmorQueryKeys.workspaceDetail("ws-1"),
		);
		expect(detail?.workspaceUnread).toBe(0);
		expect(detail?.unreadSessionCount).toBe(0);
	});

	it("rolls back groups + detail + sessions when markSessionRead rejects", async () => {
		const error = new Error("IPC boom");
		apiMocks.markSessionRead.mockRejectedValueOnce(error);

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const initialSessions = [
			makeSession("session-A", { unreadCount: 3 }),
			makeSession("session-B", { unreadCount: 1 }),
		];
		seedCacheForWorkspace(queryClient, "ws-1", initialSessions);

		// Capture the exact previous snapshots the controller will save
		// for rollback — the assertion is "post-rollback === pre-call".
		const previousSessions = queryClient.getQueryData(
			helmorQueryKeys.workspaceSessions("ws-1"),
		);
		const previousDetail = queryClient.getQueryData(
			helmorQueryKeys.workspaceDetail("ws-1"),
		);
		const previousGroups = queryClient.getQueryData(
			helmorQueryKeys.workspaceGroups,
		);

		// Silence the controller's `console.error` so the rejection
		// doesn't pollute the test runner output.
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		renderHook(() => useReadStateController(defaultDeps(queryClient)), {
			wrapper: wrapper(queryClient),
		});

		await waitFor(() =>
			expect(apiMocks.markSessionRead).toHaveBeenCalledWith("session-A"),
		);
		// Wait for the catch handler to land its rollback writes.
		await waitFor(() => {
			expect(consoleSpy).toHaveBeenCalled();
		});

		expect(
			queryClient.getQueryData(helmorQueryKeys.workspaceSessions("ws-1")),
		).toEqual(previousSessions);
		expect(
			queryClient.getQueryData(helmorQueryKeys.workspaceDetail("ws-1")),
		).toEqual(previousDetail);
		expect(queryClient.getQueryData(helmorQueryKeys.workspaceGroups)).toEqual(
			previousGroups,
		);

		consoleSpy.mockRestore();
	});

	it("does not fire the IPC when the displayed session is in interaction-required mode", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedCacheForWorkspace(queryClient, "ws-1", [
			makeSession("session-A", { unreadCount: 1 }),
		]);

		// Mount with no displayedSessionId so the effect's early-return
		// fires; flip interaction-required on; then point the
		// controller at session-A. The effect's interaction-required
		// guard must block the IPC.
		const { result, rerender } = renderHook(
			(props: { displayedSessionId: string | null }) =>
				useReadStateController({
					...defaultDeps(queryClient),
					displayedSessionId: props.displayedSessionId,
				}),
			{
				wrapper: wrapper(queryClient),
				initialProps: { displayedSessionId: null as string | null },
			},
		);

		const interactionMap = new Map<string, string>([["session-A", "ws-1"]]);
		const counts = new Map<string, number>([["session-A", 1]]);
		result.current.actions.onInteractionSessionsChange(interactionMap, counts);

		rerender({ displayedSessionId: "session-A" });

		await new Promise((r) => setTimeout(r, 20));
		expect(apiMocks.markSessionRead).not.toHaveBeenCalled();
	});

	it("dedupes consecutive renders for the same displayedSessionId + reselectTick", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedCacheForWorkspace(queryClient, "ws-1", [
			makeSession("session-A", { unreadCount: 1 }),
		]);

		const { rerender } = renderHook(
			(props: { displayedSessionId: string | null; reselectTick: number }) =>
				useReadStateController({
					...defaultDeps(queryClient),
					displayedSessionId: props.displayedSessionId,
					reselectTick: props.reselectTick,
				}),
			{
				wrapper: wrapper(queryClient),
				initialProps: { displayedSessionId: "session-A", reselectTick: 0 },
			},
		);

		await waitFor(() =>
			expect(apiMocks.markSessionRead).toHaveBeenCalledTimes(1),
		);
		// Re-render with the same id + tick — no second IPC.
		rerender({ displayedSessionId: "session-A", reselectTick: 0 });
		await new Promise((r) => setTimeout(r, 20));
		expect(apiMocks.markSessionRead).toHaveBeenCalledTimes(1);

		// Bumping reselectTick re-fires (user manually re-clicked the same workspace).
		rerender({ displayedSessionId: "session-A", reselectTick: 1 });
		await waitFor(() =>
			expect(apiMocks.markSessionRead).toHaveBeenCalledTimes(2),
		);
	});

	it("preserves workspaceUnread when another session still has unread messages", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		// session-A has unread + session-B still has unread → after
		// marking session-A read, workspaceUnread stays at its current
		// value (per `recomputeWorkspaceUnreadInGroups` contract).
		seedCacheForWorkspace(queryClient, "ws-1", [
			makeSession("session-A", { unreadCount: 1 }),
			makeSession("session-B", { unreadCount: 1 }),
		]);

		renderHook(() => useReadStateController(defaultDeps(queryClient)), {
			wrapper: wrapper(queryClient),
		});

		await waitFor(() => expect(apiMocks.markSessionRead).toHaveBeenCalled());

		const detail = queryClient.getQueryData<WorkspaceDetail>(
			helmorQueryKeys.workspaceDetail("ws-1"),
		);
		// session-A is now read but session-B still unread.
		expect(detail?.unreadSessionCount).toBe(1);
		// workspaceUnread is independent — backend rule is "clear only
		// when zero sessions are unread", which the helper mirrors.
		expect(detail?.workspaceUnread).toBe(1);
	});
});
