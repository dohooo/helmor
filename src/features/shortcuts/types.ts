export type ShortcutId =
	| "workspace.previous"
	| "workspace.next"
	| "workspace.quickSwitchNext"
	| "workspace.quickSwitchPrevious"
	| "workspace.new"
	| "workspace.addRepository"
	| "workspace.copyPath"
	| "workspace.openInEditor"
	| "session.previous"
	| "session.next"
	| "session.new"
	| "session.close"
	| "session.reopenClosed"
	| "script.run"
	| "settings.open"
	| "theme.toggle"
	| "sidebar.left.toggle"
	| "sidebar.right.toggle"
	| "zen.toggle"
	| "zoom.in"
	| "zoom.out"
	| "zoom.reset"
	| "global.hotkey"
	| "action.createPr"
	| "action.commitAndPush"
	| "action.pullLatest"
	| "action.mergePr"
	| "action.fixErrors"
	| "action.openPullRequest"
	| "composer.focus"
	| "composer.togglePlanMode"
	| "composer.toggleContextPanel"
	| "composer.openModelPicker"
	| "composer.toggleFollowUpBehavior"
	| "terminal.new"
	| "terminal.close"
	| "terminal.next"
	| "terminal.previous"
	| "inspector.toggleScripts"
	| "inspector.focusTerminal";

export type ShortcutGroup =
	| "Navigation"
	| "Session"
	| "Workspace"
	| "Actions"
	| "System"
	| "Composer"
	| "Terminal";

// Scopes a shortcut can live in. "app" = always active regardless of focus.
// All others gate on [data-focus-scope] DOM ancestors of the active element;
// nested scopes accumulate (e.g. focusing inside the composer surfaces both
// "composer" and "chat"), so a shortcut bound to "chat" still fires while
// typing — and a "composer"-only shortcut stays off when chat focus lives
// elsewhere (inspector, message list).
export type ShortcutScope = "app" | "chat" | "composer" | "terminal" | "editor";

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
