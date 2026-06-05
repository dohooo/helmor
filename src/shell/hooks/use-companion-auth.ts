import { useSyncExternalStore } from "react";
import { getCompanionAuthState, subscribeCompanionAuth } from "@/lib/ipc";

/**
 * Reactive companion auth state. `"unauthed"` means the pairing token is
 * missing or rejected and the shell should show the pairing screen instead of
 * the app. Always `"ok"` in the native desktop runtime.
 */
export function useCompanionAuthState() {
	return useSyncExternalStore(
		subscribeCompanionAuth,
		getCompanionAuthState,
		getCompanionAuthState,
	);
}
