import type { WorkspaceGroup, WorkspaceRow, WorkspaceSummary } from "@/lib/api";
import { summaryToArchivedRow } from "@/lib/workspace-helpers";

export type PendingArchiveEntry = {
	row: WorkspaceRow;
	sourceGroupId: string;
	sourceIndex: number;
	stage: "preparing" | "running" | "confirmed";
	sortTimestamp: number;
};

export type PendingCreationEntry = {
	repoId: string;
	row: WorkspaceRow;
	stage: "creating" | "confirmed";
	resolvedWorkspaceId: string | null;
};

type ProjectedArchivedRow = {
	row: WorkspaceRow;
	sortTimestamp: number;
};

export function projectSidebarLists({
	baseGroups,
	baseArchivedSummaries,
	pendingArchives,
	pendingCreations,
}: {
	baseGroups: WorkspaceGroup[];
	baseArchivedSummaries: WorkspaceSummary[];
	pendingArchives: ReadonlyMap<string, PendingArchiveEntry>;
	pendingCreations: ReadonlyMap<string, PendingCreationEntry>;
}): {
	groups: WorkspaceGroup[];
	archivedRows: WorkspaceRow[];
} {
	const hiddenLiveIds = new Set(pendingArchives.keys());
	for (const [optimisticWorkspaceId, pendingCreation] of pendingCreations) {
		hiddenLiveIds.add(optimisticWorkspaceId);
		if (pendingCreation.resolvedWorkspaceId) {
			hiddenLiveIds.add(pendingCreation.resolvedWorkspaceId);
		}
	}
	const groups =
		hiddenLiveIds.size === 0
			? baseGroups
			: baseGroups.map((group) => ({
					...group,
					rows: group.rows.filter((row) => !hiddenLiveIds.has(row.id)),
				}));

	const liveGroups = Array.from(pendingCreations.values()).reduce(
		(currentGroups, pendingCreation) =>
			insertPendingCreationRow(currentGroups, pendingCreation.row),
		groups,
	);

	const archivedById = new Map<string, ProjectedArchivedRow>();
	for (let index = 0; index < baseArchivedSummaries.length; index += 1) {
		const summary = baseArchivedSummaries[index];
		archivedById.set(summary.id, {
			row: summaryToArchivedRow(summary),
			// Keep the server ordering stable while allowing newer optimistic
			// placeholders to sit above previously archived rows.
			sortTimestamp: -index,
		});
	}

	for (const [workspaceId, pendingArchive] of pendingArchives) {
		if (archivedById.has(workspaceId)) {
			continue;
		}

		archivedById.set(workspaceId, {
			row: {
				...pendingArchive.row,
				state: "archived",
			},
			sortTimestamp: pendingArchive.sortTimestamp,
		});
	}

	const archivedRows = Array.from(archivedById.values())
		.sort((left, right) => right.sortTimestamp - left.sortTimestamp)
		.map((entry) => entry.row);

	return {
		groups: liveGroups,
		archivedRows,
	};
}

export function shouldReconcilePendingArchive(
	workspaceId: string,
	baseGroups: WorkspaceGroup[],
	baseArchivedSummaries: WorkspaceSummary[],
): boolean {
	const stillLive = baseGroups.some((group) =>
		group.rows.some((row) => row.id === workspaceId),
	);
	if (stillLive) {
		return false;
	}

	return baseArchivedSummaries.some((summary) => summary.id === workspaceId);
}

export function shouldReconcilePendingCreation(
	pendingCreation: PendingCreationEntry,
	baseGroups: WorkspaceGroup[],
): boolean {
	const resolvedWorkspaceId = pendingCreation.resolvedWorkspaceId;
	if (pendingCreation.stage !== "confirmed" || !resolvedWorkspaceId) {
		return false;
	}

	return baseGroups.some((group) =>
		group.rows.some((row) => row.id === resolvedWorkspaceId),
	);
}

function insertPendingCreationRow(
	groups: WorkspaceGroup[],
	row: WorkspaceRow,
): WorkspaceGroup[] {
	return groups.map((group) =>
		group.id === "progress"
			? {
					...group,
					rows: group.rows.some((item) => item.id === row.id)
						? group.rows
						: [row, ...group.rows],
				}
			: group,
	);
}
