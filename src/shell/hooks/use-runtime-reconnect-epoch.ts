/**
 * Track C (resilience): per-runtime "reconnect epoch" counter.
 *
 * The backend's auto-reconnect loop publishes
 * `RemoteReconnectAttempt { name, succeeded: true }` when a previously
 * Disconnected runtime is back online. Frontend hooks that depend on
 * the runtime being live (e.g. `useWorkspaceRemoteReattach`) need to
 * re-run their discovery effects on that signal so the desktop
 * automatically re-attaches to surviving agent sessions instead of
 * sitting silent until the user reopens the workspace.
 *
 * This hook returns a monotonic counter that increments every time a
 * matching `succeeded: true` event fires for the supplied runtime
 * name. Consumers thread it into their `useEffect` dep array — the
 * effect re-runs on every successful reconnect, and the journal +
 * cold-attach replay machinery (24q/24r/24t) closes the gap.
 *
 * Returns `0` for the synthetic `"local"` runtime — the local
 * sidecar doesn't go through the SSH reconnect path.
 */

import { useEffect, useRef, useState } from "react";
import { subscribeUiMutations } from "@/lib/api";

export function useRuntimeReconnectEpoch(runtimeName: string | null): number {
	const [epoch, setEpoch] = useState(0);
	// Latest target name in a ref so the channel callback always sees
	// the up-to-date value without resubscribing on every name change
	// the consumer might do.
	const targetRef = useRef<string | null>(runtimeName);
	targetRef.current = runtimeName;

	useEffect(() => {
		// The local runtime never goes through SSH reconnect — skip the
		// subscription entirely so a workspace with no remote binding
		// doesn't open a Tauri channel for nothing.
		if (!runtimeName || runtimeName === "local") return;
		let unlisten: (() => void) | undefined;
		let disposed = false;
		void subscribeUiMutations((event) => {
			if (disposed) return;
			if (event.type !== "remoteReconnectAttempt") return;
			if (event.succeeded !== true) return;
			if (event.name !== targetRef.current) return;
			// Bump on every successful attempt — the consumer's
			// effect deps array picks it up.
			setEpoch((prev) => prev + 1);
		}).then((stop) => {
			if (disposed) {
				stop();
				return;
			}
			unlisten = stop;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [runtimeName]);

	return epoch;
}
