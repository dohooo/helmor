import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Clock3, ExternalLink } from "lucide-react";
import { AppendContextButton } from "@/components/append-context-button";
import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildCardContextPayload } from "@/features/inbox/source-card";
import { SourceIcon } from "@/features/inbox/source-icon";
import { slackGetThreadDetail } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import type { SourceDetailProps } from "../common";
import { formatRelativeTime } from "../common";
import { SlackMessageBubble } from "./message";

const STALE_MS = 60_000;

/** Slack preview pane. Resolves the active card's `(team_id, channel_id,
 *  thread_ts | anchor_ts)` from its id (encoded as
 *  `<team_id>:<channel_id>:<ts>`) and renders either a full thread or a
 *  small history window around a single message. Same single-preview
 *  slot pattern as GitHub/GitLab views — clicking another item replaces
 *  this. */
export function SlackThreadView({
	card,
	appendContextTarget,
}: SourceDetailProps) {
	const parsed = parseCardId(card.id);
	const detailQuery = useQuery({
		queryKey: parsed
			? helmorQueryKeys.slackThread(parsed.teamId, parsed.channelId, parsed.ts)
			: ["slackThread", "missing", card.id],
		queryFn: () =>
			slackGetThreadDetail({
				teamId: parsed!.teamId,
				channelId: parsed!.channelId,
				// We don't reliably know thread_ts client-side; the backend
				// already prefers `conversations.replies` when the anchor ts
				// is a thread root, and falls back to channel history when
				// it isn't. So always pass null and let the backend pick.
				threadTs: null,
				anchorTs: parsed!.ts,
			}),
		enabled: parsed !== null,
		staleTime: STALE_MS,
	});

	if (!parsed) {
		return (
			<div className="flex h-full items-center justify-center px-6 text-ui text-muted-foreground">
				Invalid Slack item reference.
			</div>
		);
	}

	const detail = detailQuery.data;
	const meta = card.meta.type === "slack_thread" ? card.meta : null;
	const headerLabel =
		detail?.channelLabel ?? meta?.channelName ?? card.externalId;
	const workspaceLabel = meta?.workspaceName ?? "Slack";

	return (
		<article className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-y-auto px-4 [contain:content] [scrollbar-gutter:stable]">
			<header className="shrink-0 py-1.5">
				<div className="flex min-w-0 items-center justify-between gap-4">
					<div className="flex min-w-0 flex-wrap items-center gap-2 text-ui text-muted-foreground">
						<span className="inline-flex items-center gap-1 font-medium text-foreground/80">
							<SourceIcon
								source="slack_thread"
								size={13}
								className="shrink-0"
							/>
							{headerLabel}
						</span>
						<span className="text-muted-foreground/70">·</span>
						<span className="font-normal text-muted-foreground/70">
							{workspaceLabel}
						</span>
						<span className="inline-flex items-center gap-1 font-normal text-muted-foreground/70">
							<Clock3 className="size-[13px]" strokeWidth={1.8} />
							{formatRelativeTime(card.lastActivityAt)}
						</span>
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label="Open in Slack"
									onClick={() =>
										card.externalUrl && void openUrl(card.externalUrl)
									}
									disabled={!card.externalUrl}
									className="size-7 cursor-interactive rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
								>
									<ExternalLink className="size-[13px]" strokeWidth={1.8} />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="top">Open in Slack</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex" aria-label="Add to context">
									<AppendContextButton
										subjectLabel={card.title}
										ariaLabel="Add to context"
										getPayload={() =>
											buildCardContextPayload(card, appendContextTarget)
										}
										errorTitle="Couldn't insert context card"
										className="size-7 cursor-interactive rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground [&_svg]:size-[13px]"
									/>
								</span>
							</TooltipTrigger>
							<TooltipContent side="top">Add to context</TooltipContent>
						</Tooltip>
					</div>
				</div>
			</header>

			<div className="min-h-0 flex-1 py-2">
				{detailQuery.isLoading ? (
					<div className="flex h-full items-center justify-center">
						<HelmorLogoAnimated size={42} className="opacity-30" />
					</div>
				) : detailQuery.error ? (
					<div className="flex h-full items-center justify-center text-ui text-muted-foreground">
						{detailQuery.error instanceof Error
							? detailQuery.error.message
							: "Couldn't load Slack thread."}
					</div>
				) : detail ? (
					<div className="divide-y divide-border/40">
						{detail.messages.length === 0 ? (
							<div className="py-8 text-center text-ui text-muted-foreground">
								No messages to show.
							</div>
						) : (
							detail.messages.map((m) => (
								<SlackMessageBubble key={m.ts} message={m} />
							))
						)}
					</div>
				) : null}
			</div>
		</article>
	);
}

/** Inbox items encode their natural key as `<team_id>:<channel_id>:<ts>`
 *  so the preview can resolve the upstream args without an extra round
 *  trip. */
function parseCardId(
	id: string,
): { teamId: string; channelId: string; ts: string } | null {
	const parts = id.split(":");
	if (parts.length !== 3) return null;
	const [teamId, channelId, ts] = parts;
	if (!teamId || !channelId || !ts) return null;
	return { teamId, channelId, ts };
}
