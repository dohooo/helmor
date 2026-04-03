import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const conductorMocks = vi.hoisted(() => ({
  addRepositoryFromLocalPath: vi.fn(),
  loadAddRepositoryDefaults: vi.fn(),
  loadWorkspaceGroups: vi.fn(),
  loadArchivedWorkspaces: vi.fn(),
  loadAgentModelSections: vi.fn(),
  loadWorkspaceDetail: vi.fn(),
  loadWorkspaceSessions: vi.fn(),
  loadSessionMessages: vi.fn(),
  loadSessionAttachments: vi.fn(),
  listFixtureRepositories: vi.fn(),
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

vi.mock("./lib/conductor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/conductor")>();

  return {
    ...actual,
    addRepositoryFromLocalPath: conductorMocks.addRepositoryFromLocalPath,
    loadAddRepositoryDefaults: conductorMocks.loadAddRepositoryDefaults,
    loadWorkspaceGroups: conductorMocks.loadWorkspaceGroups,
    loadArchivedWorkspaces: conductorMocks.loadArchivedWorkspaces,
    loadAgentModelSections: conductorMocks.loadAgentModelSections,
    loadWorkspaceDetail: conductorMocks.loadWorkspaceDetail,
    loadWorkspaceSessions: conductorMocks.loadWorkspaceSessions,
    loadSessionMessages: conductorMocks.loadSessionMessages,
    loadSessionAttachments: conductorMocks.loadSessionAttachments,
    listFixtureRepositories: conductorMocks.listFixtureRepositories,
  };
});

import App from "./App";

describe("App add repository flow", () => {
  beforeEach(() => {
    addRepoRuntime.added = false;

    conductorMocks.addRepositoryFromLocalPath.mockReset();
    conductorMocks.loadAddRepositoryDefaults.mockReset();
    conductorMocks.loadWorkspaceGroups.mockReset();
    conductorMocks.loadArchivedWorkspaces.mockReset();
    conductorMocks.loadAgentModelSections.mockReset();
    conductorMocks.loadWorkspaceDetail.mockReset();
    conductorMocks.loadWorkspaceSessions.mockReset();
    conductorMocks.loadSessionMessages.mockReset();
    conductorMocks.loadSessionAttachments.mockReset();
    conductorMocks.listFixtureRepositories.mockReset();
    dialogMocks.open.mockReset();

    conductorMocks.loadAddRepositoryDefaults.mockResolvedValue({
      lastCloneDirectory: "/Users/caspian/code/github",
    });
    dialogMocks.open.mockResolvedValue("/Users/caspian/code/github/added-repo");
    conductorMocks.loadWorkspaceGroups.mockImplementation(async () => [
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
    conductorMocks.loadArchivedWorkspaces.mockResolvedValue([]);
    conductorMocks.loadAgentModelSections.mockResolvedValue([]);
    conductorMocks.listFixtureRepositories.mockImplementation(async () =>
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
    conductorMocks.loadWorkspaceDetail.mockImplementation(async (workspaceId: string) => {
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
    });
    conductorMocks.loadWorkspaceSessions.mockImplementation(async (workspaceId: string) => {
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
            claudeSessionId: null,
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
          claudeSessionId: null,
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
    });
    conductorMocks.loadSessionMessages.mockResolvedValue([]);
    conductorMocks.loadSessionAttachments.mockResolvedValue([]);
    conductorMocks.addRepositoryFromLocalPath.mockImplementation(async () => {
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
      expect(conductorMocks.addRepositoryFromLocalPath).toHaveBeenCalledWith(
        "/Users/caspian/code/github/added-repo",
      );
    });
    await waitFor(() => {
      expect(conductorMocks.loadWorkspaceDetail).toHaveBeenCalledWith("workspace-added");
    });
    await waitFor(() => {
      expect(conductorMocks.loadSessionMessages).toHaveBeenCalledWith("session-added");
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
    expect(conductorMocks.addRepositoryFromLocalPath).not.toHaveBeenCalled();
    expect(screen.queryByText("Acamar")).not.toBeInTheDocument();
  });

  it("focuses the existing workspace when the repository already exists", async () => {
    const user = userEvent.setup();
    conductorMocks.addRepositoryFromLocalPath.mockResolvedValueOnce({
      repositoryId: "repo-existing",
      createdRepository: false,
      selectedWorkspaceId: "workspace-existing",
      createdWorkspaceId: null,
      createdWorkspaceState: "ready",
    });

    render(<App />);

    await user.click(screen.getByRole("button", { name: "Add repository" }));

    await waitFor(() => {
      expect(conductorMocks.addRepositoryFromLocalPath).toHaveBeenCalledWith(
        "/Users/caspian/code/github/added-repo",
      );
    });

    expect(screen.queryByText("Acamar")).not.toBeInTheDocument();
  });

  it("shows add-repository failures inline", async () => {
    const user = userEvent.setup();
    conductorMocks.addRepositoryFromLocalPath.mockRejectedValueOnce(
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
