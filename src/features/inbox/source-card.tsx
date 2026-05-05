import { memo } from "react";
import {
	AppendContextButton,
	type AppendContextRequestPayload,
} from "@/components/append-context-button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ComposerInsertTarget } from "@/lib/composer-insert";
import type { ContextCard } from "@/lib/sources/types";
import { cn } from "@/lib/utils";
import { SourceIcon } from "./source-icon";
import { STATE_TONE_CLASS } from "./state-tone";

// `memo` keeps a 20-card inbox list cheap to re-render: when the parent
// `InboxSidebar` re-renders (which is frequent — every settings update
// cascades into it via `useSettings()`), the shallow prop check on each
// card short-circuits as long as `card`, `onOpen`, `selected`, and
// `appendContextTarget` all keep referential identity.
export const SourceCard = memo(function SourceCard({
	card,
	onOpen,
	selected = false,
	appendContextTarget,
}: {
	card: ContextCard;
	onOpen?: (card: ContextCard) => void;
	selected?: boolean;
	appendContextTarget?: ComposerInsertTarget;
}) {
	return (
		<article
			aria-label={card.title}
			role={onOpen ? "button" : undefined}
			tabIndex={onOpen ? 0 : undefined}
			onClick={() => onOpen?.(card)}
			onKeyDown={(event) => {
				if (!onOpen || (event.key !== "Enter" && event.key !== " ")) return;
				event.preventDefault();
				onOpen(card);
			}}
			className={cn(
				"group relative flex flex-col gap-2 overflow-hidden rounded-lg border border-border/70 bg-[var(--sidebar)] px-3 pt-2.5 pb-2 text-left shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
				onOpen && "cursor-pointer",
				"hover:border-border hover:bg-[var(--accent)]",
				selected && "border-border bg-[var(--accent)]",
			)}
		>
			<div className="min-w-0 flex-1">
				<div className="line-clamp-2 text-[13px] font-medium leading-[18px] text-foreground">
					{card.title}
				</div>
			</div>

			<div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
				<div className="flex min-w-0 items-center gap-1.5">
					<SourceIcon
						source={card.source}
						size={11}
						className={cn(
							"shrink-0",
							card.state
								? STATE_TONE_CLASS[card.state.tone]
								: "text-muted-foreground",
						)}
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
					"group-hover:opacity-100",
				)}
			/>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="absolute right-1 bottom-0.5 z-10 inline-flex">
						<AppendContextButton
							subjectLabel={card.title}
							ariaLabel="Add to context"
							getPayload={() =>
								buildCardContextPayload(card, appendContextTarget)
							}
							errorTitle="Couldn't insert context card"
							className={cn(
								"flex size-7.5 cursor-pointer items-center justify-center rounded-md",
								"border-0 bg-transparent text-muted-foreground opacity-0 shadow-none",
								"transition-[background-color,color,opacity,transform] duration-150",
								"group-hover:opacity-100",
								"hover:bg-foreground/10 hover:text-foreground",
								"focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
								"active:scale-95 [&_svg]:size-3.5",
							)}
						/>
					</span>
				</TooltipTrigger>
				<TooltipContent side="top">Add to context</TooltipContent>
			</Tooltip>
		</article>
	);
});

export function buildCardContextPayload(
	card: ContextCard,
	target?: ComposerInsertTarget,
): AppendContextRequestPayload {
	const label = buildCardContextLabel(card);
	const lines = [
		`Context: ${card.title}`,
		`Source: ${card.externalId}`,
		card.subtitle ? `Area: ${card.subtitle}` : null,
		card.state ? `State: ${card.state.label}` : null,
		`URL: ${card.externalUrl}`,
	].filter((line): line is string => Boolean(line));
	const submitText = lines.join("\n");

	return {
		target,
		items: [
			{
				kind: "custom-tag",
				label,
				submitText,
				key: `inbox:${card.id}`,
				preview: {
					kind: "text",
					title: label,
					text: submitText,
				},
				source: card.source,
				stateTone: card.state?.tone,
			},
		],
		behavior: "append",
	};
}

function buildCardContextLabel(card: ContextCard) {
	const number =
		card.meta.type === "github_issue" ||
		card.meta.type === "github_pr" ||
		card.meta.type === "github_discussion"
			? card.meta.number
			: null;

	if (number) {
		return `${card.title} #${number}`;
	}

	return `${card.title} ${card.externalId}`.trim();
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
