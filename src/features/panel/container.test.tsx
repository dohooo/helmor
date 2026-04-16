import { waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHelmorQueryClient, helmorQueryKeys } from "@/lib/query-client";
import { DEFAULT_SETTINGS, SettingsContext } from "@/lib/settings";
import { renderWithProviders } from "@/test/render-with-providers";

const apiMocks = vi.hoisted(() => ({
	createSession: vi.fn(),
	loadWorkspaceDetail: vi.fn(),
	loadWorkspaceSessions: vi.fn(),
	loadSessionMessages: vi.fn(),
	loadSessionThreadMessages: vi.fn(),
}));

const panelRenderSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		createSession: apiMocks.createSession,
		loadWorkspaceDetail: apiMocks.loadWorkspaceDetail,
		loadWorkspaceSessions: apiMocks.loadWorkspaceSessions,
		loadSessionMessages: apiMocks.loadSessionThreadMessages,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
	};
});

vi.mock("./index", () => ({
	WorkspacePanel: (props: Record<string, unknown>) => {
		useEffect(() => {
			const preparingSessionId = props.preparingSessionId as string | null;
			const onSessionPrepared = props.onSessionPrepared as
				| ((sessionId: string, payload: Record<string, unknown>) => void)
				| undefined;

			if (!preparingSessionId || !onSessionPrepared) {
				return;
			}

			const timeoutId = window.setTimeout(() => {
				onSessionPrepared(preparingSessionId, {
					layoutCacheKey: "test-layout",
					lastMeasuredAt: Date.now(),
				});
			}, 0);

			return () => {
				window.clearTimeout(timeoutId);
			};
		}, [props.onSessionPrepared, props.preparingSessionId]);

		panelRenderSpy(props);
		return <div data-testid="workspace-panel-props" />;
	},
}));

import { WorkspacePanelContainer } from "./container";

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolver) => {
		resolve = resolver;
	});

	return { promise, resolve };
}

function createWorkspaceDetail(
	workspaceId = "workspace-1",
	activeSessionId: string | null = "session-1",
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
		activeSessionStatus: activeSessionId ? "idle" : null,
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
			effortLevel: null,
			unreadCount: 0,
			contextTokenCount: 0,
			contextUsedPercent: null,
			thinkingEnabled: true,
			fastMode: false,
			agentPersonality: null,
			createdAt: "2026-04-05T00:00:00Z",
			updatedAt: "2026-04-05T00:00:00Z",
			lastUserMessageAt: null,
			resumeSessionAt: null,
			isHidden: false,
			isCompacting: false,
			actionKind: null,
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
			effortLevel: null,
			unreadCount: 0,
			contextTokenCount: 0,
			contextUsedPercent: null,
			thinkingEnabled: true,
			fastMode: false,
			agentPersonality: null,
			createdAt: "2026-04-05T00:00:00Z",
			updatedAt: "2026-04-05T00:00:00Z",
			lastUserMessageAt: null,
			resumeSessionAt: null,
			isHidden: false,
			isCompacting: false,
			actionKind: null,
			active: false,
		},
	];
}

function createWorkspaceSessionSummary(
	id: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		workspaceId: "workspace-1",
		title: id,
		agentType: "claude",
		status: "idle",
		model: "opus-1m",
		permissionMode: "default",
		providerSessionId: null,
		effortLevel: null,
		unreadCount: 0,
		contextTokenCount: 0,
		contextUsedPercent: null,
		thinkingEnabled: true,
		fastMode: false,
		agentPersonality: null,
		createdAt: "2026-04-05T00:00:00Z",
		updatedAt: "2026-04-05T00:00:00Z",
		lastUserMessageAt: null,
		resumeSessionAt: null,
		isHidden: false,
		isCompacting: false,
		actionKind: null,
		active: false,
		...overrides,
	};
}

function createMessages(sessionId: string) {
	return [
		{
			role: "assistant" as const,
			id: `${sessionId}-assistant`,
			createdAt: "2026-04-05T00:00:00Z",
			content: [{ type: "text" as const, text: "hello" }],
			status: { type: "complete", reason: "stop" },
		},
	];
}

function createPlanReviewMessages(
	sessionId: string,
	toolUseId = "tool-plan-1",
) {
	return [
		{
			role: "assistant" as const,
			id: `${sessionId}-plan-review`,
			createdAt: "2026-04-05T00:00:00Z",
			content: [
				{
					type: "plan-review" as const,
					toolUseId,
					toolName: "ExitPlanMode",
					plan: "1. Review the implementation plan.",
					planFilePath: "/tmp/plan.md",
					allowedPrompts: [],
				},
			],
			status: { type: "complete", reason: "stop" },
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
		apiMocks.createSession.mockReset();
		apiMocks.loadWorkspaceDetail.mockReset();
		apiMocks.loadWorkspaceSessions.mockReset();
		apiMocks.loadSessionThreadMessages.mockReset();

		apiMocks.createSession.mockResolvedValue({ sessionId: "session-created" });
		apiMocks.loadWorkspaceDetail.mockImplementation((workspaceId?: string) =>
			Promise.resolve(createWorkspaceDetail(workspaceId)),
		);
		apiMocks.loadWorkspaceSessions.mockImplementation((workspaceId?: string) =>
			Promise.resolve(createWorkspaceSessions(workspaceId)),
		);
		apiMocks.loadSessionThreadMessages.mockImplementation(
			(sessionId?: string) =>
				Promise.resolve(createMessages(sessionId ?? "session-1")),
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
		apiMocks.loadSessionThreadMessages.mockReturnValue(
			deferredMessages.promise,
		);

		renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-2"
				displayedSessionId="session-2"
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
			[...helmorQueryKeys.sessionMessages("session-2"), "thread"],
			createMessages("session-2"),
		);
		apiMocks.loadSessionThreadMessages.mockResolvedValue(
			createMessages("session-2"),
		);

		renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-2"
				displayedSessionId="session-2"
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

	it("derives the new-session tab provider from the default model setting", () => {
		const queryClient = createHelmorQueryClient();
		queryClient.setQueryData(helmorQueryKeys.agentModelSections, [
			{
				id: "claude",
				label: "Claude",
				options: [
					{
						id: "opus-1m",
						provider: "claude",
						label: "Opus",
						cliModel: "opus-1m",
					},
				],
			},
			{
				id: "codex",
				label: "Codex",
				options: [
					{
						id: "gpt-5.4",
						provider: "codex",
						label: "GPT-5.4",
						cliModel: "gpt-5.4",
					},
				],
			},
		]);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			createWorkspaceDetail("workspace-1", "session-new"),
		);
		queryClient.setQueryData(helmorQueryKeys.workspaceSessions("workspace-1"), [
			{
				id: "session-new",
				workspaceId: "workspace-1",
				title: "Untitled",
				agentType: null,
				status: "idle",
				model: null,
				permissionMode: "default",
				providerSessionId: null,
				unreadCount: 0,
				contextTokenCount: 0,
				contextUsedPercent: null,
				thinkingEnabled: true,
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
		]);
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages("session-new"), "thread"],
			[],
		);

		renderWithProviders(
			<SettingsContext.Provider
				value={{
					settings: {
						...DEFAULT_SETTINGS,
						defaultModelId: "gpt-5.4",
					},
					updateSettings: vi.fn(),
				}}
			>
				<WorkspacePanelContainer
					selectedWorkspaceId="workspace-1"
					displayedWorkspaceId="workspace-1"
					selectedSessionId="session-new"
					displayedSessionId="session-new"
					sending={false}
					onSelectSession={vi.fn()}
					onResolveDisplayedSession={vi.fn()}
				/>
			</SettingsContext.Provider>,
			{ queryClient },
		);

		expect(getLatestPanelProps().sessionDisplayProviders).toEqual({
			"session-new": "codex",
		});
	});

	it("falls back to loading when revisiting a session after query cache eviction", async () => {
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
			[...helmorQueryKeys.sessionMessages("session-1"), "thread"],
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
			[...helmorQueryKeys.sessionMessages("session-3"), "thread"],
			createMessages("session-3"),
		);

		const rendered = renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-1"
				displayedSessionId="session-1"
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
			{ queryClient },
		);

		await waitFor(() => {
			expect(getSessionPaneIds()).toContain("session-1");
		});

		// Install the deferred mock BEFORE evicting the cache. The live
		// observer on session-1 fires an automatic refetch the instant
		// `removeQueries` drops its data, and that refetch must not hit the
		// default `mockReset` stub (which returns undefined and poisons the
		// query with a `"data cannot be undefined"` error that survives the
		// later rerender back to session-1).
		const deferredMessages =
			createDeferred<ReturnType<typeof createMessages>>();
		apiMocks.loadSessionThreadMessages.mockImplementation(
			(sessionId?: string) => {
				if (sessionId === "session-1") {
					return deferredMessages.promise;
				}

				return Promise.resolve(createMessages(sessionId ?? "session-unknown"));
			},
		);

		queryClient.removeQueries({
			queryKey: [...helmorQueryKeys.sessionMessages("session-1"), "thread"],
		});

		rendered.rerender(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-2"
				displayedWorkspaceId="workspace-2"
				selectedSessionId="session-3"
				displayedSessionId="session-3"
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(getSessionPaneIds()).toContain("session-3");
		});

		rendered.rerender(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-1"
				displayedSessionId="session-1"
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
		);

		expect(getLatestPanelProps().loadingSession).toBe(true);
		expect(getSessionPaneIds()).not.toContain("session-1");

		deferredMessages.resolve(createMessages("session-1"));

		await waitFor(() => {
			expect(getLatestPanelProps().loadingSession).toBe(false);
			expect(getSessionPaneIds()).toContain("session-1");
		});
	});

	it("renders only the active session pane when switching between sessions", async () => {
		const queryClient = createHelmorQueryClient();
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			createWorkspaceDetail("workspace-1", "session-2"),
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceSessions("workspace-1"),
			createWorkspaceSessions("workspace-1"),
		);
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages("session-2"), "thread"],
			[],
		);
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages("session-1"), "thread"],
			createMessages("session-1"),
		);

		const rendered = renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-2"
				displayedSessionId="session-2"
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
			{ queryClient },
		);

		await waitFor(() => {
			expect(getSessionPaneIds()).toContain("session-2");
		});

		rendered.rerender(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-1"
				displayedSessionId="session-1"
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(getSessionPaneIds()).toContain("session-1");
			expect(getSessionPaneIds()).not.toContain("session-2");
			expect(getSessionPaneIds()).toHaveLength(1);
		});
	});

	it("shows an empty session immediately without a prepare phase", async () => {
		const queryClient = createHelmorQueryClient();
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			createWorkspaceDetail("workspace-1", "session-2"),
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceSessions("workspace-1"),
			createWorkspaceSessions("workspace-1"),
		);
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages("session-2"), "thread"],
			[],
		);
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages("session-1"), "thread"],
			createMessages("session-1"),
		);

		const rendered = renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-2"
				displayedSessionId="session-2"
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
			{ queryClient },
		);

		rendered.rerender(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-1"
				displayedSessionId="session-1"
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(getSessionPaneIds()).toEqual(["session-1"]);
			expect(getLatestPanelProps().loadingSession).toBe(false);
		});
	});

	it("sorts sessions before rendering the panel", async () => {
		const queryClient = createHelmorQueryClient();
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			createWorkspaceDetail("workspace-1", "idle"),
		);
		queryClient.setQueryData(helmorQueryKeys.workspaceSessions("workspace-1"), [
			createWorkspaceSessionSummary("action-idle", {
				actionKind: "create-pr",
				updatedAt: "2026-04-05T00:00:00Z",
			}),
			createWorkspaceSessionSummary("idle", {
				active: true,
				updatedAt: "2026-04-06T00:00:00Z",
			}),
			createWorkspaceSessionSummary("running", {
				updatedAt: "2026-04-07T00:00:00Z",
			}),
			createWorkspaceSessionSummary("unread", {
				unreadCount: 2,
				updatedAt: "2026-04-04T00:00:00Z",
			}),
		]);
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages("idle"), "thread"],
			createMessages("idle"),
		);

		renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="idle"
				displayedSessionId="idle"
				sending={false}
				sendingSessionIds={new Set(["running"])}
				completedSessionIds={new Set(["unread"])}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
			{ queryClient },
		);

		await waitFor(() => {
			expect(
				(getLatestPanelProps().sessions as Array<{ id: string }>).map(
					(session) => session.id,
				),
			).toEqual(["unread", "running", "idle", "action-idle"]);
		});
	});

	it("uses the sorted first session as the default displayed thread", async () => {
		const queryClient = createHelmorQueryClient();
		const onResolveDisplayedSession = vi.fn();
		const workspaceDetail = createWorkspaceDetail("workspace-1", null);
		const workspaceSessions = [
			createWorkspaceSessionSummary("idle", {
				updatedAt: "2026-04-05T00:00:00Z",
			}),
			createWorkspaceSessionSummary("unread", {
				unreadCount: 1,
				updatedAt: "2026-04-04T00:00:00Z",
			}),
		];

		apiMocks.loadWorkspaceDetail.mockResolvedValue(workspaceDetail);
		apiMocks.loadWorkspaceSessions.mockResolvedValue(workspaceSessions);
		apiMocks.loadSessionThreadMessages.mockImplementation(
			(sessionId?: string) =>
				Promise.resolve(createMessages(sessionId ?? "unread")),
		);

		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			workspaceDetail,
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceSessions("workspace-1"),
			workspaceSessions,
		);
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages("unread"), "thread"],
			createMessages("unread"),
		);

		renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId={null}
				displayedSessionId={null}
				sending={false}
				completedSessionIds={new Set(["unread"])}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={onResolveDisplayedSession}
			/>,
			{ queryClient },
		);

		await waitFor(() => {
			expect(onResolveDisplayedSession).toHaveBeenCalledWith("unread");
		});
	});

	it("auto-creates a session when the selected workspace has none", async () => {
		const queryClient = createHelmorQueryClient();
		let created = false;
		const onResolveDisplayedSession = vi.fn();

		apiMocks.createSession.mockImplementation(async () => {
			created = true;
			return { sessionId: "session-created" };
		});
		apiMocks.loadWorkspaceDetail.mockImplementation(
			async (workspaceId?: string) =>
				created
					? {
							...createWorkspaceDetail(workspaceId, "session-created"),
							sessionCount: 1,
							activeSessionTitle: "Untitled",
						}
					: {
							...createWorkspaceDetail(workspaceId, null),
							activeSessionAgentType: null,
							sessionCount: 0,
						},
		);
		apiMocks.loadWorkspaceSessions.mockImplementation(
			async (workspaceId?: string) =>
				created
					? [
							{
								id: "session-created",
								workspaceId: workspaceId ?? "workspace-1",
								title: "Untitled",
								agentType: null,
								status: "idle",
								model: null,
								permissionMode: "default",
								providerSessionId: null,
								unreadCount: 0,
								contextTokenCount: 0,
								contextUsedPercent: null,
								thinkingEnabled: true,
								fastMode: false,
								agentPersonality: null,
								createdAt: "2026-04-05T00:00:00Z",
								updatedAt: "2026-04-05T00:00:00Z",
								lastUserMessageAt: null,
								resumeSessionAt: null,
								isHidden: false,
								isCompacting: false,
								actionKind: null,
								active: true,
							},
						]
					: [],
		);
		apiMocks.loadSessionThreadMessages.mockResolvedValue([]);

		renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId={null}
				displayedSessionId={null}
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={onResolveDisplayedSession}
			/>,
			{ queryClient },
		);

		await waitFor(() => {
			expect(apiMocks.createSession).toHaveBeenCalledWith("workspace-1");
		});
		await waitFor(() => {
			expect(onResolveDisplayedSession).toHaveBeenCalledWith("session-created");
		});
		await waitFor(() => {
			expect(getSessionPaneIds()).toEqual(["session-created"]);
		});
	});

	it("renders plan-review messages from DB as read-only cards", async () => {
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
			[...helmorQueryKeys.sessionMessages("session-1"), "thread"],
			createPlanReviewMessages("session-1"),
		);

		renderWithProviders(
			<WorkspacePanelContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-1"
				displayedSessionId="session-1"
				sending={false}
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
			/>,
			{ queryClient },
		);

		const pane = (
			getLatestPanelProps().sessionPanes as Array<{
				sessionId: string;
				messages: Array<unknown>;
			}>
		).find((entry) => entry.sessionId === "session-1");

		expect(pane?.messages).toHaveLength(1);
	});
});
