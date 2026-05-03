import { cleanup, render, screen } from "@testing-library/react";
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
	createWorkspaceFromRepo: vi.fn(),
	prepareWorkspaceFromRepo: vi.fn(),
	finalizeWorkspaceFromRepo: vi.fn(),
	listSessionDrafts: vi.fn(),
}));

const createRuntime = vi.hoisted(() => ({
	created: false,
	workspaceId: null as string | null,
	sessionId: null as string | null,
}));

vi.mock("./App.css", () => ({}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));

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
		createWorkspaceFromRepo: apiMocks.createWorkspaceFromRepo,
		prepareWorkspaceFromRepo: apiMocks.prepareWorkspaceFromRepo,
		finalizeWorkspaceFromRepo: apiMocks.finalizeWorkspaceFromRepo,
		listSessionDrafts: apiMocks.listSessionDrafts,
	};
});

import App from "./App";

describe("App create workspace flow", () => {
	beforeEach(() => {
		createRuntime.created = false;
		createRuntime.workspaceId = null;
		createRuntime.sessionId = null;

		apiMocks.loadWorkspaceGroups.mockReset();
		apiMocks.loadArchivedWorkspaces.mockReset();
		apiMocks.loadAgentModelSections.mockReset();
		apiMocks.loadWorkspaceDetail.mockReset();
		apiMocks.loadWorkspaceSessions.mockReset();
		apiMocks.loadSessionThreadMessages.mockReset();
		apiMocks.loadRepoScripts.mockReset();
		apiMocks.loadRepoScripts.mockResolvedValue({
			setupScript: null,
			runScript: null,
			archiveScript: null,
			setupFromProject: false,
			runFromProject: false,
			archiveFromProject: false,
			autoRunSetup: true,
		});
		apiMocks.listRepositories.mockReset();
		apiMocks.createWorkspaceFromRepo.mockReset();
		apiMocks.listSessionDrafts.mockReset();
		apiMocks.listSessionDrafts.mockResolvedValue([]);

		apiMocks.listRepositories.mockResolvedValue([
			{
				id: "repo-1",
				name: "dosu-cli",
				defaultBranch: "main",
				repoInitials: "DC",
			},
		]);
		apiMocks.loadWorkspaceGroups.mockImplementation(async () => [
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows:
					createRuntime.created && createRuntime.workspaceId
						? [
								{
									id: "workspace-existing",
									title: "Existing workspace",
									repoName: "helmor-core",
									state: "ready",
								},
								{
									id: createRuntime.workspaceId,
									title: "Acamar",
									directoryName: "acamar",
									repoName: "dosu-cli",
									state: "ready",
								},
							]
						: [
								{
									id: "workspace-existing",
									title: "Existing workspace",
									repoName: "helmor-core",
									state: "ready",
								},
							],
			},
		]);
		apiMocks.loadArchivedWorkspaces.mockResolvedValue([]);
		apiMocks.loadAgentModelSections.mockResolvedValue([]);
		apiMocks.loadWorkspaceDetail.mockImplementation(
			async (workspaceId: string) => {
				if (
					createRuntime.workspaceId &&
					workspaceId === createRuntime.workspaceId
				) {
					return {
						id: workspaceId,
						title: "Acamar",
						repoId: "repo-1",
						repoName: "dosu-cli",
						directoryName: "acamar",
						state: "ready",
						hasUnread: false,
						workspaceUnread: 0,
						unreadSessionCount: 0,
						status: "in-progress",
						activeSessionId: createRuntime.sessionId,
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
				}

				return {
					id: "workspace-existing",
					title: "Existing workspace",
					repoId: "repo-existing",
					repoName: "helmor-core",
					directoryName: "existing-workspace",
					state: "ready",
					hasUnread: false,
					workspaceUnread: 0,
					unreadSessionCount: 0,
					status: "in-progress",
					activeSessionId: "session-existing",
					activeSessionTitle: "Untitled",
					activeSessionAgentType: "claude",
					activeSessionStatus: "idle",
					branch: "main",
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
					createRuntime.workspaceId &&
					workspaceId === createRuntime.workspaceId &&
					createRuntime.sessionId
				) {
					return [
						{
							id: createRuntime.sessionId,
							workspaceId,
							title: "Untitled",
							agentType: "claude",
							status: "idle",
							model: "opus",
							permissionMode: "default",
							providerSessionId: null,
							unreadCount: 0,
							codexThinkingLevel: null,
							fastMode: false,
							createdAt: "2026-04-03T00:00:00Z",
							updatedAt: "2026-04-03T00:00:00Z",
							lastUserMessageAt: null,
							isHidden: false,
							active: true,
						},
					];
				}

				return [
					{
						id: "session-existing",
						workspaceId: "workspace-existing",
						title: "Untitled",
						agentType: "claude",
						status: "idle",
						model: "opus",
						permissionMode: "default",
						providerSessionId: null,
						unreadCount: 0,
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
		apiMocks.loadSessionThreadMessages.mockResolvedValue([]);
		apiMocks.prepareWorkspaceFromRepo.mockReset();
		apiMocks.finalizeWorkspaceFromRepo.mockReset();
		apiMocks.prepareWorkspaceFromRepo.mockImplementation(async () => {
			// Backend generates the ids now. Mirror by generating once per
			// call and stashing for subsequent finalize + detail mocks.
			createRuntime.workspaceId = crypto.randomUUID();
			createRuntime.sessionId = crypto.randomUUID();
			return {
				workspaceId: createRuntime.workspaceId,
				initialSessionId: createRuntime.sessionId,
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
		apiMocks.finalizeWorkspaceFromRepo.mockImplementation(async () => {
			createRuntime.created = true;
			return {
				workspaceId: createRuntime.workspaceId!,
				finalState: "ready",
			};
		});
		// Combined create path is unused under the prepare/finalize flow —
		// still mock it so accidental calls surface clearly in test output.
		apiMocks.createWorkspaceFromRepo.mockImplementation(async () => {
			throw new Error(
				"createWorkspaceFromRepo should not be called under prepare/finalize flow",
			);
		});
	});

	afterEach(() => {
		cleanup();
	});

	it("opens the start composer from the new workspace button", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });

		render(<App />);
		await screen.findByRole("main", { name: "Application shell" });

		await user.click(screen.getByRole("button", { name: "New workspace" }));

		expect(await screen.findByLabelText("Workspace input")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start now" })).toBeDisabled();
		expect(apiMocks.prepareWorkspaceFromRepo).not.toHaveBeenCalled();
	});
});
