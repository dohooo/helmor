import type { ContextCard, ContextCardStateTone } from "@/lib/sources/types";
import { cn } from "@/lib/utils";
import { SourceIcon } from "./source-icon";

const STATE_TONE_CLASS: Record<ContextCardStateTone, string> = {
	open: "text-[var(--workspace-sidebar-status-progress)]",
	closed: "text-[var(--workspace-sidebar-status-canceled)]",
	merged: "text-[var(--workspace-sidebar-status-done)]",
	draft: "text-muted-foreground",
	answered: "text-[var(--workspace-sidebar-status-done)]",
	unanswered: "text-[var(--workspace-sidebar-status-review)]",
	urgent: "text-destructive",
	neutral: "text-muted-foreground",
};

export function SourceCard({ card }: { card: ContextCard }) {
	return (
		<article
			aria-label={card.title}
			className={cn(
				"group relative flex flex-col gap-2 rounded-lg border border-border/70 bg-[var(--sidebar)] px-3 pt-2.5 pb-2 text-left shadow-xs transition-[border-color,background-color,opacity,box-shadow]",
				"hover:border-border hover:bg-[var(--accent)]",
			)}
		>
			<div className="min-w-0 flex-1">
				<div className="line-clamp-2 text-[13px] font-medium leading-[18px] text-foreground">
					{card.title}
				</div>
				<div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-4">
					{card.state ? (
						<span
							className={cn(
								"shrink-0 font-medium",
								STATE_TONE_CLASS[card.state.tone],
							)}
						>
							{card.state.label}
						</span>
					) : null}
					{card.state && card.subtitle ? (
						<span className="shrink-0 text-muted-foreground/60">·</span>
					) : null}
					{card.subtitle ? (
						<span className="truncate text-muted-foreground">
							{card.subtitle}
						</span>
					) : null}
				</div>
			</div>

			<div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
				<div className="flex min-w-0 items-center gap-1.5">
					<SourceIcon
						source={card.source}
						size={11}
						className="shrink-0 opacity-70"
					/>
					<span className="truncate">{card.externalId}</span>
				</div>
				<span className="shrink-0">
					{formatRelativeTime(card.lastActivityAt)}
				</span>
			</div>
		</article>
	);
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
