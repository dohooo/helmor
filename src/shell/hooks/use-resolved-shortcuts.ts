import { getShortcut } from "@/features/shortcuts/registry";

/**
 * Resolves the handful of keyboard shortcuts AppShell hands down to its panes.
 * Extracted verbatim from AppShell (Phase 1 split).
 *
 * Kept as plain per-render lookups (no `useMemo`) to match the original inline
 * behavior — `getShortcut` is a cheap pure registry lookup, so memoizing it
 * would only shift recompute timing without benefit.
 */
export function useResolvedShortcuts(
	shortcuts: Parameters<typeof getShortcut>[0],
) {
	return {
		openPreferredEditorShortcut: getShortcut(
			shortcuts,
			"workspace.openInEditor",
		),
		newWorkspaceShortcut: getShortcut(shortcuts, "workspace.new"),
		addRepositoryShortcut: getShortcut(shortcuts, "workspace.addRepository"),
		sidebarFilterShortcut: getShortcut(shortcuts, "workspace.filterSidebar"),
		leftSidebarToggleShortcut: getShortcut(shortcuts, "sidebar.left.toggle"),
		rightSidebarToggleShortcut: getShortcut(shortcuts, "sidebar.right.toggle"),
	};
}
