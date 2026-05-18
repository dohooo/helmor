import type { WorkspaceGroup } from "@/lib/api";
import type { SidebarGrouping } from "@/lib/settings";
import { ARCHIVED_SECTION_ID } from "./shared";

const SECTION_OPEN_STATE_STORAGE_KEYS: Record<SidebarGrouping, string> = {
	status: "helmor:workspaces-sidebar:section-open-state",
	repo: "helmor:workspaces-sidebar:section-open-state:repo",
};

function storageKeyFor(grouping: SidebarGrouping): string {
	return SECTION_OPEN_STATE_STORAGE_KEYS[grouping];
}

export function createInitialSectionOpenState(groups: WorkspaceGroup[]) {
	return Object.fromEntries([
		...groups.map((group) => [group.id, true]),
		[ARCHIVED_SECTION_ID, false],
	]) as Record<string, boolean>;
}

export function readStoredSectionOpenState(grouping: SidebarGrouping) {
	if (typeof window === "undefined") {
		return null;
	}

	try {
		const raw = window.localStorage.getItem(storageKeyFor(grouping));
		if (!raw) {
			return null;
		}

		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}

		return parsed as Record<string, boolean>;
	} catch {
		return null;
	}
}

export function writeStoredSectionOpenState(
	grouping: SidebarGrouping,
	state: Record<string, boolean>,
) {
	if (typeof window === "undefined") {
		return;
	}

	const key = storageKeyFor(grouping);
	try {
		window.localStorage.setItem(key, JSON.stringify(state));
	} catch (error) {
		console.error(
			`[helmor] sidebar section state save failed for "${key}"`,
			error,
		);
	}
}
