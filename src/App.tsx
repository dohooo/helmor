import "./App.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import {
	Check,
	ChevronDown,
	PanelLeftClose,
	PanelLeftOpen,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWorkspaceCommitLifecycle } from "@/features/commit/hooks/use-commit-lifecycle";
import { WorkspaceConversationContainer } from "@/features/conversation";
import { WorkspaceEditorSurface } from "@/features/editor";
import { WorkspaceInspectorSidebar } from "@/features/inspector";
import { WorkspacesSidebarContainer } from "@/features/navigation/container";
import { SettingsButton, SettingsDialog } from "@/features/settings";
import { EditorIcon } from "@/shell/editor-icon";
import { GithubIdentityGate } from "@/shell/github-identity-gate";
import { GithubStatusMenu } from "@/shell/github-status-menu";
import { useGithubIdentity } from "@/shell/hooks/use-github-identity";
import { useShellPanels } from "@/shell/hooks/use-panels";
import {
	findAdjacentSessionId,
	findAdjacentWorkspaceId,
	flattenWorkspaceRows,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	PREFERRED_EDITOR_STORAGE_KEY,
	SIDEBAR_RESIZE_HIT_AREA,
} from "@/shell/layout";
import {
	type DetectedEditor,
	detectInstalledEditors,
	drainPendingCliSends,
	listenGitBranchChanged,
	listenGitRefsChanged,
	openWorkspaceInEditor,
	prefetchRemoteRefs,
	setWorkspaceManualStatus,
	type WorkspaceDetail,
	type WorkspaceSessionSummary,
} from "./lib/api";
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
import { summaryToArchivedRow } from "./lib/workspace-helpers";
import {
	type WorkspaceToastOptions,
	WorkspaceToastProvider,
} from "./lib/workspace-toast-context";

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
	const {
		githubIdentityState,
		handleCancelGithubIdentityConnect,
		handleCopyGithubDeviceCode,
		handleDisconnectGithubIdentity,
		handleStartGithubOAuthRedirect,
		isIdentityConnected,
	} = useGithubIdentity(pushWorkspaceToast);
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

	// Clear the completed-session dot for whichever session the user
	// is actually viewing. This fires on workspace switches (where the
	// default session resolves through cache or async prime) and on
	// direct session tab clicks alike.
	useEffect(() => {
		if (!displayedSessionId) return;
		setCompletedSessions((prev) => {
			if (!prev.has(displayedSessionId)) return prev;
			const next = new Map(prev);
			next.delete(displayedSessionId);
			return next;
		});
	}, [displayedSessionId]);

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

	// Reactively transition workspace sidebar status when the PR query
	// detects a state change. Handles PRs created/merged/closed externally.
	const selectedWorkspaceManualStatus =
		selectedWorkspaceDetailQuery.data?.manualStatus ?? null;
	const selectedWorkspaceState =
		selectedWorkspaceDetailQuery.data?.state ?? null;
	const prStatusSyncRef = useRef<string | null>(null);
	useEffect(() => {
		if (!selectedWorkspaceId || !workspacePrInfo) {
			prStatusSyncRef.current = null;
			return;
		}
		if (
			selectedWorkspaceState !== "active" &&
			selectedWorkspaceState !== "ready"
		) {
			return;
		}

		let targetStatus: string | null = null;
		if (workspacePrInfo.isMerged) {
			targetStatus = "done";
		} else if (workspacePrInfo.state === "OPEN") {
			targetStatus = "review";
		} else if (workspacePrInfo.state === "CLOSED") {
			targetStatus = "canceled";
		}

		if (!targetStatus) return;
		if (selectedWorkspaceManualStatus === targetStatus) return;

		const syncKey = `${selectedWorkspaceId}:${targetStatus}`;
		if (prStatusSyncRef.current === syncKey) return;
		prStatusSyncRef.current = syncKey;

		void (async () => {
			try {
				await setWorkspaceManualStatus(selectedWorkspaceId, targetStatus);
				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceGroups,
					}),
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(selectedWorkspaceId),
					}),
				]);
			} catch (error) {
				console.error("[prStatusSync] Failed:", error);
			}
		})();
	}, [
		selectedWorkspaceId,
		workspacePrInfo,
		selectedWorkspaceManualStatus,
		selectedWorkspaceState,
		queryClient,
	]);

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

	// ── Git watcher: react to external branch / ref changes ──────────
	useEffect(() => {
		let disposed = false;
		let unlistenBranch: (() => void) | undefined;
		let unlistenRefs: (() => void) | undefined;

		void listenGitBranchChanged((payload) => {
			if (disposed) return;
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceDetail(payload.workspaceId),
			});
			// Checkout changes what's uncommitted — refresh file diff
			queryClient.invalidateQueries({ queryKey: ["workspaceChanges"] });
		}).then((unlisten) => {
			if (disposed) {
				unlisten();
				return;
			}
			unlistenBranch = unlisten;
		});

		void listenGitRefsChanged((payload) => {
			if (disposed) return;
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceDetail(payload.workspaceId),
			});
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGitActionStatus(payload.workspaceId),
			});
			// Ref changes (commit, push, fetch) affect merge-base and
			// staged/unstaged state — refresh the inspector file diff.
			queryClient.invalidateQueries({ queryKey: ["workspaceChanges"] });
		}).then((unlisten) => {
			if (disposed) {
				unlisten();
				return;
			}
			unlistenRefs = unlisten;
		});

		return () => {
			disposed = true;
			unlistenBranch?.();
			unlistenRefs?.();
		};
	}, [queryClient]);

	useEffect(() => {
		if (
			githubIdentityState.status === "connected" ||
			githubIdentityState.status === "checking"
		) {
			return;
		}

		clearWorkspaceRuntimeState();
	}, [clearWorkspaceRuntimeState, githubIdentityState.status]);

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

	const {
		commitButtonMode,
		commitButtonState,
		handleInspectorCommitAction,
		handlePendingPromptConsumed,
		pendingPromptForSession,
		queuePendingPromptForSession,
	} = useWorkspaceCommitLifecycle({
		queryClient,
		selectedWorkspaceIdRef,
		workspaceManualStatus: selectedWorkspaceManualStatus,
		workspacePrInfo,
		sendingSessionIds,
		onSelectSession: handleSelectSession,
	});

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

	// ── Pending CLI sends: on window focus, drain queued prompts ────────
	// When `helmor send` detects the App is running it writes the prompt
	// into `pending_cli_sends` instead of starting its own sidecar. On
	// the next focus event we pick those up and replay them through the
	// normal streaming path (setPendingPromptForSession → auto-submit).
	useEffect(() => {
		let unlisten: (() => void) | undefined;

		void import("@tauri-apps/api/event").then(({ listen }) => {
			void listen("tauri://focus", async () => {
				// Smart fetch: refresh remote refs for the active workspace
				// so file tree diffs stay current after terminal pushes.
				const wsId = selectedWorkspaceIdRef.current;
				if (wsId) {
					prefetchRemoteRefs({ workspaceId: wsId }).catch(() => {});
				}

				try {
					const sends = await drainPendingCliSends();
					if (sends.length === 0) return;

					// Process the first send immediately. If there are
					// multiple we queue only the first — subsequent sends
					// will be picked up on the next focus or could be
					// extended later to a queue.
					const first = sends[0];
					console.log(
						"[pendingCliSend] picked up",
						sends.length,
						"send(s), processing first:",
						first.sessionId,
					);

					// Ensure workspace + session data is fresh before navigating
					await queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceGroups,
					});
					if (first.workspaceId) {
						await queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceSessions(first.workspaceId),
						});
					}

					// Navigate to the workspace + session
					handleSelectWorkspace(first.workspaceId);

					// Small delay to let workspace selection settle before
					// setting the pending prompt — otherwise the conversation
					// container might not have mounted the target session yet.
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
			}).then((fn) => {
				unlisten = fn;
			});
		});

		return () => {
			unlisten?.();
		};
	}, [
		handleSelectWorkspace,
		handleSelectSession,
		queryClient,
		queuePendingPromptForSession,
	]);

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
													{githubIdentityState.status === "connected" ? (
														<GithubStatusMenu
															identityState={githubIdentityState}
															onDisconnectGithub={() => {
																void handleDisconnectGithubIdentity();
															}}
														/>
													) : null}
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
											className={
												workspaceViewMode === "editor"
													? "hidden"
													: "flex min-h-0 flex-1 flex-col"
											}
										>
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
										</div>
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
										workspaceId={selectedWorkspaceId}
										workspaceRootPath={workspaceRootPath}
										workspaceState={
											selectedWorkspaceDetailQuery.data?.state ?? null
										}
										repoId={selectedWorkspaceDetailQuery.data?.repoId ?? null}
										workspaceBranch={
											selectedWorkspaceDetailQuery.data?.branch ?? null
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
										commitButtonMode={commitButtonMode}
										commitButtonState={commitButtonState}
										prInfo={workspacePrInfo}
										onOpenSettings={onOpenSettings}
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
export default App;
