// Stage / unstage / discard / continue-workspace mutations for the
// Changes section. All routes surface errors through the workspace toast
// bus and trigger a single `invalidateChanges` afterwards. Broken
// workspaces (recognised via `isRecoverableByPurge`) surface a persistent
// "Permanently Delete" toast instead of a transient error.
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
	continueWorkspaceFromTargetBranch,
	discardWorkspaceFile,
	stageWorkspaceFile,
	unstageWorkspaceFile,
} from "@/lib/api";
import type { InspectorFileItem } from "@/lib/editor-session";
import { extractError, isRecoverableByPurge } from "@/lib/errors";
import { formatSource, translateSource } from "@/lib/i18n";
import { helmorQueryKeys } from "@/lib/query-client";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import { showWorkspaceBrokenToast } from "@/lib/workspace-broken-toast";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";

type ChangeRow = InspectorFileItem & {
	insertions: number;
	deletions: number;
};

export type GitMutationsController = {
	isContinuingWorkspace: boolean;
	stageFile(relativePath: string): Promise<void>;
	unstageFile(relativePath: string): Promise<void>;
	stageAll(): Promise<void>;
	unstageAll(): Promise<void>;
	discardFile(relativePath: string): Promise<void>;
	continueWorkspace(): Promise<void>;
};

export function useGitMutations({
	workspaceId,
	workspaceRootPath,
	stagedChanges,
	unstagedChanges,
	queryClient,
	pushToast,
}: {
	workspaceId: string | null;
	workspaceRootPath: string | null;
	stagedChanges: ChangeRow[];
	unstagedChanges: ChangeRow[];
	queryClient: QueryClient;
	pushToast: PushWorkspaceToast;
}): GitMutationsController {
	const [isContinuingWorkspace, setIsContinuingWorkspace] = useState(false);

	const invalidateChanges = useCallback(() => {
		if (!workspaceRootPath) return;
		queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.workspaceChanges(
				workspaceRootPath,
				workspaceId,
			),
		});
		if (workspaceId) {
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGitActionStatus(workspaceId),
			});
		}
	}, [queryClient, workspaceId, workspaceRootPath]);

	const surfaceChangeError = useCallback(
		(actionKey: string, error: unknown) => {
			const action = translateSource(actionKey);
			const { code, message } = extractError(
				error,
				formatSource("inspectorFailedToAction", { action }),
			);
			if (isRecoverableByPurge(code) && workspaceId) {
				showWorkspaceBrokenToast({
					workspaceId,
					pushToast,
					queryClient,
				});
				return;
			}
			pushToast(
				message,
				formatSource("inspectorUnableToAction", { action }),
				"destructive",
			);
		},
		[pushToast, queryClient, workspaceId],
	);

	const stageFile = useCallback(
		async (relativePath: string) => {
			if (!workspaceRootPath) return;
			try {
				await stageWorkspaceFile(workspaceRootPath, relativePath);
			} catch (error) {
				surfaceChangeError("inspectorActionStageFile", error);
			} finally {
				invalidateChanges();
			}
		},
		[invalidateChanges, surfaceChangeError, workspaceRootPath],
	);

	const unstageFile = useCallback(
		async (relativePath: string) => {
			if (!workspaceRootPath) return;
			try {
				await unstageWorkspaceFile(workspaceRootPath, relativePath);
			} catch (error) {
				surfaceChangeError("inspectorActionUnstageFile", error);
			} finally {
				invalidateChanges();
			}
		},
		[invalidateChanges, surfaceChangeError, workspaceRootPath],
	);

	const stageAll = useCallback(async () => {
		if (!workspaceRootPath) return;
		const paths = unstagedChanges.map((change) => change.path);
		try {
			for (const path of paths) {
				await stageWorkspaceFile(workspaceRootPath, path);
			}
		} catch (error) {
			surfaceChangeError("inspectorActionStageFiles", error);
		} finally {
			invalidateChanges();
		}
	}, [
		invalidateChanges,
		surfaceChangeError,
		unstagedChanges,
		workspaceRootPath,
	]);

	const unstageAll = useCallback(async () => {
		if (!workspaceRootPath) return;
		const paths = stagedChanges.map((change) => change.path);
		try {
			for (const path of paths) {
				await unstageWorkspaceFile(workspaceRootPath, path);
			}
		} catch (error) {
			surfaceChangeError("inspectorActionUnstageFiles", error);
		} finally {
			invalidateChanges();
		}
	}, [invalidateChanges, stagedChanges, surfaceChangeError, workspaceRootPath]);

	const discardFile = useCallback(
		async (relativePath: string) => {
			if (!workspaceRootPath) return;
			try {
				await discardWorkspaceFile(workspaceRootPath, relativePath);
			} catch (error) {
				surfaceChangeError("inspectorActionDiscardChanges", error);
			} finally {
				invalidateChanges();
			}
		},
		[invalidateChanges, surfaceChangeError, workspaceRootPath],
	);

	const continueWorkspace = useCallback(async () => {
		if (!workspaceId || isContinuingWorkspace) return;
		setIsContinuingWorkspace(true);
		try {
			const result = await continueWorkspaceFromTargetBranch(workspaceId);
			pushToast(
				formatSource("inspectorWorkspaceMovedTo", { branch: result.branch }),
				translateSource("inspectorContinued"),
				"default",
			);
			requestSidebarReconcile(queryClient);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGitActionStatus(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceChangeRequest(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceForgeActionStatus(workspaceId),
				}),
			]);
			invalidateChanges();
		} catch (error) {
			surfaceChangeError("inspectorActionContinueWorkspace", error);
		} finally {
			setIsContinuingWorkspace(false);
		}
	}, [
		invalidateChanges,
		isContinuingWorkspace,
		pushToast,
		queryClient,
		surfaceChangeError,
		workspaceId,
	]);

	return {
		isContinuingWorkspace,
		stageFile,
		unstageFile,
		stageAll,
		unstageAll,
		discardFile,
		continueWorkspace,
	};
}
