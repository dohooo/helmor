import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type ChangesSubView = "diff" | "review";

export type ReviewIndicator = "none" | "pending" | "failure" | "success";

interface Props {
	value: ChangesSubView;
	onChange: (value: ChangesSubView) => void;
	diffCount?: number | null;
	reviewIndicator?: ReviewIndicator;
}

/**
 * Underline-style sub-tab strip rendered inside the Changes top-section
 * panel. The Diff tab carries a count badge for total changed files;
 * the Review tab carries a state pip (green tick when CI passes /
 * yellow when pending / red when failing — see `useChecksIndicator`).
 */
export function SubSectionTabs({
	value,
	onChange,
	diffCount,
	reviewIndicator = "none",
}: Props) {
	return (
		<div className="flex h-7 items-center gap-3 border-b border-border/50 px-2 text-[11px] font-medium">
			<SubTab active={value === "diff"} onClick={() => onChange("diff")}>
				Diff
				{typeof diffCount === "number" && diffCount > 0 ? (
					<span className="ml-1.5 rounded-sm bg-foreground/10 px-1 text-[10px] font-medium text-foreground/80">
						{diffCount}
					</span>
				) : null}
			</SubTab>
			<SubTab active={value === "review"} onClick={() => onChange("review")}>
				Review
				{reviewIndicator !== "none" ? (
					<span
						aria-label={
							reviewIndicator === "failure"
								? "Review checks have failures"
								: reviewIndicator === "pending"
									? "Review checks pending"
									: "Review checks passing"
						}
						className={cn(
							"ml-1.5 inline-flex items-center justify-center",
							reviewIndicator === "success"
								? "size-3 rounded-full bg-emerald-500/15 text-emerald-500"
								: reviewIndicator === "failure"
									? "size-1.5 rounded-full bg-destructive"
									: "size-1.5 rounded-full bg-amber-500",
						)}
					>
						{reviewIndicator === "success" ? (
							<Check className="size-2.5" strokeWidth={3} />
						) : null}
					</span>
				) : null}
			</SubTab>
		</div>
	);
}

function SubTab({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"-mb-px relative flex h-7 cursor-pointer items-center border-b-2 px-1 transition-colors",
				active
					? "border-foreground text-foreground"
					: "border-transparent text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}
