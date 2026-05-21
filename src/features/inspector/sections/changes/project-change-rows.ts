import type { InspectorFileItem } from "@/lib/editor-session";
import type { ChangeRow } from "./types";

export function projectStagedChanges(
	changes: InspectorFileItem[],
): ChangeRow[] {
	return changes
		.filter((change) => change.stagedStatus != null)
		.map((change) => ({
			...change,
			status: change.stagedStatus ?? change.status,
			insertions: change.stagedInsertions,
			deletions: change.stagedDeletions,
		}));
}

export function projectUnstagedChanges(
	changes: InspectorFileItem[],
): ChangeRow[] {
	return changes
		.filter((change) => change.unstagedStatus != null)
		.map((change) => ({
			...change,
			status: change.unstagedStatus ?? change.status,
			insertions: change.unstagedInsertions,
			deletions: change.unstagedDeletions,
		}));
}

export function projectCommittedChanges(
	changes: InspectorFileItem[],
): ChangeRow[] {
	return changes
		.filter((change) => change.committedStatus != null)
		.map((change) => ({
			...change,
			status: change.committedStatus ?? change.status,
			insertions: change.committedInsertions,
			deletions: change.committedDeletions,
		}));
}
