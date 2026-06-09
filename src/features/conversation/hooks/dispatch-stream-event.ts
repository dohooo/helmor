/**
 * Stream-event dispatcher for the live agent turn.
 *
 * `startAgentMessageStream(payload, onEvent)` calls `onEvent` for every
 * frame the backend produces. The dispatch here owns the per-event
 * reaction: updating the streaming partial / message snapshot, surfacing
 * permission requests + AUQ panels, running the end-of-turn cleanup
 * (DB invalidation, queue drain, restore-on-error). All of those reads
 * and writes go through the lifted streaming store so the dispatcher
 * keeps working even when the component that opened the channel has
 * unmounted.
 *
 * This used to be a 150-line inline switch inside `handleComposerSubmit`'s
 * closure. Pulling it out lets the hook stay readable AND lets the
 * dispatch logic be unit-tested independently of the React lifecycle.
 *
 * The factory shape (`createStreamEventDispatcher(deps) -> handler`) is
 * used because the dispatcher needs access to mutable per-call state
 * (the frame-rate accumulator, the rollback snapshot for restore-on-
 * error). Those are captured in the `deps` object the caller builds
 * once per send.
 */

import type { QueryClient } from "@tanstack/react-query";
import {
	buildPendingUserInput,
	type PendingUserInput,
} from "@/features/conversation/pending-user-input";
import type {
	ComposerRestoreState,
	PendingPermission,
	useStreamingStore,
} from "@/features/conversation/state/streaming-store";
import { nestStreamingChildPartial } from "@/features/conversation/streaming-child-nesting";
import { stabilizeStreamingMessages } from "@/features/conversation/streaming-tail-collapse";
import type {
	AgentModelOption,
	AgentStreamEvent,
	ThreadMessageLike,
} from "@/lib/api";
import type { ComposerCustomTag } from "@/lib/composer-insert";
import {
	replaceStreamingTail,
	restoreSnapshot,
	type SessionThreadSnapshot,
} from "@/lib/session-thread-cache";

/**
 * Mutable accumulator the dispatcher updates across event frames. Lives
 * for the lifetime of one `startAgentMessageStream` call.
 */
export type StreamAccumulator = {
	baseMessages: ThreadMessageLike[];
	pendingPartial: ThreadMessageLike | null;
	needsFlush: boolean;
	frameId: number | null;
	fallbackTimerId?: number | null;
};

const STREAM_FLUSH_FALLBACK_MS = 120;

function clearFallbackTimer(accumulator: StreamAccumulator): void {
	if (accumulator.fallbackTimerId == null) return;
	window.clearTimeout(accumulator.fallbackTimerId);
	accumulator.fallbackTimerId = null;
}

export type StreamDispatchDeps = {
	// Send-time invariants. Captured once at the top of handleComposerSubmit.
	readonly contextKey: string;
	readonly isOverride: boolean;
	readonly targetSessionId: string;
	readonly targetWorkspaceId: string | null;
	readonly cacheSessionId: string;
	readonly userMessageId: string;
	readonly trimmedPrompt: string;
	readonly imagePaths: readonly string[];
	readonly filePaths: readonly string[];
	readonly customTags: readonly ComposerCustomTag[];
	readonly model: AgentModelOption;
	readonly optimisticUserMessage: ThreadMessageLike;
	readonly rollbackSnapshot: SessionThreadSnapshot;
	readonly accumulator: StreamAccumulator;

	// Per-stream side-effect helpers. Constructed by the caller because they
	// close over the changes-refresh interval timer.
	readonly scheduleFlush: () => void;
	readonly flushStreamMessages: () => void;
	readonly cleanup: () => void;

	// Hook-bound helpers. Stable identity across the call.
	readonly rememberInteractionWorkspace: (
		contextKey: string,
		workspaceId: string | null,
	) => void;
	readonly appendPendingPermission: (
		contextKey: string,
		permission: PendingPermission,
	) => void;
	readonly setPlanReviewActive: (contextKey: string) => void;
	readonly applyUserInputEvent: (
		contextKey: string,
		input: PendingUserInput,
	) => void;
	readonly clearPendingPermissions: (contextKey: string) => void;
	readonly clearPendingUserInput: (contextKey: string) => void;
	readonly clearFastPrelude: (contextKey: string) => void;
	readonly clearSendingState: (contextKey: string) => void;
	readonly invalidateConversationQueries: (
		workspaceId: string | null,
		sessionId: string | null,
	) => void;
	readonly refreshSessionThreadFromDb: (sessionId: string) => void;
	readonly pushToast: (
		message: string,
		title: string,
		variant: "destructive",
	) => void;
	readonly onSessionCompleted?: (
		sessionId: string,
		workspaceId: string,
	) => void;
	readonly onSessionAborted?: (sessionId: string, workspaceId: string) => void;

	// Store actions (typed subset — the dispatcher only writes through these).
	readonly storeActions: {
		setSendError: (contextKey: string, error: string | null) => void;
		setLiveSession: (
			contextKey: string,
			info: { provider: string; providerSessionId: string | null },
		) => void;
		setComposerRestore: (value: ComposerRestoreState | null) => void;
	};

	// Direct store handle for one read path (the live-session adoption
	// fallback when `event.sessionId` is unset on `done`).
	readonly streamingStore: typeof useStreamingStore;
	readonly queryClient: QueryClient;
};

export function createStreamEventDispatcher(
	deps: StreamDispatchDeps,
): (event: AgentStreamEvent) => void {
	return (event: AgentStreamEvent) => {
		if (event.kind === "update") {
			deps.accumulator.baseMessages = event.messages;
			deps.accumulator.pendingPartial = null;
			deps.scheduleFlush();
			return;
		}

		if (event.kind === "streamingPartial") {
			deps.accumulator.pendingPartial = event.message;
			deps.scheduleFlush();
			return;
		}

		if (event.kind === "permissionRequest") {
			deps.rememberInteractionWorkspace(
				deps.contextKey,
				deps.targetWorkspaceId,
			);
			deps.appendPendingPermission(deps.contextKey, {
				permissionId: event.permissionId,
				toolName: event.toolName,
				toolInput: event.toolInput,
				title: event.title,
				description: event.description,
			});
			return;
		}

		if (event.kind === "planCaptured") {
			deps.rememberInteractionWorkspace(
				deps.contextKey,
				deps.targetWorkspaceId,
			);
			deps.setPlanReviewActive(deps.contextKey);
			return;
		}

		if (event.kind === "userInputRequest") {
			// Non-terminal pause. Flush the pre-pause snapshot so the panel
			// overlays an up-to-date thread, refresh from DB to pick up any
			// turn rows persisted at this checkpoint, then surface the panel.
			// Do NOT call `cleanup()` — the changes-refresh interval keeps
			// running because the stream isn't done.
			deps.rememberInteractionWorkspace(
				deps.contextKey,
				deps.targetWorkspaceId,
			);
			const nextUserInput = buildPendingUserInput(event, deps.model.id);
			deps.flushStreamMessages();
			deps.refreshSessionThreadFromDb(deps.cacheSessionId);
			if (!nextUserInput) {
				deps.storeActions.setSendError(
					deps.contextKey,
					"Unable to render user-input request: missing userInputId or modelId.",
				);
				deps.clearSendingState(deps.contextKey);
				return;
			}
			deps.applyUserInputEvent(deps.contextKey, nextUserInput);
			return;
		}

		if (event.kind === "done" || event.kind === "aborted") {
			if (deps.accumulator.frameId !== null) {
				window.cancelAnimationFrame(deps.accumulator.frameId);
				deps.accumulator.frameId = null;
			}
			deps.flushStreamMessages();
			deps.cleanup();
			deps.clearPendingPermissions(deps.contextKey);
			deps.clearPendingUserInput(deps.contextKey);
			deps.clearFastPrelude(deps.contextKey);

			if (event.kind === "done") {
				// `event.sessionId` is the *provider* session id (claude/codex
				// resume token) — only non-null from the second turn onward,
				// after the SDK has assigned a thread. Read-state tracking
				// keys off the helmor session id, so feeding the provider id
				// here would address a row that doesn't exist and
				// `mark_session_*` would silently no-op (drops the unread dot
				// on every follow-up turn).
				if (deps.targetWorkspaceId) {
					deps.onSessionCompleted?.(
						deps.targetSessionId,
						deps.targetWorkspaceId,
					);
				}
			} else if (deps.targetWorkspaceId) {
				deps.onSessionAborted?.(deps.targetSessionId, deps.targetWorkspaceId);
			}

			void deps.queryClient.invalidateQueries({
				queryKey: ["workspaceChanges"],
			});

			const adoptedSessionId =
				event.sessionId ??
				deps.streamingStore.getState().liveSessionsByContext[deps.contextKey]
					?.providerSessionId ??
				null;
			deps.storeActions.setLiveSession(deps.contextKey, {
				provider: event.provider,
				providerSessionId: adoptedSessionId,
			});
			deps.clearSendingState(deps.contextKey);

			if (event.persisted) {
				// Sidebar only — don't invalidate session messages here. The
				// streaming snapshot IS the correct data and its message IDs
				// differ from DB IDs, so a refetch would cause a full re-render
				// flicker.
				deps.invalidateConversationQueries(deps.targetWorkspaceId, null);
			}
			return;
		}

		if (event.kind === "error") {
			deps.cleanup();
			deps.clearPendingPermissions(deps.contextKey);
			deps.clearPendingUserInput(deps.contextKey);
			deps.clearFastPrelude(deps.contextKey);
			if (event.internal) {
				deps.pushToast(
					"Something went wrong. Please try again.",
					"Error",
					"destructive",
				);
			}
			deps.storeActions.setSendError(
				deps.contextKey,
				event.internal || event.persisted ? null : event.message,
			);
			deps.clearSendingState(deps.contextKey);

			if (event.persisted) {
				// Error path: DO invalidate session messages — the DB may have
				// partial data the snapshot doesn't reflect correctly.
				deps.invalidateConversationQueries(
					deps.targetWorkspaceId,
					deps.targetSessionId,
				);
			} else {
				restoreSnapshot(
					deps.queryClient,
					deps.cacheSessionId,
					deps.rollbackSnapshot,
				);
				if (!deps.isOverride) {
					deps.storeActions.setComposerRestore({
						contextKey: deps.contextKey,
						draft: deps.trimmedPrompt,
						images: [...deps.imagePaths],
						files: [...deps.filePaths],
						customTags: [...deps.customTags],
						nonce: Date.now(),
					});
				}
			}
		}
	};
}

/**
 * Caller-side helpers — building the flush primitives. The accumulator
 * lifetime is tied to one stream call, so we build these in a thin
 * factory and let the caller hand them to `createStreamEventDispatcher`
 * alongside the accumulator object itself.
 */
export function createStreamFlushers(opts: {
	accumulator: StreamAccumulator;
	queryClient: QueryClient;
	cacheSessionId: string;
	userMessageId: string;
	optimisticUserMessage: ThreadMessageLike;
	changesRefreshInterval: number;
	onFinalChangesRefresh?: () => void;
}): {
	flushStreamMessages: () => void;
	scheduleFlush: () => void;
	cleanup: () => void;
} {
	const flushStreamMessages = () => {
		opts.accumulator.frameId = null;
		clearFallbackTimer(opts.accumulator);
		if (!opts.accumulator.needsFlush) return;
		opts.accumulator.needsFlush = false;

		const partial = opts.accumulator.pendingPartial;
		let rendered: ThreadMessageLike[];
		if (!partial) {
			rendered = opts.accumulator.baseMessages;
		} else {
			// A subagent partial (`child:<parent>:…`) nests under its parent
			// tool call so the live tokens render inside the card instead of
			// flashing as a second top-level bubble. Everything else takes the
			// trailing-tail merge path.
			rendered =
				nestStreamingChildPartial(opts.accumulator.baseMessages, partial) ??
				stabilizeStreamingMessages([...opts.accumulator.baseMessages, partial]);
		}
		replaceStreamingTail(
			opts.queryClient,
			opts.cacheSessionId,
			opts.userMessageId,
			[opts.optimisticUserMessage, ...rendered],
		);
	};

	const scheduleFlush = () => {
		opts.accumulator.needsFlush = true;
		if (opts.accumulator.frameId === null) {
			opts.accumulator.frameId = window.requestAnimationFrame(() =>
				flushStreamMessages(),
			);
		}
		if (opts.accumulator.fallbackTimerId == null) {
			opts.accumulator.fallbackTimerId = window.setTimeout(() => {
				if (opts.accumulator.frameId !== null) {
					window.cancelAnimationFrame(opts.accumulator.frameId);
					opts.accumulator.frameId = null;
				}
				flushStreamMessages();
			}, STREAM_FLUSH_FALLBACK_MS);
		}
	};

	const cleanup = () => {
		window.clearInterval(opts.changesRefreshInterval);
		// Final Changes-diff refresh on stream end so the post-turn diff is fresh
		// even though the periodic refresh now runs every 7s (was 3s) mid-stream.
		opts.onFinalChangesRefresh?.();
		if (opts.accumulator.frameId !== null) {
			window.cancelAnimationFrame(opts.accumulator.frameId);
			opts.accumulator.frameId = null;
		}
		clearFallbackTimer(opts.accumulator);
	};

	return { flushStreamMessages, scheduleFlush, cleanup };
}
