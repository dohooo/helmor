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
		apiMocks.listRepositories.mockReset();
		dialogMocks.open.mockReset();

		apiMocks.loadAddRepositoryDefaults.mockResolvedValue({
			lastCloneDirectory: "/tmp/test-repos",
		});
		dialogMocks.open.mockResolvedValue("/tmp/test-repos/added-repo");
		// Add-repo no longer auto-creates a workspace, so the workspace
		// list stays unchanged after an add. New repos surface via
		// `listRepositories`, not via a fresh workspace row.
		apiMocks.loadWorkspaceGroups.mockResolvedValue([
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
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
						unreadSessionCount: 0,
						status: "in-progress",
						activeSessionId: "session-added",
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
		apiMocks.addRepositoryFromLocalPath.mockImplementation(async () => {
			addRepoRuntime.added = true;

			// New behavior: backend hands back `selectedWorkspaceId: null`
			// for newly-added repos. UI lands on start page with this
			// repo selected, no auto-create.
			return {
				repositoryId: "repo-added",
				createdRepository: true,
				selectedWorkspaceId: null,
			};
		});
	});

	afterEach(() => {
		cleanup();
	});

	it("opens the native folder picker and lands on the start page with the new repo selected", async () => {
		const user = userEvent.setup();

		render(<App />);
		await screen.findByRole("main", { name: "Application shell" });

		await user.click(screen.getByRole("button", { name: "Add repository" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Open project" }),
		);

		await waitFor(() => {
			expect(dialogMocks.open).toHaveBeenCalledWith({
				directory: true,
				multiple: false,
				defaultPath: "/tmp/test-repos",
			});
		});
		await waitFor(() => {
			expect(apiMocks.addRepositoryFromLocalPath).toHaveBeenCalledWith(
				"/tmp/test-repos/added-repo",
			);
		});
		// The new repo shows up in the sidebar's repository list.
		await waitFor(() => {
			expect(apiMocks.listRepositories).toHaveBeenCalled();
		});
		// We should NOT auto-create a workspace, so no auto-load of one.
		expect(apiMocks.loadWorkspaceDetail).not.toHaveBeenCalledWith(
			"workspace-added",
		);
		expect(screen.queryByText("Acamar")).not.toBeInTheDocument();
	});

	it("treats picker cancel as a no-op", async () => {
		const user = userEvent.setup();
		dialogMocks.open.mockResolvedValueOnce(null);

		render(<App />);
		await screen.findByRole("main", { name: "Application shell" });

		await user.click(screen.getByRole("button", { name: "Add repository" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Open project" }),
		);

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
		});

		render(<App />);
		await screen.findByRole("main", { name: "Application shell" });

		await user.click(screen.getByRole("button", { name: "Add repository" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Open project" }),
		);

		await waitFor(() => {
			expect(apiMocks.addRepositoryFromLocalPath).toHaveBeenCalledWith(
				"/tmp/test-repos/added-repo",
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
		await screen.findByRole("main", { name: "Application shell" });

		await user.click(screen.getByRole("button", { name: "Add repository" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Open project" }),
		);

		await waitFor(() => {
			expect(
				screen.getByText("Selected directory is not a Git working tree"),
			).toBeInTheDocument();
		});
	});
});
