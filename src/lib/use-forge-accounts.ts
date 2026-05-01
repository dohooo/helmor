// Single source of truth for the avatar / profile roster across every
// surface that lists forge accounts (onboarding, settings →
// Accounts, repo settings header).
//
// Why a hook rather than letting each caller build its own
// `forgeAccountsQueryOptions(...)` invocation: the underlying
// `gitlab_hosts` hint is a function of the global repository list,
// not of which UI surface happens to be open. Three callers passing
// three different host arrays → three different React Query cache
// entries → three independent fetches and a confusing "the avatar
// shows up here but not there" experience.
//
// By deriving the hosts list from `repositoriesQueryOptions` and
// `sort()`-ing it inside `gitlabHostsForRepositories`, every caller
// hits the same cache entry. One fetch fills it, every surface
// reuses it.

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { gitlabHostsForRepositories } from "@/features/settings/panels/cli-install-gitlab-hosts";
import type { ForgeAccount } from "@/lib/api";
import {
	forgeAccountsQueryOptions,
	repositoriesQueryOptions,
} from "@/lib/query-client";

export function useForgeAccountsAll(
	extraGitlabHosts: readonly string[] = EMPTY_HOSTS,
): UseQueryResult<ForgeAccount[]> {
	const reposQuery = useQuery(repositoriesQueryOptions());
	// Stable join key so identical `extraGitlabHosts` content (different
	// array instance each render) doesn't churn the memo / query key.
	const extrasKey = extraGitlabHosts.join("\u0000");
	const gitlabHosts = useMemo(() => {
		const set = new Set(gitlabHostsForRepositories(reposQuery.data ?? []));
		for (const host of extraGitlabHosts) {
			if (host) set.add(host);
		}
		return [...set].sort();
	}, [reposQuery.data, extrasKey]);
	return useQuery({
		...forgeAccountsQueryOptions(gitlabHosts),
		// Wait until the repositories query has settled — otherwise the
		// first paint runs with `[]` and we burn a fetch that the second
		// paint (with the real host list) will immediately re-run.
		enabled: reposQuery.isSuccess || reposQuery.isFetched,
	});
}

const EMPTY_HOSTS: readonly string[] = [];
