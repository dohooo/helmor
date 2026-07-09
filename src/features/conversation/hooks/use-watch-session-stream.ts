/**
 * Passive watcher for a session's live agent turn.
 *
 * The client that *sends* a message renders the turn from its own
 * `startAgentMessageStream` channel (see `use-streaming.ts`). This hook is the
 * mirror image: when the displayed session has an in-flight turn that THIS
 * client did NOT start (driven by a second window, or by the phone via the
 * mobile companion), it subscribes to the backend fan-out and feeds the same
 * `update` / `streamingPartial` frames into the shared session-thread cache —
 * so the desktop streams live instead of needing a reload.
 *
 * Read-only: permission / user-input prompts stay owned by the driving client.
 * On turn end (or teardown) we reconcile to DB truth.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useStreamingStore } from "@/features/conversation/state/streaming-store";
import { stabilizeStreamingMessages } from "@/features/conversation/streaming-tail-collapse";
import {
	type ActiveStreamSummary,
	type AgentStreamEvent,
	subscribeSessionStream,
	type ThreadMessageLike,
} from "@/lib/api";
import { sessionThreadMessagesQueryOptions } from "@/lib/query-client";
import {
	readSessionThread,
	replaceStreamingTail,
} from "@/lib/session-thread-cache";

type Args = {
	sessionId: string | null;
	/** Backend-truth active-streams snapshot (App-owned). Tells us a turn is
	 *  in flight for this session even though we didn't start it. */
	activeStreams: readonly ActiveStreamSummary[];
};

type WatchAccumulator = {
	baseMessages: ThreadMessageLike[];
	pendingPartial: ThreadMessageLike | null;
	needsFlush: boolean;
	frameId: number | null;
	fallbackTimerId: number | null;
};

const STREAM_FLUSH_FALLBACK_MS = 120;

export function useWatchSessionStream({ sessionId, activeStreams }: Args) {
	const queryClient = useQueryClient();
	const contextKey = sessionId ? `session:${sessionId}` : null;

	// THIS client is the driver if it has a local active/sending session for
	// this context (it called startAgentMessageStream itself). The driver
	// already renders via its own channel — watching would double-render.
	const isLocallyDriven = useStreamingStore((state) =>
		contextKey
			? Boolean(state.activeSessionByContext[contextKey]) ||
				state.sendingContextKeys.has(contextKey)
			: false,
	);

	const hasRemoteStream = sessionId
		? activeStreams.some((stream) => stream.sessionId === sessionId)
		: false;

	const enabled = Boolean(sessionId) && hasRemoteStream && !isLocallyDriven;

	useEffect(() => {
		if (!enabled || !sessionId) return;
		let disposed = false;
		let unlisten: (() => void) | null = null;

		const accumulator: WatchAccumulator = {
			baseMessages: [],
			pendingPartial: null,
			needsFlush: false,
			frameId: null,
			fallbackTimerId: null,
		};
		// Gate rendering until the user prompt is guaranteed persisted. The
		// backend writes the prompt row BEFORE the first sidecar event, so by
		// the time any render frame arrives a DB refetch yields a thread whose
		// last user message IS this turn's prompt — the splice boundary.
		let boundaryReady = false;
		let fetching = false;
		const queued: AgentStreamEvent[] = [];

		const refreshFromDb = () =>
			queryClient
				.fetchQuery({
					...sessionThreadMessagesQueryOptions(sessionId),
					staleTime: 0,
				})
				.catch(() => undefined);

		const flush = () => {
			accumulator.frameId = null;
			if (accumulator.fallbackTimerId !== null) {
				window.clearTimeout(accumulator.fallbackTimerId);
				accumulator.fallbackTimerId = null;
			}
			if (!accumulator.needsFlush) return;
			accumulator.needsFlush = false;

			const base = readSessionThread(queryClient, sessionId) ?? [];
			let boundary: ThreadMessageLike | undefined;
			for (let i = base.length - 1; i >= 0; i--) {
				const candidate = base[i];
				if (candidate.role === "user" && candidate.id != null) {
					boundary = candidate;
					break;
				}
			}
			if (!boundary?.id) return;

			const rendered = accumulator.pendingPartial
				? stabilizeStreamingMessages([
						...accumulator.baseMessages,
						accumulator.pendingPartial,
					])
				: accumulator.baseMessages;
			replaceStreamingTail(queryClient, sessionId, boundary.id, [
				boundary,
				...rendered,
			]);
		};

		const scheduleFlush = () => {
			accumulator.needsFlush = true;
			if (accumulator.frameId === null) {
				accumulator.frameId = window.requestAnimationFrame(flush);
			}
			if (accumulator.fallbackTimerId === null) {
				accumulator.fallbackTimerId = window.setTimeout(() => {
					if (accumulator.frameId !== null) {
						window.cancelAnimationFrame(accumulator.frameId);
						accumulator.frameId = null;
					}
					flush();
				}, STREAM_FLUSH_FALLBACK_MS);
			}
		};

		const handle = (event: AgentStreamEvent) => {
			if (event.kind === "update") {
				accumulator.baseMessages = event.messages;
				accumulator.pendingPartial = null;
				scheduleFlush();
				return;
			}
			if (event.kind === "streamingPartial") {
				accumulator.pendingPartial = event.message;
				scheduleFlush();
				return;
			}
			if (event.kind === "taskStateUpdate") {
				useStreamingStore
					.getState()
					.setActiveTasks(event.sessionId, event.tasks);
				return;
			}
			if (
				event.kind === "done" ||
				event.kind === "aborted" ||
				event.kind === "error"
			) {
				if (accumulator.frameId !== null) {
					window.cancelAnimationFrame(accumulator.frameId);
					accumulator.frameId = null;
				}
				if (accumulator.fallbackTimerId !== null) {
					window.clearTimeout(accumulator.fallbackTimerId);
					accumulator.fallbackTimerId = null;
				}
				flush();
				// Reconcile to canonical DB rows now the turn is finalized.
				void refreshFromDb();
				useStreamingStore.getState().clearActiveTasks(sessionId);
			}
			// permissionRequest / userInputRequest / planCaptured: ignored —
			// the driving client owns interactive prompts.
		};

		const onEvent = (event: AgentStreamEvent) => {
			if (disposed) return;
			if (event.kind === "taskStateUpdate") {
				handle(event);
				return;
			}
			if (!boundaryReady) {
				queued.push(event);
				const isRender =
					event.kind === "update" || event.kind === "streamingPartial";
				if (isRender && !fetching) {
					fetching = true;
					void refreshFromDb().then(() => {
						if (disposed) return;
						boundaryReady = true;
						const drain = queued.splice(0, queued.length);
						for (const queuedEvent of drain) handle(queuedEvent);
					});
				}
				return;
			}
			handle(event);
		};

		// Surface the user's prompt immediately — don't wait for the agent's
		// first frame. The backend persists the prompt row at turn start, and
		// we learn of the stream via `ActiveStreamsChanged` (which only fires
		// after registration), so by the time this effect runs the prompt is
		// in the DB. This is display-only: the overlay's splice boundary still
		// waits for the first render frame's refetch (`boundaryReady`), so a
		// rare prompt-not-yet-persisted race just falls back to that path
		// rather than overlaying onto a stale boundary.
		void refreshFromDb();

		void subscribeSessionStream(sessionId, onEvent).then((cleanup) => {
			if (disposed) {
				cleanup();
				return;
			}
			unlisten = cleanup;
		});

		return () => {
			disposed = true;
			if (accumulator.frameId !== null) {
				window.cancelAnimationFrame(accumulator.frameId);
			}
			if (accumulator.fallbackTimerId !== null) {
				window.clearTimeout(accumulator.fallbackTimerId);
			}
			unlisten?.();
			// On teardown (turn ended or navigated away), pull canonical DB
			// state so a half-streamed snapshot never lingers.
			void refreshFromDb();
		};
	}, [enabled, sessionId, queryClient]);
}
