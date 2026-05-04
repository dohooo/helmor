import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext } from "react";
import type { ContextCard } from "./sources/types";

export type ThemeMode = "system" | "light" | "dark";

export type DarkTheme = "default" | "midnight" | "forest" | "ember" | "aurora";

/** Behavior when submitting a message while the agent is still responding.
 *  - `steer`: inject into the active turn (provider-native mid-turn steer).
 *  - `queue`: stash locally; auto-fire as a new turn once the agent finishes.
 */
export type FollowUpBehavior = "steer" | "queue";
export type AppSurface = "workspace" | "workspace-start";
export type WorkspaceRightSidebarMode = "inspector" | "context";

export type ShortcutOverrides = Record<string, string | null>;

export type ClaudeCustomProviderSettings = {
	builtinProviderApiKeys: Record<string, string>;
	customBaseUrl: string;
	customApiKey: string;
	customModels: string;
};

/** Per-account toggles for which item kinds the inbox should pull from
 * a given forge login. Keyed externally by `<provider>:<login>` (e.g.
 * `github:octocat`). Missing keys default to all `true` — newly added
 * accounts opt into everything until the user changes their mind. */
export type InboxAccountSourceToggles = {
	issues: boolean;
	prs: boolean;
	discussions: boolean;
};

export type InboxSourceConfig = {
	accounts: Record<string, InboxAccountSourceToggles>;
};

export const DEFAULT_INBOX_ACCOUNT_TOGGLES: InboxAccountSourceToggles = {
	issues: true,
	prs: true,
	discussions: true,
};

/** Cap on how many inbox cards the kanban view will keep open as
 *  main-content tabs (and persist across restarts). Beyond this the
 *  user gets a toast nudging them to close some — keeps the tab strip
 *  legible and the persisted blob bounded. */
export const KANBAN_OPEN_INBOX_CARDS_MAX = 10;

/** Persisted UI state for the kanban view — the bits that should
 *  survive an app restart so the user lands back in the same place
 *  next time they open the kanban tab. Each field has a graceful
 *  fallback so a corrupt or partial blob still produces sane UI. */
export type KanbanViewState = {
	/** Whether new kanban workspaces land in "in progress" (immediate
	 *  agent dispatch) or "backlog" (draft saved, no agent). */
	createState: "in-progress" | "backlog";
	/** Repository id last selected in the kanban header picker.
	 *  Resolved against the current repo list on hydrate — falls back
	 *  to the first repo when the saved id is no longer present. */
	repoId: string | null;
	/** Inbox top-level provider tab id (e.g. "github", "linear"). Plain
	 *  string here so settings.ts stays free of feature-module imports;
	 *  consumers cast against their own narrower types. */
	inboxProviderTab: string;
	/** Inbox sub-tab id within the provider (e.g. "github_issue",
	 *  "github_pr", "github_discussion"). */
	inboxProviderSourceTab: string;
	/** Branch selected in the kanban header, keyed by repository id. */
	sourceBranchByRepoId: Record<string, string>;
	/** GitHub inbox state filter keyed by source tab id. */
	inboxStateFilterBySource: Record<string, string>;
	/** Inbox cards open as main-content tabs at last app exit. Capped
	 *  at `KANBAN_OPEN_INBOX_CARDS_MAX`. */
	openInboxCards: ContextCard[];
};

export type AppSettings = {
	fontSize: number;
	theme: ThemeMode;
	darkTheme: DarkTheme;
	notifications: boolean;
	lastWorkspaceId: string | null;
	lastSessionId: string | null;
	lastSurface: AppSurface;
	startContextPanelOpen: boolean;
	workspaceRightSidebarMode: WorkspaceRightSidebarMode;
	defaultModelId: string | null;
	/** Model used when the inspector "Review changes" helper creates a session.
	 *  When null, falls back to `defaultModelId`. */
	reviewModelId: string | null;
	/** Effort level for the Review helper. When null, falls back to
	 *  `defaultEffort`. */
	reviewEffort: string | null;
	/** Fast-mode flag for the Review helper. When null, falls back to
	 *  `defaultFastMode`. */
	reviewFastMode: boolean | null;
	defaultEffort: string | null;
	defaultFastMode: boolean;
	/** Webview zoom factor. 1.0 = 100%. Range 0.5–2.0. */
	zoomLevel: number;
	followUpBehavior: FollowUpBehavior;
	/** Force the context-usage ring to always be visible. When false (the
	 *  default), the ring auto-hides until usage crosses
	 *  `CONTEXT_USAGE_AUTO_REVEAL_THRESHOLD`. */
	alwaysShowContextUsage: boolean;
	showUsageStats: boolean;
	onboardingCompleted: boolean;
	shortcuts: ShortcutOverrides;
	claudeCustomProviders: ClaudeCustomProviderSettings;
	inboxSourceConfig: InboxSourceConfig;
	kanbanViewState: KanbanViewState;
};

export const DEFAULT_KANBAN_VIEW_STATE: KanbanViewState = {
	createState: "in-progress",
	repoId: null,
	inboxProviderTab: "github",
	inboxProviderSourceTab: "github_issue",
	sourceBranchByRepoId: {},
	inboxStateFilterBySource: {},
	openInboxCards: [],
};

/**
 * Percentage of the context window above which the ring auto-reveals
 * even when `alwaysShowContextUsage` is off. Picked to match the
 * settings copy ("…only shown when more than 70% is used").
 */
export const CONTEXT_USAGE_AUTO_REVEAL_THRESHOLD = 70;

export const DEFAULT_SETTINGS: AppSettings = {
	fontSize: 14,
	theme: "system",
	darkTheme: "default",
	notifications: true,
	lastWorkspaceId: null,
	lastSessionId: null,
	lastSurface: "workspace",
	startContextPanelOpen: false,
	workspaceRightSidebarMode: "inspector",
	defaultModelId: null,
	reviewModelId: null,
	reviewEffort: null,
	reviewFastMode: null,
	defaultEffort: "high",
	defaultFastMode: false,
	zoomLevel: 1.0,
	followUpBehavior: "steer",
	alwaysShowContextUsage: true,
	showUsageStats: true,
	onboardingCompleted: false,
	shortcuts: {},
	claudeCustomProviders: {
		builtinProviderApiKeys: {},
		customBaseUrl: "",
		customApiKey: "",
		customModels: "",
	},
	inboxSourceConfig: { accounts: {} },
	kanbanViewState: DEFAULT_KANBAN_VIEW_STATE,
};

export const THEME_STORAGE_KEY = "helmor-theme";
export const DARK_THEME_STORAGE_KEY = "helmor-dark-theme";

const VALID_DARK_THEMES: readonly DarkTheme[] = [
	"default",
	"midnight",
	"forest",
	"ember",
	"aurora",
];

// theme + darkTheme are stored in localStorage (sync read for flash-free boot), not SQLite
const SETTINGS_KEY_MAP: Record<
	Exclude<keyof AppSettings, "theme" | "darkTheme">,
	string
> = {
	fontSize: "app.font_size",
	notifications: "app.notifications",
	lastWorkspaceId: "app.last_workspace_id",
	lastSessionId: "app.last_session_id",
	lastSurface: "app.last_surface",
	startContextPanelOpen: "app.start_context_panel_open",
	workspaceRightSidebarMode: "app.workspace_right_sidebar_mode",
	defaultModelId: "app.default_model_id",
	reviewModelId: "app.review_model_id",
	reviewEffort: "app.review_effort",
	reviewFastMode: "app.review_fast_mode",
	defaultEffort: "app.default_effort",
	defaultFastMode: "app.default_fast_mode",
	zoomLevel: "app.zoom_level",
	followUpBehavior: "app.follow_up_behavior",
	alwaysShowContextUsage: "app.always_show_context_usage",
	showUsageStats: "app.show_usage_stats",
	onboardingCompleted: "app.onboarding_completed",
	shortcuts: "app.shortcuts",
	claudeCustomProviders: "app.claude_custom_providers",
	inboxSourceConfig: "app.inbox_source_config",
	kanbanViewState: "app.kanban_view_state",
};

function parseShortcutOverrides(raw: string | undefined): ShortcutOverrides {
	if (!raw) return DEFAULT_SETTINGS.shortcuts;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return DEFAULT_SETTINGS.shortcuts;
		}
		return Object.fromEntries(
			Object.entries(parsed).filter(
				([, value]) => typeof value === "string" || value === null,
			),
		) as ShortcutOverrides;
	} catch {
		return DEFAULT_SETTINGS.shortcuts;
	}
}

function parseInboxSourceConfig(raw: string | undefined): InboxSourceConfig {
	if (!raw) return DEFAULT_SETTINGS.inboxSourceConfig;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return DEFAULT_SETTINGS.inboxSourceConfig;
		}
		const accountsRaw = (parsed as { accounts?: unknown }).accounts;
		if (
			!accountsRaw ||
			typeof accountsRaw !== "object" ||
			Array.isArray(accountsRaw)
		) {
			return { accounts: {} };
		}
		const accounts: Record<string, InboxAccountSourceToggles> = {};
		for (const [key, value] of Object.entries(accountsRaw)) {
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const v = value as Partial<InboxAccountSourceToggles>;
			accounts[key] = {
				issues: typeof v.issues === "boolean" ? v.issues : true,
				prs: typeof v.prs === "boolean" ? v.prs : true,
				discussions: typeof v.discussions === "boolean" ? v.discussions : true,
			};
		}
		return { accounts };
	} catch {
		return DEFAULT_SETTINGS.inboxSourceConfig;
	}
}

function parseStringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).filter(
			([key, entry]) => key.length > 0 && typeof entry === "string" && entry,
		),
	);
}

function parseKanbanViewState(raw: string | undefined): KanbanViewState {
	if (!raw) return DEFAULT_KANBAN_VIEW_STATE;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return DEFAULT_KANBAN_VIEW_STATE;
		}
		const o = parsed as Partial<KanbanViewState>;
		const createState =
			o.createState === "backlog" || o.createState === "in-progress"
				? o.createState
				: DEFAULT_KANBAN_VIEW_STATE.createState;
		const repoId = typeof o.repoId === "string" && o.repoId ? o.repoId : null;
		const inboxProviderTab =
			typeof o.inboxProviderTab === "string" && o.inboxProviderTab
				? o.inboxProviderTab
				: DEFAULT_KANBAN_VIEW_STATE.inboxProviderTab;
		const inboxProviderSourceTab =
			typeof o.inboxProviderSourceTab === "string" && o.inboxProviderSourceTab
				? o.inboxProviderSourceTab
				: DEFAULT_KANBAN_VIEW_STATE.inboxProviderSourceTab;
		const sourceBranchByRepoId = parseStringRecord(o.sourceBranchByRepoId);
		const inboxStateFilterBySource = parseStringRecord(
			o.inboxStateFilterBySource,
		);
		// Trust the persisted ContextCard array as long as it's an array
		// of objects — the cards are written by the same code that reads
		// them, and a deep schema check here would couple settings.ts to
		// every field we add to ContextCard. Cap at the bound so an old
		// blob from before the cap doesn't blow up the UI.
		const openInboxCardsRaw = Array.isArray(o.openInboxCards)
			? o.openInboxCards
			: [];
		const openInboxCards = openInboxCardsRaw
			.filter(
				(card): card is ContextCard =>
					Boolean(card) && typeof card === "object" && !Array.isArray(card),
			)
			.slice(0, KANBAN_OPEN_INBOX_CARDS_MAX);
		return {
			createState,
			repoId,
			inboxProviderTab,
			inboxProviderSourceTab,
			sourceBranchByRepoId,
			inboxStateFilterBySource,
			openInboxCards,
		};
	} catch {
		return DEFAULT_KANBAN_VIEW_STATE;
	}
}

function parseClaudeCustomProviderSettings(
	raw: string | undefined,
): ClaudeCustomProviderSettings {
	if (!raw) return DEFAULT_SETTINGS.claudeCustomProviders;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const builtinProviderApiKeys =
			parsed.builtinProviderApiKeys &&
			typeof parsed.builtinProviderApiKeys === "object" &&
			!Array.isArray(parsed.builtinProviderApiKeys)
				? Object.fromEntries(
						Object.entries(parsed.builtinProviderApiKeys).filter(
							([, value]) => typeof value === "string",
						),
					)
				: {};
		return {
			builtinProviderApiKeys,
			customBaseUrl:
				typeof parsed.customBaseUrl === "string" ? parsed.customBaseUrl : "",
			customApiKey:
				typeof parsed.customApiKey === "string" ? parsed.customApiKey : "",
			customModels:
				typeof parsed.customModels === "string" ? parsed.customModels : "",
		};
	} catch {
		return DEFAULT_SETTINGS.claudeCustomProviders;
	}
}

export async function loadSettings(): Promise<AppSettings> {
	try {
		const raw = await invoke<Record<string, string>>("get_app_settings");
		const rawDefaultModelId = raw[SETTINGS_KEY_MAP.defaultModelId];
		const rawReviewModelId = raw[SETTINGS_KEY_MAP.reviewModelId];
		const rawReviewEffort = raw[SETTINGS_KEY_MAP.reviewEffort];
		const rawReviewFastMode = raw[SETTINGS_KEY_MAP.reviewFastMode];
		return {
			fontSize: raw[SETTINGS_KEY_MAP.fontSize]
				? Number(raw[SETTINGS_KEY_MAP.fontSize])
				: DEFAULT_SETTINGS.fontSize,
			theme:
				(localStorage.getItem(THEME_STORAGE_KEY) as AppSettings["theme"]) ??
				DEFAULT_SETTINGS.theme,
			darkTheme: (() => {
				const raw = localStorage.getItem(DARK_THEME_STORAGE_KEY);
				return VALID_DARK_THEMES.includes(raw as DarkTheme)
					? (raw as DarkTheme)
					: DEFAULT_SETTINGS.darkTheme;
			})(),
			notifications:
				raw[SETTINGS_KEY_MAP.notifications] !== undefined
					? raw[SETTINGS_KEY_MAP.notifications] === "true"
					: DEFAULT_SETTINGS.notifications,
			lastWorkspaceId: raw[SETTINGS_KEY_MAP.lastWorkspaceId] || null,
			lastSessionId: raw[SETTINGS_KEY_MAP.lastSessionId] || null,
			lastSurface:
				raw[SETTINGS_KEY_MAP.lastSurface] === "workspace-start"
					? "workspace-start"
					: DEFAULT_SETTINGS.lastSurface,
			startContextPanelOpen:
				raw[SETTINGS_KEY_MAP.startContextPanelOpen] !== undefined
					? raw[SETTINGS_KEY_MAP.startContextPanelOpen] === "true"
					: DEFAULT_SETTINGS.startContextPanelOpen,
			workspaceRightSidebarMode:
				raw[SETTINGS_KEY_MAP.workspaceRightSidebarMode] === "context"
					? "context"
					: DEFAULT_SETTINGS.workspaceRightSidebarMode,
			defaultModelId:
				rawDefaultModelId && rawDefaultModelId !== "default"
					? rawDefaultModelId
					: DEFAULT_SETTINGS.defaultModelId,
			reviewModelId:
				rawReviewModelId && rawReviewModelId !== "default"
					? rawReviewModelId
					: DEFAULT_SETTINGS.reviewModelId,
			reviewEffort:
				rawReviewEffort && rawReviewEffort !== ""
					? rawReviewEffort
					: DEFAULT_SETTINGS.reviewEffort,
			reviewFastMode:
				rawReviewFastMode === "true"
					? true
					: rawReviewFastMode === "false"
						? false
						: DEFAULT_SETTINGS.reviewFastMode,
			defaultEffort:
				raw[SETTINGS_KEY_MAP.defaultEffort] || DEFAULT_SETTINGS.defaultEffort,
			defaultFastMode:
				raw[SETTINGS_KEY_MAP.defaultFastMode] !== undefined
					? raw[SETTINGS_KEY_MAP.defaultFastMode] === "true"
					: DEFAULT_SETTINGS.defaultFastMode,
			zoomLevel: raw[SETTINGS_KEY_MAP.zoomLevel]
				? Number(raw[SETTINGS_KEY_MAP.zoomLevel])
				: DEFAULT_SETTINGS.zoomLevel,
			followUpBehavior: (() => {
				const v = raw[SETTINGS_KEY_MAP.followUpBehavior];
				return v === "queue" || v === "steer"
					? v
					: DEFAULT_SETTINGS.followUpBehavior;
			})(),
			alwaysShowContextUsage:
				raw[SETTINGS_KEY_MAP.alwaysShowContextUsage] !== undefined
					? raw[SETTINGS_KEY_MAP.alwaysShowContextUsage] === "true"
					: DEFAULT_SETTINGS.alwaysShowContextUsage,
			showUsageStats:
				raw[SETTINGS_KEY_MAP.showUsageStats] !== undefined
					? raw[SETTINGS_KEY_MAP.showUsageStats] === "true"
					: DEFAULT_SETTINGS.showUsageStats,
			onboardingCompleted:
				raw[SETTINGS_KEY_MAP.onboardingCompleted] !== undefined
					? raw[SETTINGS_KEY_MAP.onboardingCompleted] === "true"
					: DEFAULT_SETTINGS.onboardingCompleted,
			shortcuts: parseShortcutOverrides(raw[SETTINGS_KEY_MAP.shortcuts]),
			claudeCustomProviders: parseClaudeCustomProviderSettings(
				raw[SETTINGS_KEY_MAP.claudeCustomProviders],
			),
			inboxSourceConfig: parseInboxSourceConfig(
				raw[SETTINGS_KEY_MAP.inboxSourceConfig],
			),
			kanbanViewState: parseKanbanViewState(
				raw[SETTINGS_KEY_MAP.kanbanViewState],
			),
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
	if (patch.theme !== undefined) {
		try {
			localStorage.setItem(THEME_STORAGE_KEY, patch.theme);
		} catch (error) {
			console.error(
				`[helmor] theme save failed for "${THEME_STORAGE_KEY}"`,
				error,
			);
		}
	}

	if (patch.darkTheme !== undefined) {
		try {
			localStorage.setItem(DARK_THEME_STORAGE_KEY, patch.darkTheme);
		} catch (error) {
			console.error(
				`[helmor] dark theme save failed for "${DARK_THEME_STORAGE_KEY}"`,
				error,
			);
		}
	}

	const settings: Record<string, string> = {};
	for (const [key, dbKey] of Object.entries(SETTINGS_KEY_MAP)) {
		const value = patch[key as keyof Omit<AppSettings, "theme" | "darkTheme">];
		if (value !== undefined) {
			settings[dbKey] =
				key === "shortcuts" ||
				key === "claudeCustomProviders" ||
				key === "inboxSourceConfig" ||
				key === "kanbanViewState"
					? JSON.stringify(value)
					: value === null
						? ""
						: String(value);
		}
	}
	if (Object.keys(settings).length === 0) return;
	try {
		await invoke("update_app_settings", { settingsMap: settings });
	} catch {
		// ignore — non-Tauri env
	}
}

export type SettingsContextValue = {
	settings: AppSettings;
	/** False while the initial load from SQLite is still in flight. */
	isLoaded: boolean;
	updateSettings: (patch: Partial<AppSettings>) => void | Promise<void>;
};

export const SettingsContext = createContext<SettingsContextValue>({
	settings: DEFAULT_SETTINGS,
	isLoaded: false,
	updateSettings: async () => {},
});

export function useSettings(): SettingsContextValue {
	return useContext(SettingsContext);
}

/** Resolve the effective theme ("light" | "dark") from a ThemeMode setting. */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
	if (mode === "system") {
		if (
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function"
		) {
			return window.matchMedia("(prefers-color-scheme: dark)").matches
				? "dark"
				: "light";
		}
		return "dark";
	}
	return mode;
}
