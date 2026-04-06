import "./App.css";
import { MarkGithubIcon } from "@primer/octicons-react";
import {
	QueryClientProvider,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	Check,
	ChevronDown,
	Copy,
	ExternalLink,
	FolderInput,
	Moon,
	RefreshCw,
	Sun,
} from "lucide-react";
import {
	type KeyboardEvent,
	type MouseEvent,
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
import { Button } from "./components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import {
	Toast,
	ToastClose,
	ToastDescription,
	ToastProvider,
	ToastTitle,
	ToastViewport,
} from "./components/ui/toast";
import { WorkspaceConversationContainer } from "./components/workspace-conversation-container";
import { WorkspaceInspectorSidebar } from "./components/workspace-inspector-sidebar";
import { WorkspacesSidebarContainer } from "./components/workspaces-sidebar-container";
import {
	cancelGithubIdentityConnect,
	type DetectedEditor,
	detectInstalledEditors,
	disconnectGithubIdentity,
	type GithubIdentityDeviceFlowStart,
	type GithubIdentitySnapshot,
	hasTauriRuntime,
	isConductorAvailable,
	listenGithubIdentityChanged,
	loadGithubIdentitySession,
	openWorkspaceInEditor,
	startGithubIdentityConnect,
	type WorkspaceDetail,
	type WorkspaceGroup,
	type WorkspaceRow,
	type WorkspaceSessionSummary,
} from "./lib/api";
import { shouldTrackDevCacheStats } from "./lib/dev-render-debug";
import {
	archivedWorkspacesQueryOptions,
	createHelmorQueryClient,
	helmorQueryKeys,
	sessionMessagesQueryOptions,
	workspaceDetailQueryOptions,
	workspaceGroupsQueryOptions,
	workspaceSessionsQueryOptions,
} from "./lib/query-client";
import {
	type AppSettings,
	DEFAULT_SETTINGS,
	loadSettings,
	SettingsContext,
	saveSettings,
} from "./lib/settings";
import {
	describeUnknownError,
	summaryToArchivedRow,
} from "./lib/workspace-helpers";

const SIDEBAR_WIDTH_STORAGE_KEY = "helmor.workspaceSidebarWidth";
const INSPECTOR_WIDTH_STORAGE_KEY = "helmor.workspaceInspectorWidth";
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

type WorkspaceToast = {
	id: string;
	title: string;
	description: string;
	variant?: "default" | "destructive";
	action?: {
		label: string;
		onClick: () => void;
		destructive?: boolean;
	};
	/** If true, toast stays until manually dismissed (no auto-close) */
	persistent?: boolean;
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
	if (!hasTauriRuntime()) {
		return {
			status: "connected",
			session: BROWSER_DEV_GITHUB_IDENTITY_SESSION,
		};
	}

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
			<QueryClientProvider client={queryClient}>
				<AppShell onOpenSettings={() => setSettingsOpen(true)} />
			</QueryClientProvider>
			<SettingsDialog
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
			/>
		</SettingsContext.Provider>
	);
}

function AppShell({ onOpenSettings }: { onOpenSettings: () => void }) {
	const queryClient = useQueryClient();
	const workspaceSelectionRequestRef = useRef(0);
	const sessionSelectionRequestRef = useRef(0);
	const startupPrefetchedWorkspaceRef = useRef<string | null>(null);
	const selectedWorkspaceIdRef = useRef<string | null>(null);
	const selectedSessionIdRef = useRef<string | null>(null);
	const [githubIdentityState, setGithubIdentityState] =
		useState<GithubIdentityState>(getInitialGithubIdentityState);
	const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
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
	const [workspaceToasts, setWorkspaceToasts] = useState<WorkspaceToast[]>([]);
	const [sendingWorkspaceIds, setSendingWorkspaceIds] = useState<Set<string>>(
		() => new Set(),
	);

	const [theme, setTheme] = useState<"light" | "dark">(() => {
		if (typeof window === "undefined") return "dark";
		return (localStorage.getItem("helmor.theme") as "light" | "dark") ?? "dark";
	});
	const [conductorAvailable, setConductorAvailable] = useState(false);
	const [installedEditors, setInstalledEditors] = useState<DetectedEditor[]>(
		[],
	);
	const [preferredEditorId, setPreferredEditorId] = useState<string | null>(
		null,
	);
	const preferredEditor =
		installedEditors.find((e) => e.id === preferredEditorId) ??
		installedEditors[0] ??
		null;
	const [importDialogOpen, setImportDialogOpen] = useState(false);
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

	useEffect(() => {
		void isConductorAvailable().then(setConductorAvailable);
		void detectInstalledEditors().then(setInstalledEditors);
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
			opts?: {
				action?: WorkspaceToast["action"];
				persistent?: boolean;
			},
		) => {
			setWorkspaceToasts((current) => [
				...current,
				{
					id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					title,
					description,
					variant,
					action: opts?.action,
					persistent: opts?.persistent,
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
		selectedWorkspaceIdRef.current = null;
		selectedSessionIdRef.current = null;
		setSelectedWorkspaceId(null);
		setDisplayedWorkspaceId(null);
		setSelectedSessionId(null);
		setDisplayedSessionId(null);
	}, []);

	useEffect(() => {
		selectedWorkspaceIdRef.current = selectedWorkspaceId;
	}, [selectedWorkspaceId]);

	useEffect(() => {
		selectedSessionIdRef.current = selectedSessionId;
	}, [selectedSessionId]);

	useEffect(() => {
		document.documentElement.classList.toggle("dark", theme === "dark");
	}, [theme]);

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

		const handleMouseMove = (event: globalThis.MouseEvent) => {
			const deltaX = event.clientX - resizeState.pointerX;
			const nextWidth =
				resizeState.target === "sidebar"
					? resizeState.sidebarWidth + deltaX
					: resizeState.sidebarWidth - deltaX;

			if (resizeState.target === "sidebar") {
				setSidebarWidth(clampSidebarWidth(nextWidth));
				return;
			}

			setInspectorWidth(clampSidebarWidth(nextWidth));
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

	const handleResizeStart =
		(target: "sidebar" | "inspector") =>
		(event: MouseEvent<HTMLDivElement>) => {
			event.preventDefault();
			setResizeState({
				pointerX: event.clientX,
				sidebarWidth: target === "sidebar" ? sidebarWidth : inspectorWidth,
				target,
			});
		};

	const handleResizeKeyDown =
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
		};

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
					sessionMessagesQueryOptions(resolvedSessionId),
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
				queryClient.getQueryData(helmorQueryKeys.sessionMessages(sessionId)) !==
					undefined;

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

	const handleSelectWorkspace = useCallback(
		(workspaceId: string | null) => {
			if (workspaceId === selectedWorkspaceIdRef.current) {
				return;
			}

			const requestId = workspaceSelectionRequestRef.current + 1;
			workspaceSelectionRequestRef.current = requestId;
			sessionSelectionRequestRef.current += 1;
			selectedWorkspaceIdRef.current = workspaceId;
			selectedSessionIdRef.current = null;
			setSelectedWorkspaceId(workspaceId);
			setSelectedSessionId(null);
			if (workspaceId === null) {
				startTransition(() => {
					if (workspaceSelectionRequestRef.current !== requestId) {
						return;
					}

					setDisplayedWorkspaceId(null);
					setDisplayedSessionId(null);
				});
				return;
			}

			const cachedWorkspaceDisplay = resolveCachedWorkspaceDisplay(workspaceId);
			if (cachedWorkspaceDisplay) {
				selectedSessionIdRef.current = cachedWorkspaceDisplay.sessionId;
				setSelectedSessionId(cachedWorkspaceDisplay.sessionId);
				startTransition(() => {
					if (workspaceSelectionRequestRef.current !== requestId) {
						return;
					}

					setDisplayedWorkspaceId(cachedWorkspaceDisplay.workspaceId);
					setDisplayedSessionId(cachedWorkspaceDisplay.sessionId);
				});
				void queryClient.prefetchQuery(
					workspaceDetailQueryOptions(workspaceId),
				);
				void queryClient.prefetchQuery(
					workspaceSessionsQueryOptions(workspaceId),
				);
				if (cachedWorkspaceDisplay.sessionId) {
					void queryClient.prefetchQuery(
						sessionMessagesQueryOptions(cachedWorkspaceDisplay.sessionId),
					);
				}
				return;
			}

			void primeWorkspaceDisplay(workspaceId)
				.then(({ sessionId }) => {
					if (workspaceSelectionRequestRef.current !== requestId) {
						return;
					}

					startTransition(() => {
						if (workspaceSelectionRequestRef.current !== requestId) {
							return;
						}

						selectedSessionIdRef.current = sessionId;
						setSelectedSessionId(sessionId);
						setDisplayedWorkspaceId(workspaceId);
						setDisplayedSessionId(sessionId);
					});
				})
				.catch(() => {
					if (workspaceSelectionRequestRef.current !== requestId) {
						return;
					}

					startTransition(() => {
						if (workspaceSelectionRequestRef.current !== requestId) {
							return;
						}

						setDisplayedWorkspaceId(workspaceId);
						setDisplayedSessionId(null);
					});
				});
		},
		[primeWorkspaceDisplay, queryClient, resolveCachedWorkspaceDisplay],
	);

	const handleSelectSession = useCallback(
		(sessionId: string | null) => {
			if (sessionId === selectedSessionIdRef.current) {
				return;
			}

			const requestId = sessionSelectionRequestRef.current + 1;
			sessionSelectionRequestRef.current = requestId;
			selectedSessionIdRef.current = sessionId;
			setSelectedSessionId(sessionId);
			if (sessionId === null) {
				startTransition(() => {
					if (sessionSelectionRequestRef.current !== requestId) {
						return;
					}

					setDisplayedSessionId(null);
				});
				return;
			}

			if (
				queryClient.getQueryData(helmorQueryKeys.sessionMessages(sessionId)) !==
				undefined
			) {
				startTransition(() => {
					if (sessionSelectionRequestRef.current !== requestId) {
						return;
					}

					setDisplayedSessionId(sessionId);
				});
				void queryClient.prefetchQuery(sessionMessagesQueryOptions(sessionId));
				return;
			}

			void queryClient
				.ensureQueryData(sessionMessagesQueryOptions(sessionId))
				.then(() => {
					if (sessionSelectionRequestRef.current !== requestId) {
						return;
					}

					startTransition(() => {
						if (sessionSelectionRequestRef.current !== requestId) {
							return;
						}

						setDisplayedSessionId(sessionId);
					});
				})
				.catch(() => {
					if (sessionSelectionRequestRef.current !== requestId) {
						return;
					}

					startTransition(() => {
						if (sessionSelectionRequestRef.current !== requestId) {
							return;
						}

						setDisplayedSessionId(sessionId);
					});
				});
		},
		[queryClient],
	);

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
			selectedSessionIdRef.current = sessionId;
			setSelectedSessionId((current) =>
				current === sessionId ? current : sessionId,
			);
			startTransition(() => {
				setDisplayedSessionId((current) =>
					current === sessionId ? current : sessionId,
				);
			});
		},
		[],
	);

	const handleImportedFromConductor = useCallback(() => {
		void Promise.all([
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			}),
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.archivedWorkspaces,
			}),
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.repositories,
			}),
			displayedWorkspaceId
				? queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(displayedWorkspaceId),
					})
				: Promise.resolve(),
			displayedWorkspaceId
				? queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceSessions(displayedWorkspaceId),
					})
				: Promise.resolve(),
			displayedSessionId
				? queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.sessionMessages(displayedSessionId),
					})
				: Promise.resolve(),
		]);
	}, [displayedSessionId, displayedWorkspaceId, queryClient]);

	useEffect(() => {
		if (!isIdentityConnected) {
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
	}, [handleNavigateSessions, handleNavigateWorkspaces, isIdentityConnected]);

	return (
		<ToastProvider swipeDirection="right">
			{!isIdentityConnected ? (
				<GithubIdentityGate
					identityState={githubIdentityState}
					onConnectGithub={() => {
						void handleStartGithubIdentityConnect();
					}}
					onCopyGithubCode={(userCode) => handleCopyGithubDeviceCode(userCode)}
					onCancelGithubConnect={handleCancelGithubIdentityConnect}
				/>
			) : (
				<main
					aria-label="Application shell"
					className="relative h-screen overflow-hidden bg-app-base font-sans text-app-foreground antialiased"
				>
					<div className="relative flex h-full min-h-0 bg-app-sidebar">
						<aside
							aria-label="Workspace sidebar"
							className="relative h-full shrink-0 overflow-hidden bg-app-sidebar"
							style={{ width: `${sidebarWidth}px` }}
						>
							<WorkspacesSidebarContainer
								selectedWorkspaceId={selectedWorkspaceId}
								sendingWorkspaceIds={sendingWorkspaceIds}
								onSelectWorkspace={handleSelectWorkspace}
								pushWorkspaceToast={pushWorkspaceToast}
							/>
							<div className="absolute bottom-3 left-3 z-20">
								<SettingsButton onClick={onOpenSettings} />
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
										? "w-[2px] bg-app-foreground/80 shadow-[0_0_12px_rgba(250,249,246,0.2)]"
										: "w-px bg-app-border group-hover:w-[2px] group-hover:bg-app-foreground-soft/75 group-hover:shadow-[0_0_10px_rgba(250,249,246,0.08)] group-focus-visible:w-[2px] group-focus-visible:bg-app-foreground-soft/75"
								}`}
							/>
						</div>

						<section
							aria-label="Workspace panel"
							className="relative my-1 mr-1 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-app-elevated"
						>
							<div
								aria-label="Workspace panel drag region"
								className="absolute inset-x-0 top-0 z-10 h-[2.6rem] bg-transparent"
								data-tauri-drag-region
							/>

							<div className="absolute right-4 top-[0.55rem] z-30 flex items-center gap-1">
								{selectedWorkspaceId &&
									installedEditors.length > 0 &&
									preferredEditor && (
										<div className="flex items-center rounded-md border border-app-border/40 bg-app-elevated/50">
											<button
												type="button"
												aria-label={`Open in ${preferredEditor.name}`}
												title={`Open in ${preferredEditor.name}`}
												onClick={() =>
													void openWorkspaceInEditor(
														selectedWorkspaceId,
														preferredEditor.id as "cursor" | "vscode",
													).catch((e) =>
														pushWorkspaceToast(
															String(e),
															`Failed to open ${preferredEditor.name}`,
														),
													)
												}
												className="flex size-6 items-center justify-center rounded-l-[5px] text-app-muted transition-colors hover:bg-app-foreground/[0.07] hover:text-app-foreground focus-visible:outline-none"
											>
												<EditorIcon
													editorId={preferredEditor.id}
													className="size-3.5"
												/>
											</button>
											<DropdownMenu>
												<DropdownMenuTrigger className="flex h-6 w-4 items-center justify-center rounded-r-[5px] border-l border-app-border/40 text-app-muted transition-colors hover:bg-app-foreground/[0.07] hover:text-app-foreground focus-visible:outline-none">
													<ChevronDown className="size-2.5" strokeWidth={2} />
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
																void openWorkspaceInEditor(
																	selectedWorkspaceId,
																	editor.id as "cursor" | "vscode",
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
																className="size-4 shrink-0"
															/>
															<span className="font-medium">{editor.name}</span>
															{editor.id === preferredEditor.id && (
																<Check className="ml-auto size-3.5 text-app-foreground-soft" />
															)}
														</DropdownMenuItem>
													))}
												</DropdownMenuContent>
											</DropdownMenu>
										</div>
									)}
								{conductorAvailable && (
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label="Import from Conductor"
										onClick={() => setImportDialogOpen(true)}
										title="Import workspaces from Conductor"
										className="text-app-muted hover:text-app-foreground"
									>
										<FolderInput className="size-3.5" strokeWidth={1.8} />
									</Button>
								)}
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label="Toggle theme"
									onClick={toggleTheme}
									className="text-app-muted hover:text-app-foreground"
								>
									{theme === "dark" ? (
										<Sun className="size-3.5" strokeWidth={1.8} />
									) : (
										<Moon className="size-3.5" strokeWidth={1.8} />
									)}
								</Button>
								<GithubStatusMenu
									identityState={githubIdentityState}
									onDisconnectGithub={() => {
										void handleDisconnectGithubIdentity();
									}}
								/>
							</div>

							<div
								aria-label="Workspace viewport"
								className="flex min-h-0 flex-1 flex-col bg-app-elevated"
							>
								<WorkspaceConversationContainer
									selectedWorkspaceId={selectedWorkspaceId}
									displayedWorkspaceId={displayedWorkspaceId}
									selectedSessionId={selectedSessionId}
									displayedSessionId={displayedSessionId}
									onSelectSession={handleSelectSession}
									onResolveDisplayedSession={handleResolveDisplayedSession}
									onSendingWorkspacesChange={setSendingWorkspaceIds}
								/>
							</div>
							<ChatCacheDebugHud />
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
										? "w-[2px] bg-app-foreground/80 shadow-[0_0_12px_rgba(250,249,246,0.2)]"
										: "w-px bg-app-border group-hover:w-[2px] group-hover:bg-app-foreground-soft/75 group-hover:shadow-[0_0_10px_rgba(250,249,246,0.08)] group-focus-visible:w-[2px] group-focus-visible:bg-app-foreground-soft/75"
								}`}
							/>
						</div>

						<aside
							aria-label="Inspector sidebar"
							className="relative h-full shrink-0 overflow-hidden bg-app-sidebar"
							style={{ width: `${inspectorWidth}px` }}
						>
							<WorkspaceInspectorSidebar />
						</aside>
					</div>
				</main>
			)}
			<ToastViewport />
			{workspaceToasts.map((toast) => (
				<Toast
					key={toast.id}
					open
					variant={toast.variant ?? "destructive"}
					duration={toast.persistent ? 999999999 : 4200}
					onOpenChange={(open: boolean) => {
						if (!open) {
							dismissWorkspaceToast(toast.id);
						}
					}}
					className={
						toast.action
							? "flex-col items-stretch gap-0 rounded-xl border border-app-border bg-app-sidebar p-0 shadow-xl"
							: undefined
					}
				>
					{toast.action ? (
						<>
							<div className="px-4 pt-4 pb-3">
								<ToastTitle className="text-[13px] font-semibold text-app-foreground">
									{toast.title}
								</ToastTitle>
								<ToastDescription className="mt-1.5 text-[12px] leading-relaxed text-app-muted">
									{toast.description}
								</ToastDescription>
							</div>
							<div className="flex items-center justify-end gap-2 border-t border-app-border/50 px-3 py-2.5">
								<button
									type="button"
									onClick={() => dismissWorkspaceToast(toast.id)}
									className="rounded-md px-3 py-1.5 text-[12px] font-medium text-app-foreground-soft transition-colors hover:bg-app-foreground/[0.06]"
								>
									Dismiss
								</button>
								<button
									type="button"
									onClick={() => {
										toast.action?.onClick();
										dismissWorkspaceToast(toast.id);
									}}
									className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
										toast.action.destructive
											? "bg-red-500 text-white hover:bg-red-600"
											: "bg-app-foreground/10 text-app-foreground hover:bg-app-foreground/20"
									}`}
								>
									{toast.action.label}
								</button>
							</div>
							<ToastClose
								aria-label="Dismiss notification"
								className="absolute right-2 top-2"
							/>
						</>
					) : (
						<>
							<div className="grid gap-1">
								<ToastTitle>{toast.title}</ToastTitle>
								<ToastDescription>{toast.description}</ToastDescription>
							</div>
							<ToastClose aria-label="Dismiss notification" />
						</>
					)}
				</Toast>
			))}
			<ConductorImportDialog
				open={importDialogOpen}
				onClose={() => setImportDialogOpen(false)}
				onImported={handleImportedFromConductor}
			/>
		</ToastProvider>
	);
}

function EditorIcon({
	editorId,
	className,
}: {
	editorId: string;
	className?: string;
}) {
	if (editorId === "cursor") {
		return (
			<svg
				className={className}
				viewBox="0 0 466.73 532.09"
				fill="currentColor"
			>
				<path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
			</svg>
		);
	}
	if (editorId === "vscode") {
		return (
			<svg className={className} viewBox="0 0 24 24" fill="currentColor">
				<path d="M17.58 2.39L10 9.43 4.64 5.42 2 6.76v10.48l2.64 1.34L10 14.57l7.58 7.04L22 19.33V4.67l-4.42-2.28zM4.64 15.36V8.64L7.93 12l-3.29 3.36zM17.58 17.6l-5.37-5.6 5.37-5.6v11.2z" />
			</svg>
		);
	}
	// Fallback: generic external link icon
	return <ExternalLink className={className} strokeWidth={1.8} />;
}

function ChatCacheDebugHud() {
	const [tick, setTick] = useState(0);

	useEffect(() => {
		if (!shouldTrackDevCacheStats() || typeof window === "undefined") {
			return;
		}

		const intervalId = window.setInterval(() => {
			setTick((current) => current + 1);
		}, 750);

		return () => {
			window.clearInterval(intervalId);
		};
	}, []);

	if (!shouldTrackDevCacheStats() || typeof window === "undefined") {
		return null;
	}

	const snapshot = window.__HELMOR_DEV_CACHE_STATS__?.latest;

	if (!snapshot) {
		return (
			<div className="pointer-events-none absolute bottom-4 right-4 z-40 w-56 rounded-[14px] border border-app-border/70 bg-app-sidebar/92 px-3 py-2 text-[11px] text-app-muted shadow-[0_12px_32px_rgba(0,0,0,0.28)] backdrop-blur-sm">
				<div className="text-[10px] uppercase tracking-[0.18em] text-app-muted/70">
					Cache Debug
				</div>
				<div className="mt-1">Waiting for chat cache stats…</div>
			</div>
		);
	}

	const heapUsed = snapshot.heapStats
		? formatBytes(snapshot.heapStats.usedJSHeapSize)
		: "n/a";
	const heapTotal = snapshot.heapStats
		? formatBytes(snapshot.heapStats.totalJSHeapSize)
		: "n/a";
	const retainedBytes = formatBytes(snapshot.totalEstimatedMessageBytes);
	const retainedMessages = snapshot.totalRetainedMessages.toLocaleString();
	const queryMessages =
		snapshot.querySessionMessageDataMessages.toLocaleString();
	const sessionLine = snapshot.visibleSessionId
		? snapshot.visibleSessionId
		: "none";
	void tick;

	return (
		<div className="absolute bottom-4 right-4 z-40 w-64 rounded-[14px] border border-app-border/70 bg-app-sidebar/92 px-3 py-3 text-[11px] text-app-foreground shadow-[0_12px_32px_rgba(0,0,0,0.28)] backdrop-blur-sm">
			<div className="flex items-center justify-between gap-2">
				<div className="text-[10px] uppercase tracking-[0.18em] text-app-muted/70">
					Cache Debug
				</div>
				<div className="truncate text-[10px] text-app-muted">{sessionLine}</div>
			</div>

			<div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-app-foreground-soft">
				<DebugMetric
					label="Hot"
					value={`${snapshot.hotPaneCount}/${snapshot.paneLimit}`}
				/>
				<DebugMetric label="Warm" value={String(snapshot.warmEntryCount)} />
				<DebugMetric label="Retained" value={retainedMessages} />
				<DebugMetric label="Retained MB" value={retainedBytes} />
				<DebugMetric
					label="Query sessions"
					value={String(snapshot.querySessionMessageCount)}
				/>
				<DebugMetric label="Query msgs" value={queryMessages} />
				<DebugMetric
					label="Observers"
					value={String(snapshot.querySessionMessageObserverCount)}
				/>
				<DebugMetric label="Heap" value={`${heapUsed} / ${heapTotal}`} />
			</div>

			<div className="mt-3 flex items-center gap-2">
				<button
					type="button"
					onClick={() => {
						window.__HELMOR_DEV_CACHE_STATS__?.printLatest();
					}}
					className="rounded-full bg-app-toolbar px-2.5 py-1 text-[10px] font-medium text-app-foreground-soft transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground"
				>
					Print
				</button>
				<button
					type="button"
					onClick={() => {
						window.__HELMOR_DEV_CACHE_STATS__?.resetHistory();
						setTick((current) => current + 1);
					}}
					className="rounded-full bg-app-toolbar px-2.5 py-1 text-[10px] font-medium text-app-foreground-soft transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground"
				>
					Reset
				</button>
			</div>
		</div>
	);
}

function DebugMetric({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<div className="text-[10px] uppercase tracking-[0.14em] text-app-muted/60">
				{label}
			</div>
			<div className="truncate text-[11px] text-app-foreground">{value}</div>
		</div>
	);
}

function formatBytes(bytes: number) {
	const megabytes = bytes / (1024 * 1024);
	return `${megabytes.toFixed(megabytes >= 100 ? 0 : 1)} MB`;
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
									void handleCopyCodeThenRedirect();
								}}
								disabled={codeCopied}
								className="relative rounded-2xl px-5 py-3 transition-colors hover:bg-app-toolbar-hover/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border-strong"
								aria-label="Copy one-time code"
								title="Copy one-time code"
							>
								<span className="font-mono text-[30px] tracking-[0.18em] text-app-foreground">
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
											className="size-4 text-app-foreground/40"
											strokeWidth={1.8}
										/>
									)}
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
