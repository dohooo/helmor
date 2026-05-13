import { Check, Circle, CircleDot } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared clickable row for option-style selection (radio / checkbox),
 * used by:
 *   - FormElicitationPanel — boolean Yes/No, single-select, multi-select rows
 *   - AskUserQuestionPanel — question options (single- or multi-select)
 *
 * The "Other" rows with embedded text inputs are NOT covered here (those
 * have custom inline layouts); this primitive targets pure label rows.
 */
type InteractionOptionRowProps = {
	selected: boolean;
	/** `radio` = single-choice (Circle/CircleDot); `checkbox` = multi (Check/empty-box). */
	indicator: "radio" | "checkbox";
	label: ReactNode;
	description?: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	/** Extra content appended after the main row (e.g. AskQ option preview). */
	children?: ReactNode;
	className?: string;
	"data-ask-option-row"?: string;
};

export function InteractionOptionRow({
	selected,
	indicator,
	label,
	description,
	onClick,
	disabled = false,
	children,
	className,
	...dataAttrs
}: InteractionOptionRowProps) {
	return (
		<div
			className={cn(
				"rounded-md px-2 py-1.5 transition-colors",
				selected ? "bg-accent/55" : "hover:bg-accent/30",
				disabled && "opacity-60",
				className,
			)}
			{...dataAttrs}
		>
			<button
				type="button"
				disabled={disabled}
				aria-pressed={selected}
				onClick={onClick}
				className="flex w-full cursor-interactive items-start gap-1.5 text-left disabled:cursor-not-allowed"
			>
				<span className="mt-0.5 shrink-0 text-muted-foreground">
					{indicator === "radio" ? (
						selected ? (
							<CircleDot
								className="size-3.5 text-foreground"
								strokeWidth={1.9}
							/>
						) : (
							<Circle
								className="size-3.5 text-muted-foreground/60"
								strokeWidth={1.9}
							/>
						)
					) : selected ? (
						<Check className="size-3.5 text-foreground" strokeWidth={2.4} />
					) : (
						<span className="block size-3.5 rounded-[6px] bg-background/80 ring-1 ring-inset ring-border/45" />
					)}
				</span>
				<div className="min-w-0 flex-1">
					<p className="text-[13px] font-medium text-foreground">{label}</p>
					{description ? (
						<p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
							{description}
						</p>
					) : null}
				</div>
			</button>
			{children}
		</div>
	);
}
