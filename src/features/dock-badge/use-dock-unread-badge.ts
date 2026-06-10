import { useQuery } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { workspaceGroupsQueryOptions } from "@/lib/query-client";
import { isQuickPanelWindow } from "@/lib/window-role";
import { selectUnreadSessionCount } from "./selector";

/**
 * Drive the macOS Dock badge from the sidebar's workspace groups query cache.
 *
 * The badge count equals the unread quantity currently visible in the sidebar
 * query cache (summed across every non-archived workspace). When the count
 * drops to 0 we clear the badge by passing `undefined` to `setBadgeCount`.
 *
 * Design notes:
 * - Read-only against the existing `workspaceGroups` query — no new IPC, no new
 *   event subscription, no mutation of cached data. Every path that already
 *   invalidates this query (opening a workspace, window focus refetch, unread
 *   mutations) drives the badge automatically.
 * - Errors are swallowed so the badge call can never take down the renderer —
 *   on Windows the API is a no-op failure and we intentionally ignore it.
 * - Mount this once at the app shell. It renders nothing.
 */
export function useDockUnreadBadge(): void {
	const { data: groups } = useQuery(workspaceGroupsQueryOptions());
	const count = selectUnreadSessionCount(groups);

	useEffect(() => {
		// The Dock badge is app-wide; let the main window be its single writer.
		if (isQuickPanelWindow) return;
		// Wrap in try/catch because the Tauri window handle may lack
		// `setBadgeCount` entirely — e.g. in the Playwright E2E harness where
		// `@tauri-apps/api/window` is aliased to a stub, or in any future
		// non-Tauri surface. A missing method would throw synchronously, which
		// `.catch` cannot intercept, and React would treat it as a render
		// error and tear down the parent subtree.
		try {
			const win = getCurrentWindow();
			const nextValue = count > 0 ? count : undefined;
			// `undefined` removes the badge on macOS; any positive integer sets
			// it. macOS renders huge numbers itself (99+), so we don't cap.
			void win
				.setBadgeCount?.(nextValue)
				?.catch(() =>
					// Some macOS dev-runtime combinations appear to ignore the
					// numeric path while the string badge label still works.
					win.setBadgeLabel?.(
						nextValue === undefined ? undefined : String(nextValue),
					),
				)
				?.catch(() => {
					// Platforms without dock-badge support (Windows) or a missing
					// capability should never surface as a user-visible error.
				});
		} catch {
			// Missing Tauri runtime altogether — silently no-op.
		}
	}, [count]);
}
