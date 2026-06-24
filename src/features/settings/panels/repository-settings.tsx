import {
	Check,
	ChevronDown,
	GitBranch,
	Laptop,
	LoaderCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
	listBranchesForLocalPicker,
	listRemoteBranches,
	listRepoRemotes,
	prefetchRemoteRefs,
	type RepositoryCreateOption,
	updateRepositoryDefaultBranch,
	updateRepositoryRemote,
} from "@/lib/api";
import { I18nText, useI18n } from "@/lib/i18n";
import { initialsFor } from "@/lib/initials";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";
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
	const { f } = useI18n();
	// Three states:
	//  - non-git  (no default branch): no git config at all.
	//  - no-remote (git, no remote): branch + scripts apply, but no
	//    remote/account/PR/branch-prefix.
	//  - normal   (git + remote): the full panel.
	const isNonGit = !repo.defaultBranch;
	const hasRemote = Boolean(repo.remote);
	const githubLogin = repo.forgeLogin ?? null;
	const [branches, setBranches] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Anchor used by the Inspector's Run-tab dropdown "Create" flow to
	// jump straight into the scripts editor after the settings dialog
	// opens. The event is fired one frame after the panel mounts, so
	// the ref is guaranteed to point at the rendered section.
	const scriptsAnchorRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const handler = () => {
			scriptsAnchorRef.current?.scrollIntoView({
				behavior: "smooth",
				block: "start",
			});
		};
		window.addEventListener("helmor:scroll-to-repo-scripts", handler);
		return () =>
			window.removeEventListener("helmor:scroll-to-repo-scripts", handler);
	}, []);

	const currentBranch = repo.defaultBranch ?? "main";

	const fetchBranches = useCallback(() => {
		setLoading(true);
		// No remote → list local branches; otherwise the remote refs.
		const load = hasRemote
			? listRemoteBranches({ repoId: repo.id })
			: listBranchesForLocalPicker(repo.id);
		void load.then(setBranches).finally(() => setLoading(false));
	}, [repo.id, hasRemote]);

	const handleOpen = useCallback(() => {
		fetchBranches();
		// Prefetch only makes sense with a remote.
		if (!hasRemote) return;
		void prefetchRemoteRefs({ repoId: repo.id })
			.then(({ fetched }) => {
				if (fetched) fetchBranches();
			})
			.catch(() => {});
	}, [repo.id, fetchBranches, hasRemote]);

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
							f("settingsWorkspacesTargetBranchNotRemote", { count: n }),
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

			{!isNonGit && hasRemote && (
				<div className="py-5">
					<div className="text-ui font-medium leading-snug text-foreground">
						<I18nText source="remoteOrigin" />
					</div>
					<div className="mt-1 text-small leading-snug text-muted-foreground">
						<I18nText source="whereShouldWePushPullCreate" />
					</div>
					<div className="mt-3">
						<Popover
							open={remoteOpen}
							onOpenChange={(next: boolean) => {
								setRemoteOpen(next);
								if (next) fetchRemotes();
							}}
						>
							<PopoverTrigger className="inline-flex cursor-interactive items-center gap-1 rounded-lg border border-app-border/40 bg-app-base/30 px-3 py-2 text-ui font-medium text-app-foreground transition-colors hover:border-app-border-strong">
								<span className="truncate">{currentRemote}</span>
								<ChevronDown
									className="size-3 shrink-0 text-app-muted"
									strokeWidth={2}
								/>
							</PopoverTrigger>
							<PopoverContent align="start" className="w-[220px] p-0">
								<Command className="rounded-lg! p-0.5">
									<CommandList className="max-h-52">
										<CommandEmpty>
											<I18nText source="noRemotesFound" />
										</CommandEmpty>
										{remotes.map((remote) => (
											<CommandItem
												key={remote}
												value={remote}
												onSelect={() => handleRemoteSelect(remote)}
												className="flex items-center justify-between gap-2 px-1.5 py-1 text-small"
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
													<Check
														className="size-3.5 shrink-0"
														strokeWidth={2}
													/>
												)}
											</CommandItem>
										))}
									</CommandList>
								</Command>
							</PopoverContent>
						</Popover>
						{remoteError && (
							<p className="mt-2 text-small text-red-400/90">{remoteError}</p>
						)}
						{remoteNotice && (
							<p className="mt-2 text-small text-amber-400/90">
								{remoteNotice}
							</p>
						)}
					</div>
				</div>
			)}

			{!isNonGit && (
				<div className="py-5">
					<div className="text-ui font-medium leading-snug text-foreground">
						<I18nText source="branchNewWorkspacesFrom" />
					</div>
					<div className="mt-1 text-small leading-snug text-muted-foreground">
						<I18nText source="eachWorkspaceIsolatedCopyCodebase" />
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
								className="inline-flex cursor-interactive items-center gap-1 rounded-lg border border-app-border/40 bg-app-base/30 px-3 py-2 text-ui font-medium text-app-foreground transition-colors hover:border-app-border-strong"
							>
								<GitBranch
									className="size-3.5 text-app-foreground-soft"
									strokeWidth={1.8}
								/>
								<span className="truncate">
									{repo.remote
										? `${repo.remote}/${currentBranch}`
										: currentBranch}
								</span>
								<ChevronDown
									className="size-3 shrink-0 text-app-muted"
									strokeWidth={2}
								/>
							</button>
						</BranchPickerPopover>
						{error && (
							<p className="mt-2 text-small text-red-400/90">{error}</p>
						)}
					</div>
				</div>
			)}

			{!isNonGit && hasRemote && (
				<BranchPrefixSection
					repo={repo}
					githubLogin={githubLogin}
					onChanged={onRepoSettingsChanged}
				/>
			)}

			{!isNonGit && (
				<div ref={scriptsAnchorRef}>
					<ScriptsSection repoId={repo.id} workspaceId={workspaceId} />
				</div>
			)}
			<RepositoryPreferencesSection
				repoId={repo.id}
				nonGit={isNonGit || !hasRemote}
			/>

			<DeleteRepoSection repo={repo} onDeleted={onRepoDeleted} />
		</SettingsGroup>
	);
}

/// Account card at the top of the repo settings panel: the bound account,
/// else a Connect CTA. Auth is lazy — trust the persisted binding,
/// cross-checked against the focus-refreshed accounts roster, no probe.
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

	// No per-repo probe — cross-check the binding against the loaded roster.
	const probeProvider = provider === "unknown" ? "github" : provider;
	const probeHost =
		parseRemoteHost(repo.remoteUrl) ?? defaultHostFor(probeProvider);
	const persistedLogin = repo.forgeLogin;
	// Assume good until the roster lands (avoids a first-paint flash).
	const rosterLoaded = accountsQuery.data !== undefined;
	const liveLoginIsActive =
		!!persistedLogin &&
		(!rosterLoaded ||
			accounts.some(
				(a: ForgeAccount) =>
					a.provider === probeProvider &&
					a.host === probeHost &&
					a.login === persistedLogin,
			));
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

	// Non-git folder: no remote, no forge account — just say so instead of
	// showing account info or a Connect CTA that can never apply.
	if (!repo.defaultBranch) {
		return (
			<div className="flex items-center gap-3 py-5">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5 text-ui font-medium text-foreground">
						<Laptop
							className="size-3.5 text-muted-foreground"
							strokeWidth={1.8}
						/>
						<span>
							<I18nText source="nonGitRepository" />
						</span>
					</div>
					<div className="mt-0.5 text-small text-muted-foreground">
						<I18nText source="nonGitRepositoryDescription" />
					</div>
				</div>
			</div>
		);
	}

	// Git repo with no remote: branch/diff/commit work, but there's no
	// account, push, pull, or pull-request flow — say so instead of a CTA.
	if (!repo.remote) {
		return (
			<div className="flex items-center gap-3 py-5">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5 text-ui font-medium text-foreground">
						<Laptop
							className="size-3.5 text-muted-foreground"
							strokeWidth={1.8}
						/>
						<span>
							<I18nText source="localOnlyRepository" />
						</span>
					</div>
					<div className="mt-0.5 text-small text-muted-foreground">
						<I18nText source="localOnlyRepositoryDescription" />
					</div>
				</div>
			</div>
		);
	}

	if (!effectiveLogin) {
		return (
			<div className="flex items-center gap-3 py-5">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5 text-ui font-medium text-foreground">
						{providerIcon}
						<span>
							{providerLabel} <I18nText source="notConnected" />
						</span>
					</div>
					<div className="mt-0.5 text-small text-muted-foreground">
						<I18nText source="connect2" /> {providerLabel}{" "}
						<I18nText source="accountEnable" /> {providerLabel}{" "}
						<I18nText source="workflowRepo" />
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
				fallbackClassName="bg-muted text-title font-semibold uppercase text-muted-foreground"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="truncate text-ui font-semibold text-foreground">
						{displayName}
					</span>
					<span className="truncate text-small text-muted-foreground">
						@{effectiveLogin}
					</span>
				</div>
				<div className="mt-0.5 flex items-center gap-1 text-mini text-muted-foreground">
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
				<I18nText source={connecting ? "connecting" : "connect"} />
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
