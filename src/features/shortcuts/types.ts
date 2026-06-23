export type ShortcutId =
	| "workspace.previous"
	| "workspace.next"
	| "workspace.quickSwitchNext"
	| "workspace.quickSwitchPrevious"
	| "workspace.new"
	| "workspace.justChat"
	| "workspace.addRepository"
	| "workspace.filterSidebar"
	| "workspace.copyPath"
	| "workspace.openInEditor"
	| "session.previous"
	| "session.next"
	| "session.new"
	| "session.close"
	| "session.reopenClosed"
	| "window.close"
	| "script.run"
	| "settings.open"
	| "theme.toggle"
	| "window.miniMode.toggle"
	| "sidebar.left.toggle"
	| "sidebar.right.toggle"
	| "zen.toggle"
	| "zoom.in"
	| "zoom.out"
	| "zoom.reset"
	| "global.hotkey"
	| "quickPanel.hotkey"
	| "action.createPr"
	| "action.commitAndPush"
	| "action.pullLatest"
	| "action.mergePr"
	| "action.fixErrors"
	| "action.openPullRequest"
	| "composer.focus"
	| "composer.togglePlanMode"
	| "composer.toggleTerminalMode"
	| "composer.toggleContextPanel"
	| "composer.openModelPicker"
	| "composer.toggleFollowUpBehavior"
	| "startSurface.cycleRepository"
	| "startSurface.openRepositoryPicker"
	| "editor.edit"
	| "editor.new"
	| "editor.close"
	| "terminal.new"
	| "terminal.close"
	| "terminal.next"
	| "terminal.previous"
	| "inspector.toggleScripts"
	| "inspector.focusTerminal";

export type ShortcutGroup =
	| "navigation"
	| "session"
	| "workspace"
	| "actions"
	| "system"
	| "miscComposer"
	| "miscStartSurface"
	| "miscEditor"
	| "terminal";

// Scopes a shortcut can live in. "app" = always active regardless of focus.
// All others gate on [data-focus-scope] DOM ancestors of the active element;
// nested scopes accumulate (e.g. focusing inside the composer surfaces both
// "composer" and "chat"), so a shortcut bound to "chat" still fires while
// typing — and a "composer"-only shortcut stays off when chat focus lives
// elsewhere (inspector, message list).
//
// `start-composer` and `workspace-composer` are sibling leaf scopes that split
// the composer namespace by surface. They both inherit from `composer` (and
// transitively from `chat`) so generic composer shortcuts keep firing, but
// surface-specific shortcuts can target one and not the other.
export type ShortcutScope =
	| "app"
	| "chat"
	| "composer"
	| "terminal"
	| "editor"
	| "start-composer"
	| "workspace-composer";

export type ShortcutDefinition = {
	id: ShortcutId;
	title: string;
	description?: string;
	group: ShortcutGroup;
	defaultHotkey: string | null;
	scopes: readonly ShortcutScope[];
	editable: boolean;
};

export type ShortcutMap = Partial<Record<string, string | null>>;
