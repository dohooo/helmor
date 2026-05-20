/**
 * Workspace-level auto-reattach (phase 24m).
 *
 * When the user opens a workspace whose remote runtime is currently
 * streaming an in-flight agent turn for *this* helmor session, the
 * chat should automatically follow that turn — same UX as Zed
 * Remote / JetBrains Gateway / VS Code Remote-SSH where the live
 * editor pane reconnects on its own.
 *
 * The flow:
 *
 * 1. On mount (or when `sessionId` / `runtimeName` changes), query
 *    `list_remote_agent_sessions` against the runtime.
 * 2. If a returned session matches the workspace's helmor session id
 *    AND the chat isn't already streaming the same session through a
 *    fresh send, open `start_agent_message_reattach_stream`.
 * 3. The cooked `AgentStreamEvent` envelopes feed into the chat's
 *    session-thread cache the same shape a fresh send would. Persisted
 *    history snapshot taken at attach time is the immutable prefix;
 *    the daemon-rendered turn messages append to it on each `update`.
 * 4. Terminal events invalidate the session thread query so the chat
 *    re-fetches whatever the desktop's DB ended up with (which is the
 *    canonical record once the daemon's persistence side-effects land).
 *
 * Scope:
 * - Skipped entirely for local-bound workspaces (`runtimeName === null`
 *   or `"local"`). The local sidecar's send path already owns those.
 * - Skipped while another stream owns the session (avoids racing a
 *   fresh composer submit that's in flight).
 * - The reattach loop releases on unmount + on session change so
 *   switching workspaces tears down the live subscription cleanly.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	type AgentStreamEvent,
	listRemoteAgentSessions,
	startAgentReattachStream,
	type ThreadMessageLike,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	readSessionThread,
	sessionThreadCacheKey,
	shareMessages,
} from "@/lib/session-thread-cache";

export type WorkspaceRemoteReattachState = {
	/** `true` while the desktop is actively following a live remote
	 * turn for the current session. Drives the workspace-header chip. */
	isReattaching: boolean;
	/** Daemon-side request id we're attached to (`null` when idle). */
	currentRequestId: string | null;
	/** Set on `done` / `aborted` / `error` — the chip uses this to
	 * surface a transient "Caught up" / "Remote aborted" label before
	 * the chat re-fetches from DB and unmounts the chip. */
	terminalLabel: string | null;
	/** Last error message from the reattach loop or attach RPC. */
	error: string | null;
	/**
	 * Phase 24r: total journal entries the daemon is flushing on
	 * this attach. `null` until the attach RPC resolves. The chip
	 * renders "Rebuilding history (N events)" when `> 0`.
	 */
	replayedCount: number | null;
	/**
	 * Phase 24r: earliest seq the daemon's ring can still deliver
	 * when our `since_seq` predated the oldest entry. `null` means
	 * the cold replay was clean; a value means partial replay — the
	 * chip surfaces a "history unavailable" banner.
	 */
	replayGap: number | null;
};

const IDLE_STATE: WorkspaceRemoteReattachState = {
	isReattaching: false,
	currentRequestId: null,
	terminalLabel: null,
	error: null,
	replayedCount: null,
	replayGap: null,
};

export function useWorkspaceRemoteReattach({
	sessionId,
	workspaceId,
	runtimeName,
	provider,
	modelId,
	workingDirectory,
	isAlreadyStreaming,
}: {
	sessionId: string | null;
	workspaceId: string | null;
	runtimeName: string | null;
	provider: string | null;
	modelId: string | null;
	workingDirectory: string | null;
	/** When `true`, the composer-driven streaming pipeline already owns
	 * this session — skip auto-reattach to avoid clobbering its cache
	 * writes. */
	isAlreadyStreaming: boolean;
}): WorkspaceRemoteReattachState {
	const queryClient = useQueryClient();
	const [state, setState] = useState<WorkspaceRemoteReattachState>(IDLE_STATE);

	// Capture the latest "do we still own this attach" answer in a ref
	// so the async callback can short-circuit when the user has
	// switched sessions out from under us.
	const activeRequestIdRef = useRef<string | null>(null);
	const persistedPrefixRef = useRef<ThreadMessageLike[]>([]);

	useEffect(() => {
		// Don't try to reattach for local workspaces — the local
		// sidecar already owns those.
		if (!sessionId || !runtimeName || runtimeName === "local") {
			activeRequestIdRef.current = null;
			setState(IDLE_STATE);
			return;
		}
		if (isAlreadyStreaming) {
			activeRequestIdRef.current = null;
			setState(IDLE_STATE);
			return;
		}

		let disposed = false;
		void (async () => {
			let sessions: Awaited<ReturnType<typeof listRemoteAgentSessions>>;
			try {
				sessions = await listRemoteAgentSessions(runtimeName);
			} catch (err) {
				// agent.list failure is non-fatal — the workspace stays
				// usable, we just can't auto-reattach. Surface the error
				// for diagnostics + bail.
				if (!disposed) {
					setState({
						...IDLE_STATE,
						error: errorMessage(err),
					});
				}
				return;
			}
			if (disposed) return;

			// Look for a session whose helmor session id matches the
			// workspace's current session. The daemon mints the request
			// id; the desktop side keeps its helmor session id stable
			// across reconnects.
			// Phase 24t: skip `endedReplayOnly` rows on the auto-attach
			// path — those are sessions whose sidecar process is gone
			// (daemon restarted, original session terminated cleanly).
			// The desktop's local DB already holds the conversation;
			// no need to flush the on-disk journal again. Only the dev
			// panel's explicit "browse history" action attaches to
			// these.
			const match = sessions.find(
				(entry) =>
					entry.helmorSessionId === sessionId && entry.state === "live",
			);
			if (!match) {
				setState(IDLE_STATE);
				return;
			}

			activeRequestIdRef.current = match.requestId;
			// Snapshot the persisted thread so reattach's daemon-rendered
			// turn messages append to it instead of replacing the whole
			// conversation. The snapshot is read-only after this point —
			// subsequent persistence side-effects on the same key are the
			// chat's responsibility, not ours.
			persistedPrefixRef.current =
				readSessionThread(queryClient, sessionId) ?? [];

			setState({
				isReattaching: true,
				currentRequestId: match.requestId,
				terminalLabel: null,
				error: null,
				replayedCount: null,
				replayGap: null,
			});

			try {
				const response = await startAgentReattachStream(
					{
						requestId: match.requestId,
						helmorSessionId: sessionId,
						workspaceId: workspaceId ?? undefined,
						provider: provider ?? match.provider ?? "claude",
						modelId: modelId ?? match.provider ?? "claude",
						workingDirectory:
							workingDirectory ?? match.workspaceDir ?? undefined,
					},
					(event: AgentStreamEvent) => {
						if (activeRequestIdRef.current !== match.requestId) return;
						handleEvent(event, {
							queryClient,
							sessionId,
							workspaceId,
							setState,
							prefix: persistedPrefixRef.current,
							requestId: match.requestId,
						});
					},
				);
				if (disposed) return;
				if (activeRequestIdRef.current !== match.requestId) return;
				// Phase 24r: stash the daemon's replay diagnostics so the
				// header chip can render "rebuilding N events" + the gap
				// banner. The streaming loop is already running; the
				// response carries these alongside `accepted=true`.
				setState({
					isReattaching: true,
					currentRequestId: match.requestId,
					terminalLabel: null,
					error: null,
					replayedCount: response.replayedCount,
					replayGap: response.replayGap ?? null,
				});
			} catch (err) {
				if (disposed) return;
				if (activeRequestIdRef.current !== match.requestId) return;
				setState({
					isReattaching: false,
					currentRequestId: null,
					terminalLabel: null,
					error: errorMessage(err),
					replayedCount: null,
					replayGap: null,
				});
				activeRequestIdRef.current = null;
			}
		})();

		return () => {
			disposed = true;
			// We don't call a teardown RPC — the daemon's `agent.event`
			// subscription closes when the desktop drops the channel.
			// Clearing the request-id ref makes any straggler event a
			// no-op.
			activeRequestIdRef.current = null;
		};
	}, [
		sessionId,
		workspaceId,
		runtimeName,
		provider,
		modelId,
		workingDirectory,
		isAlreadyStreaming,
		queryClient,
	]);

	return state;
}

type EventContext = {
	queryClient: ReturnType<typeof useQueryClient>;
	sessionId: string;
	workspaceId: string | null;
	prefix: ThreadMessageLike[];
	requestId: string;
	setState: (next: WorkspaceRemoteReattachState) => void;
};

function handleEvent(event: AgentStreamEvent, ctx: EventContext) {
	switch (event.kind) {
		case "update":
			writeTail(ctx, event.messages, null);
			return;
		case "streamingPartial":
			writeTail(ctx, null, event.message);
			return;
		case "done":
			ctx.setState({
				isReattaching: false,
				currentRequestId: null,
				terminalLabel: "Caught up.",
				error: null,
				replayedCount: null,
				replayGap: null,
			});
			invalidateThread(ctx);
			return;
		case "aborted":
			ctx.setState({
				isReattaching: false,
				currentRequestId: null,
				terminalLabel: event.reason
					? `Remote aborted: ${event.reason}.`
					: "Remote aborted.",
				error: null,
				replayedCount: null,
				replayGap: null,
			});
			invalidateThread(ctx);
			return;
		case "error":
			ctx.setState({
				isReattaching: false,
				currentRequestId: null,
				terminalLabel: null,
				error: event.message,
				replayedCount: null,
				replayGap: null,
			});
			invalidateThread(ctx);
			return;
		default:
			// permissionRequest / userInputRequest / planCaptured fall
			// through silently — the desktop doesn't own the canUseTool
			// hooks for a reattached turn (the original sender does), so
			// surfacing the modal here would be misleading. The thread
			// refreshes once the turn terminates and the daemon's
			// persisted record is the source of truth.
			return;
	}
}

function writeTail(
	ctx: EventContext,
	messages: ThreadMessageLike[] | null,
	partial: ThreadMessageLike | null,
) {
	const cacheKey = sessionThreadCacheKey(ctx.sessionId);
	const tail = messages ?? [];
	const composed = partial ? [...tail, partial] : tail;
	ctx.queryClient.setQueryData<ThreadMessageLike[]>(cacheKey, (prev) => {
		const next = [...ctx.prefix, ...composed];
		return shareMessages(prev ?? [], next);
	});
}

function invalidateThread(ctx: EventContext) {
	void ctx.queryClient.invalidateQueries({
		queryKey: helmorQueryKeys.sessionMessages(ctx.sessionId),
	});
	if (ctx.workspaceId) {
		void ctx.queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.workspaceSessions(ctx.workspaceId),
		});
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "Reattach failed.";
}
