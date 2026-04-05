import { waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHelmorQueryClient, helmorQueryKeys } from "@/lib/query-client";
import { renderWithProviders } from "@/test/render-with-providers";

const apiMocks = vi.hoisted(() => ({
	loadWorkspaceDetail: vi.fn(),
	loadWorkspaceSessions: vi.fn(),
	loadSessionMessages: vi.fn(),
}));

const panelRenderSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		loadWorkspaceDetail: apiMocks.loadWorkspaceDetail,
		loadWorkspaceSessions: apiMocks.loadWorkspaceSessions,
		loadSessionMessages: apiMocks.loadSessionMessages,
	};
});

vi.mock("./workspace-panel", () => ({
	WorkspacePanel: (props: Record<string, unknown>) => {
		useEffect(() => {
			const preparingSessionId = props.preparingSessionId as string | null;
			const onSessionPrepared = props.onSessionPrepared as
				| ((sessionId: string, payload: Record<string, unknown>) => void)
				| undefined;

			if (!preparingSessionId || !onSessionPrepared) {
				return;
			}

			onSessionPrepared(preparingSessionId, {
				layoutCacheKey: "test-layout",
				lastMeasuredAt: Date.now(),
			});
		}, [props.onSessionPrepared, props.preparingSessionId]);

		panelRenderSpy(props);
		return <div data-testid="workspace-panel-props" />;
	},
}));

import { WorkspacePanelContainer } from "./workspace-panel-container";

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolver) => {
		resolve = resolver;
	});

	return { promise, resolve };
}

function createWorkspaceDetail(
	workspaceId = "workspace-1",
	activeSessionId = "session-1",
) {
	return {
		id: workspaceId,
		title: `Workspace ${workspaceId}`,
		repoId: "repo-1",
		repoName: "helmor",
		directoryName: "helmor",
		state: "ready",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "in-progress",
		manualStatus: null,
		activeSessionId,
		activeSessionTitle: activeSessionId,
		activeSessionAgentType: "claude",
		activeSessionStatus: "idle",
		branch: "main",
		initializationParentBranch: "main",
		intendedTargetBranch: "main",
		notes: null,
		pinnedAt: null,
		prTitle: null,
		prDescription: null,
		archiveCommit: null,
		sessionCount: 2,
		messageCount: 2,
		attachmentCount: 0,
		rootPath: "/tmp/helmor",
	};
}

function createWorkspaceSessions(
	workspaceId = "workspace-1",
	sessionIds = ["session-1", "session-2"],
) {
	return [
		{
			id: sessionIds[0],
			workspaceId,
			title: sessionIds[0],
			agentType: "claude",
			status: "idle",
			model: "opus-1m",
			permissionMode: "default",
			providerSessionId: null,
			unreadCount: 0,
			contextTokenCount: 0,
			contextUsedPercent: null,
			thinkingEnabled: true,
			codexThinkingLevel: null,
			fastMode: false,
			agentPersonality: null,
			createdAt: "2026-04-05T00:00:00Z",
			updatedAt: "2026-04-05T00:00:00Z",
			lastUserMessageAt: null,
			resumeSessionAt: null,
			isHidden: false,
			isCompacting: false,
			active: true,
		},
		{
			id: sessionIds[1],
			workspaceId,
			title: sessionIds[1],
			agentType: "claude",
			status: "idle",
			model: "opus-1m",
			permissionMode: "default",
			providerSessionId: null,
			unreadCount: 0,
			contextTokenCount: 0,
			contextUsedPercent: null,
			thinkingEnabled: true,
			codexThinkingLevel: null,
			fastMode: false,
			agentPersonality: null,
			createdAt: "2026-04-05T00:00:00Z",
			updatedAt: "2026-04-05T00:00:00Z",
			lastUserMessageAt: null,
			resumeSessionAt: null,
			isHidden: false,
			isCompacting: false,
			active: false,
		},
	];
}

function createMessages(sessionId: string) {
	return [
		{
			id: `${sessionId}-assistant`,
			sessionId,
			role: "assistant",
			content: "hello",
			contentIsJson: false,
			createdAt: "2026-04-05T00:00:00Z",
			sentAt: "2026-04-05T00:00:00Z",
			cancelledAt: null,
			model: "opus-1m",
			sdkMessageId: null,
			lastAssistantMessageId: null,
			turnId: null,
			isResumableMessage: null,
			attachmentCount: 0,
		},
	];
}

function getLatestPanelProps() {
	const latestCall =
		panelRenderSpy.mock.calls[panelRenderSpy.mock.calls.length - 1];
	if (!latestCall) {
		throw new Error("WorkspacePanel was not rendered.");
	}

	return latestCall[0] as Record<string, unknown>;
}

function getSessionPaneIds() {
	return (
		(getLatestPanelProps().sessionPanes as Array<{ sessionId: string }>)?.map(
			(pane) => pane.sessionId,
		) ?? []
	);
}

describe("WorkspacePanelContainer loading semantics", () => {
	beforeEach(() => {
		panelRenderSpy.mockReset();
		apiMocks.loadWorkspaceDetail.mockReset();
		apiMocks.loadWorkspaceSessions.mockReset();
		apiMocks.loadSessionMessages.mockReset();

		apiMocks.loadWorkspaceDetail.mockImplementation((workspaceId?: string) =>
			Promise.resolve(createWorkspaceDetail(workspaceId)),
		);
		apiMocks.loadWorkspaceSessions.mockImplementation((workspaceId?: string) =>
			Promise.resolve(createWorkspaceSessions(workspaceId)),
		);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("shows a cold session loader for the first open of an uncached session", async () => {
		const queryClient = createHelmorQueryClient();
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			createWorkspaceDetail("workspace-1"),
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceSessions("workspace-1"),
			createWorkspaceSessions("workspace-1"),
		);

		const deferredMessages =
			createDeferred<ReturnType<typeof createMessages>>();
		apiMocks.loadSessionMessages.mockReturnValue(deferredMessages.promise);

		renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-2"
				displayedSessionId="session-2"
				liveMessages={[]}
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
			{ queryClient },
		);

		expect(getLatestPanelProps().loadingWorkspace).toBe(false);
		expect(getLatestPanelProps().loadingSession).toBe(true);
		expect(getLatestPanelProps().refreshingSession).toBe(false);

		deferredMessages.resolve(createMessages("session-2"));
	});

	it("renders cached session data immediately when revisiting a previously opened session", async () => {
		const queryClient = createHelmorQueryClient();
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			createWorkspaceDetail("workspace-1"),
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceSessions("workspace-1"),
			createWorkspaceSessions("workspace-1"),
		);
		queryClient.setQueryData(
			helmorQueryKeys.sessionMessages("session-2"),
			createMessages("session-2"),
		);
		apiMocks.loadSessionMessages.mockResolvedValue(createMessages("session-2"));

		renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-2"
				displayedSessionId="session-2"
				liveMessages={[]}
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
			{ queryClient },
		);

		expect(getLatestPanelProps().loadingWorkspace).toBe(false);
		expect(getLatestPanelProps().loadingSession).toBe(false);
		expect(getSessionPaneIds()).toContain("session-2");
		expect(
			(
				getLatestPanelProps().sessionPanes as Array<{
					sessionId: string;
					messages: ReturnType<typeof createMessages>;
				}>
			).find((pane) => pane.sessionId === "session-2")?.messages,
		).toEqual(createMessages("session-2"));
	});

	it("reuses a kept-alive pane across workspace switches even after query cache eviction", async () => {
		const queryClient = createHelmorQueryClient();
		const workspace1Sessions = createWorkspaceSessions("workspace-1", [
			"session-1",
			"session-2",
		]);
		const workspace2Sessions = createWorkspaceSessions("workspace-2", [
			"session-3",
			"session-4",
		]);

		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			createWorkspaceDetail("workspace-1", "session-1"),
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceSessions("workspace-1"),
			workspace1Sessions,
		);
		queryClient.setQueryData(
			helmorQueryKeys.sessionMessages("session-1"),
			createMessages("session-1"),
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-2"),
			createWorkspaceDetail("workspace-2", "session-3"),
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceSessions("workspace-2"),
			workspace2Sessions,
		);
		queryClient.setQueryData(
			helmorQueryKeys.sessionMessages("session-3"),
			createMessages("session-3"),
		);

		const rendered = renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-1"
				displayedSessionId="session-1"
				liveMessages={[]}
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
			{ queryClient },
		);

		await waitFor(() => {
			expect(getSessionPaneIds()).toContain("session-1");
		});

		queryClient.removeQueries({
			queryKey: helmorQueryKeys.sessionMessages("session-1"),
		});

		rendered.rerender(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-2"
				displayedWorkspaceId="workspace-2"
				selectedSessionId="session-3"
				displayedSessionId="session-3"
				liveMessages={[]}
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(getSessionPaneIds()).toContain("session-3");
		});

		const deferredMessages =
			createDeferred<ReturnType<typeof createMessages>>();
		apiMocks.loadSessionMessages.mockImplementation((sessionId?: string) => {
			if (sessionId === "session-1") {
				return deferredMessages.promise;
			}

			return Promise.resolve(createMessages(sessionId ?? "session-unknown"));
		});

		rendered.rerender(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-1"
				displayedSessionId="session-1"
				liveMessages={[]}
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
		);

		expect(getLatestPanelProps().loadingSession).toBe(false);
		expect(getSessionPaneIds()).toEqual(
			expect.arrayContaining(["session-1", "session-3"]),
		);

		deferredMessages.resolve(createMessages("session-1"));
	});
});
