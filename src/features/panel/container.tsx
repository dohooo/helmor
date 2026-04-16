import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type {
	AgentModelSection,
	AgentProvider,
	PullRequestInfo,
	ThreadMessageLike,
	WorkspaceDetail,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { createSession, generateSessionTitle } from "@/lib/api";
import {
	helmorQueryKeys,
	sessionThreadMessagesQueryOptions,
	workspaceDetailQueryOptions,
	workspaceSessionsQueryOptions,
} from "@/lib/query-client";
import { useSettings } from "@/lib/settings";
import { resolveSessionDisplayProvider } from "@/lib/workspace-helpers";
import { WorkspacePanel } from "./index";

const EMPTY_MESSAGES: ThreadMessageLike[] = [];

type WorkspacePanelContainerProps = {
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	selectedSessionId: string | null;
	displayedSessionId: string | null;
	sessionSelectionHistory?: string[];
	sending: boolean;
	sendingSessionIds?: Set<string>;
	completedSessionIds?: Set<string>;
	interactionRequiredSessionIds?: Set<string>;
	modelSelections?: Record<string, string>;
	workspacePrInfo?: PullRequestInfo | null;
	onSelectSession: (sessionId: string | null) => void;
	onResolveDisplayedSession: (sessionId: string | null) => void;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
};

export const WorkspacePanelContainer = memo(function WorkspacePanelContainer({
	selectedWorkspaceId,
	displayedWorkspaceId,
	selectedSessionId,
	displayedSessionId,
	sessionSelectionHistory = [],
	sending,
	sendingSessionIds,
	completedSessionIds,
	interactionRequiredSessionIds,
	modelSelections = {},
	workspacePrInfo = null,
	onSelectSession,
	onResolveDisplayedSession,
	headerActions,
	headerLeading,
}: WorkspacePanelContainerProps) {
	const queryClient = useQueryClient();
	const { settings } = useSettings();
	const autoTitleAttemptedRef = useRef<Set<string>>(new Set());

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

		if (!workspace || sessionsQuery.data === undefined) {
			return;
		}

		if (workspace.state === "archived" || sessions.length > 0) {
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
								contextTokenCount: 0,
								contextUsedPercent: null,
								thinkingEnabled: true,
								fastMode: false,
								agentPersonality: null,
								createdAt: now,
								updatedAt: now,
								lastUserMessageAt: null,
								resumeSessionAt: null,
								isHidden: false,
								isCompacting: false,
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
		queryClient,
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
		return [
			{
				sessionId: preferredPaneSessionId,
				messages,
				sending,
				hasLoaded: true,
				presentationState: "presented" as const,
			},
		];
	}, [
		messages,
		messagesQuery.data,
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

		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceDetail(displayedWorkspaceId),
			}),
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceSessions(displayedWorkspaceId),
			}),
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
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

	// Auto-generate title for existing sessions still named "Untitled".
	// When a session is displayed and its messages are loaded, if the title
	// is "Untitled" and there is at least one user message, trigger rename.
	useEffect(() => {
		if (!threadSessionId || !displayedWorkspaceId) return;

		if (autoTitleAttemptedRef.current.has(threadSessionId)) return;

		const currentSession = sessions.find(
			(session) => session.id === threadSessionId,
		);
		if (!currentSession || currentSession.title !== "Untitled") return;

		const messages = messagesQuery.data;
		if (!messages || messages.length === 0) return;

		const firstUserMessage = messages.find(
			(message) => message.role === "user",
		);
		if (!firstUserMessage) return;

		autoTitleAttemptedRef.current.add(threadSessionId);

		const userText = firstUserMessage.content
			.filter(
				(part): part is { type: "text"; text: string } => part.type === "text",
			)
			.map((part) => part.text)
			.join("\n");
		if (!userText) return;

		void generateSessionTitle(threadSessionId, userText).then((result) => {
			if (result?.title) {
				void invalidateWorkspaceQueries();
			}
		});
	}, [
		displayedWorkspaceId,
		invalidateWorkspaceQueries,
		messagesQuery.data,
		sessions,
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
			sendingSessionIds={sendingSessionIds}
			completedSessionIds={completedSessionIds}
			interactionRequiredSessionIds={interactionRequiredSessionIds}
			onSelectSession={handleSelectSession}
			onPrefetchSession={handlePrefetchSession}
			onSessionsChanged={handleSessionsChanged}
			onSessionRenamed={handleSessionRenamed}
			onWorkspaceChanged={handleWorkspaceChanged}
			headerActions={headerActions}
			headerLeading={headerLeading}
			prInfo={workspacePrInfo}
		/>
	);
});
