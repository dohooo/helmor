import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
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
		markWorkspaceRead: apiMocks.markWorkspaceRead,
	};
});

import App from "./App";

describe("App unread lifecycle", () => {
	beforeEach(() => {
		unreadRuntime.workspaceUnread = 0;
		unreadRuntime.sessionUnreadTotal = 2;
		unreadRuntime.unreadSessionCount = 1;
		unreadRuntime.sessionUnreadCount = 2;

		apiMocks.loadWorkspaceGroups.mockReset();
		apiMocks.loadArchivedWorkspaces.mockReset();
		apiMocks.loadAgentModelSections.mockReset();
		apiMocks.loadWorkspaceDetail.mockReset();
		apiMocks.loadWorkspaceSessions.mockReset();
		apiMocks.loadSessionMessages.mockReset();
		apiMocks.loadSessionAttachments.mockReset();
		apiMocks.markWorkspaceRead.mockReset();

		apiMocks.loadWorkspaceGroups.mockImplementation(async () => [
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
							unreadRuntime.workspaceUnread > 0 ||
							unreadRuntime.sessionUnreadTotal > 0,
						workspaceUnread: unreadRuntime.workspaceUnread,
						sessionUnreadTotal: unreadRuntime.sessionUnreadTotal,
						unreadSessionCount: unreadRuntime.unreadSessionCount,
					},
				],
			},
		]);
		apiMocks.loadArchivedWorkspaces.mockResolvedValue([]);
		apiMocks.loadAgentModelSections.mockResolvedValue([]);
		apiMocks.loadWorkspaceDetail.mockImplementation(async () => ({
			id: "workspace-unread",
			title: "Unread workspace",
			repoId: "repo-1",
			repoName: "helmor-core",
			directoryName: "workspace-unread",
			state: "ready",
			hasUnread:
				unreadRuntime.workspaceUnread > 0 ||
				unreadRuntime.sessionUnreadTotal > 0,
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
		apiMocks.loadWorkspaceSessions.mockImplementation(async () => [
			{
				id: "session-1",
				workspaceId: "workspace-unread",
				title: "Unread session",
				agentType: "claude",
				status: "idle",
				model: "gpt-5.4",
				permissionMode: "default",
				providerSessionId: null,
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
		apiMocks.loadSessionMessages.mockResolvedValue([]);
		apiMocks.loadSessionAttachments.mockResolvedValue([]);
		apiMocks.markWorkspaceRead.mockImplementation(async () => {
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
			expect(apiMocks.markWorkspaceRead).toHaveBeenCalledWith(
				"workspace-unread",
			);
		});
		expect(apiMocks.markWorkspaceRead).toHaveBeenCalledTimes(1);
	});
});
