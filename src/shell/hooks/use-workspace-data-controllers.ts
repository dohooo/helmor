// The shell's per-workspace data/editor layer (cluster A of the data split).
// Given the resolved selection outputs plus the shell inputs, this assembles the
// query/state hooks AppShell hangs off the displayed workspace: session
// run-states, read-state, the forge/detail query cluster, settings-open
// handlers, the editor session controller (+ its stable active-target memo and
// edit-mode gate), and the workspace link actions. None of these participate in
// the selection TDZ ring — they only consume already-stable references. The
// mutating-action hooks that build on these outputs live in
// `useWorkspaceActionControllers`. Extracted verbatim from AppShell; call order,
// dependency arrays and `getSnapshot()` readbacks are preserved exactly.
import type { QueryClient } from "@tanstack/react-query";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useMemo,
} from "react";
import type { PendingCreatedWorkspaceSubmit } from "@/features/conversation";
import type { SettingsSection } from "@/features/settings";
import type { AppSettings } from "@/lib/settings";
import { useOsNotifications } from "@/lib/use-os-notifications";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { useEditorSessionController } from "@/shell/controllers/use-editor-session-controller";
import { useReadStateController } from "@/shell/controllers/use-read-state-controller";
import type { SelectionActions } from "@/shell/controllers/use-selection-controller";
import { useEditorEditMode } from "@/shell/hooks/use-editor-edit-mode";
import { useSessionRunStates } from "@/shell/hooks/use-session-run-states";
import { useSettingsOpenHandlers } from "@/shell/hooks/use-settings-open-handlers";
import { useWorkspaceForgeData } from "@/shell/hooks/use-workspace-forge-data";
import { useWorkspaceLinkActions } from "@/shell/hooks/use-workspace-link-actions";

export function useWorkspaceDataControllers({
	queryClient,
	pushWorkspaceToast,
	appSettings,
	onOpenSettings,
	selectionActions,
	handleSelectWorkspace,
	handleSelectSession,
	selectedWorkspaceId,
	settledWorkspaceId,
	displayedWorkspaceId,
	displayedSessionId,
	workspaceReselectTick,
	pendingCreatedWorkspaceSubmit,
	setPendingCreatedWorkspaceSubmit,
}: {
	queryClient: QueryClient;
	pushWorkspaceToast: PushWorkspaceToast;
	appSettings: AppSettings;
	onOpenSettings: (
		workspaceId: string | null,
		workspaceRepoId: string | null,
		initialSection?: SettingsSection,
	) => void;
	selectionActions: SelectionActions;
	handleSelectWorkspace: (workspaceId: string | null) => void;
	handleSelectSession: (sessionId: string | null) => void;
	selectedWorkspaceId: string | null;
	// Settle-gated workspace id (lags `selectedWorkspaceId` only for cold targets
	// during a rapid-switch burst). Feeds the forge/detail/git query cluster so it
	// fetches the settled workspace, not every one scrubbed past.
	settledWorkspaceId: string | null;
	// Paint-track workspace id — the read-state controller compares it against
	// the selected one to skip mark-read during the display-flip window.
	displayedWorkspaceId: string | null;
	displayedSessionId: string | null;
	workspaceReselectTick: number;
	pendingCreatedWorkspaceSubmit: PendingCreatedWorkspaceSubmit | null;
	setPendingCreatedWorkspaceSubmit: Dispatch<
		SetStateAction<PendingCreatedWorkspaceSubmit | null>
	>;
}) {
	// Source of truth for "which sessions are running": the Rust
	// `ActiveStreams` registry, mirrored here via React Query and kept
	// fresh by `UiMutationEvent::ActiveStreamsChanged`. We layer the
	// StartPage's optimistic "creating workspace" marker on top so the
	// panel can show a busy spinner before the real stream registers.
	const {
		activeStreams,
		effectiveSessionRunStates,
		effectiveBusySessionIds,
		effectiveStoppableSessionIds,
		effectiveBusyWorkspaceIds,
	} = useSessionRunStates(pendingCreatedWorkspaceSubmit);
	const notify = useOsNotifications(appSettings);
	const { state: readState, actions: readStateActions } =
		useReadStateController({
			queryClient,
			notify,
			pushToast: pushWorkspaceToast,
			displayedWorkspaceId,
			displayedSessionId,
			reselectTick: workspaceReselectTick,
			getSelectedWorkspaceId: () => selectionActions.getSnapshot().workspaceId,
			getSelectedSessionId: () => selectionActions.getSnapshot().sessionId,
			onReopenSelectWorkspace: (id) => {
				handleSelectWorkspace(id);
			},
			onReopenSelectSession: (id) => {
				handleSelectSession(id);
			},
		});
	const settledSessionIds = readState.settledSessionIds;
	const abortedSessionIds = readState.abortedSessionIds;
	const interactionRequiredSessionIds = readState.interactionRequiredSessionIds;
	const interactionRequiredWorkspaceIds =
		readState.interactionRequiredWorkspaceIds;

	// Key the forge/detail/git cluster on the SETTLED id (not the router-instant
	// `selectedWorkspaceId`) so a held-key burst doesn't fire 5 IPCs + a git-diff
	// per intermediate workspace. Warm/single/slow switches settle instantly, so
	// this is byte-identical to the old behaviour outside a rapid burst.
	const forge = useWorkspaceForgeData({
		queryClient,
		selectedWorkspaceId: settledWorkspaceId,
	});
	const {
		selectedWorkspaceDetailQuery,
		selectedWorkspaceDetail,
		workspaceRootPath,
		pullRequestUrl,
		workspaceChangeRequest,
		workspaceForgeIsRefreshing,
	} = forge;
	const { handleOpenSettings, handleOpenAnnouncementSettings } =
		useSettingsOpenHandlers({
			selectedWorkspaceId,
			repoId: selectedWorkspaceDetailQuery.data?.repoId ?? null,
			onOpenSettings,
		});

	const {
		state: editorSessionState,
		actions: editorSessionActions,
		dialogNode: editorDiscardConfirmDialog,
	} = useEditorSessionController({
		pushToast: pushWorkspaceToast,
		workspaceRootPath,
		selectedWorkspaceId,
		enterEditorMode: () => selectionActions.setViewMode("editor"),
		exitEditorMode: () => selectionActions.setViewMode("conversation"),
	});
	const editorSession = editorSessionState.editorSession;
	// Stable identity so downstream `React.memo` boundaries hold.
	const activeEditorTarget = useMemo(
		() =>
			editorSession
				? {
						path: editorSession.path,
						originalRef: editorSession.originalRef,
						modifiedRef: editorSession.modifiedRef,
					}
				: null,
		[
			editorSession?.path,
			editorSession?.originalRef,
			editorSession?.modifiedRef,
			editorSession,
		],
	);
	const handleEditorSessionChange = editorSessionActions.changeSession;
	const { canEditEditorSession, handleEnterEditorEditMode } = useEditorEditMode(
		{
			editorSession,
			handleEditorSessionChange,
		},
	);

	const { handleCopyWorkspacePath, handleOpenPullRequest } =
		useWorkspaceLinkActions({
			workspaceRootPath,
			pullRequestUrl,
			pushWorkspaceToast,
		});

	const handlePendingCreatedWorkspaceSubmitConsumed = useCallback(
		(id: string) => {
			setPendingCreatedWorkspaceSubmit((current) =>
				current?.id === id ? null : current,
			);
		},
		[],
	);

	return {
		forge,
		activeStreams,
		effectiveSessionRunStates,
		effectiveBusySessionIds,
		effectiveStoppableSessionIds,
		effectiveBusyWorkspaceIds,
		readStateActions,
		settledSessionIds,
		abortedSessionIds,
		interactionRequiredSessionIds,
		interactionRequiredWorkspaceIds,
		selectedWorkspaceDetailQuery,
		selectedWorkspaceDetail,
		workspaceRootPath,
		workspaceChangeRequest,
		pullRequestUrl,
		workspaceForgeIsRefreshing,
		handleOpenSettings,
		handleOpenAnnouncementSettings,
		editorSession,
		editorSessionActions,
		editorDiscardConfirmDialog,
		activeEditorTarget,
		handleEditorSessionChange,
		canEditEditorSession,
		handleEnterEditorEditMode,
		handleCopyWorkspacePath,
		handleOpenPullRequest,
		handlePendingCreatedWorkspaceSubmitConsumed,
	};
}
