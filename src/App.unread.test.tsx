import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const conductorMocks = vi.hoisted(() => ({
  loadWorkspaceGroups: vi.fn(),
  loadArchivedWorkspaces: vi.fn(),
  loadAgentModelSections: vi.fn(),
  loadWorkspaceDetail: vi.fn(),
  loadWorkspaceSessions: vi.fn(),
  loadSessionMessages: vi.fn(),
  loadSessionAttachments: vi.fn(),
  markWorkspaceRead: vi.fn(),
}));

const unreadRuntime = vi.hoisted(() => ({
  workspaceUnread: 0,
  sessionUnreadTotal: 2,
  unreadSessionCount: 1,
  sessionUnreadCount: 2,
}));

vi.mock("./App.css", () => ({}));

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
    markWorkspaceRead: conductorMocks.markWorkspaceRead,
  };
});

import App from "./App";

describe("App unread lifecycle", () => {
  beforeEach(() => {
    unreadRuntime.workspaceUnread = 0;
    unreadRuntime.sessionUnreadTotal = 2;
    unreadRuntime.unreadSessionCount = 1;
    unreadRuntime.sessionUnreadCount = 2;

    conductorMocks.loadWorkspaceGroups.mockReset();
    conductorMocks.loadArchivedWorkspaces.mockReset();
    conductorMocks.loadAgentModelSections.mockReset();
    conductorMocks.loadWorkspaceDetail.mockReset();
    conductorMocks.loadWorkspaceSessions.mockReset();
    conductorMocks.loadSessionMessages.mockReset();
    conductorMocks.loadSessionAttachments.mockReset();
    conductorMocks.markWorkspaceRead.mockReset();

    conductorMocks.loadWorkspaceGroups.mockImplementation(async () => [
      {
        id: "progress",
        label: "In progress",
        tone: "progress",
        rows: [
          {
            id: "workspace-unread",
            title: "Unread workspace",
            repoName: "helmor-core",
            state: "ready",
            hasUnread:
              unreadRuntime.workspaceUnread > 0 || unreadRuntime.sessionUnreadTotal > 0,
            workspaceUnread: unreadRuntime.workspaceUnread,
            sessionUnreadTotal: unreadRuntime.sessionUnreadTotal,
            unreadSessionCount: unreadRuntime.unreadSessionCount,
          },
        ],
      },
    ]);
    conductorMocks.loadArchivedWorkspaces.mockResolvedValue([]);
    conductorMocks.loadAgentModelSections.mockResolvedValue([]);
    conductorMocks.loadWorkspaceDetail.mockImplementation(async () => ({
      id: "workspace-unread",
      title: "Unread workspace",
      repoId: "repo-1",
      repoName: "helmor-core",
      directoryName: "workspace-unread",
      state: "ready",
      hasUnread:
        unreadRuntime.workspaceUnread > 0 || unreadRuntime.sessionUnreadTotal > 0,
      workspaceUnread: unreadRuntime.workspaceUnread,
      sessionUnreadTotal: unreadRuntime.sessionUnreadTotal,
      unreadSessionCount: unreadRuntime.unreadSessionCount,
      derivedStatus: "in-progress",
      manualStatus: null,
      activeSessionId: "session-1",
      activeSessionTitle: "Unread session",
      activeSessionAgentType: "claude",
      activeSessionStatus: "idle",
      branch: "main",
      initializationParentBranch: null,
      intendedTargetBranch: null,
      notes: null,
      pinnedAt: null,
      prTitle: null,
      prDescription: null,
      archiveCommit: null,
      sessionCount: 1,
      messageCount: 0,
      attachmentCount: 0,
    }));
    conductorMocks.loadWorkspaceSessions.mockImplementation(async () => [
      {
        id: "session-1",
        workspaceId: "workspace-unread",
        title: "Unread session",
        agentType: "claude",
        status: "idle",
        model: "gpt-5.4",
        permissionMode: "default",
        claudeSessionId: null,
        unreadCount: unreadRuntime.sessionUnreadCount,
        contextTokenCount: 0,
        contextUsedPercent: null,
        thinkingEnabled: false,
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
    ]);
    conductorMocks.loadSessionMessages.mockResolvedValue([]);
    conductorMocks.loadSessionAttachments.mockResolvedValue([]);
    conductorMocks.markWorkspaceRead.mockImplementation(async () => {
      unreadRuntime.workspaceUnread = 0;
      unreadRuntime.sessionUnreadTotal = 0;
      unreadRuntime.unreadSessionCount = 0;
      unreadRuntime.sessionUnreadCount = 0;
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("clears workspace unread when an unread workspace is opened", async () => {
    render(<App />);

    await waitFor(() => {
      expect(conductorMocks.markWorkspaceRead).toHaveBeenCalledWith("workspace-unread");
    });
    expect(conductorMocks.markWorkspaceRead).toHaveBeenCalledTimes(1);
  });
});
