import { CloudIcon, LaptopIcon } from "lucide-react";
import { useMemo } from "react";
import { INDEX_REF } from "@/lib/editor-session";
import type { ChangeListGroup, ChangeRow } from "./types";

export function useChangeGroups({
	stagedChanges,
	unstagedChanges,
	committedChanges,
	branchSwitching,
	stagedOpen,
	changesOpen,
	branchDiffOpen,
	changesTreeView,
	branchDiffTreeView,
	toggleStagedOpen,
	toggleChangesOpen,
	toggleBranchDiffOpen,
	toggleChangesTreeView,
	toggleBranchDiffTreeView,
	stageFile,
	unstageFile,
	stageAll,
	unstageAll,
	discardFile,
	workspaceTargetBranch,
}: {
	stagedChanges: ChangeRow[];
	unstagedChanges: ChangeRow[];
	committedChanges: ChangeRow[];
	branchSwitching: boolean;
	stagedOpen: boolean;
	changesOpen: boolean;
	branchDiffOpen: boolean;
	changesTreeView: boolean;
	branchDiffTreeView: boolean;
	toggleStagedOpen: () => void;
	toggleChangesOpen: () => void;
	toggleBranchDiffOpen: () => void;
	toggleChangesTreeView: () => void;
	toggleBranchDiffTreeView: () => void;
	stageFile: (path: string) => void;
	unstageFile: (path: string) => void;
	stageAll: () => void;
	unstageAll: () => void;
	discardFile: (path: string) => void;
	workspaceTargetBranch: string | null;
}) {
	return useMemo<ChangeListGroup[]>(() => {
		const groups: ChangeListGroup[] = [];
		if (stagedChanges.length > 0) {
			groups.push({
				id: "staged",
				label: "Staged Changes",
				count: stagedChanges.length,
				open: stagedOpen,
				onToggle: toggleStagedOpen,
				changes: stagedChanges,
				treeView: changesTreeView,
				onToggleTreeView: toggleChangesTreeView,
				action: "unstage",
				onStageAction: unstageFile,
				onBatchAction: unstageAll,
				originalRef: "HEAD",
				modifiedRef: INDEX_REF,
			});
		}
		if (unstagedChanges.length > 0) {
			groups.push({
				id: "unstaged",
				label: "Changes",
				icon: (
					<LaptopIcon
						className="size-3 shrink-0 text-muted-foreground"
						strokeWidth={2}
					/>
				),
				count: unstagedChanges.length,
				open: changesOpen,
				onToggle: toggleChangesOpen,
				changes: unstagedChanges,
				treeView: changesTreeView,
				onToggleTreeView: toggleChangesTreeView,
				action: "stage",
				onStageAction: stageFile,
				onBatchAction: stageAll,
				onDiscard: discardFile,
				originalRef: INDEX_REF,
			});
		}
		if (committedChanges.length > 0 || branchSwitching) {
			groups.push({
				id: "branch",
				label: "Remote",
				icon: (
					<CloudIcon
						className="size-3 shrink-0 text-muted-foreground"
						strokeWidth={2}
					/>
				),
				count: committedChanges.length,
				loading: branchSwitching,
				open: branchDiffOpen,
				onToggle: toggleBranchDiffOpen,
				changes: committedChanges,
				treeView: branchDiffTreeView,
				onToggleTreeView: toggleBranchDiffTreeView,
				originalRef: workspaceTargetBranch ?? undefined,
				modifiedRef: "HEAD",
			});
		}
		return groups;
	}, [
		branchDiffOpen,
		branchDiffTreeView,
		branchSwitching,
		changesOpen,
		changesTreeView,
		committedChanges,
		discardFile,
		stageAll,
		stageFile,
		stagedChanges,
		stagedOpen,
		toggleBranchDiffOpen,
		toggleBranchDiffTreeView,
		toggleChangesOpen,
		toggleChangesTreeView,
		toggleStagedOpen,
		unstageAll,
		unstageFile,
		unstagedChanges,
		workspaceTargetBranch,
	]);
}
