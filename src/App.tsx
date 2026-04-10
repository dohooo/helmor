import "./App.css";
import { MarkGithubIcon } from "@primer/octicons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	Check,
	ChevronDown,
	Copy,
	ExternalLink,
	PanelLeftClose,
	PanelLeftOpen,
	RefreshCw,
} from "lucide-react";
import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { SettingsButton, SettingsDialog } from "./components/settings-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar";
import { Button } from "./components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "./components/workspace-commit-button";
import { WorkspaceConversationContainer } from "./components/workspace-conversation-container";
import { WorkspaceEditorSurface } from "./components/workspace-editor-surface";
import { WorkspaceInspectorSidebar } from "./components/workspace-inspector-sidebar";
import { WorkspacesSidebarContainer } from "./components/workspaces-sidebar-container";
import {
	archiveWorkspace,
	cancelGithubIdentityConnect,
	closeWorkspacePr,
	createSession,
	type DetectedEditor,
	detectInstalledEditors,
	disconnectGithubIdentity,
	type GithubIdentityDeviceFlowStart,
	type GithubIdentitySnapshot,
	hideSession,
	listenGithubIdentityChanged,
	loadAutoCloseActionKinds,
	loadGithubIdentitySession,
	lookupWorkspacePr,
	mergeWorkspacePr,
	openWorkspaceInEditor,
	type PullRequestInfo,
	setWorkspaceManualStatus,
	startGithubOAuthRedirect,
	type WorkspaceDetail,
	type WorkspaceGroup,
	type WorkspaceRow,
	type WorkspaceSessionSummary,
} from "./lib/api";
import { COMMIT_BUTTON_PROMPTS } from "./lib/commit-button-prompts";
import {
	type ComposerInsertRequest,
	type ResolvedComposerInsertRequest,
	resolveComposerInsertTarget,
} from "./lib/composer-insert";
import { ComposerInsertProvider } from "./lib/composer-insert-context";
import type { EditorSessionState } from "./lib/editor-session";
import { isPathWithinRoot } from "./lib/editor-session";
import {
	archivedWorkspacesQueryOptions,
	createHelmorQueryClient,
	helmorQueryKeys,
	helmorQueryPersister,
	sessionThreadMessagesQueryOptions,
	workspaceDetailQueryOptions,
	workspaceGroupsQueryOptions,
	workspacePrQueryOptions,
	workspaceSessionsQueryOptions,
} from "./lib/query-client";
import {
	type AppSettings,
	DEFAULT_SETTINGS,
	loadSettings,
	resolveTheme,
	SettingsContext,
	saveSettings,
	useSettings,
} from "./lib/settings";
import {
	describeUnknownError,
	summaryToArchivedRow,
} from "./lib/workspace-helpers";
import {
	type WorkspaceToastOptions,
	WorkspaceToastProvider,
} from "./lib/workspace-toast-context";

const SIDEBAR_WIDTH_STORAGE_KEY = "helmor.workspaceSidebarWidth";
const INSPECTOR_WIDTH_STORAGE_KEY = "helmor.workspaceInspectorWidth";
const PREFERRED_EDITOR_STORAGE_KEY = "helmor.preferredEditorId";
const DEFAULT_SIDEBAR_WIDTH = 336;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const SIDEBAR_RESIZE_STEP = 16;
const SIDEBAR_RESIZE_HIT_AREA = 20;
const WORKSPACE_NAVIGATION_ORDER = [
	"done",
	"review",
	"progress",
	"backlog",
	"canceled",
] as const;

type GithubIdentityState =
	| { status: "checking" }
	| { status: "pending"; flow: GithubIdentityDeviceFlowStart }
	| { status: "awaiting-redirect" }
	| GithubIdentitySnapshot;

function clampSidebarWidth(width: number) {
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function getInitialSidebarWidth(storageKey = SIDEBAR_WIDTH_STORAGE_KEY) {
	if (typeof window === "undefined") {
		return DEFAULT_SIDEBAR_WIDTH;
	}

	try {
		const storedWidth = window.localStorage.getItem(storageKey);

		if (!storedWidth) {
			return DEFAULT_SIDEBAR_WIDTH;
		}

		const parsedWidth = Number.parseInt(storedWidth, 10);

		return Number.isFinite(parsedWidth)
			? clampSidebarWidth(parsedWidth)
			: DEFAULT_SIDEBAR_WIDTH;
	} catch {
		return DEFAULT_SIDEBAR_WIDTH;
	}
}

function getInitialGithubIdentityState(): GithubIdentityState {
	return { status: "checking" };
}

function findAdjacentSessionId(
	workspaceSessions: WorkspaceSessionSummary[],
	selectedSessionId: string | null,
	offset: -1 | 1,
) {
	if (!selectedSessionId || workspaceSessions.length < 2) {
		return null;
	}

	const currentIndex = workspaceSessions.findIndex(
		(session) => session.id === selectedSessionId,
	);

	if (currentIndex === -1) {
		return null;
	}

	const nextIndex = currentIndex + offset;

	if (nextIndex < 0 || nextIndex >= workspaceSessions.length) {
		return null;
	}

	return workspaceSessions[nextIndex]?.id ?? null;
}

function flattenWorkspaceRows(
	groups: WorkspaceGroup[],
	archivedRows: WorkspaceRow[],
) {
	const orderedRows = WORKSPACE_NAVIGATION_ORDER.flatMap((tone) =>
		groups
			.filter((group) => group.tone === tone)
			.flatMap((group) => group.rows),
	);

	return [...orderedRows, ...archivedRows];
}

function findAdjacentWorkspaceId(
	groups: WorkspaceGroup[],
	archivedRows: WorkspaceRow[],
	selectedWorkspaceId: string | null,
	offset: -1 | 1,
) {
	if (!selectedWorkspaceId) {
		return null;
	}

	const rows = flattenWorkspaceRows(groups, archivedRows);

	if (rows.length < 2) {
		return null;
	}

	const currentIndex = rows.findIndex((row) => row.id === selectedWorkspaceId);

	if (currentIndex === -1) {
		return null;
	}

	const nextIndex = currentIndex + offset;

	if (nextIndex < 0 || nextIndex >= rows.length) {
		return null;
	}

	return rows[nextIndex]?.id ?? null;
}

function App() {
	const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [queryClient] = useState(() => createHelmorQueryClient());
	const settingsContextValue = useMemo(
		() => ({
			settings: appSettings,
			updateSettings: (patch: Partial<AppSettings>) => {
				setAppSettings((previous) => {
					const next = { ...previous, ...patch };
					void saveSettings(patch);
					return next;
				});
			},
		}),
		[appSettings],
	);

	useEffect(() => {
		void loadSettings().then(setAppSettings);
	}, []);

	return (
		<SettingsContext.Provider value={settingsContextValue}>
			<PersistQueryClientProvider
				client={queryClient}
				persistOptions={{ persister: helmorQueryPersister }}
			>
				<AppShell onOpenSettings={() => setSettingsOpen(true)} />
				<SettingsDialog
					open={settingsOpen}
					onClose={() => setSettingsOpen(false)}
				/>
			</PersistQueryClientProvider>
		</SettingsContext.Provider>
	);
}

function AppShell({ onOpenSettings }: { onOpenSettings: () => void }) {
	const queryClient = useQueryClient();
	const workspaceSelectionRequestRef = useRef(0);
	const sessionSelectionRequestRef = useRef(0);
	const startupPrefetchedWorkspaceRef = useRef<string | null>(null);
	const warmedWorkspaceIdsRef = useRef<Set<string>>(new Set());
	const selectedWorkspaceIdRef = useRef<string | null>(null);
	const selectedSessionIdRef = useRef<string | null>(null);
	const sessionSelectionHistoryByWorkspaceRef = useRef<
		Record<string, string[]>
	>({});
	const [githubIdentityState, setGithubIdentityState] =
		useState<GithubIdentityState>(getInitialGithubIdentityState);
	const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [inspectorWidth, setInspectorWidth] = useState(() =>
		getInitialSidebarWidth(INSPECTOR_WIDTH_STORAGE_KEY),
	);
	const [resizeState, setResizeState] = useState<{
		pointerX: number;
		sidebarWidth: number;
		target: "sidebar" | "inspector";
	} | null>(null);
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
	const [workspaceViewMode, setWorkspaceViewMode] = useState<
		"conversation" | "editor"
	>("conversation");
	const [editorSession, setEditorSession] = useState<EditorSessionState | null>(
		null,
	);
	const [sendingWorkspaceIds, setSendingWorkspaceIds] = useState<Set<string>>(
		() => new Set(),
	);
	// Queue used by the inspector Git section's commit button: when set, the
	// conversation container auto-submits the prompt once its displayed
	// session matches `sessionId`.
	const [pendingPromptForSession, setPendingPromptForSession] = useState<{
		sessionId: string;
		prompt: string;
	} | null>(null);
	// Lifecycle driver for the inspector Git commit button. Owns the button's
	// visible state across all phases (click → session created → streaming →
	// stream ended → PR verification → next mode). See `handleInspector*` +
	// the session-watching effect below for transitions.
	const [commitLifecycle, setCommitLifecycle] = useState<{
		workspaceId: string;
		trackedSessionId: string | null;
		mode: WorkspaceCommitButtonMode;
		phase: "creating" | "streaming" | "verifying" | "done" | "error";
		prInfo: PullRequestInfo | null;
	} | null>(null);
	// Session IDs currently streaming — reported by WorkspaceConversationContainer
	// and consumed by the commit button driver to detect stream completion.
	const [sendingSessionIds, setSendingSessionIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [pendingComposerInserts, setPendingComposerInserts] = useState<
		ResolvedComposerInsertRequest[]
	>([]);
	// Sessions that finished streaming while the user was viewing a different
	// session. Map of sessionId → workspaceId so we can derive both per-session
	// and per-workspace red-dot indicators.
	const [completedSessions, setCompletedSessions] = useState<
		Map<string, string>
	>(() => new Map());
	const completedSessionIds = useMemo(
		() => new Set(completedSessions.keys()),
		[completedSessions],
	);
	const completedWorkspaceIds = useMemo(
		() => new Set(completedSessions.values()),
		[completedSessions],
	);

	const { settings: appSettings } = useSettings();
	const [installedEditors, setInstalledEditors] = useState<DetectedEditor[]>(
		[],
	);
	const [preferredEditorId, setPreferredEditorId] = useState<string | null>(
		() => localStorage.getItem(PREFERRED_EDITOR_STORAGE_KEY),
	);
	const preferredEditor =
		installedEditors.find((e) => e.id === preferredEditorId) ??
		installedEditors[0] ??
		null;
	const isSidebarResizing = resizeState?.target === "sidebar";
	const isInspectorResizing = resizeState?.target === "inspector";
	const isIdentityConnected = githubIdentityState.status === "connected";
	const navigationGroupsQuery = useQuery({
		...workspaceGroupsQueryOptions(),
		enabled: isIdentityConnected,
	});
	const navigationArchivedQuery = useQuery({
		...archivedWorkspacesQueryOptions(),
		enabled: isIdentityConnected,
	});
	const workspaceGroups = navigationGroupsQuery.data ?? [];
	const archivedRows = useMemo(
		() => (navigationArchivedQuery.data ?? []).map(summaryToArchivedRow),
		[navigationArchivedQuery.data],
	);
	const selectedWorkspaceDetailQuery = useQuery({
		...workspaceDetailQueryOptions(selectedWorkspaceId ?? "__none__"),
		enabled: isIdentityConnected && selectedWorkspaceId !== null,
	});
	const workspaceRootPath =
		selectedWorkspaceDetailQuery.data?.rootPath ??
		(selectedWorkspaceId
			? queryClient.getQueryData<WorkspaceDetail | null>(
					helmorQueryKeys.workspaceDetail(selectedWorkspaceId),
				)?.rootPath
			: null) ??
		null;

	// Persistent PR state for the current workspace's branch. Drives the
	// commit button's resting mode and the "Git · PR #xxx" header badge.
	const workspacePrQuery = useQuery({
		...workspacePrQueryOptions(selectedWorkspaceId ?? "__none__"),
		enabled: isIdentityConnected && selectedWorkspaceId !== null,
	});
	const workspacePrInfo = workspacePrQuery.data ?? null;

	// Auto-archive the workspace when its PR has been closed (not merged).
	// A closed PR signals the work is abandoned — archiving moves the
	// workspace to the "Archived" section and frees the worktree on disk.
	const autoArchiveTriggeredRef = useRef<string | null>(null);
	const selectedWorkspaceState =
		selectedWorkspaceDetailQuery.data?.state ?? null;
	useEffect(() => {
		if (
			!selectedWorkspaceId ||
			!workspacePrInfo ||
			workspacePrInfo.state !== "CLOSED" ||
			workspacePrInfo.isMerged ||
			// Don't archive if the workspace is already archived or not active.
			selectedWorkspaceState !== "active"
		) {
			autoArchiveTriggeredRef.current = null;
			return;
		}
		// Only trigger once per workspace to avoid repeat archive attempts.
		if (autoArchiveTriggeredRef.current === selectedWorkspaceId) return;
		autoArchiveTriggeredRef.current = selectedWorkspaceId;

		void (async () => {
			try {
				console.log(
					"[commitButton] PR closed — auto-archiving workspace",
					selectedWorkspaceId,
				);
				await archiveWorkspace(selectedWorkspaceId);
				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceGroups,
					}),
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(selectedWorkspaceId),
					}),
				]);
			} catch (error) {
				console.error("[commitButton] Auto-archive failed:", error);
			}
		})();
	}, [selectedWorkspaceId, workspacePrInfo, queryClient]);

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
				toast.error(title, toastOptions);
				return;
			}

			toast(title, toastOptions);
		},
		[],
	);

	const clearWorkspaceRuntimeState = useCallback(() => {
		selectedWorkspaceIdRef.current = null;
		selectedSessionIdRef.current = null;
		setSelectedWorkspaceId(null);
		setDisplayedWorkspaceId(null);
		setSelectedSessionId(null);
		setDisplayedSessionId(null);
		setWorkspaceViewMode("conversation");
		setEditorSession(null);
	}, []);

	useEffect(() => {
		void detectInstalledEditors().then(setInstalledEditors);
	}, []);

	useEffect(() => {
		selectedWorkspaceIdRef.current = selectedWorkspaceId;
	}, [selectedWorkspaceId]);

	useEffect(() => {
		selectedSessionIdRef.current = selectedSessionId;
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
		let disposed = false;
		let unlistenIdentity: (() => void) | undefined;

		void loadGithubIdentitySession().then((snapshot) => {
			if (!disposed) {
				setGithubIdentityState(snapshot);
			}
		});

		void listenGithubIdentityChanged((snapshot) => {
			if (!disposed) {
				setGithubIdentityState(snapshot);
			}
		}).then((unlisten) => {
			if (disposed) {
				unlisten();
				return;
			}

			unlistenIdentity = unlisten;
		});

		return () => {
			disposed = true;
			unlistenIdentity?.();
		};
	}, []);

	useEffect(() => {
		if (
			githubIdentityState.status === "connected" ||
			githubIdentityState.status === "checking"
		) {
			return;
		}

		clearWorkspaceRuntimeState();
	}, [clearWorkspaceRuntimeState, githubIdentityState.status]);

	useEffect(() => {
		try {
			window.localStorage.setItem(
				SIDEBAR_WIDTH_STORAGE_KEY,
				String(sidebarWidth),
			);
		} catch {
			// Ignore storage failures and keep the current in-memory width.
		}
	}, [sidebarWidth]);

	useEffect(() => {
		try {
			window.localStorage.setItem(
				INSPECTOR_WIDTH_STORAGE_KEY,
				String(inspectorWidth),
			);
		} catch {
			// Ignore storage failures and keep the current in-memory width.
		}
	}, [inspectorWidth]);

	useEffect(() => {
		if (!resizeState) {
			return;
		}

		// Throttle width updates to once-per-frame via rAF. Without this, every
		// pixel of mousemove (60+ Hz) triggers setSidebarWidth/setInspectorWidth
		// → AppShell re-renders the entire workspace tree.
		let pendingWidth: number | null = null;
		let rafId: number | null = null;
		const flush = () => {
			rafId = null;
			if (pendingWidth === null) return;
			const nextWidth = pendingWidth;
			pendingWidth = null;
			if (resizeState.target === "sidebar") {
				setSidebarWidth(nextWidth);
			} else {
				setInspectorWidth(nextWidth);
			}
		};

		const handleMouseMove = (event: globalThis.MouseEvent) => {
			const deltaX = event.clientX - resizeState.pointerX;
			const rawWidth =
				resizeState.target === "sidebar"
					? resizeState.sidebarWidth + deltaX
					: resizeState.sidebarWidth - deltaX;
			pendingWidth = clampSidebarWidth(rawWidth);
			if (rafId === null) {
				rafId = window.requestAnimationFrame(flush);
			}
		};
		const handleMouseUp = () => {
			if (rafId !== null) {
				window.cancelAnimationFrame(rafId);
				rafId = null;
			}
			// Make sure the final width is committed before tearing down.
			flush();
			setResizeState(null);
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
	}, [resizeState]);

	const handleStartGithubOAuthRedirect = useCallback(async () => {
		try {
			const { oauthUrl } = await startGithubOAuthRedirect();
			setGithubIdentityState({ status: "awaiting-redirect" });
			await openUrl(oauthUrl);
		} catch (error) {
			setGithubIdentityState({
				status: "error",
				message: describeUnknownError(error, "Unable to start GitHub sign-in."),
			});
		}
	}, []);

	const handleCopyGithubDeviceCode = useCallback(
		async (userCode: string) => {
			if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
				pushWorkspaceToast(
					"Unable to copy the one-time code on this device.",
					"Copy failed",
				);
				return false;
			}

			try {
				await navigator.clipboard.writeText(userCode);
				return true;
			} catch {
				pushWorkspaceToast("Unable to copy the one-time code.", "Copy failed");
				return false;
			}
		},
		[pushWorkspaceToast],
	);

	const handleCancelGithubIdentityConnect = useCallback(() => {
		void cancelGithubIdentityConnect()
			.then(() => {
				setGithubIdentityState({ status: "disconnected" });
			})
			.catch((error) => {
				setGithubIdentityState({
					status: "error",
					message: describeUnknownError(
						error,
						"Unable to cancel GitHub account connection.",
					),
				});
			});
	}, []);

	const handleDisconnectGithubIdentity = useCallback(async () => {
		try {
			await disconnectGithubIdentity();
			setGithubIdentityState({ status: "disconnected" });
		} catch (error) {
			setGithubIdentityState({
				status: "error",
				message: describeUnknownError(
					error,
					"Unable to disconnect the GitHub account.",
				),
			});
		}
	}, []);

	const handleResizeStart = useCallback(
		(target: "sidebar" | "inspector") =>
			(event: MouseEvent<HTMLDivElement>) => {
				event.preventDefault();
				setResizeState({
					pointerX: event.clientX,
					sidebarWidth: target === "sidebar" ? sidebarWidth : inspectorWidth,
					target,
				});
			},
		[sidebarWidth, inspectorWidth],
	);

	const handleResizeKeyDown = useCallback(
		(target: "sidebar" | "inspector") =>
			(event: KeyboardEvent<HTMLDivElement>) => {
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					if (target === "sidebar") {
						setSidebarWidth((currentWidth) =>
							clampSidebarWidth(currentWidth - SIDEBAR_RESIZE_STEP),
						);
						return;
					}

					setInspectorWidth((currentWidth) =>
						clampSidebarWidth(currentWidth + SIDEBAR_RESIZE_STEP),
					);
				}

				if (event.key === "ArrowRight") {
					event.preventDefault();
					if (target === "sidebar") {
						setSidebarWidth((currentWidth) =>
							clampSidebarWidth(currentWidth + SIDEBAR_RESIZE_STEP),
						);
						return;
					}

					setInspectorWidth((currentWidth) =>
						clampSidebarWidth(currentWidth - SIDEBAR_RESIZE_STEP),
					);
				}
			},
		[],
	);

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
		(path: string) => {
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

			setWorkspaceViewMode("editor");
			setEditorSession({
				kind: "diff",
				path,
				inline: false,
				dirty: false,
			});
		},
		[
			confirmDiscardEditorChanges,
			editorSession?.path,
			pushWorkspaceToast,
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
		(workspaceId: string) => {
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

			if (workspaceSessions.length > 0) {
				const sessionIds = new Set(
					workspaceSessions.map((session) => session.id),
				);
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

			return (
				workspaceDetail?.activeSessionId ??
				workspaceSessions.find((session) => session.active)?.id ??
				workspaceSessions[0]?.id ??
				null
			);
		},
		[queryClient],
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
		if (!isIdentityConnected) {
			return;
		}

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
		isIdentityConnected,
		primeWorkspaceDisplay,
		selectedWorkspaceId,
		workspaceGroups,
	]);

	const handleSelectWorkspace = useCallback(
		(workspaceId: string | null) => {
			if (workspaceId === selectedWorkspaceIdRef.current) {
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
			// Clear all completed-session dots belonging to this workspace
			if (workspaceId) {
				setCompletedSessions((prev) => {
					let changed = false;
					for (const [, wsId] of prev) {
						if (wsId === workspaceId) {
							changed = true;
							break;
						}
					}
					if (!changed) return prev;
					const next = new Map<string, string>();
					for (const [sid, wsId] of prev) {
						if (wsId !== workspaceId) next.set(sid, wsId);
					}
					return next;
				});
			}
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

			const cachedWorkspaceDisplay = resolveCachedWorkspaceDisplay(workspaceId);
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
			// Clear the "completed while away" dot for this session
			if (sessionId) {
				setCompletedSessions((prev) => {
					if (!prev.has(sessionId)) return prev;
					const next = new Map(prev);
					next.delete(sessionId);
					return next;
				});
			}
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

	const handleSessionCompleted = useCallback(
		(sessionId: string, workspaceId: string) => {
			if (sessionId === selectedSessionIdRef.current) return;
			setCompletedSessions((prev) => {
				const next = new Map(prev);
				next.set(sessionId, workspaceId);
				return next;
			});
		},
		[],
	);

	const handleInspectorCommitAction = useCallback(
		async (mode: WorkspaceCommitButtonMode) => {
			const workspaceId = selectedWorkspaceIdRef.current;
			if (!workspaceId) {
				console.warn("[commitButton] action ignored: no selected workspace");
				return;
			}

			console.log("[commitButton] begin", { mode, workspaceId });

			// -----------------------------------------------------------
			// Direct API actions with optimistic update.
			// Merge / close are fast single-request operations — we
			// optimistically flip the UI to the final state immediately
			// and roll back if the API call fails.
			// -----------------------------------------------------------
			if (mode === "merge" || mode === "closed") {
				const currentPr = queryClient.getQueryData<PullRequestInfo | null>(
					helmorQueryKeys.workspacePr(workspaceId),
				);
				const optimisticPr: PullRequestInfo | null = currentPr
					? {
							...currentPr,
							state: mode === "merge" ? "MERGED" : "CLOSED",
							isMerged: mode === "merge",
						}
					: null;
				const optimisticStatus = mode === "merge" ? "done" : "canceled";
				const previousStatus =
					selectedWorkspaceDetailQuery.data?.manualStatus ?? null;

				// 1. Optimistically update UI — button, PR badge, sidebar group.
				setCommitLifecycle({
					workspaceId,
					trackedSessionId: null,
					mode,
					phase: "done",
					prInfo: optimisticPr,
				});
				queryClient.setQueryData(
					helmorQueryKeys.workspacePr(workspaceId),
					optimisticPr,
				);
				void setWorkspaceManualStatus(workspaceId, optimisticStatus).then(() =>
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceGroups,
					}),
				);

				// 2. Fire the actual API call in the background.
				void (async () => {
					try {
						const result =
							mode === "merge"
								? await mergeWorkspacePr(workspaceId)
								: await closeWorkspacePr(workspaceId);
						// Refresh with real data from GitHub.
						queryClient.setQueryData(
							helmorQueryKeys.workspacePr(workspaceId),
							result,
						);
					} catch (error) {
						console.error(`[commitButton] ${mode} failed:`, error);
						// 3. Rollback — restore previous PR state + workspace status.
						queryClient.setQueryData(
							helmorQueryKeys.workspacePr(workspaceId),
							currentPr,
						);
						void setWorkspaceManualStatus(workspaceId, previousStatus).then(
							() =>
								queryClient.invalidateQueries({
									queryKey: helmorQueryKeys.workspaceGroups,
								}),
						);
						setCommitLifecycle((prev) =>
							prev
								? { ...prev, phase: "error", prInfo: currentPr ?? null }
								: prev,
						);
					}
				})();
				return;
			}

			// -----------------------------------------------------------
			// Agent-session actions — create session + dispatch prompt.
			// -----------------------------------------------------------
			const prompt = COMMIT_BUTTON_PROMPTS[mode];
			if (!prompt) {
				console.warn(
					`[commitButton] action ignored: no prompt for mode ${mode}`,
				);
				return;
			}

			// Enter the lifecycle immediately so the button flips to busy
			// before we await anything. `trackedSessionId` fills in after the
			// session has been created below.
			setCommitLifecycle({
				workspaceId,
				trackedSessionId: null,
				mode,
				phase: "creating",
				prInfo: null,
			});

			try {
				const { sessionId } = await createSession(workspaceId, mode);
				console.log("[commitButton] session created", { sessionId });

				// Refresh the workspace's session list so the new session
				// becomes visible in the tab strip + sidebar before we switch.
				await queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
				});

				setCommitLifecycle((current) =>
					current && current.phase === "creating"
						? { ...current, trackedSessionId: sessionId }
						: current,
				);

				// Queue the prompt for the conversation container to dispatch
				// once it's rendering this session. Setting state before
				// selecting guarantees the container's submit effect sees the
				// queue on the first render with the matching session.
				setPendingPromptForSession({ sessionId, prompt });
				handleSelectSession(sessionId);
			} catch (error) {
				console.error("[commitButton] Failed to start session:", error);
				setCommitLifecycle((current) =>
					current ? { ...current, phase: "error" } : current,
				);
			}
		},
		[handleSelectSession, queryClient],
	);

	const handlePendingPromptConsumed = useCallback(() => {
		console.log("[commitButton] pending prompt consumed by composer");
		setPendingPromptForSession(null);
		// The composer has handed the prompt off — the stream is now running.
		setCommitLifecycle((current) =>
			current && current.phase === "creating"
				? { ...current, phase: "streaming" }
				: current,
		);
	}, []);

	// Watch the tracked session as it moves through the sending set. Once it
	// exits (stream finished), verify whether a PR was created and rotate to
	// the next button mode.
	const commitLifecycleRef = useRef(commitLifecycle);
	commitLifecycleRef.current = commitLifecycle;
	// Remember whether the tracked session has been observed as "sending" at
	// least once. Otherwise we might see an empty sendingSessionIds set before
	// the composer even runs the submit and prematurely treat the absence as
	// "stream ended".
	const hasObservedSendingRef = useRef(false);
	useEffect(() => {
		const current = commitLifecycleRef.current;
		console.log("[commitButton] sendingSessionIds effect fired", {
			sendingIds: Array.from(sendingSessionIds),
			lifecyclePhase: current?.phase ?? null,
			trackedSessionId: current?.trackedSessionId ?? null,
			observedBefore: hasObservedSendingRef.current,
		});

		if (!current?.trackedSessionId) return;
		if (current.phase !== "creating" && current.phase !== "streaming") return;

		const isSending = sendingSessionIds.has(current.trackedSessionId);
		if (isSending) {
			console.log("[commitButton] tracked session is streaming");
			hasObservedSendingRef.current = true;
			return;
		}

		// Wait until we've actually seen the session streaming before we
		// interpret its absence as completion. This avoids a race where the
		// effect fires before the composer submits.
		if (!hasObservedSendingRef.current) {
			console.log(
				"[commitButton] tracked session not yet observed streaming — waiting",
			);
			return;
		}

		// Stream has finished. Move to verification.
		console.log(
			"[commitButton] stream ended — transitioning to verifying phase",
		);
		hasObservedSendingRef.current = false;
		setCommitLifecycle((prev) =>
			prev ? { ...prev, phase: "verifying" } : prev,
		);

		const workspaceId = current.workspaceId;
		void (async () => {
			try {
				console.log("[commitButton] calling lookupWorkspacePr", workspaceId);
				const pr = await lookupWorkspacePr(workspaceId);
				console.log("[commitButton] lookupWorkspacePr result", pr);
				setCommitLifecycle((prev) => {
					if (!prev || prev.workspaceId !== workspaceId) return prev;
					// Even if PR is null (verifier couldn't find it), treat as
					// "done" so the lifecycle dwell runs and the PR query's
					// background poll can pick it up later.
					return { ...prev, phase: "done", prInfo: pr ?? null };
				});
			} catch (error) {
				console.error("[commitButton] PR lookup failed:", error);
				setCommitLifecycle((prev) =>
					prev && prev.workspaceId === workspaceId
						? { ...prev, phase: "error" }
						: prev,
				);
			}
		})();
	}, [sendingSessionIds]);

	// After a short dwell in `done` / `error`, reset the lifecycle so the
	// button returns to idle (possibly in a new mode). On `done` we also
	// auto-hide the session if the user has opted-in via the composer's
	// "Enable Auto Close" toggle — no first-time prompt, user discovers the
	// feature via the inline button in the composer header.
	useEffect(() => {
		if (!commitLifecycle) return;
		if (commitLifecycle.phase !== "done" && commitLifecycle.phase !== "error") {
			return;
		}

		const { phase, mode, trackedSessionId, workspaceId } = commitLifecycle;

		if (phase === "done") {
			// Merge/close use optimistic cache updates — don't refetch the
			// PR query here or GitHub's propagation delay will briefly
			// overwrite the optimistic value with the old state.
			if (mode !== "merge" && mode !== "closed") {
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspacePr(workspaceId),
				});
			}
			// Refresh the file list so committed files disappear.
			queryClient.invalidateQueries({
				queryKey: ["workspaceChanges"],
			});

			void (async () => {
				try {
					// Transition workspace sidebar status based on what just
					// completed:
					// Merge/close already handle status optimistically in
					// handleInspectorCommitAction — only create-pr needs it here.
					if (mode === "create-pr") {
						await setWorkspaceManualStatus(workspaceId, "review");
						await queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceGroups,
						});
					}

					if (!trackedSessionId) return;
					const optedIn = await loadAutoCloseActionKinds();
					if (!optedIn.includes(mode)) return;
					await hideSession(trackedSessionId);
					await Promise.all([
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
						}),
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
						}),
					]);
					const detail = queryClient.getQueryData<WorkspaceDetail>(
						helmorQueryKeys.workspaceDetail(workspaceId),
					);
					handleSelectSession(detail?.activeSessionId ?? null);
				} catch (error) {
					console.error(
						"[commitButton] done-phase side effects failed:",
						error,
					);
				}
			})();
		}

		const timeoutId = window.setTimeout(
			() => {
				setCommitLifecycle(null);
			},
			phase === "done" ? 1200 : 1600,
		);
		return () => window.clearTimeout(timeoutId);
	}, [commitLifecycle, handleSelectSession, queryClient]);

	// Derive the controlled button state + mode. When no lifecycle is
	// active, the resting mode comes from the persistent PR query so the
	// button stays in "merge" / "merged" after a successful create-pr even
	// across page reloads.
	const commitButtonMode: WorkspaceCommitButtonMode = (() => {
		if (commitLifecycle) {
			if (commitLifecycle.phase === "done" && commitLifecycle.prInfo) {
				return commitLifecycle.prInfo.isMerged ? "merged" : "merge";
			}
			return commitLifecycle.mode;
		}
		// Resting state — derive from persisted PR query.
		if (workspacePrInfo) {
			if (workspacePrInfo.isMerged) return "merged";
			if (workspacePrInfo.state === "OPEN") return "merge";
			if (workspacePrInfo.state === "CLOSED") return "create-pr";
		}
		return "create-pr";
	})();
	const commitButtonState: CommitButtonState = (() => {
		if (!commitLifecycle) return "idle";
		switch (commitLifecycle.phase) {
			case "creating":
			case "streaming":
			case "verifying":
				return "busy";
			case "done":
				return "done";
			case "error":
				return "error";
		}
	})();

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

	useEffect(() => {
		if (!isIdentityConnected || workspaceViewMode === "editor") {
			return;
		}

		const handleWindowKeyDown = (event: globalThis.KeyboardEvent) => {
			if (!event.metaKey || !event.altKey || event.ctrlKey || event.shiftKey) {
				return;
			}

			if (
				event.key !== "ArrowLeft" &&
				event.key !== "ArrowRight" &&
				event.key !== "ArrowUp" &&
				event.key !== "ArrowDown"
			) {
				return;
			}

			event.preventDefault();

			if (event.key === "ArrowLeft") {
				handleNavigateSessions(-1);
				return;
			}

			if (event.key === "ArrowRight") {
				handleNavigateSessions(1);
				return;
			}

			if (event.key === "ArrowUp") {
				handleNavigateWorkspaces(-1);
				return;
			}

			handleNavigateWorkspaces(1);
		};

		window.addEventListener("keydown", handleWindowKeyDown, true);

		return () => {
			window.removeEventListener("keydown", handleWindowKeyDown, true);
		};
	}, [
		handleNavigateSessions,
		handleNavigateWorkspaces,
		isIdentityConnected,
		workspaceViewMode,
	]);

	const handleInsertIntoComposer = useCallback(
		(request: ComposerInsertRequest) => {
			const resolvedTarget = resolveComposerInsertTarget(request.target, {
				selectedWorkspaceId,
				displayedWorkspaceId,
				displayedSessionId,
			});
			const targetWorkspaceId = resolvedTarget.workspaceId;
			if (!targetWorkspaceId) {
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
					workspaceId: targetWorkspaceId,
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

	return (
		<TooltipProvider delayDuration={0}>
			<WorkspaceToastProvider value={pushWorkspaceToast}>
				<ComposerInsertProvider value={handleInsertIntoComposer}>
					{!isIdentityConnected ? (
						<GithubIdentityGate
							identityState={githubIdentityState}
							onConnectGithub={() => {
								void handleStartGithubOAuthRedirect();
							}}
							onCopyGithubCode={(userCode) =>
								handleCopyGithubDeviceCode(userCode)
							}
							onCancelGithubConnect={handleCancelGithubIdentityConnect}
						/>
					) : (
						<main
							aria-label="Application shell"
							className="relative h-screen overflow-hidden bg-background font-sans text-foreground antialiased"
						>
							<div className="relative flex h-full min-h-0 bg-background">
								{workspaceViewMode === "conversation" && (
									<>
										{!sidebarCollapsed && (
											<aside
												aria-label="Workspace sidebar"
												className="relative h-full shrink-0 overflow-hidden bg-sidebar"
												style={{ width: `${sidebarWidth}px` }}
											>
												<WorkspacesSidebarContainer
													selectedWorkspaceId={selectedWorkspaceId}
													sendingWorkspaceIds={sendingWorkspaceIds}
													completedWorkspaceIds={completedWorkspaceIds}
													onSelectWorkspace={handleSelectWorkspace}
													pushWorkspaceToast={pushWorkspaceToast}
												/>
												<Button
													aria-label="Collapse sidebar"
													onClick={() => setSidebarCollapsed(true)}
													variant="ghost"
													size="icon-xs"
													className="absolute right-[12px] top-[6px] z-20 text-muted-foreground hover:text-foreground"
												>
													<PanelLeftClose
														className="size-4"
														strokeWidth={1.8}
													/>
												</Button>
												<div className="absolute inset-x-3 bottom-3 z-20 flex items-center justify-between">
													<SettingsButton onClick={onOpenSettings} />
													<GithubStatusMenu
														identityState={githubIdentityState}
														onDisconnectGithub={() => {
															void handleDisconnectGithubIdentity();
														}}
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
										{workspaceViewMode === "editor" && editorSession ? (
											<WorkspaceEditorSurface
												editorSession={editorSession}
												workspaceRootPath={workspaceRootPath}
												onChangeSession={handleEditorSessionChange}
												onExit={handleExitEditorMode}
												onError={handleEditorSurfaceError}
											/>
										) : (
											<WorkspaceConversationContainer
												selectedWorkspaceId={selectedWorkspaceId}
												displayedWorkspaceId={displayedWorkspaceId}
												selectedSessionId={selectedSessionId}
												displayedSessionId={displayedSessionId}
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
												completedSessionIds={completedSessionIds}
												onSessionCompleted={handleSessionCompleted}
												workspacePrInfo={workspacePrInfo}
												pendingPromptForSession={pendingPromptForSession}
												onPendingPromptConsumed={handlePendingPromptConsumed}
												pendingInsertRequests={pendingComposerInserts}
												onPendingInsertRequestsConsumed={
													handlePendingComposerInsertsConsumed
												}
												headerLeading={
													sidebarCollapsed ? (
														<>
															{/* Spacer to avoid macOS traffic lights */}
															<div className="w-[52px] shrink-0" />
															<Button
																aria-label="Expand sidebar"
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
														</>
													) : undefined
												}
												headerActions={
													selectedWorkspaceId &&
													installedEditors.length > 0 &&
													preferredEditor ? (
														<div className="flex items-center">
															<Button
																variant="ghost"
																size="xs"
																aria-label={`Open in ${preferredEditor.name}`}
																title={`Open in ${preferredEditor.name}`}
																onClick={() =>
																	void openWorkspaceInEditor(
																		selectedWorkspaceId,
																		preferredEditor.id,
																	).catch((e) =>
																		pushWorkspaceToast(
																			String(e),
																			`Failed to open ${preferredEditor.name}`,
																		),
																	)
																}
																className="text-app-muted hover:text-app-foreground"
															>
																<EditorIcon
																	editorId={preferredEditor.id}
																	className="size-3.5"
																/>
																<span>{preferredEditor.name}</span>
															</Button>
															<DropdownMenu>
																<DropdownMenuTrigger asChild>
																	<Button
																		variant="ghost"
																		size="icon-xs"
																		className="w-4 text-app-muted hover:text-app-foreground"
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
																	sideOffset={6}
																	className="min-w-[11rem]"
																>
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
																				className="size-3.5 shrink-0"
																			/>
																			<span className="flex-1 font-medium">
																				{editor.name}
																			</span>
																			{editor.id === preferredEditor.id && (
																				<Check className="ml-auto size-3 text-muted-foreground" />
																			)}
																		</DropdownMenuItem>
																	))}
																</DropdownMenuContent>
															</DropdownMenu>
														</div>
													) : undefined
												}
											/>
										)}
									</div>
								</section>

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
										right: `${inspectorWidth - SIDEBAR_RESIZE_HIT_AREA / 2}px`,
										width: `${SIDEBAR_RESIZE_HIT_AREA}px`,
									}}
								>
									<span
										aria-hidden="true"
										className={`pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 transition-[width,background-color,box-shadow] ${
											isInspectorResizing
												? "w-[2px] bg-transparent shadow-none"
												: "w-px bg-border group-hover:w-[2px] group-hover:bg-muted-foreground/75 group-focus-visible:w-[2px] group-focus-visible:bg-muted-foreground/75"
										}`}
									/>
								</div>

								<aside
									aria-label="Inspector sidebar"
									className="relative h-full shrink-0 overflow-hidden bg-sidebar"
									style={{ width: `${inspectorWidth}px` }}
								>
									<WorkspaceInspectorSidebar
										workspaceRootPath={workspaceRootPath}
										workspaceBranch={
											selectedWorkspaceDetailQuery.data?.branch ?? null
										}
										workspaceTargetBranch={
											selectedWorkspaceDetailQuery.data?.intendedTargetBranch ??
											selectedWorkspaceDetailQuery.data?.defaultBranch ??
											null
										}
										editorMode={workspaceViewMode === "editor"}
										activeEditorPath={editorSession?.path ?? null}
										onOpenEditorFile={handleOpenEditorFile}
										onCommitAction={handleInspectorCommitAction}
										commitButtonMode={commitButtonMode}
										commitButtonState={commitButtonState}
										prInfo={workspacePrInfo}
									/>
								</aside>
							</div>
						</main>
					)}
					<Toaster
						theme={resolveTheme(appSettings.theme)}
						position="top-right"
						visibleToasts={6}
					/>
				</ComposerInsertProvider>
			</WorkspaceToastProvider>
		</TooltipProvider>
	);
}

function EditorIcon({
	editorId,
	className,
}: {
	editorId: string;
	className?: string;
}) {
	switch (editorId) {
		case "cursor":
			return (
				<svg
					className={className}
					viewBox="0 0 466.73 532.09"
					fill="currentColor"
				>
					<path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
				</svg>
			);
		case "vscode":
		case "vscode-insiders":
			return (
				<svg className={className} viewBox="0 0 24 24" fill="currentColor">
					<path d="M17.58 2.39L10 9.43 4.64 5.42 2 6.76v10.48l2.64 1.34L10 14.57l7.58 7.04L22 19.33V4.67l-4.42-2.28zM4.64 15.36V8.64L7.93 12l-3.29 3.36zM17.58 17.6l-5.37-5.6 5.37-5.6v11.2z" />
				</svg>
			);
		case "windsurf":
			return (
				<svg className={className} viewBox="0 0 24 24" fill="currentColor">
					<path d="M22.6522 4.79395L12.5765 19.206L2.50098 4.79395H10.5387L12.5765 7.93835L14.6143 4.79395H22.6522Z" />
				</svg>
			);
		case "zed":
			return (
				<svg className={className} viewBox="0 0 24 24" fill="currentColor">
					<path d="M5.976 4.016L15.584 4.016L5.648 16H10.496L12.08 13.664L18.688 4.016L20 4.016V20H5.976V17.6H15.584L5.648 4.016H5.976ZM12.08 13.664L10.496 16H20V20H5.976L15.912 8H11.064L9.48 10.336L2.872 20H1.56V4.016H15.584L5.648 16H10.496" />
				</svg>
			);
		case "webstorm":
			return (
				<svg className={className} viewBox="0 0 24 24" fill="currentColor">
					<path d="M0 0v24h24V0H0zm2.4 2.4h19.2v19.2H2.4V2.4zm1.8 1.5v1.2h6v-1.2h-6zm8.7 0L9.6 12.6l-1.8-5.4H6l3 9h1.5l1.5-4.5 1.5 4.5H15l3-9h-1.8l-1.8 5.4-1.5-8.7h-1.5zM4.2 19.2h7.2v1.2H4.2v-1.2z" />
				</svg>
			);
		case "sublime":
			return (
				<svg className={className} viewBox="0 0 24 24" fill="currentColor">
					<path d="M20.953 6.924c-.123-.429-.404-.715-.834-.858-.378-.126-6.32-2.048-6.32-2.048s-.065-.024-.203-.065c-.484-.138-.793-.065-1.136.199-.243.188-8.39 6.1-8.39 6.1S3.535 10.579 3.2 10.877c-.233.208-.374.463-.373.794.002.33.087.523.393.754l8.04 5.078s5.833 1.953 6.243 2.086c.488.16.867.09 1.2-.166.236-.183.347-.273.347-.273l-.003-5.402-7.473-4.424 7.476-2.4" />
				</svg>
			);
		default:
			return <ExternalLink className={className} strokeWidth={1.8} />;
	}
}

function GithubIdentityGate({
	identityState,
	onConnectGithub,
	onCopyGithubCode,
	onCancelGithubConnect,
}: {
	identityState: GithubIdentityState;
	onConnectGithub: () => void;
	onCopyGithubCode: (userCode: string) => Promise<boolean>;
	onCancelGithubConnect: () => void;
}) {
	const [codeCopied, setCodeCopied] = useState(false);

	const title =
		identityState.status === "checking"
			? "Checking GitHub connection"
			: identityState.status === "awaiting-redirect"
				? "Waiting for GitHub authorization"
				: identityState.status === "pending"
					? "Finish sign-in on GitHub"
					: identityState.status === "unconfigured"
						? "GitHub account connection is not configured"
						: identityState.status === "error"
							? "GitHub connection failed"
							: "Sign in with GitHub";
	const description =
		identityState.status === "checking"
			? "Helmor is restoring your last GitHub account session."
			: identityState.status === "awaiting-redirect"
				? "Complete the sign-in in your browser. Helmor will update automatically."
				: identityState.status === "pending"
					? "Copy the code below, then you'll be redirected to GitHub to authorize."
					: identityState.status === "unconfigured"
						? identityState.message
						: identityState.status === "error"
							? identityState.message
							: "GitHub account connection is required before Helmor loads your workspaces.";

	const handleCopyCodeThenRedirect = useCallback(async () => {
		if (identityState.status !== "pending" || codeCopied) {
			return;
		}

		const copied = await onCopyGithubCode(identityState.flow.userCode);

		if (!copied) {
			return;
		}

		setCodeCopied(true);

		const { verificationUri, verificationUriComplete } = identityState.flow;

		setTimeout(() => {
			void (async () => {
				try {
					await openUrl(verificationUriComplete ?? verificationUri);
				} catch {
					// Keep the pending state visible even if the browser cannot be opened.
				}
			})();
		}, 600);
	}, [identityState, onCopyGithubCode, codeCopied]);

	return (
		<main
			aria-label="GitHub identity gate"
			className="relative h-screen overflow-hidden bg-background font-sans text-foreground antialiased"
		>
			<div
				aria-label="GitHub identity gate drag region"
				className="absolute inset-x-0 top-0 z-10 flex h-11 items-center"
			>
				<div data-tauri-drag-region className="h-full w-[94px] shrink-0" />
				<div data-tauri-drag-region className="h-full flex-1" />
			</div>

			<div className="relative flex h-full items-center justify-center px-6">
				<div className="w-full max-w-[31rem]">
					<h1 className="text-center text-[40px] leading-[1.04] tracking-[-0.04em] text-foreground">
						{title}
					</h1>
					<p className="mx-auto mt-4 max-w-[31rem] text-center text-[16px] leading-7 text-muted-foreground">
						{description}
					</p>

					{identityState.status === "awaiting-redirect" ? (
						<div className="mt-8 flex flex-col items-center gap-4">
							<div className="inline-flex items-center gap-2 text-[14px] text-muted-foreground">
								<RefreshCw className="size-4 animate-spin" strokeWidth={1.8} />
								Waiting for authorization
							</div>
							<Button
								variant="ghost"
								onClick={onCancelGithubConnect}
								className="rounded-full px-4 text-[14px] text-muted-foreground hover:text-foreground"
							>
								Cancel
							</Button>
						</div>
					) : identityState.status === "pending" ? (
						<div className="mt-8 flex flex-col items-center gap-5">
							<Button
								variant="ghost"
								onClick={() => {
									void handleCopyCodeThenRedirect();
								}}
								disabled={codeCopied}
								className="relative h-auto rounded-2xl px-5 py-3 hover:bg-accent/60"
								aria-label="Copy one-time code"
								title="Copy one-time code"
							>
								<span className="font-mono text-[30px] tracking-[0.18em] text-foreground">
									{identityState.flow.userCode}
								</span>
								<span className="absolute -right-6 top-1/2 flex -translate-y-1/2 items-center justify-center">
									{codeCopied ? (
										<Check
											className="size-4 text-green-400"
											strokeWidth={2.5}
										/>
									) : (
										<Copy
											className="size-4 text-foreground/40"
											strokeWidth={1.8}
										/>
									)}
								</span>
							</Button>
							<div className="flex flex-wrap items-center justify-center gap-3">
								<Button
									variant="ghost"
									onClick={onCancelGithubConnect}
									className="rounded-full px-4 text-[14px] text-muted-foreground hover:text-foreground"
								>
									Cancel
								</Button>
							</div>
						</div>
					) : identityState.status === "unconfigured" ? (
						<div className="mt-8 flex justify-center">
							<Button
								disabled
								className="rounded-full px-4 text-[14px] opacity-70"
							>
								<MarkGithubIcon size={16} data-icon="inline-start" />
								Continue with GitHub
							</Button>
						</div>
					) : identityState.status === "checking" ? (
						<div className="mt-8 inline-flex w-full items-center justify-center gap-2 text-[14px] text-muted-foreground">
							<RefreshCw className="size-4 animate-spin" strokeWidth={1.8} />
							Restoring your last session
						</div>
					) : (
						<div className="mt-8 flex justify-center">
							<Button
								onClick={onConnectGithub}
								className="rounded-full px-4 text-[14px]"
							>
								<MarkGithubIcon size={16} data-icon="inline-start" />
								{identityState.status === "error"
									? "Retry with GitHub"
									: "Continue with GitHub"}
							</Button>
						</div>
					)}
				</div>
			</div>
		</main>
	);
}

function GithubStatusMenu({
	identityState,
	onDisconnectGithub,
}: {
	identityState: Extract<GithubIdentityState, { status: "connected" }>;
	onDisconnectGithub: () => void;
}) {
	const identitySession = identityState.session;
	const triggerLabel = identitySession.login;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="GitHub account menu"
				className="inline-flex h-7 items-center gap-2 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
			>
				<Avatar size="sm" className="size-4">
					{identitySession?.avatarUrl ? (
						<AvatarImage
							src={identitySession.avatarUrl}
							alt={identitySession.login}
						/>
					) : null}
					<AvatarFallback className="bg-muted text-[10px] font-medium text-muted-foreground">
						{identitySession?.login.slice(0, 2).toUpperCase() ?? "GH"}
					</AvatarFallback>
				</Avatar>
				<span className="text-[13px] font-medium text-muted-foreground">
					{triggerLabel}
				</span>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="end" sideOffset={8} className="w-44 p-1.5">
				<DropdownMenuItem
					className="rounded-md px-2 py-2 text-muted-foreground focus:bg-accent/60 focus:text-foreground"
					onClick={onDisconnectGithub}
				>
					Log out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export default App;
