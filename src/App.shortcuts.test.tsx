import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	createSession: vi.fn(),
	deleteSession: vi.fn(),
	hideSession: vi.fn(),
	loadWorkspaceGroups: vi.fn(),
	loadArchivedWorkspaces: vi.fn(),
	loadAgentModelSections: vi.fn(),
	loadWorkspaceDetail: vi.fn(),
	loadWorkspaceSessions: vi.fn(),
	loadSessionThreadMessages: vi.fn(),
}));

const windowApiMocks = vi.hoisted(() => ({
	onCloseRequested: vi.fn(),
	closeRequestedHandler: null as
		| ((event: { preventDefault: () => void }) => void | Promise<void>)
		| null,
}));

vi.mock("./App.css", () => ({}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		onCloseRequested: windowApiMocks.onCloseRequested.mockImplementation(
			async (handler: typeof windowApiMocks.closeRequestedHandler) => {
				windowApiMocks.closeRequestedHandler = handler;
				return () => {
					if (windowApiMocks.closeRequestedHandler === handler) {
						windowApiMocks.closeRequestedHandler = null;
					}
				};
			},
		),
	}),
}));

vi.mock("./lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./lib/api")>();

	return {
		...actual,
		createSession: apiMocks.createSession,
		deleteSession: apiMocks.deleteSession,
		hideSession: apiMocks.hideSession,
		loadWorkspaceGroups: apiMocks.loadWorkspaceGroups,
		loadArchivedWorkspaces: apiMocks.loadArchivedWorkspaces,
		loadAgentModelSections: apiMocks.loadAgentModelSections,
		loadWorkspaceDetail: apiMocks.loadWorkspaceDetail,
		loadWorkspaceSessions: apiMocks.loadWorkspaceSessions,
		loadSessionMessages: apiMocks.loadSessionThreadMessages,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
		requestQuit: vi.fn(),
	};
});

import App from "./App";

const WORKSPACE_IDS = {
	done: "workspace-done",
	review: "workspace-review",
	progress: "workspace-progress",
	archived1: "workspace-archived-1",
	archived2: "workspace-archived-2",
} as const;

type WorkspaceFixtureId = (typeof WORKSPACE_IDS)[keyof typeof WORKSPACE_IDS];
type SessionFixture = {
	id: string;
	title: string;
	active: boolean;
	status?: string;
	unreadCount?: number;
	updatedAt?: string;
	actionKind?: string | null;
};

const SESSION_FIXTURES: Record<WorkspaceFixtureId, readonly SessionFixture[]> =
	{
		[WORKSPACE_IDS.done]: [
			{
				id: "session-done-1",
				title: "Done session 1",
				active: true,
			},
			{
				id: "session-done-2",
				title: "Done session 2",
				active: false,
			},
		],
		[WORKSPACE_IDS.review]: [
			{
				id: "session-review-1",
				title: "Review session 1",
				active: true,
			},
		],
		[WORKSPACE_IDS.progress]: [
			{
				id: "session-progress-1",
				title: "Progress session 1",
				active: true,
			},
		],
		[WORKSPACE_IDS.archived1]: [
			{
				id: "session-archived-1",
				title: "Archived session 1",
				active: true,
			},
		],
		[WORKSPACE_IDS.archived2]: [
			{
				id: "session-archived-2",
				title: "Archived session 2",
				active: true,
			},
		],
	};

let runtimeSessionFixtures: Record<WorkspaceFixtureId, SessionFixture[]> =
	createRuntimeSessionFixtures();

function createRuntimeSessionFixtures(): Record<
	WorkspaceFixtureId,
	SessionFixture[]
> {
	return Object.fromEntries(
		Object.entries(SESSION_FIXTURES).map(([workspaceId, sessions]) => [
			workspaceId,
			sessions.map((session) => ({ ...session })),
		]),
	) as Record<WorkspaceFixtureId, SessionFixture[]>;
}

function addSessionFixture(workspaceId: WorkspaceFixtureId, sessionId: string) {
	runtimeSessionFixtures[workspaceId] = [
		...runtimeSessionFixtures[workspaceId].map((session) => ({
			...session,
			active: false,
		})),
		{
			id: sessionId,
			title: "Untitled",
			active: true,
		},
	];
}

function closeSessionFixture(sessionId: string): WorkspaceFixtureId | null {
	for (const workspaceId of Object.keys(
		runtimeSessionFixtures,
	) as WorkspaceFixtureId[]) {
		const sessions = runtimeSessionFixtures[workspaceId];
		const removedIndex = sessions.findIndex(
			(session) => session.id === sessionId,
		);
		if (removedIndex === -1) {
			continue;
		}

		const removedWasActive = sessions[removedIndex]?.active ?? false;
		const remainingSessions = sessions.filter(
			(session) => session.id !== sessionId,
		);
		const nextActiveId =
			remainingSessions.length === 0
				? null
				: removedWasActive
					? ((
							remainingSessions[removedIndex] ??
							remainingSessions[removedIndex - 1] ??
							remainingSessions[0]
						)?.id ?? null)
					: ((
							remainingSessions.find((session) => session.active) ??
							remainingSessions[0]
						)?.id ?? null);

		runtimeSessionFixtures[workspaceId] = remainingSessions.map((session) => ({
			...session,
			active: session.id === nextActiveId,
		}));

		return workspaceId;
	}

	return null;
}

function createWorkspaceDetail(workspaceId: WorkspaceFixtureId) {
	const sessions = runtimeSessionFixtures[workspaceId];
	const primarySession =
		sessions.find((session) => session.active) ?? sessions[0];
	const archived = workspaceId.startsWith("workspace-archived");

	return {
		id: workspaceId,
		title: workspaceId,
		repoId: `repo-${workspaceId}`,
		repoName: "helmor",
		directoryName: workspaceId,
		state: archived ? "archived" : "ready",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: archived ? "archived" : "progress",
		manualStatus: null,
		activeSessionId: primarySession?.id ?? null,
		activeSessionTitle: primarySession?.title ?? null,
		activeSessionAgentType: "claude",
		activeSessionStatus: primarySession ? "idle" : null,
		branch: archived ? "archive/main" : "main",
		initializationParentBranch: "main",
		intendedTargetBranch: "main",
		notes: null,
		pinnedAt: null,
		prTitle: null,
		prDescription: null,
		archiveCommit: null,
		sessionCount: sessions.length,
		messageCount: 0,
		attachmentCount: 0,
	};
}

function createWorkspaceSessions(workspaceId: WorkspaceFixtureId) {
	return runtimeSessionFixtures[workspaceId].map((session) => ({
		id: session.id,
		workspaceId,
		title: session.title,
		agentType: "claude",
		status: session.status ?? "idle",
		model: "opus-1m",
		permissionMode: "default",
		providerSessionId: null,
		unreadCount: session.unreadCount ?? 0,
		contextTokenCount: 0,
		contextUsedPercent: null,
		thinkingEnabled: true,
		codexThinkingLevel: null,
		fastMode: false,
		agentPersonality: null,
		createdAt: "2026-04-05T00:00:00Z",
		updatedAt: session.updatedAt ?? "2026-04-05T00:00:00Z",
		lastUserMessageAt: null,
		resumeSessionAt: null,
		isHidden: false,
		isCompacting: false,
		actionKind: session.actionKind ?? null,
		active: session.active,
	}));
}

function getSessionTab(title: string) {
	const tab = screen.getByText(title).closest('[role="tab"]');

	if (!tab) {
		throw new Error(`Unable to find session tab for "${title}".`);
	}

	return tab;
}

function expectSelectedSession(title: string) {
	expect(getSessionTab(title)).toHaveAttribute("aria-selected", "true");
}

function expectSelectedWorkspace(title: string) {
	expect(screen.getByRole("button", { name: title })).toHaveClass("bg-accent");
}

function pressGlobalShortcut(
	key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
	options?: Parameters<typeof fireEvent.keyDown>[1],
) {
	fireEvent.keyDown(window, {
		key,
		metaKey: true,
		altKey: true,
		...options,
	});
}

function pressCreateSessionShortcut(
	options?: Parameters<typeof fireEvent.keyDown>[1],
) {
	fireEvent.keyDown(window, {
		key: "t",
		metaKey: true,
		...options,
	});
}

async function renderAppReady() {
	render(<App />);

	await waitFor(() => {
		expectSelectedWorkspace("Done workspace");
		expectSelectedSession("Done session 1");
	});
}

describe("App global navigation shortcuts", () => {
	beforeEach(() => {
		runtimeSessionFixtures = createRuntimeSessionFixtures();
		apiMocks.createSession.mockReset();
		apiMocks.deleteSession.mockReset();
		apiMocks.hideSession.mockReset();
		apiMocks.loadWorkspaceGroups.mockReset();
		apiMocks.loadArchivedWorkspaces.mockReset();
		apiMocks.loadAgentModelSections.mockReset();
		apiMocks.loadWorkspaceDetail.mockReset();
		apiMocks.loadWorkspaceSessions.mockReset();
		apiMocks.loadSessionThreadMessages.mockReset();
		windowApiMocks.onCloseRequested.mockClear();
		windowApiMocks.closeRequestedHandler = null;
		apiMocks.createSession.mockImplementation(async (workspaceId: string) => {
			const nextSessionId = `${workspaceId}-session-new`;
			addSessionFixture(workspaceId as WorkspaceFixtureId, nextSessionId);
			return { sessionId: nextSessionId };
		});
		apiMocks.deleteSession.mockImplementation(async (sessionId: string) => {
			closeSessionFixture(sessionId);
		});
		apiMocks.hideSession.mockImplementation(async (sessionId: string) => {
			closeSessionFixture(sessionId);
		});

		apiMocks.loadWorkspaceGroups.mockResolvedValue([
			{
				id: "done",
				label: "Done",
				tone: "done",
				rows: [
					{
						id: WORKSPACE_IDS.done,
						title: "Done workspace",
						repoName: "helmor",
						state: "ready",
					},
				],
			},
			{
				id: "review",
				label: "In review",
				tone: "review",
				rows: [
					{
						id: WORKSPACE_IDS.review,
						title: "Review workspace",
						repoName: "helmor",
						state: "ready",
					},
				],
			},
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
					{
						id: WORKSPACE_IDS.progress,
						title: "Progress workspace",
						repoName: "helmor",
						state: "ready",
					},
				],
			},
			{
				id: "backlog",
				label: "Backlog",
				tone: "backlog",
				rows: [],
			},
			{
				id: "canceled",
				label: "Canceled",
				tone: "canceled",
				rows: [],
			},
		]);
		apiMocks.loadArchivedWorkspaces.mockResolvedValue([
			{
				id: WORKSPACE_IDS.archived1,
				title: "Archived workspace 1",
				directoryName: "archived-workspace-1",
				repoName: "helmor",
				repoIconSrc: null,
				repoInitials: "H",
				state: "archived",
				hasUnread: false,
				workspaceUnread: 0,
				sessionUnreadTotal: 0,
				unreadSessionCount: 0,
				derivedStatus: "archived",
				manualStatus: null,
				branch: "archive/main",
				activeSessionId: "session-archived-1",
				activeSessionTitle: "Archived session 1",
				activeSessionAgentType: "claude",
				activeSessionStatus: "idle",
				prTitle: null,
				sessionCount: 1,
				messageCount: 0,
				attachmentCount: 0,
			},
			{
				id: WORKSPACE_IDS.archived2,
				title: "Archived workspace 2",
				directoryName: "archived-workspace-2",
				repoName: "helmor",
				repoIconSrc: null,
				repoInitials: "H",
				state: "archived",
				hasUnread: false,
				workspaceUnread: 0,
				sessionUnreadTotal: 0,
				unreadSessionCount: 0,
				derivedStatus: "archived",
				manualStatus: null,
				branch: "archive/main",
				activeSessionId: "session-archived-2",
				activeSessionTitle: "Archived session 2",
				activeSessionAgentType: "claude",
				activeSessionStatus: "idle",
				prTitle: null,
				sessionCount: 1,
				messageCount: 0,
				attachmentCount: 0,
			},
		]);
		apiMocks.loadAgentModelSections.mockResolvedValue([]);
		apiMocks.loadWorkspaceDetail.mockImplementation(
			async (workspaceId: string) =>
				createWorkspaceDetail(workspaceId as WorkspaceFixtureId),
		);
		apiMocks.loadWorkspaceSessions.mockImplementation(
			async (workspaceId: string) =>
				createWorkspaceSessions(workspaceId as WorkspaceFixtureId),
		);
		apiMocks.loadSessionThreadMessages.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
	});

	it("selects the next session on Option+Command+Right", async () => {
		await renderAppReady();

		pressGlobalShortcut("ArrowRight");

		await waitFor(() => {
			expectSelectedSession("Done session 2");
		});
	});

	it("navigates sessions using query order", async () => {
		runtimeSessionFixtures[WORKSPACE_IDS.done] = [
			{
				id: "session-done-1",
				title: "Done session 1",
				active: true,
				updatedAt: "2026-04-05T00:00:00Z",
			},
			{
				id: "session-done-2",
				title: "Done session 2",
				active: false,
				unreadCount: 2,
				updatedAt: "2026-04-05T00:02:00Z",
			},
			{
				id: "session-done-3",
				title: "Done session 3",
				active: false,
				status: "running",
				updatedAt: "2026-04-05T00:01:00Z",
			},
		];

		await renderAppReady();
		await userEvent.click(getSessionTab("Done session 2"));

		await waitFor(() => {
			expectSelectedSession("Done session 2");
		});

		pressGlobalShortcut("ArrowRight");

		await waitFor(() => {
			expectSelectedSession("Done session 3");
		});

		pressGlobalShortcut("ArrowRight");

		await waitFor(() => {
			expectSelectedSession("Done session 3");
		});
	});

	it("creates a new session on Command+T", async () => {
		await renderAppReady();

		apiMocks.createSession.mockImplementationOnce(
			async (workspaceId: string) => {
				addSessionFixture(
					workspaceId as WorkspaceFixtureId,
					"session-done-new",
				);
				return { sessionId: "session-done-new" };
			},
		);

		pressCreateSessionShortcut();

		await waitFor(() => {
			expect(apiMocks.createSession).toHaveBeenCalledWith(WORKSPACE_IDS.done);
			expectSelectedSession("Untitled");
		});
	});

	it("does not wrap session navigation on Option+Command+Left from the first session", async () => {
		await renderAppReady();

		pressGlobalShortcut("ArrowLeft");

		await waitFor(() => {
			expectSelectedSession("Done session 1");
		});
		expect(getSessionTab("Done session 2")).toHaveAttribute(
			"aria-selected",
			"false",
		);
	});

	it("selects the next workspace on Option+Command+Down using sidebar order", async () => {
		await renderAppReady();

		pressGlobalShortcut("ArrowDown");

		await waitFor(() => {
			expectSelectedWorkspace("Review workspace");
			expectSelectedSession("Review session 1");
		});
	});

	it("does not wrap workspace navigation on Option+Command+Up from the first workspace", async () => {
		await renderAppReady();

		pressGlobalShortcut("ArrowUp");

		await waitFor(() => {
			expectSelectedWorkspace("Done workspace");
			expectSelectedSession("Done session 1");
		});
		expect(apiMocks.loadWorkspaceDetail).not.toHaveBeenCalledWith(
			WORKSPACE_IDS.review,
		);
	});

	it("navigates through archived workspaces after the active workspace list even while Archived stays collapsed", async () => {
		await renderAppReady();

		pressGlobalShortcut("ArrowDown");
		await waitFor(() => {
			expectSelectedSession("Review session 1");
		});

		pressGlobalShortcut("ArrowDown");
		await waitFor(() => {
			expectSelectedSession("Progress session 1");
		});

		pressGlobalShortcut("ArrowDown");
		await waitFor(() => {
			expectSelectedSession("Archived session 1");
		});

		pressGlobalShortcut("ArrowDown");
		await waitFor(() => {
			expectSelectedSession("Archived session 2");
		});

		pressGlobalShortcut("ArrowUp");
		await waitFor(() => {
			expectSelectedSession("Archived session 1");
		});

		pressGlobalShortcut("ArrowUp");
		await waitFor(() => {
			expectSelectedSession("Progress session 1");
		});
	});

	it("still triggers shortcuts while focus is inside text inputs", async () => {
		const user = userEvent.setup();

		await renderAppReady();

		const composerInput = screen.getByLabelText("Workspace input");
		composerInput.focus();
		expect(composerInput).toHaveFocus();

		fireEvent.keyDown(composerInput, {
			key: "ArrowRight",
			metaKey: true,
			altKey: true,
		});

		await waitFor(() => {
			expectSelectedSession("Done session 2");
		});

		const newWorkspaceButton = screen.getByRole("button", {
			name: "New workspace",
		});
		await user.click(newWorkspaceButton);
		const repositoryPicker = await screen.findByRole("dialog");
		expect(repositoryPicker).toHaveFocus();

		fireEvent.keyDown(repositoryPicker, {
			key: "ArrowDown",
			metaKey: true,
			altKey: true,
		});

		await waitFor(() => {
			expectSelectedWorkspace("Review workspace");
			expectSelectedSession("Review session 1");
		});
	});

	it("only responds to the exact meta+alt shortcut combination", async () => {
		await renderAppReady();

		fireEvent.keyDown(window, {
			key: "ArrowRight",
			metaKey: true,
		});
		fireEvent.keyDown(window, {
			key: "ArrowRight",
			altKey: true,
		});
		fireEvent.keyDown(window, {
			key: "ArrowDown",
			metaKey: true,
			altKey: true,
			shiftKey: true,
		});
		fireEvent.keyDown(window, {
			key: "ArrowDown",
			metaKey: true,
			altKey: true,
			ctrlKey: true,
		});

		await waitFor(() => {
			expectSelectedWorkspace("Done workspace");
			expectSelectedSession("Done session 1");
		});
		expect(apiMocks.loadWorkspaceDetail).not.toHaveBeenCalledWith(
			WORKSPACE_IDS.review,
		);
		expect(apiMocks.loadSessionThreadMessages).not.toHaveBeenCalledWith(
			"session-done-2",
		);
	});

	it("closes the current session on Command+W and swallows the follow-up window close", async () => {
		await renderAppReady();

		await waitFor(() => {
			expect(windowApiMocks.closeRequestedHandler).not.toBeNull();
		});

		fireEvent.keyDown(window, {
			key: "w",
			metaKey: true,
		});

		await waitFor(() => {
			expectSelectedSession("Done session 2");
		});
		expect(apiMocks.hideSession).toHaveBeenCalledWith("session-done-1");
		expect(apiMocks.deleteSession).not.toHaveBeenCalled();

		// QuitConfirmDialog always prevents the JS-layer close.
		const preventDefault = vi.fn();
		await windowApiMocks.closeRequestedHandler?.({ preventDefault });

		expect(preventDefault).toHaveBeenCalledTimes(1);
	});
});
