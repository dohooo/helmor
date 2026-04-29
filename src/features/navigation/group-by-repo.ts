import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";

const UNKNOWN_REPO_KEY = "__unknown__";
const UNKNOWN_REPO_LABEL = "Uncategorized";

export type RepoGroup = {
	id: string;
	repoKey: string;
	label: string;
	repoIconSrc: string | null;
	repoInitials: string | null;
	totalCount: number;
	statusGroups: WorkspaceGroup[];
};

export type RepoGroupedSidebar = {
	pinned: WorkspaceGroup | null;
	repos: RepoGroup[];
};

export function repoSectionId(repoKey: string): string {
	return `repo:${repoKey}`;
}

export function repoStatusSectionId(
	repoKey: string,
	statusGroupId: string,
): string {
	return `repo:${repoKey}:${statusGroupId}`;
}

/**
 * Re-buckets the canonical (status-keyed) sidebar groups into a repo-keyed
 * hierarchy where each repo contains the same status groups, but only with
 * rows from that repository.
 *
 * The pinned group (if any non-empty) is returned separately so the UI can
 * keep it as a top-level section regardless of repo membership.
 */
export function groupByRepo(groups: WorkspaceGroup[]): RepoGroupedSidebar {
	let pinned: WorkspaceGroup | null = null;
	const repoMap = new Map<string, RepoGroup>();
	// Preserve the order of status groups as they arrive from the server.
	const statusOrder: string[] = [];

	for (const group of groups) {
		if (group.id === "pinned") {
			pinned = group.rows.length > 0 ? group : null;
			continue;
		}

		if (!statusOrder.includes(group.id)) {
			statusOrder.push(group.id);
		}

		for (const row of group.rows) {
			const repoKey = row.repoName?.trim() ? row.repoName : UNKNOWN_REPO_KEY;
			const repoLabel = row.repoName?.trim()
				? row.repoName
				: UNKNOWN_REPO_LABEL;

			let repoGroup = repoMap.get(repoKey);
			if (!repoGroup) {
				repoGroup = {
					id: repoSectionId(repoKey),
					repoKey,
					label: repoLabel,
					repoIconSrc: row.repoIconSrc ?? null,
					repoInitials: row.repoInitials ?? null,
					totalCount: 0,
					statusGroups: [],
				};
				repoMap.set(repoKey, repoGroup);
			}

			let statusGroup = repoGroup.statusGroups.find((g) => g.id === group.id);
			if (!statusGroup) {
				statusGroup = {
					id: group.id,
					label: group.label,
					tone: group.tone,
					rows: [],
				};
				repoGroup.statusGroups.push(statusGroup);
			}
			statusGroup.rows.push(row);
			repoGroup.totalCount += 1;

			// Some rows may be missing icon metadata while others in the same repo
			// have it. Use the first non-empty value we encounter.
			if (!repoGroup.repoIconSrc && row.repoIconSrc) {
				repoGroup.repoIconSrc = row.repoIconSrc;
			}
			if (!repoGroup.repoInitials && row.repoInitials) {
				repoGroup.repoInitials = row.repoInitials;
			}
		}
	}

	// Sort status groups inside each repo according to the canonical order.
	for (const repoGroup of repoMap.values()) {
		repoGroup.statusGroups.sort(
			(a, b) => statusOrder.indexOf(a.id) - statusOrder.indexOf(b.id),
		);
	}

	const repos = Array.from(repoMap.values()).sort((a, b) => {
		// Always push the "Uncategorized" bucket to the bottom.
		if (a.repoKey === UNKNOWN_REPO_KEY) return 1;
		if (b.repoKey === UNKNOWN_REPO_KEY) return -1;
		return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
	});

	return { pinned, repos };
}

export function findSelectedRepoSection(
	selectedWorkspaceId: string | null | undefined,
	repoGroups: RepoGroup[],
): { repoSectionId: string; statusSectionId: string } | null {
	if (!selectedWorkspaceId) {
		return null;
	}

	for (const repoGroup of repoGroups) {
		for (const statusGroup of repoGroup.statusGroups) {
			if (
				statusGroup.rows.some(
					(row: WorkspaceRow) => row.id === selectedWorkspaceId,
				)
			) {
				return {
					repoSectionId: repoGroup.id,
					statusSectionId: repoStatusSectionId(
						repoGroup.repoKey,
						statusGroup.id,
					),
				};
			}
		}
	}

	return null;
}
