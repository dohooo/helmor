// The shell's mutating-action layer (cluster B of the data split). Given the
// query/editor outputs from `useWorkspaceDataControllers` plus the selection
// outputs, this wires the action hooks AppShell exposes to the inspector, the
// conversation surface and the keyboard table: feedback submit, the commit
// lifecycle (+ the action-model override wrapper), session close/create, the
// confirm-close flow, keyboard navigation, quick-switch, and the pending-queue.
// Split out of `useWorkspaceDataControllers` purely to keep each file focused
// (queries vs. mutations); it consumes already-resolved data, never the other
// way round, and stays clear of the selection TDZ ring. Extracted verbatim —
// call order and dependency arrays are preserved exactly.
import type { QueryClient } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import type { WorkspaceCommitButtonMode } from "@/features/commit/button";
import { useWorkspaceCommitLifecycle } from "@/features/commit/hooks/use-commit-lifecycle";
import type { PendingCreatedWorkspaceSubmit } from "@/features/conversation";
import { useFeedbackSubmit } from "@/features/feedback/use-feedback-submit";
import { useConfirmSessionClose } from "@/features/panel/use-confirm-session-close";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import { usesActionModelOverride } from "@/lib/commit-button-prompts";
import type { AppSettings } from "@/lib/settings";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { usePendingQueueController } from "@/shell/controllers/use-pending-queue-controller";
import type {
	ReadStateActions,
	ReadStateState,
} from "@/shell/controllers/use-read-state-controller";
import type {
	SelectionActions,
	SelectionStore,
	ShellViewMode,
} from "@/shell/controllers/use-selection-controller";
import { useSessionActions } from "@/shell/hooks/use-session-actions";
import type { useWorkspaceForgeData } from "@/shell/hooks/use-workspace-forge-data";
import { useWorkspaceNavigation } from "@/shell/hooks/use-workspace-navigation";
import { useWorkspaceQuickSwitch } from "@/shell/hooks/use-workspace-quick-switch";

type WorkspaceForgeData = ReturnType<typeof useWorkspaceForgeData>;

export function useWorkspaceActionControllers({
	queryClient,
	pushWorkspaceToast,
	appSettings,
	workspaceGroups,
	archivedRows,
	selectionActions,
	selectionStore,
	handleSelectWorkspace,
	handleSelectSession,
	selectedWorkspaceId,
	workspaceViewMode,
	setPendingCreatedWorkspaceSubmit,
	selectedWorkspaceDetailQuery,
	workspaceChangeRequest,
	workspaceForge,
	workspaceForgeActionStatus,
	workspaceGitActionStatus,
	settledSessionIds,
	abortedSessionIds,
	interactionRequiredSessionIds,
	effectiveBusySessionIds,
	readStateActions,
}: {
	queryClient: QueryClient;
	pushWorkspaceToast: PushWorkspaceToast;
	appSettings: AppSettings;
	workspaceGroups: WorkspaceGroup[];
	archivedRows: WorkspaceRow[];
	selectionActions: SelectionActions;
	selectionStore: SelectionStore;
	handleSelectWorkspace: (workspaceId: string | null) => void;
	handleSelectSession: (sessionId: string | null) => void;
	selectedWorkspaceId: string | null;
	workspaceViewMode: ShellViewMode;
	setPendingCreatedWorkspaceSubmit: Dispatch<
		SetStateAction<PendingCreatedWorkspaceSubmit | null>
	>;
	selectedWorkspaceDetailQuery: WorkspaceForgeData["selectedWorkspaceDetailQuery"];
	workspaceChangeRequest: WorkspaceForgeData["workspaceChangeRequest"];
	workspaceForge: WorkspaceForgeData["workspaceForge"];
	workspaceForgeActionStatus: WorkspaceForgeData["workspaceForgeActionStatus"];
	workspaceGitActionStatus: WorkspaceForgeData["workspaceGitActionStatus"];
	settledSessionIds: ReadStateState["settledSessionIds"];
	abortedSessionIds: ReadStateState["abortedSessionIds"];
	interactionRequiredSessionIds: ReadStateState["interactionRequiredSessionIds"];
	effectiveBusySessionIds: Set<string>;
	readStateActions: ReadStateActions;
}) {
	const submitFeedbackPrompt = useFeedbackSubmit({
		queryClient,
		appSettings,
		selectWorkspace: handleSelectWorkspace,
		selectSession: handleSelectSession,
		setViewMode: selectionActions.setViewMode,
		setPendingCreatedWorkspaceSubmit,
		pushToast: pushWorkspaceToast,
	});

	const {
		commitButtonMode,
		commitButtonState,
		handleInspectorCommitAction,
		handleInspectorReviewAction,
		handlePendingPromptConsumed,
		mergeConfirmDialogNode,
		pendingPromptForSession,
		queuePendingPromptForSession,
	} = useWorkspaceCommitLifecycle({
		queryClient,
		selectedWorkspaceId,
		getSelectedWorkspaceId: () => selectionActions.getSnapshot().workspaceId,
		selectedRepoId: selectedWorkspaceDetailQuery.data?.repoId ?? null,
		selectedWorkspaceTargetBranch:
			selectedWorkspaceDetailQuery.data?.intendedTargetBranch ??
			selectedWorkspaceDetailQuery.data?.defaultBranch ??
			null,
		selectedWorkspaceRemote: selectedWorkspaceDetailQuery.data?.remote ?? null,
		changeRequest: workspaceChangeRequest,
		forgeDetection: workspaceForge,
		forgeActionStatus: workspaceForgeActionStatus,
		workspaceGitActionStatus,
		completedSessionIds: settledSessionIds,
		abortedSessionIds,
		interactionRequiredSessionIds,
		busySessionIds: effectiveBusySessionIds,
		onSelectSession: handleSelectSession,
		pushToast: pushWorkspaceToast,
	});

	// Action model covers simple, bounded helper sessions. More involved
	// fix/resolve flows keep following the default model.
	const handleCommitAction = useCallback(
		(mode: WorkspaceCommitButtonMode) => {
			if (usesActionModelOverride(mode)) {
				return handleInspectorCommitAction(mode, {
					modelId: appSettings.prModelId ?? appSettings.defaultModelId,
					effort: appSettings.prEffort ?? appSettings.defaultEffort,
					fastMode: appSettings.prFastMode ?? appSettings.defaultFastMode,
				});
			}
			return handleInspectorCommitAction(mode);
		},
		[
			handleInspectorCommitAction,
			appSettings.prModelId,
			appSettings.prEffort,
			appSettings.prFastMode,
			appSettings.defaultModelId,
			appSettings.defaultEffort,
			appSettings.defaultFastMode,
		],
	);

	const { requestClose: requestCloseSession, dialogNode: closeConfirmDialog } =
		useConfirmSessionClose({
			busySessionIds: effectiveBusySessionIds,
			onSelectSession: handleSelectSession,
			onSessionHidden: readStateActions.onSessionHidden,
			pushToast: pushWorkspaceToast,
			queryClient,
		});

	const handleReopenClosedSession = readStateActions.reopenClosedSession;

	const {
		getCloseableCurrentSession,
		handleCloseSelectedSession,
		handleCreateSession,
	} = useSessionActions({
		queryClient,
		selectionActions,
		requestCloseSession,
		handleSelectSession,
		pushWorkspaceToast,
		workspaceViewMode,
	});

	const { handleNavigateSessions, handleNavigateWorkspaces } =
		useWorkspaceNavigation({
			queryClient,
			selectionActions,
			workspaceGroups,
			archivedRows,
			handleSelectWorkspace,
			handleSelectSession,
		});

	const { quickSwitch, liveWorkspaceRowMap } = useWorkspaceQuickSwitch({
		workspaceGroups,
		selectedWorkspaceId,
		handleSelectWorkspace,
	});

	const { state: pendingQueue, actions: pendingQueueActions } =
		usePendingQueueController({
			queryClient,
			pushToast: pushWorkspaceToast,
			getSelectionTargets: () => {
				// `selected*` is router-owned (Stage 3b) — read it synchronously via
				// the snapshot (router.state.location). `displayed*` stays in the
				// store; read it lazily (non-subscribing) so a queued insert sees the
				// current paint track even between renders.
				const snap = selectionStore.getState();
				return {
					selectedWorkspaceId: selectionActions.getSnapshot().workspaceId,
					displayedWorkspaceId: snap.displayedWorkspaceId,
					displayedSessionId: snap.displayedSessionId,
				};
			},
			getActiveWorkspaceId: () => selectionActions.getSnapshot().workspaceId,
			onCliSendSelectWorkspace: (id) => handleSelectWorkspace(id),
			onCliSendSelectSession: (id) => handleSelectSession(id),
			queuePendingPromptForSession,
		});
	const pendingComposerInserts = pendingQueue.pendingComposerInserts;

	return {
		submitFeedbackPrompt,
		commitButtonMode,
		commitButtonState,
		handleInspectorCommitAction,
		handleInspectorReviewAction,
		handlePendingPromptConsumed,
		mergeConfirmDialogNode,
		pendingPromptForSession,
		queuePendingPromptForSession,
		handleCommitAction,
		requestCloseSession,
		closeConfirmDialog,
		handleReopenClosedSession,
		getCloseableCurrentSession,
		handleCloseSelectedSession,
		handleCreateSession,
		handleNavigateSessions,
		handleNavigateWorkspaces,
		quickSwitch,
		liveWorkspaceRowMap,
		pendingQueueActions,
		pendingComposerInserts,
	};
}
