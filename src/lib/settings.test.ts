import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_KANBAN_VIEW_STATE,
	getPreloadedSettings,
	loadSettings,
	saveSettings,
} from "./settings";

const invokeMock = vi.mocked(invoke);

function installTestLocalStorage() {
	const store = new Map<string, string>();
	const storage = {
		getItem: vi.fn((key: string) => store.get(key) ?? null),
		setItem: vi.fn((key: string, value: string) => {
			store.set(key, value);
		}),
		removeItem: vi.fn((key: string) => {
			store.delete(key);
		}),
		clear: vi.fn(() => {
			store.clear();
		}),
	};
	Object.defineProperty(window, "localStorage", {
		value: storage,
		configurable: true,
	});
	Object.defineProperty(globalThis, "localStorage", {
		value: storage,
		configurable: true,
	});
}

describe("settings", () => {
	beforeEach(() => {
		installTestLocalStorage();
		invokeMock.mockReset();
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

	it("preloads terminal font from localStorage", () => {
		window.localStorage.setItem("helmor-terminal-font-family", "Berkeley Mono");

		const settings = getPreloadedSettings();

		expect(settings.terminalFontFamily).toBe("Berkeley Mono");
	});

	it("hydrates and saves terminal font from localStorage", async () => {
		window.localStorage.setItem(
			"helmor-terminal-font-family",
			"JetBrains Mono",
		);
		invokeMock.mockResolvedValue({});

		const settings = await loadSettings();

		expect(settings.terminalFontFamily).toBe("JetBrains Mono");

		await saveSettings({ terminalFontFamily: "Berkeley Mono" });
		expect(window.localStorage.getItem("helmor-terminal-font-family")).toBe(
			"Berkeley Mono",
		);

		await saveSettings({ terminalFontFamily: null });
		expect(
			window.localStorage.getItem("helmor-terminal-font-family"),
		).toBeNull();
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

	it("hydrates and saves terminal hover expansion", async () => {
		invokeMock.mockResolvedValue({
			"app.terminal_hover_expansion": "false",
		});

		const settings = await loadSettings();

		expect(settings.terminalHoverExpansion).toBe(false);

		invokeMock.mockResolvedValue(undefined);
		await saveSettings({ terminalHoverExpansion: true });

		expect(invokeMock).toHaveBeenLastCalledWith(
			"update_app_settings",
			expect.objectContaining({
				settingsMap: expect.objectContaining({
					"app.terminal_hover_expansion": "true",
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
