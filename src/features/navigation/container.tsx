import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useMemo } from "react";
import { toast } from "sonner";
import {
	clearWorkspaceRuntimeBinding,
	listRemoteRuntimes,
	openWorkspaceInFinder,
	setWorkspaceRuntimeBinding,
} from "@/lib/api";
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

		// Track F1: list runtimes so the row's "Move to runtime"
		// submenu has choices to render. Refetches on focus so a
		// connect/disconnect from settings flows into the menu
		// without a manual refresh.
		const queryClient = useQueryClient();
		const runtimesQuery = useQuery({
			queryKey: ["remote-runtimes"],
			queryFn: listRemoteRuntimes,
			refetchOnWindowFocus: true,
		});
		const availableRuntimes = useMemo(
			() => (runtimesQuery.data ?? []).map((entry) => ({ name: entry.name })),
			[runtimesQuery.data],
		);
		const moveToRuntime = useMutation({
			mutationFn: async ({
				workspaceId,
				runtimeName,
			}: {
				workspaceId: string;
				runtimeName: string | null;
			}) => {
				if (runtimeName === null || runtimeName === "local") {
					await clearWorkspaceRuntimeBinding(workspaceId);
					return { workspaceId, runtimeName: null };
				}
				await setWorkspaceRuntimeBinding(workspaceId, runtimeName);
				return { workspaceId, runtimeName };
			},
			onSuccess: ({ runtimeName }) => {
				toast.success(
					runtimeName === null
						? "Moved to local runtime"
						: `Moved to ${runtimeName}`,
				);
				void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
				void queryClient.invalidateQueries({
					queryKey: ["workspace-runtime-bindings"],
				});
			},
			onError: (err) => {
				const { message } = extractError(err, "Failed to move workspace");
				toast.error(message);
			},
		});

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
				onMoveToRuntime={(workspaceId, runtimeName) =>
					moveToRuntime.mutate({ workspaceId, runtimeName })
				}
				availableRuntimes={availableRuntimes}
			/>
		);
	},
);
