import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ArchiveExecutionFailedPayload,
	ArchiveExecutionSucceededPayload,
	PrepareArchiveWorkspaceResponse,
	WorkspaceDetail,
	WorkspaceGroup,
	WorkspaceSessionSummary,
	WorkspaceSummary,
} from "@/lib/api";
import { DEFAULT_SETTINGS, SettingsContext } from "@/lib/settings";
import { useWorkspacesSidebarController } from "./use-controller";

const apiMocks = vi.hoisted(() => {
	let archiveFailedListener:
		| ((payload: ArchiveExecutionFailedPayload) => void)
		| null = null;
	let archiveSucceededListener:
		| ((payload: ArchiveExecutionSucceededPayload) => void)
		| null = null;

	return {
		addRepositoryFromLocalPath: vi.fn(),
		createWorkspaceFromRepo: vi.fn(),
		listRepositories: vi.fn(),
		loadAddRepositoryDefaults: vi.fn(),
		loadArchivedWorkspaces: vi.fn(),
		loadSessionThreadMessages: vi.fn(),
		loadWorkspaceDetail: vi.fn(),
		loadWorkspaceGroups: vi.fn(),
		loadWorkspaceSessions: vi.fn(),
		markWorkspaceRead: vi.fn(),
		markWorkspaceUnread: vi.fn(),
		permanentlyDeleteWorkspace: vi.fn(),
		pinWorkspace: vi.fn(),
		prepareArchiveWorkspace: vi.fn(),
		restoreWorkspace: vi.fn(),
		setWorkspaceManualStatus: vi.fn(),
		startArchiveWorkspace: vi.fn(),
		unpinWorkspace: vi.fn(),
		validateRestoreWorkspace: vi.fn(),
		listenArchiveExecutionFailed: vi.fn(async (callback) => {
			archiveFailedListener = callback;
			return () => {
				if (archiveFailedListener === callback) {
					archiveFailedListener = null;
				}
			};
		}),
		listenArchiveExecutionSucceeded: vi.fn(async (callback) => {
			archiveSucceededListener = callback;
			return () => {
				if (archiveSucceededListener === callback) {
					archiveSucceededListener = null;
				}
			};
		}),
		emitArchiveFailed(payload: ArchiveExecutionFailedPayload) {
			archiveFailedListener?.(payload);
		},
		emitArchiveSucceeded(payload: ArchiveExecutionSucceededPayload) {
			archiveSucceededListener?.(payload);
		},
	};
});

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		addRepositoryFromLocalPath: apiMocks.addRepositoryFromLocalPath,
		createWorkspaceFromRepo: apiMocks.createWorkspaceFromRepo,
		listRepositories: apiMocks.listRepositories,
		loadAddRepositoryDefaults: apiMocks.loadAddRepositoryDefaults,
		loadArchivedWorkspaces: apiMocks.loadArchivedWorkspaces,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
		loadWorkspaceDetail: apiMocks.loadWorkspaceDetail,
		loadWorkspaceGroups: apiMocks.loadWorkspaceGroups,
		loadWorkspaceSessions: apiMocks.loadWorkspaceSessions,
		listenArchiveExecutionFailed: apiMocks.listenArchiveExecutionFailed,
		listenArchiveExecutionSucceeded: apiMocks.listenArchiveExecutionSucceeded,
		markWorkspaceRead: apiMocks.markWorkspaceRead,
		markWorkspaceUnread: apiMocks.markWorkspaceUnread,
		permanentlyDeleteWorkspace: apiMocks.permanentlyDeleteWorkspace,
		pinWorkspace: apiMocks.pinWorkspace,
		prepareArchiveWorkspace: apiMocks.prepareArchiveWorkspace,
		restoreWorkspace: apiMocks.restoreWorkspace,
		setWorkspaceManualStatus: apiMocks.setWorkspaceManualStatus,
		startArchiveWorkspace: apiMocks.startArchiveWorkspace,
		unpinWorkspace: apiMocks.unpinWorkspace,
		validateRestoreWorkspace: apiMocks.validateRestoreWorkspace,
	};
});

const workspaceGroups: WorkspaceGroup[] = [
	{
		id: "progress",
		label: "In progress",
		tone: "progress",
		rows: [
			{
				id: "ws-1",
				title: "Workspace 1",
				repoName: "helmor",
				repoInitials: "HE",
				state: "ready",
				manualStatus: null,
				derivedStatus: "in-progress",
				hasUnread: false,
				workspaceUnread: 0,
				sessionUnreadTotal: 0,
				unreadSessionCount: 0,
				activeSessionId: null,
				activeSessionTitle: null,
				activeSessionAgentType: null,
				activeSessionStatus: null,
				branch: "feature/ws-1",
				prTitle: null,
				pinnedAt: null,
				sessionCount: 0,
				messageCount: 0,
				attachmentCount: 0,
			},
			{
				id: "ws-2",
				title: "Workspace 2",
				repoName: "helmor",
				repoInitials: "HE",
				state: "ready",
				manualStatus: null,
				derivedStatus: "in-progress",
				hasUnread: false,
				workspaceUnread: 0,
				sessionUnreadTotal: 0,
				unreadSessionCount: 0,
				activeSessionId: null,
				activeSessionTitle: null,
				activeSessionAgentType: null,
				activeSessionStatus: null,
				branch: "feature/ws-2",
				prTitle: null,
				pinnedAt: null,
				sessionCount: 0,
				messageCount: 0,
				attachmentCount: 0,
			},
		],
	},
];

function makeArchivedSummary(id: string): WorkspaceSummary {
	return {
		id,
		title: `Archived ${id}`,
		directoryName: id,
		repoName: "helmor",
		repoInitials: "HE",
		state: "archived",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "in-progress",
		manualStatus: null,
		branch: `feature/${id}`,
		activeSessionId: null,
		activeSessionTitle: null,
		activeSessionAgentType: null,
		activeSessionStatus: null,
		prTitle: null,
		sessionCount: 0,
		messageCount: 0,
		attachmentCount: 0,
	};
}

function makeWorkspaceDetail(id: string): WorkspaceDetail {
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
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "in-progress",
		manualStatus: null,
		activeSessionId: null,
		activeSessionTitle: null,
		activeSessionAgentType: null,
		activeSessionStatus: null,
		branch: `feature/${id}`,
		initializationParentBranch: "main",
		intendedTargetBranch: "main",
		notes: null,
		pinnedAt: null,
		prTitle: null,
		prDescription: null,
		archiveCommit: null,
		sessionCount: 0,
		messageCount: 0,
		attachmentCount: 0,
	};
}

const emptySessions: WorkspaceSessionSummary[] = [];

function createWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<SettingsContext.Provider
				value={{
					settings: DEFAULT_SETTINGS,
					updateSettings: () => {},
				}}
			>
				<QueryClientProvider client={queryClient}>
					{children}
				</QueryClientProvider>
			</SettingsContext.Provider>
		);
	};
}

describe("useWorkspacesSidebarController archive flow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		apiMocks.loadWorkspaceGroups.mockResolvedValue(workspaceGroups);
		apiMocks.loadArchivedWorkspaces.mockResolvedValue([]);
		apiMocks.listRepositories.mockResolvedValue([]);
		apiMocks.loadAddRepositoryDefaults.mockResolvedValue({
			lastCloneDirectory: null,
		});
		apiMocks.loadWorkspaceDetail.mockImplementation(async (id: string) =>
			makeWorkspaceDetail(id),
		);
		apiMocks.loadWorkspaceSessions.mockResolvedValue(emptySessions);
		apiMocks.loadSessionThreadMessages.mockResolvedValue([]);
		apiMocks.prepareArchiveWorkspace.mockImplementation(
			async (
				workspaceId: string,
			): Promise<PrepareArchiveWorkspaceResponse> => ({
				workspaceId,
			}),
		);
		apiMocks.startArchiveWorkspace.mockResolvedValue(undefined);
		apiMocks.validateRestoreWorkspace.mockResolvedValue({
			targetBranchConflict: null,
		});
		apiMocks.restoreWorkspace.mockResolvedValue({
			restoredWorkspaceId: "ws-1",
			restoredState: "ready",
			selectedWorkspaceId: "ws-1",
			branchRename: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("preflight 成功后立即乐观移动 workspace，并切到下一个 workspace", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const onSelectWorkspace = vi.fn();
		const pushWorkspaceToast = vi.fn();

		const { result } = renderHook(
			() =>
				useWorkspacesSidebarController({
					selectedWorkspaceId: "ws-1",
					onSelectWorkspace,
					pushWorkspaceToast,
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await waitFor(() => {
			expect(result.current.groups[0]?.rows).toHaveLength(2);
		});

		act(() => {
			result.current.handleArchiveWorkspace("ws-1");
		});

		await waitFor(() => {
			expect(apiMocks.prepareArchiveWorkspace).toHaveBeenCalledWith("ws-1");
		});
		await waitFor(() => {
			expect(apiMocks.startArchiveWorkspace).toHaveBeenCalledWith("ws-1");
		});
		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-2",
			]);
		});
		expect(result.current.archivedRows.map((row) => row.id)).toContain("ws-1");
		expect(onSelectWorkspace).toHaveBeenCalledWith("ws-2");
		expect(pushWorkspaceToast).not.toHaveBeenCalled();
	});

	it("后台启动立即失败时会回滚乐观更新", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const pushWorkspaceToast = vi.fn();
		apiMocks.startArchiveWorkspace.mockRejectedValueOnce(new Error("boom"));

		const { result } = renderHook(
			() =>
				useWorkspacesSidebarController({
					selectedWorkspaceId: null,
					onSelectWorkspace: vi.fn(),
					pushWorkspaceToast,
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await waitFor(() => {
			expect(result.current.groups[0]?.rows).toHaveLength(2);
		});

		act(() => {
			result.current.handleArchiveWorkspace("ws-1");
		});

		await waitFor(() => {
			expect(apiMocks.startArchiveWorkspace).toHaveBeenCalledWith("ws-1");
		});
		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-1",
				"ws-2",
			]);
		});
		expect(result.current.archivedRows).toHaveLength(0);
		expect(pushWorkspaceToast).toHaveBeenCalled();
	});

	it("后台未完成时，stale refetch 不会把 workspace 拉回 live 列表；失败事件会回滚", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const pushWorkspaceToast = vi.fn();
		let resolveStart: (() => void) | null = null;
		apiMocks.startArchiveWorkspace.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveStart = resolve;
				}),
		);

		const { result } = renderHook(
			() =>
				useWorkspacesSidebarController({
					selectedWorkspaceId: null,
					onSelectWorkspace: vi.fn(),
					pushWorkspaceToast,
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-1",
				"ws-2",
			]);
		});

		act(() => {
			result.current.handleArchiveWorkspace("ws-1");
		});

		await waitFor(() => {
			expect(result.current.archivedRows.map((row) => row.id)).toContain(
				"ws-1",
			);
		});

		act(() => {
			queryClient.setQueryData(["workspaceGroups"], workspaceGroups);
			queryClient.setQueryData(["archivedWorkspaces"], []);
		});

		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-2",
			]);
		});
		expect(result.current.archivedRows.map((row) => row.id)).toContain("ws-1");

		act(() => {
			apiMocks.emitArchiveFailed({
				workspaceId: "ws-1",
				message: "archive failed later",
			});
		});

		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-1",
				"ws-2",
			]);
		});
		expect(result.current.archivedRows).toHaveLength(0);
		expect(pushWorkspaceToast).toHaveBeenCalled();

		act(() => {
			resolveStart?.();
		});
	});

	it("成功事件后，后续服务端刷新会以真实 archived 数据为准", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		let resolveStart: (() => void) | null = null;
		apiMocks.startArchiveWorkspace.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveStart = resolve;
				}),
		);

		const { result } = renderHook(
			() =>
				useWorkspacesSidebarController({
					selectedWorkspaceId: null,
					onSelectWorkspace: vi.fn(),
					pushWorkspaceToast: vi.fn(),
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await waitFor(() => {
			expect(result.current.groups[0]?.rows).toHaveLength(2);
		});

		act(() => {
			result.current.handleArchiveWorkspace("ws-1");
		});

		await waitFor(() => {
			expect(result.current.archivedRows.map((row) => row.id)).toContain(
				"ws-1",
			);
		});

		act(() => {
			apiMocks.emitArchiveSucceeded({ workspaceId: "ws-1" });
			queryClient.setQueryData(
				["workspaceGroups"],
				[{ ...workspaceGroups[0], rows: [workspaceGroups[0].rows[1]] }],
			);
			queryClient.setQueryData(
				["archivedWorkspaces"],
				[makeArchivedSummary("ws-1")],
			);
		});

		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-2",
			]);
		});
		expect(result.current.archivedRows.map((row) => row.id)).toEqual(["ws-1"]);

		act(() => {
			resolveStart?.();
		});
	});
});
