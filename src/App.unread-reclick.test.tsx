// Regression test for the `workspaceReselectTick` mechanism: clicking the
// already-selected workspace row (after a manual "Mark as unread") must
// re-trigger the mark-session-read effect and clear the green dot. The
// early-return branch in handleSelectWorkspace previously swallowed this
// case, leaving the dot stuck.
//
// Mirrors the mock pattern from App.unread.test.tsx (unread mocks).

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
	loadWorkspaceGroups: vi.fn(),
	loadArchivedWorkspaces: vi.fn(),
	loadAgentModelSections: vi.fn(),
	loadWorkspaceDetail: vi.fn(),
	loadWorkspaceSessions: vi.fn(),
	loadSessionThreadMessages: vi.fn(),
	loadRepoScripts: vi.fn(),
	listRepositories: vi.fn(),
	listSessionDrafts: vi.fn(),
	getClaudeRateLimits: vi.fn(),
	prepareWorkspaceFromRepo: vi.fn(),
	finalizeWorkspaceFromRepo: vi.fn(),
	markSessionRead: vi.fn(),
	markSessionUnread: vi.fn(),
	markWorkspaceUnread: vi.fn(),
}));

const runtime = vi.hoisted(() => ({
	createdWorkspaceId: null as string | null,
	createdSessionId: null as string | null,
	// Unread state for the CREATED workspace (the one under test).
	workspaceUnread: 0,
	sessionUnreadCount: 0,
}));

vi.mock("./App.css", () => ({}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("./lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./lib/api")>();
	return {
		...actual,
		loadWorkspaceGroups: apiMocks.loadWorkspaceGroups,
		loadArchivedWorkspaces: apiMocks.loadArchivedWorkspaces,
		loadAgentModelSections: apiMocks.loadAgentModelSections,
		loadWorkspaceDetail: apiMocks.loadWorkspaceDetail,
		loadWorkspaceSessions: apiMocks.loadWorkspaceSessions,
		loadSessionMessages: apiMocks.loadSessionThreadMessages,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
		loadRepoScripts: apiMocks.loadRepoScripts,
		listRepositories: apiMocks.listRepositories,
		listSessionDrafts: apiMocks.listSessionDrafts,
		getClaudeRateLimits: apiMocks.getClaudeRateLimits,
		prepareWorkspaceFromRepo: apiMocks.prepareWorkspaceFromRepo,
		finalizeWorkspaceFromRepo: apiMocks.finalizeWorkspaceFromRepo,
		markSessionRead: apiMocks.markSessionRead,
		markSessionUnread: apiMocks.markSessionUnread,
		markWorkspaceUnread: apiMocks.markWorkspaceUnread,
	};
});

import App from "./App";

describe("App unread — re-click selected workspace clears dot", () => {
	beforeEach(() => {
		runtime.createdWorkspaceId = null;
		runtime.createdSessionId = null;
		runtime.workspaceUnread = 0;
		runtime.sessionUnreadCount = 0;

		for (const mock of Object.values(apiMocks)) {
			mock.mockReset();
		}

		apiMocks.listRepositories.mockResolvedValue([
			{
				id: "repo-1",
				name: "dosu-cli",
				defaultBranch: "main",
				repoInitials: "DC",
			},
		]);
		apiMocks.loadArchivedWorkspaces.mockResolvedValue([]);
		apiMocks.loadAgentModelSections.mockResolvedValue([]);
		apiMocks.loadSessionThreadMessages.mockResolvedValue([]);
		apiMocks.listSessionDrafts.mockResolvedValue([]);
		apiMocks.getClaudeRateLimits.mockResolvedValue(null);
		apiMocks.loadRepoScripts.mockResolvedValue({
			setupScript: null,
			runScript: null,
			archiveScript: null,
			setupFromProject: false,
			runFromProject: false,
			archiveFromProject: false,
			autoRunSetup: true,
		});

		// Before create: empty sidebar.
		// After create: sidebar shows the created workspace, with hasUnread
		// derived from runtime (so "mark unread" flips the dot via refetch).
		apiMocks.loadWorkspaceGroups.mockImplementation(async () => {
			if (!runtime.createdWorkspaceId) {
				return [];
			}
			const hasUnread =
				runtime.workspaceUnread > 0 || runtime.sessionUnreadCount > 0;
			return [
				{
					id: "progress",
					label: "In progress",
					tone: "progress",
					rows: [
						{
							id: runtime.createdWorkspaceId,
							title: "Acamar",
							directoryName: "acamar",
							repoName: "dosu-cli",
							state: "ready",
							hasUnread,
							workspaceUnread: runtime.workspaceUnread,
							unreadSessionCount: runtime.sessionUnreadCount > 0 ? 1 : 0,
							activeSessionId: runtime.createdSessionId,
							activeSessionTitle: "Untitled",
							activeSessionAgentType: "claude",
							activeSessionStatus: "idle",
							branch: "testuser/acamar",
							status: "in-progress",
							sessionCount: 1,
							messageCount: 0,
						},
					],
				},
			];
		});

		apiMocks.loadWorkspaceDetail.mockImplementation(
			async (workspaceId: string) => {
				const hasUnread =
					runtime.workspaceUnread > 0 || runtime.sessionUnreadCount > 0;
				return {
					id: workspaceId,
					title: "Acamar",
					repoId: "repo-1",
					repoName: "dosu-cli",
					directoryName: "acamar",
					state: "ready",
					hasUnread,
					workspaceUnread: runtime.workspaceUnread,
					unreadSessionCount: runtime.sessionUnreadCount > 0 ? 1 : 0,
					status: "in-progress",
					activeSessionId: runtime.createdSessionId,
					activeSessionTitle: "Untitled",
					activeSessionAgentType: "claude",
					activeSessionStatus: "idle",
					branch: "testuser/acamar",
					initializationParentBranch: "main",
					intendedTargetBranch: "main",
					pinnedAt: null,
					prTitle: null,
					archiveCommit: null,
					sessionCount: 1,
					messageCount: 0,
				};
			},
		);

		apiMocks.loadWorkspaceSessions.mockImplementation(
			async (workspaceId: string) => {
				if (
					!runtime.createdSessionId ||
					workspaceId !== runtime.createdWorkspaceId
				) {
					return [];
				}
				return [
					{
						id: runtime.createdSessionId,
						workspaceId,
						title: "Untitled",
						agentType: "claude",
						status: "idle",
						model: "opus",
						permissionMode: "default",
						providerSessionId: null,
						unreadCount: runtime.sessionUnreadCount,
						codexThinkingLevel: null,
						fastMode: false,
						createdAt: "2026-04-03T00:00:00Z",
						updatedAt: "2026-04-03T00:00:00Z",
						lastUserMessageAt: null,
						isHidden: false,
						active: true,
					},
				];
			},
		);

		apiMocks.prepareWorkspaceFromRepo.mockImplementation(async () => {
			runtime.createdWorkspaceId = "ws-acamar";
			runtime.createdSessionId = "session-acamar";
			return {
				workspaceId: runtime.createdWorkspaceId,
				initialSessionId: runtime.createdSessionId,
				repoId: "repo-1",
				repoName: "dosu-cli",
				directoryName: "acamar",
				branch: "testuser/acamar",
				defaultBranch: "main",
				state: "initializing",
				repoScripts: {
					setupScript: null,
					runScript: null,
					archiveScript: null,
					setupFromProject: false,
					runFromProject: false,
					archiveFromProject: false,
				},
			};
		});
		apiMocks.finalizeWorkspaceFromRepo.mockImplementation(async () => ({
			workspaceId: runtime.createdWorkspaceId!,
			finalState: "ready",
		}));

		// Unread IPC mocks — mirror the backend contract. Only affects the
		// CREATED workspace (A); calls scoped to other sessions must NOT
		// touch runtime, otherwise we model the backend incorrectly.
		apiMocks.markSessionRead.mockImplementation(async (sessionId: unknown) => {
			if (sessionId !== runtime.createdSessionId) return;
			runtime.sessionUnreadCount = 0;
			if (runtime.sessionUnreadCount === 0) {
				runtime.workspaceUnread = 0;
			}
		});
		apiMocks.markSessionUnread.mockImplementation(
			async (sessionId: unknown) => {
				if (sessionId !== runtime.createdSessionId) return;
				runtime.sessionUnreadCount = 1;
			},
		);
		apiMocks.markWorkspaceUnread.mockImplementation(
			async (workspaceId: unknown) => {
				if (workspaceId !== runtime.createdWorkspaceId) return;
				runtime.workspaceUnread = 1;
			},
		);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("re-clicking the currently-selected workspace after mark-unread clears the dot immediately", async () => {
		// Regression guard for the `workspaceReselectTick` mechanism in
		// App.tsx's handleSelectWorkspace. Before the fix, clicking the
		// already-selected workspace hit the early return and never
		// re-triggered the mark-session-read effect, so the green dot stayed.
		const user = userEvent.setup();
		runtime.createdWorkspaceId = "ws-acamar";
		runtime.createdSessionId = "session-acamar";

		render(<App />);
		await screen.findByRole("main", { name: "Application shell" });

		const findRow = () =>
			document.querySelector(
				`[data-workspace-row-id="${runtime.createdWorkspaceId}"]`,
			) as HTMLElement | null;
		await waitFor(() => expect(findRow()).not.toBeNull());
		await waitFor(() => {
			expect(apiMocks.markSessionRead).toHaveBeenCalledWith("session-acamar");
		});

		// Mark the (already-selected) workspace unread via context menu.
		const row = findRow()!;
		fireEvent.contextMenu(row);
		await user.click(
			await screen.findByRole("menuitem", { name: /Mark as unread/i }),
		);
		await waitFor(() => {
			expect(findRow()?.getAttribute("data-has-unread")).toBe("true");
		});

		// Re-click the same workspace row. The tick fix must flush through
		// immediately — no waitFor tolerated.
		await user.click(row);
		expect(findRow()?.getAttribute("data-has-unread")).toBe("false");
	});
});
