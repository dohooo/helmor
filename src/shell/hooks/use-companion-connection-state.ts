import { useSyncExternalStore } from "react";
import {
	getCompanionConnectionState,
	subscribeCompanionConnection,
} from "@/lib/ipc";

/**
 * Reactive transport connection state. `"reconnecting"` means the shared SSE
 * channel dropped and is retrying (typically a sleeping team sandbox cold
 * starting) — the shell shows a loading banner, never an error. Always
 * `"online"` on the native desktop transport.
 */
export function useCompanionConnectionState() {
	return useSyncExternalStore(
		subscribeCompanionConnection,
		getCompanionConnectionState,
		getCompanionConnectionState,
	);
}
