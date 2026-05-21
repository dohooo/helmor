import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useMemo, useState } from "react";
import { toast } from "sonner";
import { MoveWorkspaceDialog } from "@/components/move-workspace-dialog";
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
		// Track F3: pending move target — set when the user picks a
		// remote runtime, opens the path-picker dialog. `null` means
		// no dialog open.
		const [pendingMove, setPendingMove] = useState<{
			workspaceId: string;
			runtimeName: string;
		} | null>(null);

		const moveToRuntime = useMutation({
			mutationFn: async ({
				workspaceId,
				runtimeName,
				remotePath,
			}: {
				workspaceId: string;
				runtimeName: string | null;
				remotePath?: string | null;
			}) => {
				if (runtimeName === null || runtimeName === "local") {
					await clearWorkspaceRuntimeBinding(workspaceId);
					return { workspaceId, runtimeName: null };
				}
				await setWorkspaceRuntimeBinding(
					workspaceId,
					runtimeName,
					remotePath ?? null,
				);
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
				setPendingMove(null);
			},
			onError: (err) => {
				const { message } = extractError(err, "Failed to move workspace");
				toast.error(message);
				setPendingMove(null);
			},
		});

		const handleMoveTo = (workspaceId: string, runtimeName: string | null) => {
			// Local target / clear binding: no path to ask about, fire
			// the mutation directly. Same behaviour as pre-F3.
			if (runtimeName === null || runtimeName === "local") {
				moveToRuntime.mutate({ workspaceId, runtimeName });
				return;
			}
			// Remote target: open the dialog so the operator can supply
			// the optional remote path. F2 wired the binding shape; F3
			// surfaces it from the move flow.
			setPendingMove({ workspaceId, runtimeName });
		};

		return (
			<>
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
							pushWorkspaceToast(
								message,
								"Failed to open Finder",
								"destructive",
							);
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
					onMoveToRuntime={handleMoveTo}
					availableRuntimes={availableRuntimes}
				/>
				<MoveWorkspaceDialog
					open={pendingMove !== null}
					onOpenChange={(open) => {
						if (!open) setPendingMove(null);
					}}
					workspaceId={pendingMove?.workspaceId ?? null}
					runtimeName={pendingMove?.runtimeName ?? null}
					onConfirm={({ runtimeName, remotePath }) => {
						if (!pendingMove) return;
						moveToRuntime.mutate({
							workspaceId: pendingMove.workspaceId,
							runtimeName,
							remotePath,
						});
					}}
				/>
			</>
		);
	},
);
