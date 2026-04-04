import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  loadWorkspaceGroups: vi.fn(),
  loadArchivedWorkspaces: vi.fn(),
  loadAgentModelSections: vi.fn(),
  loadWorkspaceDetail: vi.fn(),
  loadWorkspaceSessions: vi.fn(),
  loadSessionMessages: vi.fn(),
  loadSessionAttachments: vi.fn(),
  listRepositories: vi.fn(),
  createWorkspaceFromRepo: vi.fn(),
}));

const createRuntime = vi.hoisted(() => ({
  created: false,
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
    loadSessionMessages: apiMocks.loadSessionMessages,
    loadSessionAttachments: apiMocks.loadSessionAttachments,
    listRepositories: apiMocks.listRepositories,
    createWorkspaceFromRepo: apiMocks.createWorkspaceFromRepo,
  };
});

import App from "./App";

describe("App create workspace flow", () => {
  beforeEach(() => {
    createRuntime.created = false;

    apiMocks.loadWorkspaceGroups.mockReset();
    apiMocks.loadArchivedWorkspaces.mockReset();
    apiMocks.loadAgentModelSections.mockReset();
    apiMocks.loadWorkspaceDetail.mockReset();
    apiMocks.loadWorkspaceSessions.mockReset();
    apiMocks.loadSessionMessages.mockReset();
    apiMocks.loadSessionAttachments.mockReset();
    apiMocks.listRepositories.mockReset();
    apiMocks.createWorkspaceFromRepo.mockReset();

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
    apiMocks.loadArchivedWorkspaces.mockResolvedValue([]);
    apiMocks.loadAgentModelSections.mockResolvedValue([]);
    apiMocks.loadWorkspaceDetail.mockImplementation(async (workspaceId: string) => {
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
    apiMocks.loadWorkspaceSessions.mockImplementation(async (workspaceId: string) => {
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
    apiMocks.loadSessionMessages.mockResolvedValue([]);
    apiMocks.loadSessionAttachments.mockResolvedValue([]);
    apiMocks.createWorkspaceFromRepo.mockImplementation(async () => {
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
      expect(apiMocks.createWorkspaceFromRepo).toHaveBeenCalledWith("repo-1");
    });
    await waitFor(() => {
      expect(apiMocks.loadWorkspaceDetail).toHaveBeenCalledWith("workspace-created");
    });
    await waitFor(() => {
      expect(apiMocks.loadWorkspaceSessions).toHaveBeenCalledWith("workspace-created");
    });
    await waitFor(() => {
      expect(apiMocks.loadSessionMessages).toHaveBeenCalledWith("session-created");
    });

    expect(screen.getByText("Acamar")).toBeInTheDocument();
  });
});
