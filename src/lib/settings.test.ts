import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_START_SURFACE_PREFERENCES,
	getPreloadedSettings,
	LEGACY_SETTING_KEYS,
	loadSettings,
	readRepoPreference,
	saveSettings,
	writeRepoPreference,
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

	it("hydrates start-surface preferences from the current storage key", async () => {
		invokeMock.mockResolvedValue({
			"app.start_surface_preferences": JSON.stringify({
				createState: "backlog",
				repoId: "repo-1",
				sourceBranchByRepoId: { "repo-1": "release/next" },
				modeByRepoId: { "repo-1": "local" },
				branchIntentByRepoId: { "repo-1": "use_branch" },
			}),
		});

		const settings = await loadSettings();

		expect(settings.startSurfacePreferences).toEqual({
			createState: "backlog",
			repoId: "repo-1",
			sourceBranchByRepoId: { "repo-1": "release/next" },
			modeByRepoId: { "repo-1": "local" },
			branchIntentByRepoId: { "repo-1": "use_branch" },
			chatModeActive: false,
		});
	});

	it("migrates legacy chat entries in modeByRepoId into chatModeActive", async () => {
		invokeMock.mockResolvedValue({
			"app.start_surface_preferences": JSON.stringify({
				repoId: "repo-1",
				modeByRepoId: {
					"repo-1": "chat",
					"repo-2": "worktree",
				},
			}),
		});

		const settings = await loadSettings();

		// chat must be stripped from the repo record (it's no longer
		// repo-bound), and the top-level toggle must capture the user's
		// last intent so re-entering the start surface is unsurprising.
		expect(settings.startSurfacePreferences.modeByRepoId).toEqual({
			"repo-2": "worktree",
		});
		expect(settings.startSurfacePreferences.chatModeActive).toBe(true);
	});

	it("respects an explicit chatModeActive when present", async () => {
		invokeMock.mockResolvedValue({
			"app.start_surface_preferences": JSON.stringify({
				repoId: "repo-1",
				modeByRepoId: { "repo-1": "worktree" },
				chatModeActive: true,
			}),
		});

		const settings = await loadSettings();
		expect(settings.startSurfacePreferences.chatModeActive).toBe(true);
		expect(settings.startSurfacePreferences.modeByRepoId).toEqual({
			"repo-1": "worktree",
		});
	});

	it("hydrates per-repo mode and branch-intent and drops invalid entries", async () => {
		invokeMock.mockResolvedValue({
			"app.start_surface_preferences": JSON.stringify({
				modeByRepoId: {
					"repo-1": "local",
					"repo-2": "worktree",
					"repo-3": "bogus",
					"": "local",
				},
				branchIntentByRepoId: {
					"repo-1": "use_branch",
					"repo-2": "from_branch",
					"repo-3": "nope",
				},
			}),
		});

		const settings = await loadSettings();

		expect(settings.startSurfacePreferences.modeByRepoId).toEqual({
			"repo-1": "local",
			"repo-2": "worktree",
		});
		expect(settings.startSurfacePreferences.branchIntentByRepoId).toEqual({
			"repo-1": "use_branch",
			"repo-2": "from_branch",
		});
	});

	const LEGACY_KEY = LEGACY_SETTING_KEYS.startSurfacePreferences;
	const CURRENT_KEY = "app.start_surface_preferences";

	it("migrates legacy storage key and drops retired fields", async () => {
		invokeMock.mockResolvedValue({
			[LEGACY_KEY]: JSON.stringify({
				createState: "backlog",
				repoId: "repo-1",
				mode: "local",
				branchIntent: "use_branch",
				inboxProviderTab: "github",
				inboxProviderSourceTab: "github_pr",
				inboxStateFilterBySource: { github_pr: "merged" },
				openInboxCards: [{ id: "c" }],
				sourceBranchByRepoId: { "repo-1": "main" },
				modeByRepoId: { "repo-1": "local" },
				branchIntentByRepoId: { "repo-1": "use_branch" },
			}),
		});

		const settings = await loadSettings();

		expect(settings.startSurfacePreferences).toEqual({
			createState: "backlog",
			repoId: "repo-1",
			sourceBranchByRepoId: { "repo-1": "main" },
			modeByRepoId: { "repo-1": "local" },
			branchIntentByRepoId: { "repo-1": "use_branch" },
			chatModeActive: false,
		});

		const writeCall = invokeMock.mock.calls.find(
			([command]) => command === "update_app_settings",
		);
		expect(writeCall).toBeDefined();
		const writtenMap = (
			writeCall?.[1] as { settingsMap: Record<string, string> } | undefined
		)?.settingsMap;
		expect(writtenMap?.[CURRENT_KEY]).toEqual(expect.any(String));
		expect(writtenMap?.[LEGACY_KEY]).toBe("");
	});

	it("prefers the current key when both legacy and current are present", async () => {
		invokeMock.mockResolvedValue({
			[CURRENT_KEY]: JSON.stringify({ repoId: "new" }),
			[LEGACY_KEY]: JSON.stringify({ repoId: "old" }),
		});

		const settings = await loadSettings();
		expect(settings.startSurfacePreferences.repoId).toBe("new");
		const wroteAnything = invokeMock.mock.calls.some(
			([command]) => command === "update_app_settings",
		);
		expect(wroteAnything).toBe(false);
	});

	it("saves start-surface preferences as one JSON blob under the new key", async () => {
		invokeMock.mockResolvedValue(undefined);

		await saveSettings({
			startSurfacePreferences: {
				...DEFAULT_START_SURFACE_PREFERENCES,
				sourceBranchByRepoId: { "repo-1": "main" },
				modeByRepoId: { "repo-1": "local" },
			},
		});

		expect(invokeMock).toHaveBeenCalledWith(
			"update_app_settings",
			expect.objectContaining({
				settingsMap: expect.objectContaining({
					"app.start_surface_preferences": expect.stringContaining(
						"sourceBranchByRepoId",
					),
				}),
			}),
		);
	});

	it("hydrates and saves agent proxy settings", async () => {
		invokeMock.mockResolvedValue({
			"app.agent_proxy": JSON.stringify({
				mode: "custom",
				customUrl: "http://127.0.0.1:7890",
			}),
		});

		const settings = await loadSettings();

		expect(settings.agentProxy).toEqual({
			mode: "custom",
			customUrl: "http://127.0.0.1:7890",
		});

		invokeMock.mockResolvedValue(undefined);
		await saveSettings({
			agentProxy: {
				mode: "system",
				customUrl: "",
			},
		});

		expect(invokeMock).toHaveBeenLastCalledWith(
			"update_app_settings",
			expect.objectContaining({
				settingsMap: expect.objectContaining({
					"app.agent_proxy": JSON.stringify({
						mode: "system",
						customUrl: "",
					}),
				}),
			}),
		);
	});

	it("readRepoPreference returns record entry, falls back, and tolerates missing repoId", () => {
		const record = { "repo-1": "local" as const };
		expect(readRepoPreference(record, "repo-1", "worktree")).toBe("local");
		expect(readRepoPreference(record, "repo-2", "worktree")).toBe("worktree");
		expect(readRepoPreference(record, null, "worktree")).toBe("worktree");
		expect(readRepoPreference(record, undefined, "worktree")).toBe("worktree");
		expect(readRepoPreference({}, "repo-1", "worktree")).toBe("worktree");
	});

	it("writeRepoPreference returns a new record without mutating the input", () => {
		const before = { "repo-1": "local" as const };
		const after = writeRepoPreference(before, "repo-2", "worktree");
		expect(after).toEqual({ "repo-1": "local", "repo-2": "worktree" });
		expect(before).toEqual({ "repo-1": "local" });
		expect(after).not.toBe(before);
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

	it("hydrates and saves auto-archive-on-merge toggle", async () => {
		invokeMock.mockResolvedValue({
			"app.auto_archive_on_merge": "true",
		});

		const enabled = await loadSettings();
		expect(enabled.autoArchiveOnMerge).toBe(true);

		invokeMock.mockResolvedValue({});
		const defaulted = await loadSettings();
		expect(defaulted.autoArchiveOnMerge).toBe(false);

		invokeMock.mockResolvedValue(undefined);
		await saveSettings({ autoArchiveOnMerge: true });

		expect(invokeMock).toHaveBeenLastCalledWith(
			"update_app_settings",
			expect.objectContaining({
				settingsMap: expect.objectContaining({
					"app.auto_archive_on_merge": "true",
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
