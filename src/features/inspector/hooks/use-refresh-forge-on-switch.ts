import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ForgeActionStatus } from "@/lib/api";
import {
	forgeActionStatusRefetchInterval,
	helmorQueryKeys,
} from "@/lib/query-client";

// On workspace switch, force-refresh when cached CI is still in flight.
// `staleTime: Infinity` blocks the queryKey-change path (`setOptions`
// gates on `isStale` and ignores `refetchOnMount`); stable / non-`ok`
// states recover via focus + 60s poll.
const SWITCH_REFRESH_DEBOUNCE_MS = 150;

export function useRefreshForgeOnWorkspaceSwitch(
	selectedWorkspaceId: string | null,
) {
	const queryClient = useQueryClient();
	useEffect(() => {
		if (!selectedWorkspaceId) return;
		const queryKey =
			helmorQueryKeys.workspaceForgeActionStatus(selectedWorkspaceId);
		const cached = queryClient.getQueryData<ForgeActionStatus>(queryKey);
		if (!cached) return; // first visit — useQuery will fetch
		const interval = forgeActionStatusRefetchInterval(cached);
		// Only nudge dynamic snapshots (5s = mergeable pending, 15s = CI/
		// deployment running). Skip stable / non-`ok` states — no point
		// pinging the forge CLI on every switch just to confirm "still merged"
		// or "still unauthenticated"; focus + 60s poll cover those.
		if (interval === false || interval >= 60_000) return;
		const timer = setTimeout(() => {
			void queryClient.invalidateQueries({ queryKey });
		}, SWITCH_REFRESH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [selectedWorkspaceId, queryClient]);
}
