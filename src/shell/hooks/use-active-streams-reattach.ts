import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { helmorQueryKeys } from "@/lib/query-client";
import { useCompanionConnectionState } from "@/shell/hooks/use-companion-connection-state";

/**
 * Shared-state queries a teammate could have mutated while we were disconnected.
 * The remote `/v1/stream` replays nothing on reconnect, so every `UiMutationEvent`
 * emitted during the drop is lost — we conservatively re-sync these by root key.
 * A predicate sweep only refetches OBSERVED queries; inactive ones just go stale
 * and refetch on next mount, so the cost is bounded to what's on screen.
 */
const RECONNECT_RESYNC_ROOTS: ReadonlySet<string> = new Set([
	"workspaceGroups",
	"workspaceDetail",
	"workspaceSessions",
	"sessionMessages",
	"repositories",
	"workspaceForge",
	"workspaceForgeActionStatus",
	"workspaceGitActionStatus",
	"workspaceChangeRequest",
]);

/**
 * Re-attach + re-sync after a remote (re)connect.
 *
 * On any non-online → online transition (connecting → online after a switch, or
 * reconnecting → online after a drop) this:
 *  1. invalidates active streams so `use-watch-session-stream` re-attaches the
 *     watcher to the (R2-restored) sandbox DB — the remote `/v1/stream` channel
 *     delivers only hello/ping on reconnect (no `ActiveStreamsChanged` re-emit),
 *     so THIS invalidate is the PRIMARY re-attach trigger, not a fallback;
 *  2. re-syncs the shared-state queries (sidebar, per-workspace detail/sessions/
 *     unread, messages, repos, git/forge) a teammate could have mutated during
 *     the drop, since those `UiMutationEvent`s were lost with no replay.
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
			void queryClient.invalidateQueries({
				predicate: (query) => {
					const root = (query.queryKey as QueryKey)[0];
					return typeof root === "string" && RECONNECT_RESYNC_ROOTS.has(root);
				},
			});
		}
		prevConnection.current = connection;
	}, [connection, queryClient]);
}
