import { useQuery } from "@tanstack/react-query";
import {
	ChevronDown,
	Loader2,
	Pickaxe,
	Search,
	SlidersHorizontal,
	Smartphone,
	X,
} from "lucide-react";
import type { ChangeEvent } from "react";
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
import type {
	ForgeProvider,
	InboxKindLabels,
	RepositoryCreateOption,
} from "@/lib/api";
import type { ComposerInsertTarget } from "@/lib/composer-insert";
import { forgeLabelsFor } from "@/lib/forge-labels";
import { parseForgeRepoHost } from "@/lib/forge-repo-filter";
import { inboxKindLabelsQueryOptions } from "@/lib/query-client";
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

/** Forge providers that have an inbox backend implementation. Used to
 *  narrow `repository.forgeProvider` (which can also be "unknown"). */
type ForgeFilterId = "github" | "gitlab";

/** All non-forge providers stay as "Coming Soon" placeholders. */
type ExternalFilterId = "linear" | "slack" | "mobile";

type SourceFilterId = ForgeFilterId | ExternalFilterId;

function isForgeKindEnabled(
	kind: InboxKind,
	toggles: InboxAccountSourceToggles,
) {
	return toggles[kind];
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

type ForgeStateFilterId =
	| "all"
	| "open"
	| "closed"
	| "merged"
	| "answered"
	| "unanswered";

type ForgeStateFilter = {
	id: ForgeStateFilterId;
	/** Generic state-filter copy — same wording across providers, so it
	 *  can stay in frontend. Provider-differentiated copy (PR vs MR)
	 *  comes from `inboxKindLabelsQueryOptions` instead. */
	label: string;
};

const EXTERNAL_FILTER_IDS: ExternalFilterId[] = ["linear", "slack", "mobile"];

/** If the user pastes a GitHub or GitLab issue/PR/MR URL into the
 *  search box, snap the sub-tab to the matching kind so the result
 *  list narrows immediately. Returns `null` when the query isn't a
 *  recognised forge URL. */
function forgeUrlToInboxKind(query: string): InboxKind | null {
	const trimmed = query.trim();
	// GitHub: github.com/owner/repo/(issues|pull)/N
	const gh = trimmed.match(
		/^(?:https?:\/\/)?github\.com\/[^/\s]+\/[^/\s]+\/(issues|pull)\/\d+(?:[/?#].*)?$/i,
	);
	if (gh) return gh[1].toLowerCase() === "issues" ? "issues" : "prs";
	// GitLab: <host>/group/.../project/-/(issues|merge_requests)/N. The
	// `/-/` segment is GitLab-exclusive routing — it disambiguates from
	// generic project paths and is the same on gitlab.com and self-
	// hosted instances.
	const gl = trimmed.match(
		/^(?:https?:\/\/)?[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*\/-\/(issues|merge_requests)\/\d+(?:[/?#].*)?$/i,
	);
	if (gl) return gl[1].toLowerCase() === "issues" ? "issues" : "prs";
	return null;
}

const COMING_SOON_COPY: Record<ExternalFilterId, string[]> = {
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

/** Generic state filter sets per kind. Not provider-differentiated —
 *  Open / Closed / Merged / Answered / Unanswered mean the same thing
 *  on both forges. Provider-specific COPY (e.g. "Merge requests" vs
 *  "Pull requests" for the kind label itself) comes from the backend
 *  via `inboxKindLabelsQueryOptions`. */
const FORGE_STATE_FILTERS: Record<InboxKind, ForgeStateFilter[]> = {
	issues: [
		{ id: "all", label: "All" },
		{ id: "open", label: "Open" },
		{ id: "closed", label: "Closed" },
	],
	prs: [
		{ id: "all", label: "All" },
		{ id: "open", label: "Open" },
		{ id: "closed", label: "Closed" },
		{ id: "merged", label: "Merged" },
	],
	discussions: [
		{ id: "all", label: "All" },
		{ id: "answered", label: "Answered" },
		{ id: "unanswered", label: "Unanswered" },
	],
};

/** Implementation-detail map: which `ContextCardSource` glyph to render
 *  for a given (provider, kind) pair. Not user-facing copy — these are
 *  enum identifiers driving the icon picker, so they stay in the
 *  frontend. The backend's `inboxKindLabels` covers all displayed text. */
const INBOX_KIND_ICON_SOURCE: Record<
	ForgeFilterId,
	Partial<Record<InboxKind, ContextCardSource>>
> = {
	github: {
		issues: "github_issue",
		prs: "github_pr",
		discussions: "github_discussion",
	},
	gitlab: {
		issues: "gitlab_issue",
		prs: "gitlab_mr",
	},
};

function defaultStateForKind(
	kind: InboxKind,
	toggles: InboxAccountSourceToggles,
): ForgeStateFilterId {
	if (kind === "issues") return toggles.issueState;
	if (kind === "prs") return toggles.prState;
	return toggles.discussionState;
}

/** Pick the forge-tab id that corresponds to the project's forge.
 *  Falls back to GitHub for unknown / null — preserves legacy behaviour
 *  on repos whose `forge_provider` column was migrated in late. */
export function forgeFilterIdForRepo(
	repository: RepositoryCreateOption | null,
): ForgeFilterId {
	const provider: ForgeProvider | null | undefined = repository?.forgeProvider;
	if (provider === "gitlab") return "gitlab";
	return "github";
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
	repository,
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
	/** Repository the kanban is currently scoped to. Used to derive
	 *  which forge tab (GitHub vs GitLab) is shown — only the project's
	 *  own forge appears, never both. */
	repository?: RepositoryCreateOption | null;
	/** `owner/name` (GitHub) or `group/.../project` (GitLab) — scopes
	 *  every kind to a single repo on the backend. `null` = unfiltered
	 *  (the user's global involves-me feed). */
	repoFilter?: string | null;
	/** Controlled top-level provider tab id. Includes "github" | "gitlab"
	 *  (the project's forge) plus the external "Coming Soon" providers.
	 *  When provided, the parent owns the selection so it can be
	 *  persisted across restarts; otherwise the sidebar manages its own
	 *  state. */
	providerTab?: SourceFilterId;
	onProviderTabChange?: (tab: SourceFilterId) => void;
	/** Controlled forge sub-tab id (issues / prs / discussions). Same
	 *  controlled-vs-internal pattern as `providerTab`. */
	providerSourceTab?: InboxKind;
	onProviderSourceTabChange?: (tab: InboxKind) => void;
	stateFilterBySource?: Record<string, string>;
	onStateFilterBySourceChange?: (filters: Record<string, string>) => void;
}) {
	const projectForgeId = forgeFilterIdForRepo(repository ?? null);
	const visibleSourceFilters = useMemo<SourceFilterId[]>(
		() => [projectForgeId, ...EXTERNAL_FILTER_IDS],
		[projectForgeId],
	);

	const [internalSelectedSource, setInternalSelectedSource] =
		useState<SourceFilterId>(projectForgeId);
	const [internalForgeTypeFilter, setInternalForgeTypeFilter] =
		useState<InboxKind>("issues");
	const selectedSource = providerTab ?? internalSelectedSource;
	const forgeTypeFilter = providerSourceTab ?? internalForgeTypeFilter;
	const setSelectedSource = (next: SourceFilterId) => {
		setInternalSelectedSource(next);
		onProviderTabChange?.(next);
	};
	const setForgeTypeFilter = (next: InboxKind) => {
		setInternalForgeTypeFilter(next);
		onProviderSourceTabChange?.(next);
	};

	// If the visible set changes (different repo's forge), and the
	// currently-selected provider is the *other* forge that's no longer
	// rendered, snap to the project's forge. External providers stay
	// pinned through repo switches.
	useEffect(() => {
		if (selectedSource !== "github" && selectedSource !== "gitlab") {
			return;
		}
		if (selectedSource === projectForgeId) return;
		setInternalSelectedSource(projectForgeId);
		onProviderTabChange?.(projectForgeId);
	}, [projectForgeId, selectedSource, onProviderTabChange]);

	const [searchQuery, setSearchQuery] = useState("");
	const debouncedSearchQuery = useDebouncedValue(searchQuery, 250);

	const isForgeSource =
		selectedSource === "github" || selectedSource === "gitlab";
	const activeForgeProvider: ForgeFilterId = isForgeSource
		? (selectedSource as ForgeFilterId)
		: projectForgeId;
	const isComingSoonSource = !isForgeSource;
	const activeForgeLabels = forgeLabelsFor(activeForgeProvider);

	// Backend-authoritative kind labels. Provider-specific copy (PR vs
	// MR, "Pull requests" vs "Merge requests", GitHub-only Discussions
	// entry) lives in the Forge layer, never in TypeScript constants.
	const kindLabelsQuery = useQuery(
		inboxKindLabelsQueryOptions(activeForgeProvider),
	);
	const kindLabels: InboxKindLabels[] = kindLabelsQuery.data ?? [];

	const accountsQuery = useForgeAccountsAll();
	const { settings } = useSettings();
	const primaryForgeAccount = useMemo(
		() =>
			(accountsQuery.data ?? []).find(
				(a) => a.provider === activeForgeProvider,
			),
		[accountsQuery.data, activeForgeProvider],
	);
	const hasForgeAccount = useMemo(
		() => Boolean(primaryForgeAccount),
		[primaryForgeAccount],
	);
	const currentInboxToggles = useMemo(() => {
		if (!primaryForgeAccount) return DEFAULT_INBOX_ACCOUNT_TOGGLES;
		const key = `${primaryForgeAccount.provider}:${primaryForgeAccount.login}`;
		return (
			settings.inboxSourceConfig?.accounts?.[key] ??
			DEFAULT_INBOX_ACCOUNT_TOGGLES
		);
	}, [primaryForgeAccount, settings.inboxSourceConfig]);

	const enabledKindLabels = useMemo<InboxKindLabels[]>(
		() =>
			kindLabels.filter((entry) =>
				isForgeKindEnabled(entry.kind, currentInboxToggles),
			),
		[kindLabels, currentInboxToggles],
	);
	const activeKindLabels: InboxKindLabels | null =
		enabledKindLabels.find((entry) => entry.kind === forgeTypeFilter) ??
		enabledKindLabels[0] ??
		null;
	const inboxKind: InboxKind = activeKindLabels?.kind ?? forgeTypeFilter;
	const stateOptions = FORGE_STATE_FILTERS[inboxKind];
	const stateFilter =
		stateFilterBySource?.[inboxKind] ??
		defaultStateForKind(inboxKind, currentInboxToggles);
	const setStateFilter = (next: ForgeStateFilterId) => {
		onStateFilterBySourceChange?.({
			...(stateFilterBySource ?? {}),
			[inboxKind]: next,
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
		if (enabledKindLabels.length === 0) return;
		if (enabledKindLabels.some((entry) => entry.kind === forgeTypeFilter)) {
			return;
		}
		setForgeTypeFilter(enabledKindLabels[0].kind);
	}, [enabledKindLabels, forgeTypeFilter]);

	useEffect(() => {
		if (stateOptions.some((filter) => filter.id === stateFilter)) return;
		setStateFilter("all");
	}, [stateOptions, stateFilter]);

	const showForgeTypeSelect = isForgeSource && enabledKindLabels.length > 1;
	const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
		const nextQuery = event.target.value;
		setSearchQuery(nextQuery);
		// If the user pasted an issue/PR/MR URL, snap to the matching
		// kind. Skips when the kind isn't currently in the enabled set
		// (e.g. discussions disabled in settings, or GitLab where
		// Discussions don't exist).
		const targetKind = forgeUrlToInboxKind(nextQuery);
		if (
			targetKind &&
			targetKind !== forgeTypeFilter &&
			enabledKindLabels.some((entry) => entry.kind === targetKind)
		) {
			setForgeTypeFilter(targetKind);
		}
	};
	const horizontalPaddingClass = showWindowSafeTop
		? "pr-4 pl-3"
		: "pr-3 pl-2.5";
	const providerTabsCompact = !showWindowSafeTop;
	// Host comes from the repo's remote URL — NOT from the bound login.
	// For self-hosted GitLab, the login may live on a different host than
	// the project (e.g. user has a `gitlab.com` account but the project
	// is on `gitlab.example.com`). Without this, the inbox query would
	// 404 every time.
	const inboxHost = useMemo(
		() => parseForgeRepoHost(repository ?? null),
		[repository],
	);
	const inbox = useInboxItems(
		inboxKind,
		repoFilter ?? null,
		inboxFilters,
		activeForgeProvider,
		inboxHost,
	);
	const filteredCards = useMemo<ContextCard[]>(
		() => inbox.items.map(inboxItemToContextCard),
		[inbox.items],
	);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);

	// IntersectionObserver-driven infinite scroll. Sentinel at the
	// bottom of the list — entering the visible area pages forward.
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!isForgeSource) return;
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
		isForgeSource,
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
						"grid w-full border border-border/60 bg-background/40",
						providerTabsCompact
							? "gap-0.5 rounded-md p-0.5"
							: "gap-1 rounded-lg p-1",
					)}
					style={{
						gridTemplateColumns: `repeat(${visibleSourceFilters.length}, minmax(0, 1fr))`,
					}}
				>
					{visibleSourceFilters.map((filterId) => {
						// Top-level tab labels (GitHub / GitLab / Linear / Slack /
						// Mobile) come from the forge-labels mirror for forges and
						// from a fixed map for the external providers.
						const tabLabel =
							filterId === "github" || filterId === "gitlab"
								? forgeLabelsFor(filterId).providerName
								: filterId === "linear"
									? "Linear"
									: filterId === "slack"
										? "Slack"
										: "Mobile";
						return (
							<button
								key={filterId}
								type="button"
								aria-label={tabLabel}
								aria-pressed={selectedSource === filterId}
								title={tabLabel}
								onClick={() => setSelectedSource(filterId)}
								className={cn(
									"relative flex cursor-interactive items-center justify-center text-muted-foreground transition-[background-color,color,box-shadow]",
									providerTabsCompact ? "h-6 rounded-[5px]" : "h-7 rounded-md",
									"hover:bg-accent/60 hover:text-foreground",
									selectedSource === filterId &&
										"bg-accent text-foreground shadow-xs",
								)}
							>
								<span className="relative inline-flex">
									{filterId === "github" ? (
										<GithubBrandIcon size={providerTabsCompact ? 13 : 14} />
									) : filterId === "gitlab" ? (
										<GitlabBrandIcon size={providerTabsCompact ? 13 : 14} />
									) : filterId === "slack" ? (
										<SourceIcon
											source="slack_thread"
											size={providerTabsCompact ? 13 : 14}
										/>
									) : filterId === "mobile" ? (
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
						);
					})}
				</div>
			</div>

			{isForgeSource ? (
				<div className={cn("mt-1.5", horizontalPaddingClass)}>
					<div className="flex h-7 min-w-0 items-center gap-1.5">
						<div className="flex min-w-0 flex-1 items-center rounded-md border border-border/45 bg-background/35 px-1.5 text-muted-foreground transition-colors focus-within:border-border/80 focus-within:bg-background/55">
							<Search className="size-3 shrink-0" strokeWidth={1.9} />
							<input
								type="text"
								value={searchQuery}
								onChange={handleSearchChange}
								placeholder="Search"
								aria-label={`Search ${activeForgeLabels.providerName} contexts`}
								className="h-6 min-w-0 flex-1 bg-transparent px-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70"
							/>
							{searchQuery ? (
								<button
									type="button"
									aria-label="Clear search"
									onClick={() => setSearchQuery("")}
									className="flex size-4 cursor-interactive items-center justify-center rounded-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
								>
									<X className="size-3" strokeWidth={2} />
								</button>
							) : null}
						</div>

						{showForgeTypeSelect && activeKindLabels ? (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										aria-label={`Filter by ${activeKindLabels.short}`}
										title={activeKindLabels.short}
										className="inline-flex size-7 shrink-0 cursor-interactive items-center justify-center rounded-md border border-border/45 bg-background/35 text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground"
									>
										{(() => {
											const source =
												INBOX_KIND_ICON_SOURCE[activeForgeProvider]?.[
													activeKindLabels.kind
												];
											return source ? (
												<SourceIcon
													source={source}
													size={13}
													className="block"
												/>
											) : null;
										})()}
									</button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-40">
									<DropdownMenuRadioGroup
										value={activeKindLabels.kind}
										onValueChange={(value) =>
											setForgeTypeFilter(value as InboxKind)
										}
									>
										{enabledKindLabels.map((entry) => {
											const source =
												INBOX_KIND_ICON_SOURCE[activeForgeProvider]?.[
													entry.kind
												];
											return (
												<DropdownMenuRadioItem
													key={entry.kind}
													value={entry.kind}
													className="gap-2 text-[11px]"
												>
													{source ? (
														<SourceIcon
															source={source}
															size={12}
															className="shrink-0"
														/>
													) : null}
													<span>{entry.short}</span>
												</DropdownMenuRadioItem>
											);
										})}
									</DropdownMenuRadioGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}

						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									className="inline-flex h-7 shrink-0 cursor-interactive items-center gap-1 rounded-md border border-border/45 bg-background/35 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground"
								>
									<span>{activeStateFilter.label}</span>
									<ChevronDown className="size-3" strokeWidth={2} />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-28">
								<DropdownMenuRadioGroup
									value={activeStateFilter.id}
									onValueChange={(value) =>
										setStateFilter(value as ForgeStateFilterId)
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
					isForgeSource ? "mt-1" : "mt-[7px]",
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
									{COMING_SOON_COPY[selectedSource as ExternalFilterId].map(
										(line) => (
											<li key={line}>{line}</li>
										),
									)}
								</ul>
							</div>
						</div>
					) : !hasForgeAccount ? (
						// State 1: no account at all → big Connect CTA.
						<ConnectForgeState
							provider={activeForgeProvider}
							onConfigure={openInboxSettings}
						/>
					) : !inbox.kindEnabled ? (
						// State 2: account exists but the user has turned this
						// kind off in Settings → Context. Don't fetch; nudge them
						// to flip it back on rather than show a misleading
						// "no items" message.
						<KindDisabledState
							labels={activeKindLabels}
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
						// State 6: query resolved with zero items.
						<NoItemsState
							labels={activeKindLabels}
							repoFilter={repoFilter ?? null}
						/>
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
				className="mt-1 cursor-interactive text-[12px]"
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
		case "gitlab_issue":
			return {
				...baseFields,
				meta: {
					type: "gitlab_issue",
					repo,
					number,
					labels: [],
				},
			};
		case "gitlab_mr":
			return {
				...baseFields,
				meta: {
					type: "gitlab_mr",
					repo,
					number,
					draft: item.state?.tone === "draft",
				},
			};
	}
}

function parseExternalNumber(externalId: string): number {
	// GitHub: `owner/name#NN`. GitLab: `group/name#NN` (issue) or
	// `group/name!NN` (MR). We accept either delimiter.
	const idx = Math.max(
		externalId.lastIndexOf("#"),
		externalId.lastIndexOf("!"),
	);
	if (idx === -1) return 0;
	const tail = externalId.slice(idx + 1);
	const parsed = Number.parseInt(tail, 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function parseExternalRepo(externalId: string): string {
	const idx = Math.max(
		externalId.lastIndexOf("#"),
		externalId.lastIndexOf("!"),
	);
	return idx === -1 ? externalId : externalId.slice(0, idx);
}

function ConfigureInboxLink({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"mt-1 flex cursor-interactive items-center justify-center gap-1.5 self-center rounded-md px-2 py-1 text-[11px] text-muted-foreground/80 transition-colors",
				"hover:bg-accent/40 hover:text-foreground",
			)}
		>
			<SlidersHorizontal className="size-3" strokeWidth={2} />
			Configure
		</button>
	);
}

/** State 1: no account on record for the active forge. Big CTA —
 *  connecting an account is the only useful action here. Copy comes
 *  from the forge labels mirror (which itself mirrors the backend
 *  `ForgeLabels` so labels stay authored in one place). */
function ConnectForgeState({
	provider,
	onConfigure,
}: {
	provider: ForgeFilterId;
	onConfigure: () => void;
}) {
	const labels = forgeLabelsFor(provider);
	return (
		<div className="mt-8 flex flex-col items-center gap-2 px-6 text-center">
			<div className="flex size-8 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
				{provider === "github" ? (
					<GithubBrandIcon size={16} />
				) : (
					<GitlabBrandIcon size={16} />
				)}
			</div>
			<div className="text-[13px] font-medium text-foreground">
				{labels.connectAction}
			</div>
			<Button
				type="button"
				size="sm"
				onClick={onConfigure}
				className="mt-1 cursor-interactive gap-1.5"
			>
				<SlidersHorizontal className="size-3.5" strokeWidth={2} />
				Configure
			</Button>
		</div>
	);
}

/** State 2: this kind is turned off in Settings → Context. Surface that
 *  fact directly so an empty result isn't mistaken for "no items".
 *
 *  All copy comes from `labels` (backend-authored). No frontend branches
 *  on PR-vs-MR. */
function KindDisabledState({
	labels,
	onConfigure,
}: {
	labels: InboxKindLabels | null;
	onConfigure: () => void;
}) {
	const plural = labels?.plural ?? "Items";
	const lower = plural.toLowerCase();
	return (
		<div className="mt-8 flex flex-col items-center gap-2 px-6 text-center">
			<div className="flex size-8 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
				<SlidersHorizontal className="size-4" strokeWidth={2} />
			</div>
			<div className="text-[13px] font-medium text-foreground">
				{plural} are off
			</div>
			<div className="text-[12px] leading-5 text-muted-foreground">
				Turn {lower} back on in Contexts settings.
			</div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onClick={onConfigure}
				className="mt-1 cursor-interactive gap-1.5 text-[12px]"
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
	labels,
	repoFilter,
}: {
	labels: InboxKindLabels | null;
	repoFilter: string | null;
}) {
	const lower = (labels?.plural ?? "Items").toLowerCase();
	const title = repoFilter ? `No ${lower} in ${repoFilter}` : `No ${lower} yet`;
	return (
		<div className="mt-8 flex flex-col items-center gap-1 px-6 text-center">
			<div className="text-[12px] leading-5 text-muted-foreground/80">
				{title}
			</div>
		</div>
	);
}
