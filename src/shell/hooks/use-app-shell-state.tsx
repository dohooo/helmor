// AppShell's orchestration hub. Composes the focused sub-hooks that carry the
// bulk of the wiring — `useSelectionControllers` (the selection TDZ core),
// `useWorkspaceDataControllers` + `useWorkspaceActionControllers` (the
// per-workspace data/action layers) and `useShellChromeState` (editor + chrome
// glue) — then layers on the orchestration-level effects that belong to none of
// them: theme application, the global keyboard-shortcut table, the UI-sync
// bridge, startup effects, plus the small derived values (session-selection
// history, the start composer create-context, the sidebar auto-select gate).
// Returns the grouped sub-results + that glue; the AppShell component reads off
// `sel` / `data` / `chrome` / `panels` and computes the two perf-critical header
// memo nodes itself (kept at the orchestration boundary). Everything is lifted
// verbatim out of the old inline AppShell body — call order, dependency arrays
// and `getSnapshot()` readbacks are preserved exactly.
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ComposerCreateContext } from "@/features/conversation";
import { useDockUnreadBadge } from "@/features/dock-badge";
import type { SettingsSection } from "@/features/settings";
import { useAppUpdater } from "@/features/updater/use-app-updater";
import { useSettings } from "@/lib/settings";
import { publishShellEvent } from "@/shell/event-bus";
import { useEnsureDefaultModel } from "@/shell/hooks/use-ensure-default-model";
import { useGlobalShortcutHandlers } from "@/shell/hooks/use-global-shortcut-handlers";
import { useNavigationSidebar } from "@/shell/hooks/use-navigation-sidebar";
import { useOpencodeStartupSync } from "@/shell/hooks/use-opencode-startup-sync";
import { useShellPanels } from "@/shell/hooks/use-panels";
import { useSelectionControllers } from "@/shell/hooks/use-selection-controllers";
import { useShellChromeState } from "@/shell/hooks/use-shell-chrome-state";
import { useShellStartupEffects } from "@/shell/hooks/use-shell-startup-effects";
import { useThemeApplication } from "@/shell/hooks/use-theme-application";
import { useUiSyncBridge } from "@/shell/hooks/use-ui-sync-bridge";
import { useWorkspaceActionControllers } from "@/shell/hooks/use-workspace-action-controllers";
import { useWorkspaceDataControllers } from "@/shell/hooks/use-workspace-data-controllers";
import { useWorkspaceToast } from "@/shell/hooks/use-workspace-toast";
import { useZoom } from "@/shell/use-zoom";

export function useAppShellState({
	onOpenSettings,
}: {
	onOpenSettings: (
		workspaceId: string | null,
		workspaceRepoId: string | null,
		initialSection?: SettingsSection,
	) => void;
}) {
	useZoom();
	const queryClient = useQueryClient();
	const pushWorkspaceToast = useWorkspaceToast();
	const {
		settings: appSettings,
		isLoaded: areSettingsLoaded,
		updateSettings,
	} = useSettings();
	const { repositories, workspaceGroups, archivedRows } =
		useNavigationSidebar(appSettings);
	const [feedbackOpen, setFeedbackOpen] = useState(false);

	const sel = useSelectionControllers({
		queryClient,
		pushWorkspaceToast,
		appSettings,
		areSettingsLoaded,
		updateSettings,
		repositories,
		workspaceGroups,
		archivedRows,
	});
	const { selection, contextPanel, startSurface } = sel;
	const startRepository = startSurface.startRepository;
	const handleStartComposerPrepare = sel.startSurfaceActions.prepareComposer;
	const inspectorCollapsed = contextPanel.inspectorCollapsed;
	const panels = useShellPanels();
	const { sidebarCollapsed, setSidebarCollapsed } = panels;
	const workspacePreviewCard = contextPanel.workspacePreviewCard;
	const workspacePreviewActive = contextPanel.workspacePreviewActive;
	const setInspectorCollapsed = sel.contextPanelActions.setInspectorCollapsed;
	const handleStartContextPreviewClose =
		sel.contextPanelActions.closeStartContextPreview;
	const selectedWorkspaceId = selection.selectedWorkspaceId;
	const displayedWorkspaceId = selection.displayedWorkspaceId;
	const selectedSessionId = selection.selectedSessionId;
	const displayedSessionId = selection.displayedSessionId;
	const workspaceViewMode = selection.viewMode;
	const workspaceReselectTick = selection.reselectTick;

	// P0-A: cache the per-workspace session-selection history as a stable
	// reference. `getSessionSelectionHistory` already returns a stable ref
	// array (only swapped inside `rememberSessionSelection`), but AppShell used
	// to spread it (`[...]`) on every render — busting
	// WorkspaceConversationContainer's memo whenever ANY unrelated AppShell
	// state changed (sidebar collapse, resize, settings/forge ticks). deps
	// cover every history mutation: each `rememberSessionSelection` call runs
	// alongside a `selectedSessionId` change.
	const sessionSelectionHistory = useMemo(
		() => [
			...sel.selectionActions.getSessionSelectionHistory(selectedWorkspaceId),
		],
		[
			sel.selectionActions,
			selectedWorkspaceId,
			selectedSessionId,
			workspaceReselectTick,
		],
	);
	const appUpdateStatus = useAppUpdater();
	useDockUnreadBadge();
	useEnsureDefaultModel();
	useOpencodeStartupSync();

	const chrome = useShellChromeState({
		queryClient,
		pushWorkspaceToast,
		appSettings,
		areSettingsLoaded,
		updateSettings,
		selectedWorkspaceId,
		sidebarCollapsed,
		inspectorCollapsed,
		setSidebarCollapsed,
		setInspectorCollapsed,
	});

	const dataControllers = useWorkspaceDataControllers({
		queryClient,
		pushWorkspaceToast,
		appSettings,
		onOpenSettings,
		selectionActions: sel.selectionActions,
		handleSelectWorkspace: sel.handleSelectWorkspace,
		handleSelectSession: sel.handleSelectSession,
		selectedWorkspaceId,
		displayedSessionId,
		workspaceReselectTick,
		pendingCreatedWorkspaceSubmit: sel.pendingCreatedWorkspaceSubmit,
		setPendingCreatedWorkspaceSubmit: sel.setPendingCreatedWorkspaceSubmit,
	});
	const actionControllers = useWorkspaceActionControllers({
		queryClient,
		pushWorkspaceToast,
		appSettings,
		workspaceGroups,
		archivedRows,
		selectionActions: sel.selectionActions,
		selectionStore: sel.selectionStore,
		handleSelectWorkspace: sel.handleSelectWorkspace,
		handleSelectSession: sel.handleSelectSession,
		selectedWorkspaceId,
		workspaceViewMode,
		setPendingCreatedWorkspaceSubmit: sel.setPendingCreatedWorkspaceSubmit,
		selectedWorkspaceDetailQuery: dataControllers.selectedWorkspaceDetailQuery,
		workspaceChangeRequest: dataControllers.workspaceChangeRequest,
		workspaceForge: dataControllers.forge.workspaceForge,
		workspaceForgeActionStatus:
			dataControllers.forge.workspaceForgeActionStatus,
		workspaceGitActionStatus: dataControllers.forge.workspaceGitActionStatus,
		settledSessionIds: dataControllers.settledSessionIds,
		abortedSessionIds: dataControllers.abortedSessionIds,
		interactionRequiredSessionIds:
			dataControllers.interactionRequiredSessionIds,
		effectiveBusySessionIds: dataControllers.effectiveBusySessionIds,
		readStateActions: dataControllers.readStateActions,
	});
	const data = { ...dataControllers, ...actionControllers };

	useThemeApplication({
		theme: appSettings.theme,
		lightTheme: appSettings.lightTheme,
		darkTheme: appSettings.darkTheme,
		uiFontFamily: appSettings.uiFontFamily,
		codeFontFamily: appSettings.codeFontFamily,
		terminalFontFamily: appSettings.terminalFontFamily,
		chatFontSize: appSettings.chatFontSize,
		usePointerCursors: appSettings.usePointerCursors,
	});

	useGlobalShortcutHandlers({
		appSettings,
		updateSettings,
		contextPanelActions: sel.contextPanelActions,
		canEditEditorSession: data.canEditEditorSession,
		getCloseableCurrentSession: data.getCloseableCurrentSession,
		handleCloseSelectedSession: data.handleCloseSelectedSession,
		handleCopyWorkspacePath: data.handleCopyWorkspacePath,
		handleCreateSession: data.handleCreateSession,
		handleCommitAction: data.handleCommitAction,
		handleInspectorCommitAction: data.handleInspectorCommitAction,
		handleNavigateSessions: data.handleNavigateSessions,
		handleNavigateWorkspaces: data.handleNavigateWorkspaces,
		handleOpenModelPicker: chrome.handleOpenModelPicker,
		handleOpenPreferredEditor: chrome.handleOpenPreferredEditor,
		handleOpenPullRequest: data.handleOpenPullRequest,
		handleOpenSettings: data.handleOpenSettings,
		handleEnterEditorEditMode: data.handleEnterEditorEditMode,
		handlePullLatest: chrome.handlePullLatest,
		handleReopenClosedSession: data.handleReopenClosedSession,
		handleToggleMiniMode: chrome.handleToggleMiniMode,
		handleToggleTheme: chrome.handleToggleTheme,
		handleToggleZenMode: chrome.handleToggleZenMode,
		preferredEditor: chrome.preferredEditor,
		pullRequestUrl: data.pullRequestUrl,
		quickSwitch: data.quickSwitch,
		selectedWorkspaceId,
		setInspectorCollapsed,
		setSidebarCollapsed,
		workspaceRootPath: data.workspaceRootPath,
		workspacePreviewActive,
		workspacePreviewCard,
		workspaceViewMode,
	});

	useUiSyncBridge({
		queryClient,
		processPendingCliSends: data.pendingQueueActions.processPendingCliSends,
		reloadSettings: () => publishShellEvent({ type: "reload-settings" }),
	});

	// Close-confirmation is handled by <QuitConfirmDialog /> which registers
	// its own onCloseRequested listener.  No need for a separate hook here.

	const selectedWorkspaceRepository =
		repositories.find(
			(repository) => repository.id === data.selectedWorkspaceDetail?.repoId,
		) ?? null;
	const handleOpenWorkspaceStart = sel.selectionActions.openStart;
	useShellStartupEffects({
		lastSurface: appSettings.lastSurface,
		areSettingsLoaded,
		workspaceViewMode,
		selectedWorkspaceId,
		displayedWorkspaceId,
		startRepositoryId: startRepository?.id,
		openWorkspaceStart: handleOpenWorkspaceStart,
		closeStartContextPreview: handleStartContextPreviewClose,
	});

	const startCreateContext = useMemo<ComposerCreateContext | null>(
		() =>
			workspaceViewMode === "start"
				? { prepare: handleStartComposerPrepare }
				: null,
		[handleStartComposerPrepare, workspaceViewMode],
	);
	const restoreStartSurface =
		areSettingsLoaded && appSettings.lastSurface === "workspace-start";
	// Settings-side half of the sidebar auto-select gate. The `viewMode !==
	// "start"` term now lives inside ShellSidebarPane (it subscribes to the
	// selection store's `viewMode` and ANDs it in), so this no longer reads
	// `workspaceViewMode` — keeping a `viewMode`-only change from re-rendering
	// AppShell via this derived flag.
	const workspaceSidebarAutoSelectSettingsGate =
		areSettingsLoaded && !restoreStartSurface;

	return {
		sel,
		data,
		chrome,
		panels,
		queryClient,
		pushWorkspaceToast,
		appSettings,
		repositories,
		feedbackOpen,
		setFeedbackOpen,
		appUpdateStatus,
		sessionSelectionHistory,
		selectedWorkspaceRepository,
		handleOpenWorkspaceStart,
		startCreateContext,
		workspaceSidebarAutoSelectSettingsGate,
	};
}
