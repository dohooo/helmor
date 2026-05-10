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
 * Two-up segmented strip mirroring `TopSectionTabs`, but with a darker
 * warm-tone active surface (`#1B1716`) so the sub-level reads as nested
 * inside the top tabs without a visual collision. Each tab fills half the
 * available width.
 */
export function SubSectionTabs({
	value,
	onChange,
	diffCount,
	reviewIndicator = "none",
}: Props) {
	return (
		<div className="flex h-7 w-full items-center gap-1 rounded-md bg-muted/40 p-0.5">
			<SubTab active={value === "diff"} onClick={() => onChange("diff")}>
				Diff
				{typeof diffCount === "number" && diffCount > 0 ? (
					<span className="ml-1.5 text-[10.5px] font-medium tabular-nums text-muted-foreground/70">
						{diffCount}
					</span>
				) : null}
			</SubTab>
			<SubTab active={value === "review"} onClick={() => onChange("review")}>
				Checks
				{reviewIndicator !== "none" ? (
					<ReviewPip indicator={reviewIndicator} />
				) : null}
			</SubTab>
		</div>
	);
}

function ReviewPip({
	indicator,
}: {
	indicator: Exclude<ReviewIndicator, "none">;
}) {
	if (indicator === "success") {
		return (
			<Check
				aria-label="Review checks passing"
				className="ml-1.5 size-3 text-emerald-500"
				strokeWidth={2.5}
			/>
		);
	}
	return (
		<span
			aria-label={
				indicator === "failure"
					? "Review checks have failures"
					: "Review checks pending"
			}
			className={cn(
				"ml-1.5 inline-block size-1.5 rounded-full",
				indicator === "failure" ? "bg-destructive" : "bg-amber-500",
			)}
		/>
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
			// Active state uses `#1B1716` directly via inline style so the
			// dark warm-tone surface sits below the muted top-tab strip
			// without aliasing to any existing semantic token.
			style={active ? { backgroundColor: "#1B1716" } : undefined}
			className={cn(
				"flex h-6 flex-1 cursor-pointer items-center justify-center rounded-sm px-2 text-[11.5px] font-medium leading-none",
				active
					? "text-foreground shadow-sm"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}
