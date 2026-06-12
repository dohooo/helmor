import { HelmorThinkingIndicator } from "@/components/helmor-thinking-indicator";
import { I18nText } from "@/lib/i18n";
import type { DisplayResolution } from "./parse";
import {
	AutoCompactNote,
	CategoryList,
	SpentRow,
	UsageBar,
	UsageHeader,
} from "./popover-parts";

type Props = {
	display: DisplayResolution;
	/** True while the rich fetch is in-flight and we don't yet have
	 *  fresh categories. */
	richLoading?: boolean;
};

export function ContextUsagePopoverContent({
	display,
	richLoading = false,
}: Props) {
	const categories = display.kind === "full" ? display.categories : [];
	const showCategories = categories.length > 0;
	const hasMax = display.kind === "full" && display.maxTokens > 0;

	return (
		<div className="flex flex-col gap-3 px-1 py-1">
			{display.kind === "full" ? (
				<>
					<UsageHeader
						used={display.usedTokens}
						max={display.maxTokens}
						percentage={display.percentage}
					/>
					{hasMax ? (
						<UsageBar percentage={display.percentage} tier={display.tier} />
					) : null}
					{display.cost !== null ? <SpentRow cost={display.cost} /> : null}
					{showCategories ? (
						<>
							<CategoryList
								categories={categories}
								maxTokens={display.maxTokens}
							/>
							{display.rich?.isAutoCompactEnabled ? <AutoCompactNote /> : null}
						</>
					) : null}
				</>
			) : (
				<>
					<UsageHeader used={null} max={null} percentage={0} />
					<UsageBar percentage={0} tier="default" />
				</>
			)}

			{richLoading && !showCategories ? (
				<div className="flex items-center gap-2 text-mini text-muted-foreground">
					<HelmorThinkingIndicator size={12} />
					<span>
						<I18nText source={"Loading context details…"} />
					</span>
				</div>
			) : null}
		</div>
	);
}
