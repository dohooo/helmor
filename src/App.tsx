import "./App.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { WorkspaceCommitButtonMode } from "@/features/commit/button";
import { useWorkspaceCommitLifecycle } from "@/features/commit/hooks/use-commit-lifecycle";
import type {
	ComposerCreateContext,
	PendingCreatedWorkspaceSubmit,
} from "@/features/conversation";
import { useDockUnreadBadge } from "@/features/dock-badge";
import { useFeedbackSubmit } from "@/features/feedback/use-feedback-submit";
import { useConfirmSessionClose } from "@/features/panel/use-confirm-session-close";
import type { SettingsSection } from "@/features/settings";
import { useGlobalHotkeySync } from "@/features/shortcuts/use-global-hotkey-sync";
import { useAppUpdater } from "@/features/updater/use-app-updater";
import { useEnsureDefaultModel } from "@/shell/hooks/use-ensure-default-model";
import { useShellPanels } from "@/shell/hooks/use-panels";
import { usePullLatest } from "@/shell/hooks/use-pull-latest";
import { useThemeApplication } from "@/shell/hooks/use-theme-application";
import { useUiSyncBridge } from "@/shell/hooks/use-ui-sync-bridge";
import { PREFERRED_EDITOR_STORAGE_KEY } from "@/shell/layout";
import { useZoom } from "@/shell/use-zoom";
import { openWorkspaceInEditor } from "./lib/api";
import { usesActionModelOverride } from "./lib/commit-button-prompts";
import { detectedEditorsQueryOptions } from "./lib/query-client";
import { type ShortcutOverrides, useSettings } from "./lib/settings";
import { useOsNotifications } from "./lib/use-os-notifications";
import { resolveE2eScenarioElement } from "./shell/boot/e2e-routes";
import { AppProviders } from "./shell/components/app-providers";
import { AppShellLayout } from "./shell/components/app-shell";
import { WorkspaceHeaderActions } from "./shell/components/workspace-header-actions";
import { WorkspaceHeaderLeading } from "./shell/components/workspace-header-leading";
import { useContextPanelController } from "./shell/controllers/use-context-panel-controller";
import { useEditorSessionController } from "./shell/controllers/use-editor-session-controller";
import { usePendingQueueController } from "./shell/controllers/use-pending-queue-controller";
import { useReadStateController } from "./shell/controllers/use-read-state-controller";
import { useSelectionController } from "./shell/controllers/use-selection-controller";
import { useStartSurfaceController } from "./shell/controllers/use-start-surface-controller";
import { publishShellEvent } from "./shell/event-bus";
import { useAppBootstrap } from "./shell/hooks/use-app-bootstrap";
import { useEditorEditMode } from "./shell/hooks/use-editor-edit-mode";
import { useGlobalShortcutHandlers } from "./shell/hooks/use-global-shortcut-handlers";
import { useNavigationSidebar } from "./shell/hooks/use-navigation-sidebar";
import { useResolvedShortcuts } from "./shell/hooks/use-resolved-shortcuts";
import { useSessionActions } from "./shell/hooks/use-session-actions";
import { useSessionRunStates } from "./shell/hooks/use-session-run-states";
import { useSettingsOpenHandlers } from "./shell/hooks/use-settings-open-handlers";
import { useShellChromeActions } from "./shell/hooks/use-shell-chrome-actions";
import { useShellStartupEffects } from "./shell/hooks/use-shell-startup-effects";
import { useWorkspaceForgeData } from "./shell/hooks/use-workspace-forge-data";
import { useWorkspaceLinkActions } from "./shell/hooks/use-workspace-link-actions";
import { useWorkspaceNavigation } from "./shell/hooks/use-workspace-navigation";
import { useWorkspaceQuickSwitch } from "./shell/hooks/use-workspace-quick-switch";
import { useWorkspaceToast } from "./shell/hooks/use-workspace-toast";

function App() {
	const e2eElement = resolveE2eScenarioElement();
	if (e2eElement) return e2eElement;
	return <MainApp />;
}

function MainApp() {
	const bootstrap = useAppBootstrap();
	return <AppProviders {...bootstrap} AppShell={AppShell} />;
}

function AppShell({
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
	// Tracks which session we last persisted as "read" so the auto-read effect
	// stays idempotent when interaction-required state churns without the
	// displayed session changing.
	const pushWorkspaceToast = useWorkspaceToast();
	const {
		settings: appSettings,
		isLoaded: areSettingsLoaded,
		updateSettings,
	} = useSettings();
	const { repositories, workspaceGroups, archivedRows } =
		useNavigationSidebar(appSettings);
	const [feedbackOpen, setFeedbackOpen] = useState(false);
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
			viewMode: selection.viewMode,
			openWorkspaceStart: () => selectionActions.openStart(),
			setViewMode: (mode) => selectionActions.setViewMode(mode),
			selectWorkspace: (id) => handleSelectWorkspace(id),
			selectSession: (id) => handleSelectSession(id),
			setPendingCreatedWorkspaceSubmit: (updater) =>
				setPendingCreatedWorkspaceSubmit(updater),
		});
	const startRepository = startSurface.startRepository;
	const startInboxProviderTab = startSurface.startInboxProviderTab;
	const startInboxProviderSourceTab = startSurface.startInboxProviderSourceTab;
	const startInboxStateFilterBySource =
		startSurface.startInboxStateFilterBySource;
	const startSourceBranch = startSurface.startSourceBranch;
	const startMode = startSurface.startMode;
	const startBranchIntent = startSurface.startBranchIntent;
	const handleStartComposerPrepare = startSurfaceActions.prepareComposer;
	const startComposerContextKey = startSurface.startComposerContextKey;
	const startComposerInsertTarget = startSurface.startComposerInsertTarget;
	const startLinkedDirectoriesController =
		startSurface.startLinkedDirectoriesController;
	const inspectorCollapsed = contextPanel.inspectorCollapsed;
	const {
		handleResizeKeyDown,
		handleResizeStart,
		inspectorWidth,
		isInspectorResizing,
		isSidebarResizing,
		sidebarCollapsed,
		sidebarWidth,
		setSidebarCollapsed,
	} = useShellPanels();
	const rightSidebarMode = contextPanel.rightSidebarMode;
	const workspacePreviewCard = contextPanel.workspacePreviewCard;
	const workspacePreviewActive = contextPanel.workspacePreviewActive;
	const startPreviewCard = contextPanel.startPreviewCard;
	const rightSidebarAvailable = contextPanel.rightSidebarAvailable;
	const contextPanelOpen = contextPanel.contextPanelOpen;
	const setInspectorCollapsed = contextPanelActions.setInspectorCollapsed;
	const handleStartContextPreviewClose =
		contextPanelActions.closeStartContextPreview;
	// Mirror selection state under the legacy names used throughout AppShell.
	// Lets the consumers stay unchanged for now; stage 7 will rename them or
	// move them into pane components that read the controller directly.
	const selectedWorkspaceId = selection.selectedWorkspaceId;
	const displayedWorkspaceId = selection.displayedWorkspaceId;
	const selectedSessionId = selection.selectedSessionId;
	const displayedSessionId = selection.displayedSessionId;
	const workspaceViewMode = selection.viewMode;
	const workspaceReselectTick = selection.reselectTick;
	// Optimistic "creating workspace" marker — set by the start composer
	// once a backend `prepare_workspace_*` returns, cleared once the
	// composer's auto-submit fires for the first turn.
	const [pendingCreatedWorkspaceSubmit, setPendingCreatedWorkspaceSubmit] =
		useState<PendingCreatedWorkspaceSubmit | null>(null);
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
	// P0-A: cache the per-workspace session-selection history as a stable
	// reference. `getSessionSelectionHistory` already returns a stable ref
	// array (only swapped inside `rememberSessionSelection`), but AppShell used
	// to spread it (`[...]`) on every render — busting
	// WorkspaceConversationContainer's memo whenever ANY unrelated AppShell
	// state changed (sidebar collapse, resize, settings/forge ticks). deps
	// cover every history mutation: each `rememberSessionSelection` call runs
	// alongside a `selectedSessionId` change.
	const sessionSelectionHistory = useMemo(
		() => [...selectionActions.getSessionSelectionHistory(selectedWorkspaceId)],
		[
			selectionActions,
			selectedWorkspaceId,
			selectedSessionId,
			workspaceReselectTick,
		],
	);
	const appUpdateStatus = useAppUpdater();
	useDockUnreadBadge();
	useEnsureDefaultModel();
	const notify = useOsNotifications(appSettings);
	const { state: readState, actions: readStateActions } =
		useReadStateController({
			queryClient,
			notify,
			pushToast: pushWorkspaceToast,
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
	const installedEditorsQuery = useQuery(detectedEditorsQueryOptions());
	const installedEditors = installedEditorsQuery.data ?? [];
	const [preferredEditorId, setPreferredEditorId] = useState<string | null>(
		() => localStorage.getItem(PREFERRED_EDITOR_STORAGE_KEY),
	);
	const preferredEditor =
		installedEditors.find((e) => e.id === preferredEditorId) ??
		installedEditors[0] ??
		null;
	const {
		openPreferredEditorShortcut,
		newWorkspaceShortcut,
		addRepositoryShortcut,
		sidebarFilterShortcut,
		leftSidebarToggleShortcut,
		rightSidebarToggleShortcut,
	} = useResolvedShortcuts(appSettings.shortcuts);
	const handleUpdateGlobalHotkeyShortcuts = useCallback(
		(shortcuts: ShortcutOverrides) => updateSettings({ shortcuts }),
		[updateSettings],
	);
	useGlobalHotkeySync({
		isLoaded: areSettingsLoaded,
		shortcuts: appSettings.shortcuts,
		updateShortcuts: handleUpdateGlobalHotkeyShortcuts,
	});
	const handleOpenPreferredEditor = useCallback(() => {
		if (!selectedWorkspaceId || !preferredEditor) return;
		void openWorkspaceInEditor(selectedWorkspaceId, preferredEditor.id).catch(
			(e) =>
				pushWorkspaceToast(String(e), `Failed to open ${preferredEditor.name}`),
		);
	}, [preferredEditor, pushWorkspaceToast, selectedWorkspaceId]);
	const {
		handleToggleTheme,
		handleToggleZenMode,
		handleOpenModelPicker,
		handleOpenReleaseChangelog,
	} = useShellChromeActions({
		theme: appSettings.theme,
		updateSettings,
		sidebarCollapsed,
		inspectorCollapsed,
		setSidebarCollapsed,
		setInspectorCollapsed,
	});
	const handlePullLatest = usePullLatest({ queryClient, selectedWorkspaceId });

	const {
		selectedWorkspaceDetailQuery,
		selectedWorkspaceDetail,
		workspaceRootPath,
		workspaceForge,
		workspaceChangeRequest,
		pullRequestUrl,
		workspaceForgeActionStatus,
		workspaceForgeIsRefreshing,
		workspaceGitActionStatus,
	} = useWorkspaceForgeData({ queryClient, selectedWorkspaceId });
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

	useGlobalShortcutHandlers({
		appSettings,
		updateSettings,
		contextPanelActions,
		canEditEditorSession,
		getCloseableCurrentSession,
		handleCloseSelectedSession,
		handleCopyWorkspacePath,
		handleCreateSession,
		handleCommitAction,
		handleInspectorCommitAction,
		handleNavigateSessions,
		handleNavigateWorkspaces,
		handleOpenModelPicker,
		handleOpenPreferredEditor,
		handleOpenPullRequest,
		handleOpenSettings,
		handleEnterEditorEditMode,
		handlePullLatest,
		handleReopenClosedSession,
		handleToggleTheme,
		handleToggleZenMode,
		preferredEditor,
		pullRequestUrl,
		quickSwitch,
		selectedWorkspaceId,
		setInspectorCollapsed,
		setSidebarCollapsed,
		workspaceRootPath,
		workspacePreviewActive,
		workspacePreviewCard,
		workspaceViewMode,
	});

	const { state: pendingQueue, actions: pendingQueueActions } =
		usePendingQueueController({
			queryClient,
			pushToast: pushWorkspaceToast,
			getSelectionTargets: () => {
				// Read straight from the store (latest, lazy, non-subscribing) so a
				// queued insert sees the current selection even between renders.
				// MUST use getState() — it returns the full SelectionState including
				// the displayed* track that getSnapshot()/selected-only reads omit.
				const snap = selectionStore.getState();
				return {
					selectedWorkspaceId: snap.selectedWorkspaceId,
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
	const handlePendingCreatedWorkspaceSubmitConsumed = useCallback(
		(id: string) => {
			setPendingCreatedWorkspaceSubmit((current) =>
				current?.id === id ? null : current,
			);
		},
		[],
	);

	useUiSyncBridge({
		queryClient,
		processPendingCliSends: pendingQueueActions.processPendingCliSends,
		reloadSettings: () => publishShellEvent({ type: "reload-settings" }),
	});

	// Close-confirmation is handled by <QuitConfirmDialog /> which registers
	// its own onCloseRequested listener.  No need for a separate hook here.

	const selectedWorkspaceRepository =
		repositories.find(
			(repository) => repository.id === selectedWorkspaceDetail?.repoId,
		) ?? null;
	const handleOpenWorkspaceStart = selectionActions.openStart;
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

	// P1-A: React Compiler bailed out on this ~1650-line AppShell, so it does
	// NOT memoize these inline header JSX nodes — they get a fresh element
	// identity on every AppShell render (sidebar/inspector resize ticks, etc.),
	// busting WorkspaceConversationContainer's memo and cascading the whole
	// conversation subtree. Verified via React Profiler: ConversationContainer
	// re-rendered 11× on a single sidebar toggle. Hoist to useMemo so identity
	// is stable except when the inputs actually change.
	const headerLeadingNode = useMemo(
		() =>
			sidebarCollapsed ? (
				<WorkspaceHeaderLeading
					appUpdateStatus={appUpdateStatus}
					leftSidebarToggleShortcut={leftSidebarToggleShortcut}
					onExpandSidebar={() => setSidebarCollapsed(false)}
				/>
			) : undefined,
		[sidebarCollapsed, appUpdateStatus, leftSidebarToggleShortcut],
	);
	const headerActionsNode = useMemo(
		() =>
			selectedWorkspaceId ? (
				<WorkspaceHeaderActions
					workspaceId={selectedWorkspaceId}
					sessionId={selectedSessionId}
					installedEditors={installedEditors}
					preferredEditor={preferredEditor}
					openPreferredEditorShortcut={openPreferredEditorShortcut}
					rightSidebarToggleShortcut={rightSidebarToggleShortcut}
					inspectorCollapsed={inspectorCollapsed}
					isChatMode={selectedWorkspaceDetail?.mode === "chat"}
					onOpenPreferredEditor={handleOpenPreferredEditor}
					onToggleInspector={() =>
						setInspectorCollapsed((collapsed) => !collapsed)
					}
					onPickEditor={setPreferredEditorId}
					pushWorkspaceToast={pushWorkspaceToast}
				/>
			) : undefined,
		[
			selectedWorkspaceId,
			selectedSessionId,
			installedEditors,
			preferredEditor,
			openPreferredEditorShortcut,
			rightSidebarToggleShortcut,
			inspectorCollapsed,
			selectedWorkspaceDetail?.mode,
			handleOpenPreferredEditor,
			pushWorkspaceToast,
		],
	);

	return (
		<AppShellLayout
			providerStack={{
				selectionStore,
				pushWorkspaceToast,
				sessionRunStates: effectiveSessionRunStates,
				insertIntoComposer: pendingQueueActions.insertIntoComposer,
			}}
			feedbackOpen={feedbackOpen}
			onFeedbackOpenChange={setFeedbackOpen}
			onOpenSettings={handleOpenSettings}
			onSubmitFeedbackPrompt={submitFeedbackPrompt}
			workspaceViewMode={workspaceViewMode}
			sidebar={{
				collapsed: sidebarCollapsed,
				resizing: isSidebarResizing,
				width: sidebarWidth,
				autoSelectSettingsGate: workspaceSidebarAutoSelectSettingsGate,
				busyWorkspaceIds: effectiveBusyWorkspaceIds,
				interactionRequiredWorkspaceIds,
				newWorkspaceShortcut,
				addRepositoryShortcut,
				sidebarFilterShortcut,
				leftSidebarToggleShortcut,
				appUpdateStatus,
				appSettings,
				onSelectWorkspace: handleSelectWorkspace,
				onOpenNewWorkspace: handleOpenWorkspaceStart,
				onAddRepositoryNeedsStart: startSurfaceActions.addRepositoryNeedsStart,
				onMoveLocalToWorktree: startSurfaceActions.moveLocalToWorktree,
				onCollapseSidebar: () => setSidebarCollapsed(true),
				onOpenFeedback: () => setFeedbackOpen(true),
				onOpenSettings: handleOpenSettings,
				pushWorkspaceToast,
			}}
			sidebarCollapsed={sidebarCollapsed}
			isSidebarResizing={isSidebarResizing}
			sidebarWidth={sidebarWidth}
			workspacePane={{
				workspaceViewMode,
				editorSession,
				workspaceRootPath,
				appShortcuts: appSettings.shortcuts,
				sidebarCollapsed,
				contextPanelOpen,
				handleEditorSessionChange,
				editorSessionActions,
				repositories,
				selectionActions,
				readStateActions,
				pendingQueueActions,
				contextPanelActions,
				startSurfaceActions,
				activeStreams,
				effectiveBusySessionIds,
				effectiveStoppableSessionIds,
				interactionRequiredSessionIds,
				pendingComposerInserts,
				onSelectSession: handleSelectSession,
				onRequestCloseSession: requestCloseSession,
				handlePendingPromptConsumed,
				queuePendingPromptForSession,
				startRepository,
				startSourceBranch,
				startBranches: startSurface.startBranches,
				startBranchesLoading: startSurface.startBranchesLoading,
				startMode,
				startBranchIntent,
				startPreviewCard,
				startComposerInsertTarget,
				startComposerContextKey,
				startCreateContext,
				startLinkedDirectoriesController,
				repoId: selectedWorkspaceDetailQuery.data?.repoId ?? null,
				sessionSelectionHistory,
				workspaceChangeRequest,
				pendingPromptForSession,
				pendingCreatedWorkspaceSubmit,
				handlePendingCreatedWorkspaceSubmitConsumed,
				contextPreviewCard: workspacePreviewCard,
				contextPreviewActive: workspacePreviewActive,
				headerLeadingNode,
				headerActionsNode,
			}}
			rightSidebarAvailable={rightSidebarAvailable}
			selectedWorkspaceDetail={selectedWorkspaceDetailQuery.data ?? null}
			inspector={{
				collapsed: inspectorCollapsed,
				resizing: isInspectorResizing,
				width: inspectorWidth,
				rightSidebarMode,
				startRepository,
				selectedWorkspaceRepository,
				startInboxProviderTab,
				onStartInboxProviderTabChange: startSurfaceActions.setInboxProviderTab,
				startInboxProviderSourceTab,
				onStartInboxProviderSourceTabChange:
					startSurfaceActions.setInboxProviderSourceTab,
				startInboxStateFilterBySource,
				onStartInboxStateFilterBySourceChange:
					startSurfaceActions.setInboxStateFilterBySource,
				startComposerInsertTarget,
				startPreviewCardId: startPreviewCard?.id ?? null,
				workspacePreviewCardId: workspacePreviewCard?.id ?? null,
				onOpenStartContextCard: contextPanelActions.openStartContextCard,
				onOpenWorkspaceContextCard:
					contextPanelActions.openWorkspaceContextCard,
				workspaceRootPath,
				selectedWorkspaceDetail: selectedWorkspaceDetailQuery.data ?? null,
				activeEditor: activeEditorTarget,
				preferredEditor,
				onOpenEditorFile: editorSessionActions.openFile,
				onCommitAction: handleCommitAction,
				onReviewAction: () =>
					handleInspectorReviewAction({
						modelId: appSettings.reviewModelId ?? appSettings.defaultModelId,
						effort: appSettings.reviewEffort ?? appSettings.defaultEffort,
						fastMode: appSettings.reviewFastMode ?? appSettings.defaultFastMode,
					}),
				onQueuePendingPromptForSession: queuePendingPromptForSession,
				commitButtonMode,
				commitButtonState,
				workspaceChangeRequest,
				workspaceForgeIsRefreshing,
				onOpenSettings: handleOpenSettings,
			}}
			inspectorCollapsed={inspectorCollapsed}
			isInspectorResizing={isInspectorResizing}
			inspectorWidth={inspectorWidth}
			handleResizeStart={handleResizeStart}
			handleResizeKeyDown={handleResizeKeyDown}
			overlays={{
				theme: appSettings.theme,
				onOpenChangelog: handleOpenReleaseChangelog,
				onOpenAnnouncementSettings: handleOpenAnnouncementSettings,
				onSetRightSidebarMode: contextPanelActions.setMode,
				onOpenStartPage: () => handleOpenWorkspaceStart({ persist: false }),
				quickSwitch,
				liveWorkspaceRowMap,
				closeConfirmDialog,
				editorDiscardConfirmDialog,
				mergeConfirmDialogNode,
			}}
		/>
	);
}
export default App;
