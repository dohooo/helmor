import {
	ChevronDown,
	Funnel,
	Loader2,
	Pickaxe,
	SlidersHorizontal,
	X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { GithubBrandIcon } from "@/components/brand-icon";
import { TrafficLightSpacer } from "@/components/chrome/traffic-light-spacer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { InboxItem } from "@/lib/api";
import type { ContextCard, ContextCardSource } from "@/lib/sources/types";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";
import { cn } from "@/lib/utils";
import { SourceCard } from "./source-card";
import { SourceIcon } from "./source-icon";
import { useInboxItems } from "./use-inbox-items";

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
	id: "linear" | "github" | "slack";
	label: string;
	sources: ContextCardSource[];
};

type GitHubTypeFilter = {
	id: "all" | "github_issue" | "github_pr" | "github_discussion";
	label: string;
	sources: Extract<
		ContextCardSource,
		"github_issue" | "github_pr" | "github_discussion"
	>[];
};

const SOURCE_FILTERS: SourceFilter[] = [
	{
		id: "github",
		label: "GitHub",
		sources: ["github_issue", "github_pr", "github_discussion"],
	},
	{ id: "linear", label: "Linear", sources: ["linear"] },
	{ id: "slack", label: "Slack", sources: ["slack_thread"] },
];

const GITHUB_TYPE_FILTERS: GitHubTypeFilter[] = [
	{
		id: "all",
		label: "All",
		sources: ["github_issue", "github_pr", "github_discussion"],
	},
	{ id: "github_issue", label: "Issues", sources: ["github_issue"] },
	{ id: "github_pr", label: "Pull requests", sources: ["github_pr"] },
	{
		id: "github_discussion",
		label: "Discussions",
		sources: ["github_discussion"],
	},
];

export const InboxSidebar = memo(function InboxSidebar({
	className,
	onOpenCard,
	selectedCardId,
}: {
	className?: string;
	onOpenCard?: (card: ContextCard) => void;
	selectedCardId?: string | null;
}) {
	const [selectedSource, setSelectedSource] =
		useState<SourceFilter["id"]>("github");
	const [githubTypeFilter, setGithubTypeFilter] =
		useState<GitHubTypeFilter["id"]>("all");
	const selectedFilter =
		SOURCE_FILTERS.find((filter) => filter.id === selectedSource) ??
		SOURCE_FILTERS[0];
	const selectedGitHubTypeFilter =
		GITHUB_TYPE_FILTERS.find((filter) => filter.id === githubTypeFilter) ??
		GITHUB_TYPE_FILTERS[0];
	const isComingSoonSource = selectedFilter.id !== "github";
	const accountsQuery = useForgeAccountsAll();
	const hasGithubAccount = useMemo(
		() => (accountsQuery.data ?? []).some((a) => a.provider === "github"),
		[accountsQuery.data],
	);
	const inbox = useInboxItems();
	const filteredCards = useMemo<ContextCard[]>(() => {
		// The Rust adapter only emits github_* items today; the type-tab
		// filter then narrows further to the user's selected sub-type.
		const allowed = new Set(selectedGitHubTypeFilter.sources);
		return inbox.items
			.filter((item) =>
				allowed.has(item.source as GitHubTypeFilter["sources"][number]),
			)
			.map(inboxItemToContextCard);
	}, [inbox.items, selectedGitHubTypeFilter]);

	// IntersectionObserver-driven infinite scroll. Sentinel at the
	// bottom of the list — entering the visible area pages forward.
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (selectedFilter.id !== "github") return;
		if (!inbox.hasNextPage || inbox.isFetchingNextPage) return;
		const el = sentinelRef.current;
		if (!el) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						inbox.fetchNextPage();
						break;
					}
				}
			},
			{ rootMargin: "120px 0px" },
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
			<div
				data-slot="window-safe-top"
				className="flex h-9 shrink-0 items-center pr-3"
			>
				<TrafficLightSpacer side="left" width={94} />
				<div data-tauri-drag-region className="h-full flex-1" />
			</div>

			<div className="-mt-1 pr-4 pl-3">
				<div className="grid w-full grid-cols-3 gap-1 rounded-lg border border-border/60 bg-background/40 p-1">
					{SOURCE_FILTERS.map((filter) => (
						<button
							key={filter.id}
							type="button"
							aria-label={filter.label}
							aria-pressed={selectedSource === filter.id}
							title={filter.label}
							onClick={() => setSelectedSource(filter.id)}
							className={cn(
								"relative flex h-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,box-shadow]",
								"hover:bg-accent/60 hover:text-foreground",
								selectedSource === filter.id &&
									"bg-accent text-foreground shadow-xs",
							)}
						>
							<span className="relative inline-flex">
								{filter.id === "github" ? (
									<GithubBrandIcon size={14} />
								) : filter.id === "slack" ? (
									<SourceIcon source="slack_thread" size={14} />
								) : (
									<SourceIcon source="linear" size={14} />
								)}
							</span>
						</button>
					))}
				</div>
			</div>

			{selectedFilter.id === "github" ? (
				<div className="mt-1.5 flex h-5 items-center justify-between gap-1.5 pr-4 pl-3">
					{selectedGitHubTypeFilter.id !== "all" ? (
						<Badge
							variant="secondary"
							className="h-5 max-w-[122px] rounded-md border border-border/50 bg-accent/50 px-1.5 py-0 text-[10.5px] leading-none text-muted-foreground"
						>
							<span className="truncate">{selectedGitHubTypeFilter.label}</span>
							<button
								type="button"
								aria-label={`Clear ${selectedGitHubTypeFilter.label} filter`}
								onClick={() => setGithubTypeFilter("all")}
								className="ml-0.5 flex size-3.5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/75 hover:bg-foreground/10 hover:text-foreground"
							>
								<X className="size-2.5" strokeWidth={2} />
							</button>
						</Badge>
					) : (
						<div className="min-w-0" />
					)}

					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="xs"
								className="h-5 gap-1 rounded-md px-1.5 text-[10.5px] leading-none text-muted-foreground hover:text-foreground"
							>
								<Funnel className="size-2.5" strokeWidth={2} />
								Filter
								<ChevronDown className="size-2.5" strokeWidth={2} />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-36">
							<DropdownMenuRadioGroup
								value={githubTypeFilter}
								onValueChange={(value) =>
									setGithubTypeFilter(value as GitHubTypeFilter["id"])
								}
							>
								{GITHUB_TYPE_FILTERS.map((filter) => (
									<DropdownMenuRadioItem key={filter.id} value={filter.id}>
										{filter.label}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			) : null}

			<div
				className={cn(
					"scrollbar-stable min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-4 pl-3 [scrollbar-width:thin]",
					selectedFilter.id === "github" ? "mt-1" : "mt-[7px]",
				)}
			>
				<div className="flex w-[calc(100%+12px)] flex-col gap-2 pb-3">
					{isComingSoonSource ? (
						<div className="mt-8 flex w-full items-center justify-center gap-2 px-3 text-muted-foreground/65">
							<Pickaxe
								className="kanban-coming-soon-pickaxe size-3.5 shrink-0"
								strokeWidth={2}
							/>
							<span className="text-[13px] font-medium">Coming Soon</span>
						</div>
					) : !hasGithubAccount ? (
						<GithubInboxEmptyState
							hasGithubAccount={false}
							onConfigure={openInboxSettings}
						/>
					) : inbox.isLoading ? (
						<InboxLoadingState />
					) : inbox.error ? (
						<InboxErrorState error={inbox.error} onRetry={inbox.refetch} />
					) : filteredCards.length > 0 ? (
						<>
							{filteredCards.map((card) => (
								<SourceCard
									key={card.id}
									card={card}
									selected={card.id === selectedCardId}
									onOpen={onOpenCard}
								/>
							))}
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
						<GithubInboxEmptyState
							hasGithubAccount={hasGithubAccount}
							onConfigure={openInboxSettings}
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
		error instanceof Error ? error.message : "Couldn't load inbox items.";
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
function inboxItemToContextCard(item: InboxItem): ContextCard {
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

function GithubInboxEmptyState({
	hasGithubAccount,
	onConfigure,
}: {
	hasGithubAccount: boolean;
	onConfigure: () => void;
}) {
	const description = hasGithubAccount
		? "Issues, PRs, and discussions you're involved in will surface here. Pick which ones in Configure."
		: "Connect a GitHub account in Configure to surface your issues, PRs, and discussions here.";

	return (
		<div className="mt-8 flex flex-col items-center gap-2 px-6 text-center">
			<div className="flex size-8 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
				<GithubBrandIcon size={16} />
			</div>
			<div className="text-[13px] font-medium text-foreground">
				{hasGithubAccount ? "No GitHub items yet" : "GitHub not configured"}
			</div>
			<div className="text-[12px] leading-5 text-muted-foreground">
				{description}
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
