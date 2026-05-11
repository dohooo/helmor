import { Check, ChevronDown, GitBranch, LoaderCircle } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { BranchPickerPopover } from "@/components/branch-picker";
import { GithubBrandIcon, GitlabBrandIcon } from "@/components/brand-icon";
import { CachedAvatar } from "@/components/cached-avatar";
import { ForgeConnectDialog } from "@/components/forge-connect-dialog";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	type ForgeAccount,
	type ForgeProvider,
	listRemoteBranches,
	listRepoRemotes,
	prefetchRemoteRefs,
	type RepositoryCreateOption,
	updateRepositoryDefaultBranch,
	updateRepositoryRemote,
} from "@/lib/api";
import { initialsFor } from "@/lib/initials";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";
import { useForgeLoginsHealth } from "@/lib/use-forge-logins-health";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "../components/settings-row";
import { parseRemoteHost } from "./cli-install-gitlab-hosts";
import { RepositoryPreferencesSection } from "./repository-preferences-section";
import { BranchPrefixSection } from "./repository-settings/branch-prefix-section";
import { DeleteRepoSection } from "./repository-settings/delete-repo-section";
import { ScriptsSection } from "./repository-settings/scripts-section";

export function RepositorySettingsPanel({
	repo,
	workspaceId,
	onRepoSettingsChanged,
	onRepoDeleted,
}: {
	repo: RepositoryCreateOption;
	workspaceId: string | null;
	onRepoSettingsChanged: () => void;
	onRepoDeleted: () => void;
}) {
	// The bound gh/glab account login lives on the repo row now;
	// no more global OAuth identity.
	const githubLogin = repo.forgeLogin ?? null;
	const [branches, setBranches] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const currentBranch = repo.defaultBranch ?? "main";

	const fetchBranches = useCallback(() => {
		setLoading(true);
		void listRemoteBranches({ repoId: repo.id })
			.then(setBranches)
			.finally(() => setLoading(false));
	}, [repo.id]);

	const handleOpen = useCallback(() => {
		fetchBranches();
		void prefetchRemoteRefs({ repoId: repo.id })
			.then(({ fetched }) => {
				if (fetched) fetchBranches();
			})
			.catch(() => {});
	}, [repo.id, fetchBranches]);

	const handleSelect = useCallback(
		(branch: string) => {
			if (branch === currentBranch) return;
			setError(null);
			void updateRepositoryDefaultBranch(repo.id, branch).then(
				onRepoSettingsChanged,
				(err: unknown) => {
					setError(err instanceof Error ? err.message : String(err));
					onRepoSettingsChanged();
				},
			);
		},
		[repo.id, currentBranch, onRepoSettingsChanged],
	);

	const [remotes, setRemotes] = useState<string[]>([]);
	const [remoteOpen, setRemoteOpen] = useState(false);
	const [remoteError, setRemoteError] = useState<string | null>(null);
	const [remoteNotice, setRemoteNotice] = useState<string | null>(null);

	const currentRemote = repo.remote ?? "origin";

	const fetchRemotes = useCallback(() => {
		void listRepoRemotes(repo.id).then(setRemotes);
	}, [repo.id]);

	const handleRemoteSelect = useCallback(
		(remote: string) => {
			if (remote === currentRemote) return;
			setRemoteOpen(false);
			setRemoteError(null);
			setRemoteNotice(null);
			void updateRepositoryRemote(repo.id, remote).then(
				(response) => {
					if (response.orphanedWorkspaceCount > 0) {
						const n = response.orphanedWorkspaceCount;
						setRemoteNotice(
							`${n} workspace${n === 1 ? "" : "s"} target a branch not on this remote. Update them via the header branch picker.`,
						);
					}
					onRepoSettingsChanged();
				},
				(err: unknown) => {
					setRemoteError(err instanceof Error ? err.message : String(err));
					onRepoSettingsChanged();
				},
			);
		},
		[repo.id, currentRemote, onRepoSettingsChanged],
	);

	return (
		<SettingsGroup>
			<ForgeAccountHeader repo={repo} workspaceId={workspaceId} />

			<div className="py-5">
				<div className="text-[13px] font-medium leading-snug text-foreground">
					Remote origin
				</div>
				<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
					Where should we push, pull, and create PRs?
				</div>
				<div className="mt-3">
					<Popover
						open={remoteOpen}
						onOpenChange={(next: boolean) => {
							setRemoteOpen(next);
							if (next) fetchRemotes();
						}}
					>
						<PopoverTrigger className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-app-border/40 bg-app-base/30 px-3 py-2 text-[13px] font-medium text-app-foreground transition-colors hover:border-app-border-strong">
							<span className="truncate">{currentRemote}</span>
							<ChevronDown
								className="size-3 shrink-0 text-app-muted"
								strokeWidth={2}
							/>
						</PopoverTrigger>
						<PopoverContent align="start" className="w-[220px] p-0">
							<Command className="rounded-lg! p-0.5">
								<CommandList className="max-h-52">
									<CommandEmpty>No remotes found</CommandEmpty>
									{remotes.map((remote) => (
										<CommandItem
											key={remote}
											value={remote}
											onSelect={() => handleRemoteSelect(remote)}
											className="flex items-center justify-between gap-2 px-1.5 py-1 text-[12px]"
										>
											<span
												className={cn(
													"truncate",
													remote === currentRemote && "font-semibold",
												)}
											>
												{remote}
											</span>
											{remote === currentRemote && (
												<Check className="size-3.5 shrink-0" strokeWidth={2} />
											)}
										</CommandItem>
									))}
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>
					{remoteError && (
						<p className="mt-2 text-[12px] text-red-400/90">{remoteError}</p>
					)}
					{remoteNotice && (
						<p className="mt-2 text-[12px] text-amber-400/90">{remoteNotice}</p>
					)}
				</div>
			</div>

			<div className="py-5">
				<div className="text-[13px] font-medium leading-snug text-foreground">
					Branch new workspaces from
				</div>
				<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
					Each workspace is an isolated copy of your codebase.
				</div>
				<div className="mt-3">
					<BranchPickerPopover
						currentBranch={currentBranch}
						branches={branches}
						loading={loading}
						onOpen={handleOpen}
						onSelect={handleSelect}
					>
						<button
							type="button"
							className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-app-border/40 bg-app-base/30 px-3 py-2 text-[13px] font-medium text-app-foreground transition-colors hover:border-app-border-strong"
						>
							<GitBranch
								className="size-3.5 text-app-foreground-soft"
								strokeWidth={1.8}
							/>
							<span className="truncate">
								{repo.remote ?? "origin"}/{currentBranch}
							</span>
							<ChevronDown
								className="size-3 shrink-0 text-app-muted"
								strokeWidth={2}
							/>
						</button>
					</BranchPickerPopover>
					{error && <p className="mt-2 text-[12px] text-red-400/90">{error}</p>}
				</div>
			</div>

			<BranchPrefixSection
				repo={repo}
				githubLogin={githubLogin}
				onChanged={onRepoSettingsChanged}
			/>

			<ScriptsSection repoId={repo.id} workspaceId={workspaceId} />
			<RepositoryPreferencesSection repoId={repo.id} />

			<DeleteRepoSection repo={repo} onDeleted={onRepoDeleted} />
		</SettingsGroup>
	);
}

/// Account card pinned to the top of the repo settings panel. Shows
/// the bound account when present (avatar + name + @login + provider
/// logo); otherwise collapses to a Connect CTA matching the inspector's
/// flow. Couples a focus-driven `useForgeLoginsHealth` probe so that
/// external auth changes are reflected the moment the user returns to
/// the window — the bound login disappearing from the live set is
/// treated as "not connected" client-side, even before the backend
/// forge_login column gets cleaned up.
function ForgeAccountHeader({
	repo,
	workspaceId,
}: {
	repo: RepositoryCreateOption;
	workspaceId: string | null;
}) {
	// Shared cache entry with the Settings → Accounts roster + the
	// onboarding step. See `useForgeAccountsAll` for why we don't
	// derive the query key from this single repo.
	const accountsQuery = useForgeAccountsAll();
	const accounts = accountsQuery.data ?? [];

	const provider = repo.forgeProvider ?? "unknown";
	const providerIcon =
		provider === "gitlab" ? (
			<GitlabBrandIcon size={14} className="text-[#FC6D26]" />
		) : (
			<GithubBrandIcon size={14} />
		);
	const providerLabel =
		provider === "gitlab" ? "GitLab" : provider === "github" ? "GitHub" : "Git";

	// Probe the live login set for this repo's host so external auth
	// changes are reflected right away. The hook itself owns the
	// downstream cache invalidation (forgeAccounts / repositories);
	// we use its data to decide whether the persisted forge_login is
	// still valid.
	const probeProvider = provider === "unknown" ? "github" : provider;
	const probeHost =
		parseRemoteHost(repo.remoteUrl) ?? defaultHostFor(probeProvider);
	const liveLoginsQuery = useForgeLoginsHealth(probeProvider, probeHost);
	const persistedLogin = repo.forgeLogin;
	const liveLoginsData = liveLoginsQuery.data;
	// Treat the binding as "active" when:
	//   - the column has a value, AND
	//   - we don't yet have a live probe answer (assume good — avoids
	//     a flash of "not connected" on first paint), OR
	//   - the live answer contains the persisted login.
	const liveLoginIsActive =
		!!persistedLogin &&
		(liveLoginsData === undefined || liveLoginsData.includes(persistedLogin));
	const effectiveLogin = liveLoginIsActive ? persistedLogin : null;

	const account = useMemo(() => {
		if (!effectiveLogin) return null;
		const host = parseRemoteHost(repo.remoteUrl);
		return (
			accounts.find(
				(a: ForgeAccount) =>
					a.login === effectiveLogin && (host == null || a.host === host),
			) ?? null
		);
	}, [accounts, effectiveLogin, repo.remoteUrl]);

	if (!effectiveLogin) {
		return (
			<div className="flex items-center gap-3 py-5">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
						{providerIcon}
						<span>{providerLabel} not connected</span>
					</div>
					<div className="mt-0.5 text-[12px] text-muted-foreground">
						Connect a {providerLabel} account to enable the {providerLabel}{" "}
						workflow for this repo.
					</div>
				</div>
				<NotConnectedConnectButton repo={repo} workspaceId={workspaceId} />
			</div>
		);
	}

	const displayName = account?.name?.trim() || effectiveLogin;

	return (
		<div className="flex items-center gap-3 py-5">
			{/* Initials fallback for missing URL or <img> errors (e.g.
			 * self-hosted GitLab gating /uploads/ behind a session cookie). */}
			<CachedAvatar
				size="lg"
				className="size-10"
				src={account?.avatarUrl}
				alt={effectiveLogin}
				fallback={initialsFor(displayName)}
				fallbackClassName="bg-muted text-[15px] font-semibold uppercase text-muted-foreground"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="truncate text-[13px] font-semibold text-foreground">
						{displayName}
					</span>
					<span className="truncate text-[12px] text-muted-foreground">
						@{effectiveLogin}
					</span>
				</div>
				<div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
					{providerIcon}
					<span className="truncate">{providerLabel}</span>
				</div>
			</div>
		</div>
	);
}

/// The "no account bound" CTA. Opens the embedded ForgeConnectDialog,
/// which owns the post-auth refresh logic (per-repo rebind + cache
/// invalidations) shared with the inspector's Git header trigger.
/// Mirrors `ForgeCliTrigger`'s "Connecting" state so the user gets the
/// same visual feedback while the dialog's post-close verification
/// runs.
function NotConnectedConnectButton({
	repo,
	workspaceId,
}: {
	repo: RepositoryCreateOption;
	workspaceId: string | null;
}) {
	const provider: ForgeProvider = (repo.forgeProvider ??
		"github") as ForgeProvider;
	const host = parseRemoteHost(repo.remoteUrl) ?? defaultHostFor(provider);
	const [open, setOpen] = useState(false);
	const [connecting, setConnecting] = useState(false);

	return (
		<>
			<Button
				type="button"
				size="sm"
				variant="default"
				onClick={() => setOpen(true)}
				disabled={connecting}
				className="gap-1.5 px-5"
			>
				{connecting ? (
					<LoaderCircle
						size={12}
						className="self-center animate-spin"
						strokeWidth={2}
					/>
				) : null}
				{connecting ? "Connecting" : "Connect"}
			</Button>
			<ForgeConnectDialog
				open={open}
				onOpenChange={(next) => {
					if (!next) setConnecting(true);
					setOpen(next);
				}}
				provider={provider}
				host={host}
				repoId={repo.id}
				workspaceId={workspaceId}
				onCloseSettled={({ connected }) => {
					// On success the parent re-renders into `ForgeAccountHeader`
					// (avatar + name) and this button unmounts; only the
					// "no new login" path needs to flip back.
					if (!connected) setConnecting(false);
				}}
			/>
		</>
	);
}

function defaultHostFor(provider: ForgeProvider): string {
	return provider === "gitlab" ? "gitlab.com" : "github.com";
}
