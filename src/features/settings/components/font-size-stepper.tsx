import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export type FontSizeStepperProps = {
	value: number;
	onChange: (next: number) => void;
	min: number;
	max: number;
	step?: number;
	unit?: string;
	ariaLabel?: string;
};

/// Two-button +/- stepper with a centered numeric label. Used for all
/// three appearance font sizes (chat, UI, code) so they stay visually
/// identical and the bounds live with the caller.
export function FontSizeStepper({
	value,
	onChange,
	min,
	max,
	step = 1,
	unit = "px",
	ariaLabel,
}: FontSizeStepperProps) {
	return (
		<div className="flex items-center gap-3" aria-label={ariaLabel}>
			<Button
				variant="outline"
				size="icon-sm"
				onClick={() => onChange(Math.max(min, value - step))}
				disabled={value <= min}
				aria-label="Decrease"
			>
				<Minus className="size-3.5" strokeWidth={2} />
			</Button>
			<span className="w-12 text-center text-[14px] font-semibold tabular-nums text-foreground">
				{value}
				{unit}
			</span>
			<Button
				variant="outline"
				size="icon-sm"
				onClick={() => onChange(Math.min(max, value + step))}
				disabled={value >= max}
				aria-label="Increase"
			>
				<Plus className="size-3.5" strokeWidth={2} />
			</Button>
		</div>
	);
}
