import { invoke } from "@tauri-apps/api/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDetail } from "./lib/api";

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
	getSessionContextUsage: vi.fn(),
	getCodexRateLimits: vi.fn(),
	loadRepoScripts: vi.fn(),
	getWorkspaceForge: vi.fn(),
	refreshWorkspaceChangeRequest: vi.fn(),
	loadWorkspaceForgeActionStatus: vi.fn(),
	stopAgentStream: vi.fn(),
	requestQuit: vi.fn(),
}));

const eventApiMocks = vi.hoisted(() => ({
	handlers: new Map<string, Set<() => void>>(),
	listen: vi.fn(async (eventName: string, handler: () => void) => {
		let handlers = eventApiMocks.handlers.get(eventName);
		if (!handlers) {
			handlers = new Set();
			eventApiMocks.handlers.set(eventName, handlers);
		}
		handlers.add(handler);
		return () => {
			const currentHandlers = eventApiMocks.handlers.get(eventName);
			currentHandlers?.delete(handler);
			if (currentHandlers?.size === 0) {
				eventApiMocks.handlers.delete(eventName);
			}
		};
	}),
}));

vi.mock("./App.css", () => ({}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));
// Helmor is macOS-only; `./lib/platform` already returns `isMac: () => true`
// unconditionally. No mock needed, but keep this vi.mock stub to document the
// shortcut suite's dependency on that assumption.
vi.mock("./lib/platform", () => ({
	isMac: () => true,
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		setBadgeCount: vi.fn(async () => {}),
	}),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: eventApiMocks.listen,
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
		getSessionContextUsage: apiMocks.getSessionContextUsage,
		getCodexRateLimits: apiMocks.getCodexRateLimits,
		loadRepoScripts: apiMocks.loadRepoScripts,
		getWorkspaceForge: apiMocks.getWorkspaceForge,
		refreshWorkspaceChangeRequest: apiMocks.refreshWorkspaceChangeRequest,
		loadWorkspaceForgeActionStatus: apiMocks.loadWorkspaceForgeActionStatus,
		requestQuit: apiMocks.requestQuit,
		stopAgentStream: apiMocks.stopAgentStream,
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

function createWorkspaceDetail(
	workspaceId: WorkspaceFixtureId,
): WorkspaceDetail {
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
		unreadSessionCount: 0,
		status: archived ? "done" : "in-progress",
		activeSessionId: primarySession?.id ?? null,
		activeSessionTitle: primarySession?.title ?? null,
		activeSessionAgentType: "claude",
		activeSessionStatus: primarySession ? "idle" : null,
		branch: archived ? "archive/main" : "main",
		initializationParentBranch: "main",
		intendedTargetBranch: "main",
		pinnedAt: null,
		prTitle: null,
		archiveCommit: null,
		sessionCount: sessions.length,
		messageCount: 0,
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
		codexThinkingLevel: null,
		fastMode: false,
		createdAt: "2026-04-05T00:00:00Z",
		updatedAt: session.updatedAt ?? "2026-04-05T00:00:00Z",
		lastUserMessageAt: null,
		isHidden: false,
		actionKind: session.actionKind ?? null,
		active: session.active,
	}));
}

const UNKNOWN_FORGE_DETECTION = {
	provider: "unknown",
	host: null,
	namespace: null,
	repo: null,
	remoteUrl: null,
	labels: {
		providerName: "Forge",
		cliName: "CLI",
		changeRequestName: "PR",
		changeRequestFullName: "change request",
	},
	cli: null,
	detectionSignals: [],
};

const UNAVAILABLE_FORGE_ACTION_STATUS = {
	changeRequest: null,
	reviewDecision: null,
	mergeable: null,
	deployments: [],
	checks: [],
	remoteState: "unavailable",
	message: null,
};

const EMPTY_REPO_SCRIPTS = {
	setupScript: null,
	runScript: null,
	archiveScript: null,
	setupFromProject: false,
	runFromProject: false,
	archiveFromProject: false,
	autoRunSetup: true,
};

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

function getSessionCloseButton(title: string) {
	const closeButton = getSessionTab(title).querySelector(
		'[aria-label="Close session"]',
	);

	if (!closeButton) {
		throw new Error(`Unable to find close button for "${title}".`);
	}

	return closeButton as HTMLElement;
}

function expectSelectedWorkspace(title: string) {
	expect(screen.getByRole("button", { name: title })).toHaveClass(
		"workspace-row-selected",
	);
}

const NAV_ARROW_BY_LEGACY_KEY = {
	h: "ArrowUp", // workspace.previous
	l: "ArrowDown", // workspace.next
	k: "ArrowLeft", // session.previous
	j: "ArrowRight", // session.next
} as const;

function pressGlobalShortcut(
	key: "h" | "j" | "k" | "l",
	options?: Parameters<typeof fireEvent.keyDown>[1],
) {
	const arrow = NAV_ARROW_BY_LEGACY_KEY[key];
	fireEvent.keyDown(window, {
		key: arrow,
		code: arrow,
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

function emitTauriEvent(eventName: string) {
	const handlers = eventApiMocks.handlers.get(eventName);
	if (!handlers) {
		return;
	}

	for (const handler of handlers) {
		handler();
	}
}

async function renderAppReady(expectedSessionTitle = "Done session 1") {
	render(<App />);

	// 5s — initial App mount runs many queries; the default 1s flakes under load.
	await waitFor(
		() => {
			expectSelectedWorkspace("Done workspace");
			expectSelectedSession(expectedSessionTitle);
		},
		{ timeout: 5000 },
	);
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
		apiMocks.getSessionContextUsage.mockReset();
		apiMocks.getCodexRateLimits.mockReset();
		apiMocks.loadRepoScripts.mockReset();
		apiMocks.getWorkspaceForge.mockReset();
		apiMocks.refreshWorkspaceChangeRequest.mockReset();
		apiMocks.loadWorkspaceForgeActionStatus.mockReset();
		apiMocks.stopAgentStream.mockReset();
		eventApiMocks.listen.mockClear();
		eventApiMocks.handlers.clear();
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
				unreadSessionCount: 0,
				status: "done",
				branch: "archive/main",
				activeSessionId: "session-archived-1",
				activeSessionTitle: "Archived session 1",
				activeSessionAgentType: "claude",
				activeSessionStatus: "idle",
				prTitle: null,
				sessionCount: 1,
				messageCount: 0,
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
				unreadSessionCount: 0,
				status: "done",
				branch: "archive/main",
				activeSessionId: "session-archived-2",
				activeSessionTitle: "Archived session 2",
				activeSessionAgentType: "claude",
				activeSessionStatus: "idle",
				prTitle: null,
				sessionCount: 1,
				messageCount: 0,
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
		apiMocks.getSessionContextUsage.mockResolvedValue(null);
		apiMocks.getCodexRateLimits.mockResolvedValue(null);
		apiMocks.loadRepoScripts.mockResolvedValue(EMPTY_REPO_SCRIPTS);
		apiMocks.getWorkspaceForge.mockResolvedValue(UNKNOWN_FORGE_DETECTION);
		apiMocks.refreshWorkspaceChangeRequest.mockResolvedValue(null);
		apiMocks.loadWorkspaceForgeActionStatus.mockResolvedValue(
			UNAVAILABLE_FORGE_ACTION_STATUS,
		);
		apiMocks.stopAgentStream.mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
	});

	it("selects the next session on Option+Command+Right", async () => {
		await renderAppReady();

		pressGlobalShortcut("j");

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

		pressGlobalShortcut("j");

		await waitFor(() => {
			expectSelectedSession("Done session 3");
		});

		pressGlobalShortcut("j");

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

	it("opens the new workspace picker on Command+N", async () => {
		await renderAppReady();

		fireEvent.keyDown(window, {
			key: "n",
			code: "KeyN",
			metaKey: true,
		});

		await screen.findByRole("dialog");
	});

	it("opens the add repository menu on Command+Shift+N", async () => {
		await renderAppReady();

		fireEvent.keyDown(window, {
			key: "n",
			code: "KeyN",
			metaKey: true,
			shiftKey: true,
		});

		await screen.findByRole("menuitem", { name: /Open project/i });
	});

	it("does not wrap session navigation on Option+Command+Left from the first session", async () => {
		await renderAppReady();

		pressGlobalShortcut("k");

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

		pressGlobalShortcut("l");

		await waitFor(() => {
			expectSelectedWorkspace("Review workspace");
			expectSelectedSession("Review session 1");
		});
	});

	it("does not wrap workspace navigation on Option+Command+Up from the first workspace", async () => {
		await renderAppReady();

		pressGlobalShortcut("h");

		await waitFor(() => {
			expectSelectedWorkspace("Done workspace");
			expectSelectedSession("Done session 1");
		});
		// Assert via UI rather than the `loadWorkspaceDetail` mock: the app
		// warms non-selected workspace details in the background (see the
		// warming effect in App.tsx), so the mock can be called with
		// `workspace-review` on slow CI runners regardless of whether
		// ArrowUp actually wrapped. Checking the sidebar selection is the
		// assertion we actually care about.
		expect(
			screen.getByRole("button", { name: "Review workspace" }),
		).not.toHaveClass("workspace-row-selected");
	});

	it("navigates through archived workspaces after the active workspace list even while Archived stays collapsed", async () => {
		await renderAppReady();

		pressGlobalShortcut("l");
		await waitFor(() => {
			expectSelectedSession("Review session 1");
		});

		pressGlobalShortcut("l");
		await waitFor(() => {
			expectSelectedSession("Progress session 1");
		});

		pressGlobalShortcut("l");
		await waitFor(() => {
			expectSelectedSession("Archived session 1");
		});

		pressGlobalShortcut("l");
		await waitFor(() => {
			expectSelectedSession("Archived session 2");
		});

		pressGlobalShortcut("h");
		await waitFor(() => {
			expectSelectedSession("Archived session 1");
		});

		pressGlobalShortcut("h");
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
			code: "ArrowRight",
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
		await screen.findByRole("dialog");
		const repositoryPicker = await screen.findByRole("listbox", {
			name: "Suggestions",
		});
		// Picker focus is moved on the rAF after `onOpenAutoFocus`. Under load
		// from prior tests the rAF can land after the synchronous assertion,
		// so wait for it.
		await waitFor(() => {
			expect(repositoryPicker).toHaveFocus();
		});

		fireEvent.keyDown(repositoryPicker, {
			key: "ArrowDown",
			code: "ArrowDown",
			metaKey: true,
			altKey: true,
		});

		await waitFor(() => {
			expectSelectedWorkspace("Review workspace");
			expectSelectedSession("Review session 1");
		});
	});

	it("only responds to the exact Option shortcut combination", async () => {
		await renderAppReady();

		fireEvent.keyDown(window, {
			key: "l",
			code: "KeyL",
			metaKey: true,
		});
		fireEvent.keyDown(window, {
			key: "l",
			code: "KeyL",
		});
		fireEvent.keyDown(window, {
			key: "l",
			code: "KeyL",
			altKey: true,
			shiftKey: true,
		});
		// Strict OS-aware binding: on macOS ctrlKey is the "wrong" modifier
		// and must reject the shortcut. Restored original pre-Phase-3 assertion.
		fireEvent.keyDown(window, {
			key: "l",
			code: "KeyL",
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

	it("closes the current session on Command+W", async () => {
		await renderAppReady();

		fireEvent.keyDown(window, {
			key: "w",
			metaKey: true,
		});

		await waitFor(() => {
			expectSelectedSession("Done session 2");
		});
		expect(apiMocks.hideSession).toHaveBeenCalledWith("session-done-1");
		expect(apiMocks.deleteSession).not.toHaveBeenCalled();
	});

	it("selects the right session after closing a middle session", async () => {
		runtimeSessionFixtures[WORKSPACE_IDS.done] = [
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
			{
				id: "session-done-3",
				title: "Done session 3",
				active: false,
			},
		];

		await renderAppReady();
		await userEvent.click(getSessionTab("Done session 2"));
		await waitFor(() => {
			expectSelectedSession("Done session 2");
		});

		fireEvent.keyDown(window, {
			key: "w",
			metaKey: true,
		});

		await waitFor(() => {
			expectSelectedSession("Done session 3");
		});
		expect(apiMocks.hideSession).toHaveBeenCalledWith("session-done-2");
	});

	it("selects the left session after closing the rightmost session", async () => {
		runtimeSessionFixtures[WORKSPACE_IDS.done] = [
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
			{
				id: "session-done-3",
				title: "Done session 3",
				active: false,
			},
		];

		await renderAppReady();
		await userEvent.click(getSessionTab("Done session 3"));
		await waitFor(() => {
			expectSelectedSession("Done session 3");
		});

		fireEvent.keyDown(window, {
			key: "w",
			metaKey: true,
		});

		await waitFor(() => {
			expectSelectedSession("Done session 2");
		});
		expect(apiMocks.hideSession).toHaveBeenCalledWith("session-done-3");
	});

	it("keeps the active session when closing an inactive session tab", async () => {
		runtimeSessionFixtures[WORKSPACE_IDS.done] = [
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
			{
				id: "session-done-3",
				title: "Done session 3",
				active: false,
			},
		];

		await renderAppReady();
		await userEvent.click(getSessionCloseButton("Done session 2"));

		await waitFor(() => {
			expect(apiMocks.hideSession).toHaveBeenCalledWith("session-done-2");
		});
		expectSelectedSession("Done session 1");
	});

	it("quits silently on a Rust-emitted quit-requested event when nothing is in flight", async () => {
		apiMocks.requestQuit.mockReset();
		await renderAppReady();

		emitTauriEvent("helmor://quit-requested");

		await waitFor(() => {
			expect(apiMocks.requestQuit).toHaveBeenCalledWith(false);
		});
	});

	it("quits from onboarding when Rust emits quit-requested", async () => {
		const invokeMock = vi.mocked(invoke);
		const baseInvokeImpl = invokeMock.getMockImplementation();
		invokeMock.mockImplementation(
			async (command: string, ...args: unknown[]) => {
				if (command === "get_app_settings") {
					return {
						"app.onboarding_completed": "false",
					};
				}
				return baseInvokeImpl?.(command, args[0] as undefined);
			},
		);

		try {
			apiMocks.requestQuit.mockReset();
			render(<App />);
			await screen.findByLabelText("Helmor onboarding");

			emitTauriEvent("helmor://quit-requested");

			await waitFor(() => {
				expect(apiMocks.requestQuit).toHaveBeenCalledWith(false);
			});
		} finally {
			invokeMock.mockImplementation(baseInvokeImpl ?? (async () => undefined));
		}
	});

	it("closes the current session when macOS emits the close-current-session event", async () => {
		await renderAppReady();

		emitTauriEvent("helmor://close-current-session");

		await waitFor(() => {
			expectSelectedSession("Done session 2");
		});
		expect(apiMocks.hideSession).toHaveBeenCalledWith("session-done-1");
		expect(apiMocks.deleteSession).not.toHaveBeenCalled();
	});

	it("prompts before closing a running session on Command+W", async () => {
		runtimeSessionFixtures[WORKSPACE_IDS.done] = [
			{
				id: "session-done-1",
				title: "Done session 1",
				active: true,
				status: "running",
			},
			{
				id: "session-done-2",
				title: "Done session 2",
				active: false,
			},
		];

		render(<App />);
		await waitFor(() => {
			expectSelectedWorkspace("Done workspace");
		});
		await userEvent.click(getSessionTab("Done session 1"));
		await waitFor(() => {
			expectSelectedSession("Done session 1");
		});

		fireEvent.keyDown(window, {
			key: "w",
			metaKey: true,
		});

		expect(await screen.findByText("Close running chat?")).toBeInTheDocument();
		expect(apiMocks.hideSession).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Close anyway" }));

		await waitFor(() => {
			expect(apiMocks.stopAgentStream).toHaveBeenCalledWith(
				"session-done-1",
				"claude",
			);
			expect(apiMocks.hideSession).toHaveBeenCalledWith("session-done-1");
		});
	});
});
