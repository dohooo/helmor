import { useEffect } from "react";

// Shared signal: any sidebar DnD active. Used by both row and repo hooks
// so external listeners (hover-card etc.) treat them as one.
export const WORKSPACE_DND_ACTIVE_ATTRIBUTE = "data-workspace-dnd-active";
export const WORKSPACE_DND_ACTIVE_CHANGE_EVENT = "workspace-dnd-active-change";

const DRAG_CURSOR_STYLE_ID = "workspace-dnd-cursor-style";

const DRAG_CURSOR_STYLE_CONTENT = `
	[${WORKSPACE_DND_ACTIVE_ATTRIBUTE}="true"],
	[${WORKSPACE_DND_ACTIVE_ATTRIBUTE}="true"] * {
		cursor: grabbing !important;
	}
	[${WORKSPACE_DND_ACTIVE_ATTRIBUTE}="true"] [data-workspace-row-body]:hover {
		background-color: transparent !important;
	}
	[${WORKSPACE_DND_ACTIVE_ATTRIBUTE}="true"] .workspace-row-selected[data-workspace-row-body]:hover {
		background: var(--workspace-sidebar-selected-bg) !important;
	}
	[${WORKSPACE_DND_ACTIVE_ATTRIBUTE}="true"] [data-workspace-row-actions] {
		opacity: 0 !important;
		pointer-events: none !important;
	}
`;

/** Document-level cursor + hover suppression while a drag is active. */
export function useDndActiveOverlay(active: boolean) {
	useEffect(() => {
		if (!active) return;
		const root = document.documentElement;
		let styleElement = document.getElementById(DRAG_CURSOR_STYLE_ID);
		if (!styleElement) {
			styleElement = document.createElement("style");
			styleElement.id = DRAG_CURSOR_STYLE_ID;
			styleElement.textContent = DRAG_CURSOR_STYLE_CONTENT;
			document.head.appendChild(styleElement);
		}
		root.setAttribute(WORKSPACE_DND_ACTIVE_ATTRIBUTE, "true");
		window.dispatchEvent(new Event(WORKSPACE_DND_ACTIVE_CHANGE_EVENT));
		return () => {
			root.removeAttribute(WORKSPACE_DND_ACTIVE_ATTRIBUTE);
			window.dispatchEvent(new Event(WORKSPACE_DND_ACTIVE_CHANGE_EVENT));
		};
	}, [active]);
}

/** Horizontal travel that aborts a pending drag (scroll intent). */
export const DRAG_MOVE_CANCEL_PX = 10;
/** Pointer travel that promotes pending → active drag. */
export const DRAG_MOVE_ACTIVATE_PX = 3;

export type GhostGeometry = {
	clientY: number;
	offsetY: number;
	height: number;
};

/** Ghost visual centre — hit-test anchor (closestCenter style). */
export function ghostCentreY(g: GhostGeometry): number {
	return g.clientY - g.offsetY + g.height / 2;
}
