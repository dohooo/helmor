import { CircleAlert, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { GithubBrandIcon, GitlabBrandIcon } from "@/components/brand-icon";
import { CachedAvatar } from "@/components/cached-avatar";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
	ForgeAccount,
	ForgeProvider,
	RepositoryCreateOption,
} from "@/lib/api";
import { initialsFor } from "@/lib/initials";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";
import { useForgeLoginsHealth } from "@/lib/use-forge-logins-health";
import { SettingsGroup } from "../components/settings-row";
import { gitlabHostsForRepositories } from "./cli-install-gitlab-hosts";

const GITHUB_DEFAULT_HOST = "github.com";
const GITLAB_DEFAULT_HOST = "gitlab.com";

/// Health probe targets — one per (provider, host) we want to keep
/// fresh on focus. Always probes GitHub + gitlab.com plus any
/// self-hosted GitLab hosts known from the repo list, plus any host
/// we already have an account on (covers stale accounts after the
/// user removes the source repo).
function buildHealthTargets(
	gitlabHosts: string[],
	accounts: ForgeAccount[],
): Array<{ provider: ForgeProvider; host: string }> {
	const seen = new Map<string, { provider: ForgeProvider; host: string }>();
	seen.set(`github::${GITHUB_DEFAULT_HOST}`, {
		provider: "github",
		host: GITHUB_DEFAULT_HOST,
	});
	const orderedGitlab = [
		GITLAB_DEFAULT_HOST,
		...gitlabHosts.filter((h) => h !== GITLAB_DEFAULT_HOST),
	];
	for (const host of orderedGitlab) {
		seen.set(`gitlab::${host}`, { provider: "gitlab", host });
	}
	for (const account of accounts) {
		const key = `${account.provider}::${account.host}`;
		if (!seen.has(key)) {
			seen.set(key, { provider: account.provider, host: account.host });
		}
	}
	return [...seen.values()];
}

export function AccountPanel({
	repositories,
}: {
	repositories: RepositoryCreateOption[];
}) {
	const gitlabHosts = useMemo(
		() => gitlabHostsForRepositories(repositories),
		[repositories],
	);
	// Shared cache key with onboarding + repo settings — see
	// `useForgeAccountsAll` for why this matters (one cache entry,
	// not three).
	const accountsQuery = useForgeAccountsAll();
	const accounts = accountsQuery.data ?? [];

	// Stable order: GitHub first, then GitLab grouped by host, then by login.
	const sortedAccounts = useMemo(() => {
		return [...accounts].sort((a, b) => {
			if (a.provider !== b.provider) {
				return a.provider === "github" ? -1 : 1;
			}
			if (a.host !== b.host) return a.host.localeCompare(b.host);
			return a.login.localeCompare(b.login);
		});
	}, [accounts]);

	const healthTargets = useMemo(
		() => buildHealthTargets(gitlabHosts, accounts),
		[gitlabHosts, accounts],
	);

	const errorMessage =
		accountsQuery.error instanceof Error ? accountsQuery.error.message : null;

	return (
		<TooltipProvider delayDuration={150}>
			{healthTargets.map((target) => (
				<HealthProbe
					key={`${target.provider}::${target.host}`}
					provider={target.provider}
					host={target.host}
				/>
			))}
			{errorMessage ? (
				<div className="flex justify-end pt-3">
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label="Account list error"
								className="inline-flex h-7 cursor-default items-center justify-center text-destructive"
							>
								<CircleAlert className="size-4" strokeWidth={2.2} />
							</button>
						</TooltipTrigger>
						<TooltipContent
							side="top"
							className="max-w-xs whitespace-normal text-[11px] leading-snug"
						>
							{errorMessage}
						</TooltipContent>
					</Tooltip>
				</div>
			) : null}
			<SettingsGroup>
				{accountsQuery.isPending ? (
					<div className="flex items-center justify-center gap-2 py-5 text-[12px] text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" />
						Loading accounts…
					</div>
				) : sortedAccounts.length === 0 ? (
					<div className="py-5 text-center text-[12px] text-muted-foreground">
						No accounts connected yet.
					</div>
				) : (
					sortedAccounts.map((account) => (
						<AccountRow
							key={`${account.provider}::${account.host}::${account.login}`}
							account={account}
						/>
					))
				)}
			</SettingsGroup>
		</TooltipProvider>
	);
}

/// Tiny per-target wrapper around `useForgeLoginsHealth`. The hook
/// itself does the focus-driven auth liveness check + cache
/// invalidation; we just need one instance per unique (provider, host).
function HealthProbe({
	provider,
	host,
}: {
	provider: ForgeProvider;
	host: string;
}) {
	useForgeLoginsHealth(provider, host);
	return null;
}

function AccountRow({ account }: { account: ForgeAccount }) {
	const displayName = account.name?.trim() || account.login;
	const providerBadge =
		account.provider === "gitlab" ? (
			<GitlabBrandIcon size={11} className="text-[#FC6D26]" />
		) : (
			<GithubBrandIcon size={11} />
		);
	// GitHub Enterprise users have a non-default host worth showing as
	// a subtle caption; gitlab.com gets the same treatment as
	// self-hosted (always show the host since multiple are possible).
	const showHostCaption =
		account.provider === "gitlab" ||
		(account.provider === "github" && account.host !== GITHUB_DEFAULT_HOST);

	return (
		<div className="flex min-h-[80px] items-center gap-3 py-4">
			<div className="relative shrink-0">
				{/* Initials fallback kicks in when no URL or the <img> errors
				 * (self-hosted GitLab gates /uploads/ behind a cookie our
				 * PAT can't satisfy, etc.). */}
				<CachedAvatar
					size="lg"
					className="size-10"
					src={account.avatarUrl}
					alt={account.login}
					fallback={initialsFor(displayName)}
					fallbackClassName="bg-muted text-[15px] font-semibold uppercase text-muted-foreground"
				/>
				<span className="absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center rounded-full bg-background ring-2 ring-background">
					{providerBadge}
				</span>
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-[13px] font-semibold text-foreground">
						{displayName}
					</span>
					<span className="truncate text-[12px] text-muted-foreground">
						@{account.login}
					</span>
				</div>
				{/* Always-rendered second line. min-h reserves the row even
				 * when both email and host are absent (e.g. github.com user
				 * without a public email), so every account is the same
				 * height regardless of which fields are populated. */}
				<div className="mt-0.5 flex min-h-[18px] items-center gap-1.5">
					{account.email ? (
						<div className="min-w-0 truncate text-[12px] text-muted-foreground">
							{account.email}
						</div>
					) : null}
					{showHostCaption ? (
						<div className="shrink-0 truncate text-[11px] text-muted-foreground/70">
							{account.host}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
