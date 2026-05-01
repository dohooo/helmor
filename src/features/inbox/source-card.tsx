import { AppendContextButton } from "@/components/append-context-button";
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
				"group relative flex flex-col gap-2 overflow-hidden rounded-lg border border-border/70 bg-[var(--sidebar)] px-3 pt-2.5 pb-2 text-left shadow-xs",
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

			<div
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute inset-y-0 right-0 w-20 bg-[linear-gradient(to_top_left,var(--accent)_0%,var(--accent)_34%,color-mix(in_oklch,var(--accent)_70%,transparent)_58%,transparent_100%)] opacity-0 transition-opacity duration-150",
					"group-hover:opacity-100 group-focus-within:opacity-100",
				)}
			/>
			<AppendContextButton
				subjectLabel={card.title}
				getPayload={() => buildCardContextPayload(card)}
				errorTitle="Couldn't insert inbox card"
				className={cn(
					"absolute right-2 bottom-1.5 z-10 flex size-6 cursor-pointer items-center justify-center rounded-md",
					"border-0 bg-transparent text-muted-foreground opacity-0 shadow-none",
					"transition-[background-color,color,opacity,transform] duration-150",
					"group-hover:opacity-100 group-focus-within:opacity-100",
					"hover:bg-foreground/10 hover:text-foreground",
					"focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
					"active:scale-95 [&_svg]:size-3.5",
				)}
			/>
		</article>
	);
}

function buildCardContextPayload(card: ContextCard) {
	const lines = [
		`Inbox context: ${card.title}`,
		`Source: ${card.externalId}`,
		card.subtitle ? `Area: ${card.subtitle}` : null,
		card.state ? `State: ${card.state.label}` : null,
		`URL: ${card.externalUrl}`,
	].filter((line): line is string => Boolean(line));

	return {
		label: card.externalId,
		submitText: lines.join("\n"),
		key: `inbox:${card.id}`,
	};
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
