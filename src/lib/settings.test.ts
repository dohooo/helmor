import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_KANBAN_VIEW_STATE,
	loadSettings,
	saveSettings,
} from "./settings";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
	invoke: invokeMock,
}));

describe("settings", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		window.localStorage.clear();
	});

	it("hydrates kanban view state with per-repo branches and inbox filters", async () => {
		invokeMock.mockResolvedValue({
			"app.kanban_view_state": JSON.stringify({
				createState: "backlog",
				repoId: "repo-1",
				inboxProviderTab: "github",
				inboxProviderSourceTab: "github_pr",
				sourceBranchByRepoId: {
					"repo-1": "release/next",
				},
				inboxStateFilterBySource: {
					github_pr: "merged",
				},
				openInboxCards: [],
			}),
		});

		const settings = await loadSettings();

		expect(settings.kanbanViewState).toMatchObject({
			createState: "backlog",
			repoId: "repo-1",
			inboxProviderSourceTab: "github_pr",
			sourceBranchByRepoId: {
				"repo-1": "release/next",
			},
			inboxStateFilterBySource: {
				github_pr: "merged",
			},
		});
	});

	it("keeps old kanban view state blobs compatible", async () => {
		invokeMock.mockResolvedValue({
			"app.kanban_view_state": JSON.stringify({
				createState: "in-progress",
				repoId: "repo-1",
				inboxProviderTab: "github",
				inboxProviderSourceTab: "github_issue",
				openInboxCards: [],
			}),
		});

		const settings = await loadSettings();

		expect(settings.kanbanViewState).toMatchObject({
			...DEFAULT_KANBAN_VIEW_STATE,
			repoId: "repo-1",
		});
	});

	it("saves kanban view state as one JSON blob", async () => {
		invokeMock.mockResolvedValue(undefined);

		await saveSettings({
			kanbanViewState: {
				...DEFAULT_KANBAN_VIEW_STATE,
				sourceBranchByRepoId: { "repo-1": "main" },
				inboxStateFilterBySource: { github_issue: "closed" },
			},
		});

		expect(invokeMock).toHaveBeenCalledWith(
			"update_app_settings",
			expect.objectContaining({
				settingsMap: expect.objectContaining({
					"app.kanban_view_state": expect.stringContaining(
						"sourceBranchByRepoId",
					),
				}),
			}),
		);
	});

	it("hydrates and saves the last app surface", async () => {
		invokeMock.mockResolvedValue({
			"app.last_surface": "workspace-start",
			"app.start_context_panel_open": "true",
			"app.workspace_right_sidebar_mode": "context",
		});

		const settings = await loadSettings();

		expect(settings.lastSurface).toBe("workspace-start");
		expect(settings.startContextPanelOpen).toBe(true);
		expect(settings.workspaceRightSidebarMode).toBe("context");

		invokeMock.mockResolvedValue(undefined);
		await saveSettings({
			lastSurface: "workspace",
			startContextPanelOpen: false,
			workspaceRightSidebarMode: "inspector",
		});

		expect(invokeMock).toHaveBeenLastCalledWith(
			"update_app_settings",
			expect.objectContaining({
				settingsMap: expect.objectContaining({
					"app.last_surface": "workspace",
					"app.start_context_panel_open": "false",
					"app.workspace_right_sidebar_mode": "inspector",
				}),
			}),
		);
	});

	it("keeps default as a valid model id", async () => {
		invokeMock.mockResolvedValue({
			"app.default_model_id": "gpt-5.5",
			"app.review_model_id": "default",
			"app.pr_model_id": "default",
		});

		const settings = await loadSettings();

		expect(settings.defaultModelId).toBe("gpt-5.5");
		expect(settings.reviewModelId).toBe("default");
		expect(settings.prModelId).toBe("default");
	});
});
