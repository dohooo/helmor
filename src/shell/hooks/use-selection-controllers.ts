// The shell's selection TDZ core. Holds the three mutually-forward-referencing
// controllers — selection → contextPanel → startSurface — plus the
// `handleSelectWorkspace` / `handleSelectSession` pivots they (and every
// downstream data hook) share, and the optimistic `pendingCreatedWorkspaceSubmit`
// marker that startSurface forward-references. These MUST stay co-located in a
// single hook body: the forward references between them only resolve because
// they live in the same closure (see the `onWorkspaceSwitched` / `onStartOpened`
// callbacks reaching forward to `contextPanelActions` / `startSurfaceActions`,
// startSurface reaching forward to the pivots + the pending-created setter, and
// the pivots reaching back into the controller actions). Extracted verbatim out
// of AppShell — text order between the three controllers and the pivots is
// preserved exactly; nothing here changed except being lifted into its own hook.
import type { QueryClient } from "@tanstack/react-query";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useState,
} from "react";
import type { PendingCreatedWorkspaceSubmit } from "@/features/conversation";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import type { AppSettings } from "@/lib/settings";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { useRouterSelection } from "@/router/use-router-selection";
import {
	type ContextPanelActions,
	type ContextPanelState,
	useContextPanelController,
} from "@/shell/controllers/use-context-panel-controller";
import {
	type SelectionActions,
	type SelectionState,
	type SelectionStore,
	useSelectionController,
} from "@/shell/controllers/use-selection-controller";
import {
	type StartSurfaceActions,
	type StartSurfaceState,
	useStartSurfaceController,
} from "@/shell/controllers/use-start-surface-controller";

export type SelectionControllers = {
	selection: SelectionState;
	selectionActions: SelectionActions;
	selectionStore: SelectionStore;
	contextPanel: ContextPanelState;
	contextPanelActions: ContextPanelActions;
	startSurface: StartSurfaceState;
	startSurfaceActions: StartSurfaceActions;
	handleSelectWorkspace: (workspaceId: string | null) => void;
	handleSelectSession: (sessionId: string | null) => void;
	pendingCreatedWorkspaceSubmit: PendingCreatedWorkspaceSubmit | null;
	setPendingCreatedWorkspaceSubmit: Dispatch<
		SetStateAction<PendingCreatedWorkspaceSubmit | null>
	>;
};

export function useSelectionControllers({
	queryClient,
	pushWorkspaceToast,
	appSettings,
	areSettingsLoaded,
	updateSettings,
	repositories,
	workspaceGroups,
	archivedRows,
}: {
	queryClient: QueryClient;
	pushWorkspaceToast: PushWorkspaceToast;
	appSettings: AppSettings;
	areSettingsLoaded: boolean;
	updateSettings: (patch: Partial<AppSettings>) => void | Promise<void>;
	repositories: Parameters<typeof useStartSurfaceController>[0]["repositories"];
	workspaceGroups: WorkspaceGroup[];
	archivedRows: WorkspaceRow[];
}): SelectionControllers {
	// `viewMode` is router-owned now (Stage 3b). The start-surface controller
	// needs it reactively to clear its one-shot mode override on exit.
	const routerViewMode = useRouterSelection().viewMode;
	const {
		state: selection,
		actions: selectionActions,
		store: selectionStore,
	} = useSelectionController({
		queryClient,
		workspaceGroups,
		archivedRows,
		appSettings,
		areSettingsLoaded,
		updateSettings,
		onWorkspaceSwitched: () => {
			contextPanelActions.clearWorkspacePreview();
		},
		onStartOpened: () => {
			contextPanelActions.clearWorkspacePreview();
			startSurfaceActions.resetScratchOnReentry();
			contextPanelActions.syncToStartMode();
		},
	});
	const { state: contextPanel, actions: contextPanelActions } =
		useContextPanelController({
			appSettings,
			areSettingsLoaded,
			updateSettings,
			getViewMode: () => selectionActions.getSnapshot().viewMode,
		});
	const { state: startSurface, actions: startSurfaceActions } =
		useStartSurfaceController({
			queryClient,
			appSettings,
			areSettingsLoaded,
			updateSettings,
			repositories,
			pushToast: pushWorkspaceToast,
			getViewMode: () => selectionActions.getSnapshot().viewMode,
			viewMode: routerViewMode,
			openWorkspaceStart: () => selectionActions.openStart(),
			setViewMode: (mode) => selectionActions.setViewMode(mode),
			selectWorkspace: (id) => handleSelectWorkspace(id),
			selectSession: (id) => handleSelectSession(id),
			setPendingCreatedWorkspaceSubmit: (updater) =>
				setPendingCreatedWorkspaceSubmit(updater),
		});
	// Optimistic "creating workspace" marker — set by the start composer
	// once a backend `prepare_workspace_*` returns, cleared once the
	// composer's auto-submit fires for the first turn.
	const [pendingCreatedWorkspaceSubmit, setPendingCreatedWorkspaceSubmit] =
		useState<PendingCreatedWorkspaceSubmit | null>(null);

	const handleSelectWorkspace = useCallback(
		(workspaceId: string | null) => {
			// Align the right sidebar with the user's persisted preference on
			// every workspace switch (and on reselect too — keeps behaviour
			// identical to the pre-extraction handler).
			contextPanelActions.syncToWorkspaceMode();
			selectionActions.selectWorkspace(workspaceId);
		},
		[contextPanelActions, selectionActions],
	);

	const handleSelectSession = useCallback(
		(sessionId: string | null) => {
			contextPanelActions.deactivateWorkspaceContextPreview();
			selectionActions.selectSession(sessionId);
		},
		[selectionActions],
	);

	return {
		selection,
		selectionActions,
		selectionStore,
		contextPanel,
		contextPanelActions,
		startSurface,
		startSurfaceActions,
		handleSelectWorkspace,
		handleSelectSession,
		pendingCreatedWorkspaceSubmit,
		setPendingCreatedWorkspaceSubmit,
	};
}
