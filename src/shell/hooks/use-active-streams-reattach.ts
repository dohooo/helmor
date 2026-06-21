import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { helmorQueryKeys } from "@/lib/query-client";
import { useCompanionConnectionState } from "@/shell/hooks/use-companion-connection-state";

/**
 * Re-attach the active-stream watcher after a remote (re)connect.
 *
 * On any non-online → online transition (connecting → online after a switch, or
 * reconnecting → online after a drop) this re-fetches active streams from the
 * (R2-restored) sandbox DB so `use-watch-session-stream` re-attaches the
 * watcher. The remote `/v1/stream` channel currently delivers only hello/ping
 * (no `ActiveStreamsChanged` on reconnect), so THIS invalidate is the PRIMARY
 * re-attach trigger after a (re)connect — not a fallback. Do not remove it.
 *
 * Lives here (headless, mounted shell-wide via {@link AppOverlays}) rather than
 * in the sidebar Cloud switch: that switch renders `null` for the browser
 * companion / non-Tauri case, but this effect must run for ALL remote transports
 * (team AND browser companion). On a native desktop transport the state is
 * pinned to `online`, so this never fires there.
 */
export function useActiveStreamsReattach(): void {
	const connection = useCompanionConnectionState();
	const queryClient = useQueryClient();
	const prevConnection = useRef(connection);

	useEffect(() => {
		if (prevConnection.current !== "online" && connection === "online") {
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.activeStreams,
			});
		}
		prevConnection.current = connection;
	}, [connection, queryClient]);
}
