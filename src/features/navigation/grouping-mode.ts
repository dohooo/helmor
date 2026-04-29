export type SidebarGroupingMode = "by-status" | "by-repo";

export const DEFAULT_GROUPING_MODE: SidebarGroupingMode = "by-status";

const GROUPING_MODE_STORAGE_KEY = "helmor:workspaces-sidebar:grouping-mode";

function isGroupingMode(value: unknown): value is SidebarGroupingMode {
	return value === "by-status" || value === "by-repo";
}

export function readStoredGroupingMode(): SidebarGroupingMode {
	if (typeof window === "undefined") {
		return DEFAULT_GROUPING_MODE;
	}

	try {
		const raw = window.localStorage.getItem(GROUPING_MODE_STORAGE_KEY);
		return isGroupingMode(raw) ? raw : DEFAULT_GROUPING_MODE;
	} catch {
		return DEFAULT_GROUPING_MODE;
	}
}

export function writeStoredGroupingMode(mode: SidebarGroupingMode): void {
	if (typeof window === "undefined") {
		return;
	}

	try {
		window.localStorage.setItem(GROUPING_MODE_STORAGE_KEY, mode);
	} catch (error) {
		console.error(
			`[helmor] sidebar grouping mode save failed for "${GROUPING_MODE_STORAGE_KEY}"`,
			error,
		);
	}
}
