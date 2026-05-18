import { HelmorThinkingIndicator } from "@/components/helmor-thinking-indicator";
import type { DisplayResolution } from "./parse";
import {
	AutoCompactNote,
	CategoryList,
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
	const showCategories =
		display.kind === "full" &&
		display.rich !== null &&
		display.rich.categories.length > 0;

	return (
		<div className="flex flex-col gap-3 px-1 py-1">
			{display.kind === "full" ? (
				<>
					<UsageHeader
						used={display.usedTokens}
						max={display.maxTokens}
						percentage={display.percentage}
					/>
					<UsageBar percentage={display.percentage} tier={display.tier} />
					{showCategories && display.rich ? (
						<>
							<CategoryList
								categories={display.rich.categories}
								maxTokens={display.rich.maxTokens}
							/>
							{display.rich.isAutoCompactEnabled ? <AutoCompactNote /> : null}
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
				<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
					<HelmorThinkingIndicator size={12} />
					<span>Loading context details…</span>
				</div>
			) : null}
		</div>
	);
}
