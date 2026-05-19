import { useCallback, useEffect, useRef, useState } from "react";
import {
	type ReattachedAgentEvent,
	reattachRemoteAgentSessionStream,
	releaseRemoteAgentStream,
} from "@/lib/api";

/// One captured event in the reattach log. Wrapped so the UI can
/// key-by-id without React warning about duplicate keys when the
/// daemon emits identical raw payloads (rare but possible —
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
	start: (runtimeName: string, requestId: string) => Promise<void>;
	stop: () => Promise<void>;
	clear: () => void;
};

/// Manage a single live reattach stream. Multiple concurrent
/// streams would require a manager-per-stream pattern; for the
/// dev-panel surface "one at a time" is the right ergonomics —
/// the user picks a session, watches it, picks another. A
/// second `start` while one is running first stops the prior
/// stream so the panel only ever shows one event log at a time.
export function useReattachAgentStream(): ReattachAgentStreamState {
	const [phase, setPhase] = useState<ReattachPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [events, setEvents] = useState<ReattachLogEntry[]>([]);
	const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);
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

	const start = useCallback(async (runtimeName: string, requestId: string) => {
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
			);
			// Race: the consumer may have called stop() while
			// the RPC was in flight. If currentRequestIdRef
			// has moved on, the new start owns the state —
			// don't clobber its phase. Only commit our phase
			// transition when we're still the owner.
			if (currentRequestIdRef.current !== requestId) return;
			if (result.found) {
				setPhase("streaming");
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
	}, []);

	const clear = useCallback(() => {
		setEvents([]);
		setError(null);
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
