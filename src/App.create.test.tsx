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
	createWorkspaceFromRepo: vi.fn(),
	prepareWorkspaceFromRepo: vi.fn(),
	finalizeWorkspaceFromRepo: vi.fn(),
	listSessionDrafts: vi.fn(),
}));

const streamingMocks = vi.hoisted(() => ({
	handleComposerSubmit: vi.fn(),
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

vi.mock("@/features/conversation/hooks/use-streaming", () => ({
	useConversationStreaming: () => ({
		activeSendError: null,
		handleComposerSubmit: streamingMocks.handleComposerSubmit,
		handleDeferredToolResponse: vi.fn(),
		handleElicitationResponse: vi.fn(),
		handlePermissionResponse: vi.fn(),
		handleStopStream: vi.fn(),
		handleSteerQueued: vi.fn(),
		handleRemoveQueued: vi.fn(),
		elicitationResponsePending: false,
		isSending: false,
		pendingElicitation: null,
		pendingDeferredTool: null,
		pendingPermissions: [],
		restoreCustomTags: [],
		restoreDraft: null,
		restoreFiles: [],
		restoreImages: [],
		restoreNonce: 0,
		activeFastPreludes: {},
		sendingSessionIds: new Set(),
	}),
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

function commitComposerText(editor: HTMLElement, text: string) {
	const paragraph = editor.querySelector("p");
	if (!paragraph) {
		throw new Error("Composer paragraph element not found.");
	}
	fireEvent.compositionStart(editor, { data: "" });
	paragraph.textContent = text;
	const textNode = paragraph.firstChild;
	if (textNode) {
		const selection = editor.ownerDocument.defaultView?.getSelection();
		if (selection) {
			const range = editor.ownerDocument.createRange();
			range.setStart(textNode, text.length);
			range.setEnd(textNode, text.length);
			selection.removeAllRanges();
			selection.addRange(range);
		}
	}
	fireEvent.compositionUpdate(editor, { data: text });
	fireEvent.compositionEnd(editor, { data: text });
}

describe("App create workspace flow", () => {
	beforeEach(() => {
		createRuntime.created = false;
		createRuntime.workspaceId = null;
		createRuntime.sessionId = null;
		streamingMocks.handleComposerSubmit.mockReset();

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

	it("creates from the start composer and stays on the created workspace", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		apiMocks.loadAgentModelSections.mockResolvedValue([
			{
				id: "claude",
				label: "Claude",
				options: [
					{
						id: "opus-1m",
						provider: "claude",
						label: "Opus 4.7 1M",
						cliModel: "opus-1m",
						effortLevels: ["low", "medium", "high"],
					},
				],
			},
		]);

		render(<App />);
		await screen.findByRole("main", { name: "Application shell" });

		await user.click(screen.getByRole("button", { name: "New workspace" }));
		expect(await screen.findByLabelText("Workspace input")).toBeInTheDocument();
		expect(
			screen.queryByLabelText("Workspace panel drag region"),
		).not.toBeInTheDocument();

		commitComposerText(
			screen.getByLabelText("Workspace input"),
			"Build a dashboard",
		);
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Start now" })).toBeEnabled();
		});
		await user.click(screen.getByRole("button", { name: "Start now" }));

		await waitFor(() => {
			expect(apiMocks.prepareWorkspaceFromRepo).toHaveBeenCalledWith(
				"repo-1",
				"main",
				"worktree",
			);
		});
		await waitFor(() => {
			expect(apiMocks.finalizeWorkspaceFromRepo).toHaveBeenCalledWith(
				createRuntime.workspaceId,
			);
		});
		await waitFor(() => {
			expect(apiMocks.loadWorkspaceDetail).toHaveBeenCalledWith(
				createRuntime.workspaceId,
			);
			expect(apiMocks.loadWorkspaceSessions).toHaveBeenCalledWith(
				createRuntime.workspaceId,
			);
		});
		await waitFor(() => {
			expect(
				screen.getByLabelText("Workspace panel drag region"),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Start now" }),
			).not.toBeInTheDocument();
		});
		expect(streamingMocks.handleComposerSubmit).toHaveBeenCalled();
	});
});
