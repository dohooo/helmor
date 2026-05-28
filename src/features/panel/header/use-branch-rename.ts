// Branch rename + copy-to-clipboard state for the workspace panel header.
// Owns the in-place rename input value + the optimistic cache patch on
// commit. Rolls back the patch + surfaces a toast if the backend rename
// fails.
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { renameWorkspaceBranch, type WorkspaceDetail } from "@/lib/api";
import { extractError } from "@/lib/errors";
import { helmorQueryKeys } from "@/lib/query-client";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { normalizeBranchRenameInput } from "../branch-rename";

export type BranchRenameController = {
	editingBranch: string | null;
	branchCopied: boolean;
	setEditingBranch(value: string | null): void;
	startBranchRename(): void;
	commitBranchRename(): Promise<void>;
	cancelBranchRename(): void;
	copyBranchName(): void;
};

export function useBranchRename({
	workspace,
	queryClient,
	pushToast,
	onWorkspaceChanged,
}: {
	workspace: WorkspaceDetail | null;
	queryClient: QueryClient;
	pushToast: PushWorkspaceToast;
	onWorkspaceChanged?: () => void;
}): BranchRenameController {
	const [editingBranch, setEditingBranch] = useState<string | null>(null);
	const [branchCopied, setBranchCopied] = useState(false);

	const startBranchRename = useCallback(() => {
		if (!workspace?.branch) return;
		setEditingBranch(workspace.branch);
	}, [workspace?.branch]);

	const commitBranchRename = useCallback(async () => {
		if (editingBranch === null || !workspace) return;
		const normalized = normalizeBranchRenameInput(editingBranch);
		if (normalized && normalized !== workspace.branch) {
			const detailKey = helmorQueryKeys.workspaceDetail(workspace.id);
			const previous = queryClient.getQueryData<WorkspaceDetail | null>(
				detailKey,
			);
			if (previous) {
				queryClient.setQueryData<WorkspaceDetail | null>(detailKey, {
					...previous,
					branch: normalized,
				});
			}
			try {
				await renameWorkspaceBranch(workspace.id, normalized);
				onWorkspaceChanged?.();
			} catch (error: unknown) {
				if (previous) {
					queryClient.setQueryData<WorkspaceDetail | null>(detailKey, previous);
				}
				const { message } = extractError(error, "Unable to rename branch.");
				pushToast(message, "Branch rename failed", "destructive");
			}
		}
		setEditingBranch(null);
	}, [editingBranch, onWorkspaceChanged, pushToast, queryClient, workspace]);

	const cancelBranchRename = useCallback(() => {
		setEditingBranch(null);
	}, []);

	const copyBranchName = useCallback(() => {
		if (!workspace?.branch) return;
		void navigator.clipboard.writeText(workspace.branch);
		setBranchCopied(true);
		setTimeout(() => setBranchCopied(false), 1500);
	}, [workspace?.branch]);

	return {
		editingBranch,
		branchCopied,
		setEditingBranch,
		startBranchRename,
		commitBranchRename,
		cancelBranchRename,
		copyBranchName,
	};
}
