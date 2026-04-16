import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorkspaceDetail, WorkspaceSessionSummary } from "@/lib/api";
import { createHelmorQueryClient, helmorQueryKeys } from "@/lib/query-client";

const apiMocks = vi.hoisted(() => ({
	createSession: vi.fn(),
	hideSession: vi.fn(),
}));

vi.mock("@/components/icons", () => ({
	ClaudeIcon: (props: { className?: string }) => (
		<span data-testid="claude-icon" {...props}>
			claude-icon
		</span>
	),
	OpenAIIcon: (props: { className?: string }) => (
		<span data-testid="codex-icon" {...props}>
			codex-icon
		</span>
	),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		createSession: apiMocks.createSession,
		hideSession: apiMocks.hideSession,
	};
});

import { WorkspacePanel } from "./index";

const WORKSPACE: WorkspaceDetail = {
	id: "workspace-1",
	title: "Workspace 1",
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
	activeSessionId: "session-1",
	activeSessionTitle: "Session 1",
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
	sessionCount: 1,
	messageCount: 0,
	attachmentCount: 0,
	rootPath: "/tmp/helmor",
};

const SESSIONS: WorkspaceSessionSummary[] = [
	{
		id: "session-1",
		workspaceId: "workspace-1",
		title: "Session 1",
		agentType: "claude",
		status: "idle",
		model: "opus",
		permissionMode: "default",
		providerSessionId: null,
		effortLevel: null,
		unreadCount: 0,
		contextTokenCount: 0,
		contextUsedPercent: null,
		thinkingEnabled: true,
		fastMode: false,
		agentPersonality: null,
		createdAt: "2026-04-10T00:00:00Z",
		updatedAt: "2026-04-10T00:00:00Z",
		lastUserMessageAt: null,
		resumeSessionAt: null,
		isHidden: false,
		isCompacting: false,
		actionKind: null,
		active: true,
	},
];

describe("WorkspacePanel", () => {
	beforeEach(() => {
		apiMocks.createSession.mockReset();
		apiMocks.hideSession.mockReset();
		apiMocks.createSession.mockResolvedValue({ sessionId: "session-new" });
		apiMocks.hideSession.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("optimistically seeds the new session before switching selection", async () => {
		const user = userEvent.setup();
		const queryClient = createHelmorQueryClient();
		const onSelectSession = vi.fn();

		render(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={queryClient}>
					<WorkspacePanel
						workspace={WORKSPACE}
						sessions={SESSIONS}
						selectedSessionId="session-1"
						sessionPanes={[]}
						sending={false}
						onSelectSession={onSelectSession}
						onSessionsChanged={vi.fn()}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		await user.click(screen.getByRole("button", { name: "New session" }));

		await waitFor(() => {
			expect(onSelectSession).toHaveBeenCalledWith("session-new");
		});

		expect(
			queryClient.getQueryData<WorkspaceDetail>(
				helmorQueryKeys.workspaceDetail("workspace-1"),
			),
		).toMatchObject({
			activeSessionId: "session-new",
			activeSessionTitle: "Untitled",
			activeSessionStatus: "idle",
		});
		expect(
			queryClient.getQueryData<WorkspaceSessionSummary[]>(
				helmorQueryKeys.workspaceSessions("workspace-1"),
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "session-new",
					title: "Untitled",
					active: true,
				}),
			]),
		);
		expect(
			queryClient.getQueryData([
				...helmorQueryKeys.sessionMessages("session-new"),
				"thread",
			]),
		).toEqual([]);
	});

	it("replaces the last visible session before closing it", async () => {
		const user = userEvent.setup();
		const queryClient = createHelmorQueryClient();
		const onSelectSession = vi.fn();
		const onSessionsChanged = vi.fn();

		apiMocks.createSession.mockResolvedValueOnce({
			sessionId: "session-replacement",
		});

		const { container } = render(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={queryClient}>
					<WorkspacePanel
						workspace={WORKSPACE}
						sessions={SESSIONS}
						selectedSessionId="session-1"
						sessionPanes={[]}
						sending={false}
						onSelectSession={onSelectSession}
						onSessionsChanged={onSessionsChanged}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		const closeAction = container.querySelector(
			'[aria-label="Close session"]',
		) as HTMLElement | null;
		expect(closeAction).not.toBeNull();

		await user.click(closeAction!);

		await waitFor(() => {
			expect(apiMocks.createSession).toHaveBeenCalledWith("workspace-1");
		});
		await waitFor(() => {
			expect(apiMocks.hideSession).toHaveBeenCalledWith("session-1");
		});
		expect(onSelectSession).toHaveBeenCalledWith("session-replacement");
		expect(onSessionsChanged).toHaveBeenCalled();
		expect(
			queryClient.getQueryData<WorkspaceDetail>(
				helmorQueryKeys.workspaceDetail("workspace-1"),
			),
		).toMatchObject({
			activeSessionId: "session-replacement",
			activeSessionTitle: "Untitled",
		});
		expect(
			queryClient.getQueryData<WorkspaceSessionSummary[]>(
				helmorQueryKeys.workspaceSessions("workspace-1"),
			),
		).toEqual([
			expect.objectContaining({
				id: "session-replacement",
				active: true,
			}),
		]);
	});

	it("wraps the empty session state in a full-size centered container", () => {
		const { container } = render(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={createHelmorQueryClient()}>
					<WorkspacePanel
						workspace={WORKSPACE}
						sessions={SESSIONS}
						selectedSessionId="session-1"
						sessionPanes={[
							{
								sessionId: "session-1",
								messages: [],
								sending: false,
								hasLoaded: true,
								presentationState: "presented",
							},
						]}
						sending={false}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		const centeredContainer = container.querySelector(
			".conversation-scroll-viewport .justify-center",
		) as HTMLElement | null;

		expect(centeredContainer).not.toBeNull();
		expect(centeredContainer).toHaveClass(
			"flex",
			"min-h-full",
			"flex-1",
			"items-center",
			"justify-center",
			"px-8",
		);
		const heading = within(centeredContainer!).getByText("Nothing here yet");
		expect(heading.parentElement).toHaveClass(
			"flex",
			"max-w-sm",
			"flex-col",
			"items-center",
			"gap-2",
		);
	});

	it("shows a yellow dot for sessions waiting on user interaction", () => {
		const sessions = [
			SESSIONS[0],
			{
				...SESSIONS[0],
				id: "session-2",
				title: "Session 2",
				active: false,
				unreadCount: 3,
			},
		];

		render(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={createHelmorQueryClient()}>
					<WorkspacePanel
						workspace={WORKSPACE}
						sessions={sessions}
						selectedSessionId="session-1"
						sessionPanes={[]}
						sending={false}
						interactionRequiredSessionIds={new Set(["session-2"])}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		const tab = screen.getByRole("tab", { name: /Session 2/i });
		expect(
			within(tab).getByLabelText("Interaction required"),
		).toBeInTheDocument();
		expect(within(tab).queryByLabelText("Unread session")).toBeNull();
	});

	it("keeps the yellow dot visible on the selected session while interaction is pending", () => {
		render(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={createHelmorQueryClient()}>
					<WorkspacePanel
						workspace={WORKSPACE}
						sessions={SESSIONS}
						selectedSessionId="session-1"
						sessionPanes={[]}
						sending={false}
						interactionRequiredSessionIds={new Set(["session-1"])}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		const selectedTabs = screen.getAllByRole("tab", { name: /Session 1/i });
		expect(
			selectedTabs.some(
				(tab) => within(tab).queryByLabelText("Interaction required") !== null,
			),
		).toBe(true);
	});

	it("shows the Helmor thinking indicator for the active sending session", () => {
		render(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={createHelmorQueryClient()}>
					<WorkspacePanel
						workspace={WORKSPACE}
						sessions={SESSIONS}
						selectedSessionId="session-1"
						sessionPanes={[]}
						sending
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		const activeSessions = screen.getAllByRole("tab", { name: "Session 1" });
		expect(
			activeSessions.some(
				(tab) =>
					tab.querySelector('[data-slot="helmor-thinking-indicator"]') !== null,
			),
		).toBe(true);
	});

	it("keeps each tab icon aligned with that session's composer selection", () => {
		const sessions = [
			{
				...SESSIONS[0],
				agentType: "codex",
			},
			{
				...SESSIONS[0],
				id: "session-2",
				title: "Session 2",
				agentType: "claude",
				active: false,
			},
		];

		render(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={createHelmorQueryClient()}>
					<WorkspacePanel
						workspace={WORKSPACE}
						sessions={sessions}
						selectedSessionId="session-2"
						sessionPanes={[]}
						sending={false}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		const session1Tab = screen
			.getAllByRole("tab", { name: /Session 1/i })
			.find((tab) => within(tab).queryByTestId("codex-icon") !== null);
		const session2Tab = screen
			.getAllByRole("tab", { name: /Session 2/i })
			.find((tab) => within(tab).queryByTestId("claude-icon") !== null);

		expect(session1Tab).toBeDefined();
		expect(session2Tab).toBeDefined();
		expect(within(session1Tab!).getByTestId("codex-icon")).toBeInTheDocument();
		expect(within(session2Tab!).getByTestId("claude-icon")).toBeInTheDocument();
	});
});
