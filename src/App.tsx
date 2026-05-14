import "./App.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ForgeAccountsHealthSentinel } from "@/components/forge-accounts-health-sentinel";
import { QuitConfirmDialog } from "@/components/quit-confirm-dialog";
import { SplashScreen } from "@/components/splash-screen";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
	GITHUB_RELEASES_URL,
	ReleaseAnnouncementToastHost,
} from "@/features/announcements";
import type { WorkspaceCommitButtonMode } from "@/features/commit/button";
import { useWorkspaceCommitLifecycle } from "@/features/commit/hooks/use-commit-lifecycle";
import { hydrateDraftCache } from "@/features/composer/draft-storage";
import {
	type ComposerCreateContext,
	type PendingCreatedWorkspaceSubmit,
	WorkspaceConversationContainer,
} from "@/features/conversation";
import { useDockUnreadBadge } from "@/features/dock-badge";
import { WorkspaceEditorSurface } from "@/features/editor";
import { useRefreshForgeOnWorkspaceSwitch } from "@/features/inspector/hooks/use-refresh-forge-on-switch";
import { regroupByRepo } from "@/features/navigation/sidebar-projection";
import { AppOnboarding } from "@/features/onboarding";
import { seedNewSessionInCache } from "@/features/panel/session-cache";
import { useConfirmSessionClose } from "@/features/panel/use-confirm-session-close";
import { SettingsDialog, type SettingsSection } from "@/features/settings";
import { getShortcut } from "@/features/shortcuts/registry";
import {
	type ShortcutHandler,
	useAppShortcuts,
} from "@/features/shortcuts/use-app-shortcuts";
import { useGlobalHotkeySync } from "@/features/shortcuts/use-global-hotkey-sync";
import { useAppUpdater } from "@/features/updater/use-app-updater";
import { WorkspaceStartPage } from "@/features/workspace-start";
import { useEnsureDefaultModel } from "@/shell/hooks/use-ensure-default-model";
import { useShellPanels } from "@/shell/hooks/use-panels";
import { usePullLatest } from "@/shell/hooks/use-pull-latest";
import { useThemeApplication } from "@/shell/hooks/use-theme-application";
import { useUiSyncBridge } from "@/shell/hooks/use-ui-sync-bridge";
import {
	findAdjacentSessionId,
	findAdjacentWorkspaceId,
	PREFERRED_EDITOR_STORAGE_KEY,
} from "@/shell/layout";
import { clampZoom, useZoom, ZOOM_STEP } from "@/shell/use-zoom";
import {
	createSession,
	exitOnboardingWindowMode,
	openWorkspaceInEditor,
	type WorkspaceDetail,
	type WorkspaceSessionSummary,
} from "./lib/api";
import { usesActionModelOverride } from "./lib/commit-button-prompts";
import { ComposerInsertProvider } from "./lib/composer-insert-context";
import {
	activeStreamsQueryOptions,
	archivedWorkspacesQueryOptions,
	createHelmorQueryClient,
	detectedEditorsQueryOptions,
	helmorQueryKeys,
	helmorQueryPersister,
	QUERY_CACHE_BUSTER,
	repositoriesQueryOptions,
	workspaceChangeRequestQueryOptions,
	workspaceDetailQueryOptions,
	workspaceForgeActionStatusQueryOptions,
	workspaceForgeQueryOptions,
	workspaceGitActionStatusQueryOptions,
	workspaceGroupsQueryOptions,
} from "./lib/query-client";
import {
	buildSessionRunStates,
	deriveBusySessionIds,
	deriveBusyWorkspaceIds,
	deriveStoppableSessionIds,
	type SessionRunState,
} from "./lib/session-run-state";
import { SessionRunStatesProvider } from "./lib/session-run-state-context";
import {
	type AppSettings,
	DEFAULT_SETTINGS,
	getPreloadedSettings,
	loadSettings,
	resolveTheme,
	SettingsContext,
	type ShortcutOverrides,
	saveSettings,
	useSettings,
} from "./lib/settings";
import { requestSidebarReconcile } from "./lib/sidebar-mutation-gate";
import { useOsNotifications } from "./lib/use-os-notifications";
import { summaryToArchivedRow } from "./lib/workspace-helpers";
import {
	type WorkspaceToastOptions,
	WorkspaceToastProvider,
} from "./lib/workspace-toast-context";
import { resolveE2eScenarioElement } from "./shell/boot/e2e-routes";
import { ShellInspectorPane } from "./shell/components/shell-inspector-pane";
import { ShellResizeSeparator } from "./shell/components/shell-resize-separator";
import { ShellSidebarPane } from "./shell/components/shell-sidebar-pane";
import { WorkspaceHeaderActions } from "./shell/components/workspace-header-actions";
import { WorkspaceHeaderLeading } from "./shell/components/workspace-header-leading";
import {
	EMPTY_ACTIVE_STREAMS,
	EMPTY_SESSION_RUN_STATES,
	SPLASH_FADE_MS,
	SPLASH_MIN_DURATION_MS,
	SPLASH_POST_ONBOARDING_DELAY_MS,
} from "./shell/constants";
import { useContextPanelController } from "./shell/controllers/use-context-panel-controller";
import { useEditorSessionController } from "./shell/controllers/use-editor-session-controller";
import { usePendingQueueController } from "./shell/controllers/use-pending-queue-controller";
import { useReadStateController } from "./shell/controllers/use-read-state-controller";
import { useSelectionController } from "./shell/controllers/use-selection-controller";
import { useStartSurfaceController } from "./shell/controllers/use-start-surface-controller";
import { publishShellEvent, useShellEvent } from "./shell/event-bus";

function App() {
	const e2eElement = resolveE2eScenarioElement();
	if (e2eElement) return e2eElement;
	return <MainApp />;
}

function MainApp() {
	const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsWorkspaceId, setSettingsWorkspaceId] = useState<string | null>(
		null,
	);
	const [settingsWorkspaceRepoId, setSettingsWorkspaceRepoId] = useState<
		string | null
	>(null);
	const [settingsInitialSection, setSettingsInitialSection] =
		useState<SettingsSection>();
	const [queryClient] = useState(() => createHelmorQueryClient());
	const preloadSettings = useMemo<AppSettings>(
		() => getPreloadedSettings(),
		[],
	);

	const settingsContextValue = useMemo(
		() => ({
			settings: appSettings ?? preloadSettings,
			isLoaded: appSettings !== null,
			updateSettings: (patch: Partial<AppSettings>) => {
				setAppSettings((previous) => {
					const next = { ...(previous ?? DEFAULT_SETTINGS), ...patch };
					return next;
				});
				return saveSettings(patch);
			},
		}),
		[appSettings, preloadSettings],
	);
	useShellEvent("open-settings", (event) => {
		setSettingsInitialSection(event.section);
		setSettingsWorkspaceId(null);
		setSettingsWorkspaceRepoId(null);
		setSettingsOpen(true);
	});
	const [splashVisible, setSplashVisible] = useState(true);
	const [splashMounted, setSplashMounted] = useState(true);

	const hideSplashAfterBoot = useCallback(() => {
		window.setTimeout(() => {
			setSplashVisible(false);
			window.setTimeout(() => setSplashMounted(false), SPLASH_FADE_MS);
		}, SPLASH_POST_ONBOARDING_DELAY_MS);
	}, []);

	const completeOnboarding = useCallback(() => {
		setSplashMounted(true);
		setSplashVisible(true);
		setAppSettings((previous) => ({
			...(previous ?? DEFAULT_SETTINGS),
			onboardingCompleted: true,
		}));
		void saveSettings({ onboardingCompleted: true });

		requestAnimationFrame(() => {
			requestAnimationFrame(hideSplashAfterBoot);
		});
	}, [hideSplashAfterBoot]);

	useEffect(() => {
		const minDelay = new Promise<void>((r) =>
			setTimeout(r, SPLASH_MIN_DURATION_MS),
		);
		// Pull persisted composer drafts into the in-memory cache before
		// the splash hides — the composer's sync `loadPersistedDraft` then
		// sees DB content on first mount instead of flickering.
		const draftHydration = hydrateDraftCache();
		void Promise.all([
			loadSettings().then(setAppSettings),
			draftHydration,
			minDelay,
		]).then(() => {
			setSplashVisible(false);
			setTimeout(() => setSplashMounted(false), SPLASH_FADE_MS);
		});
	}, []);

	useEffect(() => {
		if (appSettings?.onboardingCompleted !== true) {
			return;
		}

		void exitOnboardingWindowMode().catch((error) => {
			console.error("[app] failed to restore main window mode", error);
		});
	}, [appSettings?.onboardingCompleted]);

	useShellEvent("reload-settings", () => {
		void loadSettings().then(setAppSettings);
	});

	return (
		<SettingsContext.Provider value={settingsContextValue}>
			<PersistQueryClientProvider
				client={queryClient}
				persistOptions={{
					persister: helmorQueryPersister,
					buster: QUERY_CACHE_BUSTER,
				}}
			>
				{appSettings === null ? null : !appSettings.onboardingCompleted ? (
					<>
						<AppOnboarding onComplete={completeOnboarding} />
						<QuitConfirmDialog sessionRunStates={EMPTY_SESSION_RUN_STATES} />
					</>
				) : (
					<>
						{/* Renderless: focus-driven health probes for every
						 *  (provider, host) we know about. Without this the
						 *  reconciliation only ran while Settings → Accounts
						 *  was open, so a `gh auth login` outside Helmor
						 *  wouldn't trigger a re-bind until the user opened
						 *  that panel — leaving every workspace's chip
						 *  stuck on "Connect" indefinitely. */}
						<ForgeAccountsHealthSentinel />
						<AppShell
							onOpenSettings={(
								workspaceId,
								workspaceRepoId,
								initialSection,
							) => {
								setSettingsInitialSection(initialSection);
								setSettingsWorkspaceId(workspaceId);
								setSettingsWorkspaceRepoId(workspaceRepoId);
								setSettingsOpen(true);
							}}
						/>
					</>
				)}
				{splashMounted && <SplashScreen visible={splashVisible} />}
				<SettingsDialog
					open={settingsOpen}
					workspaceId={settingsWorkspaceId}
					workspaceRepoId={settingsWorkspaceRepoId}
					initialSection={settingsInitialSection}
					onClose={() => {
						setSettingsOpen(false);
						void queryClient.invalidateQueries({
							queryKey: ["repoScripts"],
						});
					}}
				/>
			</PersistQueryClientProvider>
		</SettingsContext.Provider>
	);
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
	const pushWorkspaceToast = useCallback(
		(
			description: string,
			title = "Action failed",
			variant: "default" | "destructive" = "destructive",
			opts?: {
				action?: WorkspaceToastOptions["action"];
				persistent?: boolean;
			},
		) => {
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const action = opts?.action
				? {
						label: opts.action.label,
						onClick: () => {
							opts.action?.onClick();
							toast.dismiss(id);
						},
					}
				: undefined;
			const cancel = opts?.action
				? {
						label: "Dismiss",
						onClick: () => {
							toast.dismiss(id);
						},
					}
				: undefined;
			const toastOptions = {
				id,
				description,
				duration: opts?.persistent ? Number.POSITIVE_INFINITY : 4200,
				action,
				cancel,
			};

			if (variant === "destructive") {
				// Inline the alert icon inside the title so it sits on the same
				// line (sonner's default icon slot is hidden for the error variant
				// via `errorToastClass` — see `components/ui/sonner.tsx`).
				const titleNode = (
					<span className="inline-flex items-center gap-1.5">
						<CircleAlertIcon className="size-3.5 shrink-0" />
						<span>{title}</span>
					</span>
				);
				toast.error(titleNode, toastOptions);
				return;
			}

			toast(title, toastOptions);
		},
		[],
	);
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
	const {
		settings: appSettings,
		isLoaded: areSettingsLoaded,
		updateSettings,
	} = useSettings();
	const navigationGroupsQuery = useQuery(workspaceGroupsQueryOptions());
	const navigationArchivedQuery = useQuery(archivedWorkspacesQueryOptions());
	const baseWorkspaceGroups = navigationGroupsQuery.data ?? [];
	// Project the raw status-grouped query result through the same
	// repo-bucketing step the sidebar applies for rendering, so callers
	// downstream (selection controller's keyboard navigation, workspace
	// warmup) see groups in the order the user actually sees them on
	// screen. Without this, repo grouping mode keeps the raw status
	// buckets and up/down keys jump in seemingly random order.
	const workspaceGroups = useMemo(
		() =>
			appSettings.sidebarGrouping === "repo"
				? regroupByRepo(baseWorkspaceGroups)
				: baseWorkspaceGroups,
		[appSettings.sidebarGrouping, baseWorkspaceGroups],
	);
	const archivedRows = useMemo(
		() => (navigationArchivedQuery.data ?? []).map(summaryToArchivedRow),
		[navigationArchivedQuery.data],
	);
	const repositoriesQuery = useQuery(repositoriesQueryOptions());
	const repositories = repositoriesQuery.data ?? [];
	const { state: selection, actions: selectionActions } =
		useSelectionController({
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
			openWorkspaceStart: () => selectionActions.openStart(),
			setViewMode: (mode) => selectionActions.setViewMode(mode),
			selectWorkspace: (id) => handleSelectWorkspace(id),
			selectSession: (id) => handleSelectSession(id),
			setPendingCreatedWorkspaceSubmit: (updater) =>
				setPendingCreatedWorkspaceSubmit(updater),
		});
	const startRepository = startSurface.startRepository;
	const startInboxProviderTab = startSurface.startInboxProviderTab;
	const setStartInboxProviderTab = startSurfaceActions.setInboxProviderTab;
	const startInboxProviderSourceTab = startSurface.startInboxProviderSourceTab;
	const setStartInboxProviderSourceTab =
		startSurfaceActions.setInboxProviderSourceTab;
	const startInboxStateFilterBySource =
		startSurface.startInboxStateFilterBySource;
	const setStartInboxStateFilterBySource =
		startSurfaceActions.setInboxStateFilterBySource;
	const startSourceBranch = startSurface.startSourceBranch;
	const startMode = startSurface.startMode;
	const handleStartSourceBranchSelect = startSurfaceActions.selectSourceBranch;
	const handleStartRepositorySelect = startSurfaceActions.selectRepository;
	const handleAddRepositoryNeedsStart =
		startSurfaceActions.addRepositoryNeedsStart;
	const handleMoveLocalToWorktree = startSurfaceActions.moveLocalToWorktree;
	const handleStartComposerPrepare = startSurfaceActions.prepareComposer;
	const startComposerContextKey = startSurface.startComposerContextKey;
	const startComposerInsertTarget = startSurface.startComposerInsertTarget;
	const startLinkedDirectoriesController =
		startSurface.startLinkedDirectoriesController;
	const inspectorCollapsed = contextPanel.inspectorCollapsed;
	const rightSidebarMode = contextPanel.rightSidebarMode;
	const workspacePreviewCard = contextPanel.workspacePreviewCard;
	const workspacePreviewActive = contextPanel.workspacePreviewActive;
	const startPreviewCard = contextPanel.startPreviewCard;
	const rightSidebarAvailable = contextPanel.rightSidebarAvailable;
	const contextPanelOpen = contextPanel.contextPanelOpen;
	const setInspectorCollapsed = contextPanelActions.setInspectorCollapsed;
	const handleToggleContextPanel = contextPanelActions.toggleContextPanel;
	const handleStartContextCardOpen = contextPanelActions.openStartContextCard;
	const handleStartContextPreviewClose =
		contextPanelActions.closeStartContextPreview;
	const handleWorkspaceContextCardOpen =
		contextPanelActions.openWorkspaceContextCard;
	const handleWorkspaceContextPreviewSelect =
		contextPanelActions.selectWorkspaceContextPreview;
	const handleWorkspaceContextPreviewClose =
		contextPanelActions.closeWorkspaceContextPreview;
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
	const activeStreamsQuery = useQuery(activeStreamsQueryOptions());
	// Stable empty fallback so referential-equality consumers don't churn
	// on undefined-data ticks.
	const activeStreams = activeStreamsQuery.data ?? EMPTY_ACTIVE_STREAMS;
	const effectiveSessionRunStates = useMemo<
		ReadonlyMap<string, SessionRunState>
	>(
		() =>
			buildSessionRunStates(
				activeStreams,
				pendingCreatedWorkspaceSubmit
					? {
							sessionId: pendingCreatedWorkspaceSubmit.sessionId,
							workspaceId: pendingCreatedWorkspaceSubmit.workspaceId,
						}
					: null,
			),
		[activeStreams, pendingCreatedWorkspaceSubmit],
	);
	const effectiveBusySessionIds = useMemo(
		() => deriveBusySessionIds(effectiveSessionRunStates),
		[effectiveSessionRunStates],
	);
	const effectiveStoppableSessionIds = useMemo(
		() => deriveStoppableSessionIds(effectiveSessionRunStates),
		[effectiveSessionRunStates],
	);
	const effectiveBusyWorkspaceIds = useMemo(
		() => deriveBusyWorkspaceIds(effectiveSessionRunStates),
		[effectiveSessionRunStates],
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
	const openPreferredEditorShortcut = getShortcut(
		appSettings.shortcuts,
		"workspace.openInEditor",
	);
	const newWorkspaceShortcut = getShortcut(
		appSettings.shortcuts,
		"workspace.new",
	);
	const addRepositoryShortcut = getShortcut(
		appSettings.shortcuts,
		"workspace.addRepository",
	);
	const leftSidebarToggleShortcut = getShortcut(
		appSettings.shortcuts,
		"sidebar.left.toggle",
	);
	const rightSidebarToggleShortcut = getShortcut(
		appSettings.shortcuts,
		"sidebar.right.toggle",
	);
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
	const handleToggleTheme = useCallback(() => {
		updateSettings({
			theme: resolveTheme(appSettings.theme) === "dark" ? "light" : "dark",
		});
	}, [appSettings.theme, updateSettings]);
	const handleToggleZenMode = useCallback(() => {
		const zenActive = sidebarCollapsed && inspectorCollapsed;
		setSidebarCollapsed(!zenActive);
		setInspectorCollapsed(!zenActive);
	}, [inspectorCollapsed, setSidebarCollapsed, sidebarCollapsed]);
	const handleOpenModelPicker = useCallback(() => {
		publishShellEvent({ type: "open-model-picker" });
	}, []);
	const handlePullLatest = usePullLatest({ queryClient, selectedWorkspaceId });

	const selectedWorkspaceDetailQuery = useQuery({
		...workspaceDetailQueryOptions(selectedWorkspaceId ?? "__none__"),
		enabled: selectedWorkspaceId !== null,
	});
	const handleOpenSettings = useCallback((): void => {
		onOpenSettings(
			selectedWorkspaceId,
			selectedWorkspaceDetailQuery.data?.repoId ?? null,
		);
	}, [
		onOpenSettings,
		selectedWorkspaceDetailQuery.data?.repoId,
		selectedWorkspaceId,
	]);
	const handleOpenAnnouncementSettings = useCallback(
		(initialSection?: SettingsSection): void => {
			onOpenSettings(null, null, initialSection);
		},
		[onOpenSettings],
	);
	const handleOpenReleaseChangelog = useCallback(() => {
		void openUrl(GITHUB_RELEASES_URL).catch((error) => {
			toast.error("Unable to open GitHub changelog", {
				description: String(error),
			});
		});
	}, []);
	const selectedWorkspaceDetail =
		selectedWorkspaceDetailQuery.data ??
		(selectedWorkspaceId
			? queryClient.getQueryData<WorkspaceDetail | null>(
					helmorQueryKeys.workspaceDetail(selectedWorkspaceId),
				)
			: null) ??
		null;
	const workspaceRootPath =
		selectedWorkspaceDetail?.state === "archived"
			? null
			: (selectedWorkspaceDetail?.rootPath ?? null);

	const { state: editorSessionState, actions: editorSessionActions } =
		useEditorSessionController({
			pushToast: pushWorkspaceToast,
			workspaceRootPath,
			selectedWorkspaceId,
			enterEditorMode: () => selectionActions.setViewMode("editor"),
			exitEditorMode: () => selectionActions.setViewMode("conversation"),
		});
	const editorSession = editorSessionState.editorSession;
	const handleOpenEditorFile = editorSessionActions.openFile;
	const handleOpenFileReference = editorSessionActions.openFileReference;
	const handleEditorSessionChange = editorSessionActions.changeSession;
	const handleExitEditorMode = editorSessionActions.exit;
	const handleEditorSurfaceError = editorSessionActions.reportError;

	const handleCopyWorkspacePath = useCallback(() => {
		if (!workspaceRootPath) return;
		void navigator.clipboard.writeText(workspaceRootPath).then(() => {
			toast.success("Path copied", {
				description: workspaceRootPath,
				duration: 2000,
			});
		});
	}, [workspaceRootPath]);

	const workspaceForgeQuery = useQuery({
		...workspaceForgeQueryOptions(selectedWorkspaceId ?? "__none__"),
		enabled: selectedWorkspaceId !== null,
	});
	const workspaceForge = workspaceForgeQuery.data ?? null;
	const workspaceForgeProvider = workspaceForge?.provider ?? "unknown";
	const workspaceForgeQueriesEnabled =
		selectedWorkspaceId !== null &&
		selectedWorkspaceDetail?.state !== "archived" &&
		(workspaceForgeProvider === "gitlab" ||
			workspaceForgeProvider === "github");

	// Seed the change-request query with whatever PR snapshot is already
	// persisted on the workspace row. Lets the inspector render the PR badge
	// optimistically on first visit, before the live forge query returns.
	const workspaceChangeRequestSeed = useMemo(
		() => ({
			prSyncState: selectedWorkspaceDetail?.prSyncState,
			prUrl: selectedWorkspaceDetail?.prUrl ?? null,
			prTitle: selectedWorkspaceDetail?.prTitle ?? null,
		}),
		[
			selectedWorkspaceDetail?.prSyncState,
			selectedWorkspaceDetail?.prUrl,
			selectedWorkspaceDetail?.prTitle,
		],
	);
	const workspaceChangeRequestQuery = useQuery({
		...workspaceChangeRequestQueryOptions(
			selectedWorkspaceId ?? "__none__",
			workspaceChangeRequestSeed,
		),
		enabled: workspaceForgeQueriesEnabled,
	});
	const workspaceChangeRequest = workspaceChangeRequestQuery.data ?? null;
	const pullRequestUrl =
		workspaceChangeRequest?.url || selectedWorkspaceDetail?.prUrl || null;
	const handleOpenPullRequest = useCallback(() => {
		if (!pullRequestUrl) return;
		void openUrl(pullRequestUrl).catch((error) => {
			pushWorkspaceToast(
				error instanceof Error ? error.message : String(error),
				"Unable to open pull request",
				"destructive",
			);
		});
	}, [pullRequestUrl, pushWorkspaceToast]);

	const workspaceForgeActionStatusQuery = useQuery({
		...workspaceForgeActionStatusQueryOptions(
			selectedWorkspaceId ?? "__none__",
		),
		enabled: workspaceForgeQueriesEnabled,
	});
	const workspaceForgeActionStatus =
		workspaceForgeActionStatusQuery.data ?? null;

	// Drive the inspector's git-header shimmer. Only show it on the first
	// cold fetch — not on background refetches, and not while we're already
	// rendering a placeholder built from the persisted PR snapshot.
	const workspaceForgeIsRefreshing =
		(workspaceChangeRequestQuery.isFetching &&
			(workspaceChangeRequestQuery.data === undefined ||
				workspaceChangeRequestQuery.isPlaceholderData)) ||
		(workspaceForgeActionStatusQuery.isFetching &&
			workspaceForgeActionStatusQuery.data === undefined);

	const workspaceGitActionStatusQuery = useQuery({
		...workspaceGitActionStatusQueryOptions(selectedWorkspaceId ?? "__none__"),
		enabled:
			selectedWorkspaceId !== null &&
			selectedWorkspaceDetail?.state !== "archived",
	});
	const workspaceGitActionStatus = workspaceGitActionStatusQuery.data ?? null;

	// Nudge CI-progress refetch on workspace switch — `refetchOnMount: "always"`
	// doesn't fire on queryKey changes.
	useRefreshForgeOnWorkspaceSwitch(selectedWorkspaceId);

	useThemeApplication({
		theme: appSettings.theme,
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

	const handleSessionCompleted = readStateActions.onSessionCompleted;
	const handleSessionAborted = readStateActions.onSessionAborted;
	const handleInteractionSessionsChange =
		readStateActions.onInteractionSessionsChange;

	const getCloseableCurrentSession = useCallback(() => {
		const snapshot = selectionActions.getSnapshot();
		if (snapshot.viewMode !== "conversation") {
			return null;
		}

		const workspaceId = snapshot.workspaceId;
		const sessionId = snapshot.sessionId;
		if (!workspaceId || !sessionId) {
			return null;
		}

		const workspace = queryClient.getQueryData<WorkspaceDetail | null>(
			helmorQueryKeys.workspaceDetail(workspaceId),
		);
		const sessions =
			queryClient.getQueryData<WorkspaceSessionSummary[]>(
				helmorQueryKeys.workspaceSessions(workspaceId),
			) ?? [];
		if (!workspace || !sessions.some((session) => session.id === sessionId)) {
			return null;
		}

		return {
			workspaceId,
			sessionId,
			workspace,
			sessions,
			session: sessions.find((candidate) => candidate.id === sessionId) ?? null,
		};
	}, [queryClient, selectionActions]);

	const { requestClose: requestCloseSession, dialogNode: closeConfirmDialog } =
		useConfirmSessionClose({
			busySessionIds: effectiveBusySessionIds,
			onSelectSession: handleSelectSession,
			onSessionHidden: readStateActions.onSessionHidden,
			pushToast: pushWorkspaceToast,
			queryClient,
		});

	const handleReopenClosedSession = readStateActions.reopenClosedSession;

	const handleCloseSelectedSession = useCallback(async () => {
		const currentSession = getCloseableCurrentSession();
		if (!currentSession?.session) {
			return;
		}

		const { workspaceId, sessionId, workspace, sessions, session } =
			currentSession;

		await requestCloseSession({
			workspace,
			sessions,
			session,
			activateAdjacent: true,
			onSessionsChanged: () => {
				requestSidebarReconcile(queryClient);
				void Promise.all([
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
					}),
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
					}),
					queryClient.invalidateQueries({
						queryKey: [...helmorQueryKeys.sessionMessages(sessionId), "thread"],
					}),
				]);
			},
		});
	}, [getCloseableCurrentSession, queryClient, requestCloseSession]);

	const handleCreateSession = useCallback(async () => {
		const workspaceId = selectionActions.getSnapshot().workspaceId;
		if (!workspaceId) {
			return;
		}

		try {
			const { sessionId } = await createSession(workspaceId);
			const cachedWorkspace =
				queryClient.getQueryData<WorkspaceDetail | null>(
					helmorQueryKeys.workspaceDetail(workspaceId),
				) ?? null;
			seedNewSessionInCache({
				queryClient,
				workspaceId,
				sessionId,
				workspace: cachedWorkspace,
				existingSessions:
					queryClient.getQueryData<WorkspaceSessionSummary[]>(
						helmorQueryKeys.workspaceSessions(workspaceId),
					) ?? [],
			});
			handleSelectSession(sessionId);

			requestSidebarReconcile(queryClient);
			void Promise.all([
				...(cachedWorkspace
					? [
							queryClient.invalidateQueries({
								queryKey: helmorQueryKeys.repoScripts(
									cachedWorkspace.repoId,
									workspaceId,
								),
							}),
						]
					: []),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
				}),
			]);
		} catch (error) {
			pushWorkspaceToast(
				error instanceof Error ? error.message : String(error),
				"Unable to create session",
			);
		}
	}, [handleSelectSession, pushWorkspaceToast, queryClient]);

	const handleNavigateSessions = useCallback(
		(offset: -1 | 1) => {
			const snapshot = selectionActions.getSnapshot();
			const workspaceId = snapshot.workspaceId;
			if (!workspaceId) return;
			const workspaceSessions =
				queryClient.getQueryData<WorkspaceSessionSummary[]>(
					helmorQueryKeys.workspaceSessions(workspaceId),
				) ?? [];
			const nextSessionId = findAdjacentSessionId(
				workspaceSessions,
				snapshot.sessionId,
				offset,
			);
			if (!nextSessionId) return;
			handleSelectSession(nextSessionId);
		},
		[handleSelectSession, queryClient, selectionActions],
	);

	const handleNavigateWorkspaces = useCallback(
		(offset: -1 | 1) => {
			const snapshot = selectionActions.getSnapshot();
			const nextWorkspaceId = findAdjacentWorkspaceId(
				workspaceGroups,
				archivedRows,
				snapshot.workspaceId,
				offset,
			);
			if (!nextWorkspaceId) return;
			handleSelectWorkspace(nextWorkspaceId);
		},
		[archivedRows, handleSelectWorkspace, selectionActions, workspaceGroups],
	);

	const globalShortcutHandlers = useMemo<ShortcutHandler[]>(
		() => [
			{
				id: "settings.open" as const,
				callback: handleOpenSettings,
			},
			{
				id: "workspace.copyPath" as const,
				callback: handleCopyWorkspacePath,
				enabled: Boolean(workspaceRootPath),
			},
			{
				id: "workspace.openInEditor" as const,
				callback: handleOpenPreferredEditor,
				enabled: Boolean(selectedWorkspaceId && preferredEditor),
			},
			{
				id: "workspace.new" as const,
				callback: () => publishShellEvent({ type: "open-new-workspace" }),
			},
			{
				id: "workspace.addRepository" as const,
				callback: () => publishShellEvent({ type: "open-add-repository" }),
			},
			{
				id: "workspace.previous" as const,
				callback: () => handleNavigateWorkspaces(-1),
			},
			{
				id: "workspace.next" as const,
				callback: () => handleNavigateWorkspaces(1),
			},
			{
				id: "session.previous" as const,
				callback: () => handleNavigateSessions(-1),
				enabled: workspaceViewMode === "conversation",
			},
			{
				id: "session.next" as const,
				callback: () => handleNavigateSessions(1),
				enabled: workspaceViewMode === "conversation",
			},
			{
				id: "session.close" as const,
				callback: () => {
					if (workspacePreviewActive && workspacePreviewCard) {
						contextPanelActions.closeWorkspaceContextPreview();
						return;
					}
					if (!getCloseableCurrentSession()) return;
					void handleCloseSelectedSession();
				},
				enabled:
					workspaceViewMode === "conversation" &&
					(Boolean(workspacePreviewCard) ||
						Boolean(getCloseableCurrentSession())),
			},
			{
				id: "session.new" as const,
				callback: (): void => void handleCreateSession(),
				enabled: workspaceViewMode === "conversation",
			},
			{
				id: "session.reopenClosed" as const,
				callback: () => void handleReopenClosedSession(),
			},
			{
				id: "script.run" as const,
				callback: () => publishShellEvent({ type: "run-script" }),
			},
			{
				id: "theme.toggle" as const,
				callback: handleToggleTheme,
			},
			{
				id: "sidebar.left.toggle" as const,
				callback: () => setSidebarCollapsed((collapsed) => !collapsed),
			},
			{
				id: "sidebar.right.toggle" as const,
				callback: () => setInspectorCollapsed((collapsed) => !collapsed),
			},
			{
				id: "zen.toggle" as const,
				callback: handleToggleZenMode,
			},
			{
				id: "action.createPr" as const,
				callback: () => void handleCommitAction("create-pr"),
			},
			{
				id: "action.commitAndPush" as const,
				callback: () => void handleCommitAction("commit-and-push"),
			},
			{
				id: "action.pullLatest" as const,
				callback: () => void handlePullLatest(),
				enabled: Boolean(selectedWorkspaceId),
			},
			{
				id: "action.mergePr" as const,
				callback: () => void handleInspectorCommitAction("merge"),
			},
			{
				id: "action.fixErrors" as const,
				callback: () => void handleInspectorCommitAction("fix"),
			},
			{
				id: "action.openPullRequest" as const,
				callback: handleOpenPullRequest,
				enabled: Boolean(pullRequestUrl),
			},
			{
				id: "composer.focus" as const,
				callback: () => publishShellEvent({ type: "focus-composer" }),
				enabled:
					workspaceViewMode === "conversation" || workspaceViewMode === "start",
			},
			{
				id: "composer.openModelPicker" as const,
				callback: handleOpenModelPicker,
				enabled: workspaceViewMode === "conversation",
			},
			{
				id: "composer.toggleContextPanel" as const,
				callback: () => publishShellEvent({ type: "toggle-context-panel" }),
				enabled:
					workspaceViewMode === "conversation" || workspaceViewMode === "start",
			},
			{
				id: "zoom.in" as const,
				callback: () =>
					updateSettings({
						zoomLevel: clampZoom(appSettings.zoomLevel + ZOOM_STEP),
					}),
			},
			{
				id: "zoom.out" as const,
				callback: () =>
					updateSettings({
						zoomLevel: clampZoom(appSettings.zoomLevel - ZOOM_STEP),
					}),
			},
			{
				id: "zoom.reset" as const,
				callback: () => updateSettings({ zoomLevel: 1.0 }),
			},
		],
		[
			appSettings.zoomLevel,
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
			handlePullLatest,
			handleReopenClosedSession,
			handleToggleTheme,
			handleToggleZenMode,
			preferredEditor,
			pullRequestUrl,
			selectedWorkspaceId,
			setInspectorCollapsed,
			setSidebarCollapsed,
			updateSettings,
			workspaceRootPath,
			workspacePreviewActive,
			workspacePreviewCard,
			workspaceViewMode,
		],
	);
	useAppShortcuts({
		overrides: appSettings.shortcuts,
		handlers: globalShortcutHandlers,
	});

	const handleResolveDisplayedSession =
		selectionActions.resolveDisplayedSession;

	const { state: pendingQueue, actions: pendingQueueActions } =
		usePendingQueueController({
			queryClient,
			pushToast: pushWorkspaceToast,
			getSelectionTargets: () => ({
				selectedWorkspaceId: selection.selectedWorkspaceId,
				displayedWorkspaceId: selection.displayedWorkspaceId,
				displayedSessionId: selection.displayedSessionId,
			}),
			getActiveWorkspaceId: () => selectionActions.getSnapshot().workspaceId,
			onCliSendSelectWorkspace: (id) => handleSelectWorkspace(id),
			onCliSendSelectSession: (id) => handleSelectSession(id),
			queuePendingPromptForSession,
		});
	const pendingComposerInserts = pendingQueue.pendingComposerInserts;
	const handleInsertIntoComposer = pendingQueueActions.insertIntoComposer;
	const handlePendingComposerInsertsConsumed =
		pendingQueueActions.consumeComposerInserts;
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

	useEffect(() => {
		if (workspaceViewMode !== "conversation") {
			return;
		}

		let disposed = false;
		let unlisten: (() => void) | undefined;

		void listen("helmor://close-current-session", () => {
			if (!getCloseableCurrentSession()) {
				return;
			}

			void handleCloseSelectedSession();
		}).then((fn) => {
			if (disposed) {
				fn();
				return;
			}
			unlisten = fn;
		});

		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [
		getCloseableCurrentSession,
		handleCloseSelectedSession,
		workspaceViewMode,
	]);

	const selectedWorkspaceRepository =
		repositories.find(
			(repository) => repository.id === selectedWorkspaceDetail?.repoId,
		) ?? null;
	const handleOpenWorkspaceStart = selectionActions.openStart;
	useEffect(() => {
		if (!areSettingsLoaded || appSettings.lastSurface !== "workspace-start") {
			return;
		}
		if (
			workspaceViewMode === "start" &&
			selectedWorkspaceId === null &&
			displayedWorkspaceId === null
		) {
			return;
		}
		handleOpenWorkspaceStart({ persist: false });
	}, [
		appSettings.lastSurface,
		areSettingsLoaded,
		displayedWorkspaceId,
		handleOpenWorkspaceStart,
		selectedWorkspaceId,
		workspaceViewMode,
	]);
	useEffect(() => {
		handleStartContextPreviewClose();
	}, [startRepository?.id, handleStartContextPreviewClose]);

	const startCreateContext = useMemo<ComposerCreateContext | null>(
		() =>
			workspaceViewMode === "start"
				? { prepare: handleStartComposerPrepare }
				: null,
		[handleStartComposerPrepare, workspaceViewMode],
	);
	const restoreStartSurface =
		areSettingsLoaded && appSettings.lastSurface === "workspace-start";
	const workspaceSidebarAutoSelectEnabled =
		areSettingsLoaded && workspaceViewMode !== "start" && !restoreStartSurface;

	return (
		<TooltipProvider delayDuration={0}>
			<WorkspaceToastProvider value={pushWorkspaceToast}>
				<SessionRunStatesProvider value={effectiveSessionRunStates}>
					<ComposerInsertProvider value={handleInsertIntoComposer}>
						<main
							aria-label="Application shell"
							className="relative h-screen overflow-hidden bg-background font-sans text-foreground antialiased"
						>
							<div className="relative flex h-full min-h-0 bg-background">
								{workspaceViewMode !== "editor" && (
									<>
										<ShellSidebarPane
											collapsed={sidebarCollapsed}
											resizing={isSidebarResizing}
											width={sidebarWidth}
											selectedWorkspaceId={
												workspaceViewMode === "start"
													? null
													: selectedWorkspaceId
											}
											autoSelectEnabled={workspaceSidebarAutoSelectEnabled}
											busyWorkspaceIds={effectiveBusyWorkspaceIds}
											interactionRequiredWorkspaceIds={
												interactionRequiredWorkspaceIds
											}
											newWorkspaceShortcut={newWorkspaceShortcut}
											addRepositoryShortcut={addRepositoryShortcut}
											leftSidebarToggleShortcut={leftSidebarToggleShortcut}
											appUpdateStatus={appUpdateStatus}
											appSettings={appSettings}
											onSelectWorkspace={handleSelectWorkspace}
											onOpenNewWorkspace={handleOpenWorkspaceStart}
											onAddRepositoryNeedsStart={handleAddRepositoryNeedsStart}
											onMoveLocalToWorktree={handleMoveLocalToWorktree}
											onCollapseSidebar={() => setSidebarCollapsed(true)}
											onOpenSettings={handleOpenSettings}
											pushWorkspaceToast={pushWorkspaceToast}
										/>
										<ShellResizeSeparator
											side="sidebar"
											collapsed={sidebarCollapsed}
											resizing={isSidebarResizing}
											width={sidebarWidth}
											onMouseDown={handleResizeStart("sidebar")}
											onKeyDown={handleResizeKeyDown("sidebar")}
										/>
									</>
								)}

								<section
									aria-label="Workspace panel"
									className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
								>
									{workspaceViewMode === "conversation" && (
										<div
											aria-label="Workspace panel drag region"
											className="absolute inset-x-0 top-0 z-10 h-9 bg-transparent"
											data-tauri-drag-region
										/>
									)}

									<div
										aria-label="Workspace viewport"
										className="flex min-h-0 flex-1 flex-col bg-background"
									>
										{workspaceViewMode === "editor" && editorSession && (
											<WorkspaceEditorSurface
												editorSession={editorSession}
												workspaceRootPath={workspaceRootPath}
												onChangeSession={handleEditorSessionChange}
												onExit={handleExitEditorMode}
												onError={handleEditorSurfaceError}
											/>
										)}
										<div
											data-focus-scope="chat"
											className={
												workspaceViewMode === "editor"
													? "hidden"
													: "flex min-h-0 flex-1 flex-col"
											}
										>
											{workspaceViewMode === "start" ? (
												<WorkspaceStartPage
													repositories={repositories}
													selectedRepository={startRepository}
													onSelectRepository={handleStartRepositorySelect}
													selectedBranch={startSourceBranch}
													branches={startSurface.startBranches}
													branchesLoading={startSurface.startBranchesLoading}
													onOpenBranchPicker={
														startSurfaceActions.refetchBranches
													}
													onSelectBranch={handleStartSourceBranchSelect}
													mode={startMode}
													onModeChange={startSurfaceActions.selectMode}
													onCreateAndCheckoutBranch={async (branch) => {
														if (!startRepository) return;
														// Lazy: just remember the desired name. Actual
														// `git checkout -b` runs at submit time inside
														// `startSurfaceActions.prepareComposer`.
														startSurfaceActions.stashPendingNewBranch(branch);
													}}
													previewCard={startPreviewCard}
													previewAppendContextTarget={startComposerInsertTarget}
													showWindowSafeTop={sidebarCollapsed}
													onClosePreview={handleStartContextPreviewClose}
												>
													<WorkspaceConversationContainer
														selectedWorkspaceId={null}
														displayedWorkspaceId={null}
														selectedSessionId={null}
														displayedSessionId={null}
														repoId={startRepository?.id ?? null}
														sessionSelectionHistory={[]}
														onSelectSession={handleSelectSession}
														onResolveDisplayedSession={
															handleResolveDisplayedSession
														}
														onInteractionSessionsChange={
															handleInteractionSessionsChange
														}
														activeStreams={activeStreams}
														busySessionIds={effectiveBusySessionIds}
														stoppableSessionIds={effectiveStoppableSessionIds}
														interactionRequiredSessionIds={
															interactionRequiredSessionIds
														}
														onSessionCompleted={handleSessionCompleted}
														workspaceChangeRequest={null}
														onSessionAborted={handleSessionAborted}
														pendingPromptForSession={null}
														onPendingPromptConsumed={
															handlePendingPromptConsumed
														}
														pendingInsertRequests={pendingComposerInserts}
														onPendingInsertRequestsConsumed={
															handlePendingComposerInsertsConsumed
														}
														onQueuePendingPromptForSession={
															queuePendingPromptForSession
														}
														onRequestCloseSession={requestCloseSession}
														workspaceRootPath={null}
														onOpenFileReference={handleOpenFileReference}
														composerOnly
														composerWrapperClassName="w-full"
														composerForceAvailable={Boolean(startRepository)}
														composerContextKeyOverride={startComposerContextKey}
														composerPlaceholder="Describe what you want to build"
														composerCreateContext={startCreateContext}
														contextPanelOpen={contextPanelOpen}
														onToggleContextPanel={handleToggleContextPanel}
														composerStartSubmitMenu
														composerLinkedDirectoriesController={
															startLinkedDirectoriesController
														}
													/>
												</WorkspaceStartPage>
											) : (
												<WorkspaceConversationContainer
													selectedWorkspaceId={selectedWorkspaceId}
													displayedWorkspaceId={displayedWorkspaceId}
													selectedSessionId={selectedSessionId}
													displayedSessionId={displayedSessionId}
													repoId={
														selectedWorkspaceDetailQuery.data?.repoId ?? null
													}
													sessionSelectionHistory={[
														...selectionActions.getSessionSelectionHistory(
															selectedWorkspaceId,
														),
													]}
													onSelectSession={handleSelectSession}
													onResolveDisplayedSession={
														handleResolveDisplayedSession
													}
													onInteractionSessionsChange={
														handleInteractionSessionsChange
													}
													activeStreams={activeStreams}
													busySessionIds={effectiveBusySessionIds}
													stoppableSessionIds={effectiveStoppableSessionIds}
													interactionRequiredSessionIds={
														interactionRequiredSessionIds
													}
													onSessionCompleted={handleSessionCompleted}
													workspaceChangeRequest={workspaceChangeRequest}
													onSessionAborted={handleSessionAborted}
													pendingPromptForSession={pendingPromptForSession}
													pendingCreatedWorkspaceSubmit={
														pendingCreatedWorkspaceSubmit
													}
													onPendingCreatedWorkspaceSubmitConsumed={
														handlePendingCreatedWorkspaceSubmitConsumed
													}
													onPendingPromptConsumed={handlePendingPromptConsumed}
													pendingInsertRequests={pendingComposerInserts}
													onPendingInsertRequestsConsumed={
														handlePendingComposerInsertsConsumed
													}
													onQueuePendingPromptForSession={
														queuePendingPromptForSession
													}
													onRequestCloseSession={requestCloseSession}
													workspaceRootPath={workspaceRootPath}
													onOpenFileReference={handleOpenFileReference}
													contextPanelOpen={contextPanelOpen}
													onToggleContextPanel={handleToggleContextPanel}
													contextPreviewCard={workspacePreviewCard}
													contextPreviewActive={workspacePreviewActive}
													onSelectContextPreview={
														handleWorkspaceContextPreviewSelect
													}
													onCloseContextPreview={
														handleWorkspaceContextPreviewClose
													}
													headerLeading={
														sidebarCollapsed ? (
															<WorkspaceHeaderLeading
																appUpdateStatus={appUpdateStatus}
																leftSidebarToggleShortcut={
																	leftSidebarToggleShortcut
																}
																onExpandSidebar={() =>
																	setSidebarCollapsed(false)
																}
															/>
														) : undefined
													}
													headerActions={
														selectedWorkspaceId ? (
															<WorkspaceHeaderActions
																workspaceId={selectedWorkspaceId}
																sessionId={selectedSessionId}
																installedEditors={installedEditors}
																preferredEditor={preferredEditor}
																openPreferredEditorShortcut={
																	openPreferredEditorShortcut
																}
																rightSidebarToggleShortcut={
																	rightSidebarToggleShortcut
																}
																inspectorCollapsed={inspectorCollapsed}
																onOpenPreferredEditor={
																	handleOpenPreferredEditor
																}
																onToggleInspector={() =>
																	setInspectorCollapsed(
																		(collapsed) => !collapsed,
																	)
																}
																onPickEditor={setPreferredEditorId}
																pushWorkspaceToast={pushWorkspaceToast}
															/>
														) : undefined
													}
												/>
											)}
										</div>
									</div>
								</section>

								{rightSidebarAvailable && (
									<>
										<ShellResizeSeparator
											side="inspector"
											collapsed={inspectorCollapsed}
											resizing={isInspectorResizing}
											width={inspectorWidth}
											onMouseDown={handleResizeStart("inspector")}
											onKeyDown={handleResizeKeyDown("inspector")}
										/>
										<ShellInspectorPane
											collapsed={inspectorCollapsed}
											resizing={isInspectorResizing}
											width={inspectorWidth}
											rightSidebarMode={rightSidebarMode}
											viewMode={workspaceViewMode}
											startRepository={startRepository}
											selectedWorkspaceRepository={selectedWorkspaceRepository}
											startInboxProviderTab={startInboxProviderTab}
											onStartInboxProviderTabChange={setStartInboxProviderTab}
											startInboxProviderSourceTab={startInboxProviderSourceTab}
											onStartInboxProviderSourceTabChange={
												setStartInboxProviderSourceTab
											}
											startInboxStateFilterBySource={
												startInboxStateFilterBySource
											}
											onStartInboxStateFilterBySourceChange={
												setStartInboxStateFilterBySource
											}
											startComposerInsertTarget={startComposerInsertTarget}
											startPreviewCardId={startPreviewCard?.id ?? null}
											workspacePreviewCardId={workspacePreviewCard?.id ?? null}
											onOpenStartContextCard={handleStartContextCardOpen}
											onOpenWorkspaceContextCard={
												handleWorkspaceContextCardOpen
											}
											selectedWorkspaceId={selectedWorkspaceId}
											workspaceRootPath={workspaceRootPath}
											selectedWorkspaceDetail={
												selectedWorkspaceDetailQuery.data ?? null
											}
											displayedSessionId={displayedSessionId}
											editorSessionPath={editorSession?.path ?? null}
											onOpenEditorFile={handleOpenEditorFile}
											onCommitAction={handleCommitAction}
											onReviewAction={() =>
												handleInspectorReviewAction({
													modelId:
														appSettings.reviewModelId ??
														appSettings.defaultModelId,
													effort:
														appSettings.reviewEffort ??
														appSettings.defaultEffort,
													fastMode:
														appSettings.reviewFastMode ??
														appSettings.defaultFastMode,
												})
											}
											onQueuePendingPromptForSession={
												queuePendingPromptForSession
											}
											commitButtonMode={commitButtonMode}
											commitButtonState={commitButtonState}
											workspaceChangeRequest={workspaceChangeRequest}
											workspaceForgeIsRefreshing={workspaceForgeIsRefreshing}
											onOpenSettings={handleOpenSettings}
										/>
									</>
								)}
							</div>
						</main>
						<Toaster
							theme={resolveTheme(appSettings.theme)}
							position="bottom-right"
							visibleToasts={6}
						/>
						<ReleaseAnnouncementToastHost
							onOpenChangelog={handleOpenReleaseChangelog}
							onOpenSettings={handleOpenAnnouncementSettings}
							onSetRightSidebarMode={contextPanelActions.setMode}
						/>
						{closeConfirmDialog}
						{mergeConfirmDialogNode}
					</ComposerInsertProvider>
				</SessionRunStatesProvider>
			</WorkspaceToastProvider>
			<QuitConfirmDialog sessionRunStates={effectiveSessionRunStates} />
		</TooltipProvider>
	);
}
export default App;
