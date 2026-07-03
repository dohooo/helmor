import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { helmorQueryKeys } from "@/lib/query-client";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import { useCompanionConnectionState } from "@/shell/hooks/use-companion-connection-state";

/**
 * Per-workspace/session state a teammate could have mutated while we were
 * disconnected. The remote `/v1/stream` replays nothing on reconnect, so every
 * `UiMutationEvent` emitted during the drop is lost — we re-sync these by root
 * key, but ONLY the observed instances (R2-B narrowing): an observed
 * `workspaceDetail`/`sessionMessages`/… query is by construction the currently
 * displayed workspace/session; everything else refetches on next mount via
 * ordinary staleness anyway, so sweeping it here only amplified reconnect
 * storms. NOTE: the sidebar lists (`workspaceGroups` / `archivedWorkspaces`)
 * are deliberately NOT in this set — they go through
 * `requestSidebarReconcile` below so a reconnect can't punch through the
 * sidebar-mutation gate mid-mutation (the R8 amplifier).
 */
const RECONNECT_RESYNC_PER_WORKSPACE_ROOTS: ReadonlySet<string> = new Set([
	"workspaceDetail",
	"workspaceSessions",
	"sessionMessages",
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
 *  2. reconciles the sidebar lists through the mutation gate (never a direct
 *     invalidate — see `sidebar-mutation-gate.ts`'s contract);
 *  3. re-syncs `repositories` globally (low-frequency, cheap, and a missed
 *     teammate repo-add would otherwise be an undiagnosable stale list);
 *  4. re-syncs the observed per-workspace queries (= what's on screen).
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
			requestSidebarReconcile(queryClient);
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.repositories,
			});
			void queryClient.invalidateQueries({
				predicate: (query) => {
					const root = (query.queryKey as QueryKey)[0];
					return (
						typeof root === "string" &&
						RECONNECT_RESYNC_PER_WORKSPACE_ROOTS.has(root) &&
						query.getObserversCount() > 0
					);
				},
			});
		}
		prevConnection.current = connection;
	}, [connection, queryClient]);
}
