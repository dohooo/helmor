import "./App.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	Check,
	ChevronDown,
	CircleAlertIcon,
	FolderOpen,
	Kanban,
	PanelLeftClose,
	PanelLeftOpen,
	PanelRightClose,
	PanelRightOpen,
} from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { ForgeAccountsHealthSentinel } from "@/components/forge-accounts-health-sentinel";
import { QuitConfirmDialog } from "@/components/quit-confirm-dialog";
import { SplashScreen } from "@/components/splash-screen";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useWorkspaceCommitLifecycle } from "@/features/commit/hooks/use-commit-lifecycle";
import {
	hydrateDraftCache,
	persistSessionDraft,
} from "@/features/composer/draft-storage";
import {
	type ComposerSubmitPayload,
	type KanbanCreateContext,
	type KanbanCreatePrepareOutcome,
	WorkspaceConversationContainer,
} from "@/features/conversation";
import { useDockUnreadBadge } from "@/features/dock-badge";
import { WorkspaceEditorSurface } from "@/features/editor";
import { WorkspaceInspectorSidebar } from "@/features/inspector";
import { KanbanPage } from "@/features/kanban";
import type { KanbanCreateState } from "@/features/kanban/main-content";
import { WorkspacesSidebarContainer } from "@/features/navigation/container";
import { AppOnboarding } from "@/features/onboarding";
import { seedNewSessionInCache } from "@/features/panel/session-cache";
import { useConfirmSessionClose } from "@/features/panel/use-confirm-session-close";
import {
	SettingsButton,
	SettingsDialog,
	type SettingsSection,
} from "@/features/settings";
import { getShortcut } from "@/features/shortcuts/registry";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import {
	type ShortcutHandler,
	useAppShortcuts,
} from "@/features/shortcuts/use-app-shortcuts";
import { useGlobalHotkeySync } from "@/features/shortcuts/use-global-hotkey-sync";
import { AppUpdateButton } from "@/features/updater/app-update-button";
import { useAppUpdater } from "@/features/updater/use-app-updater";
import { cn } from "@/lib/utils";
import { EditorIcon } from "@/shell/editor-icon";
import { useEnsureDefaultModel } from "@/shell/hooks/use-ensure-default-model";
import { useShellPanels } from "@/shell/hooks/use-panels";
import { useUiSyncBridge } from "@/shell/hooks/use-ui-sync-bridge";
import {
	clampSidebarWidth,
	findAdjacentSessionId,
	findAdjacentWorkspaceId,
	flattenWorkspaceRows,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	PREFERRED_EDITOR_STORAGE_KEY,
	SIDEBAR_RESIZE_HIT_AREA,
	SIDEBAR_RESIZE_STEP,
} from "@/shell/layout";
import { clampZoom, useZoom, ZOOM_STEP } from "@/shell/use-zoom";
import {
	createSession,
	drainPendingCliSends,
	finalizeWorkspaceFromRepo,
	markSessionRead,
	markSessionUnread,
	openWorkspaceInEditor,
	openWorkspaceInFinder,
	prepareWorkspaceFromRepo,
	prewarmSlashCommandsForWorkspace,
	type RepositoryCreateOption,
	setWorkspaceStatus,
	syncWorkspaceWithTargetBranch,
	triggerWorkspaceFetch,
	unhideSession,
	type WorkspaceDetail,
	type WorkspaceGroup,
	type WorkspaceSessionSummary,
} from "./lib/api";
import {
	type ComposerInsertRequest,
	type ResolvedComposerInsertRequest,
	resolveComposerInsertTarget,
} from "./lib/composer-insert";
import { ComposerInsertProvider } from "./lib/composer-insert-context";
import type { DiffOpenOptions, EditorSessionState } from "./lib/editor-session";
import { isPathWithinRoot } from "./lib/editor-session";
import {
	archivedWorkspacesQueryOptions,
	createHelmorQueryClient,
	detectedEditorsQueryOptions,
	helmorQueryKeys,
	helmorQueryPersister,
	repositoriesQueryOptions,
	sessionThreadMessagesQueryOptions,
	workspaceChangeRequestQueryOptions,
	workspaceDetailQueryOptions,
	workspaceForgeActionStatusQueryOptions,
	workspaceForgeQueryOptions,
	workspaceGitActionStatusQueryOptions,
	workspaceGroupsQueryOptions,
	workspaceSessionsQueryOptions,
} from "./lib/query-client";
import { SendingSessionsProvider } from "./lib/sending-sessions-context";
import {
	type AppSettings,
	type DarkTheme,
	DEFAULT_KANBAN_VIEW_STATE,
	DEFAULT_SETTINGS,
	KANBAN_OPEN_INBOX_CARDS_MAX,
	loadSettings,
	resolveTheme,
	SettingsContext,
	type ShortcutOverrides,
	saveSettings,
	THEME_STORAGE_KEY,
	type ThemeMode,
	useSettings,
} from "./lib/settings";
import { flushSidebarListsIfIdle } from "./lib/sidebar-mutation-gate";
import type { ContextCard } from "./lib/sources/types";
import { useOsNotifications } from "./lib/use-os-notifications";
import {
	describeUnknownError,
	getComposerContextKey,
	recomputeWorkspaceDetailUnread,
	recomputeWorkspaceUnreadInGroups,
	summaryToArchivedRow,
} from "./lib/workspace-helpers";
import {
	type WorkspaceToastOptions,
	WorkspaceToastProvider,
} from "./lib/workspace-toast-context";
import { StreamingFooterOverlapScenario } from "./test/e2e-scenarios/streaming-footer-overlap";

const SETTINGS_RELOAD_EVENT = "helmor:reload-settings";
const OPEN_SETTINGS_EVENT = "helmor:open-settings";
type WorkspaceViewMode = "conversation" | "editor" | "kanban";
type KanbanResizeTarget = "inbox" | "board";

type KanbanResizeState = {
	pointerX: number;
	target: KanbanResizeTarget;
	width: number;
};
const EMPTY_SENDING_SESSION_IDS = new Set<string>();

function getKanbanBoardMaxWidth() {
	if (typeof window === "undefined") {
		return MAX_SIDEBAR_WIDTH;
	}

	return Math.max(MAX_SIDEBAR_WIDTH, window.innerWidth);
}

function clampKanbanResizeWidth(target: KanbanResizeTarget, width: number) {
	if (target === "inbox") {
		return clampSidebarWidth(width);
	}

	return Math.min(getKanbanBoardMaxWidth(), Math.max(MIN_SIDEBAR_WIDTH, width));
}

function App() {
	const e2eScenario =
		typeof window === "undefined"
			? null
			: new URLSearchParams(window.location.search).get("e2eScenario");

	if (e2eScenario === "streaming-footer-overlap") {
		return <StreamingFooterOverlapScenario />;
	}

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
	const preloadSettings = useMemo<AppSettings>(() => {
		const t = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null;
		return { ...DEFAULT_SETTINGS, theme: t ?? DEFAULT_SETTINGS.theme };
	}, []);

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
	useEffect(() => {
		const handleOpenSettings = (event: Event) => {
			const detail =
				event instanceof CustomEvent &&
				event.detail &&
				typeof event.detail === "object"
					? (event.detail as { section?: unknown })
					: {};
			const section =
				typeof detail.section === "string"
					? (detail.section as SettingsSection)
					: undefined;
			setSettingsInitialSection(section);
			setSettingsWorkspaceId(null);
			setSettingsWorkspaceRepoId(null);
			setSettingsOpen(true);
		};
		window.addEventListener(OPEN_SETTINGS_EVENT, handleOpenSettings);
		return () =>
			window.removeEventListener(OPEN_SETTINGS_EVENT, handleOpenSettings);
	}, []);
	const [splashVisible, setSplashVisible] = useState(true);
	const [splashMounted, setSplashMounted] = useState(true);

	const hideSplashAfterBoot = useCallback(() => {
		window.setTimeout(() => {
			setSplashVisible(false);
			window.setTimeout(() => setSplashMounted(false), 400);
		}, 1000);
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
		const minDelay = new Promise<void>((r) => setTimeout(r, 1000));
		// Pull persisted composer drafts into the in-memory cache before
		// the splash hides, so the chat composer's synchronous
		// `loadPersistedDraft` call sees DB content on first mount
		// instead of returning null and forcing a re-hydration flicker.
		const draftHydration = hydrateDraftCache();
		void Promise.all([
			loadSettings().then(setAppSettings),
			draftHydration,
			minDelay,
		]).then(() => {
			// Start fade-out
			setSplashVisible(false);
			// Remove from DOM after transition
			setTimeout(() => setSplashMounted(false), 400);
		});
	}, []);

	useEffect(() => {
		const handleSettingsReload = () => {
			void loadSettings().then(setAppSettings);
		};

		window.addEventListener(SETTINGS_RELOAD_EVENT, handleSettingsReload);
		return () => {
			window.removeEventListener(SETTINGS_RELOAD_EVENT, handleSettingsReload);
		};
	}, []);

	return (
		<SettingsContext.Provider value={settingsContextValue}>
			<PersistQueryClientProvider
				client={queryClient}
				persistOptions={{ persister: helmorQueryPersister }}
			>
				{appSettings === null ? null : !appSettings.onboardingCompleted ? (
					<>
						<AppOnboarding onComplete={completeOnboarding} />
						<QuitConfirmDialog sendingSessionIds={EMPTY_SENDING_SESSION_IDS} />
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
							onOpenSettings={(workspaceId, workspaceRepoId) => {
								setSettingsInitialSection(undefined);
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

function KanbanNavButton({
	active,
	onClick,
	shortcut,
}: {
	active: boolean;
	onClick: () => void;
	shortcut?: string | null;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					aria-label="Open Kanban"
					aria-pressed={active}
					variant="ghost"
					size="xs"
					onClick={onClick}
					className={cn(
						!active && "text-muted-foreground hover:text-foreground",
						active && "bg-muted text-foreground hover:bg-muted",
					)}
				>
					<Kanban className="size-[15px]" strokeWidth={1.8} />
					<span className="text-[13px] leading-none">Kanban</span>
				</Button>
			</TooltipTrigger>
			<TooltipContent
				side="top"
				sideOffset={4}
				className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
			>
				<span className="leading-none">Kanban</span>
				{shortcut ? (
					<InlineShortcutDisplay
						hotkey={shortcut}
						className="text-background/60"
					/>
				) : null}
			</TooltipContent>
		</Tooltip>
	);
}

function AppShell({
	onOpenSettings,
}: {
	onOpenSettings: (
		workspaceId: string | null,
		workspaceRepoId: string | null,
	) => void;
}) {
	useZoom();
	const queryClient = useQueryClient();
	const workspaceSelectionRequestRef = useRef(0);
	const sessionSelectionRequestRef = useRef(0);
	const startupPrefetchedWorkspaceRef = useRef<string | null>(null);
	const warmedWorkspaceIdsRef = useRef<Set<string>>(new Set());
	const selectedWorkspaceIdRef = useRef<string | null>(null);
	const selectedSessionIdRef = useRef<string | null>(null);
	// Tracks which session we last persisted as "read" so the auto-read effect
	// stays idempotent when interaction-required state churns without the
	// displayed session changing.
	const lastMarkedReadSessionIdRef = useRef<string | null>(null);
	// Bumped whenever the user re-clicks the already-selected workspace. The
	// mark-session-read effect depends on this tick so a manual "mark as
	// unread" followed by clicking the same workspace clears the dot, even
	// though displayedSessionId didn't change.
	const [workspaceReselectTick, setWorkspaceReselectTick] = useState(0);
	const lastMarkedReadReselectTickRef = useRef(0);

	const workspaceViewModeRef = useRef<WorkspaceViewMode>("conversation");
	const sessionSelectionHistoryByWorkspaceRef = useRef<
		Record<string, string[]>
	>({});
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
	const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
		null,
	);
	const [displayedWorkspaceId, setDisplayedWorkspaceId] = useState<
		string | null
	>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);
	const [displayedSessionId, setDisplayedSessionId] = useState<string | null>(
		null,
	);
	const [workspaceViewMode, setWorkspaceViewMode] =
		useState<WorkspaceViewMode>("conversation");
	const [kanbanInboxWidth, setKanbanInboxWidth] = useState(280);
	const [kanbanBoardWidth, setKanbanBoardWidth] = useState(332);
	const [kanbanBoardExpanded, setKanbanBoardExpanded] = useState(false);
	const kanbanBoardRestoreWidthRef = useRef(332);
	const [kanbanResizeState, setKanbanResizeState] =
		useState<KanbanResizeState | null>(null);
	// Mirrors of the kanban header picker / toggle. Lifted from KanbanPage
	// up here so the bottom kanban composer's submit handler can read the
	// repo, source branch, and create-state the user clicked when they hit
	// Enter to spin up a new workspace. Initial values are seeded
	// optimistically from the synchronously-mounted DEFAULT_SETTINGS — the
	// real persisted blob lands moments later when SettingsContext finishes
	// loading and a mirror effect (below) overwrites these with the saved
	// values. Resolving repoId from the saved blob also waits for the
	// repositories query to resolve, see the dedicated repo-hydrate effect.
	const [kanbanRepository, setKanbanRepository] =
		useState<RepositoryCreateOption | null>(null);
	const [kanbanSourceBranch, setKanbanSourceBranch] = useState<string | null>(
		null,
	);
	const [kanbanCreateState, setKanbanCreateState] = useState<KanbanCreateState>(
		DEFAULT_KANBAN_VIEW_STATE.createState,
	);
	const [kanbanInboxProviderTab, setKanbanInboxProviderTab] = useState<string>(
		DEFAULT_KANBAN_VIEW_STATE.inboxProviderTab,
	);
	const [kanbanInboxProviderSourceTab, setKanbanInboxProviderSourceTab] =
		useState<string>(DEFAULT_KANBAN_VIEW_STATE.inboxProviderSourceTab);
	const [kanbanSourceBranchByRepoId, setKanbanSourceBranchByRepoId] = useState<
		Record<string, string>
	>(() => DEFAULT_KANBAN_VIEW_STATE.sourceBranchByRepoId);
	const [kanbanInboxStateFilterBySource, setKanbanInboxStateFilterBySource] =
		useState<Record<string, string>>(
			() => DEFAULT_KANBAN_VIEW_STATE.inboxStateFilterBySource,
		);
	const [kanbanOpenInboxCards, setKanbanOpenInboxCards] = useState<
		ContextCard[]
	>(() => DEFAULT_KANBAN_VIEW_STATE.openInboxCards);
	const [editorSession, setEditorSession] = useState<EditorSessionState | null>(
		null,
	);
	const [sendingWorkspaceIds, setSendingWorkspaceIds] = useState<Set<string>>(
		() => new Set(),
	);
	// Session IDs currently streaming — reported by WorkspaceConversationContainer
	// and consumed by the commit button driver to detect stream completion.
	const [sendingSessionIds, setSendingSessionIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [pendingComposerInserts, setPendingComposerInserts] = useState<
		ResolvedComposerInsertRequest[]
	>([]);
	// Tracks sessions that have reached a terminal "done" event at least once
	// in this app run. Used by the commit lifecycle to know when to prompt.
	// Distinct from "unread" — `unreadCount` is the persisted, cross-restart
	// signal driven entirely from the backend.
	const [settledSessionIds, setSettledSessionIds] = useState<Set<string>>(
		() => new Set(),
	);
	// Sessions that terminated via abort (stop stream) rather than normal
	// completion. Used by the commit lifecycle to return the button to idle
	// when the user aborts an action session (e.g. Create PR).
	const [abortedSessionIds, setAbortedSessionIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [interactionRequiredSessions, setInteractionRequiredSessions] =
		useState<Map<string, string>>(() => new Map());
	const interactionRequiredSessionIds = useMemo(
		() => new Set(interactionRequiredSessions.keys()),
		[interactionRequiredSessions],
	);
	const interactionRequiredWorkspaceIds = useMemo(
		() => new Set(interactionRequiredSessions.values()),
		[interactionRequiredSessions],
	);

	// Persist "session read" once the user actually views a session AND it is
	// not waiting on an interaction prompt. Workspace.unread is purely derived
	// from sessions, so clearing the session naturally drops the workspace red
	// dot when no other sessions remain unread. Selecting a workspace alone
	// must NOT clear unread state — only opening a session does.
	//
	// Optimistically applies the cleared state to the cache so the sidebar dot
	// and dock badge react instantly, then commits via IPC + invalidate. If the
	// IPC fails the optimistic patch is rolled back.
	useEffect(() => {
		if (!displayedSessionId) {
			lastMarkedReadSessionIdRef.current = null;
			return;
		}
		if (interactionRequiredSessionIds.has(displayedSessionId)) {
			// Reset the dedupe key so once the interaction completes the next
			// effect run will fire the IPC.
			lastMarkedReadSessionIdRef.current = null;
			return;
		}
		if (
			lastMarkedReadSessionIdRef.current === displayedSessionId &&
			workspaceReselectTick === lastMarkedReadReselectTickRef.current
		) {
			return;
		}

		const sessionId = displayedSessionId;
		const workspaceId = selectedWorkspaceIdRef.current;
		lastMarkedReadSessionIdRef.current = sessionId;
		lastMarkedReadReselectTickRef.current = workspaceReselectTick;

		// Snapshot for rollback on IPC failure.
		const previousGroups = queryClient.getQueryData(
			helmorQueryKeys.workspaceGroups,
		);
		const previousDetail = workspaceId
			? queryClient.getQueryData(helmorQueryKeys.workspaceDetail(workspaceId))
			: undefined;
		const previousSessions = workspaceId
			? queryClient.getQueryData(helmorQueryKeys.workspaceSessions(workspaceId))
			: undefined;

		// Optimistic: clear this session's unread in the sessions cache, then
		// recompute the owning workspace's hasUnread / unreadSessionCount /
		// workspaceUnread from the patched session list. Sidebar dot and dock
		// badge react instantly; the IPC + invalidate afterwards reconciles.
		let remainingUnread = 0;
		if (workspaceId) {
			const currentSessions = queryClient.getQueryData<
				WorkspaceSessionSummary[] | undefined
			>(helmorQueryKeys.workspaceSessions(workspaceId));
			if (Array.isArray(currentSessions)) {
				const patched = currentSessions.map((session) =>
					session.id === sessionId ? { ...session, unreadCount: 0 } : session,
				);
				remainingUnread = patched.filter((s) => s.unreadCount > 0).length;
				queryClient.setQueryData<WorkspaceSessionSummary[]>(
					helmorQueryKeys.workspaceSessions(workspaceId),
					patched,
				);
			}
			queryClient.setQueryData<WorkspaceGroup[] | undefined>(
				helmorQueryKeys.workspaceGroups,
				(current) =>
					recomputeWorkspaceUnreadInGroups(
						current,
						workspaceId,
						remainingUnread,
					),
			);
			queryClient.setQueryData<WorkspaceDetail | null | undefined>(
				helmorQueryKeys.workspaceDetail(workspaceId),
				(current) =>
					current
						? recomputeWorkspaceDetailUnread(current, remainingUnread)
						: current,
			);
		}

		void markSessionRead(sessionId)
			.then(() => {
				// Skip sidebar-list invalidations while a sidebar mutation
				// (archive/restore/create/delete/pin) is in flight: the server
				// state is mid-transition and a refetch here would overwrite
				// the optimistic cache with a stale snapshot, bouncing the row
				// back to its pre-mutation position. The mutation owner flushes
				// these lists in its own `.finally`.
				flushSidebarListsIfIdle(queryClient);
				const invalidations: Promise<void>[] = [];
				if (workspaceId) {
					invalidations.push(
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
						}),
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
						}),
					);
				}
				return Promise.all(invalidations);
			})
			.catch((error) => {
				// Roll back the optimistic patch and reset dedupe so a retry can
				// succeed.
				queryClient.setQueryData(
					helmorQueryKeys.workspaceGroups,
					previousGroups,
				);
				if (workspaceId) {
					queryClient.setQueryData(
						helmorQueryKeys.workspaceDetail(workspaceId),
						previousDetail,
					);
					queryClient.setQueryData(
						helmorQueryKeys.workspaceSessions(workspaceId),
						previousSessions,
					);
				}
				if (lastMarkedReadSessionIdRef.current === sessionId) {
					lastMarkedReadSessionIdRef.current = null;
				}
				console.error("[app] mark session read on view:", error);
			});
	}, [
		displayedSessionId,
		interactionRequiredSessionIds,
		queryClient,
		workspaceReselectTick,
	]);

	const {
		settings: appSettings,
		isLoaded: areSettingsLoaded,
		updateSettings,
	} = useSettings();
	const appUpdateStatus = useAppUpdater();
	useDockUnreadBadge();
	useEnsureDefaultModel();
	const notify = useOsNotifications(appSettings);
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
		window.dispatchEvent(new Event("helmor:open-model-picker"));
	}, []);
	const handlePullLatest = useCallback(async () => {
		if (!selectedWorkspaceId) return;
		try {
			const result = await syncWorkspaceWithTargetBranch(selectedWorkspaceId);
			if (result.outcome === "updated") {
				toast.success(`Pulled latest from ${result.targetBranch}`);
			} else if (result.outcome === "alreadyUpToDate") {
				toast(`Already up to date with ${result.targetBranch}`);
			} else {
				toast.error(`Pull from ${result.targetBranch} needs attention`);
			}
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Unable to pull target branch updates.",
			);
		} finally {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey:
						helmorQueryKeys.workspaceGitActionStatus(selectedWorkspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceChangeRequest(selectedWorkspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey:
						helmorQueryKeys.workspaceForgeActionStatus(selectedWorkspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(selectedWorkspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGroups,
				}),
				queryClient.invalidateQueries({ queryKey: ["workspaceChanges"] }),
			]);
		}
	}, [queryClient, selectedWorkspaceId]);

	const navigationGroupsQuery = useQuery(workspaceGroupsQueryOptions());
	const navigationArchivedQuery = useQuery(archivedWorkspacesQueryOptions());
	const workspaceGroups = navigationGroupsQuery.data ?? [];
	const archivedRows = useMemo(
		() => (navigationArchivedQuery.data ?? []).map(summaryToArchivedRow),
		[navigationArchivedQuery.data],
	);
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

	useEffect(() => {
		selectedWorkspaceIdRef.current = selectedWorkspaceId;
	}, [selectedWorkspaceId]);

	useEffect(() => {
		selectedSessionIdRef.current = selectedSessionId;
	}, [selectedSessionId]);

	useEffect(() => {
		workspaceViewModeRef.current = workspaceViewMode;
	}, [workspaceViewMode]);

	useEffect(() => {
		if (!kanbanResizeState) {
			return;
		}

		let pendingWidth: number | null = null;
		let rafId: number | null = null;
		const flush = () => {
			rafId = null;
			if (pendingWidth === null) return;
			const nextWidth = pendingWidth;
			pendingWidth = null;
			if (kanbanResizeState.target === "inbox") {
				setKanbanInboxWidth(nextWidth);
			} else {
				setKanbanBoardWidth(nextWidth);
			}
		};

		const handleMouseMove = (event: globalThis.MouseEvent) => {
			const deltaX = event.clientX - kanbanResizeState.pointerX;
			const rawWidth =
				kanbanResizeState.target === "inbox"
					? kanbanResizeState.width + deltaX
					: kanbanResizeState.width - deltaX;
			pendingWidth = clampKanbanResizeWidth(kanbanResizeState.target, rawWidth);
			if (rafId === null) {
				rafId = window.requestAnimationFrame(flush);
			}
		};
		const handleMouseUp = () => {
			if (rafId !== null) {
				window.cancelAnimationFrame(rafId);
				rafId = null;
			}
			flush();
			setKanbanResizeState(null);
		};
		const previousCursor = document.body.style.cursor;
		const previousUserSelect = document.body.style.userSelect;

		document.body.style.cursor = "ew-resize";
		document.body.style.userSelect = "none";

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);

		return () => {
			if (rafId !== null) {
				window.cancelAnimationFrame(rafId);
			}
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousUserSelect;
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};
	}, [kanbanResizeState]);

	const handleKanbanResizeStart = useCallback(
		(target: KanbanResizeTarget) =>
			(event: ReactMouseEvent<HTMLDivElement>) => {
				if (event.button !== 0) return;
				event.preventDefault();
				if (target === "board") {
					setKanbanBoardExpanded(false);
				}
				setKanbanResizeState({
					pointerX: event.clientX,
					target,
					width: target === "inbox" ? kanbanInboxWidth : kanbanBoardWidth,
				});
			},
		[kanbanBoardWidth, kanbanInboxWidth],
	);

	const handleKanbanBoardExpandToggle = useCallback(
		(expandedWidth: number) => {
			if (kanbanBoardExpanded) {
				setKanbanBoardWidth(
					clampKanbanResizeWidth("board", kanbanBoardRestoreWidthRef.current),
				);
				setKanbanBoardExpanded(false);
				return;
			}

			kanbanBoardRestoreWidthRef.current = kanbanBoardWidth;
			setKanbanBoardWidth(clampKanbanResizeWidth("board", expandedWidth));
			setKanbanBoardExpanded(true);
		},
		[kanbanBoardExpanded, kanbanBoardWidth],
	);

	const handleKanbanResizeKeyDown = useCallback(
		(target: KanbanResizeTarget) =>
			(event: ReactKeyboardEvent<HTMLDivElement>) => {
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					if (target === "inbox") {
						setKanbanInboxWidth((currentWidth) =>
							clampKanbanResizeWidth(
								target,
								currentWidth - SIDEBAR_RESIZE_STEP,
							),
						);
						return;
					}

					setKanbanBoardExpanded(false);
					setKanbanBoardWidth((currentWidth) =>
						clampKanbanResizeWidth(target, currentWidth + SIDEBAR_RESIZE_STEP),
					);
				}

				if (event.key === "ArrowRight") {
					event.preventDefault();
					if (target === "inbox") {
						setKanbanInboxWidth((currentWidth) =>
							clampKanbanResizeWidth(
								target,
								currentWidth + SIDEBAR_RESIZE_STEP,
							),
						);
						return;
					}

					setKanbanBoardExpanded(false);
					setKanbanBoardWidth((currentWidth) =>
						clampKanbanResizeWidth(target, currentWidth - SIDEBAR_RESIZE_STEP),
					);
				}
			},
		[],
	);

	// Persist last workspace/session for restore-on-launch
	useEffect(() => {
		if (selectedWorkspaceId) {
			void saveSettings({ lastWorkspaceId: selectedWorkspaceId });
		}
	}, [selectedWorkspaceId]);

	useEffect(() => {
		if (selectedSessionId) {
			void saveSettings({ lastSessionId: selectedSessionId });
		}
	}, [selectedSessionId]);

	const rememberSessionSelection = useCallback(
		(workspaceId: string | null, sessionId: string | null) => {
			if (!workspaceId || !sessionId) {
				return;
			}

			const current =
				sessionSelectionHistoryByWorkspaceRef.current[workspaceId] ?? [];
			const next = [...current.filter((id) => id !== sessionId), sessionId];
			sessionSelectionHistoryByWorkspaceRef.current[workspaceId] =
				next.slice(-16);
		},
		[],
	);

	useEffect(() => {
		if (!editorSession) {
			return;
		}

		if (isPathWithinRoot(editorSession.path, workspaceRootPath)) {
			return;
		}

		setWorkspaceViewMode("conversation");
		setEditorSession(null);
	}, [editorSession, workspaceRootPath]);

	useEffect(() => {
		const apply = () => {
			const effective = resolveTheme(appSettings.theme);
			document.documentElement.classList.toggle("dark", effective === "dark");
			document.documentElement.style.colorScheme = effective;
			// Monaco's theme is synced via a MutationObserver inside
			// `monaco-runtime.ts` — avoid importing it here to keep Monaco out
			// of the critical boot path and out of tests that never open the
			// editor.
		};

		apply();

		if (
			appSettings.theme === "system" &&
			typeof window.matchMedia === "function"
		) {
			const mq = window.matchMedia("(prefers-color-scheme: dark)");
			mq.addEventListener("change", apply);
			return () => mq.removeEventListener("change", apply);
		}
	}, [appSettings.theme]);

	useEffect(() => {
		const DARK_THEME_CLASSES: DarkTheme[] = [
			"midnight",
			"forest",
			"ember",
			"aurora",
		];
		for (const t of DARK_THEME_CLASSES) {
			document.documentElement.classList.remove(`theme-${t}`);
		}
		if (appSettings.darkTheme && appSettings.darkTheme !== "default") {
			document.documentElement.classList.add(`theme-${appSettings.darkTheme}`);
		}
	}, [appSettings.darkTheme]);

	const confirmDiscardEditorChanges = useCallback(
		(action: string) => {
			if (!editorSession?.dirty) {
				return true;
			}

			if (typeof window === "undefined") {
				return false;
			}

			return window.confirm(
				`You have unsaved changes in ${editorSession.path}. Discard them and ${action}?`,
			);
		},
		[editorSession],
	);

	const handleEditorSurfaceError = useCallback(
		(description: string, title = "Editor action failed") => {
			pushWorkspaceToast(description, title);
		},
		[pushWorkspaceToast],
	);

	const handleOpenEditorFile = useCallback(
		(path: string, options?: DiffOpenOptions) => {
			if (!workspaceRootPath) {
				pushWorkspaceToast(
					"Open a workspace with a resolved root path before using the in-app editor.",
					"Editor unavailable",
				);
				return;
			}

			if (editorSession?.path === path) {
				return;
			}

			if (!confirmDiscardEditorChanges("open another file")) {
				return;
			}

			const status = options?.fileStatus ?? "M";

			// Background fetch so the next view reflects latest remote state
			if (selectedWorkspaceId) {
				triggerWorkspaceFetch(selectedWorkspaceId);
			}

			setWorkspaceViewMode("editor");
			setEditorSession({
				kind: "diff",
				path,
				inline: status !== "M",
				dirty: false,
				fileStatus: status,
				originalRef: options?.originalRef,
				modifiedRef: options?.modifiedRef,
			});
		},
		[
			confirmDiscardEditorChanges,
			editorSession?.path,
			pushWorkspaceToast,
			selectedWorkspaceId,
			workspaceRootPath,
		],
	);

	const handleOpenFileReference = useCallback(
		(path: string, line?: number, column?: number) => {
			if (!workspaceRootPath) {
				pushWorkspaceToast(
					"Open a workspace with a resolved root path before using the in-app editor.",
					"Editor unavailable",
				);
				return;
			}

			if (!isPathWithinRoot(path, workspaceRootPath)) {
				pushWorkspaceToast(
					"Only files inside the current workspace can be opened in the in-app editor.",
					"File unavailable",
				);
				return;
			}

			if (
				editorSession?.path !== path &&
				!confirmDiscardEditorChanges("open another file")
			) {
				return;
			}

			if (selectedWorkspaceId) {
				triggerWorkspaceFetch(selectedWorkspaceId);
			}

			setWorkspaceViewMode("editor");
			setEditorSession((current) => ({
				kind: "file",
				path,
				line,
				column,
				dirty: current?.path === path ? current.dirty : false,
				originalText: current?.path === path ? current.originalText : undefined,
				modifiedText: current?.path === path ? current.modifiedText : undefined,
				mtimeMs: current?.path === path ? current.mtimeMs : undefined,
			}));
		},
		[
			confirmDiscardEditorChanges,
			editorSession?.path,
			pushWorkspaceToast,
			selectedWorkspaceId,
			workspaceRootPath,
		],
	);

	const handleEditorSessionChange = useCallback(
		(session: EditorSessionState) => {
			setEditorSession(session);
		},
		[],
	);

	const handleExitEditorMode = useCallback(() => {
		if (!confirmDiscardEditorChanges("return to chat")) {
			return;
		}

		setWorkspaceViewMode("conversation");
		setEditorSession(null);
	}, [confirmDiscardEditorChanges]);

	const primeWorkspaceDisplay = useCallback(
		async (workspaceId: string) => {
			const [workspaceDetail, workspaceSessions] = await Promise.all([
				queryClient.ensureQueryData(workspaceDetailQueryOptions(workspaceId)),
				queryClient.ensureQueryData(workspaceSessionsQueryOptions(workspaceId)),
			]);

			const resolvedSessionId =
				workspaceDetail?.activeSessionId ??
				workspaceSessions.find((session) => session.active)?.id ??
				workspaceSessions[0]?.id ??
				null;

			if (resolvedSessionId) {
				await queryClient.ensureQueryData(
					sessionThreadMessagesQueryOptions(resolvedSessionId),
				);
			}

			return {
				workspaceId,
				sessionId: resolvedSessionId,
			};
		},
		[queryClient],
	);

	const resolveCachedWorkspaceDisplay = useCallback(
		(workspaceId: string, preferredSessionId?: string | null) => {
			const workspaceDetail = queryClient.getQueryData<WorkspaceDetail | null>(
				helmorQueryKeys.workspaceDetail(workspaceId),
			);
			const workspaceSessions = queryClient.getQueryData<
				WorkspaceSessionSummary[] | undefined
			>(helmorQueryKeys.workspaceSessions(workspaceId));

			if (!workspaceDetail || !Array.isArray(workspaceSessions)) {
				return null;
			}

			const sessionId =
				preferredSessionId ??
				workspaceDetail.activeSessionId ??
				workspaceSessions.find((session) => session.active)?.id ??
				workspaceSessions[0]?.id ??
				null;
			const hasSessionMessages =
				sessionId === null ||
				queryClient.getQueryData([
					...helmorQueryKeys.sessionMessages(sessionId),
					"thread",
				]) !== undefined;

			if (!hasSessionMessages) {
				return null;
			}

			return {
				workspaceId,
				sessionId,
			};
		},
		[queryClient],
	);

	const resolvePreferredSessionId = useCallback(
		(workspaceId: string) => {
			const sessionHistory =
				sessionSelectionHistoryByWorkspaceRef.current[workspaceId] ?? [];
			const workspaceDetail = queryClient.getQueryData<WorkspaceDetail | null>(
				helmorQueryKeys.workspaceDetail(workspaceId),
			);
			const workspaceSessions =
				queryClient.getQueryData<WorkspaceSessionSummary[] | undefined>(
					helmorQueryKeys.workspaceSessions(workspaceId),
				) ?? [];

			const sessionIds =
				workspaceSessions.length > 0
					? new Set(workspaceSessions.map((session) => session.id))
					: null;

			if (sessionIds) {
				for (let i = sessionHistory.length - 1; i >= 0; i -= 1) {
					const sessionId = sessionHistory[i];
					if (sessionIds.has(sessionId)) {
						return sessionId;
					}
				}
			}

			if (sessionHistory.length > 0) {
				return sessionHistory[sessionHistory.length - 1] ?? null;
			}

			// Restore last session from persisted settings
			if (
				appSettings.lastSessionId &&
				(!sessionIds || sessionIds.has(appSettings.lastSessionId))
			) {
				return appSettings.lastSessionId;
			}

			return (
				workspaceDetail?.activeSessionId ??
				workspaceSessions.find((session) => session.active)?.id ??
				workspaceSessions[0]?.id ??
				null
			);
		},
		[queryClient, appSettings.lastSessionId],
	);

	const primeInitialWorkspaceDisplay = useCallback(
		async (workspaceId: string) => {
			await primeWorkspaceDisplay(workspaceId);
		},
		[primeWorkspaceDisplay],
	);

	useEffect(() => {
		if (!selectedWorkspaceId || displayedWorkspaceId !== null) {
			return;
		}

		if (startupPrefetchedWorkspaceRef.current === selectedWorkspaceId) {
			return;
		}

		startupPrefetchedWorkspaceRef.current = selectedWorkspaceId;
		void primeInitialWorkspaceDisplay(selectedWorkspaceId).catch(() => {
			// Keep the first paint path resilient even if prewarm fails.
		});
	}, [displayedWorkspaceId, primeInitialWorkspaceDisplay, selectedWorkspaceId]);

	useEffect(() => {
		const candidateWorkspaceIds = flattenWorkspaceRows(
			workspaceGroups,
			archivedRows,
		)
			.map((row) => row.id)
			.filter((workspaceId) => workspaceId !== selectedWorkspaceId)
			.slice(0, 4);

		if (candidateWorkspaceIds.length === 0) {
			return;
		}

		let cancelled = false;
		let timeoutId: number | null = null;

		const warmNext = async (index: number) => {
			if (cancelled || index >= candidateWorkspaceIds.length) {
				return;
			}

			const workspaceId = candidateWorkspaceIds[index];
			if (!workspaceId || warmedWorkspaceIdsRef.current.has(workspaceId)) {
				void warmNext(index + 1);
				return;
			}

			warmedWorkspaceIdsRef.current.add(workspaceId);
			try {
				await primeWorkspaceDisplay(workspaceId);
			} catch {
				// Best-effort background warmup only.
			}

			if (!cancelled) {
				timeoutId = window.setTimeout(() => {
					void warmNext(index + 1);
				}, 150);
			}
		};

		timeoutId = window.setTimeout(() => {
			void warmNext(0);
		}, 400);

		return () => {
			cancelled = true;
			if (timeoutId !== null) {
				window.clearTimeout(timeoutId);
			}
		};
	}, [
		archivedRows,
		primeWorkspaceDisplay,
		selectedWorkspaceId,
		workspaceGroups,
	]);

	const handleSelectWorkspace = useCallback(
		(workspaceId: string | null) => {
			if (workspaceViewModeRef.current === "kanban") {
				setWorkspaceViewMode("conversation");
			}

			if (workspaceId === selectedWorkspaceIdRef.current) {
				// Re-clicking the currently selected workspace: force the
				// mark-session-read effect to re-evaluate so a lingering dot
				// from a manual "mark as unread" clears, without tearing down
				// the current session view.
				if (workspaceId !== null) {
					setWorkspaceReselectTick((tick) => tick + 1);
				}
				return;
			}

			const requestId = workspaceSelectionRequestRef.current + 1;
			workspaceSelectionRequestRef.current = requestId;
			sessionSelectionRequestRef.current += 1;
			selectedWorkspaceIdRef.current = workspaceId;
			const immediateSessionId = workspaceId
				? resolvePreferredSessionId(workspaceId)
				: null;
			selectedSessionIdRef.current = immediateSessionId;
			setSelectedWorkspaceId(workspaceId);
			setSelectedSessionId(immediateSessionId);

			if (workspaceId) {
				// Skip git fetch while the worktree is still being created —
				// `state === "initializing"` means Phase 2 hasn't finished
				// materializing the worktree on disk yet.
				const cachedDetail = queryClient.getQueryData<WorkspaceDetail | null>(
					helmorQueryKeys.workspaceDetail(workspaceId),
				);
				if (cachedDetail?.state !== "initializing") {
					triggerWorkspaceFetch(workspaceId);
					// Prewarm the slash-command cache for the new workspace so
					// the next `/` press hits warm data (or at least falls back
					// to the repo-level cache while this refresh completes).
					void prewarmSlashCommandsForWorkspace(workspaceId);
				}
			}

			// Session-level completed dots are cleared reactively via the
			// displayedSessionId effect — only the actually-viewed session
			// loses its dot, not every session in the workspace.
			if (workspaceId === null) {
				if (workspaceSelectionRequestRef.current !== requestId) {
					return;
				}
				setDisplayedWorkspaceId(null);
				setDisplayedSessionId(null);
				return;
			}

			setDisplayedWorkspaceId(workspaceId);
			setDisplayedSessionId(immediateSessionId);

			const cachedWorkspaceDisplay = resolveCachedWorkspaceDisplay(
				workspaceId,
				immediateSessionId,
			);
			if (cachedWorkspaceDisplay) {
				selectedSessionIdRef.current = cachedWorkspaceDisplay.sessionId;
				rememberSessionSelection(workspaceId, cachedWorkspaceDisplay.sessionId);
				setSelectedSessionId(cachedWorkspaceDisplay.sessionId);
				if (workspaceSelectionRequestRef.current !== requestId) {
					return;
				}
				setDisplayedWorkspaceId(cachedWorkspaceDisplay.workspaceId);
				setDisplayedSessionId(cachedWorkspaceDisplay.sessionId);
				void queryClient.prefetchQuery(
					workspaceDetailQueryOptions(workspaceId),
				);
				void queryClient.prefetchQuery(
					workspaceSessionsQueryOptions(workspaceId),
				);
				if (cachedWorkspaceDisplay.sessionId) {
					void queryClient.prefetchQuery(
						sessionThreadMessagesQueryOptions(cachedWorkspaceDisplay.sessionId),
					);
				}
				return;
			}

			void primeWorkspaceDisplay(workspaceId)
				.then(({ sessionId }) => {
					if (workspaceSelectionRequestRef.current !== requestId) {
						return;
					}

					selectedSessionIdRef.current = sessionId;
					rememberSessionSelection(workspaceId, sessionId);
					setSelectedSessionId(sessionId);
					setDisplayedWorkspaceId(workspaceId);
					setDisplayedSessionId(sessionId);
				})
				.catch(() => {
					if (workspaceSelectionRequestRef.current !== requestId) {
						return;
					}

					setDisplayedWorkspaceId(workspaceId);
					setDisplayedSessionId(null);
				});
		},
		[
			primeWorkspaceDisplay,
			queryClient,
			rememberSessionSelection,
			resolveCachedWorkspaceDisplay,
			resolvePreferredSessionId,
		],
	);

	const handleSelectSession = useCallback(
		(sessionId: string | null) => {
			if (sessionId === selectedSessionIdRef.current) {
				return;
			}

			const requestId = sessionSelectionRequestRef.current + 1;
			sessionSelectionRequestRef.current = requestId;
			rememberSessionSelection(selectedWorkspaceIdRef.current, sessionId);
			selectedSessionIdRef.current = sessionId;
			setSelectedSessionId(sessionId);
			if (sessionId === null) {
				if (sessionSelectionRequestRef.current !== requestId) {
					return;
				}
				setDisplayedSessionId(null);
				return;
			}

			if (
				queryClient.getQueryData([
					...helmorQueryKeys.sessionMessages(sessionId),
					"thread",
				]) !== undefined
			) {
				if (sessionSelectionRequestRef.current !== requestId) {
					return;
				}
				setDisplayedSessionId(sessionId);
				void queryClient.prefetchQuery(
					sessionThreadMessagesQueryOptions(sessionId),
				);
				return;
			}

			void queryClient
				.ensureQueryData(sessionThreadMessagesQueryOptions(sessionId))
				.then(() => {
					if (sessionSelectionRequestRef.current !== requestId) {
						return;
					}

					setDisplayedSessionId(sessionId);
				})
				.catch(() => {
					if (sessionSelectionRequestRef.current !== requestId) {
						return;
					}

					setDisplayedSessionId(sessionId);
				});
		},
		[queryClient, rememberSessionSelection],
	);

	const {
		commitButtonMode,
		commitButtonState,
		handleInspectorCommitAction,
		handleInspectorReviewAction,
		handlePendingPromptConsumed,
		pendingPromptForSession,
		queuePendingPromptForSession,
	} = useWorkspaceCommitLifecycle({
		queryClient,
		selectedWorkspaceId,
		selectedWorkspaceIdRef,
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
		sendingSessionIds,
		onSelectSession: handleSelectSession,
		pushToast: pushWorkspaceToast,
	});

	const handleSessionCompleted = useCallback(
		(sessionId: string, workspaceId: string) => {
			setSettledSessionIds((prev) => {
				if (prev.has(sessionId)) return prev;
				const next = new Set(prev);
				next.add(sessionId);
				return next;
			});

			const isCurrentSession = sessionId === selectedSessionIdRef.current;
			// Bump session-level unread for sessions the user isn't viewing.
			// Workspace.unread is purely derived, so this also drives the
			// sidebar workspace dot and the dock badge.
			if (!isCurrentSession) {
				void markSessionUnread(sessionId)
					.then(() => {
						// Same rationale as the mark-read path — defer the
						// sidebar-list flush when a mutation owns the cache.
						flushSidebarListsIfIdle(queryClient);
						return Promise.all([
							queryClient.invalidateQueries({
								queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
							}),
							queryClient.invalidateQueries({
								queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
							}),
						]);
					})
					.catch((error) => {
						console.error("[app] mark session unread on completion:", error);
					});
			}
			// OS notification: skip when user is focused on this session
			if (document.hasFocus() && isCurrentSession) return;
			const name =
				queryClient.getQueryData<WorkspaceDetail | null>(
					helmorQueryKeys.workspaceDetail(workspaceId),
				)?.title ?? "Workspace";
			notify({ title: "Session completed", body: name });
		},
		[notify, queryClient],
	);

	const handleSessionAborted = useCallback((sessionId: string) => {
		setAbortedSessionIds((prev) => {
			if (prev.has(sessionId)) return prev;
			const next = new Set(prev);
			next.add(sessionId);
			return next;
		});
	}, []);

	const lastInteractionCountsRef = useRef<Map<string, number>>(new Map());
	const handleInteractionSessionsChange = useCallback(
		(nextMap: Map<string, string>, counts: Map<string, number>) => {
			// Notify for new sessions or sessions with increased interaction count
			for (const [sessionId, workspaceId] of nextMap) {
				const count = counts.get(sessionId) ?? 0;
				const prev = lastInteractionCountsRef.current.get(sessionId) ?? 0;
				if (count > prev) {
					const name =
						queryClient.getQueryData<WorkspaceDetail | null>(
							helmorQueryKeys.workspaceDetail(workspaceId),
						)?.title ?? "Workspace";
					notify({ title: "Input needed", body: name });
				}
			}
			// Track counts (only for sessions still in the map)
			const nextCounts = new Map<string, number>();
			for (const [sessionId] of nextMap) {
				nextCounts.set(sessionId, counts.get(sessionId) ?? 0);
			}
			lastInteractionCountsRef.current = nextCounts;

			setInteractionRequiredSessions((current) => {
				if (current.size === nextMap.size) {
					let unchanged = true;
					for (const [sessionId, workspaceId] of nextMap) {
						if (current.get(sessionId) !== workspaceId) {
							unchanged = false;
							break;
						}
					}
					if (unchanged) return current;
				}
				return new Map(nextMap);
			});
		},
		[notify, queryClient],
	);

	const getCloseableCurrentSession = useCallback(() => {
		if (workspaceViewModeRef.current !== "conversation") {
			return null;
		}

		const workspaceId = selectedWorkspaceIdRef.current;
		const sessionId = selectedSessionIdRef.current;
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
	}, [queryClient]);

	// Stack of recently hidden sessions for "Reopen closed session". LIFO so
	// repeated invocations walk back through history. Empty (deleted) sessions
	// are not tracked because the backend can't restore them.
	const recentlyClosedSessionsRef = useRef<
		{ sessionId: string; workspaceId: string }[]
	>([]);
	const handleSessionHidden = useCallback(
		(sessionId: string, workspaceId: string) => {
			recentlyClosedSessionsRef.current = [
				{ sessionId, workspaceId },
				...recentlyClosedSessionsRef.current.filter(
					(entry) => entry.sessionId !== sessionId,
				),
			].slice(0, 20);
		},
		[],
	);

	const { requestClose: requestCloseSession, dialogNode: closeConfirmDialog } =
		useConfirmSessionClose({
			sendingSessionIds,
			onSelectSession: handleSelectSession,
			onSessionHidden: handleSessionHidden,
			pushToast: pushWorkspaceToast,
			queryClient,
		});

	const handleReopenClosedSession = useCallback(async () => {
		const next = recentlyClosedSessionsRef.current[0];
		if (!next) return;
		recentlyClosedSessionsRef.current =
			recentlyClosedSessionsRef.current.slice(1);
		try {
			await unhideSession(next.sessionId);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(next.workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceSessions(next.workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGroups,
				}),
			]);
			handleSelectWorkspace(next.workspaceId);
			handleSelectSession(next.sessionId);
		} catch (error) {
			pushWorkspaceToast(
				error instanceof Error ? error.message : String(error),
				"Unable to reopen session",
				"destructive",
			);
		}
	}, [
		handleSelectSession,
		handleSelectWorkspace,
		pushWorkspaceToast,
		queryClient,
	]);

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
				void Promise.all([
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
					}),
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
					}),
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceGroups,
					}),
					queryClient.invalidateQueries({
						queryKey: [...helmorQueryKeys.sessionMessages(sessionId), "thread"],
					}),
				]);
			},
		});
	}, [getCloseableCurrentSession, queryClient, requestCloseSession]);

	const handleCreateSession = useCallback(async () => {
		const workspaceId = selectedWorkspaceIdRef.current;
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
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGroups,
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
			const workspaceId = selectedWorkspaceIdRef.current;
			if (!workspaceId) {
				return;
			}

			const workspaceSessions =
				queryClient.getQueryData<WorkspaceSessionSummary[]>(
					helmorQueryKeys.workspaceSessions(workspaceId),
				) ?? [];
			const nextSessionId = findAdjacentSessionId(
				workspaceSessions,
				selectedSessionIdRef.current,
				offset,
			);

			if (!nextSessionId) {
				return;
			}

			handleSelectSession(nextSessionId);
		},
		[handleSelectSession, queryClient],
	);

	const handleNavigateWorkspaces = useCallback(
		(offset: -1 | 1) => {
			const nextWorkspaceId = findAdjacentWorkspaceId(
				workspaceGroups,
				archivedRows,
				selectedWorkspaceIdRef.current,
				offset,
			);

			if (!nextWorkspaceId) {
				return;
			}

			handleSelectWorkspace(nextWorkspaceId);
		},
		[archivedRows, handleSelectWorkspace, workspaceGroups],
	);

	const handleToggleKanban = useCallback(() => {
		setWorkspaceViewMode((mode) =>
			mode === "kanban" ? "conversation" : "kanban",
		);
	}, []);

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
				callback: () =>
					window.dispatchEvent(new Event("helmor:open-new-workspace")),
			},
			{
				id: "workspace.addRepository" as const,
				callback: () =>
					window.dispatchEvent(new Event("helmor:open-add-repository")),
			},
			{
				id: "workspace.toggleKanban" as const,
				callback: handleToggleKanban,
				enabled: workspaceViewMode !== "editor",
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
					if (!getCloseableCurrentSession()) return;
					void handleCloseSelectedSession();
				},
				enabled: workspaceViewMode === "conversation",
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
				callback: () => window.dispatchEvent(new Event("helmor:run-script")),
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
				callback: () => void handleInspectorCommitAction("create-pr"),
			},
			{
				id: "action.commitAndPush" as const,
				callback: () => void handleInspectorCommitAction("commit-and-push"),
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
				callback: () =>
					window.dispatchEvent(new Event("helmor:focus-composer")),
				enabled: workspaceViewMode === "conversation",
			},
			{
				id: "composer.openModelPicker" as const,
				callback: handleOpenModelPicker,
				enabled: workspaceViewMode === "conversation",
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
			handleInspectorCommitAction,
			handleNavigateSessions,
			handleNavigateWorkspaces,
			handleOpenModelPicker,
			handleOpenPreferredEditor,
			handleOpenPullRequest,
			handleOpenSettings,
			handlePullLatest,
			handleReopenClosedSession,
			handleToggleKanban,
			handleToggleTheme,
			handleToggleZenMode,
			preferredEditor,
			pullRequestUrl,
			selectedWorkspaceId,
			setInspectorCollapsed,
			setSidebarCollapsed,
			updateSettings,
			workspaceRootPath,
			workspaceViewMode,
		],
	);
	useAppShortcuts({
		overrides: appSettings.shortcuts,
		handlers: globalShortcutHandlers,
	});

	const handleResolveDisplayedSession = useCallback(
		(sessionId: string | null) => {
			rememberSessionSelection(selectedWorkspaceIdRef.current, sessionId);
			selectedSessionIdRef.current = sessionId;
			setSelectedSessionId((current) =>
				current === sessionId ? current : sessionId,
			);
			setDisplayedSessionId((current) =>
				current === sessionId ? current : sessionId,
			);
		},
		[rememberSessionSelection],
	);

	const processPendingCliSends = useCallback(async () => {
		try {
			const sends = await drainPendingCliSends();
			if (sends.length === 0) return;

			const first = sends[0];

			await queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
			if (first.workspaceId) {
				await queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceSessions(first.workspaceId),
				});
			}

			handleSelectWorkspace(first.workspaceId);

			setTimeout(() => {
				queuePendingPromptForSession({
					sessionId: first.sessionId,
					prompt: first.prompt,
					modelId: first.modelId,
					permissionMode: first.permissionMode,
				});
				handleSelectSession(first.sessionId);
			}, 100);
		} catch (error) {
			console.error("[pendingCliSend] drain failed:", error);
		}
	}, [
		handleSelectSession,
		handleSelectWorkspace,
		queryClient,
		queuePendingPromptForSession,
	]);

	useUiSyncBridge({
		queryClient,
		processPendingCliSends,
		reloadSettings: () => {
			window.dispatchEvent(new Event(SETTINGS_RELOAD_EVENT));
		},
	});

	// ── Pending CLI sends: on window focus, drain queued prompts ────────
	// When `helmor send` detects the App is running it writes the prompt
	// into `pending_cli_sends` instead of starting its own sidecar. On
	// the next focus event we pick those up and replay them through the
	// normal streaming path (setPendingPromptForSession → auto-submit).
	useEffect(() => {
		let unlisten: (() => void) | undefined;

		void import("@tauri-apps/api/event").then(({ listen }) => {
			void listen("tauri://focus", async () => {
				// Smart fetch: refresh target branch for the active workspace
				// so file tree diffs stay current after the user returns.
				const wsId = selectedWorkspaceIdRef.current;
				if (wsId) {
					triggerWorkspaceFetch(wsId);
				}

				await processPendingCliSends();
			}).then((fn) => {
				unlisten = fn;
			});
		});

		return () => {
			unlisten?.();
		};
	}, [processPendingCliSends]);

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

	const handleInsertIntoComposer = useCallback(
		(request: ComposerInsertRequest) => {
			const resolvedTarget = resolveComposerInsertTarget(request.target, {
				selectedWorkspaceId,
				displayedWorkspaceId,
				displayedSessionId,
			});
			const targetContextKey = resolvedTarget.contextKey ?? null;
			const targetWorkspaceId = resolvedTarget.workspaceId;
			if (!targetContextKey && !targetWorkspaceId) {
				pushWorkspaceToast(
					"Open a workspace before inserting content into the composer.",
					"Can't insert content",
				);
				return;
			}

			const items = request.items.filter((item) => {
				if (item.kind === "text") return item.text.length > 0;
				if (item.kind === "custom-tag") {
					return (
						item.label.trim().length > 0 && item.submitText.trim().length > 0
					);
				}
				return item.path.length > 0;
			});
			if (items.length === 0) return;

			setPendingComposerInserts((current) => [
				...current,
				{
					id: crypto.randomUUID(),
					contextKey: targetContextKey,
					workspaceId: targetWorkspaceId ?? null,
					sessionId: resolvedTarget.sessionId ?? null,
					items,
					behavior: request.behavior ?? "append",
					createdAt: Date.now(),
				},
			]);
		},
		[
			displayedSessionId,
			displayedWorkspaceId,
			pushWorkspaceToast,
			selectedWorkspaceId,
		],
	);

	const handlePendingComposerInsertsConsumed = useCallback((ids: string[]) => {
		if (ids.length === 0) return;
		const consumed = new Set(ids);
		setPendingComposerInserts((current) =>
			current.filter((r) => !consumed.has(r.id)),
		);
	}, []);

	// Hydrate the kanban view's persisted UI state from settings.
	//
	// Two-phase, because the repo selection can only be resolved once the
	// repositories list arrives:
	//
	//   Phase 1 — non-repo fields. Fires as soon as settings finish
	//             loading. Ref-guarded so a later settings update doesn't
	//             replay the same setters and revert in-flight edits.
	//
	//   Phase 2 — repoId. Waits for `repositoriesQuery.data` so the saved
	//             string id can be mapped back to a full RepositoryCreateOption.
	//
	// `kanbanFullyHydrated` flips to true only when phase 2 has had its
	// chance to run (or after we've decided no repo hydration is needed).
	// The sync-back effect gates on that flag, which is the whole point —
	// without the gate, sync-back fires immediately after phase 1 with
	// `kanbanRepository?.id === null` and clobbers the persisted repoId
	// before phase 2 can apply it.
	const repositoriesQuery = useQuery(repositoriesQueryOptions());
	const phase1HydratedRef = useRef(false);
	const [kanbanFullyHydrated, setKanbanFullyHydrated] = useState(false);
	useEffect(() => {
		if (kanbanFullyHydrated) return;
		if (!areSettingsLoaded) return;
		const saved = appSettings.kanbanViewState;

		if (!phase1HydratedRef.current) {
			phase1HydratedRef.current = true;
			setKanbanCreateState(saved.createState);
			setKanbanInboxProviderTab(saved.inboxProviderTab);
			setKanbanInboxProviderSourceTab(saved.inboxProviderSourceTab);
			setKanbanSourceBranchByRepoId(saved.sourceBranchByRepoId);
			setKanbanInboxStateFilterBySource(saved.inboxStateFilterBySource);
			setKanbanOpenInboxCards(saved.openInboxCards);
		}

		if (!saved.repoId) {
			// No saved selection — nothing more to wait for.
			setKanbanFullyHydrated(true);
			return;
		}
		const repos = repositoriesQuery.data;
		if (!repos || repos.length === 0) {
			// Wait for the next render where repos are populated. Stay
			// un-hydrated so sync-back can't fire and clobber the saved
			// repoId before we get a chance to apply it.
			return;
		}
		const found = repos.find((r) => r.id === saved.repoId);
		if (found) setKanbanRepository(found);
		setKanbanFullyHydrated(true);
	}, [
		areSettingsLoaded,
		appSettings.kanbanViewState,
		kanbanFullyHydrated,
		repositoriesQuery.data,
	]);

	// Push every kanban view-state change back to SQLite. Gated on
	// `kanbanFullyHydrated` so the renders before phase 2 finishes don't
	// overwrite the saved blob with the synchronous initial defaults.
	//
	// IMPORTANT — uses `saveSettings` directly (write-only) instead of
	// `updateSettings` (write + setAppSettings). Going through React state
	// would force `settingsContextValue` to rebuild on every kanban
	// interaction, which in turn re-renders every `useSettings()`
	// consumer (panel / composer / conversation / inspector / inbox / …).
	// `appSettings.kanbanViewState` is only read once during the
	// hydration effect above — after hydration completes we never need
	// React to know about kanban view-state changes again, so we bypass
	// the context entirely and let SQLite be the source of truth across
	// restarts.
	// Debounced — collapses bursts of changes (rapid sub-tab clicks,
	// drag-then-resize, opening several inbox cards in a row) into a
	// single SQLite write. The cleanup cancels the pending write when a
	// new change lands, so only the final blob within a 250ms window
	// hits IPC.
	useEffect(() => {
		if (!kanbanFullyHydrated) return;
		const timer = window.setTimeout(() => {
			void saveSettings({
				kanbanViewState: {
					createState: kanbanCreateState,
					repoId: kanbanRepository?.id ?? null,
					inboxProviderTab: kanbanInboxProviderTab,
					inboxProviderSourceTab: kanbanInboxProviderSourceTab,
					sourceBranchByRepoId: kanbanSourceBranchByRepoId,
					inboxStateFilterBySource: kanbanInboxStateFilterBySource,
					openInboxCards: kanbanOpenInboxCards,
				},
			});
		}, 250);
		return () => window.clearTimeout(timer);
	}, [
		kanbanCreateState,
		kanbanRepository?.id,
		kanbanInboxProviderTab,
		kanbanInboxProviderSourceTab,
		kanbanSourceBranchByRepoId,
		kanbanInboxStateFilterBySource,
		kanbanOpenInboxCards,
		kanbanFullyHydrated,
	]);

	// Open an inbox card as a kanban main-content tab. Caps the open-tab
	// list at KANBAN_OPEN_INBOX_CARDS_MAX — beyond that we toast and skip
	// the addition rather than silently dropping the oldest tab, which
	// would surprise the user (and risks losing context they were still
	// reading). Reopening an already-open card is a no-op (no toast).
	const handleKanbanOpenCard = useCallback(
		(card: ContextCard) => {
			setKanbanOpenInboxCards((current) => {
				if (current.some((openedCard) => openedCard.id === card.id)) {
					return current;
				}
				if (current.length >= KANBAN_OPEN_INBOX_CARDS_MAX) {
					pushWorkspaceToast(
						`Close one of the open ${KANBAN_OPEN_INBOX_CARDS_MAX} tabs before opening another card.`,
						"Too many open cards",
					);
					return current;
				}
				return [...current, card];
			});
		},
		[pushWorkspaceToast],
	);

	const handleKanbanCloseCard = useCallback((cardId: string) => {
		setKanbanOpenInboxCards((current) =>
			current.filter((card) => card.id !== cardId),
		);
	}, []);

	const kanbanSelectedSourceBranch = kanbanRepository?.id
		? (kanbanSourceBranchByRepoId[kanbanRepository.id] ?? null)
		: null;

	const handleKanbanSourceBranchChange = useCallback(
		(branch: string | null) => {
			setKanbanSourceBranch(branch);
			const repoId = kanbanRepository?.id;
			if (!repoId || !branch) return;
			setKanbanSourceBranchByRepoId((current) =>
				current[repoId] === branch ? current : { ...current, [repoId]: branch },
			);
		},
		[kanbanRepository?.id],
	);

	// Kanban-mode composer submit: turn the user's prompt into a brand-new
	// workspace. Phase 1 (`prepare`) returns the new workspace + initial
	// session ids synchronously; Phase 2 (`finalize`) materialises the git
	// worktree in the background. The "in progress" toggle dispatches the
	// agent stream against the new session immediately by handing back the
	// override to the conversation container; "backlog" persists the
	// composer's full Lexical state to `sessions.draft_state` so the user
	// finds their chips and prompt waiting when they later open the
	// session, and skips the agent dispatch.
	const handleKanbanComposerPrepare = useCallback(
		async (
			payload: ComposerSubmitPayload,
		): Promise<KanbanCreatePrepareOutcome> => {
			if (!kanbanRepository?.id) {
				pushWorkspaceToast(
					"Pick a repository before sending.",
					"Can't create workspace",
				);
				return { shouldStream: false };
			}

			let prepared: Awaited<ReturnType<typeof prepareWorkspaceFromRepo>>;
			try {
				prepared = await prepareWorkspaceFromRepo(
					kanbanRepository.id,
					kanbanSourceBranch,
				);
			} catch (error) {
				pushWorkspaceToast(
					describeUnknownError(error, "Could not create workspace."),
					"Can't create workspace",
				);
				return { shouldStream: false };
			}

			// Phase 2 — slow worktree creation runs in the background. The
			// agent stream below blocks on the Rust side until finalize
			// completes, so it's safe to fire-and-forget. We surface a toast
			// only if Rust reports an outright failure (in which case it
			// has already cleaned up the row + worktree).
			void finalizeWorkspaceFromRepo(prepared.workspaceId).catch((error) => {
				pushWorkspaceToast(
					describeUnknownError(error, "Workspace setup failed."),
					"Workspace setup failed",
				);
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGroups,
				});
			});

			if (kanbanCreateState === "backlog") {
				if (payload.editorStateSnapshot) {
					try {
						await persistSessionDraft(
							prepared.initialSessionId,
							payload.editorStateSnapshot,
						);
					} catch (error) {
						pushWorkspaceToast(
							describeUnknownError(error, "Couldn't save draft."),
						);
					}
				}
				try {
					await setWorkspaceStatus(prepared.workspaceId, "backlog");
				} catch (error) {
					pushWorkspaceToast(
						describeUnknownError(error, "Couldn't move card to Backlog."),
					);
				}
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGroups,
				});
				return { shouldStream: false };
			}

			// Refresh the kanban board so the new card lands in its column
			// immediately. Without this, the user has to wait for the next
			// background poll to see the workspace they just created.
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			});

			return {
				shouldStream: true,
				workspaceId: prepared.workspaceId,
				sessionId: prepared.initialSessionId,
				contextKey: getComposerContextKey(
					prepared.workspaceId,
					prepared.initialSessionId,
				),
			};
		},
		[
			kanbanCreateState,
			kanbanRepository?.id,
			kanbanSourceBranch,
			pushWorkspaceToast,
			queryClient,
		],
	);

	const kanbanCreateContext = useMemo<KanbanCreateContext | null>(
		() =>
			workspaceViewMode === "kanban"
				? { prepare: handleKanbanComposerPrepare }
				: null,
		[workspaceViewMode, handleKanbanComposerPrepare],
	);

	// English placeholder that hints at the kanban view's "compose multiple
	// inbox sources to create In-Progress or Backlog workspaces quickly"
	// flow — distinct from the regular chat composer copy.
	const kanbanComposerPlaceholder =
		"Enter to launch a workspace or save as Backlog";

	// Per-repo composer context key for the kanban bottom composer. Each
	// repo gets its own draft slot so switching repos doesn't bleed a
	// half-typed prompt across kanban contexts. Falls back to a single
	// "no-repo" slot before the user picks a repository.
	const kanbanComposerContextKey = kanbanRepository?.id
		? `kanban:repo:${kanbanRepository.id}`
		: "kanban:no-repo";
	// Stable identity for the composer-insert target passed to KanbanPage.
	// Without `useMemo`, a fresh `{ contextKey }` object is created on every
	// MainApp render, which defeats the `React.memo` wrapper around
	// `InboxSidebar` and forces 20+ `SourceCard` children to re-render on
	// every kanban interaction.
	const kanbanComposerInsertTarget = useMemo(
		() => ({ contextKey: kanbanComposerContextKey }),
		[kanbanComposerContextKey],
	);

	return (
		<TooltipProvider delayDuration={0}>
			<WorkspaceToastProvider value={pushWorkspaceToast}>
				<SendingSessionsProvider value={sendingSessionIds}>
					<ComposerInsertProvider value={handleInsertIntoComposer}>
						<main
							aria-label="Application shell"
							className="relative h-screen overflow-hidden bg-background font-sans text-foreground antialiased"
						>
							<div className="relative flex h-full min-h-0 bg-background">
								{workspaceViewMode !== "editor" &&
									workspaceViewMode !== "kanban" && (
										<>
											{!sidebarCollapsed && (
												<aside
													aria-label="Workspace sidebar"
													data-helmor-sidebar-root
													className="relative flex h-full shrink-0 flex-col overflow-hidden bg-sidebar"
													style={{ width: `${sidebarWidth}px` }}
												>
													<div className="min-h-0 flex-1">
														<WorkspacesSidebarContainer
															selectedWorkspaceId={selectedWorkspaceId}
															sendingWorkspaceIds={sendingWorkspaceIds}
															interactionRequiredWorkspaceIds={
																interactionRequiredWorkspaceIds
															}
															newWorkspaceShortcut={newWorkspaceShortcut}
															addRepositoryShortcut={addRepositoryShortcut}
															onSelectWorkspace={handleSelectWorkspace}
															pushWorkspaceToast={pushWorkspaceToast}
														/>
													</div>
													<div className="absolute right-[12px] top-[6px] z-20 flex items-center gap-[2px]">
														<AppUpdateButton status={appUpdateStatus} />
														<Tooltip>
															<TooltipTrigger asChild>
																<Button
																	aria-label="Collapse left sidebar"
																	onClick={() => setSidebarCollapsed(true)}
																	variant="ghost"
																	size="icon-xs"
																	className="text-muted-foreground hover:text-foreground"
																>
																	<PanelLeftClose
																		className="size-4"
																		strokeWidth={1.8}
																	/>
																</Button>
															</TooltipTrigger>
															<TooltipContent
																side="bottom"
																className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
															>
																<span>Collapse left sidebar</span>
																{leftSidebarToggleShortcut ? (
																	<InlineShortcutDisplay
																		hotkey={leftSidebarToggleShortcut}
																		className="text-background/60"
																	/>
																) : null}
															</TooltipContent>
														</Tooltip>
													</div>
													<div className="flex shrink-0 items-center justify-between px-3 pb-3 pt-1">
														<SettingsButton
															onClick={handleOpenSettings}
															shortcut={getShortcut(
																appSettings.shortcuts,
																"settings.open",
															)}
														/>
														<KanbanNavButton
															active={false}
															onClick={handleToggleKanban}
															shortcut={getShortcut(
																appSettings.shortcuts,
																"workspace.toggleKanban",
															)}
														/>
													</div>
												</aside>
											)}

											{!sidebarCollapsed && (
												<div
													role="separator"
													tabIndex={0}
													aria-label="Resize sidebar"
													aria-orientation="vertical"
													aria-valuemin={MIN_SIDEBAR_WIDTH}
													aria-valuemax={MAX_SIDEBAR_WIDTH}
													aria-valuenow={sidebarWidth}
													onMouseDown={handleResizeStart("sidebar")}
													onKeyDown={handleResizeKeyDown("sidebar")}
													className="group absolute inset-y-0 z-30 cursor-ew-resize touch-none outline-none"
													style={{
														left: `${sidebarWidth - SIDEBAR_RESIZE_HIT_AREA / 2}px`,
														width: `${SIDEBAR_RESIZE_HIT_AREA}px`,
													}}
												>
													<span
														aria-hidden="true"
														className={`pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 transition-[width,background-color,box-shadow] ${
															isSidebarResizing
																? "w-[2px] bg-foreground/80 shadow-[0_0_12px_rgba(0,0,0,0.12)] dark:shadow-[0_0_12px_rgba(255,255,255,0.16)]"
																: "w-px bg-border group-hover:w-[2px] group-hover:bg-muted-foreground/75 group-focus-visible:w-[2px] group-focus-visible:bg-muted-foreground/75"
														}`}
													/>
												</div>
											)}
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
										{workspaceViewMode === "kanban" && (
											<KanbanPage
												boardMaxWidth={getKanbanBoardMaxWidth()}
												boardWidth={kanbanBoardWidth}
												inboxWidth={kanbanInboxWidth}
												inboxMaxWidth={MAX_SIDEBAR_WIDTH}
												isBoardExpanded={kanbanBoardExpanded}
												isBoardResizing={kanbanResizeState?.target === "board"}
												isInboxResizing={kanbanResizeState?.target === "inbox"}
												minWidth={MIN_SIDEBAR_WIDTH}
												onBoardExpandToggle={handleKanbanBoardExpandToggle}
												onBoardResizeKeyDown={handleKanbanResizeKeyDown(
													"board",
												)}
												onBoardResizeStart={handleKanbanResizeStart("board")}
												onInboxResizeKeyDown={handleKanbanResizeKeyDown(
													"inbox",
												)}
												onInboxResizeStart={handleKanbanResizeStart("inbox")}
												repository={kanbanRepository}
												onRepositoryChange={setKanbanRepository}
												sourceBranch={kanbanSelectedSourceBranch}
												onSourceBranchChange={handleKanbanSourceBranchChange}
												createState={kanbanCreateState}
												onCreateStateChange={setKanbanCreateState}
												inboxProviderTab={kanbanInboxProviderTab}
												onInboxProviderTabChange={setKanbanInboxProviderTab}
												inboxProviderSourceTab={kanbanInboxProviderSourceTab}
												onInboxProviderSourceTabChange={
													setKanbanInboxProviderSourceTab
												}
												inboxStateFilterBySource={
													kanbanInboxStateFilterBySource
												}
												onInboxStateFilterBySourceChange={
													setKanbanInboxStateFilterBySource
												}
												openInboxCards={kanbanOpenInboxCards}
												onOpenInboxCard={handleKanbanOpenCard}
												onCloseInboxCard={handleKanbanCloseCard}
												composerInsertTarget={kanbanComposerInsertTarget}
												resizeHitArea={SIDEBAR_RESIZE_HIT_AREA}
											/>
										)}
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
													: workspaceViewMode === "kanban"
														? "pointer-events-none absolute inset-y-0 z-30 flex min-h-0 flex-col"
														: "flex min-h-0 flex-1 flex-col"
											}
											style={
												workspaceViewMode === "kanban"
													? {
															left: `${kanbanInboxWidth}px`,
															right: `${kanbanBoardWidth}px`,
														}
													: undefined
											}
										>
											<WorkspaceConversationContainer
												// In kanban mode the bottom composer creates a brand-
												// new workspace on submit, so it must NOT be tied to
												// whichever workspace happens to be selected in the
												// regular chat view. Pass null for all four selection
												// props so the composer's context key falls back to
												// the kanban-specific "global" slot — its own draft,
												// no spillover into a previously-open session.
												selectedWorkspaceId={
													workspaceViewMode === "kanban"
														? null
														: selectedWorkspaceId
												}
												displayedWorkspaceId={
													workspaceViewMode === "kanban"
														? null
														: displayedWorkspaceId
												}
												selectedSessionId={
													workspaceViewMode === "kanban"
														? null
														: selectedSessionId
												}
												displayedSessionId={
													workspaceViewMode === "kanban"
														? null
														: displayedSessionId
												}
												repoId={
													workspaceViewMode === "kanban"
														? (kanbanRepository?.id ?? null)
														: (selectedWorkspaceDetailQuery.data?.repoId ??
															null)
												}
												sessionSelectionHistory={
													selectedWorkspaceId
														? (sessionSelectionHistoryByWorkspaceRef.current[
																selectedWorkspaceId
															] ?? [])
														: []
												}
												onSelectSession={handleSelectSession}
												onResolveDisplayedSession={
													handleResolveDisplayedSession
												}
												onSendingWorkspacesChange={setSendingWorkspaceIds}
												onSendingSessionsChange={setSendingSessionIds}
												onInteractionSessionsChange={
													handleInteractionSessionsChange
												}
												interactionRequiredSessionIds={
													interactionRequiredSessionIds
												}
												onSessionCompleted={handleSessionCompleted}
												workspaceChangeRequest={workspaceChangeRequest}
												onSessionAborted={handleSessionAborted}
												pendingPromptForSession={pendingPromptForSession}
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
												composerOnly={workspaceViewMode === "kanban"}
												composerWrapperClassName={
													workspaceViewMode === "kanban"
														? "pointer-events-auto mt-auto px-4 pb-4 pt-0"
														: undefined
												}
												composerForceAvailable={workspaceViewMode === "kanban"}
												composerContextKeyOverride={
													workspaceViewMode === "kanban"
														? kanbanComposerContextKey
														: undefined
												}
												composerPlaceholder={
													workspaceViewMode === "kanban"
														? kanbanComposerPlaceholder
														: undefined
												}
												kanbanCreateContext={kanbanCreateContext}
												headerLeading={
													sidebarCollapsed ? (
														<>
															{/* Spacer to avoid macOS traffic lights */}
															<div className="w-[52px] shrink-0" />
															<div className="flex items-center gap-[2px]">
																<AppUpdateButton status={appUpdateStatus} />
																<Tooltip>
																	<TooltipTrigger asChild>
																		<Button
																			aria-label="Expand left sidebar"
																			onClick={() => setSidebarCollapsed(false)}
																			variant="ghost"
																			size="icon-xs"
																			className="text-muted-foreground hover:text-foreground"
																		>
																			<PanelLeftOpen
																				className="size-4"
																				strokeWidth={1.8}
																			/>
																		</Button>
																	</TooltipTrigger>
																	<TooltipContent
																		side="bottom"
																		className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
																	>
																		<span>Expand left sidebar</span>
																		{leftSidebarToggleShortcut ? (
																			<InlineShortcutDisplay
																				hotkey={leftSidebarToggleShortcut}
																				className="text-background/60"
																			/>
																		) : null}
																	</TooltipContent>
																</Tooltip>
															</div>
														</>
													) : undefined
												}
												headerActions={
													selectedWorkspaceId ? (
														<div className="flex items-center gap-1">
															{installedEditors.length > 0 &&
															preferredEditor ? (
																<div className="flex items-center">
																	<Tooltip>
																		<TooltipTrigger asChild>
																			<Button
																				variant="ghost"
																				size="xs"
																				aria-label={`Open in ${preferredEditor.name}`}
																				onClick={handleOpenPreferredEditor}
																				className="text-muted-foreground hover:text-foreground"
																			>
																				<EditorIcon
																					editorId={preferredEditor.id}
																					className="size-3.5"
																				/>
																				<span>{preferredEditor.name}</span>
																			</Button>
																		</TooltipTrigger>
																		<TooltipContent
																			side="bottom"
																			sideOffset={4}
																			className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
																		>
																			<span>{`Open in ${preferredEditor.name}`}</span>
																			{openPreferredEditorShortcut ? (
																				<InlineShortcutDisplay
																					hotkey={openPreferredEditorShortcut}
																					className="text-background/60"
																				/>
																			) : null}
																		</TooltipContent>
																	</Tooltip>
																	<DropdownMenu>
																		<DropdownMenuTrigger asChild>
																			<Button
																				variant="ghost"
																				size="icon-xs"
																				className="w-4 text-muted-foreground hover:text-foreground"
																			>
																				<ChevronDown
																					className="size-2.5"
																					strokeWidth={2}
																				/>
																			</Button>
																		</DropdownMenuTrigger>
																		<DropdownMenuContent
																			side="bottom"
																			align="end"
																			sideOffset={4}
																			className="min-w-[11rem]"
																		>
																			<DropdownMenuItem
																				onClick={() => {
																					void openWorkspaceInFinder(
																						selectedWorkspaceId,
																					).catch((e) =>
																						pushWorkspaceToast(
																							String(e),
																							"Failed to open Finder",
																						),
																					);
																				}}
																				className="flex items-center gap-2"
																			>
																				<FolderOpen
																					className="shrink-0"
																					strokeWidth={1.8}
																				/>
																				<span className="flex-1">Finder</span>
																			</DropdownMenuItem>
																			{installedEditors.map((editor) => (
																				<DropdownMenuItem
																					key={editor.id}
																					onClick={() => {
																						setPreferredEditorId(editor.id);
																						localStorage.setItem(
																							PREFERRED_EDITOR_STORAGE_KEY,
																							editor.id,
																						);
																						void openWorkspaceInEditor(
																							selectedWorkspaceId,
																							editor.id,
																						).catch((e) =>
																							pushWorkspaceToast(
																								String(e),
																								`Failed to open ${editor.name}`,
																							),
																						);
																					}}
																					className="flex items-center gap-2"
																				>
																					<EditorIcon
																						editorId={editor.id}
																						className="shrink-0"
																					/>
																					<span className="flex-1">
																						{editor.name}
																					</span>
																					{editor.id === preferredEditor.id && (
																						<Check className="ml-auto text-muted-foreground" />
																					)}
																				</DropdownMenuItem>
																			))}
																		</DropdownMenuContent>
																	</DropdownMenu>
																</div>
															) : null}
															<Tooltip>
																<TooltipTrigger asChild>
																	<Button
																		aria-label={
																			inspectorCollapsed
																				? "Expand right sidebar"
																				: "Collapse right sidebar"
																		}
																		onClick={() =>
																			setInspectorCollapsed(
																				(collapsed) => !collapsed,
																			)
																		}
																		variant="ghost"
																		size="icon-xs"
																		className="text-muted-foreground hover:text-foreground"
																	>
																		{inspectorCollapsed ? (
																			<PanelRightOpen
																				className="size-4"
																				strokeWidth={1.8}
																			/>
																		) : (
																			<PanelRightClose
																				className="size-4"
																				strokeWidth={1.8}
																			/>
																		)}
																	</Button>
																</TooltipTrigger>
																<TooltipContent
																	side="bottom"
																	className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
																>
																	<span>
																		{inspectorCollapsed
																			? "Expand right sidebar"
																			: "Collapse right sidebar"}
																	</span>
																	{rightSidebarToggleShortcut ? (
																		<InlineShortcutDisplay
																			hotkey={rightSidebarToggleShortcut}
																			className="text-background/60"
																		/>
																	) : null}
																</TooltipContent>
															</Tooltip>
														</div>
													) : undefined
												}
											/>
										</div>
									</div>
								</section>

								{workspaceViewMode !== "kanban" && !inspectorCollapsed && (
									<>
										<div
											role="separator"
											tabIndex={0}
											aria-label="Resize inspector sidebar"
											aria-orientation="vertical"
											aria-valuemin={MIN_SIDEBAR_WIDTH}
											aria-valuemax={MAX_SIDEBAR_WIDTH}
											aria-valuenow={inspectorWidth}
											onMouseDown={handleResizeStart("inspector")}
											onKeyDown={handleResizeKeyDown("inspector")}
											className="group absolute inset-y-0 z-30 cursor-ew-resize touch-none outline-none"
											style={{
												right: `${Math.max(0, inspectorWidth - SIDEBAR_RESIZE_HIT_AREA)}px`,
												width: `${SIDEBAR_RESIZE_HIT_AREA}px`,
											}}
										>
											<span
												aria-hidden="true"
												className={`pointer-events-none absolute inset-y-0 left-0 transition-[width,background-color,box-shadow] ${
													isInspectorResizing
														? "w-[2px] bg-transparent shadow-none"
														: "w-px bg-border group-hover:w-[2px] group-hover:bg-muted-foreground/75 group-focus-visible:w-[2px] group-focus-visible:bg-muted-foreground/75"
												}`}
											/>
										</div>

										<aside
											aria-label="Inspector sidebar"
											className="relative h-full shrink-0 overflow-hidden bg-sidebar has-[[data-tabs-zoomed=true]]:overflow-visible"
											style={{ width: `${inspectorWidth}px` }}
										>
											<WorkspaceInspectorSidebar
												workspaceId={selectedWorkspaceId}
												workspaceRootPath={workspaceRootPath}
												workspaceState={
													selectedWorkspaceDetailQuery.data?.state ?? null
												}
												repoId={
													selectedWorkspaceDetailQuery.data?.repoId ?? null
												}
												workspaceBranch={
													selectedWorkspaceDetailQuery.data?.branch ?? null
												}
												workspaceRemote={
													selectedWorkspaceDetailQuery.data?.remote ?? null
												}
												workspaceRemoteUrl={
													selectedWorkspaceDetailQuery.data?.remoteUrl ?? null
												}
												workspaceTargetBranch={(() => {
													const d = selectedWorkspaceDetailQuery.data;
													const target =
														d?.intendedTargetBranch ?? d?.defaultBranch;
													if (!target) return null;
													const remote = d?.remote ?? "origin";
													return `${remote}/${target}`;
												})()}
												editorMode={workspaceViewMode === "editor"}
												activeEditorPath={editorSession?.path ?? null}
												onOpenEditorFile={handleOpenEditorFile}
												onCommitAction={handleInspectorCommitAction}
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
												currentSessionId={displayedSessionId}
												onQueuePendingPromptForSession={
													queuePendingPromptForSession
												}
												commitButtonMode={commitButtonMode}
												commitButtonState={commitButtonState}
												changeRequest={workspaceChangeRequest}
												forgeIsRefreshing={workspaceForgeIsRefreshing}
												onOpenSettings={handleOpenSettings}
											/>
										</aside>
									</>
								)}
							</div>
						</main>
						<Toaster
							theme={resolveTheme(appSettings.theme)}
							position="bottom-right"
							visibleToasts={6}
						/>
						{closeConfirmDialog}
					</ComposerInsertProvider>
				</SendingSessionsProvider>
			</WorkspaceToastProvider>
			<QuitConfirmDialog sendingSessionIds={sendingSessionIds} />
		</TooltipProvider>
	);
}
export default App;
