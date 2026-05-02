import { ChevronDown, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { GithubBrandIcon } from "@/components/brand-icon";
import { CachedAvatar } from "@/components/cached-avatar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { initialsFor } from "@/lib/initials";
import {
	DEFAULT_INBOX_ACCOUNT_TOGGLES,
	type InboxAccountSourceToggles,
	type InboxSourceConfig,
	useSettings,
} from "@/lib/settings";

/** Defensive default — `appSettings` may have been loaded from a session
 * persisted before this field existed (HMR or pre-migration users). */
const EMPTY_INBOX_CONFIG: InboxSourceConfig = { accounts: {} };

import { useForgeAccountsAll } from "@/lib/use-forge-accounts";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow } from "../components/settings-row";

/** Storage key shape used by the inbox settings map: `<provider>:<login>`.
 * Keep the shape stable — the future Tauri command that fetches inbox
 * items will look up toggles by the same key. */
function accountConfigKey(provider: string, login: string): string {
	return `${provider}:${login}`;
}

type ToggleField = keyof InboxAccountSourceToggles;

const TOGGLE_ROWS: Array<{
	field: ToggleField;
	title: string;
	description: string;
}> = [
	{
		field: "issues",
		title: "Issues",
		description: "Surface issues you're assigned to or have opened.",
	},
	{
		field: "prs",
		title: "Pull requests",
		description:
			"Surface PRs you opened, are review-requested on, or have outstanding reviews.",
	},
	{
		field: "discussions",
		title: "Discussions",
		description: "Surface discussions in repos you have access to.",
	},
];

/** Triggers App.tsx's settings-route handler to switch to the Accounts
 * panel from inside the inbox panel — for the "Add account…" dropdown
 * footer. Reuses the same window event the inbox sidebar uses, so the
 * route is single-source. */
function openAccountSettings() {
	window.dispatchEvent(
		new CustomEvent("helmor:open-settings", {
			detail: { section: "account" },
		}),
	);
}

export function InboxSettingsPanel() {
	const accountsQuery = useForgeAccountsAll();
	const { settings, updateSettings } = useSettings();

	// Currently we only ship the GitHub connector. GitLab accounts exist
	// in the forge layer but the inbox can't pull anything for them yet.
	const githubAccounts = useMemo(
		() => (accountsQuery.data ?? []).filter((a) => a.provider === "github"),
		[accountsQuery.data],
	);

	const [selectedLogin, setSelectedLogin] = useState<string | null>(null);
	const effectiveLogin = selectedLogin ?? githubAccounts[0]?.login ?? null;
	const selectedAccount =
		githubAccounts.find((a) => a.login === effectiveLogin) ?? null;

	// Defensive read: fall back to an empty config when the field is
	// missing on `settings` (e.g. legacy persisted state from before the
	// `inboxSourceConfig` field shipped, or a stale HMR snapshot).
	const inboxConfig: InboxSourceConfig =
		settings.inboxSourceConfig ?? EMPTY_INBOX_CONFIG;
	const accountKey = selectedAccount
		? accountConfigKey(selectedAccount.provider, selectedAccount.login)
		: null;
	const currentToggles: InboxAccountSourceToggles =
		(accountKey ? inboxConfig.accounts[accountKey] : undefined) ??
		DEFAULT_INBOX_ACCOUNT_TOGGLES;

	const setToggle = useCallback(
		(field: ToggleField, next: boolean) => {
			if (!accountKey) return;
			void updateSettings({
				inboxSourceConfig: {
					...inboxConfig,
					accounts: {
						...inboxConfig.accounts,
						[accountKey]: {
							...currentToggles,
							[field]: next,
						},
					},
				},
			});
		},
		[accountKey, currentToggles, inboxConfig, updateSettings],
	);

	if (githubAccounts.length === 0) {
		return (
			<div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/60 px-6 py-10 text-center">
				<div className="flex size-9 items-center justify-center rounded-lg border border-border/50 text-muted-foreground">
					<GithubBrandIcon size={18} />
				</div>
				<div className="text-[13px] font-medium text-foreground">
					Connect a GitHub account
				</div>
				<div className="max-w-[360px] text-[12px] leading-5 text-muted-foreground">
					You need at least one GitHub account before the inbox can pull issues,
					pull requests, or discussions.
				</div>
				<Button
					type="button"
					size="sm"
					onClick={openAccountSettings}
					className="mt-1 cursor-pointer gap-1.5"
				>
					<Plus className="size-3.5" strokeWidth={2} />
					Add account
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			<AccountPicker
				accounts={githubAccounts}
				selected={selectedAccount}
				onSelect={setSelectedLogin}
			/>

			<SettingsGroup>
				{TOGGLE_ROWS.map((row) => (
					<SettingsRow
						key={row.field}
						title={row.title}
						description={row.description}
					>
						<Switch
							checked={currentToggles[row.field]}
							onCheckedChange={(next) => setToggle(row.field, next)}
						/>
					</SettingsRow>
				))}
			</SettingsGroup>
		</div>
	);
}

function AccountPicker({
	accounts,
	selected,
	onSelect,
}: {
	accounts: ReadonlyArray<{
		login: string;
		host: string;
		avatarUrl?: string | null;
		name?: string | null;
	}>;
	selected: { login: string; host: string } | null;
	onSelect: (login: string) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					className={cn(
						"h-10 w-full cursor-pointer justify-between gap-2 px-3 text-[13px]",
					)}
				>
					<span className="flex min-w-0 items-center gap-2">
						{selected ? (
							<AccountAvatar account={selected} />
						) : (
							<GithubBrandIcon size={16} />
						)}
						<span className="min-w-0 truncate font-medium">
							{selected ? selected.login : "Select account"}
						</span>
						{selected ? (
							<span className="shrink-0 text-[11px] text-muted-foreground">
								{selected.host}
							</span>
						) : null}
					</span>
					<ChevronDown
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="w-[var(--radix-dropdown-menu-trigger-width)]"
			>
				{accounts.map((account) => (
					<DropdownMenuItem
						key={`${account.host}:${account.login}`}
						onSelect={() => onSelect(account.login)}
						className="cursor-pointer gap-2 text-[13px]"
					>
						<AccountAvatar account={account} />
						<span className="min-w-0 flex-1 truncate">{account.login}</span>
						<span className="shrink-0 text-[11px] text-muted-foreground">
							{account.host}
						</span>
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={openAccountSettings}
					className="cursor-pointer gap-2 text-[13px] text-muted-foreground"
				>
					<Plus className="size-4" strokeWidth={2} />
					Add account…
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function AccountAvatar({
	account,
}: {
	account: { login: string; avatarUrl?: string | null; name?: string | null };
}) {
	return (
		<CachedAvatar
			src={account.avatarUrl ?? undefined}
			alt={account.login}
			fallback={initialsFor(account.name ?? account.login)}
			className="size-5 shrink-0 rounded-full"
		/>
	);
}
