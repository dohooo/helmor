import { memo } from "react";
import { openWorkspaceInFinder } from "@/lib/api";
import { extractError } from "@/lib/errors";
import { useWorkspacesSidebarController } from "./hooks/use-controller";
import { WorkspacesSidebar } from "./index";

type WorkspaceToastVariant = "default" | "destructive";

type WorkspacesSidebarContainerProps = {
	selectedWorkspaceId: string | null;
	autoSelectEnabled?: boolean;
	busyWorkspaceIds?: Set<string>;
	interactionRequiredWorkspaceIds?: Set<string>;
	newWorkspaceShortcut?: string | null;
	addRepositoryShortcut?: string | null;
	onSelectWorkspace: (workspaceId: string | null) => void;
	onOpenNewWorkspace?: () => void;
	onAddRepositoryNeedsStart?: (repositoryId: string) => void;
	onMoveLocalToWorktree?: (workspaceId: string) => void;
	pushWorkspaceToast: (
		description: string,
		title?: string,
		variant?: WorkspaceToastVariant,
		opts?: {
			action?: { label: string; onClick: () => void; destructive?: boolean };
			persistent?: boolean;
		},
	) => void;
};

export const WorkspacesSidebarContainer = memo(
	function WorkspacesSidebarContainer({
		selectedWorkspaceId,
		autoSelectEnabled = true,
		busyWorkspaceIds,
		interactionRequiredWorkspaceIds,
		newWorkspaceShortcut,
		addRepositoryShortcut,
		onSelectWorkspace,
		onOpenNewWorkspace,
		onAddRepositoryNeedsStart,
		onMoveLocalToWorktree,
		pushWorkspaceToast,
	}: WorkspacesSidebarContainerProps) {
		const {
			addingRepository,
			archivingWorkspaceIds,
			archivedRows,
			creatingWorkspaceRepoId,
			cloneDefaultDirectory,
			groups,
			sidebarGrouping,
			handleAddRepository,
			handleArchiveWorkspace,
			handleCloneFromUrl,
			handleDeleteWorkspace,
			handleMarkWorkspaceUnread,
			handleMoveRepositoryInSidebar,
			handleMoveWorkspaceInSidebar,
			handleOpenCloneDialog,
			handleRestoreWorkspace,
			handleSelectWorkspace,
			handleSetWorkspaceStatus,
			handleTogglePin,
			isCloneDialogOpen,
			prefetchWorkspace,
			setIsCloneDialogOpen,
		} = useWorkspacesSidebarController({
			selectedWorkspaceId,
			autoSelectEnabled,
			onSelectWorkspace,
			onOpenNewWorkspace,
			onAddRepositoryNeedsStart,
			pushWorkspaceToast,
		});

		return (
			<WorkspacesSidebar
				groups={groups}
				archivedRows={archivedRows}
				sidebarGrouping={sidebarGrouping}
				addingRepository={addingRepository}
				archivingWorkspaceIds={archivingWorkspaceIds}
				selectedWorkspaceId={selectedWorkspaceId}
				busyWorkspaceIds={busyWorkspaceIds}
				interactionRequiredWorkspaceIds={interactionRequiredWorkspaceIds}
				newWorkspaceShortcut={newWorkspaceShortcut}
				addRepositoryShortcut={addRepositoryShortcut}
				creatingWorkspaceRepoId={creatingWorkspaceRepoId}
				onAddRepository={() => {
					void handleAddRepository();
				}}
				onOpenCloneDialog={handleOpenCloneDialog}
				isCloneDialogOpen={isCloneDialogOpen}
				onCloneDialogOpenChange={setIsCloneDialogOpen}
				cloneDefaultDirectory={cloneDefaultDirectory}
				onSubmitClone={handleCloneFromUrl}
				onSelectWorkspace={handleSelectWorkspace}
				onPrefetchWorkspace={prefetchWorkspace}
				onOpenNewWorkspace={onOpenNewWorkspace}
				onCreateWorkspaceForRepo={onAddRepositoryNeedsStart}
				onArchiveWorkspace={handleArchiveWorkspace}
				onMoveLocalToWorktree={onMoveLocalToWorktree}
				onMarkWorkspaceUnread={handleMarkWorkspaceUnread}
				onRestoreWorkspace={handleRestoreWorkspace}
				onDeleteWorkspace={handleDeleteWorkspace}
				onOpenInFinder={(workspaceId) => {
					void openWorkspaceInFinder(workspaceId).catch((error) => {
						const { message } = extractError(error, "Failed to open Finder");
						pushWorkspaceToast(message, "Failed to open Finder", "destructive");
					});
				}}
				onTogglePin={(workspaceId, pinned) => {
					void handleTogglePin(workspaceId, pinned);
				}}
				onMoveWorkspaceInSidebar={(
					workspaceId,
					targetGroupId,
					beforeWorkspaceId,
				) => {
					void handleMoveWorkspaceInSidebar(
						workspaceId,
						targetGroupId,
						beforeWorkspaceId,
					);
				}}
				onMoveRepositoryInSidebar={(repoId, beforeRepoId) => {
					void handleMoveRepositoryInSidebar(repoId, beforeRepoId);
				}}
				onSetWorkspaceStatus={(workspaceId, status) => {
					void handleSetWorkspaceStatus(workspaceId, status);
				}}
			/>
		);
	},
);
