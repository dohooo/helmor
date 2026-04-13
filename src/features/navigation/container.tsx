import { memo } from "react";
import { useWorkspacesSidebarController } from "./hooks/use-controller";
import { WorkspacesSidebar } from "./index";

type WorkspaceToastVariant = "default" | "destructive";

type WorkspacesSidebarContainerProps = {
	selectedWorkspaceId: string | null;
	sendingWorkspaceIds?: Set<string>;
	completedWorkspaceIds?: Set<string>;
	interactionRequiredWorkspaceIds?: Set<string>;
	onSelectWorkspace: (workspaceId: string | null) => void;
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
		sendingWorkspaceIds,
		completedWorkspaceIds,
		interactionRequiredWorkspaceIds,
		onSelectWorkspace,
		pushWorkspaceToast,
	}: WorkspacesSidebarContainerProps) {
		const {
			addingRepository,
			archivedRows,
			availableRepositories,
			creatingWorkspaceRepoId,
			groups,
			handleAddRepository,
			handleArchiveWorkspace,
			handleCreateWorkspaceFromRepo,
			handleDeleteWorkspace,
			handleMarkWorkspaceUnread,
			handleRestoreWorkspace,
			handleSelectWorkspace,
			handleSetManualStatus,
			handleTogglePin,
			prefetchWorkspace,
		} = useWorkspacesSidebarController({
			selectedWorkspaceId,
			onSelectWorkspace,
			pushWorkspaceToast,
		});

		return (
			<WorkspacesSidebar
				groups={groups}
				archivedRows={archivedRows}
				availableRepositories={availableRepositories}
				addingRepository={addingRepository}
				selectedWorkspaceId={selectedWorkspaceId}
				sendingWorkspaceIds={sendingWorkspaceIds}
				completedWorkspaceIds={completedWorkspaceIds}
				interactionRequiredWorkspaceIds={interactionRequiredWorkspaceIds}
				creatingWorkspaceRepoId={creatingWorkspaceRepoId}
				onAddRepository={() => {
					void handleAddRepository();
				}}
				onSelectWorkspace={handleSelectWorkspace}
				onPrefetchWorkspace={prefetchWorkspace}
				onCreateWorkspace={(repoId) => {
					void handleCreateWorkspaceFromRepo(repoId);
				}}
				onArchiveWorkspace={handleArchiveWorkspace}
				onMarkWorkspaceUnread={handleMarkWorkspaceUnread}
				onRestoreWorkspace={handleRestoreWorkspace}
				onDeleteWorkspace={handleDeleteWorkspace}
				onTogglePin={(workspaceId, pinned) => {
					void handleTogglePin(workspaceId, pinned);
				}}
				onSetManualStatus={(workspaceId, status) => {
					void handleSetManualStatus(workspaceId, status);
				}}
			/>
		);
	},
);
