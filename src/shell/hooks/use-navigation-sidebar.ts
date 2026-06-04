import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	applySidebarView,
	regroupByRepo,
} from "@/features/navigation/sidebar-projection";
import {
	archivedWorkspacesQueryOptions,
	repositoriesQueryOptions,
	workspaceGroupsQueryOptions,
} from "@/lib/query-client";
import type { AppSettings } from "@/lib/settings";
import { summaryToArchivedRow } from "@/lib/workspace-helpers";

/**
 * Navigation data layer: workspace groups / archived rows / repositories,
 * projected through the same repo-bucketing + sort the sidebar renders.
 * Extracted verbatim from AppShell (Phase 1 split).
 *
 * Returns only what AppShell downstream actually consumes (workspaceGroups /
 * archivedRows / repositories). availableRepoIds, baseWorkspaceGroups,
 * rawArchivedRows and the navigationSidebar projection stay internal.
 */
export function useNavigationSidebar(appSettings: AppSettings) {
	const navigationGroupsQuery = useQuery(workspaceGroupsQueryOptions());
	const navigationArchivedQuery = useQuery(archivedWorkspacesQueryOptions());
	const baseWorkspaceGroups = navigationGroupsQuery.data ?? [];
	const repositoriesQuery = useQuery(repositoriesQueryOptions());
	const repositories = repositoriesQuery.data ?? [];
	const availableRepoIds = useMemo(
		() => repositories.map((repository) => repository.id),
		[repositories],
	);
	const rawArchivedRows = useMemo(
		() => (navigationArchivedQuery.data ?? []).map(summaryToArchivedRow),
		[navigationArchivedQuery.data],
	);
	// Project the raw status-grouped query result through the same
	// repo-bucketing step the sidebar applies for rendering, so callers
	// downstream (selection controller's keyboard navigation, workspace
	// warmup) see groups in the order the user actually sees them on
	// screen. Without this, repo grouping mode keeps the raw status
	// buckets and up/down keys jump in seemingly random order.
	const navigationSidebar = useMemo(() => {
		const groups =
			appSettings.sidebarGrouping === "repo"
				? regroupByRepo(baseWorkspaceGroups)
				: baseWorkspaceGroups;
		return applySidebarView(
			{ groups, archivedRows: rawArchivedRows },
			{
				availableRepoIds,
				repoFilterIds: appSettings.sidebarRepoFilterIds,
				sort: appSettings.sidebarSort,
			},
		);
	}, [
		appSettings.sidebarGrouping,
		appSettings.sidebarRepoFilterIds,
		appSettings.sidebarSort,
		availableRepoIds,
		baseWorkspaceGroups,
		rawArchivedRows,
	]);
	return {
		repositories,
		workspaceGroups: navigationSidebar.groups,
		archivedRows: navigationSidebar.archivedRows,
	};
}
