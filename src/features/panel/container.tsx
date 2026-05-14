import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { getShortcut } from "@/features/shortcuts/registry";
import type {
	AgentModelSection,
	AgentProvider,
	ChangeRequestInfo,
	RepoScripts,
	ThreadMessageLike,
	WorkspaceDetail,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { createSession, loadRepoScripts } from "@/lib/api";
import {
	helmorQueryKeys,
	sessionThreadMessagesQueryOptions,
	workspaceDetailQueryOptions,
	workspaceSessionsQueryOptions,
} from "@/lib/query-client";
import { useSettings } from "@/lib/settings";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import type { ContextCard } from "@/lib/sources/types";
import { resolveSessionDisplayProvider } from "@/lib/workspace-helpers";
import {
	WORKSPACE_SCRIPT_PROMPTS,
	type WorkspaceScriptType,
} from "@/lib/workspace-script-actions";
import { WorkspacePanel } from "./index";
import type { SessionCloseRequest } from "./use-confirm-session-close";

const EMPTY_MESSAGES: ThreadMessageLike[] = [];

/** Minimal shape the panel needs to render an optimistic user bubble for a
 *  freshly-created workspace whose first send is still queued behind
 *  `await finalizePromise`. Decoupled from the full
 *  `PendingCreatedWorkspaceSubmit` type so the panel doesn't pull in the
 *  composer payload's transitive deps. */
export type OptimisticPendingSubmit = {
	id: string;
	workspaceId: string;
	sessionId: string;
	prompt: string;
};

type WorkspacePanelContainerProps = {
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	selectedSessionId: string | null;
	displayedSessionId: string | null;
	sessionSelectionHistory?: string[];
	sending: boolean;
	busySessionIds?: Set<string>;
	interactionRequiredSessionIds?: Set<string>;
	modelSelections?: Record<string, string>;
	workspaceChangeRequest?: ChangeRequestInfo | null;
	onSelectSession: (sessionId: string | null) => void;
	onResolveDisplayedSession: (sessionId: string | null) => void;
	onQueuePendingPromptForSession?: (request: {
		sessionId: string;
		prompt: string;
		modelId?: string | null;
		permissionMode?: string | null;
	}) => void;
	onRequestCloseSession?: (request: SessionCloseRequest) => void;
	contextPreviewCard?: ContextCard | null;
	contextPreviewActive?: boolean;
	onSelectContextPreview?: () => void;
	onCloseContextPreview?: () => void;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
	/** Optimistic user bubble for a workspace that's mid-finalize — rendered
	 *  before the real send actually fires, swapped out as soon as the real
	 *  user message lands in DB. */
	optimisticPendingSubmit?: OptimisticPendingSubmit | null;
};

export const WorkspacePanelContainer = memo(function WorkspacePanelContainer({
	selectedWorkspaceId,
	displayedWorkspaceId,
	selectedSessionId,
	displayedSessionId,
	sessionSelectionHistory = [],
	sending,
	busySessionIds,
	interactionRequiredSessionIds,
	modelSelections = {},
	workspaceChangeRequest = null,
	onSelectSession,
	onResolveDisplayedSession,
	onQueuePendingPromptForSession,
	onRequestCloseSession,
	contextPreviewCard = null,
	contextPreviewActive = false,
	onSelectContextPreview,
	onCloseContextPreview,
	headerActions,
	headerLeading,
	optimisticPendingSubmit = null,
}: WorkspacePanelContainerProps) {
	const queryClient = useQueryClient();
	const { settings } = useSettings();

	const detailQuery = useQuery({
		...workspaceDetailQueryOptions(displayedWorkspaceId ?? "__none__"),
		enabled: Boolean(displayedWorkspaceId),
	});
	const sessionsQuery = useQuery({
		...workspaceSessionsQueryOptions(displayedWorkspaceId ?? "__none__"),
		enabled: Boolean(displayedWorkspaceId),
	});

	const workspace = detailQuery.data ?? null;
	const sessions = sessionsQuery.data ?? [];
	const rememberedSessionId = useMemo(() => {
		if (sessionSelectionHistory.length === 0 || sessions.length === 0) {
			return null;
		}

		const visibleSessionIds = new Set(sessions.map((session) => session.id));
		for (let i = sessionSelectionHistory.length - 1; i >= 0; i -= 1) {
			const sessionId = sessionSelectionHistory[i];
			if (visibleSessionIds.has(sessionId)) {
				return sessionId;
			}
		}

		return null;
	}, [sessionSelectionHistory, sessions]);

	const autoCreatingWorkspaceRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		if (!displayedWorkspaceId || selectedWorkspaceId !== displayedWorkspaceId) {
			return;
		}

		// Only auto-create after one real fetch cycle. Newly created workspaces
		// are optimistically seeded with an empty session list before the backend
		// response with the initial session lands.
		if (
			!detailQuery.isFetchedAfterMount ||
			!sessionsQuery.isFetchedAfterMount
		) {
			return;
		}

		if (!workspace || sessionsQuery.data === undefined) {
			return;
		}

		const hasNoPersistedSessions =
			workspace.sessionCount === 0 && workspace.activeSessionId === null;

		if (
			workspace.state === "archived" ||
			workspace.state === "initializing" ||
			sessions.length > 0 ||
			!hasNoPersistedSessions
		) {
			autoCreatingWorkspaceRef.current.delete(displayedWorkspaceId);
			return;
		}

		if (autoCreatingWorkspaceRef.current.has(displayedWorkspaceId)) {
			return;
		}

		let cancelled = false;
		autoCreatingWorkspaceRef.current.add(displayedWorkspaceId);

		void createSession(displayedWorkspaceId)
			.then(async ({ sessionId }) => {
				if (cancelled) {
					return;
				}

				const now = new Date().toISOString();
				queryClient.setQueryData(
					helmorQueryKeys.workspaceDetail(displayedWorkspaceId),
					(current: WorkspaceDetail | null | undefined) => {
						if (!current) {
							return current;
						}

						return {
							...current,
							activeSessionId: sessionId,
							activeSessionTitle: "Untitled",
							activeSessionAgentType: null,
							activeSessionStatus: "idle",
							sessionCount: Math.max(current.sessionCount, 1),
						};
					},
				);
				queryClient.setQueryData(
					helmorQueryKeys.workspaceSessions(displayedWorkspaceId),
					(current: WorkspaceSessionSummary[] | undefined) => {
						if ((current ?? []).some((session) => session.id === sessionId)) {
							return current;
						}

						return [
							...(current ?? []),
							{
								id: sessionId,
								workspaceId: displayedWorkspaceId,
								title: "Untitled",
								agentType: null,
								status: "idle",
								model: null,
								permissionMode: "default",
								providerSessionId: null,
								effortLevel: null,
								unreadCount: 0,
								fastMode: false,
								createdAt: now,
								updatedAt: now,
								lastUserMessageAt: null,
								isHidden: false,
								actionKind: null,
								active: true,
							},
						];
					},
				);
				queryClient.setQueryData(
					[...helmorQueryKeys.sessionMessages(sessionId), "thread"],
					[],
				);

				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(displayedWorkspaceId),
					}),
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceSessions(displayedWorkspaceId),
					}),
				]);
			})
			.catch((error) => {
				console.error(
					`Failed to auto-create a session for workspace ${displayedWorkspaceId}:`,
					error,
				);
			})
			.finally(() => {
				autoCreatingWorkspaceRef.current.delete(displayedWorkspaceId);
			});

		return () => {
			cancelled = true;
		};
	}, [
		displayedWorkspaceId,
		detailQuery.isFetchedAfterMount,
		queryClient,
		sessionsQuery.isFetchedAfterMount,
		selectedWorkspaceId,
		sessions.length,
		sessionsQuery.data,
		workspace,
	]);

	const threadSessionId = useMemo(() => {
		if (!displayedWorkspaceId) {
			return null;
		}

		if (
			displayedSessionId &&
			sessions.some((session) => session.id === displayedSessionId)
		) {
			return displayedSessionId;
		}

		return (
			rememberedSessionId ??
			workspace?.activeSessionId ??
			sessions.find((session) => session.active)?.id ??
			sessions[0]?.id ??
			null
		);
	}, [
		displayedSessionId,
		displayedWorkspaceId,
		rememberedSessionId,
		sessions,
		workspace?.activeSessionId,
	]);

	useEffect(() => {
		if (threadSessionId !== displayedSessionId) {
			onResolveDisplayedSession(threadSessionId);
		}
	}, [displayedSessionId, onResolveDisplayedSession, threadSessionId]);

	useEffect(() => {
		if (!threadSessionId) {
			return;
		}

		void queryClient.prefetchQuery(
			sessionThreadMessagesQueryOptions(threadSessionId),
		);
	}, [queryClient, threadSessionId]);

	const messagesQuery = useQuery({
		...sessionThreadMessagesQueryOptions(threadSessionId ?? "__none__"),
		enabled: Boolean(threadSessionId),
	});
	const repoScriptsQuery = useQuery({
		queryKey: helmorQueryKeys.repoScripts(
			workspace?.repoId ?? "__none__",
			displayedWorkspaceId,
		),
		queryFn: () => loadRepoScripts(workspace!.repoId, displayedWorkspaceId),
		enabled: Boolean(workspace?.repoId && displayedWorkspaceId),
		staleTime: 0,
	});

	const messages = messagesQuery.data ?? EMPTY_MESSAGES;
	const sessionDisplayProviders = useMemo<Record<string, AgentProvider>>(() => {
		const modelSections =
			queryClient.getQueryData<AgentModelSection[]>(
				helmorQueryKeys.agentModelSections,
			) ?? [];
		return Object.fromEntries(
			sessions
				.map((session) => {
					const provider = resolveSessionDisplayProvider({
						session,
						modelSelections,
						modelSections,
						settingsDefaultModelId: settings.defaultModelId,
					});
					return provider ? [session.id, provider] : null;
				})
				.filter((entry): entry is [string, AgentProvider] => entry !== null),
		);
	}, [modelSelections, queryClient, sessions, settings.defaultModelId]);

	const preferredPaneSessionId = selectedSessionId ?? threadSessionId;
	const sessionPanes = useMemo(() => {
		if (!preferredPaneSessionId) {
			return [];
		}
		// Only render a pane for the resolved thread session.
		if (preferredPaneSessionId !== threadSessionId) {
			return [];
		}
		// Don't render a pane until React Query has produced a snapshot
		// (even an empty one). On initial mount and after cache eviction
		// `data` is `undefined` and the panel shows its loading state
		// rather than a vacant "no messages" pane that would briefly
		// appear before the refetch lands.
		if (messagesQuery.data === undefined) {
			return [];
		}

		// Inject an optimistic user bubble while a freshly-created workspace
		// is still finalising. The real user message will replace it the
		// moment the sidecar persists the send. Guard with `!hasUserMessage`
		// so we never double-render once the real one lands.
		let renderedMessages = messages;
		if (
			optimisticPendingSubmit &&
			optimisticPendingSubmit.sessionId === preferredPaneSessionId &&
			optimisticPendingSubmit.workspaceId === displayedWorkspaceId &&
			!messages.some((m) => m.role === "user") &&
			optimisticPendingSubmit.prompt.trim().length > 0
		) {
			const optimisticId = `optimistic:${optimisticPendingSubmit.id}`;
			renderedMessages = [
				{
					role: "user",
					id: optimisticId,
					createdAt: new Date(0).toISOString(),
					content: [
						{
							type: "text",
							id: `${optimisticId}:text`,
							text: optimisticPendingSubmit.prompt,
						},
					],
				},
				...messages,
			];
		}

		return [
			{
				sessionId: preferredPaneSessionId,
				messages: renderedMessages,
				sending,
				hasLoaded: true,
				presentationState: "presented" as const,
			},
		];
	}, [
		displayedWorkspaceId,
		messages,
		messagesQuery.data,
		optimisticPendingSubmit,
		preferredPaneSessionId,
		sending,
		threadSessionId,
	]);

	const hasWorkspaceDetail = workspace !== null;
	const hasWorkspaceSessions = sessionsQuery.data !== undefined;
	const hasWorkspaceContent = hasWorkspaceDetail || sessions.length > 0;
	const hasResolvedWorkspace = hasWorkspaceDetail && hasWorkspaceSessions;
	const hasResolvedSessionMessages = messagesQuery.data !== undefined;

	const loadingWorkspace =
		Boolean(displayedWorkspaceId) &&
		!hasResolvedWorkspace &&
		(detailQuery.isPending || sessionsQuery.isPending);
	const refreshingWorkspace =
		Boolean(displayedWorkspaceId) &&
		!loadingWorkspace &&
		(selectedWorkspaceId !== displayedWorkspaceId ||
			(hasWorkspaceContent &&
				(detailQuery.isFetching || sessionsQuery.isFetching)));
	// Session is "loading" whenever we have a target session but no resolved
	// message data yet. We intentionally do NOT gate this on `refreshingWorkspace`
	// — a background workspace revalidation (e.g. from the git watcher's
	// `invalidateQueries(workspaceDetail)`) must not suppress session-level
	// loading, or the panel falls through to `EmptyState` and flashes
	// "Nothing here yet" before the real messages land. We also deliberately
	// drop the old `messagesQuery.isPending` guard: it was redundant with
	// `!hasResolvedSessionMessages` for enabled queries and hid loading when
	// a previous fetch had errored — the user still needs a placeholder, not
	// EmptyState, until the next fetch succeeds.
	const loadingSession =
		Boolean(threadSessionId) && !hasResolvedSessionMessages;
	const refreshingSession =
		Boolean(threadSessionId) &&
		!loadingSession &&
		!refreshingWorkspace &&
		(selectedSessionId !== threadSessionId ||
			(hasResolvedSessionMessages && messagesQuery.isFetching));

	const invalidateWorkspaceQueries = useCallback(async () => {
		if (!displayedWorkspaceId) {
			return;
		}

		requestSidebarReconcile(queryClient);
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceDetail(displayedWorkspaceId),
			}),
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceSessions(displayedWorkspaceId),
			}),
		]);
	}, [displayedWorkspaceId, queryClient]);

	const invalidateSessionQueries = useCallback(async () => {
		if (!displayedWorkspaceId) {
			return;
		}

		await invalidateWorkspaceQueries();
		if (threadSessionId) {
			await queryClient.invalidateQueries({
				queryKey: [
					...helmorQueryKeys.sessionMessages(threadSessionId),
					"thread",
				],
			});
		}
	}, [
		displayedWorkspaceId,
		invalidateWorkspaceQueries,
		queryClient,
		threadSessionId,
	]);

	const handleSessionRenamed = useCallback(
		(sessionId: string, title: string) => {
			if (!displayedWorkspaceId) {
				return;
			}

			queryClient.setQueryData(
				helmorQueryKeys.workspaceSessions(displayedWorkspaceId),
				(current: typeof sessions | undefined) =>
					(current ?? []).map((session) =>
						session.id === sessionId ? { ...session, title } : session,
					),
			);
			queryClient.setQueryData(
				helmorQueryKeys.workspaceDetail(displayedWorkspaceId),
				(current: typeof workspace | undefined) => {
					if (!current || current.activeSessionId !== sessionId) {
						return current;
					}

					return {
						...current,
						activeSessionTitle: title,
					};
				},
			);
		},
		[displayedWorkspaceId, queryClient, sessions, workspace],
	);

	const handlePrefetchSession = useCallback(
		(sessionId: string) => {
			void queryClient.prefetchQuery(
				sessionThreadMessagesQueryOptions(sessionId),
			);
		},
		[queryClient],
	);

	// All callback props that go into <WorkspacePanel> must be reference
	// stable so that the memoed header sub-component bails out across stream
	// ticks. We capture the latest `onSelectSession` in a ref and route the
	// stable handler through it.
	const onSelectSessionRef = useRef(onSelectSession);
	onSelectSessionRef.current = onSelectSession;
	const handleSelectSession = useCallback((sessionId: string) => {
		onSelectSessionRef.current(sessionId);
	}, []);
	const handleSessionsChanged = useCallback(() => {
		void invalidateSessionQueries();
	}, [invalidateSessionQueries]);
	const handleWorkspaceChanged = useCallback(() => {
		void invalidateWorkspaceQueries();
	}, [invalidateWorkspaceQueries]);
	const selectedSessionIdForPanel = selectedSessionId ?? threadSessionId;
	const selectedSession =
		sessions.find((session) => session.id === selectedSessionIdForPanel) ??
		null;
	const missingScriptTypes = useMemo<WorkspaceScriptType[]>(() => {
		if (!selectedSession) {
			return [];
		}

		const scripts: RepoScripts | undefined = repoScriptsQuery.data;
		if (!scripts) {
			return [];
		}

		const missing: WorkspaceScriptType[] = [];
		if (!scripts.setupScript?.trim()) {
			missing.push("setup");
		}
		if (!scripts.runScript?.trim()) {
			missing.push("run");
		}
		if (!scripts.archiveScript?.trim()) {
			missing.push("archive");
		}
		return missing;
	}, [repoScriptsQuery.data, selectedSession]);
	const handleInitializeScript = useCallback(
		(scriptType: WorkspaceScriptType) => {
			if (!selectedSessionIdForPanel || !onQueuePendingPromptForSession) {
				return;
			}

			onQueuePendingPromptForSession({
				sessionId: selectedSessionIdForPanel,
				prompt: WORKSPACE_SCRIPT_PROMPTS[scriptType],
			});
		},
		[onQueuePendingPromptForSession, selectedSessionIdForPanel],
	);

	return (
		<WorkspacePanel
			workspace={workspace}
			sessions={sessions}
			selectedSessionId={selectedSessionIdForPanel}
			sessionDisplayProviders={sessionDisplayProviders}
			sessionPanes={sessionPanes}
			loadingWorkspace={loadingWorkspace}
			loadingSession={loadingSession}
			refreshingWorkspace={refreshingWorkspace}
			refreshingSession={refreshingSession}
			sending={sending}
			busySessionIds={busySessionIds}
			interactionRequiredSessionIds={interactionRequiredSessionIds}
			contextPreviewCard={contextPreviewCard}
			contextPreviewActive={contextPreviewActive}
			onSelectSession={handleSelectSession}
			onSelectContextPreview={onSelectContextPreview}
			onCloseContextPreview={onCloseContextPreview}
			onPrefetchSession={handlePrefetchSession}
			onSessionsChanged={handleSessionsChanged}
			onSessionRenamed={handleSessionRenamed}
			onWorkspaceChanged={handleWorkspaceChanged}
			onRequestCloseSession={onRequestCloseSession}
			headerActions={headerActions}
			headerLeading={headerLeading}
			newSessionShortcut={getShortcut(settings.shortcuts, "session.new")}
			missingScriptTypes={missingScriptTypes}
			onInitializeScript={handleInitializeScript}
			changeRequest={workspaceChangeRequest}
		/>
	);
});
