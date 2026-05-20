/**
 * Track C6: kick a reconnect for every `Disconnected` remote runtime
 * the moment the OS reports network connectivity is back.
 *
 * The desktop's `auto_reconnect.rs` already retries on a 5-second
 * cadence, but if the user closes their laptop and walks down the
 * block, the reconnect tick happens up to 5s after Wi-Fi is back.
 * This hook collapses that window: the browser's `online` event
 * fires within milliseconds of network restoration, and we
 * immediately invoke `reconnectRemoteRuntime` for every entry in a
 * non-Connected state.
 *
 * Implementation notes:
 *
 * - We only react to `online` events, not `offline` — there's no
 *   action to take when the link drops (the next ping will fail +
 *   the auto-reconnect loop will take over). Watching `offline` too
 *   would surface noise without changing behavior.
 * - The hook is best-effort: reconnect failures swallow silently
 *   (the auto-reconnect loop will retry on its own cadence). Toasts
 *   from this surface would interleave with the existing banner
 *   noise during a real outage.
 * - Designed to mount exactly once at the shell layer; multiple
 *   mounts would multiply the reconnect calls per event. Pair with
 *   `useUiSyncBridge` in the app's outer shell.
 */

import { useEffect } from "react";
import {
	listRemoteRuntimes,
	type RuntimeEntry,
	reconnectRemoteRuntime,
} from "@/lib/api";

/// Trigger a reconnect attempt for every `RuntimeState` that isn't
/// `connected`. Used both from the OS `online` event handler and
/// from tests that drive the kick path directly.
async function kickReconnects() {
	let entries: RuntimeEntry[];
	try {
		entries = await listRemoteRuntimes();
	} catch (err) {
		// `listRemoteRuntimes` failing means the backend is in a
		// degraded state we can't reconcile from here. The
		// auto-reconnect loop runs independently + will resolve it
		// on its own cadence.
		console.debug("useOnlineReconnectKick: listRemoteRuntimes failed", err);
		return;
	}
	const toKick = entries.filter(
		(entry) => !entry.isLocal && entry.state.type !== "connected",
	);
	if (toKick.length === 0) return;
	// Fire-and-forget per entry. We never await the reconnect
	// promise — a stuck reconnect shouldn't block the kick loop
	// for the next runtime.
	for (const entry of toKick) {
		reconnectRemoteRuntime(entry.name).catch((err) => {
			console.debug(
				`useOnlineReconnectKick: reconnect ${entry.name} failed`,
				err,
			);
		});
	}
}

export function useOnlineReconnectKick() {
	useEffect(() => {
		const handler = () => {
			void kickReconnects();
		};
		window.addEventListener("online", handler);
		return () => {
			window.removeEventListener("online", handler);
		};
	}, []);
}

// Exported for tests so they can drive the kick path without
// pretending to fire a real `online` event through the JSDOM.
export const __testing__ = { kickReconnects };
