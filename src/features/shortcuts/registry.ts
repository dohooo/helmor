import type {
	ShortcutDefinition,
	ShortcutId,
	ShortcutMap,
	ShortcutScope,
} from "./types";

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
	{
		id: "workspace.previous",
		title: "previousWorkspace",
		group: "navigation",
		defaultHotkey: "Mod+Alt+ArrowUp",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.next",
		title: "nextWorkspace",
		group: "navigation",
		defaultHotkey: "Mod+Alt+ArrowDown",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.quickSwitchNext",
		title: "quickSwitchWorkspace",
		group: "navigation",
		defaultHotkey: "Control+Tab",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.quickSwitchPrevious",
		title: "quickSwitchWorkspaceReverse",
		group: "navigation",
		defaultHotkey: "Control+Shift+Tab",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "session.previous",
		title: "previousSession",
		group: "navigation",
		defaultHotkey: "Mod+Alt+ArrowLeft",
		scopes: ["chat"],
		editable: true,
	},
	{
		id: "session.next",
		title: "nextSession",
		group: "navigation",
		defaultHotkey: "Mod+Alt+ArrowRight",
		scopes: ["chat"],
		editable: true,
	},
	{
		id: "session.new",
		title: "newSession",
		group: "session",
		defaultHotkey: "Mod+T",
		scopes: ["chat"],
		editable: true,
	},
	{
		id: "session.close",
		title: "closeCurrentSession",
		group: "session",
		defaultHotkey: "Mod+W",
		scopes: ["chat"],
		editable: true,
	},
	{
		id: "session.reopenClosed",
		title: "reopenClosedSession",
		group: "session",
		defaultHotkey: "Mod+Shift+R",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "window.close",
		title: "closeWindow",
		group: "system",
		defaultHotkey: "Mod+Shift+W",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.copyPath",
		title: "copyWorkspacePath",
		group: "workspace",
		// Unbound by default — Mod+Shift+C is reserved for the composer
		// context panel. Users can rebind from settings if they want.
		defaultHotkey: null,
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.openInEditor",
		title: "openRepositoryDefaultApp",
		group: "workspace",
		defaultHotkey: "Mod+O",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.new",
		title: "openStartPage",
		group: "workspace",
		defaultHotkey: "Mod+N",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.justChat",
		title: "openStartPageJustChat",
		group: "workspace",
		defaultHotkey: "Mod+Shift+N",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.addRepository",
		title: "addRepository2",
		group: "workspace",
		// Unbound by default — Mod+Shift+N now opens the start composer in
		// "Just chat" mode. Users can rebind from settings if they want.
		defaultHotkey: null,
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.filterSidebar",
		title: "filterSortSidebar",
		group: "workspace",
		defaultHotkey: "Mod+Shift+F",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "script.run",
		title: "runStopScript",
		group: "actions",
		defaultHotkey: "Mod+R",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.createPr",
		title: "createPr",
		group: "actions",
		// Unbound by default — Mod+Shift+P is reserved for composer plan mode.
		// Users can rebind from settings if they want.
		defaultHotkey: null,
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.commitAndPush",
		title: "commitPush",
		group: "actions",
		defaultHotkey: "Mod+Shift+Y",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.pullLatest",
		title: "pullLatestFromMain",
		group: "actions",
		defaultHotkey: "Mod+Shift+L",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.mergePr",
		title: "mergePr",
		group: "actions",
		defaultHotkey: "Mod+Shift+M",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.fixErrors",
		title: "fixErrors",
		group: "actions",
		defaultHotkey: "Mod+Shift+X",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.openPullRequest",
		title: "openPrBrowser",
		group: "actions",
		defaultHotkey: "Mod+Shift+G",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "settings.open",
		title: "openSettings",
		group: "system",
		defaultHotkey: "Mod+,",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "global.hotkey",
		title: "globalHotkey",
		description: "showHideHelmorFromAnywhere",
		group: "system",
		defaultHotkey: null,
		scopes: ["app"],
		editable: true,
	},
	{
		// OS-level hotkey registered by the Rust backend. The default below
		// MUST stay in sync with `default_hotkey` in src-tauri/src/global_hotkey.rs.
		id: "quickPanel.hotkey",
		title: "quickPanelHotkey",
		description: "openQuickTaskPanelFromAnywhere",
		group: "system",
		defaultHotkey: "Shift+Alt+Space",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "theme.toggle",
		title: "toggleThemeDarkLight",
		group: "system",
		defaultHotkey: "Mod+Alt+T",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "window.miniMode.toggle",
		title: "toggleMiniMode",
		group: "system",
		defaultHotkey: "Mod+Control+M",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "sidebar.left.toggle",
		title: "toggleLeftSidebar",
		group: "system",
		defaultHotkey: "Mod+B",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "sidebar.right.toggle",
		title: "toggleRightSidebar",
		group: "system",
		defaultHotkey: "Mod+Alt+B",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "zen.toggle",
		title: "toggleZenMode",
		group: "system",
		defaultHotkey: "Mod+.",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "zoom.in",
		title: "zoom",
		group: "system",
		defaultHotkey: "Mod+=",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "zoom.out",
		title: "zoomOut",
		group: "system",
		defaultHotkey: "Mod+-",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "zoom.reset",
		title: "resetZoom",
		group: "system",
		defaultHotkey: "Mod+0",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "composer.focus",
		title: "focusChatInput",
		group: "miscComposer",
		defaultHotkey: "Mod+L",
		// App-scoped so the user can pop focus back to the composer from
		// anywhere — including the terminal — making composer ↔ terminal
		// (Mod+L vs Mod+Shift+J) a clean two-way switch.
		scopes: ["app"],
		editable: true,
	},
	{
		id: "composer.togglePlanMode",
		title: "togglePlanMode",
		group: "miscComposer",
		defaultHotkey: "Mod+Shift+P",
		// workspace-composer only: plan mode is a per-session concept with
		// no UI on the start surface.
		scopes: ["workspace-composer"],
		editable: true,
	},
	{
		id: "composer.toggleTerminalMode",
		title: "toggleTerminalMode",
		group: "miscComposer",
		defaultHotkey: "Mod+Shift+T",
		// App-scoped — handled in the global shortcut table, not composer-local.
		scopes: ["app"],
		editable: true,
	},
	{
		id: "startSurface.cycleRepository",
		title: "switchRepository",
		group: "miscStartSurface",
		defaultHotkey: "Shift+Tab",
		// start-composer only: cycles through repositories in the start
		// composer.
		scopes: ["start-composer"],
		editable: true,
	},
	{
		id: "startSurface.openRepositoryPicker",
		title: "openRepositoryPicker",
		group: "miscStartSurface",
		defaultHotkey: "Alt+R",
		// start-composer only: opens the repository search list.
		scopes: ["start-composer"],
		editable: true,
	},
	{
		id: "composer.toggleContextPanel",
		title: "toggleContextPanel",
		group: "miscComposer",
		defaultHotkey: "Mod+Shift+C",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "composer.openModelPicker",
		title: "openModelPicker",
		group: "miscComposer",
		defaultHotkey: "Alt+P",
		scopes: ["composer"],
		editable: true,
	},
	{
		id: "composer.toggleFollowUpBehavior",
		title: "sendOppositeFollowUpBehavior",
		group: "miscComposer",
		defaultHotkey: "Mod+Enter",
		scopes: ["composer"],
		editable: true,
	},
	{
		id: "editor.edit",
		title: "toggleDiffEdit",
		group: "miscEditor",
		defaultHotkey: "Mod+E",
		scopes: ["editor"],
		editable: true,
	},
	{
		id: "editor.new",
		title: "openFile",
		group: "miscEditor",
		defaultHotkey: "Mod+T",
		scopes: ["editor"],
		editable: true,
	},
	{
		id: "editor.close",
		title: "closeCurrentFile",
		group: "miscEditor",
		defaultHotkey: "Mod+W",
		scopes: ["editor"],
		editable: true,
	},
	{
		id: "terminal.new",
		title: "newTerminal",
		group: "terminal",
		defaultHotkey: "Mod+T",
		scopes: ["terminal"],
		editable: true,
	},
	{
		id: "terminal.close",
		title: "closeCurrentTerminal",
		group: "terminal",
		defaultHotkey: "Mod+W",
		scopes: ["terminal"],
		editable: true,
	},
	{
		id: "terminal.previous",
		title: "previousTerminal",
		group: "terminal",
		defaultHotkey: "Mod+Alt+ArrowLeft",
		scopes: ["terminal"],
		editable: true,
	},
	{
		id: "terminal.next",
		title: "nextTerminal",
		group: "terminal",
		defaultHotkey: "Mod+Alt+ArrowRight",
		scopes: ["terminal"],
		editable: true,
	},
	{
		id: "inspector.focusTerminal",
		title: "focusTerminal",
		group: "terminal",
		defaultHotkey: "Mod+Shift+J",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "inspector.toggleScripts",
		title: "toggleScriptsPanel",
		group: "workspace",
		defaultHotkey: "Mod+J",
		scopes: ["app"],
		editable: true,
	},
];

export const SHORTCUT_DEFINITION_BY_ID = new Map(
	SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function getShortcut(
	overrides: ShortcutMap,
	id: ShortcutId,
): string | null {
	if (Object.hasOwn(overrides, id)) {
		return overrides[id] ?? null;
	}
	return SHORTCUT_DEFINITION_BY_ID.get(id)?.defaultHotkey ?? null;
}

export function updateShortcutOverride(
	overrides: ShortcutMap,
	id: ShortcutId,
	hotkey: string | null,
): ShortcutMap {
	const next = { ...overrides };
	const fallback = SHORTCUT_DEFINITION_BY_ID.get(id)?.defaultHotkey ?? null;
	if (hotkey === fallback) {
		delete next[id];
	} else {
		next[id] = hotkey;
	}
	return next;
}

// Two scope sets "overlap" if at least one shortcut would fire under the same
// active scope. "app" is the wildcard — anything paired with "app" overlaps.
export function scopesOverlap(
	a: readonly ShortcutScope[],
	b: readonly ShortcutScope[],
): boolean {
	if (a.includes("app") || b.includes("app")) return true;
	return a.some((scope) => b.includes(scope));
}

// Scope-aware conflict for the settings UI: a shortcut conflicts with another
// only if they share both a hotkey AND a scope (so chat's Mod+T and terminal's
// Mod+T are deliberately fine).
export function findShortcutConflict(
	overrides: ShortcutMap,
	id: ShortcutId,
	hotkey: string | null,
): ShortcutDefinition | null {
	if (!hotkey) return null;
	const subject = SHORTCUT_DEFINITION_BY_ID.get(id);
	if (!subject) return null;
	return (
		SHORTCUT_DEFINITIONS.find(
			(definition) =>
				definition.id !== id &&
				getShortcut(overrides, definition.id) === hotkey &&
				scopesOverlap(subject.scopes, definition.scopes),
		) ?? null
	);
}

export function getShortcutConflicts(overrides: ShortcutMap): {
	conflictById: Partial<Record<ShortcutId, ShortcutDefinition[]>>;
	disabledIds: Set<ShortcutId>;
} {
	const definitionsByHotkey = new Map<string, ShortcutDefinition[]>();
	for (const definition of SHORTCUT_DEFINITIONS) {
		const hotkey = getShortcut(overrides, definition.id);
		if (!hotkey) continue;
		const definitions = definitionsByHotkey.get(hotkey) ?? [];
		definitions.push(definition);
		definitionsByHotkey.set(hotkey, definitions);
	}

	const conflictById: Partial<Record<ShortcutId, ShortcutDefinition[]>> = {};
	const disabledIds = new Set<ShortcutId>();
	for (const definitions of definitionsByHotkey.values()) {
		if (definitions.length < 2) continue;
		for (let i = 0; i < definitions.length; i++) {
			for (let j = i + 1; j < definitions.length; j++) {
				const a = definitions[i];
				const b = definitions[j];
				if (!scopesOverlap(a.scopes, b.scopes)) continue;
				conflictById[a.id] = [...(conflictById[a.id] ?? []), b];
				conflictById[b.id] = [...(conflictById[b.id] ?? []), a];
				disabledIds.add(a.id);
				disabledIds.add(b.id);
			}
		}
	}
	return { conflictById, disabledIds };
}
