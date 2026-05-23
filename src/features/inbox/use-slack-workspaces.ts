import { useQuery } from "@tanstack/react-query";
import { slackListWorkspaces } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";

/** Lightweight wrapper around `slack_list_workspaces`. Cache is bumped by
 *  the `slackWorkspacesChanged` UI-mutation event (Connect / Disconnect),
 *  so a default `staleTime: 0` is fine — we never hit the IPC twice on
 *  successive renders without something invalidating it first. */
export function useSlackWorkspaces() {
	return useQuery({
		queryKey: helmorQueryKeys.slackWorkspaces,
		queryFn: slackListWorkspaces,
		staleTime: 0,
	});
}
