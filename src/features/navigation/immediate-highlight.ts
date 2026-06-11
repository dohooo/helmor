// Imperative sidebar-highlight fast path shared by the pointer route (sidebar
// pointerdown preview, which keeps passing its own scroll container as root)
// and the keyboard route (which queries `[data-helmor-sidebar-root]`). Moves
// the `.workspace-row-selected` class before any React render so the highlight
// is visible within the input frame; the class produces the same pixels as the
// React-rendered active row (`rowVariants` active variant), so the follow-up
// render is a visual no-op.

export function escapeAttributeSelectorValue(value: string) {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function applyImmediateWorkspaceHighlight(
	root: ParentNode | null,
	workspaceId: string | null,
) {
	if (!root) return;
	for (const element of root.querySelectorAll(
		"[data-workspace-row-body].workspace-row-selected",
	)) {
		element.classList.remove("workspace-row-selected");
	}
	if (!workspaceId) return;
	const target = root.querySelector(
		`[data-workspace-row-body][data-workspace-row-id="${escapeAttributeSelectorValue(workspaceId)}"]`,
	);
	target?.classList.add("workspace-row-selected");
}
