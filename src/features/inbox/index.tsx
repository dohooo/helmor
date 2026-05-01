import { Inbox } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { TrafficLightSpacer } from "@/components/chrome/traffic-light-spacer";
import { Badge } from "@/components/ui/badge";
import type { ContextCardSource } from "@/lib/sources/types";
import { cn } from "@/lib/utils";
import { inboxMockCards } from "./mock";
import { SourceCard } from "./source-card";
import { SourceIcon } from "./source-icon";

type SourceFilter = {
	id: "all" | "linear" | "github" | "slack";
	label: string;
	sources: ContextCardSource[];
};

const SOURCE_FILTERS: SourceFilter[] = [
	{
		id: "all",
		label: "All sources",
		sources: [
			"linear",
			"github_issue",
			"github_pr",
			"github_discussion",
			"slack_thread",
		],
	},
	{ id: "linear", label: "Linear", sources: ["linear"] },
	{
		id: "github",
		label: "GitHub",
		sources: ["github_issue", "github_pr", "github_discussion"],
	},
	{ id: "slack", label: "Slack", sources: ["slack_thread"] },
];

export const InboxSidebar = memo(function InboxSidebar({
	className,
}: {
	className?: string;
}) {
	const [selectedSource, setSelectedSource] =
		useState<SourceFilter["id"]>("all");
	const selectedFilter =
		SOURCE_FILTERS.find((filter) => filter.id === selectedSource) ??
		SOURCE_FILTERS[0];
	const filteredCards = useMemo(
		() =>
			inboxMockCards.filter((card) =>
				selectedFilter.sources.includes(card.source),
			),
		[selectedFilter],
	);
	const countsByFilter = useMemo(
		() =>
			Object.fromEntries(
				SOURCE_FILTERS.map((filter) => [
					filter.id,
					inboxMockCards.filter((card) => filter.sources.includes(card.source))
						.length,
				]),
			) as Record<SourceFilter["id"], number>,
		[],
	);

	return (
		<div className={cn("h-full min-h-0 flex-col overflow-hidden", className)}>
			<div
				data-slot="window-safe-top"
				className="flex h-9 shrink-0 items-center pr-3"
			>
				<TrafficLightSpacer side="left" width={94} />
				<div data-tauri-drag-region className="h-full flex-1" />
			</div>

			<div className="mt-1 pr-4 pl-3">
				<div className="grid w-full grid-cols-4 gap-1 rounded-lg border border-border/60 bg-background/40 p-1">
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
								{filter.id === "all" ? (
									<Inbox className="size-3.5" strokeWidth={2} />
								) : filter.id === "github" ? (
									<SourceIcon source="github_issue" size={14} />
								) : filter.id === "slack" ? (
									<SourceIcon source="slack_thread" size={14} />
								) : (
									<SourceIcon source="linear" size={14} />
								)}
								<Badge
									variant="secondary"
									className="absolute -right-1.5 -bottom-1.5 h-3 min-w-3 justify-center rounded-full px-0.5 text-[7.5px] leading-none"
								>
									{countsByFilter[filter.id]}
								</Badge>
							</span>
						</button>
					))}
				</div>
			</div>

			<div className="scrollbar-stable mt-[7px] min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-4 pl-3 [scrollbar-width:thin]">
				<div className="flex w-[calc(100%+12px)] flex-col gap-2 pb-3">
					{filteredCards.length > 0 ? (
						filteredCards.map((card) => (
							<SourceCard key={card.id} card={card} />
						))
					) : (
						<div className="mt-8 flex flex-col items-center gap-2 px-6 text-center">
							<div className="flex size-8 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
								<Inbox className="size-4" strokeWidth={2} />
							</div>
							<div className="text-[13px] font-medium text-foreground">
								No inbox cards
							</div>
							<div className="text-[12px] leading-5 text-muted-foreground">
								New source context will appear here when it is ready to triage.
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
});
