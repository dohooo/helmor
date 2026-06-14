import { useMemo } from "react";
import type { ForgeAccount } from "@/lib/api";
import type { TeamIdentity } from "@/lib/team-api";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";

/** Pick the GitHub account whose numeric id we'll register as the member.
 * Prefers the active account (`gh auth switch`); falls back to the first
 * GitHub account that actually carries a numeric `id`. Only GitHub accounts
 * qualify — `members.id` is the GitHub numeric id, and GitLab accounts
 * carry no `id`. */
export function pickGithubIdentityAccount(
	accounts: ForgeAccount[],
): ForgeAccount | null {
	const github = accounts.filter(
		(a) => a.provider === "github" && a.id != null && a.id !== "",
	);
	if (github.length === 0) return null;
	return github.find((a) => a.active) ?? github[0];
}

export function toTeamIdentity(account: ForgeAccount): TeamIdentity | null {
	if (account.id == null || account.id === "") return null;
	return {
		githubId: account.id,
		login: account.login,
		avatarUrl: account.avatarUrl ?? undefined,
		displayName: account.name ?? undefined,
	};
}

export interface TeamIdentityState {
	/** The accept payload, or `null` until a GitHub account with a numeric
	 * id is available. */
	identity: TeamIdentity | null;
	/** True while the forge-account roster is still being fetched. */
	isLoading: boolean;
}

/**
 * Resolve the local GitHub identity used to accept a team invite. Reuses the
 * shared forge-account roster (`useForgeAccountsAll`) so it hits the same
 * cache as Settings → Accounts — no extra `gh` fan-out.
 */
export function useTeamIdentity(): TeamIdentityState {
	const accountsQuery = useForgeAccountsAll();
	const accounts = accountsQuery.data ?? [];
	const identity = useMemo(() => {
		const account = pickGithubIdentityAccount(accounts);
		return account ? toTeamIdentity(account) : null;
	}, [accounts]);
	return { identity, isLoading: accountsQuery.isPending };
}
