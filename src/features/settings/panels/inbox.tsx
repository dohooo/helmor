import { useQuery } from "@tanstack/react-query";
import {
	ChevronDown,
	CircleDot,
	GitPullRequest,
	MessagesSquare,
	Pickaxe,
	Plus,
	Smartphone,
	X,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	GithubBrandIcon,
	GitlabBrandIcon,
	LinearBrandIcon,
	SlackBrandIcon,
} from "@/components/brand-icon";
import { CachedAvatar } from "@/components/cached-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import type { GithubLabelOption, RepositoryCreateOption } from "@/lib/api";
import { initialsFor } from "@/lib/initials";
import { githubLabelsQueryOptions } from "@/lib/query-client";
import {
	DEFAULT_INBOX_ACCOUNT_TOGGLES,
	DEFAULT_INBOX_REPO_CONFIG,
	type InboxAccountSourceToggles,
	type InboxDraftFilter,
	type InboxIssueScope,
	type InboxPullRequestScope,
	type InboxRepoSourceConfig,
	type InboxSort,
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

type ToggleField = "issues" | "prs" | "discussions";
type ConfigField = keyof Omit<
	InboxRepoSourceConfig,
	"enabled" | "issues" | "prs" | "discussions"
>;

type Option<T extends string> = {
	value: T;
	label: string;
};

type ContextProviderTab = "github" | "gitlab" | "linear" | "slack" | "mobile";

const PROVIDER_TABS: {
	id: ContextProviderTab;
	label: string;
	icon: ReactNode;
}[] = [
	{ id: "github", label: "GitHub", icon: <GithubBrandIcon size={13} /> },
	{ id: "gitlab", label: "GitLab", icon: <GitlabBrandIcon size={13} /> },
	{ id: "linear", label: "Linear", icon: <LinearBrandIcon size={13} /> },
	{ id: "slack", label: "Slack", icon: <SlackBrandIcon size={13} /> },
	{
		id: "mobile",
		label: "Mobile",
		icon: <Smartphone className="size-3.5" strokeWidth={2} />,
	},
];

const COMING_SOON_COPY: Record<
	Exclude<ContextProviderTab, "github">,
	string[]
> = {
	gitlab: [
		"Link merge requests, issues, and pipeline failures as context.",
		"Turn review threads into targeted fix prompts.",
		"Bring CI logs and branch state into the workspace flow.",
	],
	linear: [
		"Pull in issues, specs, labels, and priorities.",
		"Start workspaces directly from planned tasks.",
		"Keep implementation context tied to product intent.",
	],
	slack: [
		"Capture threads, decisions, and follow-up requests.",
		"Convert discussions into actionable workspace prompts.",
		"Preserve source context without copying long chat history.",
	],
	mobile: [
		"Send tasks, links, and screenshots from your phone.",
		"Keep lightweight review and triage flows in sync.",
		"Hand off mobile-captured context to desktop agents.",
	],
};

const ISSUE_SCOPE_OPTIONS: Option<InboxIssueScope>[] = [
	{ value: "all", label: "All" },
	{ value: "involves", label: "Involves me" },
	{ value: "assigned", label: "Assigned to me" },
	{ value: "mentioned", label: "Mentioned me" },
	{ value: "created", label: "Created by me" },
];

const PR_SCOPE_OPTIONS: Option<InboxPullRequestScope>[] = [
	{ value: "all", label: "All" },
	{ value: "involves", label: "Involves me" },
	{ value: "reviewRequested", label: "Review requested" },
	{ value: "author", label: "Created by me" },
	{ value: "assignee", label: "Assigned to me" },
	{ value: "mentions", label: "Mentioned me" },
	{ value: "reviewedBy", label: "Reviewed by me" },
];

const SORT_OPTIONS: Option<InboxSort>[] = [
	{ value: "updated", label: "Recently updated" },
	{ value: "created", label: "Newest" },
	{ value: "comments", label: "Most commented" },
];

const DRAFT_OPTIONS: Option<InboxDraftFilter>[] = [
	{ value: "exclude", label: "Exclude drafts" },
	{ value: "include", label: "Include drafts" },
	{ value: "only", label: "Drafts only" },
];

/** Triggers App.tsx's settings-route handler to switch to the Accounts
 * panel from inside the Contexts panel — for the "Add account…" dropdown
 * footer. Reuses the same window event the Contexts sidebar uses, so the
 * route is single-source. */
function openAccountSettings() {
	window.dispatchEvent(
		new CustomEvent("helmor:open-settings", {
			detail: { section: "account" },
		}),
	);
}

function parseGithubRepoFilter(
	repository: RepositoryCreateOption | null,
): string | null {
	if (!repository) return null;
	const trimmed = (repository.remoteUrl ?? repository.remote ?? "").trim();
	if (!trimmed) return null;
	const sshMatch = trimmed.match(
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	);
	if (sshMatch) {
		return `${sshMatch[1]}/${sshMatch[2]}`;
	}
	const httpsMatch = trimmed.match(
		/^(?:https?|git|ssh:\/\/git@)?:?\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	);
	if (httpsMatch) {
		return `${httpsMatch[1]}/${httpsMatch[2]}`;
	}
	return null;
}

function splitLabels(value: string): string[] {
	return value
		.split(",")
		.map((label) => label.trim())
		.filter(Boolean);
}

function joinLabels(labels: string[]): string {
	return labels.join(", ");
}

export function InboxSettingsPanel({
	repositories,
}: {
	repositories: RepositoryCreateOption[];
}) {
	const accountsQuery = useForgeAccountsAll();
	const { settings, updateSettings } = useSettings();
	const [activeProvider, setActiveProvider] =
		useState<ContextProviderTab>("github");

	// Currently we only ship the GitHub connector. GitLab accounts exist
	// in the forge layer but Contexts can't pull anything for them yet.
	const githubAccounts = useMemo(
		() => (accountsQuery.data ?? []).filter((a) => a.provider === "github"),
		[accountsQuery.data],
	);

	const githubRepositories = useMemo(
		() =>
			repositories
				.map((repository) => ({
					repository,
					repoFilter: parseGithubRepoFilter(repository),
				}))
				.filter(
					(
						entry,
					): entry is {
						repository: RepositoryCreateOption;
						repoFilter: string;
					} =>
						Boolean(entry.repoFilter) &&
						(!entry.repository.forgeProvider ||
							entry.repository.forgeProvider === "github"),
				),
		[repositories],
	);
	const [selectedRepoFilter, setSelectedRepoFilter] = useState<string | null>(
		null,
	);
	const effectiveRepoFilter =
		selectedRepoFilter &&
		githubRepositories.some((entry) => entry.repoFilter === selectedRepoFilter)
			? selectedRepoFilter
			: (githubRepositories[0]?.repoFilter ?? null);
	const selectedRepository =
		githubRepositories.find((entry) => entry.repoFilter === effectiveRepoFilter)
			?.repository ?? null;
	const selectedAccount =
		githubAccounts.find(
			(account) => account.login === selectedRepository?.forgeLogin,
		) ??
		githubAccounts[0] ??
		null;
	const effectiveLogin = selectedAccount?.login ?? null;
	useEffect(() => {
		if (effectiveRepoFilter && effectiveRepoFilter !== selectedRepoFilter) {
			setSelectedRepoFilter(effectiveRepoFilter);
		}
	}, [effectiveRepoFilter, selectedRepoFilter]);
	const labelsQuery = useQuery({
		...githubLabelsQueryOptions(
			effectiveLogin ?? "",
			effectiveRepoFilter ? [effectiveRepoFilter] : [],
		),
		enabled: Boolean(effectiveLogin) && Boolean(effectiveRepoFilter),
	});
	const labelOptions = labelsQuery.data ?? [];

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
	const currentRepoConfig: InboxRepoSourceConfig = (effectiveRepoFilter
		? currentToggles.repos?.[effectiveRepoFilter]
		: undefined) ?? { ...DEFAULT_INBOX_REPO_CONFIG, enabled: true };

	const setRepoConfig = useCallback(
		(nextRepoConfig: InboxRepoSourceConfig) => {
			if (!accountKey || !effectiveRepoFilter) return;
			void updateSettings({
				inboxSourceConfig: {
					...inboxConfig,
					accounts: {
						...inboxConfig.accounts,
						[accountKey]: {
							...currentToggles,
							repos: {
								...(currentToggles.repos ?? {}),
								[effectiveRepoFilter]: {
									...nextRepoConfig,
									enabled: true,
								},
							},
						},
					},
				},
			});
		},
		[
			accountKey,
			currentToggles,
			effectiveRepoFilter,
			inboxConfig,
			updateSettings,
		],
	);
	const setToggle = useCallback(
		(field: ToggleField, next: boolean) => {
			setRepoConfig({ ...currentRepoConfig, [field]: next });
		},
		[currentRepoConfig, setRepoConfig],
	);
	const setConfig = useCallback(
		<Field extends ConfigField>(
			field: Field,
			next: InboxRepoSourceConfig[Field],
		) => {
			setRepoConfig({ ...currentRepoConfig, [field]: next });
		},
		[currentRepoConfig, setRepoConfig],
	);

	return (
		<div className="space-y-3 pt-2">
			<ProviderTabs
				value={activeProvider}
				onChange={(provider) => setActiveProvider(provider)}
			/>

			{activeProvider !== "github" ? (
				<ProviderComingSoon provider={activeProvider} />
			) : githubAccounts.length === 0 ? (
				<div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/60 px-6 py-10 text-center">
					<div className="flex size-9 items-center justify-center rounded-lg border border-border/50 text-muted-foreground">
						<GithubBrandIcon size={18} />
					</div>
					<div className="text-[13px] font-medium text-foreground">
						Connect a GitHub account
					</div>
					<div className="max-w-[360px] text-[12px] leading-5 text-muted-foreground">
						You need at least one GitHub account before Contexts can pull
						issues, pull requests, or discussions.
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
			) : (
				<SettingsGroup>
					<SettingsRow
						title="Repository"
						description="Choose the repo these Contexts settings apply to."
					>
						<RepoPicker
							repositories={githubRepositories}
							selected={selectedRepository}
							onSelect={setSelectedRepoFilter}
						/>
					</SettingsRow>
					{effectiveRepoFilter ? (
						<div className="py-1">
							<ContextKindSection
								title="Issues"
								icon={<CircleDot className="size-3" strokeWidth={2} />}
								description="Surface issues you're assigned to or have opened."
								enabled={currentRepoConfig.issues}
								onEnabledChange={(next) => setToggle("issues", next)}
							>
								<ContextConfigRow
									title="Scope"
									description="Which issue relationship GitHub should use by default."
								>
									<ScopeMultiSelect
										value={currentRepoConfig.issueScopes}
										options={ISSUE_SCOPE_OPTIONS}
										onChange={(value) => setConfig("issueScopes", value)}
									/>
								</ContextConfigRow>
								<ContextConfigRow
									title="Sort"
									description="Default ordering before any sidebar filters are applied."
								>
									<SettingsSelect
										value={currentRepoConfig.issueSort}
										options={SORT_OPTIONS}
										onChange={(value) => setConfig("issueSort", value)}
									/>
								</ContextConfigRow>
								<ContextConfigRow
									title="Labels"
									description="Only include issues with selected repository labels."
								>
									<LabelMultiSelect
										value={splitLabels(currentRepoConfig.issueLabels)}
										options={labelOptions}
										loading={labelsQuery.isLoading || labelsQuery.isFetching}
										onChange={(value) =>
											setConfig("issueLabels", joinLabels(value))
										}
									/>
								</ContextConfigRow>
							</ContextKindSection>
							<ContextKindSection
								title="Pull requests"
								icon={<GitPullRequest className="size-3" strokeWidth={2} />}
								description="Surface PRs you opened, are review-requested on, or have outstanding reviews."
								enabled={currentRepoConfig.prs}
								onEnabledChange={(next) => setToggle("prs", next)}
							>
								<ContextConfigRow
									title="Scope"
									description="Which pull request relationship GitHub should use by default."
								>
									<ScopeMultiSelect
										value={currentRepoConfig.prScopes}
										options={PR_SCOPE_OPTIONS}
										onChange={(value) => setConfig("prScopes", value)}
									/>
								</ContextConfigRow>
								<ContextConfigRow
									title="Drafts"
									description="Whether draft pull requests appear in the PR feed."
								>
									<SettingsSelect
										value={currentRepoConfig.draftPrs}
										options={DRAFT_OPTIONS}
										onChange={(value) => setConfig("draftPrs", value)}
									/>
								</ContextConfigRow>
								<ContextConfigRow
									title="Sort"
									description="Default ordering before any sidebar filters are applied."
								>
									<SettingsSelect
										value={currentRepoConfig.prSort}
										options={SORT_OPTIONS}
										onChange={(value) => setConfig("prSort", value)}
									/>
								</ContextConfigRow>
								<ContextConfigRow
									title="Labels"
									description="Only include PRs with selected repository labels."
								>
									<LabelMultiSelect
										value={splitLabels(currentRepoConfig.prLabels)}
										options={labelOptions}
										loading={labelsQuery.isLoading || labelsQuery.isFetching}
										onChange={(value) =>
											setConfig("prLabels", joinLabels(value))
										}
									/>
								</ContextConfigRow>
							</ContextKindSection>
							<ContextKindSection
								title="Discussions"
								icon={<MessagesSquare className="size-3" strokeWidth={2} />}
								description="Surface discussions in repos you have access to."
								enabled={currentRepoConfig.discussions}
								onEnabledChange={(next) => setToggle("discussions", next)}
							>
								<ContextConfigRow
									title="Sort"
									description="Default ordering before any sidebar filters are applied."
								>
									<SettingsSelect
										value={currentRepoConfig.discussionSort}
										options={SORT_OPTIONS}
										onChange={(value) => setConfig("discussionSort", value)}
									/>
								</ContextConfigRow>
							</ContextKindSection>
						</div>
					) : (
						<div className="py-8 text-center text-[12px] text-muted-foreground">
							Add or connect a GitHub repository before configuring Contexts.
						</div>
					)}
				</SettingsGroup>
			)}
		</div>
	);
}

function ProviderTabs({
	value,
	onChange,
}: {
	value: ContextProviderTab;
	onChange: (value: ContextProviderTab) => void;
}) {
	return (
		<div className="grid grid-cols-5 gap-1 rounded-lg border border-border/60 bg-background/40 p-1">
			{PROVIDER_TABS.map((tab) => (
				<button
					key={tab.id}
					type="button"
					aria-pressed={value === tab.id}
					onClick={() => onChange(tab.id)}
					className={cn(
						"flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-[background-color,color,box-shadow]",
						"hover:bg-accent/60 hover:text-foreground",
						value === tab.id && "bg-accent text-foreground shadow-xs",
					)}
				>
					{tab.icon}
					<span className="truncate">{tab.label}</span>
				</button>
			))}
		</div>
	);
}

function ProviderComingSoon({
	provider,
}: {
	provider: Exclude<ContextProviderTab, "github">;
}) {
	return (
		<div className="flex min-h-[360px] w-full items-center justify-center px-3 py-8">
			<div className="flex w-full max-w-[380px] flex-col items-stretch text-muted-foreground/65">
				<div className="flex items-center justify-center gap-2">
					<Pickaxe
						className="inbox-coming-soon-pickaxe size-3.5 shrink-0"
						strokeWidth={2}
					/>
					<span className="text-[13px] font-medium">Coming Soon</span>
				</div>
				<div className="my-7 flex items-center gap-2 px-2 text-muted-foreground/20">
					<div className="h-px flex-1 bg-current opacity-60" />
					<div className="size-0.5 rounded-full bg-current opacity-80" />
					<div className="h-px flex-1 bg-current opacity-60" />
				</div>
				<ul className="mx-auto list-disc space-y-3 pl-4 text-left text-pretty text-[11px] leading-4 marker:text-muted-foreground/35">
					{COMING_SOON_COPY[provider].map((line) => (
						<li key={line}>{line}</li>
					))}
				</ul>
			</div>
		</div>
	);
}

function ContextKindSection({
	title,
	icon,
	description,
	enabled,
	onEnabledChange,
	children,
}: {
	title: string;
	icon: ReactNode;
	description: string;
	enabled: boolean;
	onEnabledChange: (enabled: boolean) => void;
	children: ReactNode;
}) {
	return (
		<div className="py-5">
			<div className="flex items-center justify-between gap-4">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5 text-[13px] font-medium leading-snug text-foreground">
						<span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
							{icon}
						</span>
						{title}
					</div>
					<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
						{description}
					</div>
				</div>
				<Switch checked={enabled} onCheckedChange={onEnabledChange} />
			</div>
			{enabled ? (
				<div className="mt-4 divide-y divide-border/25 border-border/30 border-t">
					{children}
				</div>
			) : null}
		</div>
	);
}

function ContextConfigRow({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-4 py-3">
			<div className="min-w-0 flex-1">
				<div className="text-[12px] font-medium leading-snug text-foreground">
					{title}
				</div>
				<div className="mt-1 text-[11px] leading-snug text-muted-foreground">
					{description}
				</div>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

function ScopeMultiSelect<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T[];
	options: Option<T>[];
	onChange: (value: T[]) => void;
}) {
	const allValue = options.find((option) => option.value === "all")?.value;
	const fallbackValue = allValue ?? options[0]?.value;
	const normalizeValues = (values: T[]) => {
		const validValues = values.filter((item) =>
			options.some((option) => option.value === item),
		);
		if (allValue && validValues.includes(allValue)) {
			return [allValue];
		}
		if (validValues.length > 0) {
			return Array.from(new Set(validValues));
		}
		return fallbackValue ? [fallbackValue] : [];
	};
	const selectedValues = normalizeValues(value);
	const selected = options.filter((option) =>
		selectedValues.includes(option.value),
	);
	const toggleValue = (nextValue: T) => {
		if (allValue && nextValue === allValue) {
			onChange([allValue]);
			return;
		}
		const hasValue = selectedValues.includes(nextValue);
		const nextValues = hasValue
			? selectedValues.filter((item) => item !== nextValue)
			: [...selectedValues.filter((item) => item !== allValue), nextValue];
		onChange(normalizeValues(nextValues));
	};
	return (
		<Popover>
			<PopoverTrigger asChild>
				<div
					role="button"
					tabIndex={0}
					className={cn(
						"flex min-h-9 w-[280px] cursor-pointer items-center justify-between gap-2 rounded-lg border border-input bg-muted/20 px-2 py-1 text-left transition-colors",
						"hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
					)}
				>
					<span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
						{selected.map((option) => (
							<Badge
								key={option.value}
								variant="outline"
								className="h-6 gap-1 rounded-md pr-1 text-[11px]"
								onClick={(event) => event.stopPropagation()}
							>
								{option.label}
								<button
									type="button"
									aria-label={`Remove ${option.label}`}
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										toggleValue(option.value);
									}}
									className="inline-flex size-4 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
								>
									<X className="size-3" strokeWidth={2} />
								</button>
							</Badge>
						))}
					</span>
					<ChevronDown
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</div>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[280px] p-1.5">
				<Command>
					<CommandInput placeholder="Search scopes" />
					<CommandList>
						<CommandEmpty>No scopes found.</CommandEmpty>
						<CommandGroup>
							{options.map((option) => {
								const checked = selectedValues.includes(option.value);
								return (
									<CommandItem
										key={option.value}
										value={option.label}
										data-checked={checked}
										onSelect={() => toggleValue(option.value)}
									>
										{option.label}
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function LabelMultiSelect({
	value,
	options,
	loading,
	onChange,
}: {
	value: string[];
	options: GithubLabelOption[];
	loading: boolean;
	onChange: (value: string[]) => void;
}) {
	const optionMap = useMemo(
		() => new Map(options.map((option) => [option.name, option])),
		[options],
	);
	const mergedOptions = useMemo(() => {
		const selectedOnly = value
			.filter((label) => !optionMap.has(label))
			.map((name) => ({ name, color: null, description: null }));
		return [...selectedOnly, ...options];
	}, [optionMap, options, value]);
	const toggleValue = (nextValue: string) => {
		onChange(
			value.includes(nextValue)
				? value.filter((item) => item !== nextValue)
				: [...value, nextValue],
		);
	};
	return (
		<Popover>
			<PopoverTrigger asChild>
				<div
					role="button"
					tabIndex={0}
					className={cn(
						"flex min-h-9 w-[280px] cursor-pointer items-center justify-between gap-2 rounded-lg border border-input bg-muted/20 px-2 py-1 text-left transition-colors",
						"hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
					)}
				>
					<span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
						{value.length > 0 ? (
							value.map((label) => (
								<Badge
									key={label}
									variant="outline"
									className="h-6 gap-1 rounded-md pr-1 text-[11px]"
									onClick={(event) => event.stopPropagation()}
								>
									<LabelColorDot color={optionMap.get(label)?.color} />
									{label}
									<button
										type="button"
										aria-label={`Remove ${label}`}
										onClick={(event) => {
											event.preventDefault();
											event.stopPropagation();
											toggleValue(label);
										}}
										className="inline-flex size-4 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
									>
										<X className="size-3" strokeWidth={2} />
									</button>
								</Badge>
							))
						) : (
							<span className="px-1 text-[12px] text-muted-foreground">
								{loading ? "Loading labels" : "Select labels"}
							</span>
						)}
					</span>
					<ChevronDown
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</div>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[280px] p-1.5">
				<Command>
					<CommandInput placeholder="Search labels" />
					<CommandList>
						<CommandEmpty>
							{loading ? "Loading labels..." : "No labels found."}
						</CommandEmpty>
						<CommandGroup>
							{mergedOptions.map((option) => {
								const checked = value.includes(option.name);
								return (
									<CommandItem
										key={option.name}
										value={option.name}
										data-checked={checked}
										onSelect={() => toggleValue(option.name)}
									>
										<LabelColorDot color={option.color} />
										<span className="truncate">{option.name}</span>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function LabelColorDot({ color }: { color?: string | null }) {
	if (!color) return null;
	return (
		<span
			className="size-2 shrink-0 rounded-full"
			style={{ backgroundColor: `#${color}` }}
		/>
	);
}

function SettingsSelect<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: Option<T>[];
	onChange: (value: T) => void;
}) {
	const selected =
		options.find((option) => option.value === value) ?? options[0];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					className="h-9 w-[180px] cursor-pointer justify-between gap-2 px-3 text-[13px]"
				>
					<span className="truncate">{selected.label}</span>
					<ChevronDown
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-[var(--radix-dropdown-menu-trigger-width)]"
			>
				{options.map((option) => (
					<DropdownMenuItem
						key={option.value}
						onSelect={() => onChange(option.value)}
						className="cursor-pointer text-[13px]"
					>
						{option.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function RepoPicker({
	repositories,
	selected,
	onSelect,
}: {
	repositories: ReadonlyArray<{
		repository: RepositoryCreateOption;
		repoFilter: string;
	}>;
	selected: RepositoryCreateOption | null;
	onSelect: (repoFilter: string) => void;
}) {
	const selectedEntry =
		repositories.find((entry) => entry.repository.id === selected?.id) ?? null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					disabled={repositories.length === 0}
					className="h-10 w-[280px] cursor-pointer justify-between gap-2 px-3 text-[13px]"
				>
					<span className="flex min-w-0 items-center gap-2">
						{selected ? (
							<RepoAvatar repo={selected} />
						) : (
							<GithubBrandIcon size={16} />
						)}
						<span className="min-w-0 truncate font-medium">
							{selected ? selected.name : "Select repo"}
						</span>
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
				{repositories.map((entry) => (
					<DropdownMenuItem
						key={entry.repoFilter}
						onSelect={() => onSelect(entry.repoFilter)}
						className="cursor-pointer gap-2 text-[13px]"
					>
						<RepoAvatar repo={entry.repository} />
						<span className="min-w-0 flex-1 truncate">
							{entry.repository.name}
						</span>
						{selectedEntry?.repoFilter === entry.repoFilter ? (
							<span className="size-1.5 shrink-0 rounded-full bg-primary" />
						) : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function RepoAvatar({ repo }: { repo: RepositoryCreateOption }) {
	return (
		<CachedAvatar
			src={repo.repoIconSrc ?? undefined}
			alt={repo.name}
			fallback={repo.repoInitials ?? initialsFor(repo.name)}
			className="size-5 shrink-0 rounded-md"
			fallbackClassName="rounded-md text-[10px]"
		/>
	);
}
