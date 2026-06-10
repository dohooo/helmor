// The `workspacePane` prop bag for `WorkspacePaneSurface`, assembled from the
// `useAppShellState` orchestration result. Shared by the main AppShell and the
// quick panel's QuickShell so the wiring can never drift between the two
// surfaces — only the header nodes (and any explicit overrides) differ.
import type { ComponentProps, ReactNode } from "react";
import type { useAppShellState } from "@/shell/hooks/use-app-shell-state";
import type { WorkspacePaneSurface } from "./workspace-pane-surface";

type AppShellState = ReturnType<typeof useAppShellState>;

export function buildWorkspacePaneProps({
	s,
	headerLeadingNode,
	headerActionsNode,
}: {
	s: AppShellState;
	headerLeadingNode: ReactNode;
	headerActionsNode: ReactNode;
}): ComponentProps<typeof WorkspacePaneSurface> {
	const { sel, data, panels } = s;
	return {
		workspaceViewMode: s.workspaceViewMode,
		editorSession: data.editorSession,
		workspaceRootPath: data.workspaceRootPath,
		appShortcuts: s.appSettings.shortcuts,
		sidebarCollapsed: panels.sidebarCollapsed,
		contextPanelOpen: sel.contextPanel.contextPanelOpen,
		handleEditorSessionChange: data.handleEditorSessionChange,
		editorSessionActions: data.editorSessionActions,
		repositories: s.repositories,
		selectionActions: sel.selectionActions,
		readStateActions: data.readStateActions,
		pendingQueueActions: data.pendingQueueActions,
		contextPanelActions: sel.contextPanelActions,
		startSurfaceActions: sel.startSurfaceActions,
		activeStreams: data.activeStreams,
		effectiveBusySessionIds: data.effectiveBusySessionIds,
		effectiveStoppableSessionIds: data.effectiveStoppableSessionIds,
		interactionRequiredSessionIds: data.interactionRequiredSessionIds,
		pendingComposerInserts: data.pendingComposerInserts,
		onSelectSession: sel.handleSelectSession,
		onRequestCloseSession: data.requestCloseSession,
		handlePendingPromptConsumed: data.handlePendingPromptConsumed,
		queuePendingPromptForSession: data.queuePendingPromptForSession,
		startRepository: sel.startSurface.startRepository,
		startSourceBranch: sel.startSurface.startSourceBranch,
		startBranches: sel.startSurface.startBranches,
		startBranchesLoading: sel.startSurface.startBranchesLoading,
		startMode: sel.startSurface.startMode,
		startBranchIntent: sel.startSurface.startBranchIntent,
		startPreviewCard: sel.contextPanel.startPreviewCard,
		startComposerInsertTarget: sel.startSurface.startComposerInsertTarget,
		startComposerContextKey: sel.startSurface.startComposerContextKey,
		startCreateContext: s.startCreateContext,
		startLinkedDirectoriesController:
			sel.startSurface.startLinkedDirectoriesController,
		repoId: data.selectedWorkspaceDetailQuery.data?.repoId ?? null,
		sessionSelectionHistory: s.sessionSelectionHistory,
		workspaceChangeRequest: data.workspaceChangeRequest,
		pendingPromptForSession: data.pendingPromptForSession,
		pendingCreatedWorkspaceSubmit: sel.pendingCreatedWorkspaceSubmit,
		handlePendingCreatedWorkspaceSubmitConsumed:
			data.handlePendingCreatedWorkspaceSubmitConsumed,
		contextPreviewCard: sel.contextPanel.workspacePreviewCard,
		contextPreviewActive: sel.contextPanel.workspacePreviewActive,
		headerLeadingNode,
		headerActionsNode,
	};
}
