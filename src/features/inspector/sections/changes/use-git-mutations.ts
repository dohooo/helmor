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
			queryKey: helmorQueryKeys.workspaceChanges(workspaceRootPath),
		});
		if (workspaceId) {
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGitActionStatus(workspaceId),
			});
		}
	}, [queryClient, workspaceId, workspaceRootPath]);

	const surfaceChangeError = useCallback(
		(action: string, error: unknown) => {
			const { code, message } = extractError(error, `Failed to ${action}.`);
			if (isRecoverableByPurge(code) && workspaceId) {
				showWorkspaceBrokenToast({
					workspaceId,
					pushToast,
					queryClient,
				});
				return;
			}
			pushToast(message, `Unable to ${action}`, "destructive");
		},
		[pushToast, queryClient, workspaceId],
	);

	const stageFile = useCallback(
		async (relativePath: string) => {
			if (!workspaceRootPath) return;
			try {
				await stageWorkspaceFile(workspaceRootPath, relativePath);
			} catch (error) {
				surfaceChangeError("stage file", error);
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
				surfaceChangeError("unstage file", error);
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
			surfaceChangeError("stage files", error);
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
			surfaceChangeError("unstage files", error);
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
				surfaceChangeError("discard changes", error);
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
			pushToast(`Workspace moved to ${result.branch}.`, "Continued", "default");
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
			surfaceChangeError("continue workspace", error);
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
