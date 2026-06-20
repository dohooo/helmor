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
import type { ForgeAccount } from "@/lib/api";
import { I18nText, useI18n } from "@/lib/i18n";
import { initialsFor } from "@/lib/initials";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";
import { SettingsGroup } from "../components/settings-row";

const GITHUB_DEFAULT_HOST = "github.com";

export function AccountPanel() {
	const { t } = useI18n();
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

	const errorMessage =
		accountsQuery.error instanceof Error ? accountsQuery.error.message : null;

	return (
		<TooltipProvider delayDuration={150}>
			{errorMessage ? (
				<div className="flex justify-end pt-3">
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={t("Account list error")}
								className="inline-flex h-7 cursor-default items-center justify-center text-destructive"
							>
								<CircleAlert className="size-4" strokeWidth={2.2} />
							</button>
						</TooltipTrigger>
						<TooltipContent
							side="top"
							className="max-w-xs whitespace-normal text-mini leading-snug"
						>
							{errorMessage}
						</TooltipContent>
					</Tooltip>
				</div>
			) : null}
			<SettingsGroup>
				{accountsQuery.isPending ? (
					<div className="flex items-center justify-center gap-2 py-5 text-small text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" />
						<I18nText source={"Loading accounts…"} />
					</div>
				) : sortedAccounts.length === 0 ? (
					<div className="py-5 text-center text-small text-muted-foreground">
						<I18nText source={"No accounts connected yet."} />
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
					fallbackClassName="bg-muted text-title font-semibold uppercase text-muted-foreground"
				/>
				<span className="absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center rounded-full bg-background ring-2 ring-background">
					{providerBadge}
				</span>
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-ui font-semibold text-foreground">
						{displayName}
					</span>
					<span className="truncate text-small text-muted-foreground">
						@{account.login}
					</span>
				</div>
				{/* Always-rendered second line. min-h reserves the row even
				 * when both email and host are absent (e.g. github.com user
				 * without a public email), so every account is the same
				 * height regardless of which fields are populated. */}
				<div className="mt-0.5 flex min-h-[18px] items-center gap-1.5">
					{account.email ? (
						<div className="min-w-0 truncate text-small text-muted-foreground">
							{account.email}
						</div>
					) : null}
					{showHostCaption ? (
						<div className="shrink-0 truncate text-mini text-muted-foreground/70">
							{account.host}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
