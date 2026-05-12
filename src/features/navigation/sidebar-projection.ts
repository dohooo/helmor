import type { WorkspaceGroup, WorkspaceRow, WorkspaceSummary } from "@/lib/api";
import type { SidebarGrouping } from "@/lib/settings";
import { summaryToArchivedRow } from "@/lib/workspace-helpers";

export const REPO_GROUP_PREFIX = "repo:";
const UNKNOWN_REPO_GROUP_ID = `${REPO_GROUP_PREFIX}__unknown__`;

/**
 * Extract the underlying repository id from a sidebar group id, or `null`
 * if the group isn't a repo bucket (status group, pinned, backlog) or is
 * the catch-all "unknown repo" bucket where we have no repo to act on.
 */
export function repoIdFromGroupId(groupId: string): string | null {
	if (!groupId.startsWith(REPO_GROUP_PREFIX)) return null;
	if (groupId === UNKNOWN_REPO_GROUP_ID) return null;
	return groupId.slice(REPO_GROUP_PREFIX.length);
}

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
		const pending = pendingArchives.get(summary.id);
		archivedById.set(summary.id, {
			row: summaryToArchivedRow(summary),
			// While a pending entry exists, inherit its sortTimestamp so the
			// item doesn't jump when server data arrives. Once the pending
			// entry is reconciled away, fall back to stable server ordering.
			sortTimestamp: pending ? pending.sortTimestamp : -index,
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

/**
 * Project base sidebar data into the exact shape the UI renders, applying
 * pending optimistic state AND the user's grouping preference. This is the
 * single source of truth for "visual sidebar" — every consumer that needs
 * to reason about the order rows actually appear in (auto-select, archive
 * replacement, etc.) should call this rather than composing the two steps
 * by hand, which is how the two sides drift out of sync.
 */
export function projectVisualSidebar(
	args: Parameters<typeof projectSidebarLists>[0],
	sidebarGrouping: SidebarGrouping,
): ReturnType<typeof projectSidebarLists> {
	const projected = projectSidebarLists(args);
	if (sidebarGrouping !== "repo") return projected;
	return { ...projected, groups: regroupByRepo(projected.groups) };
}

/**
 * Re-groups status-bucketed sidebar groups into repo-bucketed ones.
 *
 * - "pinned" passes through unchanged at the front and "backlog" passes
 *   through unchanged at the back — these two carry user intent that is
 *   orthogonal to repo (workspaces the user has elevated, and workspaces
 *   queued for later) and are worth preserving as their own buckets in
 *   either grouping mode.
 * - Everything else (in-flight creates, in-progress, in review, done,
 *   canceled) flattens into per-repo buckets keyed by `repoId`. Each repo
 *   group's title is the repository name.
 * - Rows with no `repoId` (legacy / optimistic) fall into a single
 *   "Unknown" bucket so they never silently disappear.
 * - Repo bucket order follows first-seen order in the flattened input,
 *   which inherits the server's status ordering (done → review → progress
 *   → canceled), so recently-completed repos surface near the top.
 */
export function regroupByRepo(groups: WorkspaceGroup[]): WorkspaceGroup[] {
	const head: WorkspaceGroup[] = []; // pinned
	const tail: WorkspaceGroup[] = []; // backlog
	const repoOrder: string[] = [];
	const repoBuckets = new Map<
		string,
		{ label: string; rows: WorkspaceRow[] }
	>();

	for (const group of groups) {
		if (group.id === "pinned") {
			head.push(group);
			continue;
		}
		if (group.id === "backlog") {
			tail.push(group);
			continue;
		}
		for (const row of group.rows) {
			const bucketId = row.repoId
				? `${REPO_GROUP_PREFIX}${row.repoId}`
				: UNKNOWN_REPO_GROUP_ID;
			let bucket = repoBuckets.get(bucketId);
			if (!bucket) {
				bucket = { label: row.repoName ?? "Unknown", rows: [] };
				repoBuckets.set(bucketId, bucket);
				repoOrder.push(bucketId);
			}
			bucket.rows.push(row);
		}
	}

	const repoGroups: WorkspaceGroup[] = repoOrder.map((bucketId) => {
		const bucket = repoBuckets.get(bucketId);
		if (!bucket) {
			throw new Error(`regroupByRepo: missing bucket ${bucketId}`);
		}
		return {
			id: bucketId,
			label: bucket.label,
			// Repo groups don't carry status semantics; reuse "pinned" as a
			// neutral tone that won't render a status icon (the header will
			// branch on group.id and render an avatar instead).
			tone: "pinned",
			rows: bucket.rows,
		};
	});

	return [...head, ...repoGroups, ...tail];
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
