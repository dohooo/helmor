import { MessageSquare, Timer } from "lucide-react";
import type { ContextCard, ContextCardStateTone } from "@/lib/sources/types";
import { cn } from "@/lib/utils";
import { SourceIcon } from "./source-icon";

const STATE_TONE_CLASS: Record<ContextCardStateTone, string> = {
	open: "border-[var(--workspace-sidebar-status-progress)]/30 text-[var(--workspace-sidebar-status-progress)]",
	closed:
		"border-[var(--workspace-sidebar-status-canceled)]/30 text-[var(--workspace-sidebar-status-canceled)]",
	merged:
		"border-[var(--workspace-sidebar-status-done)]/30 text-[var(--workspace-sidebar-status-done)]",
	draft: "border-muted-foreground/25 text-muted-foreground",
	answered:
		"border-[var(--workspace-sidebar-status-done)]/30 text-[var(--workspace-sidebar-status-done)]",
	unanswered:
		"border-[var(--workspace-sidebar-status-review)]/30 text-[var(--workspace-sidebar-status-review)]",
	urgent: "border-destructive/30 text-destructive",
	neutral: "border-border text-muted-foreground",
};

export function SourceCard({ card }: { card: ContextCard }) {
	const transformed = card.transformedWorkspaceIds.length > 0;

	return (
		<article
			aria-label={card.title}
			className={cn(
				"group relative flex min-h-[92px] cursor-grab flex-col gap-2 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-left shadow-xs transition-[border-color,background-color,opacity,box-shadow]",
				"hover:border-border hover:bg-accent/35 active:cursor-grabbing",
				transformed && "opacity-45 grayscale",
			)}
		>
			<div className="flex min-w-0 items-start gap-2">
				<div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-muted-foreground">
					<SourceIcon source={card.source} size={13} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-1.5">
						<span className="truncate text-[13px] font-medium leading-5 text-foreground">
							{card.title}
						</span>
					</div>
					{card.subtitle ? (
						<div className="truncate text-[11px] leading-4 text-muted-foreground">
							{card.subtitle}
						</div>
					) : null}
				</div>
			</div>

			<div className="flex min-w-0 items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
					<SourceIcon
						source={card.source}
						size={11}
						className="shrink-0 opacity-70"
					/>
					<span className="truncate">{card.externalId}</span>
				</div>
				{card.state ? (
					<span
						className={cn(
							"shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] leading-none",
							STATE_TONE_CLASS[card.state.tone],
						)}
					>
						{card.state.label}
					</span>
				) : null}
			</div>

			<div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
				<div className="flex min-w-0 items-center gap-1.5">
					<Timer className="size-3 shrink-0" strokeWidth={2} />
					<span>{formatRelativeTime(card.lastActivityAt)}</span>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<MessageSquare className="size-3" strokeWidth={2} />
					<span>{contextCount(card)}</span>
				</div>
			</div>
		</article>
	);
}

function contextCount(card: ContextCard) {
	switch (card.meta.type) {
		case "linear":
			return card.meta.labels.length;
		case "github_issue":
			return card.meta.commentCount;
		case "github_pr":
			return card.meta.commentCount;
		case "github_discussion":
			return card.meta.commentCount;
		case "slack_thread":
			return card.meta.replyCount;
	}
}

function formatRelativeTime(timestamp: number) {
	const deltaMs = Date.now() - timestamp;
	const minutes = Math.max(1, Math.round(deltaMs / 60_000));
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.round(hours / 24);
	return `${days}d ago`;
}
