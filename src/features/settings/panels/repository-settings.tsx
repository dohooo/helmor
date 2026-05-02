import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Check,
	ChevronDown,
	GitBranch,
	HelpCircle,
	LoaderCircle,
	Trash2,
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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	type BranchPrefixType,
	deleteRepository,
	type ForgeAccount,
	type ForgeProvider,
	listRemoteBranches,
	listRepoRemotes,
	loadRepoScripts,
	prefetchRemoteRefs,
	type RepositoryCreateOption,
	updateRepoAutoRunSetup,
	updateRepoRunScriptMode,
	updateRepoScripts,
	updateRepositoryBranchPrefix,
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

const PREFIX_TYPES: BranchPrefixType[] = ["username", "custom", "none"];

function effectivePrefixType(repo: RepositoryCreateOption): BranchPrefixType {
	const stored = repo.branchPrefixType;
	if (stored === "username" || stored === "custom" || stored === "none") {
		return stored;
	}
	// NULL is treated as "username" by the backend resolver — mirror here
	// so the radio reflects the value the workspace branch generator
	// will use.
	return "username";
}

function BranchPrefixSection({
	repo,
	githubLogin,
	onChanged,
}: {
	repo: RepositoryCreateOption;
	githubLogin: string | null;
	onChanged: () => void;
}) {
	const initialType = effectivePrefixType(repo);
	const [prefixType, setPrefixType] = useState<BranchPrefixType>(initialType);
	const [customPrefix, setCustomPrefix] = useState(
		repo.branchPrefixCustom ?? "",
	);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Reset local state when switching repos.
	useEffect(() => {
		setPrefixType(effectivePrefixType(repo));
		setCustomPrefix(repo.branchPrefixCustom ?? "");
	}, [repo.id]);

	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		};
	}, [repo.id]);

	const persist = useCallback(
		(type: BranchPrefixType, custom: string) => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => {
				void updateRepositoryBranchPrefix(
					repo.id,
					type,
					type === "custom" ? custom.trim() || null : null,
				).then(onChanged);
			}, 400);
		},
		[repo.id, onChanged],
	);

	const handleTypeChange = useCallback(
		(value: string) => {
			if (!PREFIX_TYPES.includes(value as BranchPrefixType)) return;
			const next = value as BranchPrefixType;
			setPrefixType(next);
			// Switching mode is intent — persist immediately rather than
			// debouncing (debounce is for in-progress typing).
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			void updateRepositoryBranchPrefix(
				repo.id,
				next,
				next === "custom" ? customPrefix.trim() || null : null,
			).then(onChanged);
		},
		[customPrefix, onChanged, repo.id],
	);

	const handleCustomChange = useCallback(
		(value: string) => {
			setCustomPrefix(value);
			persist("custom", value);
		},
		[persist],
	);

	const previewBase = "tokyo";
	const previewPrefix =
		prefixType === "custom"
			? customPrefix.trim()
			: prefixType === "username"
				? githubLogin
					? `${githubLogin}/`
					: ""
				: "";

	const customId = `repo-${repo.id}-branch-prefix-custom`;
	const customActive = prefixType === "custom";

	const activateCustom = useCallback(() => {
		if (prefixType === "custom") return;
		setPrefixType("custom");
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		void updateRepositoryBranchPrefix(
			repo.id,
			"custom",
			customPrefix.trim() || null,
		).then(onChanged);
	}, [customPrefix, onChanged, prefixType, repo.id]);

	return (
		<div className="py-5">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 flex-1">
					<div className="text-[13px] font-medium leading-snug text-foreground">
						Branch prefix
					</div>
					<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
						Prefix added to branch names when creating new workspaces in this
						repo.
					</div>
				</div>
				<BranchPrefixPreview
					prefixType={prefixType}
					previewPrefix={previewPrefix}
					previewBase={previewBase}
				/>
			</div>
			<RadioGroup
				value={prefixType}
				onValueChange={handleTypeChange}
				className="mt-3 gap-0"
			>
				<PrefixRadioOption repoId={repo.id} value="username" label="Username" />
				{/*
				 * Custom row inlines its own input so the panel height stays
				 * fixed across all three options. When Custom isn't
				 * selected the input is hidden via `invisible` (NOT
				 * unmounted) — that keeps it occupying the same vertical
				 * footprint, so flipping radios doesn't reflow the
				 * surrounding layout.
				 */}
				<Field
					orientation="horizontal"
					className="items-center gap-3 rounded-lg px-1 py-0.5"
				>
					<RadioGroupItem value="custom" id={customId} />
					<FieldLabel htmlFor={customId} className="shrink-0 text-foreground">
						Custom
					</FieldLabel>
					<Input
						type="text"
						value={customPrefix}
						onChange={(event) => handleCustomChange(event.target.value)}
						onFocus={() => activateCustom()}
						placeholder="e.g. feat/"
						aria-label="Custom branch prefix"
						aria-hidden={!customActive}
						tabIndex={customActive ? 0 : -1}
						className={cn(
							"h-7 w-48 bg-muted/30 text-[13px] text-foreground placeholder:text-muted-foreground/50",
							!customActive && "invisible pointer-events-none",
						)}
					/>
				</Field>
				<PrefixRadioOption repoId={repo.id} value="none" label="None" />
			</RadioGroup>
		</div>
	);
}

/// Right-aligned preview chip rendered next to the section title.
/// Pulled out so the title row stays at a fixed height regardless of
/// which radio mode is active (None hides the chip via `invisible`,
/// not unmount, so the row's metrics don't shift).
function BranchPrefixPreview({
	prefixType,
	previewPrefix,
	previewBase,
}: {
	prefixType: BranchPrefixType;
	previewPrefix: string;
	previewBase: string;
}) {
	const hidden = prefixType === "none";
	return (
		<div
			className={cn(
				"shrink-0 text-[12px] leading-snug text-muted-foreground",
				hidden && "invisible",
			)}
			aria-hidden={hidden}
		>
			Preview:{" "}
			<span className="font-mono text-foreground/80">
				{previewPrefix}
				{previewBase}
			</span>
			{prefixType === "username" && !previewPrefix ? (
				<span className="ml-1 text-muted-foreground/70">
					(connect an account)
				</span>
			) : null}
		</div>
	);
}

function PrefixRadioOption({
	repoId,
	value,
	label,
}: {
	repoId: string;
	value: BranchPrefixType;
	label: string;
}) {
	const id = `repo-${repoId}-branch-prefix-${value}`;
	return (
		<Field
			orientation="horizontal"
			className="items-center gap-3 rounded-lg px-1 py-0.5"
		>
			<RadioGroupItem value={value} id={id} />
			<FieldContent>
				<FieldLabel htmlFor={id} className="text-foreground">
					{label}
				</FieldLabel>
			</FieldContent>
		</Field>
	);
}

function ScriptField({
	label,
	description,
	placeholder,
	value,
	locked,
	lockedMessage,
	onChange,
	headerRight,
}: {
	label: string;
	description: string;
	placeholder: string;
	value: string;
	locked: boolean;
	lockedMessage: string;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	headerRight?: React.ReactNode;
}) {
	const textarea = (
		<Textarea
			className="mt-2 min-h-[72px] resize-y bg-app-base/30 font-mono text-[12px]"
			placeholder={placeholder}
			value={value}
			onChange={onChange}
			readOnly={locked}
			disabled={locked}
		/>
	);

	return (
		<div>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="text-[12px] font-medium text-app-foreground">
						{label}
					</div>
					<div className="mt-0.5 text-[11px] text-muted-foreground">
						{description}
					</div>
				</div>
				{headerRight && <div className="shrink-0">{headerRight}</div>}
			</div>
			{locked ? (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>{textarea}</TooltipTrigger>
						<TooltipContent side="top">{lockedMessage}</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			) : (
				textarea
			)}
		</div>
	);
}

function ScriptsSection({
	repoId,
	workspaceId,
}: {
	repoId: string;
	workspaceId: string | null;
}) {
	const queryClient = useQueryClient();
	const scriptsQuery = useQuery({
		queryKey: ["repoScripts", repoId, workspaceId],
		queryFn: () => loadRepoScripts(repoId, workspaceId),
		staleTime: 0,
	});

	const data = scriptsQuery.data;
	const setupLocked = data?.setupFromProject ?? false;
	const runLocked = data?.runFromProject ?? false;
	const archiveLocked = data?.archiveFromProject ?? false;

	const [setupScript, setSetupScript] = useState("");
	const [runScript, setRunScript] = useState("");
	const [archiveScript, setArchiveScript] = useState("");
	const [autoRunSetup, setAutoRunSetup] = useState(false);
	const [runExclusive, setRunExclusive] = useState(false);
	const initialized = useRef(false);

	useEffect(() => {
		if (!data) return;
		const shouldSyncSetup = setupLocked || !initialized.current;
		const shouldSyncRun = runLocked || !initialized.current;
		const shouldSyncArchive = archiveLocked || !initialized.current;
		if (shouldSyncSetup) setSetupScript(data.setupScript ?? "");
		if (shouldSyncRun) setRunScript(data.runScript ?? "");
		if (shouldSyncArchive) setArchiveScript(data.archiveScript ?? "");
		if (!initialized.current) {
			setAutoRunSetup(data.autoRunSetup);
			setRunExclusive(data.runScriptMode === "non-concurrent");
		}
		if (!setupLocked && !runLocked && !archiveLocked) {
			initialized.current = true;
		}
	}, [data, setupLocked, runLocked, archiveLocked]);

	// Reset when switching repos.
	useEffect(() => {
		initialized.current = false;
	}, [repoId]);

	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const save = useCallback(
		(nextSetup: string, nextRun: string, nextArchive: string) => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => {
				void updateRepoScripts(
					repoId,
					nextSetup.trim() || null,
					nextRun.trim() || null,
					nextArchive.trim() || null,
				).then(() => {
					void queryClient.invalidateQueries({
						queryKey: ["repoScripts", repoId],
					});
				});
			}, 600);
		},
		[repoId, queryClient],
	);

	const handleSetupChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setSetupScript(value);
			save(value, runScript, archiveScript);
		},
		[runScript, archiveScript, save],
	);

	const handleRunChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setRunScript(value);
			save(setupScript, value, archiveScript);
		},
		[setupScript, archiveScript, save],
	);

	const handleArchiveChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setArchiveScript(value);
			save(setupScript, runScript, value);
		},
		[setupScript, runScript, save],
	);

	const handleAutoRunSetupChange = useCallback(
		(checked: boolean) => {
			setAutoRunSetup(checked);
			void updateRepoAutoRunSetup(repoId, checked).then(() => {
				void queryClient.invalidateQueries({
					queryKey: ["repoScripts", repoId],
				});
			});
		},
		[repoId, queryClient],
	);

	const handleRunExclusiveChange = useCallback(
		(checked: boolean) => {
			setRunExclusive(checked);
			void updateRepoRunScriptMode(
				repoId,
				checked ? "non-concurrent" : "concurrent",
			).then(() => {
				void queryClient.invalidateQueries({
					queryKey: ["repoScripts", repoId],
				});
			});
		},
		[repoId, queryClient],
	);

	const setupHasScript = !!setupScript.trim();
	const runHasScript = !!runScript.trim();

	return (
		<div className="py-5">
			<div className="text-[13px] font-medium leading-snug text-foreground">
				Scripts
			</div>
			<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
				Commands that run when workspaces are set up, run, or archived.
			</div>

			<div className="mt-4 space-y-4">
				<ScriptField
					label="Setup script"
					description="Available from the Setup tab in any workspace"
					placeholder="e.g., npm install"
					value={setupScript}
					locked={setupLocked}
					lockedMessage="Set by this workspace's helmor.json — edit it there"
					onChange={handleSetupChange}
					headerRight={
						<div className="flex items-center gap-1.5">
							<span className="text-[11px] font-medium text-muted-foreground">
								Auto-run
							</span>
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<HelpCircle
											className="size-3 cursor-help text-muted-foreground/70"
											strokeWidth={1.8}
										/>
									</TooltipTrigger>
									<TooltipContent side="top" className="max-w-[240px]">
										On by default — setup runs automatically as soon as a
										workspace is created. Turn off to run it manually from the
										Setup tab.
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
							<Switch
								checked={autoRunSetup}
								onCheckedChange={handleAutoRunSetupChange}
								disabled={!setupHasScript}
								aria-label="Auto-run setup script on workspace creation"
							/>
						</div>
					}
				/>
				<ScriptField
					label="Run script"
					description="Runs when you click the play button"
					placeholder="e.g., npm run dev"
					value={runScript}
					locked={runLocked}
					lockedMessage="Set by this workspace's helmor.json — edit it there"
					onChange={handleRunChange}
					headerRight={
						<div className="flex items-center gap-1.5">
							<span className="text-[11px] font-medium text-muted-foreground">
								Exclusive
							</span>
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<HelpCircle
											className="size-3 cursor-help text-muted-foreground/70"
											strokeWidth={1.8}
										/>
									</TooltipTrigger>
									<TooltipContent side="top" className="max-w-[240px]">
										Only let one workspace run this script at a time. Starting a
										new run stops any other run in this repository — useful when
										the script binds a fixed port.
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
							<Switch
								checked={runExclusive}
								onCheckedChange={handleRunExclusiveChange}
								disabled={!runHasScript}
								aria-label="Stop other runs in this repository when starting a new run"
							/>
						</div>
					}
				/>
				<ScriptField
					label="Archive script"
					description="Runs when a workspace is archived"
					placeholder="e.g., docker compose down"
					value={archiveScript}
					locked={archiveLocked}
					lockedMessage="Set by this workspace's helmor.json — edit it there"
					onChange={handleArchiveChange}
				/>
			</div>
		</div>
	);
}

function DeleteRepoSection({
	repo,
	onDeleted,
}: {
	repo: RepositoryCreateOption;
	onDeleted: () => void;
}) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleDelete = useCallback(async () => {
		setDeleting(true);
		setError(null);
		try {
			await deleteRepository(repo.id);
			setConfirmOpen(false);
			onDeleted();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setDeleting(false);
		}
	}, [repo.id, onDeleted]);

	return (
		<>
			<div className="py-5">
				<div className="flex items-center gap-2 text-[13px] font-medium leading-snug text-foreground">
					<Trash2 className="size-3.5 text-destructive" strokeWidth={1.8} />
					Delete Repository
				</div>
				<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
					Permanently remove this repository and all its workspaces, sessions,
					and messages.
				</div>
				<Button
					variant="destructive"
					size="sm"
					className="mt-3"
					onClick={() => {
						setError(null);
						setConfirmOpen(true);
					}}
				>
					Delete Repository
				</Button>
				{error && (
					<div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
						{error}
					</div>
				)}
			</div>

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={`Delete ${repo.name}?`}
				description={
					<>
						This will permanently delete all workspaces, sessions, and messages
						associated with{" "}
						<strong className="text-foreground/80">{repo.name}</strong>. This
						cannot be undone.
					</>
				}
				confirmLabel={deleting ? "Deleting..." : "Delete"}
				onConfirm={() => void handleDelete()}
				loading={deleting}
			/>
		</>
	);
}
