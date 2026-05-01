// Focus-driven liveness check for "is this (provider, host) still
// authenticated outside Helmor?". The heavyweight `forgeAccounts`
// query also refetches on focus (`staleTime: Infinity` +
// `refetchOnWindowFocus: "always"`), but it can't tell us *what*
// changed — only that the latest fetch landed. This hook plugs the
// gap: a cheap `gh auth status --json hosts` per host whose result
// we diff against the previous probe, so the *delta* drives extra
// reconciliation that the bare `forgeAccounts` refetch can't do
// (`backfillForgeRepoBindings`, plus invalidating workspace-scoped
// caches that aren't tied to the global account roster).
//
// Mirrors the inspector's git-section-header behavior (which detects
// auth loss via `workspaceForgeActionStatus`'s focus refetch + 401
// classification), but operates at host scope instead of workspace
// scope so the Settings → Accounts panel can react when ANY login on
// that host appears or disappears.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import {
	backfillForgeRepoBindings,
	type ForgeProvider,
	listForgeLogins,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";

const POLL_STALE_TIME_MS = 0;

/// Probes `(provider, host)`'s logged-in login set on every window
/// focus. On a delta vs. the previous probe (account added or removed
/// from outside Helmor) it does the full reconciliation:
///
///   1. Invalidate the heavy `forgeAccountsAll` roster + the
///      `repositories` list so Settings / sidebar UIs refresh.
///   2. Invalidate the **workspace-scoped** views — chip header
///      (`workspaceAccountProfile`), inspector forge section
///      (`workspaceForge`) and PR/MR status
///      (`workspaceForgeActionStatus`). Their query options are
///      `staleTime: Infinity`, so without explicit invalidation here
///      the chip would keep showing the logged-out account's avatar
///      forever.
///   3. Run `backfillForgeRepoBindings()` so any repo bound to the
///      now-gone login gets cleared / re-bound to whichever signed-in
///      account still has access. Without this the DB row keeps the
///      stale `forge_login` and the chip's fallback rendering
///      surfaces the old handle even after step 2 forces a refetch.
export function useForgeLoginsHealth(provider: ForgeProvider, host: string) {
	const queryClient = useQueryClient();
	// Hold the last observed login set across query refetches. `useRef`
	// is fine here even though it's read inside an async closure — the
	// closure captures the same ref object, so subsequent runs see the
	// latest mutation.
	const previousRef = useRef<Set<string> | null>(null);

	return useQuery({
		queryKey: helmorQueryKeys.forgeLogins(provider, host),
		queryFn: async () => {
			const next = await listForgeLogins(provider, host);
			const nextSet = new Set(next);
			const prev = previousRef.current;
			previousRef.current = nextSet;
			if (prev !== null && setsDiffer(prev, nextSet)) {
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.forgeAccountsAll,
				});
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.repositories,
				});
				void queryClient.invalidateQueries({
					predicate: (query) => {
						const root = query.queryKey[0];
						return (
							root === "workspaceAccountProfile" ||
							root === "workspaceForge" ||
							root === "workspaceForgeActionStatus"
						);
					},
				});
				// Fire-and-forget: backfill itself emits
				// `RepositoryListChanged` if it actually rebinds anything,
				// which the ui-sync bridge picks up and re-invalidates
				// repositories + workspace-scoped views a second time.
				// A failure here just means the DB stays stale until app
				// restart; the chip's invalidate above still refreshes
				// the view based on whatever forge_login is still in DB.
				void backfillForgeRepoBindings().catch(() => {});
			}
			return next;
		},
		staleTime: POLL_STALE_TIME_MS,
		refetchOnWindowFocus: "always",
		retry: 0,
	});
}

function setsDiffer(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return true;
	for (const value of a) {
		if (!b.has(value)) return true;
	}
	return false;
}
