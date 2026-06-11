import { memo, useCallback, useEffect, useRef } from "react";
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
	sidebarFilterShortcut?: string | null;
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
		sidebarFilterShortcut,
		onSelectWorkspace,
		onOpenNewWorkspace,
		onAddRepositoryNeedsStart,
		onMoveLocalToWorktree,
		pushWorkspaceToast,
	}: WorkspacesSidebarContainerProps) {
		const selectFrameRef = useRef<number | null>(null);
		const selectTimeoutRef = useRef<number | null>(null);
		const {
			addingRepository,
			archivingWorkspaceIds,
			archivedRows,
			availableRepositories,
			creatingWorkspaceRepoId,
			cloneDefaultDirectory,
			groups,
			sidebarGrouping,
			sidebarRepoFilterIds,
			sidebarSort,
			updateSettings,
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
		const cancelScheduledSelection = useCallback(() => {
			if (selectFrameRef.current !== null) {
				window.cancelAnimationFrame(selectFrameRef.current);
				selectFrameRef.current = null;
			}
			if (selectTimeoutRef.current !== null) {
				window.clearTimeout(selectTimeoutRef.current);
				selectTimeoutRef.current = null;
			}
		}, []);
		useEffect(() => cancelScheduledSelection, [cancelScheduledSelection]);
		const handleDeferredSelectWorkspace = useCallback(
			(workspaceId: string) => {
				cancelScheduledSelection();
				if (workspaceId === selectedWorkspaceId) {
					handleSelectWorkspace(workspaceId);
					return;
				}
				// Let the sidebar paint before the workspace pane does heavier work.
				selectFrameRef.current = window.requestAnimationFrame(() => {
					selectFrameRef.current = null;
					selectTimeoutRef.current = window.setTimeout(() => {
						selectTimeoutRef.current = null;
						handleSelectWorkspace(workspaceId);
					}, 0);
				});
			},
			[cancelScheduledSelection, handleSelectWorkspace, selectedWorkspaceId],
		);

		return (
			<WorkspacesSidebar
				groups={groups}
				archivedRows={archivedRows}
				availableRepositories={availableRepositories}
				sidebarGrouping={sidebarGrouping}
				sidebarRepoFilterIds={sidebarRepoFilterIds}
				sidebarSort={sidebarSort}
				onSidebarGroupingChange={(sidebarGrouping) => {
					void updateSettings({ sidebarGrouping });
				}}
				onSidebarRepoFilterChange={(sidebarRepoFilterIds) => {
					void updateSettings({ sidebarRepoFilterIds });
				}}
				onSidebarSortChange={(sidebarSort) => {
					void updateSettings({ sidebarSort });
				}}
				addingRepository={addingRepository}
				archivingWorkspaceIds={archivingWorkspaceIds}
				selectedWorkspaceId={selectedWorkspaceId}
				busyWorkspaceIds={busyWorkspaceIds}
				interactionRequiredWorkspaceIds={interactionRequiredWorkspaceIds}
				newWorkspaceShortcut={newWorkspaceShortcut}
				addRepositoryShortcut={addRepositoryShortcut}
				sidebarFilterShortcut={sidebarFilterShortcut}
				creatingWorkspaceRepoId={creatingWorkspaceRepoId}
				onAddRepository={() => {
					void handleAddRepository();
				}}
				onOpenCloneDialog={handleOpenCloneDialog}
				isCloneDialogOpen={isCloneDialogOpen}
				onCloneDialogOpenChange={setIsCloneDialogOpen}
				cloneDefaultDirectory={cloneDefaultDirectory}
				onSubmitClone={handleCloneFromUrl}
				onSelectWorkspace={handleDeferredSelectWorkspace}
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
