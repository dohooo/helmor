import { useEffect, useRef, useState } from "react";
import { useCompanionConnectionState } from "@/shell/hooks/use-companion-connection-state";

/**
 * Presentational connection phase for the sidebar Cloud indicator. Wraps the raw
 * transport state ({@link useCompanionConnectionState}: `online` | `connecting`
 * | `reconnecting`) and adds ONE derived phase: `disconnected`.
 *
 * `disconnected` is a purely cosmetic escalation — it does NOT exist in the core
 * `ipc.ts` state machine. A cold sandbox legitimately takes up to ~120s to wake,
 * so "non-online" alone is not an error. Only when connecting/reconnecting has
 * persisted CONTINUOUSLY past the cold-start ceiling do we flip to
 * `disconnected` (red) to signal "this is taking too long; something's wrong".
 *
 * Timer rules:
 *   - Start the countdown when state leaves `online`.
 *   - `connecting` ↔ `reconnecting` are BOTH non-online, so swapping between
 *     them does NOT reset the timer (a drop mid-cold-start keeps escalating).
 *   - Returning to `online` clears the timer and the `disconnected` flag.
 */

/** Comfortably past the ~120s cold-start ceiling, with margin for a slow wake —
 *  escalate to red only after this so a healthy-but-slow cold start never flashes
 *  red moments before it connects. */
const DISCONNECT_AFTER_MS = 165_000;

export type ConnectionPhase =
	| "online"
	| "connecting"
	| "reconnecting"
	| "disconnected";

export interface ConnectionStatus {
	phase: ConnectionPhase;
}

export function useCompanionConnectionStatus(): ConnectionStatus {
	const state = useCompanionConnectionState();
	const [disconnected, setDisconnected] = useState(false);
	// Hold the timer across renders so connecting↔reconnecting transitions (which
	// re-run the effect) don't restart the countdown.
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (state === "online") {
			// Recovered: drop any pending escalation and clear the flag.
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			setDisconnected(false);
			return;
		}
		// Non-online: arm the escalation ONCE and let it run uninterrupted across
		// connecting↔reconnecting swaps (only arm if not already counting).
		if (timerRef.current === null) {
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				setDisconnected(true);
			}, DISCONNECT_AFTER_MS);
		}
	}, [state]);

	// Clear the timer on unmount so a pending escalation can't fire into an
	// unmounted component.
	useEffect(() => {
		return () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
	}, []);

	if (state === "online") return { phase: "online" };
	if (disconnected) return { phase: "disconnected" };
	return { phase: state };
}
