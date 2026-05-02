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
import { helmorQueryKeys } from "@/lib/query-client";
import { DEFAULT_SETTINGS, SettingsContext } from "@/lib/settings";
import { resetSidebarMutationGate } from "@/lib/sidebar-mutation-gate";
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
		prepareWorkspaceFromRepo: vi.fn(),
		finalizeWorkspaceFromRepo: vi.fn(),
		listRepositories: vi.fn(),
		loadAddRepositoryDefaults: vi.fn(),
		loadArchivedWorkspaces: vi.fn(),
		loadSessionThreadMessages: vi.fn(),
		loadWorkspaceDetail: vi.fn(),
		loadWorkspaceGroups: vi.fn(),
		loadWorkspaceSessions: vi.fn(),
		markWorkspaceUnread: vi.fn(),
		permanentlyDeleteWorkspace: vi.fn(),
		pinWorkspace: vi.fn(),
		prepareArchiveWorkspace: vi.fn(),
		restoreWorkspace: vi.fn(),
		setWorkspaceStatus: vi.fn(),
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
		prepareWorkspaceFromRepo: apiMocks.prepareWorkspaceFromRepo,
		finalizeWorkspaceFromRepo: apiMocks.finalizeWorkspaceFromRepo,
		listRepositories: apiMocks.listRepositories,
		loadAddRepositoryDefaults: apiMocks.loadAddRepositoryDefaults,
		loadArchivedWorkspaces: apiMocks.loadArchivedWorkspaces,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
		loadWorkspaceDetail: apiMocks.loadWorkspaceDetail,
		loadWorkspaceGroups: apiMocks.loadWorkspaceGroups,
		loadWorkspaceSessions: apiMocks.loadWorkspaceSessions,
		listenArchiveExecutionFailed: apiMocks.listenArchiveExecutionFailed,
		listenArchiveExecutionSucceeded: apiMocks.listenArchiveExecutionSucceeded,
		markWorkspaceUnread: apiMocks.markWorkspaceUnread,
		permanentlyDeleteWorkspace: apiMocks.permanentlyDeleteWorkspace,
		pinWorkspace: apiMocks.pinWorkspace,
		prepareArchiveWorkspace: apiMocks.prepareArchiveWorkspace,
		restoreWorkspace: apiMocks.restoreWorkspace,
		setWorkspaceStatus: apiMocks.setWorkspaceStatus,
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
				status: "in-progress",
				hasUnread: false,
				workspaceUnread: 0,
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
			},
			{
				id: "ws-2",
				title: "Workspace 2",
				repoName: "helmor",
				repoInitials: "HE",
				state: "ready",
				status: "in-progress",
				hasUnread: false,
				workspaceUnread: 0,
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
		unreadSessionCount: 0,
		status: "in-progress",
		branch: `feature/${id}`,
		activeSessionId: null,
		activeSessionTitle: null,
		activeSessionAgentType: null,
		activeSessionStatus: null,
		prTitle: null,
		pinnedAt: null,
		sessionCount: 0,
		messageCount: 0,
		createdAt: "2024-01-01T00:00:00Z",
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
		unreadSessionCount: 0,
		status: "in-progress",
		activeSessionId: null,
		activeSessionTitle: null,
		activeSessionAgentType: null,
		activeSessionStatus: null,
		branch: `feature/${id}`,
		initializationParentBranch: "main",
		intendedTargetBranch: "main",
		pinnedAt: null,
		prTitle: null,
		archiveCommit: null,
		sessionCount: 0,
		messageCount: 0,
	};
}

const emptySessions: WorkspaceSessionSummary[] = [];

function createWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<SettingsContext.Provider
				value={{
					settings: DEFAULT_SETTINGS,
					isLoaded: true,
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
		resetSidebarMutationGate();
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
		apiMocks.permanentlyDeleteWorkspace.mockResolvedValue(undefined);
		apiMocks.startArchiveWorkspace.mockResolvedValue(undefined);
		apiMocks.validateRestoreWorkspace.mockResolvedValue({
			targetBranchConflict: null,
		});
		apiMocks.restoreWorkspace.mockResolvedValue({
			restoredWorkspaceId: "ws-1",
			restoredState: "ready",
			selectedWorkspaceId: "ws-1",
			branchRename: null,
			restoredFromTargetBranch: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("does not auto-select a workspace when auto selection is disabled", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const onSelectWorkspace = vi.fn();
		const pushWorkspaceToast = vi.fn();

		const { result } = renderHook(
			() =>
				useWorkspacesSidebarController({
					selectedWorkspaceId: null,
					autoSelectEnabled: false,
					onSelectWorkspace,
					pushWorkspaceToast,
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await waitFor(() => {
			expect(result.current.groups[0]?.rows[0]?.id).toBe("ws-1");
		});
		expect(onSelectWorkspace).not.toHaveBeenCalled();
	});

	it("optimistically moves the workspace after preflight success and switches to the next one", async () => {
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

	it("consecutive archives advance to the next sidebar row instead of jumping to archived", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const onSelectWorkspace = vi.fn();
		const pushWorkspaceToast = vi.fn();

		apiMocks.loadWorkspaceGroups.mockResolvedValue([
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
					{
						...workspaceGroups[0].rows[0],
						id: "ws-1",
						title: "Workspace 1",
					},
					{
						...workspaceGroups[0].rows[0],
						id: "ws-2",
						title: "Workspace 2",
					},
					{
						...workspaceGroups[0].rows[0],
						id: "ws-3",
						title: "Workspace 3",
					},
				],
			},
		]);
		apiMocks.loadArchivedWorkspaces.mockResolvedValue([
			makeArchivedSummary("arch-1"),
		]);

		const { result, rerender } = renderHook(
			({ selectedWorkspaceId }: { selectedWorkspaceId: string | null }) =>
				useWorkspacesSidebarController({
					selectedWorkspaceId,
					onSelectWorkspace,
					pushWorkspaceToast,
				}),
			{
				initialProps: { selectedWorkspaceId: "ws-1" },
				wrapper: createWrapper(queryClient),
			},
		);

		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-1",
				"ws-2",
				"ws-3",
			]);
		});

		act(() => {
			result.current.handleArchiveWorkspace("ws-1");
		});

		await waitFor(() => {
			expect(onSelectWorkspace).toHaveBeenLastCalledWith("ws-2");
		});

		rerender({ selectedWorkspaceId: "ws-2" });

		act(() => {
			result.current.handleArchiveWorkspace("ws-2");
		});

		await waitFor(() => {
			expect(onSelectWorkspace).toHaveBeenLastCalledWith("ws-3");
		});
		expect(pushWorkspaceToast).not.toHaveBeenCalled();
	});

	it("paints the workspace with final metadata after prepare, then finalizes to ready in place", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const onSelectWorkspace = vi.fn();
		const pushWorkspaceToast = vi.fn();
		let resolveFinalize:
			| ((value: { workspaceId: string; finalState: string }) => void)
			| null = null;
		const generatedWorkspaceId = crypto.randomUUID();
		const generatedSessionId = crypto.randomUUID();

		apiMocks.listRepositories.mockResolvedValue([
			{
				id: "repo-1",
				name: "helmor",
				defaultBranch: "main",
				repoInitials: "HE",
			},
		]);
		apiMocks.prepareWorkspaceFromRepo.mockResolvedValue({
			workspaceId: generatedWorkspaceId,
			initialSessionId: generatedSessionId,
			repoId: "repo-1",
			repoName: "helmor",
			directoryName: "vega",
			branch: "feature/vega",
			defaultBranch: "main",
			state: "initializing" as const,
			repoScripts: {
				setupScript: null,
				runScript: null,
				archiveScript: null,
				setupFromProject: false,
				runFromProject: false,
				archiveFromProject: false,
				autoRunSetup: true,
			},
		});
		apiMocks.finalizeWorkspaceFromRepo.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveFinalize = resolve;
				}),
		);

		const { result } = renderHook(
			() =>
				useWorkspacesSidebarController({
					selectedWorkspaceId: null,
					onSelectWorkspace,
					pushWorkspaceToast,
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await waitFor(() => {
			expect(result.current.groups[0]?.rows).toHaveLength(2);
		});

		await act(async () => {
			void result.current.handleCreateWorkspaceFromRepo("repo-1");
		});

		await waitFor(() => {
			expect(result.current.groups[0]?.rows[0]?.id).toBe(generatedWorkspaceId);
		});

		const preparedRow = result.current.groups[0]?.rows[0];
		expect(preparedRow?.state).toBe("initializing");
		// Title, directory, branch are all final-state immediately — prepare
		// returned real values so there is no placeholder-to-real swap.
		expect(preparedRow?.title).toBe("helmor workspace");
		expect(preparedRow?.directoryName).toBe("vega");
		expect(preparedRow?.branch).toBe("feature/vega");
		expect(apiMocks.prepareWorkspaceFromRepo).toHaveBeenCalledWith("repo-1");
		expect(onSelectWorkspace).toHaveBeenCalledWith(generatedWorkspaceId);
		expect(apiMocks.finalizeWorkspaceFromRepo).toHaveBeenCalledWith(
			generatedWorkspaceId,
		);

		await act(async () => {
			resolveFinalize?.({
				workspaceId: generatedWorkspaceId,
				finalState: "ready",
			});
		});

		// After Phase 2, the detail flips to state=ready in place — no new
		// row, no id swap.
		await waitFor(() => {
			expect(
				queryClient.getQueryData(
					helmorQueryKeys.workspaceDetail(generatedWorkspaceId),
				),
			).toMatchObject({
				id: generatedWorkspaceId,
				state: "ready",
			});
		});
		expect(generatedSessionId).toBeTruthy();
		expect(pushWorkspaceToast).not.toHaveBeenCalled();
	});

	it("paints the workspace detail + sessions cache from prepare response", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const onSelectWorkspace = vi.fn();
		const generatedWorkspaceId = crypto.randomUUID();
		const generatedSessionId = crypto.randomUUID();

		apiMocks.listRepositories.mockResolvedValue([
			{
				id: "repo-1",
				name: "helmor",
				defaultBranch: "main",
				repoInitials: "HE",
			},
		]);
		apiMocks.prepareWorkspaceFromRepo.mockResolvedValue({
			workspaceId: generatedWorkspaceId,
			initialSessionId: generatedSessionId,
			repoId: "repo-1",
			repoName: "helmor",
			directoryName: "testuser-helmor",
			branch: "testuser/helmor",
			defaultBranch: "main",
			state: "initializing" as const,
			repoScripts: {
				setupScript: null,
				runScript: null,
				archiveScript: null,
				setupFromProject: false,
				runFromProject: false,
				archiveFromProject: false,
				autoRunSetup: true,
			},
		});
		// Keep Phase 2 suspended so we can assert the Phase 1 painted state
		// independently.
		apiMocks.finalizeWorkspaceFromRepo.mockImplementation(
			() => new Promise(() => {}),
		);

		const { result } = renderHook(
			() =>
				useWorkspacesSidebarController({
					selectedWorkspaceId: null,
					onSelectWorkspace,
					pushWorkspaceToast: vi.fn(),
				}),
			{ wrapper: createWrapper(queryClient) },
		);

		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-1",
				"ws-2",
			]);
		});

		await act(async () => {
			void result.current.handleCreateWorkspaceFromRepo("repo-1");
		});

		await waitFor(() => {
			expect(result.current.groups[0]?.rows[0]?.id).toBe(generatedWorkspaceId);
		});

		// After Phase 1, the detail + sessions cache is already seeded with
		// the final directory/branch — no re-render needed later for those.
		// Branch/remote fields must match what Phase 2's refetch returns so
		// the inspector's `workspaceTargetBranch` doesn't flip `null →
		// "origin/main"` and flash the "Remote" BranchDiffSection header.
		expect(
			queryClient.getQueryData(
				helmorQueryKeys.workspaceDetail(generatedWorkspaceId),
			),
		).toMatchObject({
			id: generatedWorkspaceId,
			directoryName: "testuser-helmor",
			branch: "testuser/helmor",
			state: "initializing",
			remote: "origin",
			defaultBranch: "main",
			intendedTargetBranch: "main",
			initializationParentBranch: "main",
		});
		expect(
			queryClient.getQueryData(
				helmorQueryKeys.workspaceSessions(generatedWorkspaceId),
			),
		).toMatchObject([
			{
				id: generatedSessionId,
				workspaceId: generatedWorkspaceId,
				active: true,
			},
		]);

		// Git + PR status caches are seeded with the canonical "fresh
		// workspace" empty state so the inspector's Actions section never
		// falls through to EMPTY_*_STATUS (which renders the misleading
		// "Sync status unavailable" / "Waiting for PR review" labels).
		expect(
			queryClient.getQueryData(
				helmorQueryKeys.workspaceGitActionStatus(generatedWorkspaceId),
			),
		).toMatchObject({
			uncommittedCount: 0,
			conflictCount: 0,
			syncStatus: "upToDate",
			pushStatus: "unpublished",
		});
		expect(
			queryClient.getQueryData(
				helmorQueryKeys.workspaceChangeRequest(generatedWorkspaceId),
			),
		).toBeNull();
		expect(
			queryClient.getQueryData(
				helmorQueryKeys.workspaceForgeActionStatus(generatedWorkspaceId),
			),
		).toMatchObject({
			changeRequest: null,
			remoteState: "noPr",
			deployments: [],
			checks: [],
		});

		expect(onSelectWorkspace).toHaveBeenCalledWith(generatedWorkspaceId);
	});

	it("does not optimistically reorder sidebar groups when setting manual status", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const deferred = new Promise<void>(() => {});

		apiMocks.setWorkspaceStatus.mockReturnValue(deferred);

		const { result } = renderHook(
			() =>
				useWorkspacesSidebarController({
					selectedWorkspaceId: "ws-1",
					onSelectWorkspace: vi.fn(),
					pushWorkspaceToast: vi.fn(),
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
			void result.current.handleSetWorkspaceStatus("ws-1", "done");
		});

		expect(apiMocks.setWorkspaceStatus).toHaveBeenCalledWith("ws-1", "done");
		expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
			"ws-1",
			"ws-2",
		]);
		expect(
			result.current.groups.find((group) => group.id === "done")?.rows ?? [],
		).toEqual([]);
	});

	// The pending creation row and the navigation refetch share the same
	// workspace id. Once the canonical row lands in base groups, reconciliation
	// drops the pending entry — exactly one row remains.
	it("does not duplicate the row when the canonical workspace groups refetch", {
		retry: 2,
	}, async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		let resolveFinalize:
			| ((value: { workspaceId: string; finalState: string }) => void)
			| null = null;
		const generatedWorkspaceId = crypto.randomUUID();
		const generatedSessionId = crypto.randomUUID();

		apiMocks.listRepositories.mockResolvedValue([
			{
				id: "repo-1",
				name: "helmor",
				defaultBranch: "main",
				repoInitials: "HE",
			},
		]);
		apiMocks.prepareWorkspaceFromRepo.mockResolvedValue({
			workspaceId: generatedWorkspaceId,
			initialSessionId: generatedSessionId,
			repoId: "repo-1",
			repoName: "helmor",
			directoryName: "testuser-helmor",
			branch: "testuser/helmor",
			defaultBranch: "main",
			state: "initializing" as const,
			repoScripts: {
				setupScript: null,
				runScript: null,
				archiveScript: null,
				setupFromProject: false,
				runFromProject: false,
				archiveFromProject: false,
				autoRunSetup: true,
			},
		});
		apiMocks.finalizeWorkspaceFromRepo.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveFinalize = resolve;
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
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-1",
				"ws-2",
			]);
		});

		await act(async () => {
			void result.current.handleCreateWorkspaceFromRepo("repo-1");
		});

		await waitFor(() => {
			expect(result.current.groups[0]?.rows[0]?.id).toBe(generatedWorkspaceId);
		});

		const upgradedGroups = [
			{
				...workspaceGroups[0],
				rows: [
					{
						...workspaceGroups[0].rows[0],
						id: generatedWorkspaceId,
						title: "helmor workspace",
						state: "initializing" as const,
						branch: "testuser/helmor",
					},
					...workspaceGroups[0].rows,
				],
			},
		];
		apiMocks.loadWorkspaceGroups.mockResolvedValue(upgradedGroups);

		act(() => {
			queryClient.setQueryData(helmorQueryKeys.workspaceGroups, upgradedGroups);
		});

		await act(async () => {
			resolveFinalize?.({
				workspaceId: generatedWorkspaceId,
				finalState: "ready",
			});
		});

		await waitFor(() => {
			expect(
				result.current.groups[0]?.rows.filter(
					(row) => row.id === generatedWorkspaceId,
				),
			).toHaveLength(1);
		});
	});

	// When Phase 2 rejects, Rust has already cleaned up the DB row +
	// worktree. The frontend must tear down its mirror: drop the pending
	// row, remove all seeded caches (detail/sessions/messages/scripts),
	// surface an error toast, and (if the user is still parked on the
	// failing workspace) switch selection back to the previously-selected
	// workspace via the `selectedWorkspaceIdRef` path.
	it("tears down the mirror and restores previous selection when finalize rejects", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const onSelectWorkspace = vi.fn();
		const pushWorkspaceToast = vi.fn();
		const generatedWorkspaceId = crypto.randomUUID();
		const generatedSessionId = crypto.randomUUID();

		apiMocks.listRepositories.mockResolvedValue([
			{
				id: "repo-1",
				name: "helmor",
				defaultBranch: "main",
				repoInitials: "HE",
			},
		]);
		apiMocks.prepareWorkspaceFromRepo.mockResolvedValue({
			workspaceId: generatedWorkspaceId,
			initialSessionId: generatedSessionId,
			repoId: "repo-1",
			repoName: "helmor",
			directoryName: "testuser-helmor",
			branch: "testuser/helmor",
			defaultBranch: "main",
			state: "initializing" as const,
			repoScripts: {
				setupScript: null,
				runScript: null,
				archiveScript: null,
				setupFromProject: false,
				runFromProject: false,
				archiveFromProject: false,
				autoRunSetup: true,
			},
		});
		apiMocks.finalizeWorkspaceFromRepo.mockRejectedValue(
			new Error("worktree create failed"),
		);

		let currentSelection: string | null = "ws-1";
		onSelectWorkspace.mockImplementation((id: string | null) => {
			currentSelection = id;
		});

		const { result, rerender } = renderHook(
			({ selectedWorkspaceId }: { selectedWorkspaceId: string | null }) =>
				useWorkspacesSidebarController({
					selectedWorkspaceId,
					onSelectWorkspace,
					pushWorkspaceToast,
				}),
			{
				initialProps: { selectedWorkspaceId: currentSelection },
				wrapper: createWrapper(queryClient),
			},
		);

		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-1",
				"ws-2",
			]);
		});

		await act(async () => {
			void result.current.handleCreateWorkspaceFromRepo("repo-1");
		});

		// Phase 1 painted the pending row + selected the new workspace.
		await waitFor(() => {
			expect(onSelectWorkspace).toHaveBeenCalledWith(generatedWorkspaceId);
		});
		rerender({ selectedWorkspaceId: currentSelection });

		// Wait for the rejection to propagate through `.catch().finally()`.
		await waitFor(() => {
			expect(pushWorkspaceToast).toHaveBeenCalled();
		});

		// Pending entry + every seeded cache key is removed.
		expect(
			queryClient.getQueryData(
				helmorQueryKeys.workspaceDetail(generatedWorkspaceId),
			),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(
				helmorQueryKeys.workspaceSessions(generatedWorkspaceId),
			),
		).toBeUndefined();
		expect(
			queryClient.getQueryData([
				...helmorQueryKeys.sessionMessages(generatedSessionId),
				"thread",
			]),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(
				helmorQueryKeys.repoScripts("repo-1", generatedWorkspaceId),
			),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(
				helmorQueryKeys.workspaceGitActionStatus(generatedWorkspaceId),
			),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(
				helmorQueryKeys.workspaceChangeRequest(generatedWorkspaceId),
			),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(
				helmorQueryKeys.workspaceForgeActionStatus(generatedWorkspaceId),
			),
		).toBeUndefined();
		expect(
			result.current.groups[0]?.rows.find(
				(row) => row.id === generatedWorkspaceId,
			),
		).toBeUndefined();

		// Selection: the user was parked on the failing workspace, so the
		// catch branch switches them back to the previous selection.
		const lastSelectCall =
			onSelectWorkspace.mock.calls[onSelectWorkspace.mock.calls.length - 1];
		expect(lastSelectCall?.[0]).toBe("ws-1");
	});

	it("rolls back the optimistic update when the background start fails immediately", async () => {
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

	it("stale refetches do not restore the workspace while the background is pending; failure events roll it back", async () => {
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
				code: "Unknown",
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

	it("after a success event, subsequent server refreshes defer to the real archived data", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		let resolveStart: (() => void) | null = null;
		let archivedFromServer: WorkspaceSummary[] = [];
		let groupsFromServer = workspaceGroups;
		apiMocks.startArchiveWorkspace.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveStart = resolve;
				}),
		);
		apiMocks.loadWorkspaceGroups.mockImplementation(
			async () => groupsFromServer,
		);
		apiMocks.loadArchivedWorkspaces.mockImplementation(
			async () => archivedFromServer,
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
			groupsFromServer = [
				{ ...workspaceGroups[0], rows: [workspaceGroups[0].rows[1]] },
			];
			archivedFromServer = [makeArchivedSummary("ws-1")];
			apiMocks.emitArchiveSucceeded({ workspaceId: "ws-1" });
		});

		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-2",
			]);
		});
		expect(result.current.archivedRows.map((row) => row.id)).toEqual(["ws-1"]);
		expect(apiMocks.loadWorkspaceGroups).toHaveBeenCalledTimes(2);
		expect(apiMocks.loadArchivedWorkspaces).toHaveBeenCalledTimes(2);

		act(() => {
			resolveStart?.();
		});
	});

	it("does not render the same workspace in both live and archived when the success event arrives before the server snapshot switches", async () => {
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
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-1",
				"ws-2",
			]);
		});

		act(() => {
			result.current.handleArchiveWorkspace("ws-1");
		});

		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-2",
			]);
			expect(result.current.archivedRows.map((row) => row.id)).toEqual([
				"ws-1",
			]);
		});

		act(() => {
			apiMocks.emitArchiveSucceeded({ workspaceId: "ws-1" });
		});

		await waitFor(() => {
			expect(result.current.groups[0]?.rows.map((row) => row.id)).toEqual([
				"ws-2",
			]);
			expect(result.current.archivedRows.map((row) => row.id)).toEqual([
				"ws-1",
			]);
		});

		const occurrences = [
			...result.current.groups.flatMap((group) => group.rows),
			...result.current.archivedRows,
		].filter((row) => row.id === "ws-1");
		expect(occurrences).toHaveLength(1);

		act(() => {
			resolveStart?.();
		});
	});

	it("deleting an archived placeholder also clears the local optimistic rollback entry", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const onSelectWorkspace = vi.fn();
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
					selectedWorkspaceId: "ws-1",
					onSelectWorkspace,
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
			resolveStart?.();
		});

		await waitFor(() => {
			expect(result.current.archivingWorkspaceIds.has("ws-1")).toBe(false);
		});

		act(() => {
			result.current.handleDeleteWorkspace("ws-1");
		});

		await waitFor(() => {
			expect(apiMocks.permanentlyDeleteWorkspace).toHaveBeenCalledWith("ws-1");
		});
		await waitFor(() => {
			expect(result.current.archivedRows).toHaveLength(0);
		});

		act(() => {
			queryClient.setQueryData(["archivedWorkspaces"], []);
		});

		expect(result.current.archivedRows).toHaveLength(0);
		expect(onSelectWorkspace).toHaveBeenCalledWith("ws-2");
	});
});
