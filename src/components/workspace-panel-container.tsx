import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	memo,
	startTransition,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ThreadMessageLike } from "@/lib/api";
import { messagesStructurallyEqual } from "@/lib/structural-equality";

type DbSeenCache = {
	db: ThreadMessageLike[];
	ids: Set<string | undefined>;
};

// ---------------------------------------------------------------------------
// Structural sharing
//
// The Tauri stream pipeline emits two flavours of events:
//   - `streamingPartial` — only the trailing message changed.
//   - `update`           — full snapshot replay (every message gets a NEW
//                          object reference, even if its content is byte-for-
//                          byte identical to what we already had).
//
// Without structural sharing, every `update` invalidates the
// `MemoConversationMessage` `prev.message === next.message` bail-out and the
// entire message list re-renders. `shareMessages` walks the new array,
// reuses the previous message object whenever the message id matches AND
// its content is structurally equivalent (via `messagesStructurallyEqual`
// from `@/lib/structural-equality`, shared with the per-component memo
// comparators in `workspace-panel.tsx`), and finally falls back to the
// previous outer array reference if nothing changed at all.
// ---------------------------------------------------------------------------

/**
 * Exported for direct unit testing of the structural-sharing algorithm.
 * The helper itself is what keeps `MemoConversationMessage`'s
 * `prev.message === next.message` bail-out alive across `update`
 * snapshots — its truth table (when to reuse vs. allocate, and when
 * to fall back to the previous outer array reference entirely) is
 * pinned by tests in `workspace-panel-container.share.test.ts`.
 */
export function shareMessages(
	prev: ThreadMessageLike[],
	next: ThreadMessageLike[],
): ThreadMessageLike[] {
	if (prev === next) return next;
	const prevById = new Map<string, ThreadMessageLike>();
	for (const message of prev) {
		if (message.id != null) prevById.set(message.id, message);
	}
	let allReused = next.length === prev.length;
	const shared = next.map((message, index) => {
		const candidate = message.id != null ? prevById.get(message.id) : undefined;
		if (candidate && messagesStructurallyEqual(candidate, message)) {
			if (allReused && prev[index] !== candidate) {
				allReused = false;
			}
			return candidate;
		}
		allReused = false;
		return message;
	});
	return allReused ? prev : shared;
}

import { generateSessionTitle } from "@/lib/api";
import { measureSync } from "@/lib/perf-marks";
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
	selectedProvider?: string | null;
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
	liveMessages,
	sending,
	sendingSessionIds,
	selectedProvider = null,
	onSelectSession,
	onResolveDisplayedSession,
	headerActions,
	headerLeading,
}: WorkspacePanelContainerProps) {
	const queryClient = useQueryClient();
	const autoTitleAttemptedRef = useRef<Set<string>>(new Set());
	const sessionPaneCacheRef = useRef<
		Map<
			string,
			{
				sessionId: string;
				messages: ThreadMessageLike[];
				sending: boolean;
				hasLoaded: boolean;
			}
		>
	>(new Map());
	const sessionPaneOrderRef = useRef<string[]>([]);
	const SESSION_PANE_CACHE_LIMIT = 3;

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

	// Cache the dedup Set across stream ticks. While the agent is streaming,
	// the persistent `db` array reference is stable, so we should not rebuild
	// the Set on every accumulator delta. The cache is invalidated whenever
	// the underlying `db` reference changes.
	const dbSeenCacheRef = useRef<DbSeenCache | null>(null);
	// Previous mergedMessages output, used by `shareMessages` for structural
	// reference reuse so historical messages keep the same identity across
	// stream ticks (and across backend `update` snapshots).
	const prevMergedRef = useRef<ThreadMessageLike[]>([]);

	// Phase 2 / Goal #2 — A1' progressive deferred hydration:
	//
	// On a fresh session mount we render only the LAST `INITIAL_HYDRATION_COUNT`
	// messages. After a short dwell time, we silently expand to the full
	// thread in the background. The user sees the bottom of the conversation
	// almost immediately even on long sessions, and the older messages
	// "appear" above without any visible flicker because:
	//   1. The first frame anchors to the bottom of the partial render.
	//   2. When the rest hydrates, every newly-mounted row above the viewport
	//      lands inside the existing pendingScrollAdjustment compensation
	//      path (Goal #1) — scrollTop is bumped up by the height of the
	//      newly added rows so the visible content stays put.
	//   3. The user's hasUserScrolledRef gate (Goal #1.5) ensures that if
	//      the user happens to start scrolling during the hydration window,
	//      the compensation is suppressed and their scroll position is
	//      preserved instead.
	//
	// Streaming sessions (sending=true) bypass slicing entirely — the
	// streaming tail must always be visible.
	const INITIAL_HYDRATION_COUNT = 30;
	const HYDRATION_DELAY_MS = 1500;
	// Phase 2 / Goal #2 refinement (iter 1):
	// Sessions at or below this threshold skip A1' entirely — they render
	// the full thread on mount with no state machine, no transition, no
	// extra re-renders. Reasoning: for a session of (say) 12 messages, the
	// initial mount cost is already tiny, and the 3-5 ms overhead of the
	// A1' state reset + useEffect + setTimeout + transition handling is a
	// pure regression. We only pay that overhead when it's actually buying
	// us something, which is long sessions (>50 msgs).
	// Tauri/WKWebView is already sensitive to the progressive viewport's dynamic
	// height corrections. Layering A1' on top of that — "render the last 30
	// messages now, then swap in the full thread 1500ms later" — causes an
	// obvious whole-panel flash and scrollbar thumb resize on long sessions.
	//
	// The progressive viewport itself already virtualizes realized rows, so in
	// Tauri we prefer a single stable full-thread model from first paint. Helmor
	// is Tauri-only now, so A1' is always disabled — keep the variable so the
	// surrounding hydration code can be simplified in a follow-up pass without
	// interleaving it with this cleanup.
	const a1Enabled = false;
	const [hydratedMessageCount, setHydratedMessageCount] = useState(
		INITIAL_HYDRATION_COUNT,
	);

	// Reset hydration count when the active session changes so each fresh
	// session walks through the partial → full hydration phases on its own.
	const lastHydratedSessionRef = useRef<string | null>(null);
	if (lastHydratedSessionRef.current !== threadSessionId) {
		lastHydratedSessionRef.current = threadSessionId;
		// Setting state during render is the React-recommended way to
		// "reset state on prop change" — React discards the in-progress
		// render and immediately retries with the new state, avoiding the
		// extra render → useEffect → setState chain.
		// eslint-disable-next-line react-hooks/rules-of-hooks
		setHydratedMessageCount(INITIAL_HYDRATION_COUNT);
	}

	// After the dwell time, expand to the full thread inside a transition
	// so React can interleave the heavy reconciliation with browser
	// rendering work and bail out if the user does anything (e.g. starts
	// scrolling). startTransition marks the state update as non-urgent;
	// React 19 will spread the commit across multiple frames if needed
	// rather than firing a single 200+ ms blocking commit. We only arm
	// the timer for sessions where A1' is actually doing any clipping.
	useEffect(() => {
		if (!threadSessionId) return;
		if (!a1Enabled) return;
		if (hydratedMessageCount === Number.POSITIVE_INFINITY) return;
		const handle = window.setTimeout(() => {
			startTransition(() => {
				setHydratedMessageCount(Number.POSITIVE_INFINITY);
			});
		}, HYDRATION_DELAY_MS);
		return () => window.clearTimeout(handle);
	}, [threadSessionId, hydratedMessageCount, a1Enabled]);

	const mergedMessages = useMemo(() => {
		return measureSync(
			"container:merged-messages",
			() => {
				const dbAll = messagesQuery.data ?? [];
				// Only clip the historical (db) tail when:
				//   1. A1' is actually enabled for this session (large enough
				//      to benefit, not streaming), AND
				//   2. the full hydration transition hasn't landed yet, AND
				//   3. the session is actually larger than the current
				//      hydrated count.
				// Small sessions (≤ 50 msgs) bypass the slicing completely so
				// there's zero A1' overhead on the common-case fast path.
				const db =
					!a1Enabled ||
					sending ||
					hydratedMessageCount === Number.POSITIVE_INFINITY ||
					dbAll.length <= hydratedMessageCount
						? dbAll
						: dbAll.slice(dbAll.length - hydratedMessageCount);
				let next: ThreadMessageLike[];
				if (liveMessages.length === 0) {
					next = db;
				} else if (db.length === 0) {
					next = liveMessages;
				} else {
					let cache = dbSeenCacheRef.current;
					if (!cache || cache.db !== db) {
						const ids = new Set<string | undefined>();
						for (const message of db) {
							ids.add(message.id);
						}
						cache = { db, ids };
						dbSeenCacheRef.current = cache;
					}
					const uniqueLive = liveMessages.filter(
						(message) => !cache.ids.has(message.id),
					);
					next = uniqueLive.length === 0 ? db : [...db, ...uniqueLive];
				}
				const shared = measureSync(
					"container:share-messages",
					() => shareMessages(prevMergedRef.current, next),
					{
						prevLength: prevMergedRef.current.length,
						nextLength: next.length,
					},
				);
				prevMergedRef.current = shared;
				return shared;
			},
			{
				dbLength: messagesQuery.data?.length ?? 0,
				liveLength: liveMessages.length,
				hydratedCount:
					hydratedMessageCount === Number.POSITIVE_INFINITY
						? -1
						: hydratedMessageCount,
			},
		);
	}, [
		messagesQuery.data,
		liveMessages,
		hydratedMessageCount,
		sending,
		a1Enabled,
	]);

	const preferredPaneSessionId = selectedSessionId ?? threadSessionId;
	const hasFreshThreadSnapshot =
		Boolean(threadSessionId) &&
		(messagesQuery.data !== undefined || liveMessages.length > 0);
	if (threadSessionId && hasFreshThreadSnapshot) {
		sessionPaneCacheRef.current.set(threadSessionId, {
			sessionId: threadSessionId,
			messages: mergedMessages,
			sending,
			hasLoaded: true,
		});
		sessionPaneOrderRef.current = [
			threadSessionId,
			...sessionPaneOrderRef.current.filter((id) => id !== threadSessionId),
		].slice(0, SESSION_PANE_CACHE_LIMIT);
	}
	if (preferredPaneSessionId) {
		sessionPaneOrderRef.current = [
			preferredPaneSessionId,
			...sessionPaneOrderRef.current.filter(
				(id) => id !== preferredPaneSessionId,
			),
		].slice(0, SESSION_PANE_CACHE_LIMIT);
	}

	const hasWorkspaceDetail = workspace !== null;
	const hasWorkspaceSessions = sessionsQuery.data !== undefined;
	const hasWorkspaceContent = hasWorkspaceDetail || sessions.length > 0;
	const hasResolvedWorkspace = hasWorkspaceDetail && hasWorkspaceSessions;
	const hasResolvedSessionMessages = messagesQuery.data !== undefined;
	const hasSessionSnapshot =
		Boolean(threadSessionId) &&
		(hasResolvedSessionMessages || liveMessages.length > 0);
	const sessionPanes = useMemo(() => {
		if (!preferredPaneSessionId) {
			return [];
		}

		const preferredPane =
			sessionPaneCacheRef.current.get(preferredPaneSessionId) ?? null;
		if (!preferredPane) {
			return [];
		}

		return [
			{
				sessionId: preferredPaneSessionId,
				messages:
					preferredPaneSessionId === threadSessionId && hasFreshThreadSnapshot
						? mergedMessages
						: preferredPane.messages,
				sending:
					preferredPaneSessionId === threadSessionId
						? sending
						: preferredPane.sending,
				hasLoaded: preferredPane.hasLoaded,
				presentationState: "presented" as const,
			},
		];
	}, [
		hasFreshThreadSnapshot,
		mergedMessages,
		preferredPaneSessionId,
		sending,
		threadSessionId,
	]);
	const visibleSessionId = sessionPanes[0]?.sessionId ?? null;
	const hasPresentedPane = Boolean(sessionPanes[0]?.hasLoaded);

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
		!hasPresentedPane &&
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
			selectedProvider={selectedProvider}
			sessionPanes={sessionPanes}
			loadingWorkspace={loadingWorkspace}
			loadingSession={loadingSession}
			refreshingWorkspace={refreshingWorkspace}
			refreshingSession={refreshingSession}
			sending={sending}
			sendingSessionIds={sendingSessionIds}
			onSelectSession={handleSelectSession}
			onPrefetchSession={handlePrefetchSession}
			onSessionsChanged={handleSessionsChanged}
			onSessionRenamed={handleSessionRenamed}
			onWorkspaceChanged={handleWorkspaceChanged}
			headerActions={headerActions}
			headerLeading={headerLeading}
		/>
	);
});
