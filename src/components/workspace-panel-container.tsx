import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { ThreadMessageLike } from "@/lib/api";
import { generateSessionTitle } from "@/lib/api";
import {
	publishChatCacheSnapshot,
	shouldTrackDevCacheStats,
} from "@/lib/dev-render-debug";
import {
	helmorQueryKeys,
	sessionThreadMessagesQueryOptions,
	workspaceDetailQueryOptions,
	workspaceSessionsQueryOptions,
} from "@/lib/query-client";
import { WorkspacePanel } from "./workspace-panel";

type WorkspacePanelContainerProps = {
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	selectedSessionId: string | null;
	displayedSessionId: string | null;
	sessionSelectionHistory?: string[];
	liveMessages: ThreadMessageLike[];
	sending: boolean;
	sendingSessionIds?: Set<string>;
	onSelectSession: (sessionId: string | null) => void;
	onResolveDisplayedSession: (sessionId: string | null) => void;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
};

function estimateMessageBytes(messages: ThreadMessageLike[]) {
	let total = 0;

	for (const message of messages) {
		total += 160;
		total += (message.id?.length ?? 0) * 2;
		total += message.role.length * 2;
		total += message.content.length * 40;
		total += (message.createdAt?.length ?? 0) * 2;
	}

	return total;
}

export const WorkspacePanelContainer = memo(function WorkspacePanelContainer({
	selectedWorkspaceId,
	displayedWorkspaceId,
	selectedSessionId,
	displayedSessionId,
	sessionSelectionHistory = [],
	liveMessages,
	sending,
	sendingSessionIds,
	onSelectSession,
	onResolveDisplayedSession,
	headerActions,
	headerLeading,
}: WorkspacePanelContainerProps) {
	const queryClient = useQueryClient();
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

	const mergedMessages = useMemo(() => {
		const db = messagesQuery.data ?? [];
		if (liveMessages.length === 0) return db;
		if (db.length === 0) return liveMessages;
		// Dedup by ID when an error-path refetch briefly overlaps with live data.
		const seen = new Set(db.map((message) => message.id));
		const uniqueLive = liveMessages.filter((message) => !seen.has(message.id));
		return [...db, ...uniqueLive];
	}, [messagesQuery.data, liveMessages]);

	const hasWorkspaceDetail = workspace !== null;
	const hasWorkspaceSessions = sessionsQuery.data !== undefined;
	const hasWorkspaceContent = hasWorkspaceDetail || sessions.length > 0;
	const hasResolvedWorkspace = hasWorkspaceDetail && hasWorkspaceSessions;
	const hasResolvedSessionMessages = messagesQuery.data !== undefined;
	const hasSessionSnapshot =
		Boolean(threadSessionId) &&
		(hasResolvedSessionMessages || liveMessages.length > 0);
	const sessionPanes = useMemo(() => {
		if (!threadSessionId || !hasSessionSnapshot) {
			return [];
		}

		return [
			{
				sessionId: threadSessionId,
				messages: mergedMessages,
				sending,
				hasLoaded: true,
				presentationState: "presented" as const,
			},
		];
	}, [hasSessionSnapshot, mergedMessages, sending, threadSessionId]);
	const visibleSessionId = sessionPanes[0]?.sessionId ?? null;

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
	const loadingSession =
		Boolean(threadSessionId) &&
		!refreshingWorkspace &&
		!hasSessionSnapshot &&
		messagesQuery.isPending &&
		liveMessages.length === 0;
	const refreshingSession =
		Boolean(threadSessionId) &&
		!loadingSession &&
		!refreshingWorkspace &&
		((selectedSessionId !== threadSessionId &&
			visibleSessionId !== threadSessionId) ||
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

	useEffect(() => {
		if (!shouldTrackDevCacheStats()) {
			return;
		}

		const panesBySession = Object.fromEntries(
			sessionPanes.map((pane) => [
				pane.sessionId,
				{
					workspaceId: displayedWorkspaceId,
					messageCount: pane.messages.length,
					estimatedMessageBytes: estimateMessageBytes(pane.messages),
					sending: pane.sending,
					hasLoaded: pane.hasLoaded,
					presentationState: pane.presentationState,
					hasViewportSnapshot: false,
					layoutCacheKey: null,
					lastMeasuredAt: undefined,
				},
			]),
		);
		const sessionMessageKeyPrefix =
			helmorQueryKeys.sessionMessages("__debug__")[0];
		const querySessionEntries = queryClient
			.getQueryCache()
			.getAll()
			.filter(
				(query) =>
					Array.isArray(query.queryKey) &&
					query.queryKey[0] === sessionMessageKeyPrefix,
			);

		publishChatCacheSnapshot({
			paneLimit: 1,
			visibleSessionId,
			preparingSessionId: null,
			threadSessionId,
			hotPaneCount: sessionPanes.length,
			warmEntryCount: 0,
			totalRetainedMessages: sessionPanes.reduce(
				(sum, pane) => sum + pane.messages.length,
				0,
			),
			totalEstimatedMessageBytes: Object.values(panesBySession).reduce(
				(sum, pane) => sum + pane.estimatedMessageBytes,
				0,
			),
			querySessionMessageCount: querySessionEntries.length,
			querySessionMessageObserverCount: querySessionEntries.reduce(
				(sum, query) =>
					sum +
					(typeof query.getObserversCount === "function"
						? query.getObserversCount()
						: 0),
				0,
			),
			querySessionMessageDataMessages: querySessionEntries.reduce(
				(sum, query) =>
					sum + (Array.isArray(query.state.data) ? query.state.data.length : 0),
				0,
			),
			paneOrder: sessionPanes.map((pane) => pane.sessionId),
			warmSessionIds: [],
			panesBySession,
		});
	}, [
		displayedWorkspaceId,
		queryClient,
		sessionPanes,
		threadSessionId,
		visibleSessionId,
	]);

	return (
		<WorkspacePanel
			workspace={workspace}
			sessions={sessions}
			selectedSessionId={selectedSessionId ?? threadSessionId}
			sessionPanes={sessionPanes}
			loadingWorkspace={loadingWorkspace}
			loadingSession={loadingSession}
			refreshingWorkspace={refreshingWorkspace}
			refreshingSession={refreshingSession}
			sending={sending}
			sendingSessionIds={sendingSessionIds}
			onSelectSession={(sessionId) => {
				onSelectSession(sessionId);
			}}
			onPrefetchSession={handlePrefetchSession}
			onSessionsChanged={() => {
				void invalidateSessionQueries();
			}}
			onSessionRenamed={handleSessionRenamed}
			onWorkspaceChanged={() => {
				void invalidateWorkspaceQueries();
			}}
			headerActions={headerActions}
			headerLeading={headerLeading}
		/>
	);
});
