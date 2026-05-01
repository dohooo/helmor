import { GithubBrandIcon, GitlabBrandIcon } from "@/components/brand-icon";
import { CachedAvatar } from "@/components/cached-avatar";
import type { ForgeAccount, ForgeProvider } from "@/lib/api";
import { initialsFor } from "@/lib/initials";

type AccountInfo = {
	provider: Exclude<ForgeProvider, "unknown">;
	host: string;
	login: string;
	avatarUrl?: string | null;
	name?: string | null;
	email?: string | null;
};

/**
 * Hover-card body for a forge account. Mirrors the layout used in
 * onboarding's `StackedAccountAvatar` so the same chrome shows up in
 * the workspace header chip.
 */
export function AccountHoverCardContent({ account }: { account: AccountInfo }) {
	const displayName = account.name?.trim() || account.login;
	const providerBadge =
		account.provider === "gitlab" ? (
			<GitlabBrandIcon size={11} className="text-[#FC6D26]" />
		) : (
			<GithubBrandIcon size={11} />
		);
	return (
		<div className="flex items-center gap-3">
			<div className="relative shrink-0">
				<CachedAvatar
					size="lg"
					className="size-10"
					src={account.avatarUrl}
					alt={account.login}
					fallback={initialsFor(displayName)}
					fallbackClassName="bg-muted text-[13px] font-semibold uppercase text-muted-foreground"
				/>
				<span className="absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center rounded-full bg-popover ring-2 ring-popover">
					{providerBadge}
				</span>
			</div>
			<div className="min-w-0 flex-1">
				<div className="truncate text-[13px] font-semibold text-foreground">
					{displayName}
				</div>
				<div className="truncate text-[12px] text-muted-foreground">
					@{account.login}
				</div>
				{account.email ? (
					<div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
						{account.email}
					</div>
				) : null}
				{account.provider === "gitlab" ? (
					<div className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
						{account.host}
					</div>
				) : null}
			</div>
		</div>
	);
}

export type { AccountInfo as ForgeAccountInfo };

/** Convenience adapter: build the hover-card payload from a backend
 * `ForgeAccount`. Pass `null` to render nothing. */
export function accountInfoFromForgeAccount(
	account: ForgeAccount | null,
): AccountInfo | null {
	if (!account) return null;
	if (account.provider === "unknown") return null;
	return {
		provider: account.provider,
		host: account.host,
		login: account.login,
		avatarUrl: account.avatarUrl,
		name: account.name,
		email: account.email,
	};
}
