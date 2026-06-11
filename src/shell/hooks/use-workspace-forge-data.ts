import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useRefreshForgeOnWorkspaceSwitch } from "@/features/inspector/hooks/use-refresh-forge-on-switch";
import type { WorkspaceDetail } from "@/lib/api";
import {
	helmorQueryKeys,
	workspaceChangeRequestQueryOptions,
	workspaceDetailQueryOptions,
	workspaceForgeActionStatusQueryOptions,
	workspaceForgeQueryOptions,
	workspaceGitActionStatusQueryOptions,
} from "@/lib/query-client";

/**
 * Owns the workspace-detail + forge/git query cluster AppShell hangs off the
 * selected workspace: the detail query (and the `workspaceRootPath` derived
 * from it, which feeds the editor session controller), forge detection, the
 * change-request / PR query, the forge + git action-status queries, and the
 * `useRefreshForgeOnWorkspaceSwitch` nudge. Extracted verbatim from AppShell.
 *
 * Call this AFTER the selection controller (it needs `selectedWorkspaceId`) and
 * BEFORE `useEditorSessionController` (it produces `workspaceRootPath`).
 * Dependency arrays and `enabled` predicates are preserved exactly as the
 * original inline queries.
 */
export function useWorkspaceForgeData({
	queryClient,
	selectedWorkspaceId,
}: {
	queryClient: QueryClient;
	selectedWorkspaceId: string | null;
}) {
	const selectedWorkspaceDetailQuery = useQuery({
		...workspaceDetailQueryOptions(selectedWorkspaceId ?? "__none__"),
		enabled: selectedWorkspaceId !== null,
	});
	const selectedWorkspaceDetail =
		selectedWorkspaceDetailQuery.data ??
		(selectedWorkspaceId
			? queryClient.getQueryData<WorkspaceDetail | null>(
					helmorQueryKeys.workspaceDetail(selectedWorkspaceId),
				)
			: null) ??
		null;
	const workspaceRootPath =
		selectedWorkspaceDetail?.state === "archived"
			? null
			: (selectedWorkspaceDetail?.rootPath ?? null);

	const workspaceForgeQuery = useQuery({
		...workspaceForgeQueryOptions(selectedWorkspaceId ?? "__none__"),
		enabled: selectedWorkspaceId !== null,
	});
	const workspaceForge = workspaceForgeQuery.data ?? null;
	const workspaceForgeProvider = workspaceForge?.provider ?? "unknown";
	const workspaceForgeQueriesEnabled =
		selectedWorkspaceId !== null &&
		selectedWorkspaceDetail?.state !== "archived" &&
		(workspaceForgeProvider === "gitlab" ||
			workspaceForgeProvider === "github");

	// Seed the change-request query with whatever PR snapshot is already
	// persisted on the workspace row. Lets the inspector render the PR badge
	// optimistically on first visit, before the live forge query returns.
	const workspaceChangeRequestSeed = useMemo(
		() => ({
			prSyncState: selectedWorkspaceDetail?.prSyncState,
			prUrl: selectedWorkspaceDetail?.prUrl ?? null,
			prTitle: selectedWorkspaceDetail?.prTitle ?? null,
		}),
		[
			selectedWorkspaceDetail?.prSyncState,
			selectedWorkspaceDetail?.prUrl,
			selectedWorkspaceDetail?.prTitle,
		],
	);
	const workspaceChangeRequestQuery = useQuery({
		...workspaceChangeRequestQueryOptions(
			selectedWorkspaceId ?? "__none__",
			workspaceChangeRequestSeed,
		),
		enabled: workspaceForgeQueriesEnabled,
	});
	const workspaceChangeRequest = workspaceChangeRequestQuery.data ?? null;
	const pullRequestUrl =
		workspaceChangeRequest?.url || selectedWorkspaceDetail?.prUrl || null;

	const workspaceForgeActionStatusQuery = useQuery({
		...workspaceForgeActionStatusQueryOptions(
			selectedWorkspaceId ?? "__none__",
		),
		enabled: workspaceForgeQueriesEnabled,
	});
	const workspaceForgeActionStatus =
		workspaceForgeActionStatusQuery.data ?? null;

	// Drive the inspector's git-header shimmer. Only show it on the first
	// cold fetch — not on background refetches, and not while we're already
	// rendering a placeholder built from the persisted PR snapshot.
	const workspaceForgeIsRefreshing =
		(workspaceChangeRequestQuery.isFetching &&
			(workspaceChangeRequestQuery.data === undefined ||
				workspaceChangeRequestQuery.isPlaceholderData)) ||
		(workspaceForgeActionStatusQuery.isFetching &&
			workspaceForgeActionStatusQuery.data === undefined);

	const workspaceGitActionStatusQuery = useQuery({
		...workspaceGitActionStatusQueryOptions(selectedWorkspaceId ?? "__none__"),
		enabled:
			selectedWorkspaceId !== null &&
			selectedWorkspaceDetail?.state !== "archived",
	});
	const workspaceGitActionStatus = workspaceGitActionStatusQuery.data ?? null;

	// Nudge CI-progress refetch on workspace switch — `refetchOnMount: "always"`
	// doesn't fire on queryKey changes.
	useRefreshForgeOnWorkspaceSwitch(selectedWorkspaceId);

	return {
		selectedWorkspaceDetailQuery,
		selectedWorkspaceDetail,
		workspaceRootPath,
		workspaceForge,
		workspaceChangeRequest,
		pullRequestUrl,
		workspaceForgeActionStatus,
		workspaceForgeIsRefreshing,
		workspaceGitActionStatus,
	};
}
