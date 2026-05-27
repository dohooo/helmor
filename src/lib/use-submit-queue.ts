/**
 * App-level submit queue — stores follow-up messages the user wants to
 * send once the current turn finishes.
 *
 * Why module-level singleton: the queue must survive session / workspace
 * switches AND the start-page ↔ workspace toggle so the user can navigate
 * away from a long-running session and come back to see their queue
 * still intact. Component-scoped state would be dropped the moment the
 * displaying container unmounts.
 *
 * State is in-memory only. If the app restarts the queue is lost —
 * that's the intended trade-off: the queue is a short-lived intent, not
 * a durable artifact like a message. Individual rows are identified by
 * client-generated UUIDs so row-level cancel / steer actions have stable
 * targets across re-renders.
 */

import type { SerializedEditorState } from "lexical";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { AgentModelOption } from "./api";
import type { ComposerCustomTag } from "./composer-insert";

/** Minimal serialisable copy of `SubmitPayload` — enough to replay
 *  through `handleComposerSubmit` when the drain fires after the
 *  current turn ends. */
export type QueuedSubmitPayload = {
	prompt: string;
	imagePaths: string[];
	filePaths: string[];
	customTags: ComposerCustomTag[];
	model: AgentModelOption;
	workingDirectory: string | null;
	effortLevel: string;
	permissionMode: string;
	fastMode: boolean;
	/** Full Lexical editor state at enqueue time. Lets `Edit` round-trip the
	 *  queued message back into the composer without lossy reverse-parsing
	 *  of `prompt` (which has `@<path>` references inlined and would otherwise
	 *  collide with badge metadata on restore). */
	editorStateSnapshot?: SerializedEditorState;
};

/** Context captured at enqueue time so drain / Steer can replay
 *  against the original session even if the user has since navigated
 *  elsewhere. Without this, a queued message from session A would
 *  fire into whatever session is currently displayed. */
export type QueuedSubmitContext = {
	sessionId: string;
	workspaceId: string | null;
	contextKey: string;
};

export type QueuedSubmit = {
	/** Client-generated UUID; stable across re-renders. */
	id: string;
	context: QueuedSubmitContext;
	payload: QueuedSubmitPayload;
	enqueuedAt: number;
};

export type SubmitQueueApi = {
	/** Shallow-cloned queue for the given session. Empty array when none. */
	getQueue: (sessionId: string) => QueuedSubmit[];
	/** Find an entry by id across all sessions. Undefined when not found. */
	findById: (id: string) => QueuedSubmit | undefined;
	/** Append to the queue for the enqueue-time context. Returns the generated id. */
	enqueue: (
		context: QueuedSubmitContext,
		payload: QueuedSubmitPayload,
	) => string;
	/** Remove a queued entry by id. No-op if not found. */
	remove: (sessionId: string, id: string) => void;
	/** Pop the head (FIFO) for a session. Returns undefined when empty. */
	popNext: (sessionId: string) => QueuedSubmit | undefined;
	/** Drop the entire queue for a session — used on session deletion. */
	clear: (sessionId: string) => void;
};

type SubmitQueueState = {
	queuesBySessionId: Record<string, readonly QueuedSubmit[]>;
} & SubmitQueueApi;

const EMPTY: readonly QueuedSubmit[] = Object.freeze([]);
export const EMPTY_QUEUE: readonly QueuedSubmit[] = EMPTY;

const INITIAL_QUEUES: Record<string, readonly QueuedSubmit[]> = Object.freeze(
	{},
);

/**
 * Module-level singleton. Two `WorkspaceConversationContainer` instances
 * (start-page + workspace mode) and any future readers all consume the
 * same store — that's how the queue survives navigation.
 */
export const useSubmitQueueStore = create<SubmitQueueState>((set, get) => ({
	queuesBySessionId: INITIAL_QUEUES,

	getQueue: (sessionId) => {
		const bucket = get().queuesBySessionId[sessionId];
		return bucket ? [...bucket] : [];
	},

	findById: (id) => {
		for (const entries of Object.values(get().queuesBySessionId)) {
			const match = entries.find((entry) => entry.id === id);
			if (match) return match;
		}
		return undefined;
	},

	enqueue: (context, payload) => {
		const id = crypto.randomUUID();
		const entry: QueuedSubmit = {
			id,
			context,
			payload,
			enqueuedAt: Date.now(),
		};
		set((state) => {
			const existing = state.queuesBySessionId[context.sessionId] ?? EMPTY;
			return {
				queuesBySessionId: {
					...state.queuesBySessionId,
					[context.sessionId]: [...existing, entry],
				},
			};
		});
		return id;
	},

	remove: (sessionId, id) => {
		set((state) => {
			const existing = state.queuesBySessionId[sessionId];
			if (!existing) return state;
			const filtered = existing.filter((entry) => entry.id !== id);
			if (filtered.length === existing.length) return state;
			const next = { ...state.queuesBySessionId };
			if (filtered.length === 0) {
				delete next[sessionId];
			} else {
				next[sessionId] = filtered;
			}
			return { queuesBySessionId: next };
		});
	},

	popNext: (sessionId) => {
		const existing = get().queuesBySessionId[sessionId];
		if (!existing || existing.length === 0) return undefined;
		const head = existing[0];
		set((state) => {
			const cur = state.queuesBySessionId[sessionId];
			if (!cur || cur.length === 0) return state;
			const rest = cur.slice(1);
			const next = { ...state.queuesBySessionId };
			if (rest.length === 0) {
				delete next[sessionId];
			} else {
				next[sessionId] = rest;
			}
			return { queuesBySessionId: next };
		});
		return head;
	},

	clear: (sessionId) => {
		set((state) => {
			if (!(sessionId in state.queuesBySessionId)) return state;
			const next = { ...state.queuesBySessionId };
			delete next[sessionId];
			return { queuesBySessionId: next };
		});
	},
}));

/**
 * Returns a stable handle to the queue API — uses a shallow selector so
 * the consuming component doesn't re-render when queue contents change
 * (only when action references change, which they don't outside of
 * `__resetSubmitQueueForTests`).
 */
export function useSubmitQueueApi(): SubmitQueueApi {
	return useSubmitQueueStore(
		useShallow((state) => ({
			getQueue: state.getQueue,
			findById: state.findById,
			enqueue: state.enqueue,
			remove: state.remove,
			popNext: state.popNext,
			clear: state.clear,
		})),
	);
}

/**
 * Subscribe to the queue for a given session. Returns the live array;
 * re-renders the consumer whenever that bucket mutates.
 */
export function useSubmitQueueForSession(
	sessionId: string | null,
): readonly QueuedSubmit[] {
	return useSubmitQueueStore((state) =>
		sessionId ? (state.queuesBySessionId[sessionId] ?? EMPTY) : EMPTY,
	);
}

/**
 * Test-only — wipe the queue. Production code never resets imperatively
 * (use `clear(sessionId)` for legitimate session-deletion paths).
 */
export function __resetSubmitQueueForTests(): void {
	useSubmitQueueStore.setState({ queuesBySessionId: INITIAL_QUEUES });
}
