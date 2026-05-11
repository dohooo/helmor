// Pull-latest action: rebases the workspace branch onto its target,
// surfacing the outcome via toast and invalidating the relevant queries.
import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { syncWorkspaceWithTargetBranch } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";

export function usePullLatest(opts: {
	queryClient: QueryClient;
	selectedWorkspaceId: string | null;
}): () => Promise<void> {
	const { queryClient, selectedWorkspaceId } = opts;

	return useCallback(async () => {
		if (!selectedWorkspaceId) return;
		try {
			const result = await syncWorkspaceWithTargetBranch(selectedWorkspaceId);
			if (result.outcome === "updated") {
				toast.success(`Pulled latest from ${result.targetBranch}`);
			} else if (result.outcome === "alreadyUpToDate") {
				toast(`Already up to date with ${result.targetBranch}`);
			} else {
				toast.error(`Pull from ${result.targetBranch} needs attention`);
			}
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Unable to pull target branch updates.",
			);
		} finally {
			requestSidebarReconcile(queryClient);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey:
						helmorQueryKeys.workspaceGitActionStatus(selectedWorkspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceChangeRequest(selectedWorkspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey:
						helmorQueryKeys.workspaceForgeActionStatus(selectedWorkspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(selectedWorkspaceId),
				}),
				queryClient.invalidateQueries({ queryKey: ["workspaceChanges"] }),
			]);
		}
	}, [queryClient, selectedWorkspaceId]);
}
