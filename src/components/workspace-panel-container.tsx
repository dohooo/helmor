import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type {
	CollapsedGroupPart,
	ExtendedMessagePart,
	MessagePart,
	ThreadMessageLike,
	ToolCallPart,
} from "@/lib/api";

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
// entire message list re-renders. The helpers below walk the new array,
// reuse the previous message object whenever the message id matches AND its
// content is structurally equivalent, and finally fall back to the previous
// outer array reference if nothing changed at all.
// ---------------------------------------------------------------------------

function partsStructurallyEqual(
	a: ExtendedMessagePart[],
	b: ExtendedMessagePart[],
): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (!partStructurallyEqual(a[i]!, b[i]!)) return false;
	}
	return true;
}

function partStructurallyEqual(
	a: ExtendedMessagePart,
	b: ExtendedMessagePart,
): boolean {
	if (a === b) return true;
	if (a.type !== b.type) return false;
	switch (a.type) {
		case "text": {
			const tb = b as Extract<MessagePart, { type: "text" }>;
			return a.text === tb.text;
		}
		case "reasoning": {
			const rb = b as Extract<MessagePart, { type: "reasoning" }>;
			return a.text === rb.text && a.streaming === rb.streaming;
		}
		case "tool-call": {
			const tb = b as ToolCallPart;
			if (a.toolCallId !== tb.toolCallId) return false;
			if (a.toolName !== tb.toolName) return false;
			if (a.streamingStatus !== tb.streamingStatus) return false;
			if (a.argsText !== tb.argsText) return false;
			// `result` is intentionally not compared by reference — backend
			// snapshot `update` events allocate new wrapper objects for the
			// same logical result, which would otherwise defeat the cache.
			// `(toolCallId, streamingStatus, argsText)` is enough to identify a
			// stable rendered state.
			return true;
		}
		case "collapsed-group": {
			const gb = b as CollapsedGroupPart;
			if (a.active !== gb.active) return false;
			if (a.category !== gb.category) return false;
			if (a.summary !== gb.summary) return false;
			if (a.tools.length !== gb.tools.length) return false;
			for (let i = 0; i < a.tools.length; i += 1) {
				if (!partStructurallyEqual(a.tools[i]!, gb.tools[i]!)) return false;
			}
			return true;
		}
		default:
			return false;
	}
}

function messagesStructurallyEqual(
	a: ThreadMessageLike,
	b: ThreadMessageLike,
): boolean {
	if (a === b) return true;
	if (a.id !== b.id) return false;
	if (a.role !== b.role) return false;
	if (a.streaming !== b.streaming) return false;
	if (a.createdAt !== b.createdAt) return false;
	if (a.status !== b.status) {
		if (!a.status || !b.status) return false;
		if (a.status.type !== b.status.type) return false;
		if (a.status.reason !== b.status.reason) return false;
	}
	return partsStructurallyEqual(a.content, b.content);
}

function shareMessages(
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

	// Cache the dedup Set across stream ticks. While the agent is streaming,
	// the persistent `db` array reference is stable, so we should not rebuild
	// the Set on every accumulator delta. The cache is invalidated whenever
	// the underlying `db` reference changes.
	const dbSeenCacheRef = useRef<DbSeenCache | null>(null);
	// Previous mergedMessages output, used by `shareMessages` for structural
	// reference reuse so historical messages keep the same identity across
	// stream ticks (and across backend `update` snapshots).
	const prevMergedRef = useRef<ThreadMessageLike[]>([]);
	const mergedMessages = useMemo(() => {
		const db = messagesQuery.data ?? [];
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
		const shared = shareMessages(prevMergedRef.current, next);
		prevMergedRef.current = shared;
		return shared;
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
