import type { WorkspaceGroup, WorkspaceRow, WorkspaceSummary } from "@/lib/api";
import type { SidebarGrouping, SidebarSort } from "@/lib/settings";
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
	viewOptions?: SidebarViewOptions,
): ReturnType<typeof projectSidebarLists> {
	const projected = projectSidebarLists(args);
	const grouped =
		sidebarGrouping === "repo"
			? { ...projected, groups: regroupByRepo(projected.groups) }
			: projected;
	return applySidebarView(grouped, viewOptions);
}

export type SidebarViewOptions = {
	availableRepoIds?: readonly string[];
	repoFilterIds?: readonly string[];
	sort?: SidebarSort;
};

export function applySidebarView(
	projected: ReturnType<typeof projectSidebarLists>,
	options?: SidebarViewOptions,
): ReturnType<typeof projectSidebarLists> {
	const filterIds = effectiveRepoFilterIds(
		projected.groups,
		projected.archivedRows,
		options?.availableRepoIds,
		options?.repoFilterIds ?? [],
	);
	const hasRepoFilter = filterIds.size > 0;
	const sort = options?.sort ?? "custom";

	const filteredGroups = projected.groups
		.map((group) => ({
			...group,
			rows: hasRepoFilter
				? group.rows.filter((row) => row.repoId && filterIds.has(row.repoId))
				: group.rows,
		}))
		.filter(
			(group) =>
				!hasRepoFilter ||
				group.rows.length > 0 ||
				repoIdFromGroupId(group.id) === null,
		);
	const filteredArchivedRows = hasRepoFilter
		? projected.archivedRows.filter(
				(row) => row.repoId && filterIds.has(row.repoId),
			)
		: projected.archivedRows;

	// Archived rows always sort by updatedAt DESC, independent of the
	// active sidebarSort. Custom (drag) order is meaningless once a
	// workspace is archived, and repoName / createdAt aren't the
	// natural index for "find an old workspace" — last activity is.
	const sortedArchivedRows = [...filteredArchivedRows].sort(
		compareArchivedRowsByUpdatedAtDesc,
	);

	if (sort === "custom") {
		return {
			groups: filteredGroups,
			archivedRows: sortedArchivedRows,
		};
	}

	return {
		groups: sortGroupsForView(filteredGroups, sort),
		archivedRows: sortedArchivedRows,
	};
}

function compareArchivedRowsByUpdatedAtDesc(
	left: WorkspaceRow,
	right: WorkspaceRow,
): number {
	const leftTime = Date.parse(left.updatedAt ?? "") || 0;
	const rightTime = Date.parse(right.updatedAt ?? "") || 0;
	if (leftTime !== rightTime) return rightTime - leftTime;
	return compareStrings(left.title, right.title);
}

function effectiveRepoFilterIds(
	groups: WorkspaceGroup[],
	archivedRows: WorkspaceRow[],
	availableRepoIds: readonly string[] | undefined,
	repoFilterIds: readonly string[],
): Set<string> {
	if (repoFilterIds.length === 0) return new Set();
	const validRepoIds = new Set(availableRepoIds);
	for (const group of groups) {
		for (const row of group.rows) {
			if (row.repoId) validRepoIds.add(row.repoId);
		}
	}
	for (const row of archivedRows) {
		if (row.repoId) validRepoIds.add(row.repoId);
	}
	return new Set(repoFilterIds.filter((repoId) => validRepoIds.has(repoId)));
}

function sortGroupsForView(
	groups: WorkspaceGroup[],
	sort: Exclude<SidebarSort, "custom">,
): WorkspaceGroup[] {
	const sortedGroups = groups.map((group) => ({
		...group,
		rows: [...group.rows].sort((left, right) =>
			compareRowsBySidebarSort(left, right, sort),
		),
	}));

	const hasRepoGroups = sortedGroups.some((group) =>
		group.id.startsWith(REPO_GROUP_PREFIX),
	);
	if (!hasRepoGroups) return sortedGroups;

	const head = sortedGroups.filter((group) => group.id === "pinned");
	const tail = sortedGroups.filter((group) => group.id === "backlog");
	const middle = sortedGroups.filter(
		(group) => group.id !== "pinned" && group.id !== "backlog",
	);

	middle.sort((left, right) =>
		compareRepoGroupsBySidebarSort(left, right, sort),
	);

	return [...head, ...middle, ...tail];
}

function compareRepoGroupsBySidebarSort(
	left: WorkspaceGroup,
	right: WorkspaceGroup,
	sort: Exclude<SidebarSort, "custom">,
): number {
	if (sort === "repoName") {
		const byName = compareStrings(left.label, right.label);
		if (byName !== 0) return byName;
	}

	const leftBest = bestTimestampForGroup(left, sort);
	const rightBest = bestTimestampForGroup(right, sort);
	if (leftBest !== rightBest) return rightBest - leftBest;

	return compareStrings(left.label, right.label);
}

function bestTimestampForGroup(
	group: WorkspaceGroup,
	sort: Exclude<SidebarSort, "custom">,
): number {
	if (group.rows.length === 0) return 0;

	if (sort === "createdAt") {
		return Math.max(
			...group.rows.map((row) => Date.parse(row.createdAt ?? "") || 0),
		);
	}
	return Math.max(
		...group.rows.map((row) => Date.parse(row.updatedAt ?? "") || 0),
	);
}

function compareRowsBySidebarSort(
	left: WorkspaceRow,
	right: WorkspaceRow,
	sort: Exclude<SidebarSort, "custom">,
): number {
	if (sort === "repoName") {
		const byRepo = compareStrings(left.repoName ?? "", right.repoName ?? "");
		if (byRepo !== 0) return byRepo;
		const byTitle = compareStrings(left.title, right.title);
		if (byTitle !== 0) return byTitle;
		return compareStrings(left.id, right.id);
	}

	const leftTime =
		Date.parse(
			sort === "createdAt" ? (left.createdAt ?? "") : (left.updatedAt ?? ""),
		) || 0;
	const rightTime =
		Date.parse(
			sort === "createdAt" ? (right.createdAt ?? "") : (right.updatedAt ?? ""),
		) || 0;
	if (leftTime !== rightTime) return rightTime - leftTime;
	return compareStrings(left.title, right.title);
}

function compareStrings(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: "base" });
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
 * - Repo bucket order is driven by the user-controllable
 *   `repoSidebarOrder` field each row carries (mirrored from
 *   `repos.display_order` on the backend). Ties fall back to first-seen
 *   order so legacy rows without an order still surface stably.
 * - Rows inside each repo bucket sort by `displayOrder` — the single
 *   sparse order shared with status grouping.
 */
export function regroupByRepo(groups: WorkspaceGroup[]): WorkspaceGroup[] {
	const head: WorkspaceGroup[] = []; // pinned
	const tail: WorkspaceGroup[] = []; // backlog
	const firstSeen = new Map<string, number>();
	const bucketOrder = new Map<string, number>();
	const repoBuckets = new Map<
		string,
		{ label: string; rows: WorkspaceRow[] }
	>();

	let seen = 0;
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
				firstSeen.set(bucketId, seen++);
			}
			bucket.rows.push(row);
			// Lowest non-zero `repoSidebarOrder` across the bucket's rows is
			// the canonical bucket order. They should all agree (a single
			// repo's `repos.display_order` is broadcast to every row), but
			// taking the min keeps us robust to mid-flight optimistic edits.
			const candidate = row.repoSidebarOrder ?? 0;
			if (candidate > 0) {
				const current = bucketOrder.get(bucketId);
				if (current === undefined || candidate < current) {
					bucketOrder.set(bucketId, candidate);
				}
			}
		}
	}

	for (const bucket of repoBuckets.values()) {
		bucket.rows.sort(compareRepoRows);
	}

	const sortedBucketIds = Array.from(repoBuckets.keys()).sort((left, right) => {
		const leftOrder = bucketOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
		const rightOrder = bucketOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
		if (leftOrder !== rightOrder) return leftOrder - rightOrder;
		return (firstSeen.get(left) ?? 0) - (firstSeen.get(right) ?? 0);
	});

	const repoGroups: WorkspaceGroup[] = sortedBucketIds.map((bucketId) => {
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

function compareRepoRows(left: WorkspaceRow, right: WorkspaceRow) {
	const leftOrder = left.displayOrder ?? 0;
	const rightOrder = right.displayOrder ?? 0;
	if (leftOrder !== rightOrder) return leftOrder - rightOrder;

	const leftCreated = Date.parse(left.createdAt ?? "") || 0;
	const rightCreated = Date.parse(right.createdAt ?? "") || 0;
	if (leftCreated !== rightCreated) return rightCreated - leftCreated;

	return 0;
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
