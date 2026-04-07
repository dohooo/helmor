import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	addRepositoryFromLocalPath: vi.fn(),
	loadAddRepositoryDefaults: vi.fn(),
	loadWorkspaceGroups: vi.fn(),
	loadArchivedWorkspaces: vi.fn(),
	loadAgentModelSections: vi.fn(),
	loadWorkspaceDetail: vi.fn(),
	loadWorkspaceSessions: vi.fn(),
	loadSessionThreadMessages: vi.fn(),
	loadSessionAttachments: vi.fn(),
	listRepositories: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
	open: vi.fn(),
}));

const addRepoRuntime = vi.hoisted(() => ({
	added: false,
}));

vi.mock("./App.css", () => ({}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: dialogMocks.open,
}));

vi.mock("./lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./lib/api")>();

	return {
		...actual,
		addRepositoryFromLocalPath: apiMocks.addRepositoryFromLocalPath,
		loadAddRepositoryDefaults: apiMocks.loadAddRepositoryDefaults,
		loadWorkspaceGroups: apiMocks.loadWorkspaceGroups,
		loadArchivedWorkspaces: apiMocks.loadArchivedWorkspaces,
		loadAgentModelSections: apiMocks.loadAgentModelSections,
		loadWorkspaceDetail: apiMocks.loadWorkspaceDetail,
		loadWorkspaceSessions: apiMocks.loadWorkspaceSessions,
		loadSessionMessages: apiMocks.loadSessionThreadMessages,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
		loadSessionAttachments: apiMocks.loadSessionAttachments,
		listRepositories: apiMocks.listRepositories,
	};
});

import App from "./App";

describe("App add repository flow", () => {
	beforeEach(() => {
		addRepoRuntime.added = false;

		apiMocks.addRepositoryFromLocalPath.mockReset();
		apiMocks.loadAddRepositoryDefaults.mockReset();
		apiMocks.loadWorkspaceGroups.mockReset();
		apiMocks.loadArchivedWorkspaces.mockReset();
		apiMocks.loadAgentModelSections.mockReset();
		apiMocks.loadWorkspaceDetail.mockReset();
		apiMocks.loadWorkspaceSessions.mockReset();
		apiMocks.loadSessionThreadMessages.mockReset();
		apiMocks.loadSessionAttachments.mockReset();
		apiMocks.listRepositories.mockReset();
		dialogMocks.open.mockReset();

		apiMocks.loadAddRepositoryDefaults.mockResolvedValue({
			lastCloneDirectory: "/Users/caspian/code/github",
		});
		dialogMocks.open.mockResolvedValue("/Users/caspian/code/github/added-repo");
		apiMocks.loadWorkspaceGroups.mockImplementation(async () => [
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: addRepoRuntime.added
					? [
							{
								id: "workspace-existing",
								title: "Existing workspace",
								repoName: "helmor-core",
								state: "ready",
							},
							{
								id: "workspace-added",
								title: "Acamar",
								directoryName: "acamar",
								repoName: "added-repo",
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
		apiMocks.listRepositories.mockImplementation(async () =>
			addRepoRuntime.added
				? [
						{
							id: "repo-existing",
							name: "helmor-core",
							defaultBranch: "main",
							repoInitials: "HC",
						},
						{
							id: "repo-added",
							name: "added-repo",
							defaultBranch: "main",
							repoInitials: "AR",
						},
					]
				: [
						{
							id: "repo-existing",
							name: "helmor-core",
							defaultBranch: "main",
							repoInitials: "HC",
						},
					],
		);
		apiMocks.loadWorkspaceDetail.mockImplementation(
			async (workspaceId: string) => {
				if (workspaceId === "workspace-added") {
					return {
						id: "workspace-added",
						title: "Acamar",
						repoId: "repo-added",
						repoName: "added-repo",
						directoryName: "acamar",
						state: "ready",
						hasUnread: false,
						workspaceUnread: 0,
						sessionUnreadTotal: 0,
						unreadSessionCount: 0,
						derivedStatus: "in-progress",
						manualStatus: null,
						activeSessionId: "session-added",
						activeSessionTitle: "Untitled",
						activeSessionAgentType: "claude",
						activeSessionStatus: "idle",
						branch: "caspian/acamar",
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
					sessionUnreadTotal: 0,
					unreadSessionCount: 0,
					derivedStatus: "in-progress",
					manualStatus: null,
					activeSessionId: "session-existing",
					activeSessionTitle: "Untitled",
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
				};
			},
		);
		apiMocks.loadWorkspaceSessions.mockImplementation(
			async (workspaceId: string) => {
				if (workspaceId === "workspace-added") {
					return [
						{
							id: "session-added",
							workspaceId: "workspace-added",
							title: "Untitled",
							agentType: "claude",
							status: "idle",
							model: "opus",
							permissionMode: "default",
							providerSessionId: null,
							unreadCount: 0,
							contextTokenCount: 0,
							contextUsedPercent: null,
							thinkingEnabled: true,
							codexThinkingLevel: null,
							fastMode: false,
							agentPersonality: null,
							createdAt: "2026-04-03T00:00:00Z",
							updatedAt: "2026-04-03T00:00:00Z",
							lastUserMessageAt: null,
							resumeSessionAt: null,
							isHidden: false,
							isCompacting: false,
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
						contextTokenCount: 0,
						contextUsedPercent: null,
						thinkingEnabled: true,
						codexThinkingLevel: null,
						fastMode: false,
						agentPersonality: null,
						createdAt: "2026-04-03T00:00:00Z",
						updatedAt: "2026-04-03T00:00:00Z",
						lastUserMessageAt: null,
						resumeSessionAt: null,
						isHidden: false,
						isCompacting: false,
						active: true,
					},
				];
			},
		);
		apiMocks.loadSessionThreadMessages.mockResolvedValue([]);
		apiMocks.loadSessionAttachments.mockResolvedValue([]);
		apiMocks.addRepositoryFromLocalPath.mockImplementation(async () => {
			addRepoRuntime.added = true;

			return {
				repositoryId: "repo-added",
				createdRepository: true,
				selectedWorkspaceId: "workspace-added",
				createdWorkspaceId: "workspace-added",
				createdWorkspaceState: "ready",
			};
		});
	});

	afterEach(() => {
		cleanup();
	});

	it("opens the native folder picker and adds a repository", async () => {
		const user = userEvent.setup();

		render(<App />);

		await user.click(screen.getByRole("button", { name: "Add repository" }));

		await waitFor(() => {
			expect(dialogMocks.open).toHaveBeenCalledWith({
				directory: true,
				multiple: false,
				defaultPath: "/Users/caspian/code/github",
			});
		});
		await waitFor(() => {
			expect(apiMocks.addRepositoryFromLocalPath).toHaveBeenCalledWith(
				"/Users/caspian/code/github/added-repo",
			);
		});
		await waitFor(() => {
			expect(apiMocks.loadWorkspaceDetail).toHaveBeenCalledWith(
				"workspace-added",
			);
		});
		await waitFor(() => {
			expect(apiMocks.loadSessionThreadMessages).toHaveBeenCalledWith(
				"session-added",
			);
		});

		expect(screen.getByText("Acamar")).toBeInTheDocument();
	});

	it("treats picker cancel as a no-op", async () => {
		const user = userEvent.setup();
		dialogMocks.open.mockResolvedValueOnce(null);

		render(<App />);

		await user.click(screen.getByRole("button", { name: "Add repository" }));

		await waitFor(() => {
			expect(dialogMocks.open).toHaveBeenCalled();
		});
		expect(apiMocks.addRepositoryFromLocalPath).not.toHaveBeenCalled();
		expect(screen.queryByText("Acamar")).not.toBeInTheDocument();
	});

	it("focuses the existing workspace when the repository already exists", async () => {
		const user = userEvent.setup();
		apiMocks.addRepositoryFromLocalPath.mockResolvedValueOnce({
			repositoryId: "repo-existing",
			createdRepository: false,
			selectedWorkspaceId: "workspace-existing",
			createdWorkspaceId: null,
			createdWorkspaceState: "ready",
		});

		render(<App />);

		await user.click(screen.getByRole("button", { name: "Add repository" }));

		await waitFor(() => {
			expect(apiMocks.addRepositoryFromLocalPath).toHaveBeenCalledWith(
				"/Users/caspian/code/github/added-repo",
			);
		});

		expect(screen.queryByText("Acamar")).not.toBeInTheDocument();
	});

	it("shows add-repository failures inline", async () => {
		const user = userEvent.setup();
		apiMocks.addRepositoryFromLocalPath.mockRejectedValueOnce(
			new Error("Selected directory is not a Git working tree"),
		);

		render(<App />);

		await user.click(screen.getByRole("button", { name: "Add repository" }));

		await waitFor(() => {
			expect(
				screen.getByText("Selected directory is not a Git working tree"),
			).toBeInTheDocument();
		});
	});
});
