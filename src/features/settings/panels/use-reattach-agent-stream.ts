import { useCallback, useEffect, useRef, useState } from "react";
import {
	type AgentStreamEvent,
	type ReattachedAgentEvent,
	reattachRemoteAgentSessionStream,
	releaseRemoteAgentStream,
	startAgentReattachStream,
} from "@/lib/api";

/// One captured event in the reattach log. Wrapped so the UI can
/// key-by-id without React warning about duplicate keys when the
/// daemon emits identical payloads (rare but possible —
/// repeated tool-use heartbeats, etc.).
export type ReattachLogEntry = {
	id: number;
	receivedAt: number;
	event: ReattachedAgentEvent;
};

/// Phase of the reattach lifecycle. The panel renders a
/// distinct affordance per phase:
///   - `idle`    — nothing happening; the user can click Reattach.
///   - `attaching` — RPC in flight.
///   - `streaming` — events flowing; the user can stop.
///   - `notFound` — the daemon reported the session expired; show
///                  a toast + reset to idle on next start.
///   - `error`   — RPC failed for some other reason; the error
///                 message goes into `error`.
export type ReattachPhase =
	| "idle"
	| "attaching"
	| "streaming"
	| "notFound"
	| "error";

export type ReattachAgentStreamState = {
	phase: ReattachPhase;
	error: string | null;
	events: ReattachLogEntry[];
	currentRequestId: string | null;
	/**
	 * Phase 24q-2: the daemon-reported journal high-water-mark
	 * captured at attach time. The panel surfaces this so an
	 * operator can verify `since_seq` semantics.
	 */
	lastSeq: number | null;
	/**
	 * Phase 24q-2: events the daemon replayed during attach.
	 * Counts events the desktop's local DB hadn't already persisted.
	 */
	replayedCount: number | null;
	/**
	 * Phase 24q-2: earliest seq the daemon's ring can still
	 * deliver when the desktop's `since_seq` predated the oldest
	 * entry. Non-null means events were evicted; the frontend
	 * should fall back to a full DB reload for the gap.
	 */
	replayGap: number | null;
	start: (
		runtimeName: string,
		requestId: string,
		helmorSessionId?: string,
	) => Promise<void>;
	stop: () => Promise<void>;
	clear: () => void;
};

/// Manage a single live raw-event reattach stream — the dev
/// panel's "watch the wire" affordance. Pairs with
/// `useChatReattachStream` (phase 24l) for the cooked, chat-
/// integrated equivalent. Keeping both lets the panel toggle
/// between operator-friendly raw JSON + the user-friendly
/// accumulator-rendered preview without duplicating the
/// lifecycle plumbing.
export function useReattachAgentStream(): ReattachAgentStreamState {
	const [phase, setPhase] = useState<ReattachPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [events, setEvents] = useState<ReattachLogEntry[]>([]);
	const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);
	const [lastSeq, setLastSeq] = useState<number | null>(null);
	const [replayedCount, setReplayedCount] = useState<number | null>(null);
	const [replayGap, setReplayGap] = useState<number | null>(null);
	// Sequencer for unique per-event keys. Plain monotonic counter
	// is simpler + faster than a UUID per event.
	const eventSequenceRef = useRef(0);
	// Track the latest request id in a ref so the unmount cleanup
	// can call release without depending on stale state.
	const currentRequestIdRef = useRef<string | null>(null);

	const stop = useCallback(async () => {
		const requestId = currentRequestIdRef.current;
		if (!requestId) return;
		currentRequestIdRef.current = null;
		setCurrentRequestId(null);
		setPhase("idle");
		try {
			await releaseRemoteAgentStream(requestId);
		} catch (err) {
			// Stopping should never throw a user-visible error —
			// the only failure mode is "subscription was already
			// gone" which is fine. Log + move on.
			console.warn(
				`useReattachAgentStream: release failed for ${requestId}`,
				err,
			);
		}
	}, []);

	const start = useCallback(
		async (
			runtimeName: string,
			requestId: string,
			helmorSessionId?: string,
		) => {
			// If a previous stream is running, tear it down first
			// so we never leak callbacks. The release call is
			// idempotent so a stale id won't error out.
			if (currentRequestIdRef.current) {
				const prior = currentRequestIdRef.current;
				currentRequestIdRef.current = null;
				try {
					await releaseRemoteAgentStream(prior);
				} catch {
					// swallow — see stop().
				}
			}
			setError(null);
			setEvents([]);
			setLastSeq(null);
			setReplayedCount(null);
			setReplayGap(null);
			setPhase("attaching");
			currentRequestIdRef.current = requestId;
			setCurrentRequestId(requestId);
			try {
				const result = await reattachRemoteAgentSessionStream(
					runtimeName,
					requestId,
					(event) => {
						const id = ++eventSequenceRef.current;
						setEvents((prev) => [
							...prev,
							{
								id,
								receivedAt: Date.now(),
								event,
							},
						]);
					},
					helmorSessionId,
				);
				// Race: the consumer may have called stop() while
				// the RPC was in flight. If currentRequestIdRef
				// has moved on, the new start owns the state —
				// don't clobber its phase. Only commit our phase
				// transition when we're still the owner.
				if (currentRequestIdRef.current !== requestId) return;
				if (result.found) {
					setPhase("streaming");
					setLastSeq(result.lastSeq);
					setReplayedCount(result.replayedCount);
					setReplayGap(result.replayGap ?? null);
				} else {
					setPhase("notFound");
					currentRequestIdRef.current = null;
					setCurrentRequestId(null);
				}
			} catch (err) {
				if (currentRequestIdRef.current !== requestId) return;
				setError(errorMessage(err));
				setPhase("error");
				currentRequestIdRef.current = null;
				setCurrentRequestId(null);
			}
		},
		[],
	);

	const clear = useCallback(() => {
		setEvents([]);
		setError(null);
		setLastSeq(null);
		setReplayedCount(null);
		setReplayGap(null);
	}, []);

	// On unmount, release any active subscription so the daemon
	// stops fueling a closure that points at a torn-down React
	// tree. Mirror of `useWorkspaceFileWatch`'s cleanup pattern.
	useEffect(() => {
		return () => {
			const requestId = currentRequestIdRef.current;
			if (!requestId) return;
			currentRequestIdRef.current = null;
			void releaseRemoteAgentStream(requestId).catch(() => {});
		};
	}, []);

	return {
		phase,
		error,
		events,
		currentRequestId,
		lastSeq,
		replayedCount,
		replayGap,
		start,
		stop,
		clear,
	};
}

// ── Phase 24l: chat-integrated reattach ─────────────────────────

/// Cooked event stream — the daemon's per-message events run
/// through the desktop's existing `MessagePipeline` accumulator
/// + emerge as `AgentStreamEvent`. The same envelope the chat's
/// `useStreaming` consumes on a fresh send, so a future slice
/// can route these straight into the chat with no shape
/// translation.
///
/// For now the dev panel renders them as a live preview: the
/// trailing `Update` carries `ThreadMessageLike[]` which the
/// preview displays as a simplified message list.
export type ChatReattachState = {
	phase: ReattachPhase;
	error: string | null;
	currentRequestId: string | null;
	/// Last `Update.messages` payload — the full conversation as
	/// the daemon has rendered it so far. `null` until the first
	/// Update lands.
	messages: import("@/lib/api").ThreadMessageLike[] | null;
	/// Trailing partial message (in-progress assistant turn).
	/// Replaced on every `streamingPartial` event; cleared by
	/// the next `Update`. Mirrors the chat's pendingPartial
	/// concept so a future direct chat integration doesn't have
	/// to reimplement the same gluing.
	partial: import("@/lib/api").ThreadMessageLike | null;
	/// Set on `done` / `aborted` / `error` — drives the panel's
	/// terminal-state chip ("Turn finished", "Aborted: reason",
	/// "Error: ...").
	terminalLabel: string | null;
	start: (args: import("@/lib/api").AgentReattachRequest) => Promise<void>;
	stop: () => Promise<void>;
	clear: () => void;
};

export function useChatReattachStream(): ChatReattachState {
	const [phase, setPhase] = useState<ReattachPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);
	const [messages, setMessages] = useState<
		import("@/lib/api").ThreadMessageLike[] | null
	>(null);
	const [partial, setPartial] = useState<
		import("@/lib/api").ThreadMessageLike | null
	>(null);
	const [terminalLabel, setTerminalLabel] = useState<string | null>(null);
	const currentRequestIdRef = useRef<string | null>(null);

	const stop = useCallback(async () => {
		const requestId = currentRequestIdRef.current;
		if (!requestId) return;
		currentRequestIdRef.current = null;
		setCurrentRequestId(null);
		setPhase("idle");
		// The cooked stream has no `release_remote_agent_session_stream`
		// counterpart yet — the reattach event loop tears itself down
		// when the daemon emits a terminal event or the connection
		// drops. Future slice: add an explicit abort command if the
		// operator wants to detach mid-stream.
	}, []);

	const start = useCallback(
		async (args: import("@/lib/api").AgentReattachRequest) => {
			setError(null);
			setMessages(null);
			setPartial(null);
			setTerminalLabel(null);
			setPhase("attaching");
			currentRequestIdRef.current = args.requestId;
			setCurrentRequestId(args.requestId);
			const onEvent = (event: AgentStreamEvent) => {
				if (currentRequestIdRef.current !== args.requestId) return;
				switch (event.kind) {
					case "update":
						setMessages(event.messages);
						setPartial(null);
						return;
					case "streamingPartial":
						setPartial(event.message);
						return;
					case "done":
						setTerminalLabel("Turn finished.");
						setPhase("idle");
						currentRequestIdRef.current = null;
						setCurrentRequestId(null);
						return;
					case "aborted":
						setTerminalLabel(
							event.reason ? `Aborted: ${event.reason}.` : "Aborted.",
						);
						setPhase("idle");
						currentRequestIdRef.current = null;
						setCurrentRequestId(null);
						return;
					case "error":
						setTerminalLabel(`Error: ${event.message}`);
						setError(event.message);
						setPhase("error");
						currentRequestIdRef.current = null;
						setCurrentRequestId(null);
						return;
					default:
						// permissionRequest / userInputRequest /
						// planCaptured don't have a panel UI today.
						// Surface a generic "Pending: <kind>" label
						// so the operator at least knows something
						// is waiting on a user response on the
						// other end.
						setTerminalLabel(`Pending: ${event.kind}`);
				}
			};
			try {
				await startAgentReattachStream(args, onEvent);
				if (currentRequestIdRef.current !== args.requestId) return;
				setPhase("streaming");
			} catch (err) {
				if (currentRequestIdRef.current !== args.requestId) return;
				setError(errorMessage(err));
				setPhase("error");
				currentRequestIdRef.current = null;
				setCurrentRequestId(null);
			}
		},
		[],
	);

	const clear = useCallback(() => {
		setMessages(null);
		setPartial(null);
		setTerminalLabel(null);
		setError(null);
	}, []);

	return {
		phase,
		error,
		currentRequestId,
		messages,
		partial,
		terminalLabel,
		start,
		stop,
		clear,
	};
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "Reattach failed.";
}
