import { useQuery } from "@tanstack/react-query";
import { slackListWorkspaces } from "@/lib/api";
import { helmorQueryKeys, PERSIST_META } from "@/lib/query-client";

/** Lightweight wrapper around `slack_list_workspaces`. Cache is bumped by
 *  the `slackWorkspacesChanged` UI-mutation event (Connect / Disconnect),
 *  so a default `staleTime: 0` is fine — we never hit the IPC twice on
 *  successive renders without something invalidating it first.
 *
 *  Persisted across cold start so the Slack tab strip / workspace
 *  switcher renders immediately on app boot, matching how GitHub
 *  identity chips feel via `forgeAccountsQueryOptions`. The list is
 *  small (a handful of workspaces, ~1 KB total) so the synchronous
 *  hydrate isn't a boot-time hazard. A fresh fetch runs in the
 *  background per `refetchOnWindowFocus`. */
export function useSlackWorkspaces() {
	return useQuery({
		queryKey: helmorQueryKeys.slackWorkspaces,
		queryFn: slackListWorkspaces,
		staleTime: 0,
		meta: PERSIST_META,
	});
}
