import { ChevronDown, Loader2 } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SlackInboxItem, SlackSearchSort } from "@/lib/api";
import type { ComposerInsertTarget } from "@/lib/composer-insert";
import type { ContextCard, SlackThreadMeta } from "@/lib/sources/types";
import { InboxActionMenuButton, InboxSearchField } from "./actions";
import { InboxSourceLayout } from "./layout";
import { SlackConnectState } from "./slack-connect-button";
import { SlackSourceCard } from "./slack-source-card";
import { SlackWorkspaceSwitcher } from "./slack-workspace-switcher";
import { useDebouncedValue } from "./use-debounced-value";
import { useSlackEmojiMap } from "./use-slack-emoji-map";
import { useSlackInboxItems } from "./use-slack-inbox-items";
import { useSlackSearch } from "./use-slack-search";
import { useSlackWorkspaces } from "./use-slack-workspaces";

/** Sort-mode labels for the right-side dropdown. Order matches Slack's
 *  own UI: timestamp first because the inbox is fundamentally a "what's
 *  new" surface. */
const SORT_OPTIONS: { id: SlackSearchSort; label: string }[] = [
	{ id: "newest", label: "Newest" },
	{ id: "relevance", label: "Most relevant" },
];

/** Self-contained Slack subtree of the Contexts sidebar. Owns:
 *
 *  - active workspace selection (when multiple workspaces are connected)
 *  - workspace switcher in the right-aligned header
 *  - infinite-scroll Activity feed
 *  - empty / loading / error states
 *
 *  Mirrors the visual contract of the forge inbox path so cards open in
 *  the same preview slot as GitHub/GitLab items. */
export function SlackInboxSection({
	onOpenCard,
	selectedCardId,
	appendContextTarget,
	horizontalPaddingClass,
}: {
	onOpenCard?: (card: ContextCard) => void;
	selectedCardId?: string | null;
	appendContextTarget?: ComposerInsertTarget;
	horizontalPaddingClass: string;
}) {
	const workspacesQuery = useSlackWorkspaces();
	const workspaces = workspacesQuery.data ?? [];
	const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
	const [searchInput, setSearchInput] = useState("");
	const debouncedQuery = useDebouncedValue(searchInput, 250);
	const [sort, setSort] = useState<SlackSearchSort>("newest");

	// Auto-select the first workspace once the list resolves. Keeping the
	// state local rather than persisted matches v1 scope: a hard reload
	// always lands on the most-recently-connected workspace.
	useEffect(() => {
		if (workspaces.length === 0) {
			if (activeTeamId !== null) setActiveTeamId(null);
			return;
		}
		const stillExists = workspaces.some((w) => w.teamId === activeTeamId);
		if (!stillExists) {
			setActiveTeamId(workspaces[workspaces.length - 1].teamId);
		}
	}, [workspaces, activeTeamId]);

	// Reset the search box when the user switches workspaces. Carrying a
	// query across workspaces would hit the new workspace's `search.messages`
	// with the wrong intent (the user's mental model is "this box belongs
	// to the workspace I'm looking at").
	useEffect(() => {
		setSearchInput("");
	}, [activeTeamId]);

	// Two data sources behind one renderer: the activity feed (mentions
	// + unread DMs) when the search box is empty, and `search.messages`
	// results when the user is actively typing. Always call both hooks
	// (one will be disabled internally) so the rules-of-hooks order
	// stays stable across the empty ↔ searching transition.
	//
	// We only feed the IPC layer an `activeTeamId` once it actually
	// shows up in the workspaces list — otherwise an import + auto-
	// select race can fire `slack_list_inbox_items` for a team_id the
	// backend hasn't observed yet, yielding a spurious "workspace is
	// not connected" toast right after a successful import.
	const trimmedQuery = debouncedQuery.trim();
	const isSearching = trimmedQuery.length > 0;
	const safeTeamId =
		activeTeamId !== null && workspaces.some((w) => w.teamId === activeTeamId)
			? activeTeamId
			: null;
	const activity = useSlackInboxItems(isSearching ? null : safeTeamId);
	const searchResults = useSlackSearch(safeTeamId, trimmedQuery, sort);
	const inbox = isSearching ? searchResults : activity;
	const emoji = useSlackEmojiMap(safeTeamId);
	const activeWorkspace = useMemo(
		() => workspaces.find((w) => w.teamId === safeTeamId) ?? null,
		[workspaces, safeTeamId],
	);
	const myUserId = activeWorkspace?.myUserId ?? null;
	const cards = useMemo<ContextCard[]>(
		() =>
			inbox.items.map((item) =>
				slackItemToContextCard(
					item,
					workspaces.find((w) => w.teamId === item.teamId)?.teamName ?? "Slack",
				),
			),
		[inbox.items, workspaces],
	);

	const activeSortLabel =
		SORT_OPTIONS.find((option) => option.id === sort)?.label ??
		SORT_OPTIONS[0].label;
	const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
		setSearchInput(event.target.value);
	};

	const sentinelRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const sentinel = sentinelRef.current;
		if (!sentinel || !inbox.hasNextPage) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					inbox.fetchNextPage();
				}
			},
			{ rootMargin: "200px 0px" },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [inbox.hasNextPage, inbox.fetchNextPage]);

	const showConnectState =
		!workspacesQuery.isLoading && workspaces.length === 0;

	const actions =
		workspaces.length > 0 ? (
			<>
				<InboxSearchField
					value={searchInput}
					onChange={handleSearchChange}
					onClear={() => setSearchInput("")}
					ariaLabel="Search Slack messages"
				/>
				{isSearching ? (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<InboxActionMenuButton aria-label={`Sort by ${activeSortLabel}`}>
								<span>{activeSortLabel}</span>
								<ChevronDown className="size-3" strokeWidth={2} />
							</InboxActionMenuButton>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-36">
							<DropdownMenuRadioGroup
								value={sort}
								onValueChange={(value) => setSort(value as SlackSearchSort)}
							>
								{SORT_OPTIONS.map((option) => (
									<DropdownMenuRadioItem
										key={option.id}
										value={option.id}
										className="text-mini"
									>
										{option.label}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
				<SlackWorkspaceSwitcher
					workspaces={workspaces}
					activeTeamId={activeTeamId}
					onSelect={setActiveTeamId}
				/>
			</>
		) : null;

	return (
		<InboxSourceLayout
			horizontalPaddingClass={horizontalPaddingClass}
			actions={actions}
		>
			<div className="flex w-full flex-col gap-2">
				{showConnectState ? (
					<SlackConnectState
						onConnected={(teamId) => setActiveTeamId(teamId)}
					/>
				) : workspacesQuery.isLoading || activeTeamId === null ? (
					<InboxLoadingState />
				) : inbox.error ? (
					<InboxErrorState error={inbox.error} onRetry={inbox.refetch} />
				) : !inbox.hasResolved ? (
					<InboxLoadingState />
				) : cards.length > 0 ? (
					<>
						<div className="flex w-full flex-col gap-2">
							{cards.map((card, index) => {
								const item = inbox.items[index];
								if (!item) return null;
								return (
									<SlackSourceCard
										key={card.id}
										item={item}
										card={card}
										myUserId={myUserId}
										emoji={emoji}
										selected={card.id === selectedCardId}
										onOpen={onOpenCard}
										appendContextTarget={appendContextTarget}
									/>
								);
							})}
						</div>
						{inbox.hasNextPage ? (
							<div
								ref={sentinelRef}
								aria-hidden="true"
								className="flex h-8 w-full shrink-0 items-center justify-center text-muted-foreground/60"
							>
								{inbox.isFetchingNextPage ? (
									<Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
								) : null}
							</div>
						) : null}
					</>
				) : (
					<EmptyState
						isSearching={isSearching}
						query={trimmedQuery}
						onRefresh={inbox.refetch}
					/>
				)}
			</div>
		</InboxSourceLayout>
	);
}

function InboxLoadingState() {
	return (
		<div className="mt-8 flex flex-col items-center gap-2 px-6 text-muted-foreground/70">
			<Loader2 className="size-4 animate-spin" strokeWidth={2} />
			<div className="text-small leading-5">Loading Slack…</div>
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
		error instanceof Error ? error.message : "Couldn't load Slack inbox.";
	return (
		<div className="mt-8 flex flex-col items-center gap-2 px-6 text-center">
			<div className="text-ui font-medium text-foreground">Couldn't load</div>
			<div className="text-small leading-5 text-muted-foreground">
				{message}
			</div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onClick={onRetry}
				className="mt-1 cursor-interactive text-small"
			>
				Try again
			</Button>
		</div>
	);
}

function EmptyState({
	isSearching,
	query,
	onRefresh,
}: {
	isSearching: boolean;
	query: string;
	onRefresh: () => void;
}) {
	// Two distinct empty states: searching with zero hits is a UX
	// dead-end if we say "no new activity" — the user can see they
	// just typed something. The activity-feed empty state stays
	// reassuring ("nothing waiting for you"); the search empty state
	// reminds them what they searched for.
	const title = isSearching ? "No matches" : "No new activity";
	const subtitle = isSearching
		? `Nothing in this workspace matches "${query}".`
		: "Mentions and unread DMs will appear here.";
	return (
		<div className="mt-10 flex flex-col items-center gap-2 px-6 text-center">
			<div className="text-ui font-medium text-foreground">{title}</div>
			<div className="text-small leading-5 text-muted-foreground">
				{subtitle}
			</div>
			{!isSearching ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onRefresh}
					className="mt-1 cursor-interactive text-small"
				>
					Refresh
				</Button>
			) : null}
		</div>
	);
}

function slackItemToContextCard(
	item: SlackInboxItem,
	workspaceName: string,
): ContextCard {
	const meta: SlackThreadMeta = {
		type: "slack_thread",
		workspaceName,
		channelName: item.channelLabel,
		rootAuthor: { name: item.authorName },
	};
	return {
		id: item.id,
		source: "slack_thread",
		externalId: item.channelLabel,
		externalUrl: item.permalink,
		title: titleForItem(item),
		subtitle: item.authorName,
		lastActivityAt: item.tsMillis,
		meta,
	};
}

function titleForItem(item: SlackInboxItem): string {
	if (item.kind === "mention") {
		return item.textSnippet || `${item.authorName} mentioned you`;
	}
	return item.textSnippet || `${item.authorName} sent a message`;
}
