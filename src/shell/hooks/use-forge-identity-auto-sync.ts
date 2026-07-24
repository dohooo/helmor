import { useEffect, useRef } from "react";
import { authorizeCloudForgeIdentity } from "@/lib/api";
import { isTauriRuntime } from "@/lib/platform";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";
import { useCompanionConnectionState } from "@/shell/hooks/use-companion-connection-state";

/** Min gap between auto-syncs so a flapping SSE reconnect doesn't re-spawn
 *  `gh auth token` + re-PUT on every blip. Fresh enough for token rotation
 *  (rare); a connect after this gap re-syncs. */
const MIN_RESYNC_GAP_MS = 5 * 60_000;

/**
 * Team mode (desktop only): on each (re)connect, silently push THIS member's
 * forge creds (gh token + glab config) to their `ForgeIdentity` broker so the
 * shared cloud sandbox can act as them on git/gh/glab. No button — joining /
 * connecting IS the opt-in (per-member by design). Best-effort: a machine with
 * no gh/glab just no-ops; errors are swallowed so the shell never blocks.
 *
 * LOCAL_ONLY: the command reads THIS Mac's keychain / config, so it runs only on
 * the Tauri host — a browser companion client has nothing to extract and skips.
 */
export function useForgeIdentityAutoSync(): void {
	const connection = useCompanionConnectionState();
	const previous = useRef(connection);
	const lastSyncMs = useRef(0);

	useEffect(() => {
		const cameOnline = previous.current !== "online" && connection === "online";
		previous.current = connection;
		if (!cameOnline) return;
		if (!isTauriRuntime() || !isTeamModeActive()) return;

		const now = Date.now();
		if (now - lastSyncMs.current < MIN_RESYNC_GAP_MS) return;
		const config = getTeamConfig();
		if (!config) return;

		lastSyncMs.current = now;
		void authorizeCloudForgeIdentity(config.url, config.token).catch(() => {
			// No gh/glab on this machine, or a transient Worker error — the next
			// connect past the throttle window retries.
		});
	}, [connection]);
}
