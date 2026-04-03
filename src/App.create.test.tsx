import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const conductorMocks = vi.hoisted(() => ({
  loadWorkspaceGroups: vi.fn(),
  loadArchivedWorkspaces: vi.fn(),
  loadAgentModelSections: vi.fn(),
  loadWorkspaceDetail: vi.fn(),
  loadWorkspaceSessions: vi.fn(),
  loadSessionMessages: vi.fn(),
  loadSessionAttachments: vi.fn(),
  listFixtureRepositories: vi.fn(),
  createWorkspaceFromRepo: vi.fn(),
}));

const createRuntime = vi.hoisted(() => ({
  created: false,
}));

vi.mock("./App.css", () => ({}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("./lib/conductor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/conductor")>();

  return {
    ...actual,
    loadWorkspaceGroups: conductorMocks.loadWorkspaceGroups,
    loadArchivedWorkspaces: conductorMocks.loadArchivedWorkspaces,
    loadAgentModelSections: conductorMocks.loadAgentModelSections,
    loadWorkspaceDetail: conductorMocks.loadWorkspaceDetail,
    loadWorkspaceSessions: conductorMocks.loadWorkspaceSessions,
    loadSessionMessages: conductorMocks.loadSessionMessages,
    loadSessionAttachments: conductorMocks.loadSessionAttachments,
    listFixtureRepositories: conductorMocks.listFixtureRepositories,
    createWorkspaceFromRepo: conductorMocks.createWorkspaceFromRepo,
  };
});

import App from "./App";

describe("App create workspace flow", () => {
  beforeEach(() => {
    createRuntime.created = false;

    conductorMocks.loadWorkspaceGroups.mockReset();
    conductorMocks.loadArchivedWorkspaces.mockReset();
    conductorMocks.loadAgentModelSections.mockReset();
    conductorMocks.loadWorkspaceDetail.mockReset();
    conductorMocks.loadWorkspaceSessions.mockReset();
    conductorMocks.loadSessionMessages.mockReset();
    conductorMocks.loadSessionAttachments.mockReset();
    conductorMocks.listFixtureRepositories.mockReset();
    conductorMocks.createWorkspaceFromRepo.mockReset();

    conductorMocks.listFixtureRepositories.mockResolvedValue([
      {
        id: "repo-1",
        name: "dosu-cli",
        defaultBranch: "main",
        repoInitials: "DC",
      },
    ]);
    conductorMocks.loadWorkspaceGroups.mockImplementation(async () => [
      {
        id: "progress",
        label: "In progress",
        tone: "progress",
        rows: createRuntime.created
          ? [
              {
                id: "workspace-existing",
                title: "Existing workspace",
                repoName: "helmor-core",
                state: "ready",
              },
              {
                id: "workspace-created",
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
    conductorMocks.loadArchivedWorkspaces.mockResolvedValue([]);
    conductorMocks.loadAgentModelSections.mockResolvedValue([]);
    conductorMocks.loadWorkspaceDetail.mockImplementation(async (workspaceId: string) => {
      if (workspaceId === "workspace-created") {
        return {
          id: "workspace-created",
          title: "Acamar",
          repoId: "repo-1",
          repoName: "dosu-cli",
          directoryName: "acamar",
          state: "ready",
          hasUnread: false,
          workspaceUnread: 0,
          sessionUnreadTotal: 0,
          unreadSessionCount: 0,
          derivedStatus: "in-progress",
          manualStatus: null,
          activeSessionId: "session-created",
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
      if (workspaceId === "workspace-created") {
        return [
          {
            id: "session-created",
            workspaceId: "workspace-created",
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
    conductorMocks.createWorkspaceFromRepo.mockImplementation(async () => {
      createRuntime.created = true;

      return {
        createdWorkspaceId: "workspace-created",
        selectedWorkspaceId: "workspace-created",
        createdState: "ready",
        directoryName: "acamar",
        branch: "caspian/acamar",
      };
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("creates a workspace from the repo picker and selects its first session", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole("button", { name: "New workspace" }));
    await user.click(screen.getByText("dosu-cli"));

    await waitFor(() => {
      expect(conductorMocks.createWorkspaceFromRepo).toHaveBeenCalledWith("repo-1");
    });
    await waitFor(() => {
      expect(conductorMocks.loadWorkspaceDetail).toHaveBeenCalledWith("workspace-created");
    });
    await waitFor(() => {
      expect(conductorMocks.loadWorkspaceSessions).toHaveBeenCalledWith("workspace-created");
    });
    await waitFor(() => {
      expect(conductorMocks.loadSessionMessages).toHaveBeenCalledWith("session-created");
    });

    expect(screen.getByText("Acamar")).toBeInTheDocument();
  });
});
