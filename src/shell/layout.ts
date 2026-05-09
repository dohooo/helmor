import type {
	WorkspaceGroup,
	WorkspaceRow,
	WorkspaceSessionSummary,
} from "@/lib/api";

export const SIDEBAR_WIDTH_STORAGE_KEY = "helmor.workspaceSidebarWidth";
export const INSPECTOR_WIDTH_STORAGE_KEY = "helmor.workspaceInspectorWidth";
export const PREFERRED_EDITOR_STORAGE_KEY = "helmor.preferredEditorId";
export const DEFAULT_SIDEBAR_WIDTH = 336;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 520;
export const SIDEBAR_RESIZE_STEP = 16;
export const SIDEBAR_RESIZE_HIT_AREA = 20;
export const MIN_CANVAS_WIDTH = 420;

export function fitPanelsToWindow(
	sidebarWidth: number,
	inspectorWidth: number,
	windowWidth: number,
	{
		sidebarCollapsed = false,
		inspectorCollapsed = false,
	}: { sidebarCollapsed?: boolean; inspectorCollapsed?: boolean } = {},
) {
	const sidebar = sidebarCollapsed ? 0 : sidebarWidth;
	const inspector = inspectorCollapsed ? 0 : inspectorWidth;
	const overflow = sidebar + inspector + MIN_CANVAS_WIDTH - windowWidth;

	if (overflow <= 0) {
		return { sidebarWidth, inspectorWidth };
	}

	const inspectorMin = inspectorCollapsed ? 0 : MIN_SIDEBAR_WIDTH;
	const sidebarMin = sidebarCollapsed ? 0 : MIN_SIDEBAR_WIDTH;

	let remaining = overflow;
	let nextInspector = inspector;
	let nextSidebar = sidebar;

	const inspectorReducible = Math.max(0, inspector - inspectorMin);
	const inspectorCut = Math.min(remaining, inspectorReducible);
	nextInspector = inspector - inspectorCut;
	remaining -= inspectorCut;

	if (remaining > 0) {
		const sidebarReducible = Math.max(0, sidebar - sidebarMin);
		const sidebarCut = Math.min(remaining, sidebarReducible);
		nextSidebar = sidebar - sidebarCut;
	}

	return {
		sidebarWidth: sidebarCollapsed ? sidebarWidth : nextSidebar,
		inspectorWidth: inspectorCollapsed ? inspectorWidth : nextInspector,
	};
}

const WORKSPACE_NAVIGATION_ORDER = [
	"done",
	"review",
	"progress",
	"backlog",
	"canceled",
] as const;

export function clampSidebarWidth(width: number) {
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

export function getInitialSidebarWidth(storageKey = SIDEBAR_WIDTH_STORAGE_KEY) {
	if (typeof window === "undefined") {
		return DEFAULT_SIDEBAR_WIDTH;
	}

	try {
		const storedWidth = window.localStorage.getItem(storageKey);

		if (!storedWidth) {
			return DEFAULT_SIDEBAR_WIDTH;
		}

		const parsedWidth = Number.parseInt(storedWidth, 10);

		return Number.isFinite(parsedWidth)
			? clampSidebarWidth(parsedWidth)
			: DEFAULT_SIDEBAR_WIDTH;
	} catch {
		return DEFAULT_SIDEBAR_WIDTH;
	}
}

export function findAdjacentSessionId(
	workspaceSessions: WorkspaceSessionSummary[],
	selectedSessionId: string | null,
	offset: -1 | 1,
) {
	if (!selectedSessionId || workspaceSessions.length < 2) {
		return null;
	}

	const currentIndex = workspaceSessions.findIndex(
		(session) => session.id === selectedSessionId,
	);

	if (currentIndex === -1) {
		return null;
	}

	const nextIndex = currentIndex + offset;

	if (nextIndex < 0 || nextIndex >= workspaceSessions.length) {
		return null;
	}

	return workspaceSessions[nextIndex]?.id ?? null;
}

export function flattenWorkspaceRows(
	groups: WorkspaceGroup[],
	archivedRows: WorkspaceRow[],
) {
	const orderedRows = WORKSPACE_NAVIGATION_ORDER.flatMap((tone) =>
		groups
			.filter((group) => group.tone === tone)
			.flatMap((group) => group.rows),
	);

	return [...orderedRows, ...archivedRows];
}

export function findAdjacentWorkspaceId(
	groups: WorkspaceGroup[],
	archivedRows: WorkspaceRow[],
	selectedWorkspaceId: string | null,
	offset: -1 | 1,
) {
	if (!selectedWorkspaceId) {
		return null;
	}

	const rows = flattenWorkspaceRows(groups, archivedRows);

	if (rows.length < 2) {
		return null;
	}

	const currentIndex = rows.findIndex((row) => row.id === selectedWorkspaceId);

	if (currentIndex === -1) {
		return null;
	}

	const nextIndex = currentIndex + offset;

	if (nextIndex < 0 || nextIndex >= rows.length) {
		return null;
	}

	return rows[nextIndex]?.id ?? null;
}
