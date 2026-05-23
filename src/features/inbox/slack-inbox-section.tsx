import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SlackInboxItem } from "@/lib/api";
import type { ComposerInsertTarget } from "@/lib/composer-insert";
import type { ContextCard, SlackThreadMeta } from "@/lib/sources/types";
import { InboxSourceLayout } from "./layout";
import { SlackConnectState } from "./slack-connect-button";
import { SlackWorkspaceSwitcher } from "./slack-workspace-switcher";
import { SourceCard } from "./source-card";
import { useSlackInboxItems } from "./use-slack-inbox-items";
import { useSlackWorkspaces } from "./use-slack-workspaces";

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

	const inbox = useSlackInboxItems(activeTeamId);
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
			<div className="ml-auto">
				<SlackWorkspaceSwitcher
					workspaces={workspaces}
					activeTeamId={activeTeamId}
					onSelect={setActiveTeamId}
				/>
			</div>
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
							{cards.map((card) => (
								<SourceCard
									key={card.id}
									card={card}
									selected={card.id === selectedCardId}
									onOpen={onOpenCard}
									appendContextTarget={appendContextTarget}
								/>
							))}
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
					<EmptyState onRefresh={inbox.refetch} />
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

function EmptyState({ onRefresh }: { onRefresh: () => void }) {
	return (
		<div className="mt-10 flex flex-col items-center gap-2 px-6 text-center">
			<div className="text-ui font-medium text-foreground">No new activity</div>
			<div className="text-small leading-5 text-muted-foreground">
				Mentions and unread DMs will appear here.
			</div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onClick={onRefresh}
				className="mt-1 cursor-interactive text-small"
			>
				Refresh
			</Button>
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
