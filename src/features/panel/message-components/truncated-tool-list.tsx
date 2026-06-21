import { ChevronDown } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** `one` / `other` are i18n catalog KEYS, resolved at render via t(). */
export type TruncatedNoun = { one: string; other: string };

const DEFAULT_PREVIEW_COUNT = 3;
const DEFAULT_NOUN: TruncatedNoun = {
	one: "panelNounStep",
	other: "panelNounSteps",
};

const LIST_CLASS_NAME =
	"ml-5 flex flex-col gap-0.5 border-l border-border/30 pl-3 pt-1";

type TruncatedToolListProps<T> = {
	items: T[];
	getKey: (item: T) => string;
	renderItem: (item: T, opts: { expanded: boolean }) => ReactNode;
	/** Only items matching this count toward the preview cap. Defaults to all. */
	previewFilter?: (item: T) => boolean;
	/** Extra item appended to the collapsed preview (e.g. a live-streaming tail). Ignored when expanded. */
	previewTail?: T | null;
	previewCount?: number;
	defaultExpanded?: boolean;
	className?: string;
	noun?: TruncatedNoun;
};

// Renders tool calls capped at `previewCount` with a "Show N more" toggle.
// Shared by sub-agent children and collapsed read-only command groups.
export function TruncatedToolList<T>({
	items,
	getKey,
	renderItem,
	previewFilter,
	previewTail,
	previewCount = DEFAULT_PREVIEW_COUNT,
	defaultExpanded = false,
	className,
	noun = DEFAULT_NOUN,
}: TruncatedToolListProps<T>) {
	const { t, f } = useI18n();
	const [expanded, setExpanded] = useState(defaultExpanded);

	const previewItems = previewFilter ? items.filter(previewFilter) : items;
	const collapsedSlice = previewItems.slice(-previewCount);
	const collapsedVisibleCount = collapsedSlice.length + (previewTail ? 1 : 0);
	const hiddenCount = items.length - collapsedVisibleCount;
	const hasMore = previewItems.length >= previewCount && hiddenCount > 0;
	const visible = expanded
		? items
		: previewTail
			? [...collapsedSlice, previewTail]
			: collapsedSlice;

	return (
		<div className={cn(LIST_CLASS_NAME, className)}>
			{hasMore ? (
				<Button
					type="button"
					variant="ghost"
					size="xs"
					onClick={() => setExpanded((value) => !value)}
					className="mb-0.5 h-auto items-center justify-start gap-1 px-0 text-mini text-muted-foreground/50 hover:bg-transparent hover:text-muted-foreground"
				>
					<ChevronDown
						className={cn(
							"size-3 transition-transform",
							expanded && "rotate-180",
						)}
						strokeWidth={1.5}
					/>
					{expanded
						? t("panelCollapse")
						: f("panelShowMoreCount", {
								count: hiddenCount,
								noun: t(hiddenCount > 1 ? noun.other : noun.one),
							})}
				</Button>
			) : null}
			{visible.map((item) => (
				<Fragment key={getKey(item)}>{renderItem(item, { expanded })}</Fragment>
			))}
		</div>
	);
}
