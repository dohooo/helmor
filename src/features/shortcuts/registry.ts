import type {
	ShortcutDefinition,
	ShortcutId,
	ShortcutMap,
	ShortcutScope,
} from "./types";

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
	{
		id: "workspace.previous",
		title: "Previous workspace",
		group: "Navigation",
		defaultHotkey: "Mod+Alt+ArrowUp",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.next",
		title: "Next workspace",
		group: "Navigation",
		defaultHotkey: "Mod+Alt+ArrowDown",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "session.previous",
		title: "Previous session",
		group: "Navigation",
		defaultHotkey: "Mod+Alt+ArrowLeft",
		scopes: ["chat"],
		editable: true,
	},
	{
		id: "session.next",
		title: "Next session",
		group: "Navigation",
		defaultHotkey: "Mod+Alt+ArrowRight",
		scopes: ["chat"],
		editable: true,
	},
	{
		id: "session.new",
		title: "New session",
		group: "Session",
		defaultHotkey: "Mod+T",
		scopes: ["chat"],
		editable: true,
	},
	{
		id: "session.close",
		title: "Close current session",
		group: "Session",
		defaultHotkey: "Mod+W",
		scopes: ["chat"],
		editable: true,
	},
	{
		id: "session.reopenClosed",
		title: "Reopen closed session",
		group: "Session",
		defaultHotkey: "Mod+Shift+T",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.copyPath",
		title: "Copy workspace path",
		group: "Workspace",
		defaultHotkey: "Mod+Shift+C",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.openInEditor",
		title: "Open repository in default app",
		group: "Workspace",
		defaultHotkey: "Mod+O",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.new",
		title: "Create new workspace",
		group: "Workspace",
		defaultHotkey: "Mod+N",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.addRepository",
		title: "Add repository",
		group: "Workspace",
		defaultHotkey: "Mod+Shift+N",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "workspace.toggleKanban",
		title: "Toggle Kanban",
		group: "Workspace",
		defaultHotkey: "Mod+Shift+K",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "script.run",
		title: "Run / stop script",
		group: "Actions",
		defaultHotkey: "Mod+R",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.createPr",
		title: "Create PR",
		group: "Actions",
		defaultHotkey: "Mod+Shift+P",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.commitAndPush",
		title: "Commit and push",
		group: "Actions",
		defaultHotkey: "Mod+Shift+Y",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.pullLatest",
		title: "Pull latest from main",
		group: "Actions",
		defaultHotkey: "Mod+Shift+L",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.mergePr",
		title: "Merge PR",
		group: "Actions",
		defaultHotkey: "Mod+Shift+M",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.fixErrors",
		title: "Fix errors",
		group: "Actions",
		defaultHotkey: "Mod+Shift+X",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "action.openPullRequest",
		title: "Open PR in browser",
		group: "Actions",
		defaultHotkey: "Mod+Shift+G",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "settings.open",
		title: "Open settings",
		group: "System",
		defaultHotkey: "Mod+,",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "global.hotkey",
		title: "Global hotkey",
		description: "Show/hide Helmor from anywhere.",
		group: "System",
		defaultHotkey: null,
		scopes: ["app"],
		editable: true,
	},
	{
		id: "theme.toggle",
		title: "Toggle theme (dark/light)",
		group: "System",
		defaultHotkey: "Mod+Alt+T",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "sidebar.left.toggle",
		title: "Toggle left sidebar",
		group: "System",
		defaultHotkey: "Mod+B",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "sidebar.right.toggle",
		title: "Toggle right sidebar",
		group: "System",
		defaultHotkey: "Mod+Alt+B",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "zen.toggle",
		title: "Toggle zen mode",
		group: "System",
		defaultHotkey: "Mod+.",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "zoom.in",
		title: "Zoom in",
		group: "System",
		defaultHotkey: "Mod+=",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "zoom.out",
		title: "Zoom out",
		group: "System",
		defaultHotkey: "Mod+-",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "zoom.reset",
		title: "Reset zoom",
		group: "System",
		defaultHotkey: "Mod+0",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "composer.focus",
		title: "Focus chat input",
		group: "Composer",
		defaultHotkey: "Mod+L",
		// App-scoped so the user can pop focus back to the composer from
		// anywhere — including the terminal — making composer ↔ terminal
		// (Mod+L vs Mod+Shift+J) a clean two-way switch.
		scopes: ["app"],
		editable: true,
	},
	{
		id: "composer.togglePlanMode",
		title: "Toggle plan mode",
		group: "Composer",
		defaultHotkey: "Shift+Tab",
		// composer-only: don't let Shift+Tab steal default a11y focus traversal
		// from the inspector / message list.
		scopes: ["composer"],
		editable: true,
	},
	{
		id: "composer.openModelPicker",
		title: "Open model picker",
		group: "Composer",
		defaultHotkey: "Alt+P",
		scopes: ["composer"],
		editable: true,
	},
	{
		id: "composer.toggleFollowUpBehavior",
		title: "Send with opposite follow-up behavior",
		group: "Composer",
		defaultHotkey: "Mod+Enter",
		scopes: ["composer"],
		editable: true,
	},
	{
		id: "terminal.new",
		title: "New terminal",
		group: "Terminal",
		defaultHotkey: "Mod+T",
		scopes: ["terminal"],
		editable: true,
	},
	{
		id: "terminal.close",
		title: "Close current terminal",
		group: "Terminal",
		defaultHotkey: "Mod+W",
		scopes: ["terminal"],
		editable: true,
	},
	{
		id: "terminal.previous",
		title: "Previous terminal",
		group: "Terminal",
		defaultHotkey: "Mod+Alt+ArrowLeft",
		scopes: ["terminal"],
		editable: true,
	},
	{
		id: "terminal.next",
		title: "Next terminal",
		group: "Terminal",
		defaultHotkey: "Mod+Alt+ArrowRight",
		scopes: ["terminal"],
		editable: true,
	},
	{
		id: "inspector.focusTerminal",
		title: "Focus terminal",
		group: "Terminal",
		defaultHotkey: "Mod+Shift+J",
		scopes: ["app"],
		editable: true,
	},
	{
		id: "inspector.toggleScripts",
		title: "Toggle scripts panel",
		group: "Workspace",
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
