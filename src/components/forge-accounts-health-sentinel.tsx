// Renderless sentinel that mounts a `useForgeLoginsHealth` probe for
// every (provider, host) we care about. Without this the focus-driven
// reconciliation only runs while Settings → Accounts is open — a
// `gh auth login` / `gh auth logout` performed outside Helmor would
// only be picked up the next time the user opened that panel, so
// every other surface (workspace header chip, inspector forge
// section, repo settings) would stay stuck on stale data.
//
// Targets always include the canonical github.com / gitlab.com hosts
// plus every (provider, host) we already have an account on. The
// roster is derived from `useForgeAccountsAll`, so the moment a new
// host shows up — typically the first time the user adds a repo from
// a self-hosted GitLab — a probe gets mounted for that host too.

import { useMemo } from "react";
import type { ForgeProvider } from "@/lib/api";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";
import { useForgeLoginsHealth } from "@/lib/use-forge-logins-health";

const GITHUB_DEFAULT_HOST = "github.com";
const GITLAB_DEFAULT_HOST = "gitlab.com";

type HealthTarget = { provider: ForgeProvider; host: string };

function HealthProbe({ provider, host }: HealthTarget) {
	useForgeLoginsHealth(provider, host);
	return null;
}

export function ForgeAccountsHealthSentinel() {
	const accountsQuery = useForgeAccountsAll();
	const accounts = accountsQuery.data ?? [];

	const targets = useMemo<HealthTarget[]>(() => {
		const seen = new Map<string, HealthTarget>();
		seen.set(`github::${GITHUB_DEFAULT_HOST}`, {
			provider: "github",
			host: GITHUB_DEFAULT_HOST,
		});
		seen.set(`gitlab::${GITLAB_DEFAULT_HOST}`, {
			provider: "gitlab",
			host: GITLAB_DEFAULT_HOST,
		});
		for (const account of accounts) {
			const key = `${account.provider}::${account.host}`;
			if (!seen.has(key)) {
				seen.set(key, { provider: account.provider, host: account.host });
			}
		}
		return [...seen.values()];
	}, [accounts]);

	return (
		<>
			{targets.map((target) => (
				<HealthProbe
					key={`${target.provider}::${target.host}`}
					provider={target.provider}
					host={target.host}
				/>
			))}
		</>
	);
}
