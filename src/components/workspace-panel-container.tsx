import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StateSnapshot } from "react-virtuoso";
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

const SESSION_PANE_LIMIT = 8;

type SessionThreadPane = {
	sessionId: string;
	workspaceId: string | null;
	messages: ThreadMessageLike[];
	sending: boolean;
	hasLoaded: boolean;
	presentationState: "cold-unpresented" | "presented";
	viewportSnapshot?: StateSnapshot;
	layoutCacheKey?: string | null;
	lastMeasuredAt?: number;
};

type SessionViewportCacheEntry = {
	viewportSnapshot?: StateSnapshot;
	layoutCacheKey?: string | null;
	lastMeasuredAt?: number;
};

type WorkspacePanelContainerProps = {
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	selectedSessionId: string | null;
	displayedSessionId: string | null;
	liveMessages: ThreadMessageLike[];
	sending: boolean;
	sendingSessionIds?: Set<string>;
	onSelectSession: (sessionId: string | null) => void;
	onResolveDisplayedSession: (sessionId: string | null) => void;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
};

function arePaneMeasurementsEqual(
	current: SessionViewportCacheEntry | undefined,
	next: SessionViewportCacheEntry,
) {
	return (
		current?.viewportSnapshot === next.viewportSnapshot &&
		current?.layoutCacheKey === next.layoutCacheKey &&
		current?.lastMeasuredAt === next.lastMeasuredAt
	);
}

function estimateMessageBytes(messages: ThreadMessageLike[]) {
	let total = 0;

	for (const message of messages) {
		total += 160;
		total += (message.id?.length ?? 0) * 2;
		total += message.role.length * 2;
		total += message.content.length * 40; // rough estimate per part
		total += (message.createdAt?.length ?? 0) * 2;
	}

	return total;
}

export const WorkspacePanelContainer = memo(function WorkspacePanelContainer({
	selectedWorkspaceId,
	displayedWorkspaceId,
	selectedSessionId,
	displayedSessionId,
	liveMessages,
	sending,
	sendingSessionIds,
	onSelectSession,
	onResolveDisplayedSession,
	headerActions,
	headerLeading,
}: WorkspacePanelContainerProps) {
	const queryClient = useQueryClient();
	const warmCacheRef = useRef<Record<string, SessionViewportCacheEntry>>({});
	const threadSessionIdRef = useRef<string | null>(null);
	const visibleSessionIdRef = useRef<string | null>(null);
	const preparingSessionIdRef = useRef<string | null>(null);
	const [paneRegistry, setPaneRegistry] = useState<{
		order: string[];
		panes: Record<string, SessionThreadPane>;
	}>({
		order: [],
		panes: {},
	});
	const [visibleSessionId, setVisibleSessionId] = useState<string | null>(null);
	const [preparingSessionId, setPreparingSessionId] = useState<string | null>(
		null,
	);
	const [preparedSessionId, setPreparedSessionId] = useState<string | null>(
		null,
	);
	const [coldRevealSessionId, setColdRevealSessionId] = useState<string | null>(
		null,
	);

	useEffect(() => {
		threadSessionIdRef.current = null;
	}, []);

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
			workspace?.activeSessionId ??
			sessions.find((session) => session.active)?.id ??
			sessions[0]?.id ??
			null
		);
	}, [
		displayedSessionId,
		displayedWorkspaceId,
		sessions,
		workspace?.activeSessionId,
	]);

	useEffect(() => {
		threadSessionIdRef.current = threadSessionId;
	}, [threadSessionId]);

	useEffect(() => {
		visibleSessionIdRef.current = visibleSessionId;
	}, [visibleSessionId]);

	useEffect(() => {
		preparingSessionIdRef.current = preparingSessionId;
	}, [preparingSessionId]);

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
		// Dedup by ID — DB messages take priority over live messages.
		// With persistedIds, live and DB share the same IDs for persisted turns,
		// so duplicates are removed without any visual disruption.
		const seen = new Set(db.map((m) => m.id));
		const uniqueLive = liveMessages.filter((m) => !seen.has(m.id));
		return [...db, ...uniqueLive];
	}, [messagesQuery.data, liveMessages]);

	const hasWorkspaceDetail = workspace !== null;
	const hasWorkspaceSessions = sessionsQuery.data !== undefined;
	const hasWorkspaceContent = hasWorkspaceDetail || sessions.length > 0;
	const hasResolvedWorkspace = hasWorkspaceDetail && hasWorkspaceSessions;
	const hasResolvedSessionMessages = messagesQuery.data !== undefined;
	const targetPane = threadSessionId
		? (paneRegistry.panes[threadSessionId] ?? null)
		: null;
	const hasTargetPane =
		Boolean(targetPane?.hasLoaded) ||
		Boolean(
			threadSessionId &&
				(hasResolvedSessionMessages || liveMessages.length > 0),
		);
	const hasVisiblePane = Boolean(
		visibleSessionId && paneRegistry.panes[visibleSessionId],
	);

	const loadingWorkspace =
		Boolean(displayedWorkspaceId) &&
		!hasResolvedWorkspace &&
		!hasVisiblePane &&
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
		!hasVisiblePane &&
		!hasTargetPane &&
		messagesQuery.isPending &&
		liveMessages.length === 0;
	const refreshingSession =
		Boolean(preparingSessionId) ||
		(Boolean(threadSessionId) &&
			!loadingSession &&
			!refreshingWorkspace &&
			((selectedSessionId !== threadSessionId &&
				visibleSessionId !== threadSessionId) ||
				((hasResolvedSessionMessages || Boolean(targetPane?.hasLoaded)) &&
					messagesQuery.isFetching)));

	useEffect(() => {
		if (!threadSessionId) {
			if (!loadingWorkspace && !refreshingWorkspace) {
				setPreparedSessionId(null);
				setPreparingSessionId(null);
				setColdRevealSessionId(null);
				setVisibleSessionId(null);
			}
			return;
		}

		if (!hasTargetPane) {
			return;
		}

		const retainedVisibleSessionId = visibleSessionIdRef.current;
		const retainedVisiblePane = retainedVisibleSessionId
			? paneRegistry.panes[retainedVisibleSessionId]
			: null;
		const targetHasMessages =
			(targetPane?.messages.length ?? mergedMessages.length) > 0;

		if (!retainedVisiblePane) {
			setColdRevealSessionId(
				targetPane?.presentationState === "cold-unpresented"
					? threadSessionId
					: null,
			);
			setVisibleSessionId(threadSessionId);
			setPreparingSessionId(null);
			setPreparedSessionId(null);
			return;
		}

		if (!targetHasMessages) {
			setColdRevealSessionId(null);
			setVisibleSessionId(threadSessionId);
			setPreparingSessionId(null);
			setPreparedSessionId(null);
			return;
		}

		if (threadSessionId === retainedVisibleSessionId) {
			if (preparingSessionIdRef.current) {
				setPreparingSessionId(null);
				setPreparedSessionId(null);
			}
			return;
		}

		if (preparingSessionIdRef.current !== threadSessionId) {
			setPreparedSessionId(null);
			setPreparingSessionId(threadSessionId);
		}
	}, [
		hasTargetPane,
		loadingWorkspace,
		mergedMessages.length,
		paneRegistry.panes,
		refreshingWorkspace,
		targetPane?.presentationState,
		targetPane?.messages.length,
		threadSessionId,
	]);

	useEffect(() => {
		if (!preparedSessionId) {
			return;
		}

		if (
			preparedSessionId !== preparingSessionIdRef.current ||
			preparedSessionId !== threadSessionIdRef.current
		) {
			return;
		}

		setVisibleSessionId(preparedSessionId);
		setPreparingSessionId(null);
		setPreparedSessionId(null);
		setColdRevealSessionId(null);
	}, [preparedSessionId]);

	useEffect(() => {
		if (!visibleSessionId) {
			return;
		}

		const visiblePane = paneRegistry.panes[visibleSessionId];
		if (!visiblePane || visiblePane.presentationState !== "cold-unpresented") {
			return;
		}

		const timeoutId = window.setTimeout(() => {
			setPaneRegistry((current) => {
				const pane = current.panes[visibleSessionId];
				if (!pane || pane.presentationState === "presented") {
					return current;
				}

				return {
					order: current.order,
					panes: {
						...current.panes,
						[visibleSessionId]: {
							...pane,
							presentationState: "presented",
						},
					},
				};
			});
			setColdRevealSessionId((current) =>
				current === visibleSessionId ? null : current,
			);
		}, 120);

		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [paneRegistry.panes, visibleSessionId]);

	useEffect(() => {
		if (!threadSessionId) {
			return;
		}

		const hasFreshSnapshot =
			hasResolvedSessionMessages || liveMessages.length > 0;

		setPaneRegistry((current) => {
			const existingPane = current.panes[threadSessionId];
			if (!existingPane && !hasFreshSnapshot) {
				return current;
			}

			const warmEntry = warmCacheRef.current[threadSessionId];
			const nextPane: SessionThreadPane = {
				sessionId: threadSessionId,
				workspaceId: displayedWorkspaceId,
				messages: hasFreshSnapshot
					? mergedMessages
					: (existingPane?.messages ?? []),
				sending,
				hasLoaded: Boolean(existingPane?.hasLoaded || hasFreshSnapshot),
				presentationState:
					existingPane?.presentationState ??
					(warmEntry ? "presented" : "cold-unpresented"),
				viewportSnapshot:
					existingPane?.viewportSnapshot ?? warmEntry?.viewportSnapshot,
				layoutCacheKey:
					existingPane?.layoutCacheKey ?? warmEntry?.layoutCacheKey ?? null,
				lastMeasuredAt:
					existingPane?.lastMeasuredAt ?? warmEntry?.lastMeasuredAt,
			};

			const nextOrder = [
				...current.order.filter((sessionId) => sessionId !== threadSessionId),
				threadSessionId,
			];
			const reservedIds = new Set(
				[
					visibleSessionIdRef.current,
					preparingSessionIdRef.current,
					threadSessionId,
				].filter((sessionId): sessionId is string => Boolean(sessionId)),
			);
			const evictedIds: string[] = [];
			while (nextOrder.length - evictedIds.length > SESSION_PANE_LIMIT) {
				const candidate = nextOrder.find(
					(sessionId) =>
						!reservedIds.has(sessionId) && !evictedIds.includes(sessionId),
				);
				if (!candidate) {
					break;
				}
				evictedIds.push(candidate);
			}

			const evictedIdSet = new Set(evictedIds);
			const keptOrder = nextOrder.filter(
				(sessionId) => !evictedIdSet.has(sessionId),
			);
			const nextPanes = {
				...current.panes,
				[threadSessionId]: nextPane,
			};

			for (const sessionId of evictedIds) {
				const pane = nextPanes[sessionId];
				if (
					pane &&
					pane.presentationState === "presented" &&
					pane.messages.length > 0 &&
					(pane.viewportSnapshot || pane.layoutCacheKey || pane.lastMeasuredAt)
				) {
					warmCacheRef.current[sessionId] = {
						viewportSnapshot: pane.viewportSnapshot,
						layoutCacheKey: pane.layoutCacheKey ?? null,
						lastMeasuredAt: pane.lastMeasuredAt,
					};
				}
				delete nextPanes[sessionId];
			}

			const registryChanged =
				existingPane !== nextPane ||
				keptOrder.length !== current.order.length ||
				keptOrder.some(
					(sessionId, index) => sessionId !== current.order[index],
				) ||
				evictedIds.length > 0;

			return registryChanged
				? {
						order: keptOrder,
						panes: nextPanes,
					}
				: current;
		});
	}, [
		displayedWorkspaceId,
		hasResolvedSessionMessages,
		liveMessages.length,
		mergedMessages,
		sending,
		threadSessionId,
	]);

	useEffect(() => {
		setPaneRegistry((current) => {
			const removablePaneIds = current.order.filter((sessionId) => {
				const pane = current.panes[sessionId];
				if (!pane) {
					return false;
				}

				const isProtected =
					sessionId !== visibleSessionIdRef.current &&
					sessionId !== preparingSessionIdRef.current &&
					sessionId !== threadSessionIdRef.current;
				if (!isProtected) {
					return false;
				}

				return (
					pane.presentationState === "cold-unpresented" ||
					pane.messages.length === 0
				);
			});

			if (removablePaneIds.length === 0) {
				return current;
			}

			const removablePaneIdSet = new Set(removablePaneIds);
			const nextPanes = { ...current.panes };
			for (const sessionId of removablePaneIds) {
				delete nextPanes[sessionId];
				delete warmCacheRef.current[sessionId];
			}

			return {
				order: current.order.filter(
					(sessionId) => !removablePaneIdSet.has(sessionId),
				),
				panes: nextPanes,
			};
		});
	}, [preparingSessionId, threadSessionId, visibleSessionId]);

	useEffect(() => {
		if (!displayedWorkspaceId) {
			return;
		}

		const visibleSessionIds = new Set(sessions.map((session) => session.id));
		setPaneRegistry((current) => {
			const removableIds = current.order.filter((sessionId) => {
				const pane = current.panes[sessionId];
				return (
					pane?.workspaceId === displayedWorkspaceId &&
					!visibleSessionIds.has(sessionId)
				);
			});

			if (removableIds.length === 0) {
				return current;
			}

			const removableIdSet = new Set(removableIds);
			const nextPanes = { ...current.panes };
			for (const sessionId of removableIds) {
				delete nextPanes[sessionId];
				delete warmCacheRef.current[sessionId];
			}

			return {
				order: current.order.filter(
					(sessionId) => !removableIdSet.has(sessionId),
				),
				panes: nextPanes,
			};
		});
	}, [displayedWorkspaceId, sessions]);

	const handlePaneMeasurements = useCallback(
		(sessionId: string, payload: SessionViewportCacheEntry) => {
			if (arePaneMeasurementsEqual(warmCacheRef.current[sessionId], payload)) {
				return;
			}

			warmCacheRef.current[sessionId] = payload;
			setPaneRegistry((current) => {
				const pane = current.panes[sessionId];
				if (!pane) {
					return current;
				}

				if (
					pane.viewportSnapshot === payload.viewportSnapshot &&
					pane.layoutCacheKey === payload.layoutCacheKey &&
					pane.lastMeasuredAt === payload.lastMeasuredAt
				) {
					return current;
				}

				return {
					order: current.order,
					panes: {
						...current.panes,
						[sessionId]: {
							...pane,
							viewportSnapshot: payload.viewportSnapshot,
							layoutCacheKey: payload.layoutCacheKey ?? null,
							lastMeasuredAt: payload.lastMeasuredAt,
						},
					},
				};
			});
		},
		[],
	);

	const handlePanePrepared = useCallback(
		(sessionId: string, payload: SessionViewportCacheEntry) => {
			handlePaneMeasurements(sessionId, payload);
			if (
				sessionId !== threadSessionIdRef.current ||
				sessionId !== preparingSessionIdRef.current
			) {
				return;
			}

			setPreparedSessionId(sessionId);
		},
		[handlePaneMeasurements],
	);

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
				queryKey: helmorQueryKeys.sessionMessages(threadSessionId),
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
	const autoTitleAttemptedRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (!threadSessionId || !displayedWorkspaceId) return;

		// Already attempted for this session — skip
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

		// Extract text from thread message content parts
		const userText = firstUserMessage.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text)
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

	const sessionPanes = useMemo(() => {
		const panes = paneRegistry.order
			.map((sessionId) => paneRegistry.panes[sessionId])
			.filter((pane): pane is SessionThreadPane => pane !== undefined)
			.map((pane) => {
				const warmEntry = warmCacheRef.current[pane.sessionId];
				return {
					sessionId: pane.sessionId,
					messages: pane.messages,
					sending: pane.sending,
					hasLoaded: pane.hasLoaded,
					presentationState: pane.presentationState,
					viewportSnapshot:
						pane.viewportSnapshot ?? warmEntry?.viewportSnapshot,
					layoutCacheKey:
						pane.layoutCacheKey ?? warmEntry?.layoutCacheKey ?? null,
					lastMeasuredAt: pane.lastMeasuredAt ?? warmEntry?.lastMeasuredAt,
				};
			});

		if (
			threadSessionId &&
			(hasResolvedSessionMessages || liveMessages.length > 0)
		) {
			const warmEntry = warmCacheRef.current[threadSessionId];
			const activePane = {
				sessionId: threadSessionId,
				messages: mergedMessages,
				sending,
				hasLoaded: true,
				presentationState:
					paneRegistry.panes[threadSessionId]?.presentationState ??
					(warmEntry ? "presented" : "cold-unpresented"),
				viewportSnapshot: warmEntry?.viewportSnapshot,
				layoutCacheKey: warmEntry?.layoutCacheKey ?? null,
				lastMeasuredAt: warmEntry?.lastMeasuredAt,
			};
			const existingIndex = panes.findIndex(
				(pane) => pane.sessionId === threadSessionId,
			);

			if (existingIndex >= 0) {
				panes[existingIndex] = {
					...panes[existingIndex],
					...activePane,
				};
			} else {
				panes.push(activePane);
			}
		}

		return panes;
	}, [
		hasResolvedSessionMessages,
		liveMessages.length,
		mergedMessages,
		paneRegistry,
		sending,
		threadSessionId,
	]);

	useEffect(() => {
		if (!shouldTrackDevCacheStats()) {
			return;
		}

		const panesBySession = Object.fromEntries(
			sessionPanes.map((pane) => [
				pane.sessionId,
				{
					workspaceId: paneRegistry.panes[pane.sessionId]?.workspaceId ?? null,
					messageCount: pane.messages.length,
					estimatedMessageBytes: estimateMessageBytes(pane.messages),
					sending: pane.sending,
					hasLoaded: pane.hasLoaded,
					presentationState: pane.presentationState,
					hasViewportSnapshot: Boolean(pane.viewportSnapshot),
					layoutCacheKey: pane.layoutCacheKey ?? null,
					lastMeasuredAt: pane.lastMeasuredAt,
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
			paneLimit: SESSION_PANE_LIMIT,
			visibleSessionId,
			preparingSessionId,
			threadSessionId,
			hotPaneCount: paneRegistry.order.length,
			warmEntryCount: Object.keys(warmCacheRef.current).length,
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
			paneOrder: paneRegistry.order,
			warmSessionIds: Object.keys(warmCacheRef.current),
			panesBySession,
		});
	}, [
		paneRegistry.order,
		paneRegistry.panes,
		preparingSessionId,
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
			visibleSessionId={visibleSessionId}
			preparingSessionId={preparingSessionId}
			coldRevealSessionId={coldRevealSessionId}
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
			onSessionMeasurements={handlePaneMeasurements}
			onSessionPrepared={handlePanePrepared}
			headerActions={headerActions}
			headerLeading={headerLeading}
		/>
	);
});
