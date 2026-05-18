import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
	WorkspaceDetail,
	WorkspaceGroup,
	WorkspaceRow,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { useSelectionController } from "./use-selection-controller";

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		triggerWorkspaceFetch: vi.fn(),
		prewarmSlashCommandsForWorkspace: vi.fn(),
	};
});

function makeWorkspace(id: string, name = id): WorkspaceDetail {
	return {
		id,
		name,
		title: name,
		description: null,
		summary: null,
		repoId: "repo-1",
		repoName: "repo",
		branch: "feature/branch",
		defaultBranch: "main",
		intendedTargetBranch: "main",
		remote: "origin",
		remoteUrl: null,
		state: "ready",
		tone: "progress",
		mode: "worktree",
		rootPath: `/tmp/${id}`,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		setupCompletedAt: "2024-01-01T00:00:00.000Z",
		activeSessionId: `${id}-session-1`,
		visibility: "visible",
		unreadSessionCount: 0,
		hasUnread: false,
		workspaceUnread: false,
		actionMode: null,
		actionContext: null,
		prSyncState: null,
		prUrl: null,
		prTitle: null,
		prDraft: false,
		prChecksTone: null,
		prMergeable: null,
		conflictCount: 0,
		uncommittedCount: 0,
		labelIds: [],
		summaryStage: null,
		archivedAt: null,
		bytesIndexed: null,
	} as unknown as WorkspaceDetail;
}

function makeSession(
	id: string,
	overrides: Partial<WorkspaceSessionSummary> = {},
): WorkspaceSessionSummary {
	return {
		id,
		workspaceId: "ws-1",
		title: id,
		summary: null,
		preview: null,
		active: false,
		archived: false,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		messageCount: 0,
		unreadCount: 0,
		settledAt: null,
		hidden: false,
		...overrides,
	} as unknown as WorkspaceSessionSummary;
}

function seedWorkspaceCache(
	queryClient: QueryClient,
	workspaceId: string,
	sessions: WorkspaceSessionSummary[] = [],
) {
	queryClient.setQueryData(
		helmorQueryKeys.workspaceDetail(workspaceId),
		makeWorkspace(workspaceId),
	);
	queryClient.setQueryData(
		helmorQueryKeys.workspaceSessions(workspaceId),
		sessions,
	);
	for (const session of sessions) {
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages(session.id), "thread"],
			[],
		);
	}
}

function buildHookProps(
	overrides: {
		queryClient?: QueryClient;
		workspaceGroups?: WorkspaceGroup[];
		archivedRows?: WorkspaceRow[];
		updateSettings?: (patch: unknown) => void;
		onWorkspaceSwitched?: () => void;
		onStartOpened?: (opts: { persist: boolean }) => void;
	} = {},
) {
	const queryClient = overrides.queryClient ?? new QueryClient();
	const updateSettings = overrides.updateSettings ?? vi.fn();
	return {
		queryClient,
		workspaceGroups: overrides.workspaceGroups ?? [],
		archivedRows: overrides.archivedRows ?? [],
		appSettings: { ...DEFAULT_SETTINGS },
		areSettingsLoaded: true,
		updateSettings: updateSettings as (
			patch: Partial<typeof DEFAULT_SETTINGS>,
		) => void | Promise<void>,
		onWorkspaceSwitched: overrides.onWorkspaceSwitched,
		onStartOpened: overrides.onStartOpened,
	} as const;
}

describe("useSelectionController", () => {
	it("selecting a workspace moves it through pending → displayed once cache warms", () => {
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		const { result } = renderHook(() =>
			useSelectionController(buildHookProps({ queryClient })),
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		expect(result.current.state.selectedWorkspaceId).toBe("ws-A");
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(result.current.state.selectedSessionId).toBe("ws-A-session-1");
		expect(result.current.state.displayedSessionId).toBe("ws-A-session-1");
	});

	it("re-selecting the current workspace bumps the reselect tick instead of switching", () => {
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		const onWorkspaceSwitched = vi.fn();
		const { result } = renderHook(() =>
			useSelectionController(
				buildHookProps({ queryClient, onWorkspaceSwitched }),
			),
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		const tickBefore = result.current.state.reselectTick;
		expect(onWorkspaceSwitched).toHaveBeenCalledTimes(1);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		expect(result.current.state.reselectTick).toBe(tickBefore + 1);
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(onWorkspaceSwitched).toHaveBeenCalledTimes(1);
	});

	it("rapid A → B switch only displays B (race guard discards stale resolves)", async () => {
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		seedWorkspaceCache(queryClient, "ws-B", [makeSession("ws-B-session-1")]);

		const { result } = renderHook(() =>
			useSelectionController(buildHookProps({ queryClient })),
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
			result.current.actions.selectWorkspace("ws-B");
		});

		expect(result.current.state.selectedWorkspaceId).toBe("ws-B");
		expect(result.current.state.displayedWorkspaceId).toBe("ws-B");
	});

	it("openStart wipes selection and switches viewMode; persist=true updates settings", () => {
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		const updateSettings = vi.fn();
		const onStartOpened = vi.fn();
		const { result } = renderHook(() =>
			useSelectionController(
				buildHookProps({ queryClient, updateSettings, onStartOpened }),
			),
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		updateSettings.mockClear();

		act(() => {
			result.current.actions.openStart();
		});

		expect(result.current.state.selectedWorkspaceId).toBeNull();
		expect(result.current.state.displayedWorkspaceId).toBeNull();
		expect(result.current.state.viewMode).toBe("start");
		expect(onStartOpened).toHaveBeenCalledWith({ persist: true });
		expect(updateSettings).toHaveBeenCalledWith({
			lastSurface: "workspace-start",
		});
	});

	it("openStart with persist=false skips the settings write but still fires onStartOpened", () => {
		const updateSettings = vi.fn();
		const onStartOpened = vi.fn();
		const { result } = renderHook(() =>
			useSelectionController(buildHookProps({ updateSettings, onStartOpened })),
		);

		act(() => {
			result.current.actions.openStart({ persist: false });
		});

		expect(onStartOpened).toHaveBeenCalledWith({ persist: false });
		expect(updateSettings).not.toHaveBeenCalledWith(
			expect.objectContaining({ lastSurface: "workspace-start" }),
		);
	});

	it("rememberSessionSelection caps history at the configured maximum", () => {
		const { result } = renderHook(() =>
			useSelectionController(buildHookProps()),
		);

		for (let i = 0; i < 30; i += 1) {
			act(() => {
				result.current.actions.rememberSessionSelection("ws-A", `session-${i}`);
			});
		}

		const history = result.current.actions.getSessionSelectionHistory("ws-A");
		expect(history.length).toBeLessThanOrEqual(16);
		expect(history[history.length - 1]).toBe("session-29");
	});

	it("rememberSessionSelection moves an existing id to the tail (LRU semantics)", () => {
		const { result } = renderHook(() =>
			useSelectionController(buildHookProps()),
		);

		act(() => {
			result.current.actions.rememberSessionSelection("ws-A", "session-1");
			result.current.actions.rememberSessionSelection("ws-A", "session-2");
			result.current.actions.rememberSessionSelection("ws-A", "session-1");
		});

		const history = result.current.actions.getSessionSelectionHistory("ws-A");
		expect(history).toEqual(["session-2", "session-1"]);
	});

	it("navigateWorkspaces uses the flattened sidebar order across groups + archived", () => {
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		seedWorkspaceCache(queryClient, "ws-B", [makeSession("ws-B-session-1")]);
		seedWorkspaceCache(queryClient, "ws-C", [makeSession("ws-C-session-1")]);

		const workspaceGroups: WorkspaceGroup[] = [
			{
				tone: "progress",
				rows: [
					{ id: "ws-A" } as WorkspaceRow,
					{ id: "ws-B" } as WorkspaceRow,
					{ id: "ws-C" } as WorkspaceRow,
				],
			} as WorkspaceGroup,
		];

		const { result } = renderHook(() =>
			useSelectionController(buildHookProps({ queryClient, workspaceGroups })),
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		act(() => {
			result.current.actions.navigateWorkspaces(1);
		});

		expect(result.current.state.selectedWorkspaceId).toBe("ws-B");

		act(() => {
			result.current.actions.navigateWorkspaces(1);
		});
		expect(result.current.state.selectedWorkspaceId).toBe("ws-C");

		act(() => {
			result.current.actions.navigateWorkspaces(1);
		});
		// At the end of the list, navigateWorkspaces is a no-op.
		expect(result.current.state.selectedWorkspaceId).toBe("ws-C");
	});

	it("getSnapshot reflects the most recent selection synchronously inside actions", () => {
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		seedWorkspaceCache(queryClient, "ws-B", [makeSession("ws-B-session-1")]);

		const { result } = renderHook(() =>
			useSelectionController(buildHookProps({ queryClient })),
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		expect(result.current.actions.getSnapshot()).toEqual({
			workspaceId: "ws-A",
			sessionId: "ws-A-session-1",
			viewMode: "conversation",
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		expect(result.current.actions.getSnapshot().workspaceId).toBe("ws-B");
	});

	it("actions reference is stable across renders", () => {
		const { result, rerender } = renderHook(() =>
			useSelectionController(buildHookProps()),
		);

		const initialActions = result.current.actions;
		rerender();
		expect(result.current.actions).toBe(initialActions);
	});
});
