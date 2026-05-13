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

/** Controls how Claude Code returns thinking content.
 *  - `summarized`: thinking blocks contain summarized thinking text.
 *  - `omitted`: server skips streaming thinking tokens; the final text
 *    response begins streaming sooner. */
export type ClaudeThinkingDisplay = "summarized" | "omitted";
export type AppSurface = "workspace" | "workspace-start";
export type WorkspaceRightSidebarMode = "inspector" | "context";
export type SidebarGrouping = "status" | "repo";

export type ShortcutOverrides = Record<string, string | null>;

export type InboxIssueScope =
	| "involves"
	| "assigned"
	| "mentioned"
	| "created"
	| "all";
export type InboxPullRequestScope =
	| "involves"
	| "author"
	| "assignee"
	| "mentions"
	| "reviewRequested"
	| "reviewedBy"
	| "all";
export type InboxSort = "updated" | "created" | "comments";
export type InboxDraftFilter = "exclude" | "include" | "only";
export type InboxIssueState = "open" | "closed" | "all";
export type InboxPullRequestState = "open" | "closed" | "merged" | "all";
export type InboxDiscussionState = "unanswered" | "answered" | "all";

export type InboxKindDefaults = {
	issueScopes: InboxIssueScope[];
	prScopes: InboxPullRequestScope[];
	issueState: InboxIssueState;
	prState: InboxPullRequestState;
	discussionState: InboxDiscussionState;
	issueSort: InboxSort;
	prSort: InboxSort;
	discussionSort: InboxSort;
	draftPrs: InboxDraftFilter;
	issueLabels: string;
	prLabels: string;
};

export type ClaudeCustomProviderSettings = {
	builtinProviderApiKeys: Record<string, string>;
	customBaseUrl: string;
	customApiKey: string;
	customModels: string;
};

/** Mirrors SDK `ModelParameterDefinition` shape. */
export type CursorCachedModelParameterValue = {
	value: string;
	displayName?: string;
};

export type CursorCachedModelParameter = {
	id: string;
	displayName?: string;
	values: CursorCachedModelParameterValue[];
};

/** `Cursor.models.list` snapshot. `parameters` may be absent on legacy
 *  entries — Rust catalog degrades until next Refresh writes them back. */
export type CursorCachedModel = {
	id: string;
	label: string;
	parameters?: CursorCachedModelParameter[];
};

export type CursorProviderSettings = {
	apiKey: string;
	/** `null` = first fetch auto-fills defaults; `[]` = user cleared,
	 *  never auto-fill again. */
	enabledModelIds: string[] | null;
	/** Last fetched catalog; lets the Rust picker render synchronously. */
	cachedModels: CursorCachedModel[] | null;
};

/** Per-account toggles for which item kinds the inbox should pull from
 * a given forge login. Keyed externally by `<provider>:<login>` (e.g.
 * `github:octocat`). Missing keys default to all `true` — newly added
 * accounts opt into everything until the user changes their mind. */
export type InboxAccountSourceToggles = InboxKindDefaults & {
	issues: boolean;
	prs: boolean;
	discussions: boolean;
	repos?: Record<string, InboxRepoSourceConfig>;
};

export type InboxRepoSourceConfig = InboxKindDefaults & {
	enabled: boolean;
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
	issueScopes: ["involves"],
	prScopes: ["involves"],
	issueState: "open",
	prState: "open",
	discussionState: "unanswered",
	issueSort: "updated",
	prSort: "updated",
	discussionSort: "updated",
	draftPrs: "exclude",
	issueLabels: "",
	prLabels: "",
};

export const DEFAULT_INBOX_REPO_CONFIG: InboxRepoSourceConfig = {
	enabled: false,
	issues: true,
	prs: true,
	discussions: true,
	issueScopes: ["all"],
	prScopes: ["all"],
	issueState: "open",
	prState: "open",
	discussionState: "unanswered",
	issueSort: "updated",
	prSort: "updated",
	discussionSort: "updated",
	draftPrs: "exclude",
	issueLabels: "",
	prLabels: "",
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
	/** Chat message body font size (px). Migrated from the legacy `fontSize`
	 *  field, which only ever affected chat rendering. */
	chatFontSize: number;
	/** Override for the sans-serif UI font stack. `null` = preset default. */
	uiFontFamily: string | null;
	/** Override for the monospace code font stack. `null` = preset default. */
	codeFontFamily: string | null;
	/** When true, all clickable elements show a pointer cursor on hover.
	 *  When false, falls back to the default arrow. */
	usePointerCursors: boolean;
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
	/** Model used by simple action sessions: create/reopen PR/MR and
	 *  commit-and-push. When null, falls back to `defaultModelId`. */
	prModelId: string | null;
	/** Effort level for simple action sessions. When null, falls back to
	 *  `defaultEffort`. */
	prEffort: string | null;
	/** Fast-mode flag for simple action sessions. When null, falls back to
	 *  `defaultFastMode`. */
	prFastMode: boolean | null;
	defaultEffort: string | null;
	defaultFastMode: boolean;
	/** Webview zoom factor. 1.0 = 100%. Range 0.5–2.0. */
	zoomLevel: number;
	followUpBehavior: FollowUpBehavior;
	/** How Claude Code returns thinking content. Plumbed through to the
	 *  sidecar's `thinking.display` field. */
	claudeThinkingDisplay: ClaudeThinkingDisplay;
	/** Force the context-usage ring to always be visible. When false (the
	 *  default), the ring auto-hides until usage crosses
	 *  `CONTEXT_USAGE_AUTO_REVEAL_THRESHOLD`. */
	alwaysShowContextUsage: boolean;
	showUsageStats: boolean;
	onboardingCompleted: boolean;
	shortcuts: ShortcutOverrides;
	claudeCustomProviders: ClaudeCustomProviderSettings;
	cursorProvider: CursorProviderSettings;
	inboxSourceConfig: InboxSourceConfig;
	kanbanViewState: KanbanViewState;
	/** Sidebar grouping mode. Persisted to localStorage (sync read on boot
	 *  to avoid the sidebar flashing the wrong grouping while SQLite-backed
	 *  settings load asynchronously). */
	sidebarGrouping: SidebarGrouping;
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
	chatFontSize: 14,
	uiFontFamily: null,
	codeFontFamily: null,
	usePointerCursors: true,
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
	prModelId: null,
	prEffort: null,
	prFastMode: null,
	defaultEffort: "high",
	defaultFastMode: false,
	zoomLevel: 1.0,
	followUpBehavior: "steer",
	claudeThinkingDisplay: "summarized",
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
	cursorProvider: {
		apiKey: "",
		enabledModelIds: null,
		cachedModels: null,
	},
	inboxSourceConfig: { accounts: {} },
	kanbanViewState: DEFAULT_KANBAN_VIEW_STATE,
	sidebarGrouping: "status",
};

export const THEME_STORAGE_KEY = "helmor-theme";
export const DARK_THEME_STORAGE_KEY = "helmor-dark-theme";
export const SIDEBAR_GROUPING_STORAGE_KEY = "helmor-sidebar-grouping";
export const UI_FONT_FAMILY_STORAGE_KEY = "helmor-ui-font-family";
export const CODE_FONT_FAMILY_STORAGE_KEY = "helmor-code-font-family";

/** Keys mirrored to localStorage for flash-free synchronous boot reads.
 *  Anything visible in the first paint must live here so we don't wait
 *  on the async SQLite round-trip. */
const LOCALSTORAGE_KEYS = {
	theme: THEME_STORAGE_KEY,
	darkTheme: DARK_THEME_STORAGE_KEY,
	sidebarGrouping: SIDEBAR_GROUPING_STORAGE_KEY,
	uiFontFamily: UI_FONT_FAMILY_STORAGE_KEY,
	codeFontFamily: CODE_FONT_FAMILY_STORAGE_KEY,
} as const;

type LocalStorageKey = keyof typeof LOCALSTORAGE_KEYS;

const VALID_SIDEBAR_GROUPINGS: readonly SidebarGrouping[] = ["status", "repo"];

const VALID_DARK_THEMES: readonly DarkTheme[] = [
	"default",
	"midnight",
	"forest",
	"ember",
	"aurora",
];

// Synchronous theme read for flash-free splash boot. The full settings
// payload lives in SQLite and loads async; theme is mirrored to
// localStorage so we can paint with the right colour scheme before that
// returns.
export function getPreloadedTheme(): ThemeMode {
	if (typeof localStorage === "undefined") {
		return DEFAULT_SETTINGS.theme;
	}
	const raw = localStorage.getItem(THEME_STORAGE_KEY);
	return (raw as ThemeMode | null) ?? DEFAULT_SETTINGS.theme;
}

function readLocalStorageString(key: string): string | null {
	if (typeof localStorage === "undefined") return null;
	const v = localStorage.getItem(key);
	return v && v.length > 0 ? v : null;
}

export function getPreloadedSettings(): AppSettings {
	const darkTheme = (() => {
		const raw = readLocalStorageString(DARK_THEME_STORAGE_KEY);
		return VALID_DARK_THEMES.includes(raw as DarkTheme)
			? (raw as DarkTheme)
			: DEFAULT_SETTINGS.darkTheme;
	})();
	return {
		...DEFAULT_SETTINGS,
		theme: getPreloadedTheme(),
		darkTheme,
		uiFontFamily: readLocalStorageString(UI_FONT_FAMILY_STORAGE_KEY),
		codeFontFamily: readLocalStorageString(CODE_FONT_FAMILY_STORAGE_KEY),
	};
}

// localStorage-backed fields (sync read for flash-free boot) live in
// `LOCALSTORAGE_KEYS` above. Everything else goes through SQLite.
const SETTINGS_KEY_MAP: Record<
	Exclude<keyof AppSettings, LocalStorageKey>,
	string
> = {
	chatFontSize: "app.chat_font_size",
	usePointerCursors: "app.use_pointer_cursors",
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
	prModelId: "app.pr_model_id",
	prEffort: "app.pr_effort",
	prFastMode: "app.pr_fast_mode",
	defaultEffort: "app.default_effort",
	defaultFastMode: "app.default_fast_mode",
	zoomLevel: "app.zoom_level",
	followUpBehavior: "app.follow_up_behavior",
	claudeThinkingDisplay: "app.claude_thinking_display",
	alwaysShowContextUsage: "app.always_show_context_usage",
	showUsageStats: "app.show_usage_stats",
	onboardingCompleted: "app.onboarding_completed",
	shortcuts: "app.shortcuts",
	claudeCustomProviders: "app.claude_custom_providers",
	cursorProvider: "app.cursor_provider",
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

function parseInboxToggles(
	value: unknown,
	defaults: InboxKindDefaults & {
		issues: boolean;
		prs: boolean;
		discussions: boolean;
	},
): InboxKindDefaults & { issues: boolean; prs: boolean; discussions: boolean } {
	const v = (value ?? {}) as Partial<InboxAccountSourceToggles> & {
		labels?: unknown;
		sort?: unknown;
		issueScope?: unknown;
		prScope?: unknown;
	};
	const legacySort = isInboxSort(v.sort) ? v.sort : defaults.issueSort;
	const legacyLabels = typeof v.labels === "string" ? v.labels : "";
	return {
		issues: typeof v.issues === "boolean" ? v.issues : defaults.issues,
		prs: typeof v.prs === "boolean" ? v.prs : defaults.prs,
		discussions:
			typeof v.discussions === "boolean" ? v.discussions : defaults.discussions,
		issueScopes: parseInboxIssueScopes(
			v.issueScopes,
			v.issueScope,
			defaults.issueScopes,
		),
		prScopes: parseInboxPullRequestScopes(
			v.prScopes,
			v.prScope,
			defaults.prScopes,
		),
		issueState: isInboxIssueState(v.issueState)
			? v.issueState
			: defaults.issueState,
		prState: isInboxPullRequestState(v.prState) ? v.prState : defaults.prState,
		discussionState: isInboxDiscussionState(v.discussionState)
			? v.discussionState
			: defaults.discussionState,
		issueSort: isInboxSort(v.issueSort) ? v.issueSort : legacySort,
		prSort: isInboxSort(v.prSort) ? v.prSort : legacySort,
		discussionSort: isInboxSort(v.discussionSort)
			? v.discussionSort
			: legacySort,
		draftPrs: isInboxDraftFilter(v.draftPrs) ? v.draftPrs : defaults.draftPrs,
		issueLabels:
			typeof v.issueLabels === "string" ? v.issueLabels : legacyLabels,
		prLabels: typeof v.prLabels === "string" ? v.prLabels : legacyLabels,
	};
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
			const reposRaw = v.repos;
			const repos: Record<string, InboxRepoSourceConfig> = {};
			if (
				reposRaw &&
				typeof reposRaw === "object" &&
				!Array.isArray(reposRaw)
			) {
				for (const [repo, repoValue] of Object.entries(reposRaw)) {
					if (
						!repoValue ||
						typeof repoValue !== "object" ||
						Array.isArray(repoValue)
					) {
						continue;
					}
					const repoConfig = repoValue as Partial<InboxRepoSourceConfig>;
					repos[repo] = {
						...parseInboxToggles(repoValue, DEFAULT_INBOX_REPO_CONFIG),
						enabled:
							typeof repoConfig.enabled === "boolean"
								? repoConfig.enabled
								: DEFAULT_INBOX_REPO_CONFIG.enabled,
					};
				}
			}
			accounts[key] = {
				...parseInboxToggles(value, DEFAULT_INBOX_ACCOUNT_TOGGLES),
				repos,
			};
		}
		return { accounts };
	} catch {
		return DEFAULT_SETTINGS.inboxSourceConfig;
	}
}

function oneOf<T extends string>(
	value: unknown,
	values: readonly T[],
): value is T {
	return typeof value === "string" && values.includes(value as T);
}

function isInboxIssueScope(value: unknown): value is InboxIssueScope {
	return oneOf(value, [
		"involves",
		"assigned",
		"mentioned",
		"created",
		"all",
	] as const);
}

function parseInboxIssueScopes(
	value: unknown,
	legacyValue: unknown,
	fallback = DEFAULT_INBOX_ACCOUNT_TOGGLES.issueScopes,
): InboxIssueScope[] {
	if (Array.isArray(value)) {
		const scopes = value.filter(isInboxIssueScope);
		if (scopes.length > 0) return scopes;
	}
	if (isInboxIssueScope(legacyValue)) return [legacyValue];
	return fallback;
}

function isInboxPullRequestScope(
	value: unknown,
): value is InboxPullRequestScope {
	return oneOf(value, [
		"involves",
		"author",
		"assignee",
		"mentions",
		"reviewRequested",
		"reviewedBy",
		"all",
	] as const);
}

function parseInboxPullRequestScopes(
	value: unknown,
	legacyValue: unknown,
	fallback = DEFAULT_INBOX_ACCOUNT_TOGGLES.prScopes,
): InboxPullRequestScope[] {
	if (Array.isArray(value)) {
		const scopes = value.filter(isInboxPullRequestScope);
		if (scopes.length > 0) return scopes;
	}
	if (isInboxPullRequestScope(legacyValue)) return [legacyValue];
	return fallback;
}

function isInboxIssueState(value: unknown): value is InboxIssueState {
	return oneOf(value, ["open", "closed", "all"] as const);
}

function isInboxPullRequestState(
	value: unknown,
): value is InboxPullRequestState {
	return oneOf(value, ["open", "closed", "merged", "all"] as const);
}

function isInboxDiscussionState(value: unknown): value is InboxDiscussionState {
	return oneOf(value, ["unanswered", "answered", "all"] as const);
}

function isInboxSort(value: unknown): value is InboxSort {
	return oneOf(value, ["updated", "created", "comments"] as const);
}

function isInboxDraftFilter(value: unknown): value is InboxDraftFilter {
	return oneOf(value, ["exclude", "include", "only"] as const);
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

function parseCursorProviderSettings(
	raw: string | undefined,
): CursorProviderSettings {
	if (!raw) return DEFAULT_SETTINGS.cursorProvider;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return {
			apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
			enabledModelIds: parseEnabledModelIds(parsed.enabledModelIds),
			cachedModels: parseCachedModels(parsed.cachedModels),
		};
	} catch {
		return DEFAULT_SETTINGS.cursorProvider;
	}
}

function parseEnabledModelIds(value: unknown): string[] | null {
	if (value === null) return null;
	if (!Array.isArray(value)) return null;
	const ids = value.filter((item): item is string => typeof item === "string");
	return ids;
}

function parseCachedModels(value: unknown): CursorCachedModel[] | null {
	if (!Array.isArray(value)) return null;
	const models: CursorCachedModel[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const obj = entry as Record<string, unknown>;
		if (typeof obj.id !== "string" || typeof obj.label !== "string") continue;
		const parameters = parseCachedModelParameters(obj.parameters);
		models.push({
			id: obj.id,
			label: obj.label,
			...(parameters ? { parameters } : {}),
		});
	}
	return models;
}

function parseCachedModelParameters(
	value: unknown,
): CursorCachedModelParameter[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: CursorCachedModelParameter[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const obj = entry as Record<string, unknown>;
		if (typeof obj.id !== "string") continue;
		const values: CursorCachedModelParameterValue[] = [];
		if (Array.isArray(obj.values)) {
			for (const v of obj.values) {
				if (!v || typeof v !== "object" || Array.isArray(v)) continue;
				const vobj = v as Record<string, unknown>;
				if (typeof vobj.value !== "string") continue;
				values.push({
					value: vobj.value,
					...(typeof vobj.displayName === "string"
						? { displayName: vobj.displayName }
						: {}),
				});
			}
		}
		out.push({
			id: obj.id,
			...(typeof obj.displayName === "string"
				? { displayName: obj.displayName }
				: {}),
			values,
		});
	}
	return out;
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

/** Read an integer setting bounded to [min, max] with a default fallback.
 *  Used for font sizes so corrupted or out-of-range values can't render
 *  the UI unreadable. */
function readClampedInt(
	value: string | undefined,
	{ min, max, fallback }: { min: number; max: number; fallback: number },
): number {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}

function readModelId(value: string | undefined): string | null {
	return value && value !== "" ? value : null;
}

export async function loadSettings(): Promise<AppSettings> {
	try {
		const raw = await invoke<Record<string, string>>("get_app_settings");
		const rawDefaultModelId = raw[SETTINGS_KEY_MAP.defaultModelId];
		const rawReviewModelId = raw[SETTINGS_KEY_MAP.reviewModelId];
		const rawReviewEffort = raw[SETTINGS_KEY_MAP.reviewEffort];
		const rawReviewFastMode = raw[SETTINGS_KEY_MAP.reviewFastMode];
		const rawPrModelId = raw[SETTINGS_KEY_MAP.prModelId];
		const rawPrEffort = raw[SETTINGS_KEY_MAP.prEffort];
		const rawPrFastMode = raw[SETTINGS_KEY_MAP.prFastMode];
		// Migration: legacy `app.font_size` is the new chatFontSize. Read
		// it as a fallback when the new key is absent; the old row stays
		// in SQLite (unused) until the user next changes the chat font.
		const legacyFontSize = raw["app.font_size"];
		return {
			chatFontSize: readClampedInt(
				raw[SETTINGS_KEY_MAP.chatFontSize] ?? legacyFontSize,
				{ min: 10, max: 24, fallback: DEFAULT_SETTINGS.chatFontSize },
			),
			uiFontFamily: readLocalStorageString(UI_FONT_FAMILY_STORAGE_KEY),
			codeFontFamily: readLocalStorageString(CODE_FONT_FAMILY_STORAGE_KEY),
			usePointerCursors:
				raw[SETTINGS_KEY_MAP.usePointerCursors] !== undefined
					? raw[SETTINGS_KEY_MAP.usePointerCursors] === "true"
					: DEFAULT_SETTINGS.usePointerCursors,
			theme:
				(localStorage.getItem(THEME_STORAGE_KEY) as AppSettings["theme"]) ??
				DEFAULT_SETTINGS.theme,
			darkTheme: (() => {
				const raw = localStorage.getItem(DARK_THEME_STORAGE_KEY);
				return VALID_DARK_THEMES.includes(raw as DarkTheme)
					? (raw as DarkTheme)
					: DEFAULT_SETTINGS.darkTheme;
			})(),
			sidebarGrouping: (() => {
				const raw = localStorage.getItem(SIDEBAR_GROUPING_STORAGE_KEY);
				return VALID_SIDEBAR_GROUPINGS.includes(raw as SidebarGrouping)
					? (raw as SidebarGrouping)
					: DEFAULT_SETTINGS.sidebarGrouping;
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
			defaultModelId: readModelId(rawDefaultModelId),
			reviewModelId: readModelId(rawReviewModelId),
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
			prModelId: readModelId(rawPrModelId),
			prEffort:
				rawPrEffort && rawPrEffort !== ""
					? rawPrEffort
					: DEFAULT_SETTINGS.prEffort,
			prFastMode:
				rawPrFastMode === "true"
					? true
					: rawPrFastMode === "false"
						? false
						: DEFAULT_SETTINGS.prFastMode,
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
			claudeThinkingDisplay: (() => {
				const v = raw[SETTINGS_KEY_MAP.claudeThinkingDisplay];
				return v === "summarized" || v === "omitted"
					? v
					: DEFAULT_SETTINGS.claudeThinkingDisplay;
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
			cursorProvider: parseCursorProviderSettings(
				raw[SETTINGS_KEY_MAP.cursorProvider],
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
	// localStorage-backed fields. `null` / "" clears the row so the next
	// boot falls back to the preset default.
	for (const [field, lsKey] of Object.entries(LOCALSTORAGE_KEYS) as Array<
		[LocalStorageKey, string]
	>) {
		const value = patch[field];
		if (value === undefined) continue;
		try {
			if (value === null || value === "") {
				localStorage.removeItem(lsKey);
			} else {
				localStorage.setItem(lsKey, String(value));
			}
		} catch (error) {
			console.error(`[helmor] localStorage save failed for "${lsKey}"`, error);
		}
	}

	const settings: Record<string, string> = {};
	for (const [key, dbKey] of Object.entries(SETTINGS_KEY_MAP)) {
		const value = patch[key as keyof Omit<AppSettings, LocalStorageKey>];
		if (value !== undefined) {
			settings[dbKey] =
				key === "shortcuts" ||
				key === "claudeCustomProviders" ||
				key === "cursorProvider" ||
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
