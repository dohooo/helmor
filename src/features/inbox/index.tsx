import {
	ChevronDown,
	Loader2,
	Pickaxe,
	Search,
	SlidersHorizontal,
	Smartphone,
	X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { GithubBrandIcon, GitlabBrandIcon } from "@/components/brand-icon";
import { TrafficLightSpacer } from "@/components/chrome/traffic-light-spacer";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ComposerInsertTarget } from "@/lib/composer-insert";
import {
	DEFAULT_INBOX_ACCOUNT_TOGGLES,
	type InboxAccountSourceToggles,
	useSettings,
} from "@/lib/settings";
import type { ContextCard, ContextCardSource } from "@/lib/sources/types";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";
import { cn } from "@/lib/utils";
import { SourceCard } from "./source-card";
import { SourceIcon } from "./source-icon";
import {
	type InboxItemWithDetailRef,
	type InboxKind,
	useInboxItems,
} from "./use-inbox-items";

/** Map the GitHub sub-tab id to the kind the inbox hook fetches. The
 *  GitHubTypeFilter ids share the same string shape as `ContextCardSource`,
 *  so a single literal table keeps them in sync. */
const TAB_TO_INBOX_KIND: Record<GitHubTypeFilter["id"], InboxKind> = {
	github_issue: "issues",
	github_pr: "prs",
	github_discussion: "discussions",
};

function isGitHubTypeEnabled(
	filter: GitHubTypeFilter,
	toggles: InboxAccountSourceToggles,
) {
	return toggles[TAB_TO_INBOX_KIND[filter.id]];
}

/** Matches the constant in App.tsx — keep these in sync (one of two
 * dispatchers in the codebase). Centralising would require a new shared
 * module just for one string; for now we duplicate. */
const OPEN_SETTINGS_EVENT = "helmor:open-settings";

function openInboxSettings() {
	window.dispatchEvent(
		new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: "inbox" } }),
	);
}

type SourceFilter = {
	id: "github" | "gitlab" | "linear" | "slack" | "mobile";
	label: string;
	sources: ContextCardSource[];
};

type GitHubTypeFilter = {
	id: "github_issue" | "github_pr" | "github_discussion";
	label: string;
	sources: Extract<
		ContextCardSource,
		"github_issue" | "github_pr" | "github_discussion"
	>[];
};

type GitHubStateFilter = {
	id: "all" | "open" | "closed" | "merged" | "answered" | "unanswered";
	label: string;
};

const SOURCE_FILTERS: SourceFilter[] = [
	{
		id: "github",
		label: "GitHub",
		sources: ["github_issue", "github_pr", "github_discussion"],
	},
	{ id: "gitlab", label: "GitLab", sources: [] },
	{ id: "linear", label: "Linear", sources: ["linear"] },
	{ id: "slack", label: "Slack", sources: ["slack_thread"] },
	{ id: "mobile", label: "Mobile", sources: [] },
];

const COMING_SOON_COPY: Record<
	Exclude<SourceFilter["id"], "github">,
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

const GITHUB_TYPE_FILTERS: GitHubTypeFilter[] = [
	{ id: "github_issue", label: "Issues", sources: ["github_issue"] },
	{ id: "github_pr", label: "PRs", sources: ["github_pr"] },
	{
		id: "github_discussion",
		label: "Discussions",
		sources: ["github_discussion"],
	},
];

const GITHUB_STATE_FILTERS: Record<
	GitHubTypeFilter["id"],
	GitHubStateFilter[]
> = {
	github_issue: [
		{ id: "all", label: "All" },
		{ id: "open", label: "Open" },
		{ id: "closed", label: "Closed" },
	],
	github_pr: [
		{ id: "all", label: "All" },
		{ id: "open", label: "Open" },
		{ id: "closed", label: "Closed" },
		{ id: "merged", label: "Merged" },
	],
	github_discussion: [
		{ id: "all", label: "All" },
		{ id: "answered", label: "Answered" },
		{ id: "unanswered", label: "Unanswered" },
	],
};

function defaultStateForGitHubType(
	filterId: GitHubTypeFilter["id"],
	toggles: InboxAccountSourceToggles,
): GitHubStateFilter["id"] {
	if (filterId === "github_issue") return toggles.issueState;
	if (filterId === "github_pr") return toggles.prState;
	return toggles.discussionState;
}
function useDebouncedValue<T>(value: T, delayMs: number) {
	const [debouncedValue, setDebouncedValue] = useState(value);
	useEffect(() => {
		const timer = window.setTimeout(() => setDebouncedValue(value), delayMs);
		return () => window.clearTimeout(timer);
	}, [value, delayMs]);
	return debouncedValue;
}

export const InboxSidebar = memo(function InboxSidebar({
	className,
	onOpenCard,
	selectedCardId,
	repoFilter,
	providerTab,
	providerSourceTab,
	onProviderTabChange,
	onProviderSourceTabChange,
	stateFilterBySource,
	onStateFilterBySourceChange,
	appendContextTarget,
	showWindowSafeTop = true,
}: {
	className?: string;
	onOpenCard?: (card: ContextCard) => void;
	selectedCardId?: string | null;
	appendContextTarget?: ComposerInsertTarget;
	showWindowSafeTop?: boolean;
	/** GitHub `owner/name` to scope the inbox queries to a single repo,
	 *  driven by the kanban header's repo picker. `null` = unfiltered
	 *  (the user's global "involves:@me" feed). */
	repoFilter?: string | null;
	/** Controlled top-level provider tab (e.g. "github"). When provided,
	 *  the parent owns the selection so it can be persisted across
	 *  restarts; otherwise the sidebar manages its own state. */
	providerTab?: SourceFilter["id"];
	onProviderTabChange?: (tab: SourceFilter["id"]) => void;
	/** Controlled GitHub sub-tab id (issue/pr/discussion). Same
	 *  controlled-vs-internal pattern as `providerTab`. */
	providerSourceTab?: GitHubTypeFilter["id"];
	onProviderSourceTabChange?: (tab: GitHubTypeFilter["id"]) => void;
	stateFilterBySource?: Record<string, string>;
	onStateFilterBySourceChange?: (filters: Record<string, string>) => void;
}) {
	const [internalSelectedSource, setInternalSelectedSource] =
		useState<SourceFilter["id"]>("github");
	const [internalGithubTypeFilter, setInternalGithubTypeFilter] =
		useState<GitHubTypeFilter["id"]>("github_issue");
	const selectedSource = providerTab ?? internalSelectedSource;
	const githubTypeFilter = providerSourceTab ?? internalGithubTypeFilter;
	const setSelectedSource = (next: SourceFilter["id"]) => {
		setInternalSelectedSource(next);
		onProviderTabChange?.(next);
	};
	const setGithubTypeFilter = (next: GitHubTypeFilter["id"]) => {
		setInternalGithubTypeFilter(next);
		onProviderSourceTabChange?.(next);
	};
	const [searchQuery, setSearchQuery] = useState("");
	const debouncedSearchQuery = useDebouncedValue(searchQuery, 250);
	const selectedFilter =
		SOURCE_FILTERS.find((filter) => filter.id === selectedSource) ??
		SOURCE_FILTERS[0];
	const selectedGitHubTypeFilter =
		GITHUB_TYPE_FILTERS.find((filter) => filter.id === githubTypeFilter) ??
		GITHUB_TYPE_FILTERS[0];
	const isComingSoonSource = selectedFilter.id !== "github";
	const accountsQuery = useForgeAccountsAll();
	const { settings } = useSettings();
	const primaryGithubAccount = useMemo(
		() => (accountsQuery.data ?? []).find((a) => a.provider === "github"),
		[accountsQuery.data],
	);
	const hasGithubAccount = useMemo(
		() => Boolean(primaryGithubAccount),
		[primaryGithubAccount],
	);
	const currentInboxToggles = useMemo(() => {
		if (!primaryGithubAccount) return DEFAULT_INBOX_ACCOUNT_TOGGLES;
		const key = `${primaryGithubAccount.provider}:${primaryGithubAccount.login}`;
		return (
			settings.inboxSourceConfig?.accounts?.[key] ??
			DEFAULT_INBOX_ACCOUNT_TOGGLES
		);
	}, [primaryGithubAccount, settings.inboxSourceConfig]);
	const enabledGitHubTypeFilters = useMemo(
		() =>
			GITHUB_TYPE_FILTERS.filter((filter) =>
				isGitHubTypeEnabled(filter, currentInboxToggles),
			),
		[currentInboxToggles],
	);
	const activeGitHubTypeFilter =
		enabledGitHubTypeFilters.find((filter) => filter.id === githubTypeFilter) ??
		enabledGitHubTypeFilters[0] ??
		selectedGitHubTypeFilter;
	const stateOptions = GITHUB_STATE_FILTERS[activeGitHubTypeFilter.id];
	const stateFilter =
		stateFilterBySource?.[activeGitHubTypeFilter.id] ??
		defaultStateForGitHubType(activeGitHubTypeFilter.id, currentInboxToggles);
	const setStateFilter = (next: GitHubStateFilter["id"]) => {
		onStateFilterBySourceChange?.({
			...(stateFilterBySource ?? {}),
			[activeGitHubTypeFilter.id]: next,
		});
	};
	const activeStateFilter =
		stateOptions.find((filter) => filter.id === stateFilter) ?? stateOptions[0];
	const effectiveStateFilter = activeStateFilter.id;
	const trimmedSearchQuery = debouncedSearchQuery.trim();
	const inboxFilters = useMemo(
		() => ({
			query: trimmedSearchQuery || null,
			state: effectiveStateFilter === "all" ? null : effectiveStateFilter,
		}),
		[effectiveStateFilter, trimmedSearchQuery],
	);

	useEffect(() => {
		if (enabledGitHubTypeFilters.length === 0) return;
		if (
			enabledGitHubTypeFilters.some((filter) => filter.id === githubTypeFilter)
		) {
			return;
		}
		setGithubTypeFilter(enabledGitHubTypeFilters[0].id);
	}, [enabledGitHubTypeFilters, githubTypeFilter]);

	useEffect(() => {
		if (stateOptions.some((filter) => filter.id === stateFilter)) return;
		setStateFilter("all");
	}, [stateOptions, stateFilter]);

	const showGitHubTypeSelect =
		selectedFilter.id === "github" && enabledGitHubTypeFilters.length > 1;
	const horizontalPaddingClass = showWindowSafeTop
		? "pr-4 pl-3"
		: "pr-3 pl-2.5";
	const providerTabsCompact = !showWindowSafeTop;
	// Each sub-tab drives its own infinite query: the backend's
	// merge-then-truncate window otherwise crowds out kinds with less
	// recent activity (issues + discussions get pushed past the visible
	// page when PRs dominate). Keying the hook on the active tab also
	// means TanStack reuses each tab's previous pages on switch-back.
	const inboxKind = TAB_TO_INBOX_KIND[activeGitHubTypeFilter.id];
	const inbox = useInboxItems(inboxKind, repoFilter ?? null, inboxFilters);
	const filteredCards = useMemo<ContextCard[]>(
		() => inbox.items.map(inboxItemToContextCard),
		[inbox.items],
	);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);

	// IntersectionObserver-driven infinite scroll. Sentinel at the
	// bottom of the list — entering the visible area pages forward.
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (selectedFilter.id !== "github") return;
		if (!inbox.hasNextPage || inbox.isFetchingNextPage) return;
		const el = sentinelRef.current;
		if (!el) return;
		const root = scrollContainerRef.current;
		if (!root) return;
		if (root.scrollHeight <= root.clientHeight + 1) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						inbox.fetchNextPage();
						break;
					}
				}
			},
			{ root, rootMargin: "120px 0px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [
		inbox.hasNextPage,
		inbox.isFetchingNextPage,
		inbox.fetchNextPage,
		selectedFilter.id,
		filteredCards.length,
	]);

	return (
		<div className={cn("h-full min-h-0 flex-col overflow-hidden", className)}>
			{showWindowSafeTop ? (
				<div
					data-slot="window-safe-top"
					className="flex h-9 shrink-0 items-center pr-3"
				>
					<TrafficLightSpacer side="left" width={94} />
					<div data-tauri-drag-region className="h-full flex-1" />
				</div>
			) : null}

			<div
				className={cn(
					horizontalPaddingClass,
					showWindowSafeTop ? "-mt-1" : "pt-1",
				)}
			>
				<div
					className={cn(
						"grid w-full grid-cols-5 border border-border/60 bg-background/40",
						providerTabsCompact
							? "gap-0.5 rounded-md p-0.5"
							: "gap-1 rounded-lg p-1",
					)}
				>
					{SOURCE_FILTERS.map((filter) => (
						<button
							key={filter.id}
							type="button"
							aria-label={filter.label}
							aria-pressed={selectedSource === filter.id}
							title={filter.label}
							onClick={() => setSelectedSource(filter.id)}
							className={cn(
								"relative flex cursor-pointer items-center justify-center text-muted-foreground transition-[background-color,color,box-shadow]",
								providerTabsCompact ? "h-6 rounded-[5px]" : "h-7 rounded-md",
								"hover:bg-accent/60 hover:text-foreground",
								selectedSource === filter.id &&
									"bg-accent text-foreground shadow-xs",
							)}
						>
							<span className="relative inline-flex">
								{filter.id === "github" ? (
									<GithubBrandIcon size={providerTabsCompact ? 13 : 14} />
								) : filter.id === "gitlab" ? (
									<GitlabBrandIcon size={providerTabsCompact ? 13 : 14} />
								) : filter.id === "slack" ? (
									<SourceIcon
										source="slack_thread"
										size={providerTabsCompact ? 13 : 14}
									/>
								) : filter.id === "mobile" ? (
									<Smartphone
										size={providerTabsCompact ? 13 : 14}
										strokeWidth={2}
									/>
								) : (
									<SourceIcon
										source="linear"
										size={providerTabsCompact ? 13 : 14}
									/>
								)}
							</span>
						</button>
					))}
				</div>
			</div>

			{selectedFilter.id === "github" ? (
				<div className={cn("mt-1.5", horizontalPaddingClass)}>
					<div className="flex h-7 min-w-0 items-center gap-1.5">
						<div className="flex min-w-0 flex-1 items-center rounded-md border border-border/45 bg-background/35 px-1.5 text-muted-foreground transition-colors focus-within:border-border/80 focus-within:bg-background/55">
							<Search className="size-3 shrink-0" strokeWidth={1.9} />
							<input
								type="text"
								value={searchQuery}
								onChange={(event) => setSearchQuery(event.target.value)}
								placeholder="Search"
								aria-label="Search GitHub contexts"
								className="h-6 min-w-0 flex-1 bg-transparent px-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70"
							/>
							{searchQuery ? (
								<button
									type="button"
									aria-label="Clear search"
									onClick={() => setSearchQuery("")}
									className="flex size-4 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
								>
									<X className="size-3" strokeWidth={2} />
								</button>
							) : null}
						</div>

						{showGitHubTypeSelect ? (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										aria-label={`Filter by ${activeGitHubTypeFilter.label}`}
										title={activeGitHubTypeFilter.label}
										className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/45 bg-background/35 text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground"
									>
										<SourceIcon
											source={activeGitHubTypeFilter.sources[0]}
											size={13}
											className="block"
										/>
									</button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-40">
									<DropdownMenuRadioGroup
										value={activeGitHubTypeFilter.id}
										onValueChange={(value) =>
											setGithubTypeFilter(value as GitHubTypeFilter["id"])
										}
									>
										{enabledGitHubTypeFilters.map((filter) => (
											<DropdownMenuRadioItem
												key={filter.id}
												value={filter.id}
												className="gap-2 text-[11px]"
											>
												<SourceIcon
													source={filter.sources[0]}
													size={12}
													className="shrink-0"
												/>
												<span>{filter.label}</span>
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}

						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/45 bg-background/35 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground"
								>
									<span>{activeStateFilter.label}</span>
									<ChevronDown className="size-3" strokeWidth={2} />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-28">
								<DropdownMenuRadioGroup
									value={activeStateFilter.id}
									onValueChange={(value) =>
										setStateFilter(value as GitHubStateFilter["id"])
									}
								>
									{stateOptions.map((filter) => (
										<DropdownMenuRadioItem
											key={filter.id}
											value={filter.id}
											className="text-[11px]"
										>
											{filter.label}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			) : null}

			<div
				ref={scrollContainerRef}
				className={cn(
					"scrollbar-stable min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-width:thin]",
					horizontalPaddingClass,
					selectedFilter.id === "github" ? "mt-1" : "mt-[7px]",
				)}
			>
				<div className="flex w-[calc(100%+12px)] flex-col gap-2 pb-3">
					{isComingSoonSource ? (
						<div className="flex min-h-[calc(100vh-150px)] w-full items-center justify-center px-3">
							<div className="flex w-full max-w-[250px] flex-col items-stretch text-muted-foreground/65">
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
								<ul className="list-disc space-y-3 pl-4 text-left text-pretty text-[11px] leading-4 marker:text-muted-foreground/35">
									{COMING_SOON_COPY[
										selectedFilter.id as Exclude<SourceFilter["id"], "github">
									].map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
							</div>
						</div>
					) : !hasGithubAccount ? (
						// State 1: no GitHub account at all → big Connect CTA.
						<ConnectGithubState onConfigure={openInboxSettings} />
					) : !inbox.kindEnabled ? (
						// State 2: account exists but the user has turned this
						// kind off in Settings → Context. Don't fetch; nudge them
						// to flip it back on rather than show a misleading
						// "no items" message.
						<KindDisabledState
							kind={inboxKind}
							onConfigure={openInboxSettings}
						/>
					) : inbox.error ? (
						// State 4: query failed (toast already fired in the
						// hook). Inline retry stays as the primary affordance.
						<InboxErrorState error={inbox.error} onRetry={inbox.refetch} />
					) : !inbox.hasResolved ? (
						// State 3: first fetch hasn't resolved yet — show ONLY
						// the spinner. Important: don't fall through to the
						// empty state below until we actually have a response,
						// otherwise "no items" flashes for a frame and the
						// user thinks something's wrong.
						<InboxLoadingState />
					) : filteredCards.length > 0 ? (
						// State 5: list.
						<>
							<div className="flex w-full flex-col gap-2">
								{filteredCards.map((card, index) => (
									<div key={card.id} data-index={index}>
										<SourceCard
											card={card}
											selected={card.id === selectedCardId}
											onOpen={onOpenCard}
											appendContextTarget={appendContextTarget}
										/>
									</div>
								))}
							</div>
							{inbox.hasNextPage ? (
								<div
									ref={sentinelRef}
									aria-hidden="true"
									className="flex h-8 w-full shrink-0 items-center justify-center text-muted-foreground/60"
								>
									{inbox.isFetchingNextPage ? (
										<Loader2
											className="size-3.5 animate-spin"
											strokeWidth={2}
										/>
									) : null}
								</div>
							) : null}
							<ConfigureInboxLink onClick={openInboxSettings} />
						</>
					) : (
						// State 6: query returned 0. Distinct copy depending
						// on whether the user has scoped to a single repo or
						// is looking at the global involves:@me feed —
						// neither has a Configure CTA, the configuration is
						// fine; there's just nothing to triage.
						<NoItemsState kind={inboxKind} repoFilter={repoFilter ?? null} />
					)}
				</div>
			</div>
		</div>
	);
});

function InboxLoadingState() {
	return (
		<div className="mt-8 flex flex-col items-center gap-2 px-6 text-muted-foreground/70">
			<Loader2 className="size-4 animate-spin" strokeWidth={2} />
			<div className="text-[12px] leading-5">Loading items…</div>
		</div>
	);
}

function InboxErrorState({
	error,
	onRetry,
}: {
	error: unknown;
	onRetry: () => void;
}) {
	const message =
		error instanceof Error ? error.message : "Couldn't load context items.";
	return (
		<div className="mt-8 flex flex-col items-center gap-2 px-6 text-center">
			<div className="text-[13px] font-medium text-foreground">
				Couldn't load
			</div>
			<div className="text-[12px] leading-5 text-muted-foreground">
				{message}
			</div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onClick={onRetry}
				className="mt-1 cursor-pointer text-[12px]"
			>
				Try again
			</Button>
		</div>
	);
}

/** Map the Rust-side InboxItem into the existing ContextCard shape that
 * SourceCard renders. `meta` is synthesized as a minimal placeholder —
 * SourceCard reads only `source / externalId / title / state /
 * lastActivityAt`, so the meta variant only needs to satisfy types. */
function inboxItemToContextCard(item: InboxItemWithDetailRef): ContextCard {
	const externalId = item.externalId;
	const number = parseExternalNumber(externalId);
	const repo = parseExternalRepo(externalId);
	const baseFields = {
		id: item.id,
		source: item.source as ContextCardSource,
		externalId,
		externalUrl: item.externalUrl,
		title: item.title,
		subtitle: item.subtitle ?? undefined,
		state: item.state ?? undefined,
		lastActivityAt: item.lastActivityAt,
		detailRef: item.detailRef,
	};
	switch (item.source) {
		case "github_issue":
			return {
				...baseFields,
				meta: {
					type: "github_issue",
					repo,
					number,
					labels: [],
				},
			};
		case "github_pr":
			return {
				...baseFields,
				meta: {
					type: "github_pr",
					repo,
					number,
					additions: 0,
					deletions: 0,
					changedFiles: 0,
				},
			};
		case "github_discussion":
			return {
				...baseFields,
				meta: {
					type: "github_discussion",
					repo,
					number,
					category: { name: "Discussion", emoji: "💬" },
				},
			};
	}
}

function parseExternalNumber(externalId: string): number {
	const idx = externalId.lastIndexOf("#");
	if (idx === -1) return 0;
	const tail = externalId.slice(idx + 1);
	const parsed = Number.parseInt(tail, 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function parseExternalRepo(externalId: string): string {
	const idx = externalId.lastIndexOf("#");
	return idx === -1 ? externalId : externalId.slice(0, idx);
}

function ConfigureInboxLink({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"mt-1 flex cursor-pointer items-center justify-center gap-1.5 self-center rounded-md px-2 py-1 text-[11px] text-muted-foreground/80 transition-colors",
				"hover:bg-accent/40 hover:text-foreground",
			)}
		>
			<SlidersHorizontal className="size-3" strokeWidth={2} />
			Configure
		</button>
	);
}

/** Singular + plural labels per inbox kind, used by the empty / disabled
 *  states for terse, source-specific copy. */
const KIND_LABEL: Record<InboxKind, { plural: string; singular: string }> = {
	issues: { plural: "Issues", singular: "issue" },
	prs: { plural: "Pull requests", singular: "pull request" },
	discussions: { plural: "Discussions", singular: "discussion" },
};

/** State 1: no GitHub account on record. Big CTA — connecting an
 *  account is the only useful action here. */
function ConnectGithubState({ onConfigure }: { onConfigure: () => void }) {
	return (
		<div className="mt-8 flex flex-col items-center gap-2 px-6 text-center">
			<div className="flex size-8 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
				<GithubBrandIcon size={16} />
			</div>
			<div className="text-[13px] font-medium text-foreground">
				Connect GitHub
			</div>
			<Button
				type="button"
				size="sm"
				onClick={onConfigure}
				className="mt-1 cursor-pointer gap-1.5"
			>
				<SlidersHorizontal className="size-3.5" strokeWidth={2} />
				Configure
			</Button>
		</div>
	);
}

/** State 2: this kind is turned off in Settings → Context. Surface that
 *  fact directly so an empty result isn't mistaken for "no items". */
function KindDisabledState({
	kind,
	onConfigure,
}: {
	kind: InboxKind;
	onConfigure: () => void;
}) {
	const lower = KIND_LABEL[kind].plural.toLowerCase();
	return (
		<div className="mt-8 flex flex-col items-center gap-2 px-6 text-center">
			<div className="flex size-8 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
				<SlidersHorizontal className="size-4" strokeWidth={2} />
			</div>
			<div className="text-[13px] font-medium text-foreground">
				{KIND_LABEL[kind].plural} are off
			</div>
			<div className="text-[12px] leading-5 text-muted-foreground">
				Turn {lower} back on in Contexts settings.
			</div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onClick={onConfigure}
				className="mt-1 cursor-pointer gap-1.5 text-[12px]"
			>
				<SlidersHorizontal className="size-3.5" strokeWidth={2} />
				Configure
			</Button>
		</div>
	);
}

/** State 6: query resolved with zero items. No CTA — config is fine,
 *  there's just nothing to triage. Wording bends on whether the user
 *  scoped to a single repo or is looking at their global feed. */
function NoItemsState({
	kind,
	repoFilter,
}: {
	kind: InboxKind;
	repoFilter: string | null;
}) {
	const lower = KIND_LABEL[kind].plural.toLowerCase();
	const title = repoFilter ? `No ${lower} in ${repoFilter}` : `No ${lower} yet`;
	return (
		<div className="mt-8 flex flex-col items-center gap-1 px-6 text-center">
			<div className="text-[12px] leading-5 text-muted-foreground/80">
				{title}
			</div>
		</div>
	);
}
