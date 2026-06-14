// Thin top banner shown while a team / companion sandbox is connecting or
// reconnecting. Per the Team Cloud Sandbox UX (§10.5): offline is a LOADING
// state, not an error and not a local-cache fallback — a sleeping sandbox just
// takes a moment to wake. Two loading sub-states, distinguished only by copy:
//   "connecting"   — fresh entry into team mode (the user just switched, or a
//                    companion tab loaded). The Worker is presumed cold;
//                    "Connecting to your team workspace…" greets the switch.
//   "reconnecting" — a previously-online stream dropped mid-session and is
//                    retrying; "Reconnecting to the team sandbox…".
// Single-user / native desktop stays "online" (the SSE loop that drives this
// only runs on a remote transport), so this renders nothing there.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { isRemoteTransport } from "@/lib/ipc";
import { helmorQueryKeys } from "@/lib/query-client";
import { useCompanionConnectionState } from "@/shell/hooks/use-companion-connection-state";

export function ReconnectingBanner() {
	const connection = useCompanionConnectionState();
	const queryClient = useQueryClient();
	const prevConnection = useRef(connection);

	// On any loading → online transition (connecting → online after a switch, or
	// reconnecting → online after a drop), re-fetch active streams from the
	// (R2-restored) sandbox DB so `use-watch-session-stream` re-attaches the
	// watcher. NOTE: the remote /v1/stream channel currently delivers only
	// hello/ping (no ActiveStreamsChanged on reconnect), so THIS invalidate is
	// the PRIMARY re-attach trigger after a (re)connect — not a fallback. Do not
	// remove it. (A backend ActiveStreamsChanged-on-reconnect re-emit would be a
	// future enhancement, not a current dependency.)
	useEffect(() => {
		if (prevConnection.current !== "online" && connection === "online") {
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.activeStreams,
			});
		}
		prevConnection.current = connection;
	}, [connection, queryClient]);

	// Gate on the remote transport (team / companion) AND a loading state.
	// `connectionState` is already pinned to "online" on a native transport, so
	// the second check alone would suffice — the explicit transport gate makes
	// the single-user "render nothing" contract obvious at the call site.
	if (!isRemoteTransport() || connection === "online") return null;

	const isConnecting = connection === "connecting";
	return (
		<div
			role="status"
			aria-live="polite"
			className="fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-0.5 bg-muted/95 px-4 py-2 text-center text-muted-foreground text-xs shadow-sm backdrop-blur-sm"
		>
			<div className="flex items-center gap-2 font-medium text-foreground">
				<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
				<span>
					{isConnecting
						? "Connecting to your team workspace…"
						: "Reconnecting to the team sandbox…"}
				</span>
			</div>
			<span className="text-[0.6875rem] text-muted-foreground">
				This can take a moment while the sandbox wakes up.
			</span>
		</div>
	);
}
