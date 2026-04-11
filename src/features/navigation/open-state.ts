import type { WorkspaceGroup } from "@/lib/api";
import { ARCHIVED_SECTION_ID } from "./shared";

const SECTION_OPEN_STATE_STORAGE_KEY =
	"helmor:workspaces-sidebar:section-open-state";

export function createInitialSectionOpenState(groups: WorkspaceGroup[]) {
	return Object.fromEntries([
		...groups.map((group) => [group.id, true]),
		[ARCHIVED_SECTION_ID, false],
	]) as Record<string, boolean>;
}

export function readStoredSectionOpenState() {
	if (typeof window === "undefined") {
		return null;
	}

	try {
		const raw = window.localStorage.getItem(SECTION_OPEN_STATE_STORAGE_KEY);
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

export function writeStoredSectionOpenState(state: Record<string, boolean>) {
	if (typeof window === "undefined") {
		return;
	}

	try {
		window.localStorage.setItem(
			SECTION_OPEN_STATE_STORAGE_KEY,
			JSON.stringify(state),
		);
	} catch {}
}
