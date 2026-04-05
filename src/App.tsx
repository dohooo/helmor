import "./App.css";
import { MarkGithubIcon } from "@primer/octicons-react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, Moon, RefreshCw, Sun } from "lucide-react";
import {
	type KeyboardEvent,
	type MouseEvent,
	memo,
	startTransition,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ConductorImportDialog } from "./components/conductor-import-dialog";
import { SettingsButton, SettingsDialog } from "./components/settings-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { ShimmerText } from "./components/ui/shimmer-text";
import {
	Toast,
	ToastClose,
	ToastDescription,
	ToastProvider,
	ToastTitle,
	ToastViewport,
} from "./components/ui/toast";
import { WorkspaceComposer } from "./components/workspace-composer";
import { WorkspacePanel } from "./components/workspace-panel";
import { WorkspacesSidebar } from "./components/workspaces-sidebar";
import {
	type AgentModelOption,
	type AgentModelSection,
	addRepositoryFromLocalPath,
	archiveWorkspace,
	cancelGithubIdentityConnect,
	createSession,
	createWorkspaceFromRepo,
	DEFAULT_AGENT_MODEL_SECTIONS,
	DEFAULT_WORKSPACE_GROUPS,
	disconnectGithubIdentity,
	type GithubIdentityDeviceFlowStart,
	type GithubIdentitySnapshot,
	hasTauriRuntime,
	isConductorAvailable,
	listenAgentStream,
	listenGithubIdentityChanged,
	listRepositories,
	loadAddRepositoryDefaults,
	loadAgentModelSections,
	loadArchivedWorkspaces,
	loadGithubIdentitySession,
	loadSessionAttachments,
	loadSessionMessages,
	loadWorkspaceDetail,
	loadWorkspaceGroups,
	loadWorkspaceSessions,
	markWorkspaceRead,
	markWorkspaceUnread,
	type RepositoryCreateOption,
	restoreWorkspace,
	type SessionAttachmentRecord,
	type SessionMessageRecord,
	startAgentMessageStream,
	startGithubIdentityConnect,
	stopAgentStream,
	type WorkspaceDetail,
	type WorkspaceGroup,
	type WorkspaceRow,
	type WorkspaceSessionSummary,
	type WorkspaceSummary,
} from "./lib/api";
import {
	type AppSettings,
	DEFAULT_SETTINGS,
	loadSettings,
	SettingsContext,
	saveSettings,
} from "./lib/settings";
import { StreamAccumulator } from "./lib/stream-accumulator";

const SIDEBAR_WIDTH_STORAGE_KEY = "helmor.workspaceSidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 336;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const SIDEBAR_RESIZE_STEP = 16;
const SIDEBAR_RESIZE_HIT_AREA = 20;
const DEFAULT_CLAUDE_MODEL_ID = "opus-1m";
const DEFAULT_CODEX_MODEL_ID = "gpt-5.4";

type WorkspaceToast = {
	id: string;
	title: string;
	description: string;
	variant?: "default" | "destructive";
};

type GithubIdentityState =
	| { status: "checking" }
	| { status: "pending"; flow: GithubIdentityDeviceFlowStart }
	| GithubIdentitySnapshot;

const BROWSER_DEV_GITHUB_IDENTITY_SESSION = {
	provider: "browser-dev",
	githubUserId: 0,
	login: "browser-dev",
	name: "Browser Dev",
	avatarUrl: null,
	primaryEmail: null,
	tokenExpiresAt: null,
	refreshTokenExpiresAt: null,
} as const;

function clampSidebarWidth(width: number) {
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function getInitialSidebarWidth() {
	if (typeof window === "undefined") {
		return DEFAULT_SIDEBAR_WIDTH;
	}

	try {
		const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);

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
	if (!hasTauriRuntime()) {
		return {
			status: "connected",
			session: BROWSER_DEV_GITHUB_IDENTITY_SESSION,
		};
	}

	return { status: "checking" };
}

function App() {
	const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const settingsContextValue = useMemo(
		() => ({
			settings: appSettings,
			updateSettings: (patch: Partial<AppSettings>) => {
				setAppSettings((prev) => {
					const next = { ...prev, ...patch };
					void saveSettings(patch);
					return next;
				});
			},
		}),
		[appSettings],
	);

	// Load settings from DB on mount
	useEffect(() => {
		void loadSettings().then(setAppSettings);
	}, []);

	const [githubIdentityState, setGithubIdentityState] =
		useState<GithubIdentityState>(getInitialGithubIdentityState);
	const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
	const [resizeState, setResizeState] = useState<{
		pointerX: number;
		sidebarWidth: number;
	} | null>(null);
	const [groups, setGroups] = useState<WorkspaceGroup[]>(
		DEFAULT_WORKSPACE_GROUPS,
	);
	const [archivedSummaries, setArchivedSummaries] = useState<
		WorkspaceSummary[]
	>([]);
	const [repositories, setRepositories] = useState<RepositoryCreateOption[]>(
		[],
	);
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
		findInitialWorkspaceId(DEFAULT_WORKSPACE_GROUPS),
	);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);
	const [workspaceDetail, setWorkspaceDetail] =
		useState<WorkspaceDetail | null>(null);
	const [workspaceSessions, setWorkspaceSessions] = useState<
		WorkspaceSessionSummary[]
	>([]);
	const [sessionMessages, setSessionMessages] = useState<
		SessionMessageRecord[]
	>([]);
	const [sessionAttachments, setSessionAttachments] = useState<
		SessionAttachmentRecord[]
	>([]);
	const [agentModelSections, setAgentModelSections] = useState<
		AgentModelSection[]
	>(DEFAULT_AGENT_MODEL_SECTIONS);
	const [composerModelSelections, setComposerModelSelections] = useState<
		Record<string, string>
	>({});
	const [composerEffortLevels, setComposerEffortLevels] = useState<
		Record<string, string>
	>({});
	const [composerPermissionModes, setComposerPermissionModes] = useState<
		Record<string, string>
	>({});
	const [composerRestoreState, setComposerRestoreState] = useState<{
		contextKey: string;
		draft: string;
		images: string[];
		nonce: number;
	} | null>(null);
	const [liveMessagesByContext, setLiveMessagesByContext] = useState<
		Record<string, SessionMessageRecord[]>
	>({});
	const [liveSessionsByContext, setLiveSessionsByContext] = useState<
		Record<string, { provider: string; sessionId?: string | null }>
	>({});
	const [sendErrorsByContext, setSendErrorsByContext] = useState<
		Record<string, string | null>
	>({});
	const [sendingContextKeys, setSendingContextKeys] = useState<
		Record<string, boolean>
	>({});
	// Track active sidecar session IDs for stop functionality
	const [activeSessionByContext, setActiveSessionByContext] = useState<
		Record<string, { sessionId: string; provider: string }>
	>({});
	const [markingReadWorkspaceId, setMarkingReadWorkspaceId] = useState<
		string | null
	>(null);
	const [markingUnreadWorkspaceId, setMarkingUnreadWorkspaceId] = useState<
		string | null
	>(null);
	const [deferredWorkspaceReadClearId, setDeferredWorkspaceReadClearId] =
		useState<string | null>(null);
	const [archivingWorkspaceId, setArchivingWorkspaceId] = useState<
		string | null
	>(null);
	const [restoringWorkspaceId, setRestoringWorkspaceId] = useState<
		string | null
	>(null);
	const [addingRepository, setAddingRepository] = useState(false);
	const [creatingWorkspaceRepoId, setCreatingWorkspaceRepoId] = useState<
		string | null
	>(null);
	const [workspaceToasts, setWorkspaceToasts] = useState<WorkspaceToast[]>([]);
	const openedGithubDeviceCodesRef = useRef<Set<string>>(new Set());
	const [loadingWorkspace, setLoadingWorkspace] = useState(false);
	const [loadingSession, setLoadingSession] = useState(false);
	const [dataVersion, setDataVersion] = useState(0);
	const [theme, setTheme] = useState<"light" | "dark">(() => {
		if (typeof window === "undefined") return "dark";
		return (localStorage.getItem("helmor.theme") as "light" | "dark") ?? "dark";
	});
	const [conductorAvailable, setConductorAvailable] = useState(false);
	const [importDialogOpen, setImportDialogOpen] = useState(false);
	const isResizing = resizeState !== null;
	const isIdentityConnected = githubIdentityState.status === "connected";

	useEffect(() => {
		void isConductorAvailable().then(setConductorAvailable);
	}, []);

	const toggleTheme = useCallback(() => {
		setTheme((t) => {
			const next = t === "dark" ? "light" : "dark";
			localStorage.setItem("helmor.theme", next);
			return next;
		});
	}, []);

	const pushWorkspaceToast = useCallback(
		(
			description: string,
			title = "Action failed",
			variant: "default" | "destructive" = "destructive",
		) => {
			setWorkspaceToasts((current) => [
				...current,
				{
					id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					title,
					description,
					variant,
				},
			]);
		},
		[],
	);

	const dismissWorkspaceToast = useCallback((toastId: string) => {
		setWorkspaceToasts((current) =>
			current.filter((toast) => toast.id !== toastId),
		);
	}, []);

	const clearWorkspaceRuntimeState = useCallback(() => {
		setSelectedWorkspaceId(null);
		setSelectedSessionId(null);
		setWorkspaceDetail(null);
		setWorkspaceSessions([]);
		setSessionMessages([]);
		setSessionAttachments([]);
		setRepositories([]);
		setLiveMessagesByContext({});
		setLiveSessionsByContext({});
		setSendErrorsByContext({});
		setSendingContextKeys({});
		setActiveSessionByContext({});
		setLoadingWorkspace(false);
		setLoadingSession(false);
		setDataVersion(0);
	}, []);

	useEffect(() => {
		document.documentElement.classList.toggle("dark", theme === "dark");
	}, [theme]);

	useEffect(() => {
		if (githubIdentityState.status !== "pending") {
			return;
		}

		const { deviceCode, verificationUri, verificationUriComplete } =
			githubIdentityState.flow;

		if (openedGithubDeviceCodesRef.current.has(deviceCode)) {
			return;
		}

		openedGithubDeviceCodesRef.current.add(deviceCode);
		void (async () => {
			try {
				await openUrl(verificationUriComplete ?? verificationUri);
			} catch {
				// Keep the pending state visible even if the browser cannot be opened.
			}
		})();
	}, [githubIdentityState]);

	useEffect(() => {
		let disposed = false;
		let unlistenIdentity: (() => void) | undefined;

		void loadGithubIdentitySession().then((snapshot) => {
			if (!disposed) {
				setGithubIdentityState(snapshot);
			}
		});

		if (hasTauriRuntime()) {
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
		}

		return () => {
			disposed = true;
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

	const archivedRows = useMemo(
		() => archivedSummaries.map(summaryToArchivedRow),
		[archivedSummaries],
	);
	const selectedSession =
		workspaceSessions.find((session) => session.id === selectedSessionId) ??
		null;
	const composerContextKey = getComposerContextKey(
		selectedWorkspaceId,
		selectedSessionId,
	);
	const selectedModelId =
		composerModelSelections[composerContextKey] ??
		inferDefaultModelId(selectedSession, agentModelSections);
	const selectedModel = findModelOption(agentModelSections, selectedModelId);
	const isOpusModel =
		selectedModelId === "opus-1m" || selectedModelId === "opus";
	const rawEffortLevel =
		composerEffortLevels[composerContextKey] ??
		selectedSession?.effortLevel ??
		"high";
	const currentEffortLevel = (() => {
		let level = rawEffortLevel;
		if (selectedModel?.provider === "codex") {
			if (level === "max") level = "xhigh";
		} else {
			if (level === "xhigh") level = isOpusModel ? "max" : "high";
			if (level === "minimal") level = "low";
			if (level === "max" && !isOpusModel) level = "high";
		}
		return level;
	})();
	const currentPermissionMode =
		composerPermissionModes[composerContextKey] ?? "acceptEdits";
	const liveMessages = liveMessagesByContext[composerContextKey] ?? [];
	const mergedMessages = useMemo(
		() => [...sessionMessages, ...liveMessages],
		[sessionMessages, liveMessages],
	);
	const activeSendError = sendErrorsByContext[composerContextKey] ?? null;
	const isSending = sendingContextKeys[composerContextKey] ?? false;

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
		if (!resizeState) {
			return;
		}

		const handleMouseMove = (event: globalThis.MouseEvent) => {
			setSidebarWidth(
				clampSidebarWidth(
					resizeState.sidebarWidth + event.clientX - resizeState.pointerX,
				),
			);
		};
		const handleMouseUp = () => {
			setResizeState(null);
		};
		const previousCursor = document.body.style.cursor;
		const previousUserSelect = document.body.style.userSelect;

		document.body.style.cursor = "ew-resize";
		document.body.style.userSelect = "none";

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);

		return () => {
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousUserSelect;
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};
	}, [resizeState]);

	useEffect(() => {
		if (!isIdentityConnected) {
			return;
		}

		let disposed = false;

		void Promise.all([
			loadWorkspaceGroups(),
			loadArchivedWorkspaces(),
			loadAgentModelSections(),
			listRepositories(),
		]).then(
			([
				loadedGroups,
				loadedArchived,
				loadedModelSections,
				loadedRepositories,
			]) => {
				if (disposed) {
					return;
				}

				setGroups(loadedGroups);
				setArchivedSummaries(loadedArchived);
				setAgentModelSections(loadedModelSections);
				setRepositories(loadedRepositories);
				setSelectedWorkspaceId((current) => {
					if (
						current &&
						hasWorkspaceId(current, loadedGroups, loadedArchived)
					) {
						return current;
					}

					return (
						findInitialWorkspaceId(loadedGroups) ??
						loadedArchived[0]?.id ??
						null
					);
				});
			},
		);

		return () => {
			disposed = true;
		};
	}, [isIdentityConnected]);

	const refreshAllData = useCallback(() => {
		if (!isIdentityConnected) {
			return;
		}

		void Promise.all([
			loadWorkspaceGroups(),
			loadArchivedWorkspaces(),
			listRepositories(),
		]).then(([loadedGroups, loadedArchived, loadedRepositories]) => {
			setGroups(loadedGroups);
			setArchivedSummaries(loadedArchived);
			setRepositories(loadedRepositories);

			// Auto-select first workspace if none is currently selected
			setSelectedWorkspaceId((current) => {
				if (current && hasWorkspaceId(current, loadedGroups, loadedArchived)) {
					return current;
				}
				return (
					findInitialWorkspaceId(loadedGroups) ?? loadedArchived[0]?.id ?? null
				);
			});

			// Bump dataVersion to force workspace detail + session useEffects to re-run
			setDataVersion((v) => v + 1);
		});
	}, [isIdentityConnected]);

	useEffect(() => {
		if (!isIdentityConnected) {
			return;
		}

		if (!selectedWorkspaceId) {
			setWorkspaceDetail(null);
			setWorkspaceSessions([]);
			setSelectedSessionId(null);
			return;
		}

		let disposed = false;
		setLoadingWorkspace(true);

		void Promise.all([
			loadWorkspaceDetail(selectedWorkspaceId),
			loadWorkspaceSessions(selectedWorkspaceId),
		]).then(([detail, sessions]) => {
			if (disposed) {
				return;
			}

			setWorkspaceDetail(detail);
			setWorkspaceSessions(sessions);
			setSelectedSessionId((current) => {
				if (current && sessions.some((session) => session.id === current)) {
					return current;
				}

				return (
					detail?.activeSessionId ??
					sessions.find((session) => session.active)?.id ??
					sessions[0]?.id ??
					null
				);
			});
			setLoadingWorkspace(false);
		});

		return () => {
			disposed = true;
		};
	}, [dataVersion, isIdentityConnected, selectedWorkspaceId]);

	useEffect(() => {
		if (!isIdentityConnected) {
			return;
		}

		if (!selectedSessionId) {
			setSessionMessages([]);
			setSessionAttachments([]);
			return;
		}

		let disposed = false;
		setLoadingSession(true);

		void Promise.all([
			loadSessionMessages(selectedSessionId),
			loadSessionAttachments(selectedSessionId),
		]).then(([messages, attachments]) => {
			if (disposed) {
				return;
			}

			setSessionMessages(messages);
			setSessionAttachments(attachments);
			setLoadingSession(false);
		});

		return () => {
			disposed = true;
		};
	}, [dataVersion, isIdentityConnected, selectedSessionId]);

	const refreshSelectedWorkspaceCollections = useCallback(
		async (workspaceId: string, preferredSessionId: string | null) => {
			const [detail, sessions, loadedGroups, loadedArchived] =
				await Promise.all([
					loadWorkspaceDetail(workspaceId),
					loadWorkspaceSessions(workspaceId),
					loadWorkspaceGroups(),
					loadArchivedWorkspaces(),
				]);

			setWorkspaceDetail(detail);
			setWorkspaceSessions(sessions);
			setGroups(loadedGroups);
			setArchivedSummaries(loadedArchived);

			const resolvedSessionId =
				preferredSessionId &&
				sessions.some((session) => session.id === preferredSessionId)
					? preferredSessionId
					: (detail?.activeSessionId ??
						sessions.find((session) => session.active)?.id ??
						sessions[0]?.id ??
						null);

			setSelectedSessionId(resolvedSessionId);
		},
		[],
	);

	const refreshWorkspaceNavigation = useCallback(async () => {
		const [loadedGroups, loadedArchived, loadedRepositories] =
			await Promise.all([
				loadWorkspaceGroups(),
				loadArchivedWorkspaces(),
				listRepositories(),
			]);

		setGroups(loadedGroups);
		setArchivedSummaries(loadedArchived);
		setRepositories(loadedRepositories);

		return {
			loadedGroups,
			loadedArchived,
			loadedRepositories,
		};
	}, []);

	const hydrateWorkspaceSelection = useCallback(
		async (workspaceId: string | null) => {
			setSelectedWorkspaceId(workspaceId);

			if (!workspaceId) {
				setWorkspaceDetail(null);
				setWorkspaceSessions([]);
				setSelectedSessionId(null);
				setSessionMessages([]);
				setSessionAttachments([]);
				return;
			}

			setLoadingWorkspace(true);
			const [detail, sessions] = await Promise.all([
				loadWorkspaceDetail(workspaceId),
				loadWorkspaceSessions(workspaceId),
			]);
			const nextSessionId =
				detail?.activeSessionId ??
				sessions.find((session) => session.active)?.id ??
				sessions[0]?.id ??
				null;

			setWorkspaceDetail(detail);
			setWorkspaceSessions(sessions);
			setSelectedSessionId(nextSessionId);
			setLoadingWorkspace(false);

			if (!nextSessionId) {
				setSessionMessages([]);
				setSessionAttachments([]);
				return;
			}

			setLoadingSession(true);
			const [messages, attachments] = await Promise.all([
				loadSessionMessages(nextSessionId),
				loadSessionAttachments(nextSessionId),
			]);
			setSessionMessages(messages);
			setSessionAttachments(attachments);
			setLoadingSession(false);
		},
		[],
	);

	useEffect(() => {
		if (!isIdentityConnected) {
			return;
		}

		if (!selectedWorkspaceId || loadingWorkspace || loadingSession) {
			return;
		}

		let disposed = false;

		const syncUnreadState = async () => {
			if (
				((workspaceDetail?.workspaceUnread ?? 0) > 0 ||
					(workspaceDetail?.sessionUnreadTotal ?? 0) > 0) &&
				deferredWorkspaceReadClearId !== selectedWorkspaceId &&
				markingReadWorkspaceId !== selectedWorkspaceId
			) {
				setMarkingReadWorkspaceId(selectedWorkspaceId);

				try {
					await markWorkspaceRead(selectedWorkspaceId);

					if (!disposed) {
						await refreshSelectedWorkspaceCollections(
							selectedWorkspaceId,
							null,
						);
					}
				} catch (error) {
					console.error("Failed to mark workspace as read", error);
				} finally {
					if (!disposed) {
						setMarkingReadWorkspaceId((current) =>
							current === selectedWorkspaceId ? null : current,
						);
					}
				}
			}
		};

		void syncUnreadState();

		return () => {
			disposed = true;
		};
	}, [
		loadingSession,
		loadingWorkspace,
		markingReadWorkspaceId,
		deferredWorkspaceReadClearId,
		refreshSelectedWorkspaceCollections,
		selectedWorkspaceId,
		workspaceDetail?.sessionUnreadTotal,
		workspaceDetail?.workspaceUnread,
		isIdentityConnected,
	]);

	useEffect(() => {
		if (
			deferredWorkspaceReadClearId &&
			selectedWorkspaceId !== deferredWorkspaceReadClearId
		) {
			setDeferredWorkspaceReadClearId(null);
		}
	}, [deferredWorkspaceReadClearId, selectedWorkspaceId]);

	const handleStartGithubIdentityConnect = useCallback(async () => {
		try {
			const flow = await startGithubIdentityConnect();
			setGithubIdentityState({
				status: "pending",
				flow,
			});
		} catch (error) {
			setGithubIdentityState({
				status: "error",
				message: describeUnknownError(
					error,
					"Unable to start GitHub account connection.",
				),
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
				pushWorkspaceToast(
					"The GitHub one-time code has been copied to your clipboard.",
					"Code copied",
					"default",
				);
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

	const handleResizeStart = (event: MouseEvent<HTMLDivElement>) => {
		event.preventDefault();
		setResizeState({
			pointerX: event.clientX,
			sidebarWidth,
		});
	};

	const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowLeft") {
			event.preventDefault();
			setSidebarWidth((currentWidth) =>
				clampSidebarWidth(currentWidth - SIDEBAR_RESIZE_STEP),
			);
		}

		if (event.key === "ArrowRight") {
			event.preventDefault();
			setSidebarWidth((currentWidth) =>
				clampSidebarWidth(currentWidth + SIDEBAR_RESIZE_STEP),
			);
		}
	};

	const reloadAfterPersist = async (
		ctxKey: string,
		sessId: string,
		wsId: string | null,
	) => {
		const [messages, detail, sessions, loadedGroups, loadedArchived] =
			await Promise.all([
				loadSessionMessages(sessId),
				wsId ? loadWorkspaceDetail(wsId) : null,
				wsId ? loadWorkspaceSessions(wsId) : [],
				loadWorkspaceGroups(),
				loadArchivedWorkspaces(),
			]);

		// Only update workspace-specific state if this workspace is still
		// the one the user is viewing. Prevents background stream completions
		// from overwriting the currently visible workspace.
		const isCurrentWorkspace = wsId && wsId === selectedWorkspaceId;
		const isCurrentSession = sessId === selectedSessionId;

		// Batch all state updates together so React commits them in a single
		// render pass. This prevents a flash where live messages are cleared
		// before DB messages appear (or vice versa).
		if (isCurrentSession) {
			setSessionMessages(messages);
		}
		// Clear live messages in the same render batch as setting DB messages
		setLiveMessagesByContext((current) => ({
			...current,
			[ctxKey]: [],
		}));
		if (isCurrentWorkspace) {
			setWorkspaceDetail(detail);
			setWorkspaceSessions(sessions);
		}
		// Groups and archived list are global — always update
		setGroups(loadedGroups);
		setArchivedSummaries(loadedArchived);
	};

	const handleCreateWorkspaceFromRepo = useCallback(
		async (repoId: string) => {
			if (
				addingRepository ||
				creatingWorkspaceRepoId ||
				archivingWorkspaceId ||
				restoringWorkspaceId ||
				markingUnreadWorkspaceId
			) {
				return;
			}

			setCreatingWorkspaceRepoId(repoId);

			try {
				const response = await createWorkspaceFromRepo(repoId);
				const { loadedGroups, loadedArchived } =
					await refreshWorkspaceNavigation();
				const nextWorkspaceId = hasWorkspaceId(
					response.selectedWorkspaceId,
					loadedGroups,
					loadedArchived,
				)
					? response.selectedWorkspaceId
					: (findInitialWorkspaceId(loadedGroups) ??
						loadedArchived[0]?.id ??
						null);

				await hydrateWorkspaceSelection(nextWorkspaceId);
			} catch (error) {
				pushWorkspaceToast(
					describeUnknownError(error, "Unable to create workspace."),
				);
			} finally {
				setCreatingWorkspaceRepoId(null);
				setLoadingWorkspace(false);
				setLoadingSession(false);
			}
		},
		[
			addingRepository,
			archivingWorkspaceId,
			creatingWorkspaceRepoId,
			hydrateWorkspaceSelection,
			markingUnreadWorkspaceId,
			pushWorkspaceToast,
			refreshWorkspaceNavigation,
			restoringWorkspaceId,
		],
	);

	const handleAddRepository = useCallback(async () => {
		if (
			addingRepository ||
			creatingWorkspaceRepoId ||
			archivingWorkspaceId ||
			restoringWorkspaceId ||
			markingUnreadWorkspaceId
		) {
			return;
		}

		setAddingRepository(true);

		try {
			const defaults = await loadAddRepositoryDefaults();
			const selection = await open({
				directory: true,
				multiple: false,
				defaultPath: defaults.lastCloneDirectory ?? undefined,
			});
			const selectedPath = Array.isArray(selection) ? selection[0] : selection;

			if (!selectedPath) {
				return;
			}

			const response = await addRepositoryFromLocalPath(selectedPath);
			const { loadedGroups, loadedArchived } =
				await refreshWorkspaceNavigation();
			const nextWorkspaceId = hasWorkspaceId(
				response.selectedWorkspaceId,
				loadedGroups,
				loadedArchived,
			)
				? response.selectedWorkspaceId
				: (findInitialWorkspaceId(loadedGroups) ??
					loadedArchived[0]?.id ??
					null);

			await hydrateWorkspaceSelection(nextWorkspaceId);
		} catch (error) {
			pushWorkspaceToast(
				describeUnknownError(error, "Unable to add repository."),
			);
		} finally {
			setAddingRepository(false);
			setLoadingWorkspace(false);
			setLoadingSession(false);
		}
	}, [
		addingRepository,
		archivingWorkspaceId,
		creatingWorkspaceRepoId,
		hydrateWorkspaceSelection,
		markingUnreadWorkspaceId,
		pushWorkspaceToast,
		refreshWorkspaceNavigation,
		restoringWorkspaceId,
	]);

	const handleModelSelect = async (modelId: string) => {
		const newModel = findModelOption(agentModelSections, modelId);
		const currentProvider = selectedModel?.provider ?? null;
		const newProvider = newModel?.provider ?? null;

		// If provider changed and the current session already has messages,
		// create a new session. Empty sessions can switch provider freely.
		const hasMessages = sessionMessages.length > 0;
		if (
			newProvider &&
			currentProvider &&
			newProvider !== currentProvider &&
			selectedSessionId &&
			selectedWorkspaceId &&
			hasMessages
		) {
			try {
				const { sessionId: newSessionId } =
					await createSession(selectedWorkspaceId);

				// Reload sessions list
				const sessions = await loadWorkspaceSessions(selectedWorkspaceId);
				setWorkspaceSessions(sessions);

				// Switch to the new session
				setSelectedSessionId(newSessionId);

				// Set model on the NEW session's context key
				const newContextKey = getComposerContextKey(
					selectedWorkspaceId,
					newSessionId,
				);
				setComposerModelSelections((current) => ({
					...current,
					[newContextKey]: modelId,
				}));
			} catch {
				// If session creation fails, just update model in current context
				setComposerModelSelections((current) => ({
					...current,
					[composerContextKey]: modelId,
				}));
			}
		} else {
			// Same provider or no session yet — just update model selection
			setComposerModelSelections((current) => ({
				...current,
				[composerContextKey]: modelId,
			}));
		}
	};

	const handleStopStream = useCallback(() => {
		const active = activeSessionByContext[composerContextKey];
		if (active) {
			void stopAgentStream(active.sessionId, active.provider);
		}
	}, [composerContextKey, activeSessionByContext]);

	const handleComposerSubmit = async (
		submittedPrompt: string,
		imagePaths: string[],
	) => {
		const prompt = submittedPrompt.trim();
		if (!prompt || !selectedModel) {
			return;
		}

		const contextKey = composerContextKey;
		const now = new Date().toISOString();
		const optimisticUserMessage = createLiveMessage({
			id: `${contextKey}:user:${Date.now()}`,
			sessionId: selectedSessionId ?? contextKey,
			role: "user",
			content: prompt,
			createdAt: now,
			model: selectedModel.id,
		});
		const previousLiveSession = liveSessionsByContext[contextKey];
		const sessionId =
			previousLiveSession?.provider === selectedModel.provider
				? (previousLiveSession.sessionId ?? undefined)
				: undefined;

		setLiveMessagesByContext((current) =>
			appendLiveMessage(current, contextKey, optimisticUserMessage),
		);
		setComposerRestoreState(null);
		setSendErrorsByContext((current) => ({ ...current, [contextKey]: null }));
		setSendingContextKeys((current) => ({ ...current, [contextKey]: true }));

		try {
			// Try streaming first, fall back to blocking
			const { streamId } = await startAgentMessageStream({
				provider: selectedModel.provider,
				modelId: selectedModel.id,
				prompt,
				sessionId,
				helmorSessionId: selectedSessionId,
				workingDirectory: workspaceDetail?.rootPath ?? null,
				effortLevel: currentEffortLevel,
				permissionMode: currentPermissionMode,
			});

			// Track session for stop functionality
			const sidecarSessionId = selectedSessionId ?? `tmp-${streamId}`;
			setActiveSessionByContext((current) => ({
				...current,
				[contextKey]: {
					sessionId: sidecarSessionId,
					provider: selectedModel.provider,
				},
			}));

			const accumulator = new StreamAccumulator();
			let unlistenFn: (() => void) | null = null;
			let frameId: number | null = null;

			const cleanup = () => {
				if (frameId !== null) {
					window.cancelAnimationFrame(frameId);
					frameId = null;
				}
				if (unlistenFn) {
					unlistenFn();
					unlistenFn = null;
				}
			};

			const flushStreamMessages = (immediate = false) => {
				frameId = null;
				const streamMessages = accumulator.toMessages(
					contextKey,
					selectedSessionId ?? contextKey,
				);
				const nextMessages = [optimisticUserMessage, ...streamMessages];
				const doFlush = () => {
					setLiveMessagesByContext((current) => {
						if (haveSameLiveMessages(current[contextKey], nextMessages)) {
							return current;
						}
						return {
							...current,
							[contextKey]: nextMessages,
						};
					});
				};
				// Use startTransition for intermediate flushes (lower priority).
				// Final flush (on "done") uses direct setState so it commits
				// before reloadAfterPersist clears live messages.
				if (immediate) {
					doFlush();
				} else {
					startTransition(doFlush);
				}
			};

			const scheduleFlush = () => {
				if (frameId !== null) return;
				frameId = window.requestAnimationFrame(() => flushStreamMessages());
			};

			unlistenFn = await listenAgentStream(streamId, (event) => {
				if (event.kind === "line") {
					accumulator.addLine(event.line);
					scheduleFlush();
					return;
				}

				if (event.kind === "done") {
					if (frameId !== null) {
						window.cancelAnimationFrame(frameId);
						frameId = null;
					}
					flushStreamMessages(true); // immediate — commit before reload
					cleanup();

					setLiveSessionsByContext((current) => ({
						...current,
						[contextKey]: {
							provider: event.provider,
							sessionId:
								event.sessionId ?? current[contextKey]?.sessionId ?? null,
						},
					}));

					if (event.persisted && selectedSessionId) {
						void reloadAfterPersist(
							contextKey,
							selectedSessionId,
							selectedWorkspaceId,
						);
					}

					setSendingContextKeys((current) => {
						const next = { ...current };
						delete next[contextKey];
						return next;
					});
					setActiveSessionByContext((current) => {
						const next = { ...current };
						delete next[contextKey];
						return next;
					});
					return;
				}

				if (event.kind === "error") {
					cleanup();
					setSendErrorsByContext((current) => ({
						...current,
						[contextKey]: event.message,
					}));
					setComposerRestoreState({
						contextKey,
						draft: prompt,
						images: imagePaths,
						nonce: Date.now(),
					});
					setLiveMessagesByContext((current) => ({
						...current,
						[contextKey]: (current[contextKey] ?? []).filter(
							(m) => m.id !== optimisticUserMessage.id,
						),
					}));
					setSendingContextKeys((current) => {
						const next = { ...current };
						delete next[contextKey];
						return next;
					});
					setActiveSessionByContext((current) => {
						const next = { ...current };
						delete next[contextKey];
						return next;
					});
				}
			});
		} catch (error) {
			const message = describeUnknownError(error, "Unable to send message.");
			setSendErrorsByContext((current) => ({
				...current,
				[contextKey]: message,
			}));
			setComposerRestoreState({
				contextKey,
				draft: prompt,
				images: imagePaths,
				nonce: Date.now(),
			});
			setLiveMessagesByContext((current) => ({
				...current,
				[contextKey]: (current[contextKey] ?? []).filter(
					(m) => m.id !== optimisticUserMessage.id,
				),
			}));
			setSendingContextKeys((current) => {
				const next = { ...current };
				delete next[contextKey];
				return next;
			});
			setActiveSessionByContext((current) => {
				const next = { ...current };
				delete next[contextKey];
				return next;
			});
		}
	};

	const handleArchiveWorkspace = useCallback(
		async (workspaceId: string) => {
			if (addingRepository || archivingWorkspaceId || restoringWorkspaceId) {
				return;
			}

			setArchivingWorkspaceId(workspaceId);

			try {
				await archiveWorkspace(workspaceId);
				const { loadedGroups, loadedArchived } =
					await refreshWorkspaceNavigation();
				const nextWorkspaceId =
					selectedWorkspaceId && selectedWorkspaceId !== workspaceId
						? hasWorkspaceId(selectedWorkspaceId, loadedGroups, loadedArchived)
							? selectedWorkspaceId
							: (findInitialWorkspaceId(loadedGroups) ??
								loadedArchived[0]?.id ??
								null)
						: (findInitialWorkspaceId(loadedGroups) ??
							loadedArchived[0]?.id ??
							null);

				await hydrateWorkspaceSelection(nextWorkspaceId);
			} catch (error) {
				pushWorkspaceToast(
					describeUnknownError(error, "Unable to archive workspace."),
				);
			} finally {
				setArchivingWorkspaceId(null);
				setLoadingWorkspace(false);
				setLoadingSession(false);
			}
		},
		[
			addingRepository,
			archivingWorkspaceId,
			hydrateWorkspaceSelection,
			pushWorkspaceToast,
			refreshWorkspaceNavigation,
			restoringWorkspaceId,
			selectedWorkspaceId,
		],
	);

	const handleMarkWorkspaceUnread = useCallback(
		async (workspaceId: string) => {
			if (
				addingRepository ||
				archivingWorkspaceId ||
				restoringWorkspaceId ||
				markingUnreadWorkspaceId
			) {
				return;
			}

			setMarkingUnreadWorkspaceId(workspaceId);

			try {
				await markWorkspaceUnread(workspaceId);

				if (selectedWorkspaceId === workspaceId) {
					setDeferredWorkspaceReadClearId(workspaceId);
				}

				await refreshWorkspaceNavigation();

				if (selectedWorkspaceId === workspaceId) {
					const [detail, sessions] = await Promise.all([
						loadWorkspaceDetail(workspaceId),
						loadWorkspaceSessions(workspaceId),
					]);

					setWorkspaceDetail(detail);
					setWorkspaceSessions(sessions);
				}
			} catch (error) {
				pushWorkspaceToast(
					describeUnknownError(error, "Unable to mark workspace as unread."),
				);
			} finally {
				setMarkingUnreadWorkspaceId(null);
			}
		},
		[
			addingRepository,
			archivingWorkspaceId,
			markingUnreadWorkspaceId,
			pushWorkspaceToast,
			refreshWorkspaceNavigation,
			restoringWorkspaceId,
			selectedWorkspaceId,
		],
	);

	const handleSelectWorkspace = useCallback(
		(workspaceId: string) => {
			setSelectedWorkspaceId(workspaceId);

			const selectedRow = findWorkspaceRowById(
				workspaceId,
				groups,
				archivedRows,
			);

			if (
				!selectedRow?.hasUnread ||
				deferredWorkspaceReadClearId === workspaceId ||
				markingReadWorkspaceId === workspaceId
			) {
				return;
			}

			setGroups((current) =>
				clearWorkspaceUnreadFromGroups(current, workspaceId),
			);
			setArchivedSummaries((current) =>
				clearWorkspaceUnreadFromSummaries(current, workspaceId),
			);
			setWorkspaceDetail((current) =>
				current?.id === workspaceId
					? {
							...current,
							hasUnread: false,
							workspaceUnread: 0,
							sessionUnreadTotal: 0,
							unreadSessionCount: 0,
						}
					: current,
			);

			setMarkingReadWorkspaceId(workspaceId);

			void (async () => {
				try {
					await markWorkspaceRead(workspaceId);
					await refreshSelectedWorkspaceCollections(workspaceId, null);
				} catch (error) {
					pushWorkspaceToast(
						describeUnknownError(error, "Unable to mark workspace as read."),
					);
					const [loadedGroups, loadedArchived] = await Promise.all([
						loadWorkspaceGroups(),
						loadArchivedWorkspaces(),
					]);
					setGroups(loadedGroups);
					setArchivedSummaries(loadedArchived);
				} finally {
					setMarkingReadWorkspaceId((current) =>
						current === workspaceId ? null : current,
					);
				}
			})();
		},
		[
			archivedRows,
			deferredWorkspaceReadClearId,
			groups,
			markingReadWorkspaceId,
			pushWorkspaceToast,
			refreshSelectedWorkspaceCollections,
		],
	);

	const handleRestoreWorkspace = useCallback(
		async (workspaceId: string) => {
			if (addingRepository || archivingWorkspaceId || restoringWorkspaceId) {
				return;
			}

			setRestoringWorkspaceId(workspaceId);

			try {
				const response = await restoreWorkspace(workspaceId);
				const { loadedGroups, loadedArchived } =
					await refreshWorkspaceNavigation();
				const nextWorkspaceId = hasWorkspaceId(
					response.selectedWorkspaceId,
					loadedGroups,
					loadedArchived,
				)
					? response.selectedWorkspaceId
					: (findInitialWorkspaceId(loadedGroups) ??
						loadedArchived[0]?.id ??
						null);

				await hydrateWorkspaceSelection(nextWorkspaceId);
			} catch (error) {
				pushWorkspaceToast(
					describeUnknownError(error, "Unable to restore workspace."),
				);
			} finally {
				setRestoringWorkspaceId(null);
				setLoadingWorkspace(false);
				setLoadingSession(false);
			}
		},
		[
			addingRepository,
			archivingWorkspaceId,
			hydrateWorkspaceSelection,
			pushWorkspaceToast,
			refreshWorkspaceNavigation,
			restoringWorkspaceId,
		],
	);

	return (
		<SettingsContext.Provider value={settingsContextValue}>
			<ToastProvider swipeDirection="right">
				{!isIdentityConnected ? (
					<GithubIdentityGate
						identityState={githubIdentityState}
						onConnectGithub={() => {
							void handleStartGithubIdentityConnect();
						}}
						onCopyGithubCode={(userCode) =>
							handleCopyGithubDeviceCode(userCode)
						}
						onCancelGithubConnect={handleCancelGithubIdentityConnect}
					/>
				) : (
					<main
						aria-label="Application shell"
						className="relative h-screen overflow-hidden bg-app-base font-sans text-app-foreground antialiased"
					>
						<div className="relative flex h-full min-h-0 bg-app-base">
							<aside
								aria-label="Workspace sidebar"
								className="relative h-full shrink-0 overflow-hidden bg-app-sidebar"
								style={{ width: `${sidebarWidth}px` }}
							>
								<WorkspacesSidebar
									groups={groups}
									archivedRows={archivedRows}
									availableRepositories={repositories}
									addingRepository={addingRepository}
									selectedWorkspaceId={selectedWorkspaceId}
									creatingWorkspaceRepoId={creatingWorkspaceRepoId}
									onAddRepository={() => {
										void handleAddRepository();
									}}
									onSelectWorkspace={handleSelectWorkspace}
									onCreateWorkspace={(repoId) => {
										void handleCreateWorkspaceFromRepo(repoId);
									}}
									onArchiveWorkspace={(workspaceId) => {
										void handleArchiveWorkspace(workspaceId);
									}}
									onMarkWorkspaceUnread={(workspaceId) => {
										void handleMarkWorkspaceUnread(workspaceId);
									}}
									onRestoreWorkspace={(workspaceId) => {
										void handleRestoreWorkspace(workspaceId);
									}}
									archivingWorkspaceId={archivingWorkspaceId}
									markingUnreadWorkspaceId={markingUnreadWorkspaceId}
									restoringWorkspaceId={restoringWorkspaceId}
								/>
								<div className="absolute bottom-3 left-3 z-20">
									<SettingsButton onClick={() => setSettingsOpen(true)} />
								</div>
							</aside>

							<div
								role="separator"
								tabIndex={0}
								aria-label="Resize sidebar"
								aria-orientation="vertical"
								aria-valuemin={MIN_SIDEBAR_WIDTH}
								aria-valuemax={MAX_SIDEBAR_WIDTH}
								aria-valuenow={sidebarWidth}
								onMouseDown={handleResizeStart}
								onKeyDown={handleResizeKeyDown}
								className="group absolute inset-y-0 z-30 cursor-ew-resize touch-none outline-none"
								style={{
									left: `${sidebarWidth - SIDEBAR_RESIZE_HIT_AREA / 2}px`,
									width: `${SIDEBAR_RESIZE_HIT_AREA}px`,
								}}
							>
								<span
									aria-hidden="true"
									className={`pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 transition-[width,background-color,box-shadow] ${
										isResizing
											? "w-[2px] bg-app-foreground/80 shadow-[0_0_12px_rgba(250,249,246,0.2)]"
											: "w-px bg-app-border group-hover:w-[2px] group-hover:bg-app-foreground-soft/75 group-hover:shadow-[0_0_10px_rgba(250,249,246,0.08)] group-focus-visible:w-[2px] group-focus-visible:bg-app-foreground-soft/75"
									}`}
								/>
							</div>

							<section
								aria-label="Workspace panel"
								className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-app-elevated"
							>
								<div
									aria-label="Workspace panel drag region"
									className="absolute inset-x-0 top-0 z-10 h-[2.6rem] bg-transparent"
									data-tauri-drag-region
								/>

								<div className="absolute right-4 top-[0.55rem] z-30 flex items-center gap-1">
									{conductorAvailable && (
										<button
											type="button"
											aria-label="Import from Conductor"
											onClick={() => setImportDialogOpen(true)}
											title="Import workspaces from Conductor"
											className="flex size-6 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground"
										>
											<Download className="size-3.5" strokeWidth={1.8} />
										</button>
									)}
									<button
										type="button"
										aria-label="Toggle theme"
										onClick={toggleTheme}
										className="flex size-6 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground"
									>
										{theme === "dark" ? (
											<Sun className="size-3.5" strokeWidth={1.8} />
										) : (
											<Moon className="size-3.5" strokeWidth={1.8} />
										)}
									</button>
									<GithubStatusMenu
										identityState={githubIdentityState}
										onDisconnectGithub={() => {
											void handleDisconnectGithubIdentity();
										}}
									/>
								</div>

								<div
									aria-label="Workspace viewport"
									className="flex min-h-0 flex-1 flex-col bg-white dark:bg-app-elevated"
								>
									<WorkspacePanel
										workspace={workspaceDetail}
										sessions={workspaceSessions}
										selectedSessionId={selectedSessionId}
										selectedProvider={selectedModel?.provider}
										messages={mergedMessages}
										attachments={sessionAttachments}
										loadingWorkspace={loadingWorkspace}
										loadingSession={loadingSession}
										sending={isSending}
										onSelectSession={setSelectedSessionId}
										onSessionsChanged={() => setDataVersion((v) => v + 1)}
										onSessionRenamed={(sessionId, title) => {
											setWorkspaceSessions((prev) =>
												prev.map((s) =>
													s.id === sessionId ? { ...s, title } : s,
												),
											);
										}}
										onWorkspaceChanged={() => {
											if (selectedWorkspaceId) {
												void refreshSelectedWorkspaceCollections(
													selectedWorkspaceId,
													selectedSessionId,
												);
											}
										}}
									/>

									<div className="mt-auto px-4 pb-4 pt-0">
										<SendingStatusBar active={isSending} />
										<div>
											<WorkspaceComposer
												key={composerContextKey}
												contextKey={composerContextKey}
												onSubmit={(prompt, imagePaths) => {
													void handleComposerSubmit(prompt, imagePaths);
												}}
												onStop={handleStopStream}
												sending={isSending}
												selectedModelId={selectedModelId}
												modelSections={agentModelSections}
												onSelectModel={(modelId) => {
													void handleModelSelect(modelId);
												}}
												provider={selectedModel?.provider}
												effortLevel={currentEffortLevel}
												onSelectEffort={(level) => {
													setComposerEffortLevels((c) => ({
														...c,
														[composerContextKey]: level,
													}));
												}}
												permissionMode={currentPermissionMode}
												onTogglePlanMode={() => {
													setComposerPermissionModes((c) => ({
														...c,
														[composerContextKey]:
															c[composerContextKey] === "plan"
																? "acceptEdits"
																: "plan",
													}));
												}}
												sendError={activeSendError}
												restoreDraft={
													composerRestoreState?.contextKey ===
													composerContextKey
														? composerRestoreState.draft
														: null
												}
												restoreImages={
													composerRestoreState?.contextKey ===
													composerContextKey
														? composerRestoreState.images
														: []
												}
												restoreNonce={
													composerRestoreState?.contextKey ===
													composerContextKey
														? composerRestoreState.nonce
														: 0
												}
											/>
										</div>
									</div>
								</div>
							</section>
						</div>
					</main>
				)}
				<ToastViewport />
				{workspaceToasts.map((toast) => (
					<Toast
						key={toast.id}
						open
						variant={toast.variant ?? "destructive"}
						duration={4200}
						onOpenChange={(open: boolean) => {
							if (!open) {
								dismissWorkspaceToast(toast.id);
							}
						}}
					>
						<div className="grid gap-1">
							<ToastTitle>{toast.title}</ToastTitle>
							<ToastDescription>{toast.description}</ToastDescription>
						</div>
						<ToastClose aria-label="Dismiss notification" />
					</Toast>
				))}
				<ConductorImportDialog
					open={importDialogOpen}
					onClose={() => setImportDialogOpen(false)}
					onImported={refreshAllData}
				/>
			</ToastProvider>
			<SettingsDialog
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
			/>
		</SettingsContext.Provider>
	);
}

const SendingStatusBar = memo(function SendingStatusBar({
	active,
}: {
	active: boolean;
}) {
	return (
		<div
			aria-hidden={!active}
			className={`overflow-hidden px-1 transition-none ${active ? "h-6 pb-1" : "h-0 pb-0"}`}
		>
			<div className="flex items-center py-1 text-[11px] font-medium">
				<ShimmerText className="text-[12px] text-app-muted">
					Thinking
				</ShimmerText>
			</div>
		</div>
	);
});

function findInitialWorkspaceId(groups: WorkspaceGroup[]): string | null {
	for (const group of groups) {
		if (group.rows.length > 0) {
			return group.rows[0].id;
		}
	}

	return null;
}

function hasWorkspaceId(
	workspaceId: string,
	groups: WorkspaceGroup[],
	archived: WorkspaceSummary[],
) {
	return (
		groups.some((group) => group.rows.some((row) => row.id === workspaceId)) ||
		archived.some((workspace) => workspace.id === workspaceId)
	);
}

function findWorkspaceRowById(
	workspaceId: string,
	groups: WorkspaceGroup[],
	archivedRows: WorkspaceRow[],
) {
	for (const group of groups) {
		const match = group.rows.find((row) => row.id === workspaceId);

		if (match) {
			return match;
		}
	}

	return archivedRows.find((row) => row.id === workspaceId) ?? null;
}

function clearWorkspaceUnreadFromRow(row: WorkspaceRow): WorkspaceRow {
	return {
		...row,
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
	};
}

function clearWorkspaceUnreadFromGroups(
	groups: WorkspaceGroup[],
	workspaceId: string,
): WorkspaceGroup[] {
	return groups.map((group) => ({
		...group,
		rows: group.rows.map((row) =>
			row.id === workspaceId ? clearWorkspaceUnreadFromRow(row) : row,
		),
	}));
}

function clearWorkspaceUnreadFromSummaries(
	summaries: WorkspaceSummary[],
	workspaceId: string,
): WorkspaceSummary[] {
	return summaries.map((summary) =>
		summary.id === workspaceId
			? {
					...summary,
					hasUnread: false,
					workspaceUnread: 0,
					sessionUnreadTotal: 0,
					unreadSessionCount: 0,
				}
			: summary,
	);
}

function summaryToArchivedRow(summary: WorkspaceSummary): WorkspaceRow {
	return {
		id: summary.id,
		title: summary.title,
		directoryName: summary.directoryName,
		repoName: summary.repoName,
		repoIconSrc: summary.repoIconSrc ?? null,
		repoInitials: summary.repoInitials ?? null,
		state: summary.state,
		hasUnread: summary.hasUnread,
		workspaceUnread: summary.workspaceUnread,
		sessionUnreadTotal: summary.sessionUnreadTotal,
		unreadSessionCount: summary.unreadSessionCount,
		derivedStatus: summary.derivedStatus,
		manualStatus: summary.manualStatus ?? null,
		branch: summary.branch ?? null,
		activeSessionId: summary.activeSessionId ?? null,
		activeSessionTitle: summary.activeSessionTitle ?? null,
		activeSessionAgentType: summary.activeSessionAgentType ?? null,
		activeSessionStatus: summary.activeSessionStatus ?? null,
		prTitle: summary.prTitle ?? null,
		sessionCount: summary.sessionCount,
		messageCount: summary.messageCount,
		attachmentCount: summary.attachmentCount,
	};
}

function getComposerContextKey(
	workspaceId: string | null,
	sessionId: string | null,
): string {
	if (sessionId) {
		return `session:${sessionId}`;
	}

	if (workspaceId) {
		return `workspace:${workspaceId}`;
	}

	return "global";
}

function inferDefaultModelId(
	session: WorkspaceSessionSummary | null,
	modelSections: AgentModelSection[],
): string {
	const preferredModelId = session?.model ?? null;
	if (preferredModelId && findModelOption(modelSections, preferredModelId)) {
		return preferredModelId;
	}

	return session?.agentType === "codex"
		? DEFAULT_CODEX_MODEL_ID
		: DEFAULT_CLAUDE_MODEL_ID;
}

function describeUnknownError(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim()) {
		return error.message;
	}

	if (typeof error === "string" && error.trim()) {
		return error;
	}

	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string" &&
		error.message.trim()
	) {
		return error.message;
	}

	try {
		const serialized = JSON.stringify(error);
		if (serialized && serialized !== "{}") {
			return serialized;
		}
	} catch {
		// Ignore serialization failures and fall through.
	}

	return fallback;
}

function findModelOption(
	modelSections: AgentModelSection[],
	modelId: string | null,
): AgentModelOption | null {
	if (!modelId) {
		return null;
	}

	return (
		modelSections
			.flatMap((section) => section.options)
			.find((option) => option.id === modelId) ?? null
	);
}

function createLiveMessage({
	id,
	sessionId,
	role,
	content,
	createdAt,
	model,
}: {
	id: string;
	sessionId: string;
	role: string;
	content: string;
	createdAt: string;
	model: string;
}): SessionMessageRecord {
	return {
		id,
		sessionId,
		role,
		content,
		contentIsJson: false,
		createdAt,
		sentAt: createdAt,
		cancelledAt: null,
		model,
		sdkMessageId: null,
		lastAssistantMessageId: null,
		turnId: null,
		isResumableMessage: null,
		attachmentCount: 0,
	};
}

function appendLiveMessage(
	current: Record<string, SessionMessageRecord[]>,
	contextKey: string,
	message: SessionMessageRecord,
) {
	return {
		...current,
		[contextKey]: [...(current[contextKey] ?? []), message],
	};
}

function haveSameLiveMessages(
	current: SessionMessageRecord[] | undefined,
	next: SessionMessageRecord[],
) {
	if (!current || current.length !== next.length) return false;

	return current.every((message, index) => {
		const nextMessage = next[index];
		return (
			message.id === nextMessage.id &&
			message.role === nextMessage.role &&
			message.content === nextMessage.content &&
			message.contentIsJson === nextMessage.contentIsJson &&
			message.createdAt === nextMessage.createdAt
		);
	});
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
	const title =
		identityState.status === "checking"
			? "Checking GitHub connection"
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
			: identityState.status === "pending"
				? "A browser window should open for authorization. If it does not, complete GitHub device sign-in with the code below."
				: identityState.status === "unconfigured"
					? identityState.message
					: identityState.status === "error"
						? identityState.message
						: "GitHub account connection is required before Helmor loads your workspaces.";

	const handleCopyCode = useCallback(async () => {
		if (identityState.status !== "pending") {
			return;
		}

		const copied = await onCopyGithubCode(identityState.flow.userCode);

		if (!copied) {
			return;
		}
	}, [identityState, onCopyGithubCode]);

	return (
		<main
			aria-label="GitHub identity gate"
			className="relative h-screen overflow-hidden bg-app-base font-sans text-app-foreground antialiased"
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
					<h1 className="text-center text-[40px] leading-[1.04] tracking-[-0.04em] text-app-foreground">
						{title}
					</h1>
					<p className="mx-auto mt-4 max-w-[31rem] text-center text-[16px] leading-7 text-app-foreground-soft/72">
						{description}
					</p>

					{identityState.status === "pending" ? (
						<div className="mt-8 flex flex-col items-center gap-5">
							<button
								type="button"
								onClick={() => {
									void handleCopyCode();
								}}
								className="rounded-2xl px-3 py-2 transition-colors hover:bg-app-toolbar-hover/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border-strong"
								aria-label="Copy one-time code"
								title="Copy one-time code"
							>
								<span className="font-mono text-[30px] tracking-[0.18em] text-app-foreground">
									{identityState.flow.userCode}
								</span>
							</button>
							<div className="flex flex-wrap items-center justify-center gap-3">
								<button
									type="button"
									onClick={onCancelGithubConnect}
									className="inline-flex items-center justify-center rounded-full px-4 py-2 text-[14px] font-medium text-app-foreground-soft/78 transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground"
								>
									Cancel
								</button>
							</div>
						</div>
					) : identityState.status === "unconfigured" ? (
						<div className="mt-8 flex justify-center">
							<button
								type="button"
								disabled
								className="inline-flex items-center gap-2 rounded-full bg-[#353534] px-4 py-2 text-[14px] font-medium text-app-foreground/55 opacity-70"
							>
								<MarkGithubIcon size={16} />
								Continue with GitHub
							</button>
						</div>
					) : identityState.status === "checking" ? (
						<div className="mt-8 inline-flex w-full items-center justify-center gap-2 text-[14px] text-app-foreground-soft/76">
							<RefreshCw className="size-4 animate-spin" strokeWidth={1.8} />
							Restoring your last session
						</div>
					) : (
						<div className="mt-8 flex justify-center">
							<button
								type="button"
								onClick={onConnectGithub}
								className="inline-flex items-center gap-2 rounded-full bg-[#353534] px-4 py-2 text-[14px] font-medium text-app-foreground transition-colors hover:bg-[#424240]"
							>
								<MarkGithubIcon size={16} />
								{identityState.status === "error"
									? "Retry with GitHub"
									: "Continue with GitHub"}
							</button>
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
				className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-app-muted transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground"
			>
				<Avatar size="sm" className="size-4">
					{identitySession?.avatarUrl ? (
						<AvatarImage
							src={identitySession.avatarUrl}
							alt={identitySession.login}
						/>
					) : null}
					<AvatarFallback className="bg-app-toolbar text-[9px] font-medium text-app-foreground-soft">
						{identitySession?.login.slice(0, 2).toUpperCase() ?? "GH"}
					</AvatarFallback>
				</Avatar>
				<span className="text-[12px] font-medium text-app-foreground-soft/74">
					{triggerLabel}
				</span>
			</DropdownMenuTrigger>

			<DropdownMenuContent
				align="end"
				sideOffset={8}
				className="w-44 rounded-[14px] border border-app-border bg-app-sidebar p-1.5 text-app-foreground shadow-[0_18px_48px_rgba(0,0,0,0.38)]"
			>
				<DropdownMenuItem
					className="rounded-[10px] px-2 py-2 text-app-foreground-soft hover:bg-app-row-hover focus:bg-app-row-hover"
					onClick={onDisconnectGithub}
				>
					Log out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export default App;
