export type ShortcutId =
	| "workspace.previous"
	| "workspace.next"
	| "workspace.quickSwitchNext"
	| "workspace.quickSwitchPrevious"
	| "workspace.new"
	| "workspace.addRepository"
	| "workspace.filterSidebar"
	| "workspace.search"
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
	| "startSurface.cycleRepository"
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
	| "Navigation"
	| "Session"
	| "Workspace"
	| "Actions"
	| "System"
	| "Composer"
	| "Start surface"
	| "Editor"
	| "Terminal";

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
// surface-specific shortcuts (Shift+Tab → cycle repo on start, toggle plan
// mode on workspace) can target one and not the other.
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
